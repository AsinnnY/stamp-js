/**
 * 畸形 / fuzz 测试矩阵
 * =============================================================================
 * 与 run.mjs（正常路径 + 回归）互补：这里只喂**损坏或异常的输入**，对每个用例
 * 断言同一组不变量，而不是逐个写期望值：
 *
 *   I1  不抛异常（永远返回 { ok } 对象）
 *   I2  失败时：error 非空、有 errorCode、且不产出 blob/parts
 *   I3  成功时：输出结构自洽（JPEG 段/PNG 块/MP4 顶层盒与容器盒逐个铺满）
 *   I4  成功时：媒体载荷不变（MP4 mdat / PNG IDAT / JPEG 熵编码段 sha256 一致）
 *   I5  成功时：二次写入字节一致（幂等）
 *
 * 这样"静默改坏无关字节"这类问题会被 I3/I4 抓住，而不是靠人工猜期望值。
 *
 * 运行：node test/malformed.mjs
 */
import { createHash } from 'node:crypto';
import { writeTags, BlobSource, u32, fourcc } from '../src/stamp.js';

let PASS = 0, FAIL = 0;
const FAILURES = [];
const section = (t) => console.log('\n\x1b[1m▌ ' + t + '\x1b[0m');
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log('   \x1b[32m✓\x1b[0m ' + name); }
  else { FAIL++; FAILURES.push(name); console.log('   \x1b[31m✗\x1b[0m ' + name + (extra ? '  \x1b[33m→ ' + extra + '\x1b[0m' : '')); }
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

/* ---------------------------------- 构造工具 ---------------------------------- */
const cat = (...a) => { const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) { o.set(c, p); p += c.length; } return o; };
const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16b = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
const z2 = (n) => new Uint8Array(n);
const u8b = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const box = (t, ...b) => { const x = cat(...b); return cat(u2(8 + x.length), a2(t), x); };
const fullBox = (t, ...b) => { const x = cat(...b); return cat(u2(12 + x.length), a2(t), z2(4), x); };
const dataBox = (v) => { const p = a2(v); return cat(u2(16 + p.length), a2('data'), u2(1), u2(0), p); };
const idxEntry = (i, v) => { const inner = dataBox(v); return cat(u2(8 + inner.length), u2(i), inner); };
const hdlr = (t) => fullBox('hdlr', z2(4), a2(t), z2(12), z2(1));
const keysBox = (names) => fullBox('keys', u2(names.length), ...names.map((n) => cat(u2(8 + n.length), a2('mdta'), a2(n))));
const FTYP = () => cat(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
const MVHD = () => cat(u2(108), a2('mvhd'), z2(100));
const MDAT = (n = 512) => cat(u2(8 + n), a2('mdat'), z2(n).fill(0x5a));

/* ---------------------------------- 校验器 ---------------------------------- */
function jpegStructureOk(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return 'no SOI';
  let i = 2, sawSos = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return `byte ${i} is not a marker`;
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0xd9) return 'unexpected EOI before SOS';
    if (m >= 0xd0 && m <= 0xd7) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return `segment ${m.toString(16)} has length ${len}`;
    if (i + 2 + len > b.length) return `segment ${m.toString(16)} runs past EOF`;
    if (m === 0xda) { sawSos = true; break; }
    i += 2 + len;
  }
  if (!sawSos) return 'no SOS';
  // 尾载荷（厂商 trailer / 动态照片标记）是合法的：只在结尾确实是 EOI 时才要求
  if (b.length >= 2 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) return null;
  return null;    // 扫描数据之后允许附加数据（SOS→EOF 的字节不变由 I4 保证）
  
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const v of b) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngStructureOk(b) {
  if (b.subarray(0, 8).join() !== a2('\x89PNG\r\n\x1a\n').join()) return 'no PNG signature';
  let p = 8, first = true, last = null;
  while (p + 8 <= b.length) {
    const len = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
    const type = fourcc(b, p + 4);
    if (p + 12 + len > b.length) return `${type} runs past EOF`;
    const body = b.subarray(p + 8, p + 8 + len);
    if (crc32(cat(a2(type), body)) !== u32(b, p + 8 + len)) return `${type} CRC mismatch`;
    if (first && type !== 'IHDR') return `first chunk is ${type}`;
    first = false; last = type; p += 12 + len;
  }
  if (p !== b.length) return 'chunks do not tile the file';
  if (last !== 'IEND') return 'last chunk is not IEND';
  return null;
}

function mp4StructureOk(b) {
  const walk = (start, end, depth) => {
    let p = start;
    while (p + 8 <= end) {
      let sz = u32(b, p), hdr = 8;
      if (sz === 1) { sz = Number(new DataView(b.buffer, b.byteOffset + p + 8, 8).getBigUint64(0)); hdr = 16; }
      else if (sz === 0) sz = end - p;
      if (sz < hdr || p + sz > end) return `box ${fourcc(b, p + 4)}@${p} bad size ${sz}`;
      const t = fourcc(b, p + 4);
      if (depth < 3 && ['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta'].includes(t)) {
        const e = walk(p + hdr, p + sz, depth + 1);
        if (e) return e;
      }
      if (depth < 3 && t === 'meta') {
        const qt = p + 8, iso = p + 12;
        const probe = (s) => { let q = s; while (q + 8 <= p + sz) { const s2 = u32(b, q); if (s2 < 8 || q + s2 > p + sz) return false; q += s2; } return q === p + sz; };
        const e = walk(probe(qt) ? qt : iso, p + sz, depth + 1);
        if (e) return e;
      }
      p += sz;
    }
    return p === end ? null : `leftover ${end - p} bytes at ${start}`;
  };
  return walk(0, b.length, 0);
}

const payloads = {
  jpeg: (b) => { for (let i = 2; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xda) return b.subarray(i); return null; },
  png: (b) => { const ch = []; let p = 8; while (p + 8 <= b.length) { const n = u32(b, p); const t = fourcc(b, p + 4); if (t === 'IDAT') ch.push(b.subarray(p + 8, p + 8 + n)); p += 12 + n; if (t === 'IEND') break; } return ch.length ? cat(ch) : null; },
  mp4: (b) => {
    // 容忍畸形顶层结构：直接按 4CC 找 mdat，并用声明长度校验范围
    for (let i = 0; i + 8 <= b.length; i++) {
      if (b[i + 4] !== 0x6d || b[i + 5] !== 0x64 || b[i + 6] !== 0x61 || b[i + 7] !== 0x74) continue;  // 'mdat'
      let sz = u32(b, i), hdr = 8;
      if (sz === 1) { if (i + 16 > b.length) continue; sz = Number(new DataView(b.buffer, b.byteOffset + i + 8, 8).getBigUint64(0)); hdr = 16; }
      else if (sz === 0) sz = b.length - i;
      if (sz >= hdr && i + sz <= b.length) return b.subarray(i + hdr, i + sz);
    }
    return null;
  },
};

/**
 * 对单个用例跑五条不变量。
 * expect: 'refuse' 必须拒绝 | 'accept' 必须成功 | 'either' 两种都可以，但都要满足不变量
 */
async function fuzz(kind, label, bytes, expect = 'either') {
  let res, threw = null;
  try { res = await writeTags(new BlobSource(new Blob([bytes])), { title: 'fuzz' }); }
  catch (e) { threw = String(e.message || e); }
  const tag = `${kind}: ${label}`;

  check(`${tag} → I1 不抛异常`, !threw, threw ? 'threw: ' + threw : '');
  if (threw) return;

  if (!res.ok) {
    check(`${tag} → I2 拒绝带原因与 errorCode`, !!res.report.error && !!res.report.errorCode,
      `code=${res.report.errorCode} err=${res.report.error}`);
    check(`${tag} → I2 拒绝不产出文件`, !res.blob && !res.parts);
    if (expect === 'accept') check(`${tag} → 用例要求成功但被拒绝`, false, res.report.error);
    return;
  }

  if (expect === 'refuse') check(`${tag} → 用例要求拒绝但成功了`, false);
  const out = new Uint8Array(await res.blob.arrayBuffer());

  const structural = kind === 'jpeg' ? jpegStructureOk : kind === 'png' ? pngStructureOk : mp4StructureOk;
  const inErr = structural(bytes);
  if (!inErr) {
    const outErr = structural(out);
    check(`${tag} → I3 输出结构自洽`, !outErr, outErr || '');
  } else {
    console.log(`   \x1b[33m○\x1b[0m ${tag} → I3 跳过（输入本身已畸形: ${inErr}）`);
  }

  const pin = payloads[kind](bytes), pout = payloads[kind](out);
  if (pin && pout) check(`${tag} → I4 媒体载荷 sha256 不变`, sha(pin) === sha(pout), `${sha(pin).slice(0, 12)} vs ${sha(pout).slice(0, 12)}`);
  else check(`${tag} → I4 载荷可提取并比较`, false, 'input or output payload missing');

  const r2 = await writeTags(new BlobSource(new Blob([out])), { title: 'fuzz' });
  if (r2.ok) {
    const o2 = new Uint8Array(await r2.blob.arrayBuffer());
    check(`${tag} → I5 二次写入字节一致`, o2.length === out.length && o2.every((v, i) => v === out[i]));
  } else {
    check(`${tag} → I5 二次写入未失败`, false, r2.report.error);
  }
}

/* ============================== JPEG 畸形 ============================== */
section('A. JPEG 畸形输入');

function jpegOf(segments, scanLen = 2048) {
  const dqt = cat(new Uint8Array([0xff, 0xdb]), u16b(67), z2(1), z2(64).fill(16));
  // 3 分量 SOF0: len = 2 + 精度(1) + 高(2) + 宽(2) + 分量数(1) + 3*3
  const sof = cat(new Uint8Array([0xff, 0xc0]), u16b(2 + 1 + 2 + 2 + 1 + 9), new Uint8Array([8]),
    u16b(64), u16b(64), new Uint8Array([3]),
    new Uint8Array([1, 0x22, 0]), new Uint8Array([2, 0x11, 1]), new Uint8Array([3, 0x11, 1]));
  // SOS: len = 2 + 分量数(1) + 3*2 + 3
  const sos = cat(new Uint8Array([0xff, 0xda]), u16b(2 + 1 + 6 + 3), new Uint8Array([3]),
    new Uint8Array([1, 0, 2, 0, 3, 0]), new Uint8Array([0, 0x3f, 0]));
  const eoi = new Uint8Array([0xff, 0xd9]);
  return cat(new Uint8Array([0xff, 0xd8]), ...segments, dqt, sof, sos, new Uint8Array(scanLen).fill(0x5a), eoi);
}
const appSeg = (marker, body) => cat(new Uint8Array([0xff, marker]), u16b(body.length + 2), body);
const xmpSeg = (text) => appSeg(0xe1, cat(a2('http://ns.adobe.com/xap/1.0/\x00'), a2(text)));
const extSeg = (payload) => appSeg(0xe1, cat(a2('http://ns.adobe.com/xmp/extension/\x00'), a2(payload)));
const jfif = appSeg(0xe0, cat(a2('JFIF\0'), z2(9)));

await fuzz('jpeg', 'APP 段声明长度越界(len 超过文件)', jpegOf([jfif, cat(new Uint8Array([0xff, 0xe1]), u16b(60000), a2('X'), a2('short'))]), 'refuse');
await fuzz('jpeg', 'APP 段长度 < 2（非法）', jpegOf([cat(new Uint8Array([0xff, 0xe1]), u16b(1), a2('x'))]), 'refuse');
await fuzz('jpeg', '缺失 SOS/SOF', cat(new Uint8Array([0xff, 0xd8]), jfif, xmpSeg('X'), new Uint8Array([0xff, 0xd9])), 'refuse');
await fuzz('jpeg', '不是 JPEG（SOI 后即垃圾）', cat(new Uint8Array([0xff, 0xd8]), z2(64).fill(0x11)), 'refuse');
await fuzz('jpeg', '多个 EOI + 尾部载荷', cat(jpegOf([jfif, xmpSeg('T')]), new Uint8Array([0xff, 0xd9]), a2('vendor-tail')), 'either');
await fuzz('jpeg', 'XMP 段中间夹垃圾字节', jpegOf([jfif, xmpSeg('<x:xmpmeta>'), appSeg(0xe1, a2('garbage')), xmpSeg('</x:xmpmeta>')]), 'either');
await fuzz('jpeg', '扩展 XMP 分片 GUID 全错/长度错', jpegOf([jfif, xmpSeg('std'), extSeg('0'.repeat(32) + '\x00\x00\xff\xff' + 'wrong-length')]), 'either');
await fuzz('jpeg', '多个 APP1 XMP（3 个）', jpegOf([jfif, xmpSeg('one'), xmpSeg('two'), xmpSeg('three')]), 'accept');
// MPF：段长 >= 16 才会被识别为多图索引；IFD 偏移指向段外时必须拒绝
await fuzz('jpeg', 'APP2 MPF 的 IFD 偏移越界', jpegOf([jfif, appSeg(0xe2, cat(a2('MPF\x00'), a2('MM\x00\x2a'), u2(0xFFFF), z2(8)))]), 'refuse');
await fuzz('jpeg', 'APP2 MPF 的 MPEntry 偏移溢出', jpegOf([jfif, appSeg(0xe2, cat(
  a2('MPF\x00'), a2('MM\x00\x2a'), u2(8),
  u2(2), u2(0xB000), u2(7), u2(4), u2(0), u2(0xB002), u2(7), u2(32), u2(10),
  z2(2), u2(0x00030000), u2(0xFFFFFFFF), u2(0), u2(0)))]), 'refuse');
await fuzz('jpeg', '超长单段 XMP（>64KB）', cat(new Uint8Array([0xff, 0xd8]), jfif, appSeg(0xe1, cat(a2('http://ns.adobe.com/xap/1.0/\x00'), a2('A'.repeat(65535)))), new Uint8Array([0xff, 0xd9])), 'refuse');
await fuzz('jpeg', '只有 SOI 的空文件', new Uint8Array([0xff, 0xd8]), 'refuse');
await fuzz('jpeg', '空文件（0 字节）', new Uint8Array(0), 'refuse');

/* ============================== PNG 畸形 ============================== */
section('B. PNG 畸形输入');

const pngChunk = (type, data) => cat(u2(data.length), a2(type), data, u2(crc32(cat(a2(type), data))));
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = (w = 64, h = 64) => pngChunk('IHDR', cat(u2(w), u2(h), new Uint8Array([8, 6, 0, 0, 0])));
const IDAT = (n = 256) => pngChunk('IDAT', z2(n).fill(0x33));
const IEND = () => pngChunk('IEND', z2(0));

await fuzz('png', 'chunk 长度越界', cat(PNG_SIG, IHDR(), cat(u2(999999), a2('IDAT'), z2(16))), 'refuse');
await fuzz('png', 'chunk 长度 > 2^31', cat(PNG_SIG, IHDR(), cat(u2(0x80000000), a2('IDAT'), z2(16))), 'refuse');
await fuzz('png', 'IDAT CRC 错误', (() => { const c = IDAT().slice(); c[4 + 4 + 8] ^= 0xff; return cat(PNG_SIG, IHDR(), c, IEND()); })(), 'either');
await fuzz('png', '缺少 IEND', cat(PNG_SIG, IHDR(), IDAT()), 'either');
await fuzz('png', 'IDAT 前有巨型 unknown chunk', cat(PNG_SIG, IHDR(), pngChunk('gAMA', z2(4)), pngChunk('XXxx', z2(40000)), IDAT(), IEND()), 'accept');
await fuzz('png', '多个 IDAT（4 个）', cat(PNG_SIG, IHDR(), IDAT(64), IDAT(64), IDAT(64), IDAT(64), IEND()), 'accept');
await fuzz('png', 'iTXt keyword 超长（无 NUL 结束）', cat(PNG_SIG, IHDR(), pngChunk('iTXt', cat(a2('K'.repeat(300)))), IDAT(), IEND()), 'either');
await fuzz('png', 'iTXt keyword 不是 UTF-8', cat(PNG_SIG, IHDR(), pngChunk('iTXt', cat(new Uint8Array([0xff, 0xfe, 0x80]), z2(3), a2('v'))), IDAT(), IEND()), 'either');
await fuzz('png', 'zTXt 压缩文本块', cat(PNG_SIG, IHDR(), pngChunk('zTXt', cat(a2('Comment\0'), new Uint8Array([0]), z2(8).fill(0x78))), IDAT(), IEND()), 'accept');
await fuzz('png', '只有签名', PNG_SIG, 'refuse');
await fuzz('png', 'IHDR 长度错（13→12）', cat(PNG_SIG, cat(u2(12), a2('IHDR'), z2(12), u2(0)), IDAT(), IEND()), 'either');

/* ============================== MP4 畸形 ============================== */
section('C. MP4 畸形输入');

const mp4Of = (moovKids, mdatBytes = MDAT()) => cat(FTYP(), box('moov', MVHD(), ...moovKids), mdatBytes);
const stcoBox = (offsets, countOverride = null) => fullBox('stco', cat(u2(countOverride ?? offsets.length), ...offsets.map(u2)));
const co64Box = (offsets, countOverride = null) => fullBox('co64', cat(u2(countOverride ?? offsets.length), ...offsets.map((o) => u8b(o))));
const trakOf = (stblKids) => box('trak', box('mdia', box('minf', box('stbl', ...stblKids))));

// --- 顶层盒结构 ---
await fuzz('mp4', '顶层盒 size=0（延伸到 EOF）', cat(FTYP(), box('moov', MVHD()), cat(u2(0), a2('mdat'), z2(512).fill(0x5a))), 'accept');
await fuzz('mp4', 'mdat 用 64 位 largesize', cat(FTYP(), box('moov', MVHD()), cat(u2(1), a2('mdat'), u8b(16 + 512), z2(512).fill(0x5a))), 'accept');
await fuzz('mp4', '顶层盒 size 越界', cat(FTYP(), cat(u2(0xFFFFFFF0), a2('moov'), MVHD()), MDAT()), 'refuse');
await fuzz('mp4', '重复 moov', cat(FTYP(), box('moov', MVHD()), box('moov', MVHD()), MDAT()), 'refuse');
await fuzz('mp4', '重复 ftyp', cat(FTYP(), FTYP(), box('moov', MVHD()), MDAT()), 'either');
await fuzz('mp4', '两个 mdat', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([3000])])), MDAT(256), MDAT(256)), 'either');
await fuzz('mp4', 'moov 在多个 mdat 之后', cat(FTYP(), MDAT(256), MDAT(256), box('moov', MVHD(), trakOf([stcoBox([400])]))), 'accept');
await fuzz('mp4', '顶层盒之间 4 字节间隙', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([3000])])), z2(4), MDAT()), 'either');
await fuzz('mp4', 'moov 自身 largesize 头', cat(FTYP(), cat(u2(1), a2('moov'), u8b(16 + MVHD().length), MVHD()), MDAT()), 'refuse');
await fuzz('mp4', 'moov 内子盒 largesize 头', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdir'), box('ilst', cat(u2(1), a2('ilst'), u8b(16 + 8), z2(8)))))), MDAT()), 'refuse');

// --- 偏移表（本轮修掉的静默破坏就在这里）---
await fuzz('mp4', 'stco count 超出盒子（声明 5 实际 1）', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([3000], 5), box('free', z2(64).fill(0xaa))])), MDAT()), 'refuse');
await fuzz('mp4', 'co64 count 超出盒子（声明 9 实际 1）', cat(FTYP(), box('moov', MVHD(), trakOf([co64Box([3000], 9), box('free', z2(64).fill(0xaa))])), MDAT()), 'refuse');
await fuzz('mp4', 'stco count=0（空表）', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([])])), MDAT()), 'accept');
await fuzz('mp4', '多个 stco（两个 trak）', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([3000])]), trakOf([stcoBox([3000])])), MDAT()), 'accept');
await fuzz('mp4', '同一 trak 内两个 stco', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([3000]), stcoBox([3004])])), MDAT()), 'accept');
await fuzz('mp4', 'stco/co64 混用（两个 trak）', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([3000])]), trakOf([co64Box([3000])])), MDAT()), 'accept');
await fuzz('mp4', 'stco 偏移 = 0', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([0])])), MDAT()), 'accept');
await fuzz('mp4', 'stco 偏移 = 0xFFFFFFFF', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([0xFFFFFFFF])])), MDAT()), 'accept');
await fuzz('mp4', 'stco 偏移 = 0xFFFFFFFF - 8（临界）', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([0xFFFFFFF7])])), MDAT()), 'accept');
await fuzz('mp4', 'co64 偏移 > 2^53', cat(FTYP(), box('moov', MVHD(), trakOf([co64Box([2 ** 53 + 4096])])), MDAT()), 'refuse');
await fuzz('mp4', 'stco 偏移全部接近 2^32（触发 co64 升级）', cat(FTYP(), box('moov', MVHD(), trakOf([stcoBox([0xFFFFFFF0, 0xFFFFFFF4])])), MDAT()), 'accept');

// --- metadata 结构 ---
await fuzz('mp4', 'mdta 索引超出 keys 表', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdta'), keysBox(['title']), box('ilst', idxEntry(9, 'x'))))), MDAT()), 'refuse');
await fuzz('mp4', 'mdta 有索引但无 keys 盒', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdta'), box('ilst', idxEntry(1, 'x'))))), MDAT()), 'refuse');
await fuzz('mp4', 'meta 缺 hdlr', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', box('ilst', cat(u2(8 + 21), a2('\xa9nam'), dataBox('v')))))), MDAT()), 'either');
await fuzz('mp4', 'meta 内两个 hdlr', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdir'), hdlr('mdta'), box('ilst', cat(u2(8 + dataBox('v').length), a2('\xa9nam'), dataBox('v')))))), MDAT()), 'either');
await fuzz('mp4', 'meta 内两个 keys 盒', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdta'), keysBox(['title']), box('ilst', idxEntry(1, 'v')), keysBox(['genre'])))), MDAT()), 'either');
await fuzz('mp4', 'keys 表 count 声明偏大但数据铺满（应修正 count 而非拒绝）', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdta'), fullBox('keys', u2(9), cat(u2(13), a2('mdta'), a2('title'))), box('ilst', idxEntry(1, 'v'))))), MDAT()), 'accept');
await fuzz('mp4', '未知 meta 子盒（应保留）', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdir'), box('ilst', cat(u2(8 + dataBox('v').length), a2('\xa9nam'), dataBox('v'))), box('zzzz', a2('KEEPME'))))), MDAT()), 'accept');
await fuzz('mp4', 'meta 子盒尺寸越界', cat(FTYP(), box('moov', MVHD(), box('udta', fullBox('meta', hdlr('mdir'), cat(u2(0xFFFF), a2('ilst')), box('ilst', z2(8))))), MDAT()), 'refuse');
await fuzz('mp4', 'udta 内直接放 ©nam（QuickTime 风格）', cat(FTYP(), box('moov', MVHD(), box('udta', box('\xa9nam', dataBox('x')))), MDAT()), 'refuse');
await fuzz('mp4', 'moov 为空（无 trak）', cat(FTYP(), box('moov'), MDAT()), 'accept');
await fuzz('mp4', '无 moov', cat(FTYP(), MDAT()), 'refuse');

console.log('\n' + '='.repeat(70));
console.log(` ${FAIL === 0 ? '\x1b[32mALL PASSED' : '\x1b[31mSOME FAILED'}\x1b[0m  ${PASS} passed, ${FAIL} failed`);
if (FAILURES.length) { console.log(' 失败用例:'); for (const f of FAILURES) console.log('   - ' + f); }
console.log('='.repeat(70));
process.exit(FAIL === 0 ? 0 : 1);
