/**
 * Test sample generator: hand-crafted ISO-BMFF / JPEG / PNG, covering real-world layouts.
 * Each mp4 chunk carries identifiable canary bytes to verify that after stco shifts,
 * sample data is still correctly referenced — the core criterion for whether metadata writing corrupts the file.
 */

/* ------------------------------ Utilities ------------------------------ */
const u16b = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const u32b = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u64b = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
const zeros = (n) => new Uint8Array(n);
const cat = (...list) => {
  const flat = list.flat();
  let n = 0;
  for (const c of flat) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of flat) { out.set(c, o); o += c.length; }
  return out;
};
function box(type, ...body) {
  const b = cat(...body);
  return cat(u32b(8 + b.length), ascii(type), b);
}
function fullBox(type, ver, flags, ...body) {
  const b = cat(...body);
  return cat(u32b(12 + b.length), ascii(type), new Uint8Array([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), b);
}
function largeBox(type, ...body) {   // size=1 + 64-bit largesize
  const b = cat(...body);
  const size = 16n + BigInt(b.length);
  const hdr = new Uint8Array(16);
  new DataView(hdr.buffer).setUint32(0, 1);
  hdr.set(ascii(type), 4);
  new DataView(hdr.buffer).setBigUint64(8, size);
  return cat(hdr, b);
}

/* ------------------------------ MP4 hierarchy ------------------------------ */
const FTYP_LEN = 32;
const ftyp = (major = 'isom') => box('ftyp', ascii(major), u32b(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));

const mvhd = () => fullBox('mvhd', 0, 0,
  zeros(4), zeros(4), u32b(1000), u32b(10000),      // creation, modification, timescale, duration
  u32b(0x00010000), u16b(0x0100), zeros(10),
  cat(u32b(0x00010000), zeros(4), zeros(4), u32b(0x00010000), zeros(4), zeros(4), u32b(0x40000000)),
  zeros(24), u32b(2));

const tkhd = (w = 1920, h = 1080) => fullBox('tkhd', 0, 3,
  zeros(4), zeros(4), u32b(1), zeros(4), u32b(10000), zeros(8),
  zeros(2), zeros(2), u16b(0), zeros(2),
  cat(u32b(0x00010000), zeros(4), zeros(4), u32b(0x00010000), zeros(4), zeros(4), u32b(0x40000000)),
  u32b(w << 16), u32b(h << 16));

const mdhd = (timescale = 30000, duration = 300000) => fullBox('mdhd', 0, 0,
  zeros(4), zeros(4), u32b(timescale), u32b(duration), u16b(0x55c4), zeros(2));

const hdlr = (handler, name = 'VideoHandler') => fullBox('hdlr', 0, 0, zeros(4), ascii(handler), zeros(12), ascii(name), zeros(1));

const minf = (stbl) => box('minf', fullBox('vmhd', 0, 1, zeros(2), zeros(6)),
  box('dinf', fullBox('dref', 0, 0, u32b(1), fullBox('url ', 0, 1))), stbl);

function stsdAvc1(w = 1920, h = 1080) {
  const avcC = box('avcC', new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]));
  const entry = cat(
    zeros(6), u16b(1),                      // SampleEntry
    zeros(2), zeros(2), zeros(12),          // VisualSampleEntry
    u16b(w), u16b(h), u32b(0x00480000), u32b(0x00480000),
    zeros(4), u16b(1), zeros(32), u16b(0x0018), u16b(0xffff), avcC);
  return fullBox('stsd', 0, 0, u32b(1), box('avc1', entry));
}

const stts = (count, delta) => fullBox('stts', 0, 0, u32b(1), u32b(count), u32b(delta));
const stsc = (chunks, per) => fullBox('stsc', 0, 0, u32b(1), u32b(1), u32b(per), u32b(1));
const stsz = (count, size) => fullBox('stsz', 0, 0, u32b(size), u32b(count));
const stco = (offsets) => fullBox('stco', 0, 0, u32b(offsets.length), cat(offsets.map(u32b)));
const co64 = (offsets) => {
  const b = new Uint8Array(offsets.length * 8);
  const dv = new DataView(b.buffer);
  offsets.forEach((v, i) => dv.setBigUint64(i * 8, BigInt(v)));
  return fullBox('co64', 0, 0, u32b(offsets.length), b);
};

function mdirUdta(entries) {   // {'\xa9cmt': 'old comment'}
  const kids = Object.entries(entries).map(([name, val]) => {
    const payload = ascii(val);
    const inner = cat(u32b(16 + payload.length), ascii('data'), u32b(1), u32b(0), payload);
    return box(name, inner);
  });
  return box('udta', fullBox('meta', 0, 0, hdlr('mdir', ''), box('ilst', kids)));
}

function mdtaUdta(keys, values) {
  const keyEntries = keys.map((k) => cat(u32b(8 + k.length), ascii('mdta'), ascii(k)));
  const keysBox = fullBox('keys', 0, 0, u32b(keys.length), keyEntries);
  const kids = values.map((v, i) => {
    const payload = ascii(v);
    const inner = cat(u32b(16 + payload.length), ascii('data'), u32b(1), u32b(0), payload);
    const name = String.fromCharCode(0, 0, 0, i + 1);
    return box(name, inner);
  });
  return box('udta', fullBox('meta', 0, 0, hdlr('mdta', ''), keysBox, box('ilst', kids)));
}

/* ------------------------------ Assemble full file ------------------------------ */
export const CHUNK_MARK = (i) => ascii(chunkMarkStr(i));
export const chunkMarkStr = (i) => 'CHUNK' + String(i).padStart(2, '0') + '!';   // exactly 8 bytes
export const CHUNK_BYTE = (i) => 0xa0 + i;

function makePayload(chunks, chunkSize) {
  const p = new Uint8Array(chunks * chunkSize);
  for (let i = 0; i < chunks; i++) {
    p.fill(CHUNK_BYTE(i), i * chunkSize, (i + 1) * chunkSize);
    p.set(CHUNK_MARK(i), i * chunkSize);
  }
  return p;
}

/**
 * @param {object} o
 *  layout:'head'|'tail'|'free'   moov position / free between moov and mdat
 *  existing:'mdir'|'mdta'|null   whether udta tags already exist
 *  largeMdat:boolean             mdat uses 64-bit largesize
 *  fragmented:boolean            moov followed by moof+mdat (fragmented MP4)
 *  useCo64:boolean               stco replaced with co64
 *  chunks/chunkSize              sample layout
 */
export function buildMp4(o = {}) {
  const chunks = o.chunks ?? 8;
  const chunkSize = o.chunkSize ?? 4096;
  const payload = makePayload(chunks, chunkSize);
  const freeSize = o.layout === 'free' ? (o.freeSize ?? 512) : 0;

  const buildMoov = (offsets) => {
    const stbl = box('stbl', stsdAvc1(), stts(chunks, 1000), stsc(chunks, 1), stsz(chunks, chunkSize),
      o.useCo64 ? co64(offsets) : stco(offsets));
    const trak = box('trak', tkhd(), box('mdia', mdhd(), hdlr('vide'), minf(stbl)));
    const extra = o.fragmented ? box('mvex', fullBox('trex', 0, 0, u32b(1), u32b(1), u32b(0), u32b(0), u32b(0))) : zeros(0);
    const udta = o.existing === 'mdir' ? mdirUdta({ '\xa9cmt': 'old comment', '\xa9nam': 'old title', '\xa9gen': 'Electronic' })
      : o.existing === 'mdta' ? mdtaUdta(['title', 'artist', 'genre'], ['old title', 'old artist', 'Electronic'])
        : zeros(0);
    return box('moov', mvhd(), trak, extra, udta);
  };

  // First pass: placeholder offsets to measure moov size
  const placeholder = buildMoov(new Array(chunks).fill(0));
  const headSize = FTYP_LEN;                            // ftyp
  const moovAt = headSize;
  const afterMoov = freeSize ? moovAt + placeholder.length + freeSize : moovAt + placeholder.length;
  const mdatHeader = o.largeMdat ? 16 : 8;

  // Fragmented: moof also contains mdat
  if (o.fragmented) {
    const moov = buildMoov(new Array(0).fill(0));
    const moof = box('moof', fullBox('mfhd', 0, 0, u32b(1)),
      box('traf', fullBox('tfhd', 0, 0x020000, u32b(1)), fullBox('tfdt', 1, 0, new Uint8Array(8))));
    const frags = [];
    for (let i = 0; i < chunks; i++) {
      frags.push(moof, box('mdat', payload.subarray(i * chunkSize, (i + 1) * chunkSize)));
    }
    return { bytes: cat(ftyp(), moov, ...frags), moovAt: FTYP_LEN, moovSize: moov.length, chained: true };
  }

  const mdatAt = o.layout === 'tail' ? FTYP_LEN : afterMoov;   // tail layout: mdat right after ftyp
  const offsets = Array.from({ length: chunks }, (_, i) => mdatAt + mdatHeader + i * chunkSize);
  const moov = buildMoov(offsets);

  const free = freeSize ? box('free', zeros(freeSize - 8)) : zeros(0);
  const mdat = o.largeMdat ? largeBox('mdat', payload) : box('mdat', payload);
  const parts = o.layout === 'tail'
    ? [ftyp(), mdat, free, moov]
    : [ftyp(), moov, free, mdat];

  // Verify: computed offsets must actually point to canaries
  const bytes = cat(...parts);
  return { bytes, offsets, moovAt: o.layout === 'tail' ? FTYP_LEN + mdat.length + free.length : FTYP_LEN, moovSize: moov.length, chunkSize, chunks };
}

/* ------------------------------ JPEG / PNG ------------------------------ */
const u16le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const u32le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

const JPEG_SOI = new Uint8Array([0xff, 0xd8]);
const JPEG_EOI = new Uint8Array([0xff, 0xd9]);
const JPEG_XMP_NS = 'http://ns.adobe.com/xap/1.0/';
const JPEG_XMP_EXT_NS = 'http://ns.adobe.com/xmp/extension/';
export const XMP_EXT_GUID = 'ABCDEF0123456789ABCDEF0123456789';

function app1(payload) { return cat(new Uint8Array([0xff, 0xe1]), u16b(payload.length + 2), payload); }

/** JPEG segments after the metadata area: JFIF / DQT / SOF0 / SOS + scan + EOI. */
function jpegCore() {
  const jfif = cat(new Uint8Array([0xff, 0xe0]), u16b(16), ascii('JFIF\0'), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const dqt = cat(new Uint8Array([0xff, 0xdb]), u16b(67), new Uint8Array([0]), new Uint8Array(64).fill(16));
  const sof = cat(new Uint8Array([0xff, 0xc0]), u16b(17), new Uint8Array([8]), u16b(64), u16b(64), new Uint8Array([3]),
    new Uint8Array([1, 0x22, 0]), new Uint8Array([2, 0x11, 1]), new Uint8Array([3, 0x11, 1]));
  const sos = cat(new Uint8Array([0xff, 0xda]), u16b(12), new Uint8Array([3]),
    new Uint8Array([1, 0, 2, 0, 3, 0, 0, 0x3f, 0]));
  const scan = new Uint8Array(2048).fill(0x5a);
  return [jfif, dqt, sof, sos, scan, JPEG_EOI];
}

function xmpPacket({ extended = false, pad = 0 } = {}) {
  const note = extended
    ? `<rdf:Description rdf:about="" xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${XMP_EXT_GUID}"/>`
    : '';
  const filler = pad
    ? `<dc:description xmlns:dc="http://purl.org/dc/elements/1.1/">${'P'.repeat(pad)}</dc:description>`
    : '';
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">`
    + `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about=""><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">old xmp title</dc:title>${filler}</rdf:Description>`
    + note
    + `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/**
 * Extended XMP fragment (APP1 + xmp/extension namespace):
 * namespace + GUID(32) + full length(4) + this-chunk offset(4) + payload
 */
function xmpExtensionSegment(data, offset, fullLen) {
  return app1(cat(ascii(JPEG_XMP_EXT_NS + '\0'), ascii(XMP_EXT_GUID),
    u32b(fullLen), u32b(offset), ascii(data)));
}

/**
 * @param {object} o
 *  withXmp:boolean       emit a standard XMP APP1 packet
 *  extendedXmp:boolean   emit two xmp/extension fragments (large-metadata layout)
 */
export function buildJpeg({ withXmp = false, extendedXmp = false } = {}) {
  const parts = [JPEG_SOI];
  let xmpSeg = null, extSegs = [];
  if (withXmp) {
    xmpSeg = app1(ascii(JPEG_XMP_NS + '\0' + xmpPacket({ extended: extendedXmp })));
    parts.push(xmpSeg);
  }
  if (extendedXmp) {
    const a = 'E'.repeat(600), b = 'F'.repeat(400);
    extSegs = [xmpExtensionSegment(a, 0, a.length + b.length), xmpExtensionSegment(b, a.length, a.length + b.length)];
    parts.push(...extSegs);
  }
  parts.push(...jpegCore());
  return { bytes: cat(...parts), xmpSeg, extSegs };
}

/**
 * Motion photo / multi-picture JPEG: a normal JPEG plus an appended secondary
 * payload (another JPEG or a video), indexed by an APP2 MPF segment whose
 * MPEntry table stores absolute lengths and offsets — exactly what real
 * cameras (vivo/OPPO/xiaomi) and MPO writers produce.
 *
 * @param {object} o
 *  payload:Uint8Array   appended secondary payload
 *  big:boolean          big-endian MP header (default true)
 *  version:boolean      emit an extra version field before the byte-order mark
 *  bom:string           override the byte-order mark (corrupt-index tests)
 */
export function buildJpegWithMpf(o = {}) {
  const payload = o.payload ?? new Uint8Array(1024).fill(0x77);
  const big = o.big !== false;
  const U32 = big ? u32b : u32le;
  const U16 = big ? u16b : u16le;
  const pre = cat(ascii('MPF\0'), o.version ? ascii('0100') : zeros(0));
  const bomBytes = ascii(o.bom ?? (big ? 'MM\0*' : 'II*\0'));
  const eSeg = 4 + pre.length;                 // byte-order mark, segment-relative
  const ifdAt = eSeg + 8;                      // MP Offset = 8, relative to the mark
  const tableAt = ifdAt + 2 + 3 * 12 + 4;
  const coreBytes = cat(...jpegCore());

  const body = (size1, size2, off2) => cat(
    pre, bomBytes, U32(8),
    zeros(ifdAt - (4 + pre.length + bomBytes.length + 4)),
    U16(3),
    U16(0xb000), U16(7), U32(4), ascii('0100'),          // MPFVersion
    U16(0xb001), U16(4), U32(1), U32(2),                 // NumberOfImages
    U16(0xb002), U16(7), U32(32), U32(tableAt - eSeg),   // MPEntry table
    U32(0),                                              // next IFD
    U32(0x00030000), U32(size1), U32(0), U32(0),         // image 1: primary, offset 0
    U32(0), U32(size2), U32(off2), U32(0));              // image 2: appended payload

  const bodyLen = body(0, 0, 0).length;
  const segLen = 4 + bodyLen;
  // optional bulky pre-existing standard XMP, so replacement can also shrink the header
  const existing = o.existingXmp
    ? app1(ascii(JPEG_XMP_NS + '\0' + xmpPacket({ pad: o.existingXmpPad ?? 2000 })))
    : zeros(0);
  const primaryEnd = 2 + existing.length + segLen + coreBytes.length;   // primary image = header + core
  const absBom = 2 + existing.length + eSeg;
  const bodyBytes = body(primaryEnd, payload.length, primaryEnd - absBom);
  const seg = cat(new Uint8Array([0xff, 0xe2]), u16b(bodyBytes.length + 2), bodyBytes);
  const bytes = cat(JPEG_SOI, existing, seg, coreBytes, payload);
  // self-check: the stored absolute offset must land on the appended payload
  if (bytes[primaryEnd] !== payload[0]) throw new Error('buildJpegWithMpf: MPF offset does not resolve to the payload');
  return { bytes, seg, xmpSeg: existing, primaryEnd, payloadAt: primaryEnd, payload };
}

export function buildPng({ withXmp = false } = {}) {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => cat(u32b(data.length), ascii(type), data, u32b(crc32(cat(ascii(type), data))));
  const ihdr = chunk('IHDR', cat(u32b(64), u32b(64), new Uint8Array([8, 6, 0, 0, 0])));
  const idat = chunk('IDAT', new Uint8Array(4096).fill(0x33));
  const iend = chunk('IEND', zeros(0));
  const xmpChunk = chunk('iTXt', cat(ascii('XML:com.adobe.xmp'), new Uint8Array([0, 0, 0]), zeros(2), ascii('<x:xmpmeta>old</x:xmpmeta>')));
  const parts = [sig, ihdr];
  if (withXmp) parts.push(xmpChunk);
  parts.push(idat, iend);
  return { bytes: cat(...parts), xmpChunk };
}

/* -------------------- Giant sparse file (verify read-only-moov) -------------------- */
/**
 * Plan for a sparse MP4 whose real size can exceed 4 GiB.
 *
 * Real >4 GiB files must express things 32 bits cannot hold:
 *   - `mdat` larger than 2^32-1 needs the 64-bit largesize header (size==1 + 8-byte size)
 *   - `stco` cannot store offsets >= 2^32, so such files are already `co64`
 * Writing a >4 GiB size into a 32-bit field would silently wrap and produce a
 * file that lies about itself — pass `useCo64` when offsets exceed 32 bits.
 *
 * @param {object} o
 *   chunks/chunkSize  sample layout (chunkSize is the gap between sample offsets)
 *   useCo64:boolean   emit co64 instead of stco (required if offsets would overflow)
 *   largeMdat:boolean force the 64-bit largesize mdat header (default: auto by size)
 */
export function buildSparseMp4Plan(totalSize, { chunks = 64, chunkSize = 1 << 20, useCo64 = false, largeMdat = null, layout = 'head' } = {}) {
  const buildMoov = (offsets) => {
    const stbl = box('stbl', stsdAvc1(3840, 2160), stts(chunks, 1000), stsc(chunks, 1), stsz(chunks, chunkSize),
      useCo64 ? co64(offsets) : stco(offsets));
    return box('moov', mvhd(), box('trak', tkhd(3840, 2160), box('mdia', mdhd(), hdlr('vide'), minf(stbl))));
  };
  const placeholder = buildMoov(new Array(chunks).fill(0));
  const moovSize = placeholder.length;
  // 'head' = faststart (moov before mdat); 'tail' = ffmpeg default (mdat then moov at EOF)
  const mdatAt = layout === 'tail' ? FTYP_LEN : FTYP_LEN + moovSize;
  const mdatSize = layout === 'tail' ? totalSize - mdatAt - moovSize : totalSize - mdatAt;
  const useLarge = largeMdat === null ? mdatSize > 0xffffffff : largeMdat;
  const mdatHeader = useLarge ? 16 : 8;
  const offsets = Array.from({ length: chunks }, (_, i) => mdatAt + mdatHeader + i * chunkSize);
  if (!useCo64 && offsets[offsets.length - 1] > 0xffffffff) {
    throw new Error(`buildSparseMp4Plan: last offset ${offsets[offsets.length - 1]} exceeds 32 bits — pass useCo64: true`);
  }
  const moov = buildMoov(offsets);
  const mdatHeaderBytes = useLarge
    ? cat(u32b(1), ascii('mdat'), u64b(mdatSize))
    : cat(u32b(mdatSize), ascii('mdat'));
  const head = layout === 'tail' ? cat(ftyp(), mdatHeaderBytes) : cat(ftyp(), moov, mdatHeaderBytes);
  const tailAt = totalSize - moovSize;   // where the moov must be written for 'tail'
  return {
    head, layout, moovAt: layout === 'tail' ? tailAt : FTYP_LEN, moovSize, tailAt, moovBytes: moov,
    mdatAt, offsets, chunks, chunkSize, mdatSize, useCo64, mdatHeader,
  };
}

/* -------------------- JPEG with a full, spec-valid EXIF block -------------------- */
/**
 * A JPEG whose EXIF block contains IFD0 (with pointers to ExifIFD and GPS, and
 * a next-IFD pointing at IFD1), an ExifIFD with DateTimeOriginal, a GPS IFD, and
 * an IFD1 holding a thumbnail. `exiftool -validate` reports "OK" for it, so any
 * change observed after a write is the library's and not the fixture's.
 *
 * The layout is deterministic: all IFD directories first, then a value area,
 * then the thumbnail — offsets therefore need no iteration to settle.
 */
export function buildJpegWithExif() {
  const THUMB = new Uint8Array(64).fill(0xee);
  const utf8 = (s) => new TextEncoder().encode(s);
  const dirSize = (n) => 2 + n * 12 + 4;

  const dirs = [
    { next: 0, entries: [                                   // IFD0
      { tag: 0x010f, type: 2, count: 8, value: utf8('TESTCAM\0') },
      { tag: 0x0110, type: 2, count: 11, value: utf8('TestCam X1\0') },
      { tag: 0x0112, type: 3, count: 1, value: u16b(1) },
      { tag: 0x011a, type: 5, count: 1, value: cat(u32b(72), u32b(1)) },
      { tag: 0x011b, type: 5, count: 1, value: cat(u32b(72), u32b(1)) },
      { tag: 0x0128, type: 3, count: 1, value: u16b(2) },
      { tag: 0x0131, type: 2, count: 8, value: utf8('FW 01.0\0') },
      { tag: 0x0213, type: 3, count: 1, value: u16b(1) },
      { tag: 0x8769, type: 4, count: 1, value: u32b(0) },   // → ExifIFD
      { tag: 0x8825, type: 4, count: 1, value: u32b(0) },   // → GPS
    ] },
    { next: 0, entries: [                                   // ExifIFD
      { tag: 0x8827, type: 3, count: 1, value: u16b(100) },
      { tag: 0x9000, type: 7, count: 4, value: utf8('0232') },
      { tag: 0x9003, type: 2, count: 20, value: utf8('2020:01:01 00:00:00\0') },
      { tag: 0x9101, type: 7, count: 4, value: new Uint8Array([1, 2, 3, 0]) },
      { tag: 0xa001, type: 3, count: 1, value: u16b(1) },
      { tag: 0xa002, type: 3, count: 1, value: u16b(64) },
      { tag: 0xa003, type: 3, count: 1, value: u16b(64) },
    ] },
    { next: 0, entries: [                                   // GPS
      { tag: 0x0000, type: 1, count: 4, value: new Uint8Array([2, 3, 0, 0]) },
      { tag: 0x0001, type: 2, count: 2, value: utf8('N\0') },
      { tag: 0x0002, type: 5, count: 3, value: cat(u32b(37), u32b(1), u32b(1), u32b(1), u32b(0), u32b(1)) },
    ] },
    { next: 0, entries: [                                   // IFD1 (thumbnail)
      { tag: 0x0103, type: 3, count: 1, value: u16b(6) },
      { tag: 0x011a, type: 5, count: 1, value: cat(u32b(72), u32b(1)) },
      { tag: 0x011b, type: 5, count: 1, value: cat(u32b(72), u32b(1)) },
      { tag: 0x0128, type: 3, count: 1, value: u16b(2) },
      { tag: 0x0201, type: 4, count: 1, value: u32b(0) },   // → thumbnail
      { tag: 0x0202, type: 4, count: 1, value: u32b(THUMB.length) },
    ] },
  ];

  const offsets = [];
  let cursor = 8;
  for (const d of dirs) { offsets.push(cursor); cursor += dirSize(d.entries.length); }
  if (cursor % 2) cursor += 1;
  const valueChunks = [];
  let vp = cursor;
  const place = (bytes) => {
    if (vp % 2) { valueChunks.push(new Uint8Array(1)); vp += 1; }
    const at = vp; valueChunks.push(bytes); vp += bytes.length; return at;
  };
  const dirBytes = dirs.map((d) => {
    const buf = new Uint8Array(dirSize(d.entries.length));
    buf.set(u16b(d.entries.length), 0);
    [...d.entries].sort((a, b) => a.tag - b.tag).forEach((e, i) => {
      const at = 2 + i * 12;
      buf.set(u16b(e.tag), at);
      buf.set(u16b(e.type), at + 2);
      buf.set(u32b(e.count), at + 4);
      if (e.value.length <= 4) { buf.set(e.value, at + 8); return; }
      buf.set(u32b(place(e.value)), at + 8);
    });
    buf.set(u32b(d.next ?? 0), 2 + d.entries.length * 12);
    return buf;
  });
  const tailAt = vp % 2 ? vp + 1 : vp;
  const tiff = cat(new Uint8Array([0x4d, 0x4d]), u16b(42), u32b(offsets[0]),
    ...dirBytes, ...valueChunks, zeros(tailAt - vp), THUMB);

  const put = (at, v) => tiff.set(u32b(v), at);
  const valueAt = (dirIndex, tag) => {
    const sorted = [...dirs[dirIndex].entries].sort((a, b) => a.tag - b.tag);
    const i = sorted.findIndex((e) => e.tag === tag);
    return offsets[dirIndex] + 2 + i * 12 + 8;
  };
  put(valueAt(0, 0x8769), offsets[1]);
  put(valueAt(0, 0x8825), offsets[2]);
  put(valueAt(3, 0x0201), tailAt);
  put(offsets[0] + dirSize(dirs[0].entries.length) - 4, offsets[3]);

  const dqt = cat(new Uint8Array([0xff, 0xdb]), u16b(67), zeros(1), new Uint8Array(64).fill(16));
  const sof = cat(new Uint8Array([0xff, 0xc0]), u16b(17), zeros(1), u16b(64), u16b(64), zeros(1),
    new Uint8Array([1, 0x22, 0]), new Uint8Array([2, 0x11, 1]), new Uint8Array([3, 0x11, 1]));
  const sos = cat(new Uint8Array([0xff, 0xda]), u16b(12), zeros(1), new Uint8Array([1, 0, 2, 0, 3, 0]), new Uint8Array([0, 0x3f, 0]));
  const bytes = cat(new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe1]), u16b(2 + 6 + tiff.length), ascii('Exif'), zeros(2), tiff,
    dqt, sof, sos, new Uint8Array(2048).fill(0x5a), new Uint8Array([0xff, 0xd9]));
  return { bytes, tiff, tiffAt: 10, tailAt, thumbLen: THUMB.length };
}

/**
 * A PNG whose `eXIf` chunk holds the same spec-valid TIFF block as
 * `buildJpegWithExif()`. PNG's eXIf chunk carries the bare TIFF — there is no
 * "Exif\0\0" prefix, unlike a JPEG APP1.
 */
export function buildPngWithExif() {
  const { tiff, tailAt, thumbLen } = buildJpegWithExif();
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => cat(u32b(data.length), ascii(type), data, u32b(crc32(cat(ascii(type), data))));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', cat(u32b(64), u32b(64), new Uint8Array([8, 6, 0, 0, 0])));
  const idat = chunk('IDAT', new Uint8Array(256).fill(0x33));
  const iend = chunk('IEND', new Uint8Array(0));
  return { bytes: cat(sig, ihdr, chunk('eXIf', tiff), idat, iend), tiff, tailAt, thumbLen, eXIfAt: 8 + ihdr.length };
}
