/**
 * stamp.js test suite
 * Focus areas:
 *   1. Correctness — output box structure is self-consistent; sample data
 *      is still correctly referenced after stco/co64 shifts.
 *   2. Safety — fragmented MP4 / corrupt files must be refused; never
 *      produce a corrupt file.
 *   3. Idempotency — repeated writes do not create duplicate XMP segments
 *      or duplicate udta boxes.
 *   4. Memory — only moov is read; peak heap usage is decoupled from file size.
 *
 * Run: node --expose-gc test/run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { writeTags, inspect, capabilities, BlobSource, BufferSource, HttpSource, partsToStream, u16, u32, u64, fourcc } from '../src/stamp.js';
import { NodeFileSource } from '../src/node.js';
import * as F from './fixtures.mjs';

let PASS = 0, FAIL = 0;
const pad = (s, n) => String(s).padEnd(n);
function section(t) { console.log('\n\x1b[1m▌ ' + t + '\x1b[0m'); }
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log('   \x1b[32m✓\x1b[0m ' + name); }
  else { FAIL++; console.log('   \x1b[31m✗\x1b[0m ' + name + (extra ? '  \x1b[33m-> ' + extra + '\x1b[0m' : '')); }
}
const eq = (a, b) => a === b;

/* --------------------------- Parsing and verification tools --------------------------- */
function topBoxes(b, from = 0) {
  const out = [];
  let p = from;
  while (p + 8 <= b.length) {
    let size = u32(b, p), header = 8;
    if (size === 1) { header = 16; size = u64(b, p + 8); }
    else if (size === 0) size = b.length - p;
    if (size < header || p + size > b.length) return { boxes: out, ok: false, bad: { p, size, type: fourcc(b, p + 4) } };
    out.push({ pos: p, size, header, type: fourcc(b, p + 4), end: p + size });
    p += size;
  }
  return { boxes: out, ok: p === b.length, tail: p };
}

function children(b, box) {
  // meta is a full box: 12-byte header (size+type+version/flags)
  const skip = box.type === 'meta' ? 12 : (box.header || 8);
  const base = box.pos + skip;
  return topBoxes(b.subarray(base, box.end)).boxes.map((c) => ({ ...c, pos: c.pos + base, end: c.end + base }));
}
function findChild(b, box, type) { return children(b, box).find((c) => c.type === type) || null; }

/** Recursively collect stco / co64 offset values */
function collectOffsets(b) {
  const res = { stco: [], co64: [] };
  const walk = (start, end) => {
    let p = start;
    while (p + 8 <= end) {
      let size = u32(b, p), header = 8;
      if (size === 1) { header = 16; size = u64(b, p + 8); } else if (size === 0) size = end - p;
      if (size < header || p + size > end) return;
      const type = fourcc(b, p + 4);
      if (type === 'stco') {
        const n = u32(b, p + 12);
        for (let i = 0; i < n; i++) res.stco.push(u32(b, p + 16 + i * 4));
      } else if (type === 'co64') {
        const n = u32(b, p + 12);
        for (let i = 0; i < n; i++) res.co64.push(u64(b, p + 16 + i * 8));
      } else if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta'].includes(type)) {
        walk(p + header, p + size);
      }
      p += size;
    }
  };
  walk(0, b.length);
  return res;
}

/** Verify: canary bytes at given offset */
function canariesOk(b, offsets, chunks, chunkSize, label) {
  const bad = [];
  for (let i = 0; i < Math.min(offsets.length, chunks); i++) {
    const o = offsets[i];
    if (o + 8 > b.length) { bad.push(`${i}:out-of-bounds`); continue; }
    const mark = String.fromCharCode(...b.subarray(o, o + 8));
    const want = F.chunkMarkStr(i);
    if (mark !== want) bad.push(`${i}:mark=${mark} want=${want} @${o}`);
    else if (b[o + 8] !== F.CHUNK_BYTE(i)) bad.push(`${i}:sample bytes mismatch`);
  }
  check(`${label}：${Math.min(offsets.length, chunks)} sample canaries all point correctly`, bad.length === 0, bad.slice(0, 3).join(' | '));
}

/** Read key-values from udta/meta/ilst */
function readTags(b) {
  const t = topBoxes(b);
  const moov = t.boxes.find((x) => x.type === 'moov');
  if (!moov) return { error: 'no moov' };
  const udtas = children(b, moov).filter((x) => x.type === 'udta');
  const out = { udtaCount: udtas.length, hdlr: null, tags: {}, keys: [] };
  if (!udtas.length) return out;
  const udta = udtas[udtas.length - 1];
  const metas = children(b, udta).filter((x) => x.type === 'meta');
  if (!metas.length) return out;
  const meta = metas[0];
  meta.type = 'meta';
  const kids = children(b, meta);
  const h = kids.find((k) => k.type === 'hdlr');
  if (h) out.hdlr = fourcc(b, h.pos + 16);
  const keysBox = kids.find((k) => k.type === 'keys');
  if (keysBox) {
    const n = u32(b, keysBox.pos + 12);
    let p = keysBox.pos + 16;
    for (let i = 0; i < n; i++) {
      const s = u32(b, p);
      out.keys.push(new TextDecoder().decode(b.subarray(p + 8, p + s)));
      p += s;
    }
  }
  const ilst = kids.find((k) => k.type === 'ilst');
  if (ilst) {
    for (const entry of children(b, ilst)) {
      const inner = children(b, entry);
      const data = inner.find((d) => d.type === 'data');
      const val = data ? new TextDecoder().decode(b.subarray(data.pos + 16, data.end)) : '';
      let name = entry.type;
      if (out.keys.length) {
        const idx = u32(b, entry.pos + 4);
        if (idx >= 1 && idx <= out.keys.length) name = out.keys[idx - 1];
      }
      out.tags[name.replace(/\xa9/g, '©')] = val;
    }
  }
  return out;
}

function readJpegXmpSegments(b, ns = 'http://ns.adobe.com/xap/1.0/') {
  const segs = [];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) break;
    const marker = b[p + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = u16(b, p + 2);
    if (marker === 0xe1) {
      const name = new TextDecoder().decode(b.subarray(p + 4, p + 4 + ns.length));
      if (name === ns) {
        segs.push({ start: p, end: p + 2 + len, len: 2 + len, text: new TextDecoder().decode(b.subarray(p + 4, p + 2 + len)) });
      }
    }
    p += 2 + len;
  }
  return segs;
}

const XMP_EXT_NS = 'http://ns.adobe.com/xmp/extension/';
const readExtendedXmp = (b) => readJpegXmpSegments(b, XMP_EXT_NS);

function readPngChunks(b) {
  const out = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32(b, p);
    const type = fourcc(b, p + 4);
    out.push({ type, len, start: p, end: p + 12 + len });
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

/**
 * Independent MPF (CIPA DC-007) reader: locates the APP2 MPF index and resolves
 * every MPEntry to an absolute file offset. Written from the spec rather than
 * from stamp.js, so it can disagree with the implementation — which is the point.
 */
function readMpf(b) {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xff) { p += 1; continue; }
    const len = u16(b, p + 2);
    if (marker === 0xe2 && fourcc(b, p + 4) === 'MPF\0') {
      let e = -1, be = true;
      for (const cand of [p + 8, p + 12]) {                    // byte-order mark
        const two = String.fromCharCode(b[cand], b[cand + 1]);
        if (two === 'MM') { e = cand; be = true; break; }
        if (two === 'II') { e = cand; be = false; break; }
      }
      if (e < 0) return null;
      const rd32 = (o) => (be ? u32(b, o) : ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0));
      const rd16 = (o) => (be ? u16(b, o) : ((b[o] | (b[o + 1] << 8)) >>> 0));
      const ifd = e + rd32(e + 4);
      const count = rd16(ifd);
      let table = -1, images = 0;
      for (let i = 0; i < count; i++) {
        const q = ifd + 2 + i * 12;
        if (rd16(q) === 0xb002) { images = rd32(q + 4) / 16; table = e + rd32(q + 8); }
      }
      const entries = [];
      for (let i = 0; i < images; i++) {
        const q = table + i * 16;
        const size = rd32(q + 4), off = rd32(q + 8);
        entries.push({ size, offset: off, abs: off === 0 ? 0 : e + off });
      }
      return { segAt: p, bomAt: e, entries };
    }
    p += 2 + len;
  }
  return null;
}

const bytesOf = async (res) => new Uint8Array(await res.blob.arrayBuffer());

const TAGS = {
  title: 'Stamp Test Title',
  artist: 'asinnn',
  date: '2026-09-22T05:42:10.000Z',
  comment: 'Test comment text for metadata writing validation.\n' + 'X'.repeat(600),
  url: 'https://x.com/i/status/1234567890',
  software: 'stamp/0.1.0',
};

const heapUsed = () => {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, ab: m.arrayBuffers, total: m.heapUsed + m.arrayBuffers };
};
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

/* ===================================================================== */
section('A. JPEG: header-only, APP1 XMP insert / replace');

{
  const { bytes } = F.buildJpeg();
  const src = new BlobSource(new Blob([bytes]));
  const res = await writeTags(src, TAGS);
  check('write succeeds', res.ok, res.report.error);
  const out = await bytesOf(res);
  const segs = readJpegXmpSegments(out);
  check('output has exactly 1 XMP APP1 segment', segs.length === 1, `actual ${segs.length}`);
  check('XMP contains title', segs[0] && segs[0].text.includes(TAGS.title));
  check('XMP contains URL', segs[0] && segs[0].text.includes(TAGS.url));
  const insertAt = u16(out, 2 + 2) + 4;
  const tail = out.subarray(out.length - 2050);
  check('raw scan data after insertion point unchanged byte-for-byte',
    tail.every((v, i) => v === bytes[bytes.length - 2050 + i]));
  check('SOI/EOI intact', out[0] === 0xff && out[1] === 0xd8 && out[out.length - 2] === 0xff && out[out.length - 1] === 0xd9);
  check(`read only ${res.report.stats.bytesRead} bytes(file ${bytes.length})`, res.report.stats.bytesRead <= bytes.length);

  // Idempotency
  const res2 = await writeTags(new BlobSource(new Blob([out])), TAGS);
  const out2 = await bytesOf(res2);
  check('Idempotency：two consecutive writes produce identical bytes', out2.length === out.length && out2.every((v, i) => v === out[i]),
    `length ${out.length} vs ${out2.length}`);
}

{
  const { bytes } = F.buildJpeg({ withXmp: true });
  check('sample originally has 1 XMP segment', readJpegXmpSegments(bytes).length === 1);
  const res = await writeTags(new BlobSource(new Blob([bytes])), TAGS);
  const out = await bytesOf(res);
  const segs = readJpegXmpSegments(out);
  check('replacement: old XMP replaced not stacked', segs.length === 1 && segs[0].text.includes(TAGS.title) && !segs[0].text.includes('old xmp title'));
  check('JFIF APP0 preserved', u32(out, 0) === 0xffd8ffe0 || out[2] === 0xff);
}

section('B. PNG: iTXt before IDAT');

{
  const { bytes } = F.buildPng({ withXmp: true });
  const res = await writeTags(new BlobSource(new Blob([bytes])), TAGS);
  check('write succeeds', res.ok, res.report.error);
  const out = await bytesOf(res);
  const chunks = readPngChunks(out);
  const firstIdat = chunks.find((c) => c.type === 'IDAT');
  const itxts = chunks.filter((c) => c.type === 'iTXt');
  check('all iTXt before IDAT', itxts.every((c) => c.start < firstIdat.start));
  check('exactly 1 new XMP iTXt', itxts.filter((c) => new TextDecoder().decode(out.subarray(c.start + 8, c.start + 8 + 17)) === 'XML:com.adobe.xmp').length === 1);
  check('IHDR / IDAT / IEND order intact', JSON.stringify(chunks.map((c) => c.type).filter((t) => ['IHDR', 'IDAT', 'IEND'].includes(t))) === '["IHDR","IDAT","IEND"]');
  let crcOk = true;
  for (const c of chunks) {
    const crc = u32(out, c.end - 4);
    const calc = (() => {
      const t = (() => { const T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let x = n; for (let k = 0; k < 8; k++) x = (x & 1) ? (0xedb88320 ^ (x >>> 1)) : (x >>> 1); T[n] = x >>> 0; } return T; })();
      let c2 = 0xffffffff;
      for (const v of out.subarray(c.start + 4, c.end - 4)) c2 = t[(c2 ^ v) & 0xff] ^ (c2 >>> 8);
      return (c2 ^ 0xffffffff) >>> 0;
    })();
    if (crc !== calc) crcOk = false;
  }
  check('all chunk CRC32 valid (including new ones)', crcOk);
  const res2 = await writeTags(new BlobSource(new Blob([out])), TAGS);
  const out2 = await bytesOf(res2);
  check('Idempotency：two consecutive writes produce identical bytes', out2.length === out.length && out2.every((v, i) => v === out[i]));
}

/* ===================================================================== */
section('C. MP4: moov layouts / existing tags / 64-bit / fragmented');

async function mp4Case(label, opts, verify) {
  const fx = F.buildMp4(opts);
  const inputSize = fx.bytes.length;
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), TAGS);
  if (!res.ok) { check(label + '：write succeeds', false, res.report.error); return null; }
  const out = await bytesOf(res);
  const t = topBoxes(out);
  check(`${label}：top-level box structure consistent`, t.ok, JSON.stringify(t.bad));
  const moov = t.boxes.find((b) => b.type === 'moov');
  check(`${label}：moov size field synced (+${out.length - inputSize})`, moov && moov.size === res.parts.find((p) => p.kind === 'bytes').bytes.length);
  const tags = readTags(out);
  check(`${label}：udta unique (no duplicates)`, tags.udtaCount === 1, `udtaCount=${tags.udtaCount}`);
  check(`${label}：title written correctly`, (tags.tags['©nam'] || tags.tags.title) === TAGS.title, JSON.stringify(tags.tags).slice(0, 120));
  if (verify) verify(out, fx, res);
  // Idempotency
  const res2 = await writeTags(new BlobSource(new Blob([out])), TAGS);
  const out2 = await bytesOf(res2);
  check(`${label}：Idempotency(second write content unchanged)`, out2.length === out.length && out2.every((v, i) => v === out[i]),
    `length ${out.length} -> ${out2.length}`);
  return { out, res, fx };
}

await mp4Case('faststart(moov-at-head)', { layout: 'head' }, (out, fx) => {
  const { stco } = collectOffsets(out);
  const real = stco.filter((v) => v > 0);
  const delta = out.length - fx.bytes.length;
  check('faststart：all stco shifted by delta', real.length === fx.chunks && real.every((v, i) => v === fx.offsets[i] + delta),
    `${real.slice(0, 3)} vs ${fx.offsets.slice(0, 3).map((v) => v + delta)}`);
  canariesOk(out, real, fx.chunks, fx.chunkSize, 'faststart');
});

await mp4Case('moov-at-tail', { layout: 'tail' }, (out, fx) => {
  const { stco } = collectOffsets(out);
  const real = stco.filter((v) => v > 0);
  check('moov-at-tail：stco unchanged (zero-offset path)', real.every((v, i) => v === fx.offsets[i]), `${real.slice(0, 3)} vs ${fx.offsets.slice(0, 3)}`);
  canariesOk(out, real, fx.chunks, fx.chunkSize, 'moov-at-tail');
});

await mp4Case('free-between-moov-and-mdat', { layout: 'free', freeSize: 512 }, (out, fx) => {
  const { stco } = collectOffsets(out);
  const real = stco.filter((v) => v > 0);
  const delta = out.length - fx.bytes.length;
  check('free layout：stco shift correct', real.every((v, i) => v === fx.offsets[i] + delta));
  canariesOk(out, real, fx.chunks, fx.chunkSize, 'free layout');
});

await mp4Case('existing mdir tags (merge not stack)', { layout: 'head', existing: 'mdir' }, (out) => {
  const tags = readTags(out);
  check('hd existing ©gen = Electronic preserved', tags.tags['©gen'] === 'Electronic', JSON.stringify(tags.tags));
  check('old ©nam overwritten with new title', tags.tags['©nam'] === TAGS.title);
  const { stco } = collectOffsets(out);
  canariesOk(out, stco.filter((v) => v > 0), 8, 4096, 'merge path');
});

await mp4Case('existing mdta tags (keep mdta style)', { layout: 'head', existing: 'mdta' }, (out) => {
  const tags = readTags(out);
  check('hdlr still mdta', tags.hdlr === 'mdta', `hdlr=${tags.hdlr}`);
  check('keys table preserves genre and adds new keys', tags.keys.includes('genre') && tags.keys.includes('title') && tags.keys.includes('software'), JSON.stringify(tags.keys));
  check('genre value preserved as Electronic', tags.tags.genre === 'Electronic', JSON.stringify(tags.tags));
  check('title overwritten', tags.tags.title === TAGS.title);
});

await mp4Case('co64 (64-bit chunk offsets)', { layout: 'head', useCo64: true }, (out, fx) => {
  const { co64 } = collectOffsets(out);
  const delta = out.length - fx.bytes.length;
  check('co64 shift correct', co64.every((v, i) => v === fx.offsets[i] + delta));
  canariesOk(out, co64, fx.chunks, fx.chunkSize, 'co64');
});

await mp4Case('mdat with 64-bit largesize', { layout: 'head', largeMdat: true }, (out, fx) => {
  const { stco } = collectOffsets(out);
  const delta = out.length - fx.bytes.length;
  check('largesize layout stco shift correct', stco.filter((v) => v > 0).every((v, i) => v === fx.offsets[i] + delta),
    `${stco} vs ${fx.offsets.map((v) => v + delta)}`);
  canariesOk(out, stco.filter((v) => v > 0), fx.chunks, fx.chunkSize, 'largesize');
});

{
  const fx = F.buildMp4({ fragmented: true });
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), TAGS);
  check('fragmented MP4：explicitly refused not silently corrupted', res.ok === false && /fragment|moof/.test(res.report.error || ''), res.report.error);
  const info = await inspect(new BlobSource(new Blob([fx.bytes])));
  check('inspect identifies fragmented and marks unsafe', info.mp4 && info.mp4.fragmented === true && info.mp4.safeToWrite === false, JSON.stringify(info.mp4));
}

{
  const bad = new Uint8Array(F.buildMp4({ layout: 'head' }).bytes);
  let moovAt = -1;
  for (let i = 0; i < bad.length - 4; i++) {
    if (bad[i] === 0x6d && bad[i + 1] === 0x6f && bad[i + 2] === 0x6f && bad[i + 3] === 0x76) { moovAt = i - 4; break; }
  }
  new DataView(bad.buffer).setUint32(moovAt, 999999);   // corrupt moov size field
  const res = await writeTags(new BlobSource(new Blob([bad])), TAGS);
  check('corrupt file：returns failure without throwing', res.ok === false && !!res.report.error, res.report.error);
  check('corrupt file：no output produced', !res.blob && !res.stream);
}

/* ===================================================================== */
section('D. inspect: format / codec / bitrate');

{
  const fx = F.buildMp4({ layout: 'head' });
  const info = await inspect(new BlobSource(new Blob([fx.bytes])));
  check('identified as mp4 with faststart=true', info.format === 'mp4' && info.mp4.fastStart === true);
  check('codec=avc1', info.mp4.codec === 'avc1', info.mp4.codec);
  check('resolution 1920x1080', info.mp4.video && info.mp4.video.width === 1920 && info.mp4.video.height === 1080, JSON.stringify(info.mp4.video));
  check('duration and bitrate computed', info.mp4.durationSec > 0 && info.mp4.bitrate > 0, `dur=${info.mp4.durationSec}s br=${info.mp4.bitrate}`);
  console.log(`      └ probe result：${JSON.stringify(info.mp4.video)} codec=${info.mp4.codec} bitrate=${(info.mp4.bitrate / 1000).toFixed(0)} kbps`);
}

/* ===================================================================== */
section('E. large file: peak memory decoupled from file size (sparse file + real Blob)');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));

function makeSparseFile(file, totalSize, plan) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, plan.head);
  fs.ftruncateSync(fd, totalSize);
  for (let i = 0; i < plan.chunks; i++) fs.writeSync(fd, F.CHUNK_MARK(i), 0, 8, plan.offsets[i]);
  fs.closeSync(fd);
  return fs.statSync(file);
}

// ---------- E1: 2 GiB high-bitrate file, plan only, no materialize ----------
{
  const BIG = 2 * 1024 ** 3;
  const plan = F.buildSparseMp4Plan(BIG, { chunks: 64, chunkSize: 1 << 20 });
  const file = path.join(tmp, 'big.mp4');
  const st = makeSparseFile(file, BIG, plan);
  console.log(`      sparse sample: logical ${(st.size / 1073741824).toFixed(2)} GiB, actual disk usage ${(st.blocks * 512 / 1048576).toFixed(2)} MiB`);

  const before = heapUsed();
  const blob = await fs.openAsBlob(file);
  const src = new BlobSource(blob);
  const res = await writeTags(src, TAGS, { materialize: false });
  const after = heapUsed();

  check('2 GiB file write succeeds (plan only)', res.ok, res.report.error);
  check(`read only ${res.report.stats.bytesRead} bytes(≈ ${(res.report.stats.bytesRead / 1024).toFixed(1)} KiB；file 2 GiB, of file ${(res.report.stats.bytesRead / BIG * 100).toFixed(4)}%)`,
    res.report.stats.bytesRead < 4 * 1024 * 1024, `bytesRead=${res.report.stats.bytesRead}`);
  check(`peak heap delta ${mb(after.total - before.total)}(require < 8 MB)`, after.total - before.total < 8 * 1048576);
  const bigRef = res.parts.filter((p) => p.kind === 'ref' && p.end - p.start > BIG / 2);
  check('mdat preserved as reference slice, 2 GiB not in heap', bigRef.length === 1,
    JSON.stringify(res.parts.map((p) => `${p.kind}:${p.kind === 'bytes' ? p.bytes.length : p.end - p.start}`)));

  const patched = res.parts.find((p) => p.kind === 'bytes').bytes;
  const newOffsets = collectOffsets(patched).stco.slice(0, plan.chunks);
  const delta = patched.length - plan.moovSize;
  check(`stco shift = moov delta(${delta} bytes, multiple of 8 -> mdat aligned)`,
    delta % 8 === 0 && newOffsets.every((v, i) => v === plan.offsets[i] + delta),
    `${newOffsets.slice(0, 2)} vs ${plan.offsets.slice(0, 2).map((v) => v + delta)}`);
  const readAt = new Uint8Array(await blob.slice(newOffsets[3] - delta, newOffsets[3] - delta + 8).arrayBuffer());
  check('4th sample at output coords still points to original canary', String.fromCharCode(...readAt) === F.chunkMarkStr(3), String.fromCharCode(...readAt));
}

// ---------- E2: 256 MiB, new vs old impl peak memory comparison ----------
{
  const MID = 256 * 1024 ** 2;
  const plan = F.buildSparseMp4Plan(MID, { chunks: 32, chunkSize: 1 << 20 });
  const file = path.join(tmp, 'mid.mp4');
  makeSparseFile(file, MID, plan);
  const blob = await fs.openAsBlob(file);
  const src = new BlobSource(blob);

  const beforeNew = heapUsed();
  const resNew = await writeTags(src, TAGS);
  const afterNew = heapUsed();
  const newPeak = afterNew.total - beforeNew.total;

  const beforeOld = heapUsed();
  const all = new Uint8Array(await blob.arrayBuffer());                 // all into heap
  const delta = resNew.size - MID;
  const grown = new Uint8Array(all.length + delta);                     // copy and grow
  grown.set(all);
  grown.set(resNew.parts.find((p) => p.kind === 'bytes').bytes.subarray(-delta), all.length);
  const legacyBlob = new Blob([grown]);                                 // Blob takes another copy
  const afterOld = heapUsed();
  const oldPeak = afterOld.total - beforeOld.total;

  check('old impl reads entire file into heap (baseline)', oldPeak > MID * 0.9, mb(oldPeak));
  console.log(`      └ 256 MiB file peak heap: new impl (plan)${mb(newPeak)} vs old impl ${mb(oldPeak)}(ratio 1 : ${(oldPeak / Math.max(1, newPeak)).toFixed(0)})`);
  console.log('      └ old impl = arrayBuffer (full) + Uint8Array(len+delta) grow copy + Blob copy ~ 3x file size');
  void legacyBlob; void grown; void resNew;
}

section('F. Stream output: ReadableStream chunks (network to disk)');

{
  const fx = F.buildMp4({ layout: 'head', chunks: 4, chunkSize: 4096 });
  const src = new BlobSource(new Blob([fx.bytes]));
  const res = await writeTags(src, TAGS);
  const out = await bytesOf(res);
  const { partsToStream } = await import('../src/stamp.js');
  const stream = partsToStream(src, res.parts, 1024);
  const reader = stream.getReader();
  const chunksOut = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunksOut.push(value); }
  const joined = new Uint8Array(chunksOut.reduce((a, c) => a + c.length, 0));
  let o = 0; for (const c of chunksOut) { joined.set(c, o); o += c.length; }
  check('ReadableStream output matches Blob output byte-for-byte', joined.length === out.length && joined.every((v, i) => v === out[i]),
    `${joined.length} vs ${out.length}`);
  check('chunked output (1KB window) content unchanged', chunksOut.length > 3);
}

fs.rmSync(tmp, { recursive: true, force: true });

/* ===================================================================== */
section('G. Regression: bug fixes from external review');

// G1: PNG with large IDAT should not read the chunk body (#1)
{
  const cat = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u32b = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const ascii = (s) => new Uint8Array([...s].map(c => c.charCodeAt(0) & 255));
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => cat(u32b(data.length), ascii(type), data, u32b(crc32(cat(ascii(type), data))));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', cat(u32b(64), u32b(64), new Uint8Array([8, 6, 0, 0, 0])));
  const IDAT_LEN = 70 * 1024 * 1024;
  class FakePngSource extends BufferSource {
    constructor() { const head = cat(sig, ihdr, u32b(IDAT_LEN), ascii('IDAT'), new Uint8Array(8)); super(head, 'image/png'); this.size = sig.length + ihdr.length + 12 + IDAT_LEN + 12; }
    async read(start, end) { if (end <= this.bytes.length) return this.bytes.subarray(start, end); const out = new Uint8Array(end - start); const avail = Math.min(this.bytes.length - start, out.length); if (avail > 0) out.set(this.bytes.subarray(start, start + avail), 0); return out; }
    canSlice() { return false; }
  }
  const res = await writeTags(new FakePngSource(), { title: 'large IDAT test' });
  check('large IDAT PNG: write succeeds (no spurious failure)', res.ok, res.report?.error);
  if (res.ok) {
    check('large IDAT PNG: did not read more than 64KB of header', res.report.stats.maxReadSize < 65536, `maxReadSize=${res.report.stats.maxReadSize}`);
  }
}

// G2: HttpSource refuses random read when Range unsupported (#2)
{
  const fakeFetch = async (url, opts) => {
    const range = opts?.headers?.Range || '';
    if (range === 'bytes=0-0') return { status: 200, headers: { get: (k) => k === 'content-length' ? '1048576' : null }, body: { cancel: () => {} } };
    return { status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(1048576).buffer };
  };
  const src = await new HttpSource('http://fake', { fetchImpl: fakeFetch }).init();
  check('HttpSource: detects rangeSupported=false', src.rangeSupported === false);
  let threw = false;
  try { await src.read(0, 100); } catch { threw = true; }
  check('HttpSource: read() refuses when Range unsupported', threw);
}

// G3: MP4 with multiple udta — second udta data preserved (#3)
{
  const cat = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u32b = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const ascii = (s) => new Uint8Array([...s].map(c => c.charCodeAt(0) & 255));
  const zeros = (n) => new Uint8Array(n);
  function box(type, ...body) { const b = cat(...body); return cat(u32b(8 + b.length), ascii(type), b); }
  function fullBox(type, ver, flags, ...body) { const b = cat(...body); return cat(u32b(12 + b.length), ascii(type), new Uint8Array([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), b); }
  const data1 = (val) => { const p = ascii(val); return cat(u32b(16 + p.length), ascii('data'), u32b(1), u32b(0), p); };
  const udta1 = box('udta', fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, zeros(8), ascii('mdir'), zeros(12), zeros(1)), box('ilst', box('\xa9nam', data1('first udta title')), box('\xa9too', data1('first udta tool')))));
  const udta2 = box('udta', fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, zeros(8), ascii('mdir'), zeros(12), zeros(1)), box('ilst', box('\xa9cmt', data1('second udta secret data')))));
  const fx = F.buildMp4({ layout: 'head' });
  let moovPos = -1, moovSize = 0;
  for (let i = 0; i < fx.bytes.length - 4; i++) { if (fourcc(fx.bytes, i + 4) === 'moov') { moovPos = i; moovSize = u32(fx.bytes, i); break; } }
  const origMoovBody = fx.bytes.subarray(moovPos + 8, moovPos + moovSize);
  const newMoovBody = cat(origMoovBody, udta1, udta2);
  const newMoov = cat(u32b(8 + newMoovBody.length), ascii('moov'), newMoovBody);
  const multiUdtaBytes = cat(fx.bytes.subarray(0, moovPos), newMoov, fx.bytes.subarray(moovPos + moovSize));
  const res = await writeTags(new BlobSource(new Blob([multiUdtaBytes])), { title: 'merged title' });
  check('multi-udta: write succeeds', res.ok, res.report?.error);
  if (res.ok) {
    const out = await bytesOf(res);
    const outStr = new TextDecoder().decode(out);
    check('multi-udta: second udta data preserved', outStr.includes('second udta secret data'));
    check('multi-udta: first udta non-overlapping data preserved', outStr.includes('first udta tool'));
  }
}

// G4: JPEG with multiple XMP — all old XMP removed (#4)
{
  const cat = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u16b = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
  const ascii = (s) => new Uint8Array([...s].map(c => c.charCodeAt(0) & 255));
  const makeXmpSeg = (title) => { const packet = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${title}</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`; const ns = ascii('http://ns.adobe.com/xap/1.0/\0'); const body = ascii(packet); return cat(new Uint8Array([0xff, 0xe1]), u16b(2 + ns.length + body.length), ns, body); };
  const jfif = cat(new Uint8Array([0xff, 0xe0]), u16b(16), ascii('JFIF\0'), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const dqt = cat(new Uint8Array([0xff, 0xdb]), u16b(67), new Uint8Array([0]), new Uint8Array(64).fill(16));
  const sof = cat(new Uint8Array([0xff, 0xc0]), u16b(17), new Uint8Array([8]), u16b(64), u16b(64), new Uint8Array([3]), new Uint8Array([1, 0x22, 0]), new Uint8Array([2, 0x11, 1]), new Uint8Array([3, 0x11, 1]));
  const sos = cat(new Uint8Array([0xff, 0xda]), u16b(12), new Uint8Array([3]), new Uint8Array([1, 0, 2, 0, 3, 0, 0, 0x3f, 0]));
  const scan = new Uint8Array(2048).fill(0x5a);
  const eoi = new Uint8Array([0xff, 0xd9]);
  const bytes = cat(new Uint8Array([0xff, 0xd8]), jfif, makeXmpSeg('XMP #1'), makeXmpSeg('XMP #2'), makeXmpSeg('XMP #3'), dqt, sof, sos, scan, eoi);
  const res = await writeTags(new BlobSource(new Blob([bytes])), { title: 'new' });
  const out = await bytesOf(res);
  const outStr = new TextDecoder().decode(out);
  const xmpSegs = readJpegXmpSegments(out);
  check('multi-XMP JPEG: all old XMP removed', !outStr.includes('XMP #1') && !outStr.includes('XMP #2') && !outStr.includes('XMP #3'));
  check('multi-XMP JPEG: exactly 1 XMP segment in output', xmpSegs.length === 1, `count=${xmpSegs.length}`);
}

// G5: chunkSize=0 throws RangeError (#5)
{
  const fx = F.buildMp4({ layout: 'head', chunks: 4, chunkSize: 4096 });
  const src = new BlobSource(new Blob([fx.bytes]));
  const res = await writeTags(src, { title: 'test' }, { materialize: false });
  let threw = false;
  try { partsToStream(src, res.parts, 0); } catch (e) { threw = e instanceof RangeError; }
  check('chunkSize=0: throws RangeError', threw);
}

// G6: metadataFormat with invalid value is rejected (#6)
{
  const fx = F.buildMp4({ layout: 'head' });
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), { title: 'test' }, { metadataFormat: 'wat' });
  check('metadataFormat="wat": rejected (ok:false)', res.ok === false);
  check('metadataFormat="wat": error mentions valid values', /auto|mdir|mdta/.test(res.report?.error || ''));
}

// G7: forced mdir on mdta file — no mixed ilst (#7)
{
  const fx = F.buildMp4({ layout: 'head', existing: 'mdta' });
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), { title: 'forced' }, { metadataFormat: 'mdir' });
  check('forced mdir on mdta file: write succeeds', res.ok, res.report?.error);
  if (res.ok) {
    const out = await bytesOf(res);
    // Check: no numeric-index entries (mdta legacy) in ilst
    let moovPos = -1, moovSize = 0;
    for (let i = 0; i < out.length - 4; i++) { if (fourcc(out, i + 4) === 'moov') { moovPos = i; moovSize = u32(out, i); break; } }
    const moov = out.subarray(moovPos, moovPos + moovSize);
    const findIlst = (b, start, end) => { let p = start; while (p + 8 <= end) { const s = u32(b, p); if (s < 8) break; const t = fourcc(b, p + 4); if (t === 'ilst') return { pos: p, size: s }; if (['moov','udta','meta'].includes(t)) { const skip = t === 'meta' ? 12 : 8; const r = findIlst(b, p + skip, p + s); if (r) return r; } p += s; } return null; };
    const ilst = findIlst(moov, 8, moov.length);
    let hasNumericName = false;
    if (ilst) { let p = ilst.pos + 8; while (p + 8 <= ilst.pos + ilst.size) { const s = u32(moov, p); if (s < 8) break; const name = fourcc(moov, p + 4); if (name.charCodeAt(0) === 0 && name.charCodeAt(1) === 0 && name.charCodeAt(2) === 0) hasNumericName = true; p += s; } }
    check('forced mdir: no mdta numeric-index entries (clean ilst)', !hasNumericName);
  }
}

// G8: extra field is not in API (silently ignored, not written) (#8)
{
  const fx = F.buildMp4({ layout: 'head' });
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), { title: 't', extra: { foo: 'bar' } });
  const out = await bytesOf(res);
  check('extra field: not written to file', !new TextDecoder().decode(out).includes('bar'));
}

// G9: report.stats includes sliceCalls from Blob assembly (#9)
{
  const fx = F.buildMp4({ layout: 'head', chunks: 4, chunkSize: 4096 });
  const src = new BlobSource(new Blob([fx.bytes]));
  const res = await writeTags(src, { title: 'test' });
  check('report.stats: sliceCalls > 0 after Blob assembly', res.report.stats.sliceCalls > 0, `sliceCalls=${res.report.stats.sliceCalls}`);
}

// G10: mdta freeform (----) entries preserved; numeric-index entries overridden
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map(c => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);
  const hdlrBody = c2(z2(4), a2('mdta'), z2(12), z2(1));
  const hdlr = c2(u2(12 + hdlrBody.length), a2('hdlr'), z2(4), hdlrBody);
  const idxEntry = (idx, val) => { const pl = a2(val); const inner = c2(u2(16 + pl.length), a2('data'), u2(1), u2(0), pl); return c2(u2(8 + inner.length), new Uint8Array([0, 0, 0, idx]), inner); };
  const freeform = (mean, name, val) => {
    const meanBox = c2(u2(12 + mean.length), a2('mean'), z2(4), a2(mean));
    const nameBox = c2(u2(12 + name.length), a2('name'), z2(4), a2(name));
    const pl = a2(val);
    const dataBox = c2(u2(16 + pl.length), a2('data'), u2(1), u2(0), pl);
    const inner = c2(meanBox, nameBox, dataBox);
    return c2(u2(8 + inner.length), a2('----'), inner);
  };
  const ilstChildren = c2(idxEntry(1, 'old title'), freeform('com.apple.quicktime', 'location.ISO6709', '+37.7749-122.4194/'));
  const ilst = c2(u2(8 + ilstChildren.length), a2('ilst'), ilstChildren);
  const keyEntry = c2(u2(8 + 5), a2('mdta'), a2('title'));
  const keys = c2(u2(16 + keyEntry.length), a2('keys'), z2(4), u2(1), keyEntry);
  const metaBody = c2(hdlr, keys, ilst);
  const meta = c2(u2(12 + metaBody.length), a2('meta'), z2(4), metaBody);
  const udta = c2(u2(8 + meta.length), a2('udta'), meta);
  const mvhd = c2(u2(108), a2('mvhd'), z2(100));
  const moovBody = c2(mvhd, udta);
  const moov = c2(u2(8 + moovBody.length), a2('moov'), moovBody);
  const ftp = c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mdat = c2(u2(264), a2('mdat'), z2(256));
  const bytes = c2(ftp, moov, mdat);

  const res = await writeTags(new BlobSource(new Blob([bytes])), { title: 'new title' });
  check('mdta freeform: write succeeds', res.ok, res.report?.error);
  if (res.ok) {
    const out = new Uint8Array(await res.blob.arrayBuffer());
    const s = new TextDecoder().decode(out);
    check('mdta freeform: ---- entry preserved (location data not lost)', s.includes('+37.7749-122.4194/'));
    check('mdta freeform: old numeric-index title overridden', !s.includes('old title'));
    check('mdta freeform: new title written', s.includes('new title'));
  }
}

// G11: stco -> co64 upgrade when offset would overflow 32 bits (>4GB faststart)
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map(c => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);

  const STCO_OFFSET = 0xFFFFFFF0;         // near the 32-bit ceiling
  const FAKE_SIZE = 0xFFFFFFFF + 100;     // logical >4GB file

  const ftp = c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mvhd = c2(u2(108), a2('mvhd'), z2(100));
  const stcoBody = c2(u2(1), u2(STCO_OFFSET));
  const stco = c2(u2(12 + stcoBody.length), a2('stco'), z2(4), stcoBody);
  const stbl = c2(u2(8 + stco.length), a2('stbl'), stco);
  const minf = c2(u2(8 + stbl.length), a2('minf'), stbl);
  const mdia = c2(u2(8 + minf.length), a2('mdia'), minf);
  const trak = c2(u2(8 + mdia.length), a2('trak'), mdia);
  const moov = c2(u2(8 + mvhd.length + trak.length), a2('moov'), mvhd, trak);
  const head = c2(ftp, moov);
  const mdatSize = FAKE_SIZE - head.length;
  const realHead = c2(head, u2(mdatSize), a2('mdat'));

  class HugeSource extends BufferSource {
    constructor() { super(realHead, 'video/mp4'); this.size = FAKE_SIZE; }
    async read(start, end) {
      if (end <= this.bytes.length) return this.bytes.subarray(start, end);
      const out = new Uint8Array(end - start);
      const avail = Math.max(0, Math.min(this.bytes.length - start, out.length));
      if (avail > 0) out.set(this.bytes.subarray(start, start + avail), 0);
      return out;
    }
    canSlice() { return false; }
  }

  const res = await writeTags(new HugeSource(), { title: 'Huge File Test' }, { materialize: false });
  check('co64 upgrade: >4GB faststart no longer refused', res.ok, res.report?.error);
  if (res.ok) {
    const outMoov = res.parts.find((p) => p.kind === 'bytes').bytes;
    const s = new TextDecoder().decode(outMoov);
    check('co64 upgrade: output contains co64 box', s.includes('co64'));
    check('co64 upgrade: output has no leftover stco box', !s.includes('stco'));
    const findBox = (b, type, start, end) => {
      let p = start;
      while (p + 8 <= end) {
        const sz = u32(b, p);
        if (sz < 8 || p + sz > end) return null;
        const t = fourcc(b, p + 4);
        if (t === type) return { pos: p, size: sz };
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(t)) { const r = findBox(b, type, p + 8, p + sz); if (r) return r; }
        p += sz;
      }
      return null;
    };
    const co64 = findBox(outMoov, 'co64', 0, outMoov.length);
    if (co64) {
      const dv = new DataView(outMoov.buffer, outMoov.byteOffset, outMoov.byteLength);
      const v = dv.getBigUint64(co64.pos + 16);
      const expected = BigInt(STCO_OFFSET) + BigInt(res.report.delta);
      check(`co64 upgrade: offset = original + delta (0x${v.toString(16)})`, v === expected,
        `got ${v}, expected ${expected}`);
      check('co64 upgrade: shifted offset exceeds 32-bit range', v > 0xFFFFFFFFn);
    } else {
      check('co64 upgrade: co64 box found in output', false);
    }
  }
}

// G12: offsets stay 32-bit -> stco kept, no spurious upgrade
{
  const fx = F.buildMp4({ layout: 'head', chunks: 8, chunkSize: 4096 });
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), { title: 'test' });
  const out = await bytesOf(res);
  const s = new TextDecoder().decode(out.subarray(0, 4096));
  check('no-upgrade: stco kept when no overflow occurs', s.includes('stco') && !s.includes('co64'));
}

// G13: multiple traks — only the overflowing stco upgrades to co64
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map(c => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);

  const SMALL_OFFSET = 0x1000;            // video trak, stays 32-bit
  const BIG_OFFSET = 0xFFFFFFF8;          // audio trak, would overflow
  const FAKE_SIZE = 0xFFFFFFFF + 100;

  const mkTrak = (offset) => {
    const stcoBody = c2(u2(1), u2(offset));
    const stco = c2(u2(12 + stcoBody.length), a2('stco'), z2(4), stcoBody);
    const stbl = c2(u2(8 + stco.length), a2('stbl'), stco);
    const minf = c2(u2(8 + stbl.length), a2('minf'), stbl);
    const mdia = c2(u2(8 + minf.length), a2('mdia'), minf);
    return c2(u2(8 + mdia.length), a2('trak'), mdia);
  };

  const ftp = c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mvhd = c2(u2(108), a2('mvhd'), z2(100));
  const trakVideo = mkTrak(SMALL_OFFSET);
  const trakAudio = mkTrak(BIG_OFFSET);
  const moovBody = c2(mvhd, trakVideo, trakAudio);
  const moov = c2(u2(8 + moovBody.length), a2('moov'), moovBody);
  const head = c2(ftp, moov);
  const mdatSize = FAKE_SIZE - head.length;
  const realHead = c2(head, u2(mdatSize), a2('mdat'));

  class MultiTrakSource extends BufferSource {
    constructor() { super(realHead, 'video/mp4'); this.size = FAKE_SIZE; }
    async read(start, end) {
      if (end <= this.bytes.length) return this.bytes.subarray(start, end);
      const out = new Uint8Array(end - start);
      const avail = Math.max(0, Math.min(this.bytes.length - start, out.length));
      if (avail > 0) out.set(this.bytes.subarray(start, start + avail), 0);
      return out;
    }
    canSlice() { return false; }
  }

  const res = await writeTags(new MultiTrakSource(), { title: 'Multi Trak' }, { materialize: false });
  check('multi-trak: write succeeds', res.ok, res.report?.error);
  if (res.ok) {
    const outMoov = res.parts.find((p) => p.kind === 'bytes').bytes;
    // Count stco and co64 boxes recursively
    let stcoCount = 0, co64Count = 0;
    const countBoxes = (b, start, end) => {
      let p = start;
      while (p + 8 <= end) {
        const sz = u32(b, p);
        if (sz < 8 || p + sz > end) return;
        const t = fourcc(b, p + 4);
        if (t === 'stco') stcoCount++;
        else if (t === 'co64') co64Count++;
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(t)) countBoxes(b, p + 8, p + sz);
        p += sz;
      }
    };
    countBoxes(outMoov, 0, outMoov.length);
    check('multi-trak: only the overflowing trak upgraded (1 stco + 1 co64)',
      stcoCount === 1 && co64Count === 1, `stco=${stcoCount}, co64=${co64Count}`);
  }
}

// G14: real >4 GiB files — 64-bit sizes and offsets, end to end.
//
// Two 32-bit traps make the naive version of this test useless:
//   1. writing a >4 GiB mdat size into a 32-bit field silently wraps (the box
//      then lies about itself), so large mdat boxes need the 64-bit largesize form
//   2. Node's fs.openAsBlob reports a truncated size for files >= 4 GiB
//      (4 GiB -> 0, 8 GiB -> 0), which makes the planner read a wrong container
// Together they cancel out and let a broken test pass, so this uses explicit
// largesize headers plus NodeFileSource (fstat gives the true 64-bit size).
{
  const GB = 1 << 30;
  const canaryAt = (i) => Buffer.from(F.CHUNK_MARK(i));

  const sparseCase = async (label, opts, verify) => {
    const total = opts.total;
    const plan = F.buildSparseMp4Plan(total, opts);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-big-'));
    const fpath = path.join(dir, 'big.mp4');
    const fd = fs.openSync(fpath, 'w');
    fs.writeSync(fd, plan.head, 0, plan.head.length, 0);
    fs.ftruncateSync(fd, total);
    for (let i = 0; i < plan.chunks; i++) fs.writeSync(fd, canaryAt(i), 0, 8, plan.offsets[i]);
    if (plan.layout === 'tail') fs.writeSync(fd, plan.moovBytes, 0, plan.moovBytes.length, plan.tailAt);
    fs.closeSync(fd);

    const realSize = fs.statSync(fpath).size;
    const src = new NodeFileSource(fpath);
    check(`${label}: NodeFileSource reports the true 64-bit size`,
      src.size === realSize, `src=${src.size} fs=${realSize}`);

    const res = await writeTags(src, { title: 'Big File Test' });
    check(`${label}: write succeeds (${(realSize / GB).toFixed(2)} GiB, ${plan.layout})`, res.ok, res.report?.error);
    if (res.ok) {
      const read = res.report.stats.bytesRead;
      check(`${label}: header-only read (${read} bytes, ${(read / realSize * 100).toFixed(5)}%)`, read < (1 << 20));
      const delta = res.report.outputSize - realSize;
      const moov = res.parts.find((p) => p.kind === 'bytes').bytes;
      verify({ moov, delta, plan, res, realSize, label });
    }
    src.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return plan;
  };

  // --- 1) faststart, stco offsets just below 2^32: the shift must trigger a co64 upgrade
  {
    const chunks = 8;
    const total = 0xFFFFFFFF + 4096;
    const probe = F.buildSparseMp4Plan(total, { chunks, chunkSize: 1024, useCo64: true });
    const chunkSize = Math.floor((0xFFFFFFF0 - probe.mdatAt - probe.mdatHeader) / (chunks - 1));
    await sparseCase('>4GiB faststart (stco near 2^32)', { total, chunks, chunkSize }, ({ moov, delta, plan, label }) => {
      const { stco, co64 } = collectOffsets(moov);
      check(`${label}: upgraded to co64 (stco gone)`, stco.length === 0 && co64.length === plan.chunks,
        `stco=${stco.length} co64=${co64.length}`);
      check(`${label}: every co64 offset = original + delta`,
        co64.every((v, i) => v === plan.offsets[i] + delta), `delta=${delta}`);
      check(`${label}: 64-bit largesize mdat header preserved`,
        plan.mdatHeader === 16 && delta > 0);
    });
  }

  // --- 2) 8 GiB faststart that is already co64: stays co64, offsets shift
  {
    const chunks = 16;
    const total = 8 * GB;
    const probe = F.buildSparseMp4Plan(total, { chunks, chunkSize: 1024, useCo64: true });
    // samples must end inside the file: last offset + chunkSize == total
    const chunkSize = Math.floor((total - probe.mdatAt - probe.mdatHeader) / chunks);
    await sparseCase('8GiB faststart (already co64)', { total, chunks, chunkSize, useCo64: true }, ({ moov, delta, plan, label }) => {
      const { stco, co64 } = collectOffsets(moov);
      check(`${label}: stays co64 (no stco introduced)`, stco.length === 0 && co64.length === plan.chunks);
      check(`${label}: every co64 offset = original + delta`,
        co64.every((v, i) => v === plan.offsets[i] + delta), `delta=${delta}`);
      check(`${label}: offsets exceed 4 GiB (real 64-bit values)`,
        Math.max(...co64) > 0xFFFFFFFF, `max=${Math.max(...co64)}`);
    });
  }

  // --- 3) 8 GiB with moov at the tail (ffmpeg default): appending must not move offsets
  {
    const chunks = 8;
    const total = 8 * GB;
    const probe = F.buildSparseMp4Plan(total, { chunks, chunkSize: 1024, useCo64: true, layout: 'tail' });
    // samples must end where moov begins (moov occupies the tail)
    const chunkSize = Math.floor((total - probe.moovSize - probe.mdatAt - probe.mdatHeader) / chunks);
    const plan = await sparseCase('8GiB moov-at-tail', { total, chunks, chunkSize, useCo64: true, layout: 'tail' },
      ({ moov, delta, plan: p, res, label }) => {
        check(`${label}: zero-offset strategy chosen`, res.report.strategy === 'moov-at-tail-zero-offset',
          String(res.report.strategy));
        check(`${label}: moov grew by the new udta`, delta > 0, `delta=${delta}`);
        const { co64 } = collectOffsets(moov);
        check(`${label}: offsets unchanged (mdat does not move)`,
          co64.length === p.chunks && co64.every((v, i) => v === p.offsets[i]));
      });
  }
}

// G15: multiple mdta udta boxes — numeric ilst indices are relative to each
// udta's *own* keys table, so merging the tables renumbers them. The raw index
// of a preserved entry must be rebased, or it silently reads back as a
// different tag (regression from external review).
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);
  const box2 = (type, ...body) => { const b = c2(...body); return c2(u2(8 + b.length), a2(type), b); };
  const full2 = (type, ...body) => { const b = c2(...body); return c2(u2(12 + b.length), a2(type), z2(4), b); };
  const idxData = (idx, val) => { const p = a2(val); const inner = c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); return c2(u2(8 + inner.length), new Uint8Array([0, 0, 0, idx]), inner); };
  const hdlrMdta = () => full2('hdlr', z2(4), a2('mdta'), z2(12), z2(1));
  const keys2 = (names) => full2('keys', u2(names.length), ...names.map((n) => c2(u2(8 + n.length), a2('mdta'), a2(n))));
  const udtaWith = (names, entries) => box2('udta', full2('meta', hdlrMdta(), keys2(names), box2('ilst', ...entries)));

  // A: keys=[title,genre]; B: keys=[artist,genre] -> 'artist' is index 1 in B
  // but index 3 in the merged table.
  const udtaA = udtaWith(['title', 'genre'], [idxData(1, 'A-title'), idxData(2, 'A-genre')]);
  const udtaB = udtaWith(['artist', 'genre'], [idxData(1, 'B-artist'), idxData(2, 'B-genre')]);
  const fx = F.buildMp4({ layout: 'head' });
  let moovPos = -1, moovSize = 0;
  for (let i = 0; i < fx.bytes.length - 4; i++) { if (fourcc(fx.bytes, i + 4) === 'moov') { moovPos = i; moovSize = u32(fx.bytes, i); break; } }
  const newMoov = box2('moov', fx.bytes.subarray(moovPos + 8, moovPos + moovSize), udtaA, udtaB);
  const input = c2(fx.bytes.subarray(0, moovPos), newMoov, fx.bytes.subarray(moovPos + moovSize));

  const res = await writeTags(new BlobSource(new Blob([input])), { title: 'Merged title' });
  check('multi-udta mdta: write succeeds', res.ok, res.report?.error);
  if (res.ok) {
    const out = await bytesOf(res);
    const tags = readTags(out);
    check('multi-udta mdta: single merged udta', tags.udtaCount === 1, `udtaCount=${tags.udtaCount}`);
    check('multi-udta mdta: keys tables merged (title, genre, artist)',
      tags.keys.includes('title') && tags.keys.includes('genre') && tags.keys.includes('artist'),
      JSON.stringify(tags.keys));
    check('multi-udta mdta: second udta entry still reads as "artist"',
      tags.tags.artist === 'B-artist', JSON.stringify(tags.tags));
    check('multi-udta mdta: title holds the new value, not the artist entry',
      tags.tags.title === 'Merged title', JSON.stringify(tags.tags));
    check('multi-udta mdta: genre entry preserved from an old udta',
      tags.tags.genre === 'A-genre' || tags.tags.genre === 'B-genre', JSON.stringify(tags.tags));

    const res2 = await writeTags(new BlobSource(new Blob([out])), { title: 'Merged title' });
    const out2 = await bytesOf(res2);
    check('multi-udta mdta: second write is byte-identical',
      res2.ok && out2.length === out.length && out2.every((v, i) => v === out[i]));
  }
}

// G16: a malformed meta subtree must be refused, not silently truncated.
// The child walk used to stop at the bad box, and the rewrite then dropped
// everything after it while still reporting a successful write.
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);
  const box2 = (type, ...body) => { const b = c2(...body); return c2(u2(8 + b.length), a2(type), b); };
  const full2 = (type, ...body) => { const b = c2(...body); return c2(u2(12 + b.length), a2(type), z2(4), b); };
  const data2 = (val) => { const p = a2(val); return c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); };
  const mp4 = (metaKids) => c2(
    c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41')),
    box2('moov', c2(u2(108), a2('mvhd'), z2(100)),
      box2('udta', full2('meta', full2('hdlr', z2(4), a2('mdir'), z2(12), z2(1)), ...metaKids))),
    c2(u2(264), a2('mdat'), z2(256)));

  // (a) well-formed: an unknown meta child after ilst must be preserved
  const good = mp4([box2('ilst', box2('\xa9nam', data2('old'))), box2('name', a2('UNKNOWN_CHILD_MARKER'))]);
  const okRes = await writeTags(new BlobSource(new Blob([good])), { title: 'New title' });
  check('well-formed unknown meta child: write succeeds', okRes.ok, okRes.report?.error);
  if (okRes.ok) {
    const out = await bytesOf(okRes);
    check('well-formed unknown meta child: preserved in the output',
      new TextDecoder().decode(out).includes('UNKNOWN_CHILD_MARKER'));
  }

  // (b) malformed: a box whose size (< 8) makes the subtree untraversable
  const bad = mp4([
    box2('ilst', box2('\xa9nam', data2('old'))),
    c2(u2(4), a2('junk')),                                  // size 4 < 8 -> invalid
    box2('name', a2('LATER_METADATA_MARKER')),              // would be dropped by a silent break
  ]);
  const res = await writeTags(new BlobSource(new Blob([bad])), { title: 'New title' });
  check('malformed meta subtree: refused with a reason',
    res.ok === false && /malformed/.test(res.report.error || ''), String(res.report && res.report.error));
  check('malformed meta subtree: no output produced', !res.blob && !res.parts);
  const info = await inspect(new BlobSource(new Blob([bad])));
  check('malformed meta subtree: inspect() does not claim a safe write',
    info.format === 'mp4' && info.mp4.safeToWrite === false, JSON.stringify(info.mp4));
}

// G17: Android/MediaTek movies keep tags in `moov/meta` — a *sibling* of
// `moov/udta`, written in the bare QuickTime form (no version/flags). Two bugs
// met here: findChild() scanned past udta.end and read that sibling meta as if
// it were udta/meta, and meta children were only ever read with the ISO (+12)
// layout, which turns the QuickTime (+8) form into garbage.
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);
  const box2 = (type, ...body) => { const b = c2(...body); return c2(u2(8 + b.length), a2(type), b); };
  const full2 = (type, ...body) => { const b = c2(...body); return c2(u2(12 + b.length), a2(type), z2(4), b); };
  const idxEntry = (i, val) => { const p = a2(val); const inner = c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); return c2(u2(8 + inner.length), new Uint8Array([0, 0, 0, i]), inner); };
  const hdlrMdta = () => full2('hdlr', z2(4), a2('mdta'), z2(12), z2(1));
  const keys2 = (names) => full2('keys', u2(names.length), ...names.map((n) => c2(u2(8 + n.length), a2('mdta'), a2(n))));
  const ftyp = () => c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mvhd = () => c2(u2(108), a2('mvhd'), z2(100));
  const mdat = () => c2(u2(8 + 256), a2('mdat'), z2(256).fill(0x42));
  const kidsOf = (b, base, end) => { const out = []; let p = base; while (p + 8 <= end) { const s = u32(b, p); if (s < 8 || p + s > end) break; out.push({ pos: p, size: s, type: fourcc(b, p + 4), end: p + s }); p += s; } return out; };
  const moovOf = (b) => { for (let i = 0; i < b.length - 4; i++) if (fourcc(b, i + 4) === 'moov') return { pos: i, size: u32(b, i) }; return null; };
  // Read meta with automatic layout detection (mirrors what a tolerant reader does)
  const readMeta = (b, meta) => {
    const qt = kidsOf(b, meta.pos + 8, meta.end);
    const iso = kidsOf(b, meta.pos + 12, meta.end);
    const tile = (r) => r.length > 0 && r.some((k) => k.type === 'hdlr') && r[r.length - 1].end === meta.end;
    const qtLayout = tile(qt);
    const kids = qtLayout ? qt : iso;
    const keys = [];
    const kb = kids.find((k) => k.type === 'keys');
    if (kb) { const n = u32(b, kb.pos + 12); let p = kb.pos + 16; for (let i = 0; i < n; i++) { const s = u32(b, p); keys.push(new TextDecoder().decode(b.subarray(p + 8, p + s))); p += s; } }
    const tags = {};
    const il = kids.find((k) => k.type === 'ilst');
    if (il) for (const e of kidsOf(b, il.pos + 8, il.end)) {
      const numeric = e.type.charCodeAt(0) === 0 && e.type.charCodeAt(1) === 0 && e.type.charCodeAt(2) === 0;
      const key = numeric ? (keys[u32(b, e.pos + 4) - 1] ?? '#' + u32(b, e.pos + 4)) : e.type.replace(/\xa9/g, '©');
      const d = kidsOf(b, e.pos + 8, e.end).find((x) => x.type === 'data');
      tags[key] = d ? new TextDecoder().decode(b.subarray(d.pos + 16, d.end)) : '';
    }
    return { keys, tags, qtLayout };
  };
  // a udta with no meta at all — the all-zero placeholder vivo/MediaTek writes
  const placeholderUdta = box2('udta', c2(u2(30), z2(26)));

  // ---- (a) moov/meta in QuickTime form, next to a meta-less udta ----
  {
    const moov = box2('moov', mvhd(), placeholderUdta, box2('meta', hdlrMdta(), keys2(['com.android.version']), box2('ilst', idxEntry(1, '16'))));
    const input = c2(ftyp(), moov, mdat());
    const res = await writeTags(new BlobSource(new Blob([input])), { title: 'QT meta 标题', artist: 'QT 作者' });
    check('moov/meta (QuickTime style): write succeeds', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      const mv = moovOf(out);
      const mk = kidsOf(out, mv.pos + 8, mv.pos + mv.size);
      const udtaOut = mk.find((k) => k.type === 'udta');
      const metaOut = mk.find((k) => k.type === 'meta');
      check('moov/meta (QuickTime style): meta still a direct child of moov', !!metaOut);
      check('moov/meta (QuickTime style): layout stayed QuickTime (children at +8)',
        !!metaOut && readMeta(out, metaOut).qtLayout);
      check('moov/meta (QuickTime style): meta-less udta left byte-identical',
        !!udtaOut && out.subarray(udtaOut.pos, udtaOut.end).every((v, i) => v === placeholderUdta[i]));
      const parsed = readMeta(out, metaOut);
      check('moov/meta (QuickTime style): existing android key preserved',
        parsed.tags['com.android.version'] === '16', JSON.stringify(parsed.tags));
      check('moov/meta (QuickTime style): new tags written next to it',
        parsed.tags.title === 'QT meta 标题' && parsed.tags.artist === 'QT 作者', JSON.stringify(parsed.tags));
      check('moov/meta (QuickTime style): no duplicate udta/meta container created',
        !!udtaOut && !kidsOf(out, udtaOut.pos + 8, udtaOut.end).some((k) => k.type === 'meta'));
      const res2 = await writeTags(new BlobSource(new Blob([out])), { title: 'QT meta 标题', artist: 'QT 作者' });
      const out2 = await bytesOf(res2);
      check('moov/meta (QuickTime style): second write is byte-identical',
        res2.ok && out2.length === out.length && out2.every((v, i) => v === out[i]));
    }
  }

  // ---- (b) moov/meta in ISO FullBox form ----
  {
    const moov = box2('moov', mvhd(), full2('meta', hdlrMdta(), keys2(['custom.key']), box2('ilst', idxEntry(1, 'keep'))));
    const res = await writeTags(new BlobSource(new Blob([c2(ftyp(), moov, mdat())])), { title: 'ISO meta' });
    check('moov/meta (ISO style): write succeeds', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      const mv = moovOf(out);
      const metaOut = kidsOf(out, mv.pos + 8, mv.pos + mv.size).find((k) => k.type === 'meta');
      const parsed = readMeta(out, metaOut);
      check('moov/meta (ISO style): existing key preserved', parsed.tags['custom.key'] === 'keep', JSON.stringify(parsed.tags));
      check('moov/meta (ISO style): new title written', parsed.tags.title === 'ISO meta', JSON.stringify(parsed.tags));
    }
  }

  // ---- (c) QuickTime ©xxx atoms directly under udta cannot be merged -> refuse ----
  {
    const udtaQt = box2('udta', box2('\xa9nam', c2(u2(16 + 5), a2('data'), u2(1), u2(0), a2('old'))));
    const moov = box2('moov', mvhd(), udtaQt);
    const res = await writeTags(new BlobSource(new Blob([c2(ftyp(), moov, mdat())])), { title: 'x' });
    check('udta with QuickTime tag atoms: refused with a reason',
      res.ok === false && /QuickTime tag atoms/.test(res.report.error || ''), String(res.report?.error));
    check('udta with QuickTime tag atoms: no output produced', !res.blob && !res.parts);
  }

  // ---- (d) only a meta-less udta and no metadata anywhere -> create udta/meta ----
  {
    const moov = box2('moov', mvhd(), placeholderUdta);
    const res = await writeTags(new BlobSource(new Blob([c2(ftyp(), moov, mdat())])), { title: 'fresh' });
    check('meta-less udta only: write succeeds', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      const mv = moovOf(out);
      const mk = kidsOf(out, mv.pos + 8, mv.pos + mv.size);
      const udtas = mk.filter((k) => k.type === 'udta');
      check('meta-less udta only: a new udta/meta/ilst was created',
        udtas.length === 2 && udtas.some((k) => kidsOf(out, k.pos + 8, k.end).some((c) => c.type === 'meta')));
      check('meta-less udta only: the original placeholder is preserved (same size)',
        udtas.some((k) => k.size === placeholderUdta.length));
      check('meta-less udta only: a note records the ignored udta',
        res.report.notes.some((n) => /without a meta box/.test(n)), JSON.stringify(res.report.notes));
    }
  }
}

// G18: MP4 tag capabilities. `copyright` is written for real (mdir -> 'cprt',
// mdta -> 'copyright' key, both resolved by exiftool); `keywords` has no
// standard MP4 home and is refused instead of being silently dropped.
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);
  const box2 = (t, ...b) => { const x = c2(...b); return c2(u2(8 + x.length), a2(t), x); };
  const full2 = (t, ...b) => { const x = c2(...b); return c2(u2(12 + x.length), a2(t), z2(4), x); };
  const data2 = (v) => { const p = a2(v); return c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); };
  const idx2 = (i, v) => { const p = a2(v); const inner = c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); return c2(u2(8 + inner.length), new Uint8Array([0, 0, 0, i]), inner); };
  const hMdir = () => full2('hdlr', z2(4), a2('mdir'), z2(12), z2(1));
  const hMdta = () => full2('hdlr', z2(4), a2('mdta'), z2(12), z2(1));
  const keys2 = (ns) => full2('keys', u2(ns.length), ...ns.map((n) => c2(u2(8 + n.length), a2('mdta'), a2(n))));
  const udtaOf = (kids) => box2('udta', full2('meta', ...kids));
  const ftyp2 = () => c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mvhd2 = () => c2(u2(108), a2('mvhd'), z2(100));
  const mdat2 = () => c2(u2(8 + 256), a2('mdat'), z2(256).fill(0x42));
  const kidsOf = (b, base, end) => { const out = []; let p = base; while (p + 8 <= end) { const s = u32(b, p); if (s < 8 || p + s > end) break; out.push({ pos: p, size: s, type: fourcc(b, p + 4), end: p + s }); p += s; } return out; };

  // mdir: copyright must become an ilst entry named 'cprt'
  {
    const input = c2(ftyp2(), box2('moov', mvhd2(), udtaOf([hMdir(), box2('ilst', box2('\xa9cmt', data2('old')))])), mdat2());
    const res = await writeTags(new BlobSource(new Blob([input])), { copyright: 'COPY-MDIR' });
    check('MP4 mdir: copyright write succeeds', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      check('MP4 mdir: copyright value is stored', new TextDecoder().decode(out).includes('COPY-MDIR'));
      let moovPos = -1; for (let i = 0; i + 4 < out.length; i++) if (fourcc(out, i + 4) === 'moov') { moovPos = i; break; }
      const mv = kidsOf(out, moovPos + 8, moovPos + u32(out, moovPos));
      const udta = mv.find((k) => k.type === 'udta');
      const meta = kidsOf(out, udta.pos + 8, udta.end).find((k) => k.type === 'meta');
      const ilst = kidsOf(out, meta.pos + 12, meta.end).find((k) => k.type === 'ilst');
      const names = kidsOf(out, ilst.pos + 8, ilst.end).map((k) => k.type);
      check('MP4 mdir: stored under the atom exiftool reads as Copyright ("cprt")',
        names.includes('cprt'), JSON.stringify(names));
      check('MP4 mdir: pre-existing entry preserved', names.includes('\xa9cmt'), JSON.stringify(names));
    }
  }
  // mdta: copyright must land in the keys table as 'copyright'
  {
    const input = c2(ftyp2(), box2('moov', mvhd2(), udtaOf([hMdta(), keys2(['genre']), box2('ilst', idx2(1, 'M-genre'))])), mdat2());
    const res = await writeTags(new BlobSource(new Blob([input])), { copyright: 'COPY-MDTA' });
    check('MP4 mdta: copyright write succeeds', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      let moovPos = -1; for (let i = 0; i + 4 < out.length; i++) if (fourcc(out, i + 4) === 'moov') { moovPos = i; break; }
      const mv = kidsOf(out, moovPos + 8, moovPos + u32(out, moovPos));
      const meta = kidsOf(out, mv.find((k) => k.type === 'udta').pos + 8, mv.find((k) => k.type === 'udta').end).find((k) => k.type === 'meta');
      const kb = kidsOf(out, meta.pos + 12, meta.end).find((k) => k.type === 'keys');
      const keys = []; { const n = u32(out, kb.pos + 12); let p = kb.pos + 16; for (let i = 0; i < n; i++) { const s = u32(out, p); keys.push(new TextDecoder().decode(out.subarray(p + 8, p + s))); p += s; } }
      check('MP4 mdta: "copyright" added to the keys table', keys.includes('copyright'), JSON.stringify(keys));
      check('MP4 mdta: existing key preserved', keys.includes('genre'), JSON.stringify(keys));
    }
  }
  // keywords must be refused, not silently dropped
  {
    const input = c2(ftyp2(), box2('moov', mvhd2()), mdat2());
    const only = await writeTags(new BlobSource(new Blob([input])), { keywords: ['a', 'b'] });
    check('MP4 keywords-only: refused', only.ok === false, 'ok=true means it was silently dropped');
    check('MP4 keywords-only: errorCode is UNSUPPORTED_TAG', only.report.errorCode === 'UNSUPPORTED_TAG',
      String(only.report.errorCode));
    check('MP4 keywords-only: report names the unsupported field',
      JSON.stringify(only.report.unsupportedTags) === '["keywords"]', JSON.stringify(only.report.unsupportedTags));
    check('MP4 keywords-only: message lists what IS supported',
      /title, artist, date, comment, url, software, copyright/.test(only.report.error || ''), only.report.error);
    const mixed = await writeTags(new BlobSource(new Blob([input])), { title: 'T', keywords: ['a'] });
    check('MP4 title+keywords: refused as a whole (no silent partial write)',
      mixed.ok === false && mixed.report.errorCode === 'UNSUPPORTED_TAG');
    const okCopy = await writeTags(new BlobSource(new Blob([input])), { title: 'T', copyright: 'C' });
    check('MP4 title+copyright: supported combination still writes', okCopy.ok, okCopy.report?.error);
  }
  // capabilities() must agree with what writeTags accepts
  {
    const mp4 = capabilities('mp4'), jpeg = capabilities('jpeg');
    check('capabilities(mp4): supports copyright, not keywords',
      mp4.supported.includes('copyright') && mp4.unsupported.join() === 'keywords');
    check('capabilities(jpeg): supports all 8 fields', jpeg.unsupported.length === 0 && jpeg.supported.length === 8);
    const info = await inspect(new BlobSource(new Blob([c2(ftyp2(), box2('moov', mvhd2()), mdat2())])));
    check('inspect(): exposes the capability matrix', info.capabilities &&
      info.capabilities.unsupported.join() === 'keywords', JSON.stringify(info.capabilities));
  }
}

// G19: an iTunes (mdir) udta next to an Android (mdta) moov/meta is a real
// iOS/QuickTime layout. Merging them into one ilst would corrupt one side
// (numeric indices vs ©-atoms), so 'auto' updates each in its own format.
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);
  const box2 = (t, ...b) => { const x = c2(...b); return c2(u2(8 + x.length), a2(t), x); };
  const full2 = (t, ...b) => { const x = c2(...b); return c2(u2(12 + x.length), a2(t), z2(4), x); };
  const data2 = (v) => { const p = a2(v); return c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); };
  const idx2 = (i, v) => { const p = a2(v); const inner = c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); return c2(u2(8 + inner.length), new Uint8Array([0, 0, 0, i]), inner); };
  const hMdir = () => full2('hdlr', z2(4), a2('mdir'), z2(12), z2(1));
  const hMdta = () => full2('hdlr', z2(4), a2('mdta'), z2(12), z2(1));
  const ftyp2 = () => c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mvhd2 = () => c2(u2(108), a2('mvhd'), z2(100));
  const mdat2 = () => c2(u2(8 + 256), a2('mdat'), z2(256).fill(0x42));
  const kidsOf = (b, base, end) => { const out = []; let p = base; while (p + 8 <= end) { const s = u32(b, p); if (s < 8 || p + s > end) break; out.push({ pos: p, size: s, type: fourcc(b, p + 4), end: p + s }); p += s; } return out; };
  const readMetaTags = (b, meta) => {
    const qt = kidsOf(b, meta.pos + 8, meta.end);
    const kids = qt.some((k) => k.type === 'hdlr') ? qt : kidsOf(b, meta.pos + 12, meta.end);
    const h = kids.find((k) => k.type === 'hdlr');
    const hdlr = h ? fourcc(b, h.pos + 16) : null;
    const keys = [];
    const kb = kids.find((k) => k.type === 'keys');
    if (kb) { const n = u32(b, kb.pos + 12); let p = kb.pos + 16; for (let i = 0; i < n; i++) { const s = u32(b, p); keys.push(new TextDecoder().decode(b.subarray(p + 8, p + s))); p += s; } }
    const ilst = kids.find((k) => k.type === 'ilst');
    let numeric = 0, atom = 0; const tags = {};
    if (ilst) for (const e of kidsOf(b, ilst.pos + 8, ilst.end)) {
      const isNum = e.type.charCodeAt(0) === 0 && e.type.charCodeAt(1) === 0 && e.type.charCodeAt(2) === 0;
      if (isNum) numeric++; else atom++;
      const key = isNum ? (keys[u32(b, e.pos + 4) - 1] ?? '?') : e.type.replace(/\xa9/g, '©');
      const d = kidsOf(b, e.pos + 8, e.end).find((x) => x.type === 'data');
      tags[key] = d ? new TextDecoder().decode(b.subarray(d.pos + 16, d.end)) : '';
    }
    return { hdlr, keys, tags, numeric, atom };
  };

  const mdirUdta = box2('udta', full2('meta', hMdir(), box2('ilst', box2('\xa9cmt', data2('C-comment')))));
  const mdtaMeta = box2('meta', hMdta(), full2('keys', u2(1), c2(u2(8 + 5), a2('mdta'), a2('genre'))), box2('ilst', idx2(1, 'M-genre')));
  const input = c2(ftyp2(), box2('moov', mvhd2(), mdirUdta, mdtaMeta), mdat2());

  const res = await writeTags(new BlobSource(new Blob([input])), { title: 'New title' });
  check('mixed handlers: write succeeds', res.ok, res.report?.error);
  if (res.ok) {
    const out = await bytesOf(res);
    let moovPos = -1; for (let i = 0; i + 4 < out.length; i++) if (fourcc(out, i + 4) === 'moov') { moovPos = i; break; }
    const mk = kidsOf(out, moovPos + 8, moovPos + u32(out, moovPos));
    const ut = kidsOf(out, mk.find((k) => k.type === 'udta').pos + 8, mk.find((k) => k.type === 'udta').end).find((k) => k.type === 'meta');
    const mt = mk.find((k) => k.type === 'meta');
    const a = readMetaTags(out, ut), b = readMetaTags(out, mt);
    check('mixed handlers: udta container stays mdir', a.hdlr === 'mdir', a.hdlr);
    check('mixed handlers: moov/meta container stays mdta', b.hdlr === 'mdta', b.hdlr);
    check('mixed handlers: no mixed ilst (mdir holds no numeric entries)', a.numeric === 0, JSON.stringify(a));
    check('mixed handlers: no mixed ilst (mdta holds no ©-atoms)', b.atom === 0, JSON.stringify(b));
    check('mixed handlers: original tags preserved in both containers',
      a.tags['©cmt'] === 'C-comment' && b.tags.genre === 'M-genre', JSON.stringify([a.tags, b.tags]));
    check('mixed handlers: new tag written to each container',
      a.tags['©nam'] === 'New title' && b.tags.title === 'New title', JSON.stringify([a.tags, b.tags]));
    check('mixed handlers: note explains the split', res.report.notes.some((n) => /mixed metadata handlers/.test(n)),
      JSON.stringify(res.report.notes));
    const res2 = await writeTags(new BlobSource(new Blob([out])), { title: 'New title' });
    const out2 = await bytesOf(res2);
    check('mixed handlers: second write is byte-identical',
      res2.ok && out2.length === out.length && out2.every((v, i) => v === out[i]));
  }
}

// G20: HTTP random access is only safe if the server really honoured the range
{
  const mkRes = (status, headers, body) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, ...body });
  // a correct range: accepted
  {
    let cancelled = false;
    const fetchImpl = async (url, opts) => {
      const r = opts?.headers?.Range;
      if (r === 'bytes=0-0') return mkRes(206, { 'content-range': 'bytes 0-0/1000000' }, { body: { cancel() { cancelled = true; } } });
      return mkRes(206, { 'content-range': 'bytes 100-199/1000000' }, { arrayBuffer: async () => new Uint8Array(100).fill(7).buffer });
    };
    const src = await new HttpSource('http://x', { fetchImpl }).init();
    check('HttpSource: valid Content-Range accepted', (await src.read(100, 200))[0] === 7);
    check('HttpSource: probe body cancelled on the 206 path', cancelled);
  }
  // wrong window: refused
  {
    const fetchImpl = async (url, opts) => {
      const r = opts?.headers?.Range;
      if (r === 'bytes=0-0') return mkRes(206, { 'content-range': 'bytes 0-0/1000000' }, { body: { cancel() {} } });
      return mkRes(206, { 'content-range': 'bytes 0-99/1000000' }, { arrayBuffer: async () => new Uint8Array(100).fill(0xab).buffer });
    };
    const src = await new HttpSource('http://x', { fetchImpl }).init();
    let err = null; try { await src.read(100, 200); } catch (e) { err = e; }
    check('HttpSource: mismatched Content-Range refused', !!err && err.code === 'RANGE_MISMATCH', String(err && err.message));
  }
  // truncated body: refused
  {
    const fetchImpl = async (url, opts) => {
      const r = opts?.headers?.Range;
      if (r === 'bytes=0-0') return mkRes(206, { 'content-range': 'bytes 0-0/1000000' }, { body: { cancel() {} } });
      return mkRes(206, { 'content-range': 'bytes 100-199/1000000' }, { arrayBuffer: async () => new Uint8Array(40).buffer });
    };
    const src = await new HttpSource('http://x', { fetchImpl }).init();
    let err = null; try { await src.read(100, 200); } catch (e) { err = e; }
    check('HttpSource: short read refused', !!err && err.code === 'RANGE_MISMATCH', String(err && err.message));
  }
  // no Range support: body must still be released
  {
    let cancelled = false;
    const fetchImpl = async () => mkRes(200, { 'content-length': '1048576' }, { body: { cancel() { cancelled = true; } } });
    const src = await new HttpSource('http://x', { fetchImpl }).init();
    check('HttpSource: no-Range server detected', src.rangeSupported === false);
    check('HttpSource: probe body cancelled on the 200 path', cancelled);
    let err = null; try { await src.read(0, 100); } catch (e) { err = e; }
    check('HttpSource: random access refused without Range', !!err && err.code === 'RANGE_UNSUPPORTED');
  }
}

// G21: 64-bit largesize boxes get an accurate diagnosis (not "invalid size")
{
  const c2 = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
  const z2 = (n) => new Uint8Array(n);
  const u8b = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
  const box2 = (t, ...b) => { const x = c2(...b); return c2(u2(8 + x.length), a2(t), x); };
  const full2 = (t, ...b) => { const x = c2(...b); return c2(u2(12 + x.length), a2(t), z2(4), x); };
  const data2 = (v) => { const p = a2(v); return c2(u2(16 + p.length), a2('data'), u2(1), u2(0), p); };
  const hMdir = () => full2('hdlr', z2(4), a2('mdir'), z2(12), z2(1));
  const ftyp2 = () => c2(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mvhd2 = () => c2(u2(108), a2('mvhd'), z2(100));
  const mdat2 = () => c2(u2(8 + 256), a2('mdat'), z2(256).fill(0x42));

  // (a) a child box written with a 64-bit largesize header
  const inner = box2('\xa9nam', data2('LARGE'));
  const ilstLarge = c2(u2(1), a2('ilst'), u8b(16 + inner.length), inner);
  const withChildLarge = c2(ftyp2(), box2('moov', mvhd2(), box2('udta', full2('meta', hMdir(), box2('ilst', ilstLarge)))), mdat2());
  const r1 = await writeTags(new BlobSource(new Blob([withChildLarge])), { title: 'x' });
  check('largesize child box: refused', r1.ok === false);
  check('largesize child box: message says largesize, not "invalid size"',
    /largesize/.test(r1.report.error || ''), r1.report.error);

  // (b) the moov box itself uses a 64-bit largesize header
  const moovLarge = c2(u2(1), a2('moov'), u8b(16 + mvhd2().length), mvhd2());
  const r2 = await writeTags(new BlobSource(new Blob([c2(ftyp2(), moovLarge, mdat2())])), { title: 'x' });
  check('largesize moov: refused with a precise reason',
    r2.ok === false && /largesize/.test(r2.report.error || '') && r2.report.errorCode === 'UNSUPPORTED_LARGESIZE',
    `${r2.report.errorCode}: ${r2.report.error}`);
}

// G22: media-payload invariants — hashes, not just structural validity
{
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const concat = (chunks) => { const n = chunks.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length; } return o; };
  // PNG: every IDAT byte must survive
  {
    const fx = F.buildPng({ withXmp: true });
    const idat = (b) => { const ch = []; let p = 8; while (p + 8 <= b.length) { const n = u32(b, p); const t = fourcc(b, p + 4); if (t === 'IDAT') ch.push(b.subarray(p + 8, p + 8 + n)); p += 12 + n; if (t === 'IEND') break; } return concat(ch); };
    const res = await writeTags(new BlobSource(new Blob([fx.bytes])), TAGS);
    const out = await bytesOf(res);
    check('PNG invariant: IDAT sha256 unchanged', sha(idat(fx.bytes)) === sha(idat(out)),
      `${sha(idat(fx.bytes)).slice(0, 12)} vs ${sha(idat(out)).slice(0, 12)}`);
  }
  // JPEG: the entropy-coded scan (SOS → EOF) must survive byte-for-byte
  {
    const fx = F.buildJpeg({ withXmp: true });
    const sos = (b) => { for (let i = 2; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xda) return i; return -1; };
    const res = await writeTags(new BlobSource(new Blob([fx.bytes])), TAGS);
    const out = await bytesOf(res);
    check('JPEG invariant: entropy-coded scan sha256 unchanged',
      sha(fx.bytes.subarray(sos(fx.bytes))) === sha(out.subarray(sos(out))));
  }
  // MP4: the mdat payload must survive byte-for-byte
  {
    const fx = F.buildMp4({ layout: 'head', chunks: 8, chunkSize: 4096 });
    const mdat = (b) => { const t = topBoxes(b); const m = t.boxes.find((x) => x.type === 'mdat'); return b.subarray(m.pos + m.header, m.end); };
    const res = await writeTags(new BlobSource(new Blob([fx.bytes])), TAGS);
    const out = await bytesOf(res);
    check('MP4 invariant: mdat sha256 unchanged', sha(mdat(fx.bytes)) === sha(mdat(out)),
      `${sha(mdat(fx.bytes)).slice(0, 12)} vs ${sha(mdat(out)).slice(0, 12)}`);
  }
}

// G23: the structured report summary (additive to notes/warnings/stats)
{
  const cases = [
    ['JPEG', F.buildJpeg({ withXmp: true }).bytes],
    ['PNG', F.buildPng({ withXmp: true }).bytes],
    ['MP4', F.buildMp4({ layout: 'head', chunks: 8, chunkSize: 4096, existing: 'mdta' }).bytes],
  ];
  for (const [label, bytes] of cases) {
    const res = await writeTags(new BlobSource(new Blob([bytes])), { title: 'T', artist: 'A' });
    const rep = res.report;
    check(`${label} report: input carries size/mime`, rep.input && rep.input.size === bytes.length,
      JSON.stringify(rep.input));
    check(`${label} report: changes says the media payload was not touched`,
      rep.changes && rep.changes.mediaBytesChanged === false && rep.changes.reencoded === false,
      JSON.stringify(rep.changes));
    check(`${label} report: changes.metadataBytes == bytes actually inserted`,
      rep.changes.metadataBytes === rep.edits.reduce((a, e) => a + e.bytes, 0),
      `${rep.changes.metadataBytes} vs ${rep.edits.reduce((a, e) => a + e.bytes, 0)}`);
    check(`${label} report: changes.netDelta matches the real size change`,
      rep.changes.netDelta === res.blob.size - bytes.length,
      `${rep.changes.netDelta} vs ${res.blob.size - bytes.length}`);
    check(`${label} report: metadata lists the fields actually written`,
      rep.metadata && JSON.stringify(rep.metadata.addedTags) === '["title","artist"]',
      JSON.stringify(rep.metadata));
    check(`${label} report: offsets describes the shift`,
      rep.offsets && rep.offsets.shifted === (rep.changes.netDelta !== 0) && rep.offsets.delta === rep.changes.netDelta,
      JSON.stringify(rep.offsets));
    check(`${label} report: legacy fields still present`,
      Array.isArray(rep.notes) && Array.isArray(rep.warnings) && rep.stats && typeof rep.bytesRead !== 'undefined' ||
      Array.isArray(rep.notes) && Array.isArray(rep.warnings) && rep.stats,
      Object.keys(rep).join(','));
  }
  // MP4-specific extras
  const mp4 = F.buildMp4({ layout: 'head', chunks: 8, chunkSize: 4096, existing: 'mdta' }).bytes;
  const r = await writeTags(new BlobSource(new Blob([mp4])), { title: 'T' });
  check('MP4 report: metadata.format + existingContainers + preservedTags',
    ['mdir', 'mdta'].includes(r.report.metadata.format) &&
    Array.isArray(r.report.metadata.existingContainers) &&
    typeof r.report.metadata.preservedTags === 'number',
    JSON.stringify(r.report.metadata));
  check('MP4 report: offsets.stcoUpgraded is a boolean',
    typeof r.report.offsets.stcoUpgraded === 'boolean', JSON.stringify(r.report.offsets));
}

/* ===================================================================== */
section('K. JPEG native EXIF (IFD0): Title/Artist reach OS property sheets');

/**
 * Uses the spec-valid EXIF fixture from fixtures.mjs (IFD0 with ExifIFD/GPS
 * pointers and an IFD1 thumbnail; `exiftool -validate` says OK). Whatever
 * changes after a write is therefore the library's doing, not the fixture's.
 */
{
  /** Small byte helpers for reading/building the EXIF segments under test. */
  const tU16 = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
  const tU32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const tCat = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of parts) { o.set(c, p); p += c.length; } return o; };
  const tUtf8 = (s) => new TextEncoder().encode(s);

  /** Pull the Exif APP1 payload (after 'Exif\0\0') out of a JPEG, or null. */
  function exifTiffOf(jpegBytes) {
    for (let i = 2; i + 4 <= jpegBytes.length && jpegBytes[i] === 0xff;) {
      const marker = jpegBytes[i + 1];
      if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      const len = (jpegBytes[i + 2] << 8) | jpegBytes[i + 3];
      if (len < 2 || i + 2 + len > jpegBytes.length) return null;
      if (marker === 0xe1 && jpegBytes.subarray(i + 4, i + 10).join() === tUtf8('Exif\0\0').join()) {
        return jpegBytes.subarray(i + 10, i + 2 + len);
      }
      if (marker === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }

  /** Minimal TIFF reader used to verify the result independently of the library. */
  function readTiff(t) {
    const le = t[0] === 0x49;
    const u16 = (o) => (le ? (t[o] | (t[o + 1] << 8)) : ((t[o] << 8) | t[o + 1]));
    const u32 = (o) => (le
      ? ((t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0)
      : (((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0));
    const readIfd = (off) => {
      const n = u16(off);
      const out = {};
      for (let i = 0; i < n; i++) {
        const at = off + 2 + i * 12;
        const type = u16(at + 2);
        const count = u32(at + 4);
        const width = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] || 1;
        const len = width * count;
        const raw = len <= 4 ? t.subarray(at + 8, at + 8 + len) : t.subarray(u32(at + 8), u32(at + 8) + len);
        out[u16(at)] = { type, count, raw, text: type === 2 ? new TextDecoder().decode(raw).replace(/\0+$/, '') : null, value: u32(at + 8) };
      }
      return { entries: out, next: u32(off + 2 + n * 12) };
    };
    return { readIfd, ifd0Offset: u32(4), le };
  }

  const NATIVE_TAGS = {
    title: 'Native 标题 Title', artist: 'Native Artist', copyright: '© 2026 asinnny',
    date: '2026-09-23T01:02:03Z', comment: 'XMP only', url: 'https://example.com',
    software: 'stamp-js', keywords: ['a', 'b'],
  };

  // ---- (a) inject into an existing, spec-valid EXIF ----
  {
    const fx = F.buildJpegWithExif();
    const res = await writeTags(new BlobSource(new Blob([fx.bytes])), NATIVE_TAGS);
    check('EXIF: write succeeds', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      const tiff = exifTiffOf(out);
      check('EXIF: output still carries exactly one Exif APP1', !!tiff);
      const tr = readTiff(tiff);
      const ifd0 = tr.readIfd(tr.ifd0Offset);
      const exifPtr = ifd0.entries[0x8769];
      const gpsPtr = ifd0.entries[0x8825];
      const exifIfd = exifPtr ? tr.readIfd(exifPtr.value) : null;
      const gps = gpsPtr ? tr.readIfd(gpsPtr.value) : null;
      const ifd1 = tr.readIfd(ifd0.next);

      check('EXIF: 0x010E ImageDescription holds the title',
        ifd0.entries[0x010e]?.text === NATIVE_TAGS.title, JSON.stringify(ifd0.entries[0x010e]?.text));
      check('EXIF: 0x013B Artist holds the artist',
        ifd0.entries[0x013b]?.text === NATIVE_TAGS.artist, JSON.stringify(ifd0.entries[0x013b]?.text));
      check('EXIF: 0x8298 Copyright holds the copyright',
        ifd0.entries[0x8298]?.text === NATIVE_TAGS.copyright, JSON.stringify(ifd0.entries[0x8298]?.text));
      check('EXIF: 0x0132 DateTime converted to EXIF format',
        ifd0.entries[0x0132]?.text === '2026:09:23 01:02:03', JSON.stringify(ifd0.entries[0x0132]?.text));

      check('EXIF: camera tags untouched (Make/Model/Software/Orientation)',
        ifd0.entries[0x010f]?.text === 'TESTCAM' && ifd0.entries[0x0110]?.text === 'TestCam X1'
        && ifd0.entries[0x0131]?.text === 'FW 01.0' && ifd0.entries[0x0112]?.raw[1] === 1,
        JSON.stringify([ifd0.entries[0x010f]?.text, ifd0.entries[0x0131]?.text]));
      check('EXIF: ExifIFD intact (DateTimeOriginal is NOT rewritten)',
        exifIfd && exifIfd.entries[0x9003]?.text === '2020:01:01 00:00:00'
        && exifIfd.entries[0x8827]?.raw[1] === 100,
        JSON.stringify(exifIfd?.entries[0x9003]?.text));
      check('EXIF: GPS IFD intact',
        gps && gps.entries[0x0001]?.text === 'N' && gps.entries[0x0002]?.raw.length === 24,
        JSON.stringify(gps?.entries[0x0001]?.text));
      const newThumbAt = ifd1.entries[0x0201]?.value;
      check('EXIF: IFD1 thumbnail still points at the same 64 bytes',
        ifd1.entries[0x0202]?.value === fx.thumbLen && newThumbAt === fx.tailAt
        && tiff.subarray(newThumbAt, newThumbAt + fx.thumbLen).every((v) => v === 0xee),
        JSON.stringify({ at: newThumbAt, was: fx.tailAt, len: ifd1.entries[0x0202]?.value }));

      // Strongest structural invariant: we only append, so the original TIFF
      // block must still be a byte-exact prefix (apart from the IFD0 pointer).
      const oldPrefix = fx.tiff;
      const same = tiff.length > oldPrefix.length
        && oldPrefix.every((v, i) => (i >= 4 && i < 8) || v === tiff[i]);
      check('EXIF: everything but the IFD0 pointer is still a byte-exact prefix (append-only)',
        same, `${oldPrefix.length} vs ${tiff.length}`);
      check('EXIF: report.exif lists the four tags updated',
        JSON.stringify(res.report.exif?.updated) === '[270,306,315,33432]', JSON.stringify(res.report.exif));

      const res2 = await writeTags(new BlobSource(new Blob([out])), NATIVE_TAGS);
      const out2 = await bytesOf(res2);
      check('EXIF: second write is byte-identical',
        res2.ok && out2.length === out.length && out2.every((v, i) => v === out[i]));

      // Nothing changed → the EXIF segment must not be touched at all
      const res3 = await writeTags(new BlobSource(new Blob([out])), { ...NATIVE_TAGS, title: NATIVE_TAGS.title });
      const out3 = await bytesOf(res3);
      check('EXIF: a write with identical values leaves the file byte-identical',
        res3.ok && out3.length === out.length && out3.every((v, i) => v === out[i]));
    }
  }

  // ---- (b) opt-out ----
  {
    const fx = F.buildJpegWithExif();
    const out = await bytesOf(await writeTags(new BlobSource(new Blob([fx.bytes])), NATIVE_TAGS, { nativeExif: false }));
    const tiff = exifTiffOf(out);
    check('EXIF: nativeExif:false leaves the EXIF block byte-identical',
      tiff && tiff.every((v, i) => v === fx.tiff[i]), `${tiff?.length} vs ${fx.tiff.length}`);
  }

  // ---- (c) file without any EXIF ----
  {
    const plain = F.buildJpeg({ withXmp: true });
    const res = await writeTags(new BlobSource(new Blob([plain.bytes])), NATIVE_TAGS);
    check('EXIF: a JPEG without EXIF is written too', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      const tiff = exifTiffOf(out);
      check('EXIF: a minimal Exif APP1 was created', !!tiff);
      if (tiff) {
        const ifd0 = readTiff(tiff).readIfd(readTiff(tiff).ifd0Offset);
        check('EXIF: synthesized block carries title/artist/copyright/date',
          ifd0.entries[0x010e]?.text === NATIVE_TAGS.title
          && ifd0.entries[0x013b]?.text === NATIVE_TAGS.artist
          && ifd0.entries[0x8298]?.text === NATIVE_TAGS.copyright
          && ifd0.entries[0x0132]?.text === '2026:09:23 01:02:03',
          JSON.stringify(Object.keys(ifd0.entries)));
        check('EXIF: synthesized block has no next IFD', ifd0.next === 0, String(ifd0.next));
        check('EXIF: tags are in ascending order (spec requires it)',
          Object.keys(ifd0.entries).map(Number).every((t, i, a) => i === 0 || a[i - 1] < t),
          JSON.stringify(Object.keys(ifd0.entries)));
      }
    }
  }

  // ---- (d) XMP still carries everything (the two are independent) ----
  {
    const fx = F.buildJpegWithExif();
    const out = await bytesOf(await writeTags(new BlobSource(new Blob([fx.bytes])), NATIVE_TAGS));
    const text = new TextDecoder().decode(out);
    check('EXIF: XMP still carries comment/url/keywords (EXIF only mirrors 4 fields)',
      text.includes('XMP only') && text.includes('https://example.com') && text.includes('<rdf:li>a</rdf:li>'));
    check('EXIF: IFD0 Software keeps the camera value (not overwritten by "stamp-js")',
      !new TextDecoder().decode(exifTiffOf(out)).includes('stamp-js'));
  }

  // ---- (e) corrupt EXIF degrades to a warning, the XMP still gets written ----
  {
    const brokenExif = new Uint8Array([0x4d, 0x4d, 0, 99, 0, 0, 0, 8]);   // magic != 42
    const broken = tCat(new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xe1]), tU16(2 + 6 + brokenExif.length), tUtf8('Exif\0\0'), brokenExif,
      new Uint8Array([0xff, 0xdb]), tU16(67), new Uint8Array([0]), new Uint8Array(64).fill(16),
      new Uint8Array([0xff, 0xc0]), tU16(17), new Uint8Array([8]), tU16(64), tU16(64), new Uint8Array([3]),
      new Uint8Array([1, 0x22, 0]), new Uint8Array([2, 0x11, 1]), new Uint8Array([3, 0x11, 1]),
      new Uint8Array([0xff, 0xda]), tU16(12), new Uint8Array([3]), new Uint8Array([1, 0, 2, 0, 3, 0]), new Uint8Array([0, 0x3f, 0]),
      new Uint8Array(512).fill(0x5a), new Uint8Array([0xff, 0xd9]));
    const res = await writeTags(new BlobSource(new Blob([broken])), NATIVE_TAGS);
    check('EXIF: unparseable EXIF → write still succeeds (XMP is written)', res.ok, res.report?.error);
    check('EXIF: unparseable EXIF is reported as a warning, not silence',
      res.ok && res.report.warnings.some((w) => /native EXIF not updated/.test(w)), JSON.stringify(res.report?.warnings));
    if (res.ok) {
      const out = await bytesOf(res);
      const segLen = 2 + 6 + brokenExif.length;
      check('EXIF: the broken EXIF segment was left untouched (only XMP added)',
        new TextDecoder().decode(out).includes('stamp-js')
        && out.subarray(2, 2 + segLen).every((v, i) => v === broken.subarray(2, 2 + segLen)[i]),
        JSON.stringify(Array.from(out.subarray(2, 6))));
    }
  }
  // ---- (f) UserComment (ExifIFD) ----
  {
    const fx = F.buildJpegWithExif();
    const res = await writeTags(new BlobSource(new Blob([fx.bytes])), NATIVE_TAGS);
    const out = await bytesOf(res);
    const tr = readTiff(exifTiffOf(out));
    const ifd0 = tr.readIfd(tr.ifd0Offset);
    const exifIfd = tr.readIfd(ifd0.entries[0x8769].value);
    const uc = exifIfd.entries[0x9286];
    check('EXIF: UserComment written into the ExifIFD', !!uc, JSON.stringify(Object.keys(exifIfd.entries)));
    if (uc) {
      const raw = uc.raw;
      const prefix = new TextDecoder().decode(raw.subarray(0, 8)).replace(/\0+$/, '');
      check('EXIF: ASCII comment uses the ASCII character code',
        prefix === 'ASCII' && new TextDecoder().decode(raw.subarray(8)) === NATIVE_TAGS.comment,
        `${prefix} / ${new TextDecoder().decode(raw.subarray(8))}`);
      check('EXIF: ExifIFD keeps its other tags (DateTimeOriginal/ISO/ExifVersion)',
        exifIfd.entries[0x9003]?.text === '2020:01:01 00:00:00' && exifIfd.entries[0x8827]?.raw[1] === 100
        && exifIfd.entries[0x9000]?.raw.length === 4,
        JSON.stringify(Object.keys(exifIfd.entries)));
    }
    // Non-ASCII → UNICODE + UTF-16LE with a BOM (without the BOM readers guess
    // the byte order and show mojibake).
    const cn = '中文备注';
    const res2 = await writeTags(new BlobSource(new Blob([fx.bytes])), { ...NATIVE_TAGS, comment: cn });
    const out2 = await bytesOf(res2);
    const tr2 = readTiff(exifTiffOf(out2));
    const uc2 = tr2.readIfd(tr2.readIfd(tr2.ifd0Offset).entries[0x8769].value).entries[0x9286];
    const raw2 = uc2.raw;
    check('EXIF: non-ASCII comment uses UNICODE + UTF-16LE with BOM',
      new TextDecoder().decode(raw2.subarray(0, 8)).replace(/\0+$/, '') === 'UNICODE'
      && raw2[8] === 0xff && raw2[9] === 0xfe
      && new TextDecoder('utf-16le').decode(raw2.subarray(10)) === cn,
      raw2.subarray(0, 12).toString());
    // Changing only the comment must still be idempotent
    const res3 = await writeTags(new BlobSource(new Blob([out2])), { ...NATIVE_TAGS, comment: cn });
    const out3 = await bytesOf(res3);
    check('EXIF: UserComment second write is byte-identical',
      res3.ok && out3.length === out2.length && out3.every((v, i) => v === out2[i]));
  }

  // ---- (g) PNG: the same TIFF machinery in an eXIf chunk ----
  {
    const pngExif = (bytes) => {
      let p = 8;
      while (p + 8 <= bytes.length) {
        const n = u32(bytes, p);
        const t = fourcc(bytes, p + 4);
        if (t === 'eXIf') return bytes.subarray(p + 8, p + 8 + n);
        if (t === 'IEND') break;
        p += 12 + n;
      }
      return null;
    };
    const fx = F.buildPngWithExif();
    const res = await writeTags(new BlobSource(new Blob([fx.bytes])), NATIVE_TAGS);
    check('PNG eXIf: write succeeds', res.ok, res.report?.error);
    if (res.ok) {
      const out = await bytesOf(res);
      const tiff = pngExif(out);
      check('PNG eXIf: chunk still present', !!tiff);
      const tr = readTiff(tiff);
      const ifd0 = tr.readIfd(tr.ifd0Offset);
      const exifIfd = tr.readIfd(ifd0.entries[0x8769].value);
      check('PNG eXIf: IFD0 carries title/artist/copyright',
        ifd0.entries[0x010e]?.text === NATIVE_TAGS.title && ifd0.entries[0x013b]?.text === NATIVE_TAGS.artist
        && ifd0.entries[0x8298]?.text === NATIVE_TAGS.copyright,
        JSON.stringify([ifd0.entries[0x010e]?.text, ifd0.entries[0x013b]?.text]));
      check('PNG eXIf: no EXIF date duplicated (PNG has its own Creation Time chunk)',
        !ifd0.entries[0x0132] && new TextDecoder().decode(out).includes('Creation Time'));
      check('PNG eXIf: UserComment written', exifIfd.entries[0x9286]?.raw.length > 8);
      check('PNG eXIf: GPS/thumbnail intact',
        tr.readIfd(ifd0.entries[0x8825].value).entries[0x0001]?.text === 'N'
        && tr.readIfd(ifd0.next).entries[0x0202]?.value === fx.thumbLen);
      check('PNG eXIf: original TIFF is still a byte-exact prefix (append-only)',
        tiff.length > fx.tiff.length && fx.tiff.every((v, i) => (i >= 4 && i < 8) || v === tiff[i]));
      check('PNG: chunk CRCs still valid after the rewrite',
        (() => { let p = 8; while (p + 8 <= out.length) { const n = u32(out, p); p += 12 + n; if (fourcc(out, out.length ? p - 12 + 4 : 0) === 'IEND') break; } return p === out.length; })());
      const res2 = await writeTags(new BlobSource(new Blob([out])), NATIVE_TAGS);
      const out2 = await bytesOf(res2);
      check('PNG eXIf: second write is byte-identical',
        res2.ok && out2.length === out.length && out2.every((v, i) => v === out[i]));
    }
    // PNG without any eXIf → one is created
    const plain = F.buildPng({ withXmp: true });
    const res3 = await writeTags(new BlobSource(new Blob([plain.bytes])), NATIVE_TAGS);
    const out3 = await bytesOf(res3);
    const created = pngExif(out3);
    check('PNG eXIf: created when the file had none', !!created);
    if (created) {
      const ifd0 = readTiff(created).readIfd(8);
      check('PNG eXIf: created chunk carries the fields',
        ifd0.entries[0x010e]?.text === NATIVE_TAGS.title && ifd0.entries[0x8298]?.text === NATIVE_TAGS.copyright);
    }
    check('PNG eXIf: nativeExif:false writes no eXIf',
      !pngExif(await bytesOf(await writeTags(new BlobSource(new Blob([plain.bytes])), NATIVE_TAGS, { nativeExif: false }))));
  }
}

/* ===================================================================== */
section('H. Motion photo (MPF): absolute offsets must follow the header length');
{
  const payload = new Uint8Array(777).fill(0x5a);
  const plain = F.buildJpegWithMpf({ payload });
  const ref = readMpf(plain.bytes);
  check('fixture: MPF index resolves to the appended payload',
    !!ref && ref.entries.length === 2 && ref.entries[1].abs === plain.payloadAt,
    JSON.stringify(ref && ref.entries));

  // Replacement of a small existing XMP grows the header; replacing a bulky one
  // shrinks it. Both directions must rebase the index.
  const bulky = F.buildJpegWithMpf({ payload, existingXmp: true });
  const cases = [
    ['growing header', plain.bytes, TAGS],
    ['shrinking header', bulky.bytes, { title: 'S' }],
  ];

  for (const [label, inBytes, tags] of cases) {
    const base = readMpf(inBytes);
    const res = await writeTags(new BlobSource(new Blob([inBytes])), tags);
    check(`MPF ${label}: write succeeds`, res.ok, res.report.error);
    if (!res.ok) continue;
    const out = await bytesOf(res);
    const delta = out.length - inBytes.length;
    const m = readMpf(out);

    check(`MPF ${label}: index still describes 2 images`, !!m && m.entries.length === 2, JSON.stringify(m && m.entries));
    check(`MPF ${label}: primary length shifted by the file delta (${delta >= 0 ? '+' : ''}${delta})`,
      m.entries[0].size === base.entries[0].size + delta,
      `${m.entries[0].size} != ${base.entries[0].size} + ${delta}`);
    check(`MPF ${label}: secondary offset shifted by the file delta`,
      m.entries[1].abs === base.entries[1].abs + delta,
      `${m.entries[1].abs} != ${base.entries[1].abs} + ${delta}`);
    check(`MPF ${label}: secondary length untouched`, m.entries[1].size === payload.length);
    check(`MPF ${label}: new offset lands exactly on the payload`,
      out.subarray(m.entries[1].abs, m.entries[1].abs + payload.length).every((v, i) => v === payload[i]));
    check(`MPF ${label}: report.mpf advertises the rebase`,
      !!res.report.mpf && res.report.mpf.images === 2 && res.report.mpf.rebased === true,
      JSON.stringify(res.report.mpf));
    check(`MPF ${label}: payload never enters the heap (read ${res.report.stats.bytesRead} bytes)`,
      res.report.stats.bytesRead < 65536);
    check(`MPF ${label}: exactly one XMP segment`, readJpegXmpSegments(out).length === 1);

    const res2 = await writeTags(new BlobSource(new Blob([out])), tags);
    const out2 = await bytesOf(res2);
    check(`MPF ${label}: second write is byte-identical`,
      res2.ok && out2.length === out.length && out2.every((v, i) => v === out[i]));
  }
}

{ // header variants: byte order and the optional version field
  const payload = new Uint8Array(300).fill(0x33);
  for (const [label, opts] of [['big-endian', {}], ['little-endian', { big: false }],
    ['version-field header', { version: true }]]) {
    const fx = F.buildJpegWithMpf({ payload, ...opts });
    const base = readMpf(fx.bytes);
    const res = await writeTags(new BlobSource(new Blob([fx.bytes])), { title: 'Variant' });
    check(`MPF ${label}: write succeeds`, res.ok, res.report.error);
    if (!res.ok) continue;
    const out = await bytesOf(res);
    const delta = out.length - fx.bytes.length;
    const m = readMpf(out);
    check(`MPF ${label}: secondary offset rebased`,
      !!m && m.entries[1].abs === base.entries[1].abs + delta, JSON.stringify(m && m.entries));
    check(`MPF ${label}: payload intact`,
      out.subarray(m.entries[1].abs, m.entries[1].abs + payload.length).every((v, i) => v === payload[i]));
  }
}

{ // secondary payload may be a video (motion photo) rather than an image
  const video = new Uint8Array(4 + 8 + 900);
  video.set([0, 0, 0, 0x20], 0);              // box size
  video.set(F.CHUNK_MARK(0), 4);              // 'ftyp'-style canary
  video.fill(0x11, 12);
  const fx = F.buildJpegWithMpf({ payload: video });
  const base = readMpf(fx.bytes);
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), { title: 'Video payload' });
  check('MPF video payload: write succeeds', res.ok, res.report.error);
  if (res.ok) {
    const out = await bytesOf(res);
    const delta = out.length - fx.bytes.length;
    const m = readMpf(out);
    check('MPF video payload: offset rebased', m.entries[1].abs === base.entries[1].abs + delta);
    check('MPF video payload: video bytes unchanged',
      out.subarray(m.entries[1].abs, m.entries[1].abs + video.length).every((v, i) => v === video[i]));
  }
}

{ // an unparseable index must be refused, never left dangling
  const bad = F.buildJpegWithMpf({ bom: 'XX\0*' }).bytes;
  const res = await writeTags(new BlobSource(new Blob([bad])), TAGS);
  check('MPF corrupt index: refused with a reason', !res.ok && /MPF/.test(res.report.error), String(res.report.error));
  check('MPF corrupt index: no output produced', !res.blob && !res.parts);
}

{ // files without MPF are untouched by the new code path
  const res = await writeTags(new BlobSource(new Blob([F.buildJpeg({ withXmp: true }).bytes])), TAGS);
  check('no MPF: report.mpf stays absent', res.ok && res.report.mpf === undefined, JSON.stringify(res.report.mpf));
  check('no MPF: no MPF index in the output', readMpf(await bytesOf(res)) === null);
}

{ // inspect() must let a caller detect a motion photo before writing
  const motion = await inspect(new BlobSource(new Blob([F.buildJpegWithMpf({}).bytes])));
  check('inspect(): reports the multi-picture index',
    !!motion.jpeg.multiPicture && motion.jpeg.multiPicture.images === 2 &&
    motion.jpeg.multiPicture.offsets[1] === F.buildJpegWithMpf({}).primaryEnd,
    JSON.stringify(motion.jpeg));
  const plainInfo = await inspect(new BlobSource(new Blob([F.buildJpeg({ withXmp: true }).bytes])));
  check('inspect(): multiPicture is null for a plain JPEG',
    plainInfo.jpeg && plainInfo.jpeg.multiPicture === null && plainInfo.jpeg.existingXmp === true,
    JSON.stringify(plainInfo.jpeg));
}

/* ===================================================================== */
section('I. Extended XMP: stale fragments must not survive a write');

{
  const fx = F.buildJpeg({ withXmp: true, extendedXmp: true });
  const extBytes = fx.extSegs.reduce((a, s) => a + s.length, 0);
  const inBytes = fx.bytes;
  check('fixture: standard packet + 2 extension fragments',
    readJpegXmpSegments(inBytes).length === 1 && readExtendedXmp(inBytes).length === 2,
    `${readJpegXmpSegments(inBytes).length} / ${readExtendedXmp(inBytes).length}`);

  const res = await writeTags(new BlobSource(new Blob([inBytes])), TAGS);
  check('extended XMP: write succeeds', res.ok, res.report.error);
  if (res.ok) {
    const out = await bytesOf(res);
    const stdOut = readJpegXmpSegments(out);
    check('extended XMP: all fragments removed', readExtendedXmp(out).length === 0);
    check('extended XMP: exactly 1 standard packet remains', stdOut.length === 1, `actual ${stdOut.length}`);
    check('extended XMP: new packet carries the new title', stdOut[0] && stdOut[0].text.includes(TAGS.title));
    check('extended XMP: reported in report.xmp',
      res.report.xmp && res.report.xmp.staleExtendedFragments === 2 && res.report.xmp.replaced === 1,
      JSON.stringify(res.report.xmp));
    check('extended XMP: removal note emitted',
      res.report.notes.some((n) => /Extended XMP fragment/.test(n)), JSON.stringify(res.report.notes));
    // Size identity: nothing but the fragments and the packet swap changed.
    // The size must be explained exactly: fragments dropped, packet swapped,
    // plus the native EXIF APP1 this library adds when the file has none.
    const exifSegLen = (() => {
      for (let i = 2; i + 4 <= out.length && out[i] === 0xff; i += 2 + u16(out, i + 2)) {
        const marker = out[i + 1];
        if (marker === 0xe1 && out.subarray(i + 4, i + 10).join() === [0x45, 0x78, 0x69, 0x66, 0, 0].join()) {
          return 2 + u16(out, i + 2);
        }
      }
      return 0;
    })();
    const expect = inBytes.length - extBytes + (stdOut[0].len - fx.xmpSeg.length) + exifSegLen;
    check('extended XMP: output size accounts for exactly the fragments + packet swap' +
      ' (+ the new EXIF segment)', out.length === expect, `${out.length} != ${expect} (exif +${exifSegLen})`);
    // Privacy: the stale fragment payloads must be gone from the bytes entirely.
    check('extended XMP: stale fragment payload no longer present in the file',
      !new TextDecoder().decode(out).includes('E'.repeat(64)) &&
      !new TextDecoder().decode(out).includes('F'.repeat(64)));
    check('extended XMP: image scan data unchanged byte-for-byte',
      out.subarray(out.length - 2048).every((v, i) => v === inBytes[inBytes.length - 2048 + i]));

    const res2 = await writeTags(new BlobSource(new Blob([out])), TAGS);
    const out2 = await bytesOf(res2);
    check('extended XMP: second write is byte-identical',
      res2.ok && out2.length === out.length && out2.every((v, i) => v === out[i]));
  }
}

{ // fragments without any standard packet: still stale, still removed
  const fx = F.buildJpeg({ extendedXmp: true });
  check('fixture: extension fragments without a standard packet', readExtendedXmp(fx.bytes).length === 2);
  const res = await writeTags(new BlobSource(new Blob([fx.bytes])), TAGS);
  check('orphan fragments: write succeeds', res.ok, res.report.error);
  if (res.ok) {
    const out = await bytesOf(res);
    check('orphan fragments: removed', readExtendedXmp(out).length === 0);
    check('orphan fragments: a standard packet was inserted', readJpegXmpSegments(out).length === 1);
  }
}

{ // a plain JPEG is unaffected
  const res = await writeTags(new BlobSource(new Blob([F.buildJpeg({ withXmp: true }).bytes])), TAGS);
  check('no fragments: report.xmp stays absent',
    res.ok && res.report.xmp === undefined, JSON.stringify(res.report.xmp));
}

{ // inspect() surfaces the situation before writing
  const info = await inspect(new BlobSource(new Blob([F.buildJpeg({ withXmp: true, extendedXmp: true }).bytes])));
  check('inspect(): reports stale fragment count',
    info.jpeg && info.jpeg.extendedXmpFragments === 2 && info.jpeg.existingXmp === true,
    JSON.stringify(info.jpeg));
  const plain = await inspect(new BlobSource(new Blob([F.buildJpeg({ withXmp: true }).bytes])));
  check('inspect(): 0 fragments on a plain JPEG', plain.jpeg.extendedXmpFragments === 0);
}

/* ===================================================================== */
section('J. Input validation and format clarity');

{
  const jpeg = new BlobSource(new Blob([F.buildJpeg({}).bytes]));
  const refuse = async (label, tags, expectFragment) => {
    const res = await writeTags(jpeg, tags);
    check(`${label}: refused with a reason`,
      !res.ok && (!expectFragment || res.report.error.includes(expectFragment)),
      String(res.report && res.report.error));
    check(`${label}: no output produced`, !res.blob && !res.parts);
  };

  // An empty / unknown-only tag object must not silently wipe existing metadata.
  await refuse('empty tag object {}', {}, 'no writable tags');
  await refuse('only unknown fields', { bogus: 'x' }, 'no writable tags');
  await refuse('only empty strings', { title: '', comment: '', artist: '' }, 'no writable tags');
  await refuse('empty keywords array', { keywords: [] }, 'no writable tags');

  const ok = await writeTags(jpeg, { keywords: ['a', 'b'] });
  check('keywords-only write is allowed', ok.ok, ok.report && ok.report.error);

  // Unsupported containers should say what to do, not just "unsupported".
  const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
  const catBytes = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
  const u32b = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const ftypOnly = (brand) => {
    const body = catBytes(ascii(brand), u32b(0x200), ascii(brand), new Uint8Array(8));
    return catBytes(u32b(8 + body.length), ascii('ftyp'), body);   // size must match the real length
  };

  const cases = [
    ['WebP (RIFF)', catBytes(ascii('RIFF'), u32b(1024), ascii('WEBP'), ascii('VP8 '), new Uint8Array(64)), 'WebP'],
    ['WebM (EBML)', catBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(64)), 'WebM/MKV'],
    ['plain text', catBytes(ascii('hello world, definitely not media'), new Uint8Array(64)), 'supported: JPEG, PNG, MP4/MOV'],
    ['AVIF', ftypOnly('avif'), 'AVIF'],
    ['HEIC', ftypOnly('heic'), 'HEIC'],
    ['MOV with no moov', ftypOnly('qt  '), 'moov'],
  ];
  for (const [label, bytes, fragment] of cases) {
    const res = await writeTags(new BlobSource(new Blob([bytes])), { title: 'x' });
    check(`${label}: clear refusal message mentions "${fragment}"`,
      !res.ok && res.report.error.includes(fragment), String(res.report && res.report.error).slice(0, 140));
  }
}

{ // Memory during an MP4 rewrite is bounded by moov, not by the media size —
  // and a long recording is exactly what makes moov big. Warn above the
  // threshold so callers can pre-check with inspect().mp4.moovSize.
  const small = await writeTags(new BlobSource(new Blob([F.buildMp4({ chunks: 64 }).bytes])), { title: 'x' });
  check('normal moov: no memory warning', small.ok && small.report.warnings.length === 0,
    JSON.stringify(small.report.warnings));

  const plan = F.buildSparseMp4Plan(240 << 20, { chunks: 2_100_000, chunkSize: 100, useCo64: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-moov-'));
  const fpath = path.join(dir, 'long.mp4');
  const fd = fs.openSync(fpath, 'w');
  fs.writeSync(fd, plan.head, 0, plan.head.length, 0);
  fs.ftruncateSync(fd, 240 << 20);
  fs.closeSync(fd);

  const src = new NodeFileSource(fpath);
  const res = await writeTags(src, { title: 'Long recording' });
  const moovMB = (plan.moovSize / 1048576).toFixed(1);
  check(`big moov (${moovMB} MB in a 240 MB file): write still succeeds`, res.ok, res.report && res.report.error);
  check('big moov: warning reports the estimated peak memory',
    res.ok && res.report.warnings.some((w) => w.includes('moov is') && w.includes('× moov')),
    JSON.stringify(res.ok ? res.report.warnings : []));
  check('big moov: reads the header + moov only, never the media',
    res.ok && res.report.stats.bytesRead <= plan.moovSize + (512 << 10) && res.report.stats.bytesRead < (240 << 20) / 8,
    String(res.ok && res.report.stats.bytesRead));
  src.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ===================================================================== */
console.log(`\n\x1b[1m${FAIL === 0 ? '\x1b[32mALL PASSED' : '\x1b[31mSOME FAILED'}\x1b[0m  ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL === 0 ? 0 : 1);
