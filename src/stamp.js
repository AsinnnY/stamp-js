/**
 * stamp.js — Low-memory media metadata writer (box-level, zero-dependency)
 * =============================================================================
 *
 * Writes XMP / EXIF / iTunes & QuickTime tags into JPEG, PNG, and MP4/MOV files
 * without re-muxing or re-encoding. Only the bytes that must change are read
 * into the JS heap; the media payload is preserved as reference slices.
 *
 * Design principles
 *   1. Read only what is needed: JPEG/PNG headers, MP4 top-level box headers
 *      + moov. The media data (mdat) never enters the JS heap.
 *   2. Move only what is needed: output is assembled from reference slices.
 *      In runtimes that implement Blob composition by reference (browsers,
 *      Node), the media payload is not copied.
 *   3. Probe before acting: detect faststart, moov position, fragmentation
 *      (fMP4), and free-box availability, then choose offset-preserving,
 *      offset-shifting, or refuse-and-fallback — never produce a corrupt file.
 *   4. Idempotent: repeated writes do not create duplicate XMP segments or
 *      duplicate udta boxes.
 *   5. Keep absolute offset tables honest: MP4 stco/co64 and JPEG MPF
 *      (motion-photo / multi-picture index) are rebased whenever the container
 *      length changes. Only those tables are rewritten; payloads stay as
 *      reference slices.
 *
 * Explicitly unsupported (returns ok:false with a reason, never silently
 * corrupts):
 *   - Fragmented MP4 / CMAF when insertion before media data is required
 *     (offsets are scattered across moof/trun/saio/sidx)
 *   - Boxes larger than 2^53 bytes
 *
 * Runtime: modern Chrome/Edge/Firefox/Safari, Node 18+, Deno, Web Workers.
 * =============================================================================
 */

/* ===========================================================================
 * 0. Utilities
 * ========================================================================= */

const TE = new TextEncoder();

export const utf8 = (s) => TE.encode(String(s));
export const u16 = (b, o) => ((b[o] << 8) | b[o + 1]) >>> 0;
export const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
export const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export function u64(b, o) {
  const hi = u32(b, o);
  if (hi > 0x1fffff) throw fail('UNSUPPORTED_LARGESIZE', 'value exceeds 2^53; box sizes and 64-bit offsets beyond that are not supported');
  return hi * 4294967296 + u32(b, o + 4);
}

export function cat(list) {
  let n = 0;
  for (const c of list) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of list) { out.set(c, o); o += c.length; }
  return out;
}

const xmlEsc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const xmlUnesc = (s) => String(s ?? '')
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ===========================================================================
 * 1. Source abstraction: unified interface for random-access read + reference
 *    slicing. This is the foundation of low-memory operation: read() fetches
 *    only the requested range; slice() returns a reference without copying.
 * ========================================================================= */

export class Source {
  constructor() {
    this.size = 0;
    this.type = '';
    this.stats = { readCalls: 0, bytesRead: 0, maxReadSize: 0, sliceCalls: 0 };
  }
  async read(_start, _end) { throw new Error('Source.read() not implemented'); }
  canSlice() { return false; }
  slice(_start, _end) { throw new Error('this source does not support reference slicing'); }
  async _read(start, end) {
    start = Math.max(0, Math.floor(start));
    end = Math.min(this.size, Math.ceil(end));
    if (!(end > start)) return new Uint8Array(0);
    const out = await this.read(start, end);
    this.stats.readCalls++;
    this.stats.bytesRead += out.length;
    if (out.length > this.stats.maxReadSize) this.stats.maxReadSize = out.length;
    return out;
  }
  _slice(start, end) {
    start = Math.max(0, Math.floor(start));
    end = Math.min(this.size, Math.ceil(end));
    if (!(end > start)) return null;
    this.stats.sliceCalls++;
    return this.slice(start, end);
  }
}

export class BlobSource extends Source {
  constructor(blob) {
    super();
    if (!blob || typeof blob.size !== 'number') throw new TypeError('BlobSource requires a Blob');
    this.blob = blob;
    this.size = blob.size;
    this.type = blob.type || '';
  }
  async read(start, end) {
    const buf = await this.blob.slice(start, end).arrayBuffer();
    return new Uint8Array(buf);
  }
  canSlice() { return true; }
  slice(start, end) { return this.blob.slice(start, end); }
}

export class BufferSource extends Source {
  constructor(bytes, type = '') {
    super();
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.size = this.bytes.byteLength;
    this.type = type;
  }
  async read(start, end) { return this.bytes.subarray(start, end); }
  canSlice() { return true; }
  slice(start, end) { return this.bytes.subarray(start, end); }
}

/**
 * HTTP data source with Range request support.
 */
export class HttpSource extends Source {
  constructor(url, { fetchImpl = globalThis.fetch, type = '', size = null } = {}) {
    super();
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.size = size ?? 0;
    this.type = type;
    this.rangeSupported = null;
  }
  async init() {
    if (this.size) return this;
    const res = await this.fetchImpl(this.url, { headers: { Range: 'bytes=0-0' } });
    try {
      const cr = res.headers && res.headers.get && res.headers.get('content-range');
      if (res.status === 206 && cr) {
        const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(String(cr).trim());
        if (!m) throw fail('RANGE_UNSUPPORTED', 'Content-Range header is malformed: ' + cr);
        const total = Number(m[3]);
        if (!Number.isFinite(total) || total < 0)
          throw fail('RANGE_UNSUPPORTED', 'Content-Range total size is invalid: ' + cr);
        this.size = total;
        this.rangeSupported = true;
      } else {
        const len = res.headers && res.headers.get && res.headers.get('content-length');
        const size = Number(len);
        if (!Number.isFinite(size) || size < 0)
          throw fail('RANGE_UNSUPPORTED',
            'Server does not support Range and Content-Length is invalid; cannot perform random access');
        this.size = size;
        this.rangeSupported = false;
      }
    } finally {
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* ignore */ }
    }
    return this;
  }
  async read(start, end) {
    if (this.rangeSupported === false)
      throw fail('RANGE_UNSUPPORTED', 'Server does not support Range requests; random access is unavailable');
    const res = await this.fetchImpl(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (res.status !== 206)
      throw fail('RANGE_UNSUPPORTED', 'Range request failed: HTTP ' + res.status + ' (expected 206 Partial Content)');
    const want = end - start;
    const buf = new Uint8Array(await res.arrayBuffer());
    const cr = res.headers && res.headers.get && res.headers.get('content-range');
    if (cr) {
      const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(String(cr).trim());
      if (!m || Number(m[1]) !== start || Number(m[2]) !== end - 1)
        throw fail('RANGE_MISMATCH',
          `server ignored the requested range: asked bytes=${start}-${end - 1}, got Content-Range "${cr}"`);
    }
    if (buf.length < want)
      throw fail('RANGE_MISMATCH', `short read: asked ${want} bytes at offset ${start}, got ${buf.length}`);
    return buf.length > want ? buf.subarray(0, want) : buf;
  }
  canSlice() { return false; }
}

/** Top-level box header cursor with a sliding window, avoiding per-box
 *  round-trips when fMP4 has thousands of boxes. */
class HeaderWindow {
  constructor(src, window = 65536, seed = null) {
    this.src = src; this.window = window;
    this.buf = seed && seed.length ? seed : null;
    this.base = 0;
  }
  async header(pos) {
    if (pos + 8 > this.src.size) return null;
    if (!this.buf || pos < this.base || pos + 16 > this.base + this.buf.length) {
      const end = Math.min(this.src.size, pos + this.window);
      this.buf = await this.src._read(pos, end);
      this.base = pos;
    }
    const off = pos - this.base;
    if (off + 8 > this.buf.length) return null;
    return { buf: this.buf, off };
  }
}

/* ===========================================================================
 * 2. Format detection
 * ========================================================================= */

/** ISOBMFF ftyp brands that are still images/sequences, not MP4/MOV video
 *  (they carry metadata in top-level meta/iloc, not moov/udta). */
const ISOBMFF_IMAGE_BRANDS = {
  avif: 'AVIF image', avis: 'AVIF image sequence',
  heic: 'HEIC image', heix: 'HEIC image', heif: 'HEIF image',
  mif1: 'HEIF image', msf1: 'HEIF image sequence',
};

/** Classify an ISOBMFF ftyp header into 'avif', 'heic', or 'mp4'. */
function classifyIsobmffBrand(bytes) {
  if (bytes.length < 12) return { format: 'mp4', brand: '' };
  const major = fourcc(bytes, 8);
  const norm = major.trim().toLowerCase();
  if (norm === 'avif' || norm === 'avis') return { format: 'avif', brand: major };
  if (norm === 'heic' || norm === 'heix' || norm === 'heif') return { format: 'heic', brand: major };
  // Generic HEIF brands ('mif1', 'msf1'): inspect compatible_brands if present
  // so an AVIF with major_brand='mif1' and compatible_brands=['avif'] is named accurately.
  if (norm === 'mif1' || norm === 'msf1') {
    const ftypSize = u32(bytes, 0);
    const limit = ftypSize >= 16 ? Math.min(bytes.length, ftypSize) : bytes.length;
    for (let p = 16; p + 4 <= limit; p += 4) {
      const cb = fourcc(bytes, p).trim().toLowerCase();
      if (cb === 'avif' || cb === 'avis') return { format: 'avif', brand: fourcc(bytes, p) };
    }
    return { format: 'heic', brand: major };
  }
  return { format: 'mp4', brand: major };
}

export function sniff(bytes, type = '') {
  const m = (type || '').toLowerCase();
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 8 && fourcc(bytes, 4) === 'ftyp') {
    return classifyIsobmffBrand(bytes).format;
  }
  if (bytes.length >= 4 && fourcc(bytes, 0) === 'RIFF') return 'riff';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'ebml';
  if (/avif/.test(m)) return 'avif';
  if (/hei[cf]/.test(m)) return 'heic';
  if (/webp/.test(m)) return 'riff';
  if (/webm|matroska|mkv/.test(m)) return 'ebml';
  if (/jpe?g/.test(m)) return 'jpeg';
  if (/png/.test(m)) return 'png';
  if (/mp4|mov|m4v/.test(m)) return 'mp4';
  return 'unknown';
}

/**
 * Read [0, need) from the source. If a seed (bytes already read during
 * probing) is available, it is reused so the same byte range is never read
 * twice — this keeps the bytesRead metric trustworthy.
 */
async function readHeadAt(src, need, seed) {
  const want = Math.min(need, src.size);
  if (seed && seed.length >= want) return seed.subarray(0, want);
  const from = seed ? seed.length : 0;
  if (!(want > from)) return seed ? seed.subarray(0, want) : new Uint8Array(0);
  const rest = await src._read(from, want);
  return seed ? cat([seed, rest]) : rest;
}

/* ===========================================================================
 * 3. Codec: unified tag model -> per-container native fields
 *    tags = {
 *      title, artist, date, encodedDate, taggedDate, dateOriginal,
 *      description, comment, url, software, copyright, keywords[],
 *      album, genre, make, model, gps, rating
 *    }
 * ========================================================================= */

/** Every tag field the public API accepts, in a stable order. */
export const TAG_FIELDS = [
  'title', 'artist', 'date', 'encodedDate', 'taggedDate', 'dateOriginal',
  'description', 'comment', 'url', 'software', 'copyright', 'keywords',
  'album', 'genre', 'make', 'model', 'gps', 'rating',
];

const TEXT_TAG_FIELDS = [
  'title', 'artist', 'date', 'encodedDate', 'taggedDate', 'dateOriginal',
  'description', 'comment', 'url', 'software', 'copyright',
  'album', 'genre', 'make', 'model',
];

const DATE_TAG_KEYS = [
  'date', 'encodedDate', 'taggedDate', 'dateOriginal',
  'creationTime', 'modificationTime', 'modifyDate', 'captureDate',
];

/** Error carrying a machine-readable code, surfaced as `report.errorCode`. */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Human-readable reason for containers we deliberately do not write. */
const FORMAT_HINTS = {
  riff: 'WebP/RIFF stores XMP in a RIFF chunk that is not handled yet',
  ebml: 'WebM/MKV needs EBML SeekHead/Cues recalculation (absolute offsets)',
};

function unsupportedFormatError(format, seed) {
  if (format === 'avif' || format === 'heic') {
    const brand = seed && seed.length >= 12 ? fourcc(seed, 8) : format;
    const kind = ISOBMFF_IMAGE_BRANDS[brand.trim().toLowerCase()] || `${format.toUpperCase()} image`;
    return fail('UNSUPPORTED_FORMAT',
      `${kind} (ftyp brand "${brand}") is not supported: it carries metadata in meta/iloc, not moov/udta. Supported: JPEG, PNG, MP4/MOV`);
  }
  const hint = FORMAT_HINTS[format];
  return fail('UNSUPPORTED_FORMAT', `unsupported format: ${format}`
    + (hint ? ` — ${hint}` : '')
    + '; supported: JPEG, PNG, MP4/MOV');
}

/* ------------------------------- Date & GPS helpers ----------------------- */

/** Seconds between 1904-01-01T00:00:00Z (QuickTime/MP4 epoch) and 1970-01-01T00:00:00Z (Unix epoch). */
export const MP4_EPOCH_OFFSET = 2082844800;

function maxDaysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parse a date/time input into UTC milliseconds since 1970-01-01T00:00:00Z.
 *
 * Accepted formats:
 *   - ISO-8601 date or date-time: `"YYYY-MM-DD"`, `"YYYY-MM-DDTHH:MM:SSZ"`,
 *     `"YYYY-MM-DDTHH:MM:SS.sss±HH:MM"`, `"YYYY-MM-DD HH:MM:SS"`
 *   - EXIF date/time: `"YYYY:MM:DD HH:MM:SS"` or `"YYYY:MM:DD"`
 *   - MediaInfo UTC string: `"UTC YYYY-MM-DD HH:MM:SS"`
 *   - Valid JavaScript `Date` instance (`!Number.isNaN(d.getTime())`)
 *   - Non-negative finite number (Unix seconds or milliseconds)
 *
 * Returns `null` when the input is empty or invalid.
 */
export function parseDateToMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;
  if (/^UTC\s+/i.test(s)) s = s.replace(/^UTC\s+/i, '').trim();

  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > maxDaysInMonth(year, month)) return null;

  let iso;
  if (m[4] !== undefined) {
    const hour = Number(m[4]);
    const min = Number(m[5]);
    const sec = Number(m[6]);
    if (hour > 23 || min > 59 || sec > 59) return null;
    const frac = m[7] ? '.' + m[7].slice(0, 3).padEnd(3, '0') : '';
    let tz = m[8] || 'Z';
    if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ':' + tz.slice(3);
    iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}${tz}`;
  } else {
    iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Validate a single date field value; throws BAD_OPTION if invalid. */
function validateDateField(value, fieldName) {
  if (value === undefined || value === null || value === '') return;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw fail('BAD_OPTION', `invalid ${fieldName}: Date object is Invalid Date (NaN)`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw fail('BAD_OPTION', `invalid ${fieldName}: numeric timestamp must be a non-negative finite number, received ${value}`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (parseDateToMs(value) === null) {
      throw fail('BAD_OPTION',
        `invalid ${fieldName}: "${value}" (expected ISO-8601 "YYYY-MM-DDTHH:MM:SSZ", "YYYY-MM-DD", EXIF "YYYY:MM:DD HH:MM:SS", a valid Date, or a finite timestamp)`);
    }
    return;
  }
  throw fail('BAD_OPTION', `invalid ${fieldName}: expected an ISO-8601 string, Date instance, or finite timestamp`);
}

/** Validate all date, GPS, and rating fields on a raw tags object up front. */
export function validateTags(tags) {
  if (!tags || typeof tags !== 'object') return;
  for (const k of DATE_TAG_KEYS) {
    if (k in tags) validateDateField(tags[k], k);
  }
  const rawGps = tags.gps ?? tags.location;
  if (rawGps !== undefined && rawGps !== null && rawGps !== '') {
    parseGps(rawGps);
  }
  if (tags.rating !== undefined && tags.rating !== null && tags.rating !== '') {
    normalizeRating(tags.rating);
  }
}

function formatDateInput(v, fieldName = 'date') {
  if (v == null || v === '') return '';
  validateDateField(v, fieldName);
  if (v instanceof Date) {
    return v.toISOString().replace(/\.000Z$/, 'Z');
  }
  if (typeof v === 'number') {
    const ms = v > 1e11 ? v : v * 1000;
    return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
  }
  return String(v).trim();
}

function normalizeTags(tags) {
  const t = {
    title: '', artist: '', date: '', encodedDate: '', taggedDate: '', dateOriginal: '',
    description: '', comment: '', url: '', software: '', copyright: '', keywords: null,
    album: '', genre: '', make: '', model: '', gps: null, rating: null,
  };
  if (!tags || typeof tags !== 'object') return t;
  validateTags(tags);
  for (const k of Object.keys(t)) {
    if (tags[k] != null) t[k] = tags[k];
  }
  if (!t.encodedDate && tags.creationTime != null) t.encodedDate = tags.creationTime;
  if (!t.taggedDate && (tags.modificationTime != null || tags.modifyDate != null)) {
    t.taggedDate = tags.modificationTime ?? tags.modifyDate;
  }
  if (!t.dateOriginal && tags.captureDate != null) t.dateOriginal = tags.captureDate;
  if (t.gps == null && tags.location != null) t.gps = tags.location;

  t.date = formatDateInput(t.date, 'date');
  t.encodedDate = formatDateInput(t.encodedDate, 'encodedDate');
  t.taggedDate = formatDateInput(t.taggedDate, 'taggedDate');
  t.dateOriginal = formatDateInput(t.dateOriginal, 'dateOriginal');

  if (typeof t.keywords === 'string') {
    const parts = t.keywords.split(',').map((s) => s.trim()).filter(Boolean);
    t.keywords = parts.length ? parts : [];
  }
  return t;
}

/**
 * Parse GPS input: accepts `{ lat, lon, alt? }`, `{ latitude, longitude, altitude? }`,
 * an ISO-6709 string (`"+35.6895+139.6917+40/"` or `"+37.7749-122.4194/"`), or a
 * comma-separated `"35.6895, 139.6917"` string.
 */
export function parseGps(raw) {
  if (raw == null || raw === '') return null;
  let lat = NaN, lon = NaN, alt = null, rawIso = null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    const iso = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?(?:CRS[^/]*)?\/?$/i.exec(s);
    if (iso) {
      const parseIsoPart = (str, maxDeg) => {
        const n = Number(str);
        if (Math.abs(n) <= maxDeg) return n;
        const sign = n < 0 ? -1 : 1;
        const abs = Math.abs(n);
        const deg = Math.floor(abs / 100);
        const min = abs - deg * 100;
        return sign * (deg + min / 60);
      };
      lat = parseIsoPart(iso[1], 90);
      lon = parseIsoPart(iso[2], 180);
      alt = iso[3] != null ? Number(iso[3]) : null;
      if (Math.abs(Number(iso[1])) <= 90 && Math.abs(Number(iso[2])) <= 180) {
        rawIso = s.endsWith('/') ? s : s + '/';
      }
    } else {
      const csv = /^([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)(?:\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?))?$/.exec(s);
      if (csv) {
        lat = Number(csv[1]);
        lon = Number(csv[2]);
        alt = csv[3] != null ? Number(csv[3]) : null;
      }
    }
  } else if (typeof raw === 'object') {
    const la = raw.lat ?? raw.latitude;
    const lo = raw.lon ?? raw.lng ?? raw.longitude;
    const al = raw.alt ?? raw.altitude;
    if (la != null && la !== '' && lo != null && lo !== '') {
      lat = Number(la);
      lon = Number(lo);
      if (al != null && al !== '') alt = Number(al);
    }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw fail('BAD_OPTION', 'invalid gps coordinates: expected {lat, lon, alt?} or ISO-6709 string with lat in [-90, 90] and lon in [-180, 180]');
  }
  if (alt !== null && !Number.isFinite(alt)) {
    throw fail('BAD_OPTION', 'invalid gps altitude: expected a finite number in meters');
  }
  const latSign = lat >= 0 ? '+' : '-';
  const lonSign = lon >= 0 ? '+' : '-';
  const latStr = Math.abs(lat).toFixed(4).padStart(7, '0');
  const lonStr = Math.abs(lon).toFixed(4).padStart(8, '0');
  const altStr = alt !== null ? `${alt >= 0 ? '+' : '-'}${Math.abs(alt).toFixed(2)}` : '';
  const iso6709 = rawIso || `${latSign}${latStr}${lonSign}${lonStr}${altStr}/`;
  return { lat, lon, alt, iso6709 };
}

function normalizeRating(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -1 || n > 5) {
    throw fail('BAD_OPTION', `rating must be a number between -1 and 5, received: ${raw}`);
  }
  return Math.round(n);
}

/**
 * Would this write actually change anything? An empty/unknown-only object used
 * to silently replace existing XMP with an empty packet — i.e. wipe the user's
 * metadata through what looks like a no-op call. Refuse instead.
 */
function hasWritableTags(tags) {
  if (!tags || typeof tags !== 'object') return false;
  validateTags(tags);
  const t = normalizeTags(tags);
  if (TEXT_TAG_FIELDS.some((k) => String(t[k]).length > 0)) return true;
  if (Array.isArray(t.keywords) && t.keywords.filter((k) => String(k ?? '').length > 0).length > 0) return true;
  if (t.gps != null && t.gps !== '') {
    if (typeof t.gps === 'string' && t.gps.trim().length > 0) return true;
    if (typeof t.gps === 'object' && Object.keys(t.gps).length > 0) return true;
  }
  if (t.rating != null && t.rating !== '') return true;
  return false;
}

const MP4_UNSUPPORTED_TAGS = [];

/** Which tag fields a container can actually store.
 *  Unsupported or unknown formats return `supported: []` so callers never see
 *  writable capabilities advertised for a container that cannot be written. */
export function capabilities(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'jpeg' || f === 'jpg') {
    return { format: 'jpeg', supported: TAG_FIELDS.slice(), unsupported: [] };
  }
  if (f === 'png') {
    return { format: 'png', supported: TAG_FIELDS.slice(), unsupported: [] };
  }
  if (f === 'mp4' || f === 'mov' || f === 'm4v' || f === 'isobmff') {
    const unsupported = MP4_UNSUPPORTED_TAGS.slice();
    return {
      format: 'mp4',
      supported: TAG_FIELDS.filter((k) => !unsupported.includes(k)),
      unsupported,
    };
  }
  return {
    format: f || 'unknown',
    supported: [],
    unsupported: TAG_FIELDS.slice(),
  };
}

/** The non-empty fields the caller actually asked for. */
function requestedFields(tags) {
  const t = normalizeTags(tags);
  const out = [];
  for (const k of TAG_FIELDS) {
    if (k === 'keywords') {
      if (Array.isArray(t.keywords) && t.keywords.some((v) => String(v ?? '').length > 0)) out.push(k);
    } else if (k === 'gps') {
      if (t.gps != null && t.gps !== '' && (typeof t.gps === 'string' ? t.gps.trim().length > 0 : Object.keys(t.gps).length > 0)) out.push(k);
    } else if (k === 'rating') {
      if (t.rating != null && t.rating !== '') out.push(k);
    } else if (String(t[k]).length > 0) out.push(k);
  }
  return out;
}

/** Convert a date/time input to MP4/QuickTime seconds since 1904-01-01T00:00:00Z. */
export function toMp4EpochSeconds(value) {
  const ms = parseDateToMs(value);
  if (ms === null) return null;
  const sec = Math.floor(ms / 1000) + MP4_EPOCH_OFFSET;
  return sec >= 0 ? sec : null;
}

/** Convert MP4/QuickTime seconds since 1904-01-01T00:00:00Z to an ISO-8601 UTC string. */
export function fromMp4EpochSeconds(sec) {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return null;
  const ms = (sec - MP4_EPOCH_OFFSET) * 1000;
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

/** Convert decimal degrees into XMP GPS format "DDD,MM.MMMMk" (e.g. "35,41.3700N"). */
function toXmpGpsCoord(deg, posRef, negRef) {
  const ref = deg >= 0 ? posRef : negRef;
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = (abs - d) * 60;
  return `${d},${m.toFixed(4)}${ref}`;
}

function fromXmpGpsCoord(str) {
  if (!str) return null;
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/i.exec(String(str).trim());
  if (!m) return null;
  const deg = Number(m[1]) + Number(m[2]) / 60;
  const ref = m[3].toUpperCase();
  return (ref === 'S' || ref === 'W') ? -deg : deg;
}

/* ------------------------------- XMP (JPEG / generic) --------------------- */

export function buildXmpPacket(tags) {
  const t = normalizeTags(tags);
  const gps = t.gps != null && t.gps !== '' ? parseGps(t.gps) : null;
  const rating = t.rating != null && t.rating !== '' ? normalizeRating(t.rating) : null;
  const desc = [t.description, t.comment, t.url ? 'URL: ' + t.url : ''].filter(Boolean).join('\n\n');
  const kw = Array.isArray(t.keywords) && t.keywords.length
    ? `   <dc:subject><rdf:Bag>${t.keywords.map((k) => `<rdf:li>${xmlEsc(k)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>\n`
    : '';
  const createDate = t.encodedDate || t.date || t.dateOriginal;
  const extraLines = [];
  if (t.taggedDate) {
    extraLines.push(`   <xmp:ModifyDate>${xmlEsc(t.taggedDate)}</xmp:ModifyDate>`);
    extraLines.push(`   <xmp:MetadataDate>${xmlEsc(t.taggedDate)}</xmp:MetadataDate>`);
  }
  if (rating !== null) extraLines.push(`   <xmp:Rating>${rating}</xmp:Rating>`);
  if (t.dateOriginal) extraLines.push(`   <exif:DateTimeOriginal>${xmlEsc(t.dateOriginal)}</exif:DateTimeOriginal>`);
  if (t.encodedDate) extraLines.push(`   <exif:DateTimeDigitized>${xmlEsc(t.encodedDate)}</exif:DateTimeDigitized>`);
  if (t.make) extraLines.push(`   <tiff:Make>${xmlEsc(t.make)}</tiff:Make>`);
  if (t.model) extraLines.push(`   <tiff:Model>${xmlEsc(t.model)}</tiff:Model>`);
  if (t.album) extraLines.push(`   <xmpDM:album>${xmlEsc(t.album)}</xmpDM:album>`);
  if (t.genre) extraLines.push(`   <xmpDM:genre>${xmlEsc(t.genre)}</xmpDM:genre>`);
  if (gps) {
    extraLines.push(`   <exif:GPSLatitude>${xmlEsc(toXmpGpsCoord(gps.lat, 'N', 'S'))}</exif:GPSLatitude>`);
    extraLines.push(`   <exif:GPSLongitude>${xmlEsc(toXmpGpsCoord(gps.lon, 'E', 'W'))}</exif:GPSLongitude>`);
    if (gps.alt !== null) {
      extraLines.push(`   <exif:GPSAltitudeRef>${gps.alt < 0 ? 1 : 0}</exif:GPSAltitudeRef>`);
      extraLines.push(`   <exif:GPSAltitude>${Math.round(Math.abs(gps.alt) * 1000)}/1000</exif:GPSAltitude>`);
    }
  }
  const extraNs = [
    (t.dateOriginal || t.encodedDate || gps) ? ' xmlns:exif="http://ns.adobe.com/exif/1.0/"' : '',
    (t.make || t.model) ? ' xmlns:tiff="http://ns.adobe.com/tiff/1.0/"' : '',
    (t.album || t.genre) ? ' xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/"' : '',
  ].join('');
  const extraBlock = extraLines.length ? '\n' + extraLines.join('\n') : '';
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"${extraNs}>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(t.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${xmlEsc(t.artist)}</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(desc)}</rdf:li></rdf:Alt></dc:description>
   <dc:source>${xmlEsc(t.url)}</dc:source>
   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(t.copyright)}</rdf:li></rdf:Alt></dc:rights>
${kw}   <xmp:CreateDate>${xmlEsc(createDate)}</xmp:CreateDate>
   <xmp:CreatorTool>${xmlEsc(t.software)}</xmp:CreatorTool>${extraBlock}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Parse an existing XMP packet (element or attribute form) into a normalized
 * tag object so `inspect()` can report existing metadata and `writeTags()` can
 * merge or round-trip fields without data loss.
 */
export function parseXmpPacket(xml) {
  if (!xml || typeof xml !== 'string') return {};
  const out = {};
  const extractTag = (tagName) => {
    const elemRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const em = elemRe.exec(xml);
    if (em) {
      const inner = em[1];
      const liRe = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/i;
      const lm = liRe.exec(inner);
      const raw = lm ? lm[1] : inner.replace(/<[^>]+>/g, '');
      const val = xmlUnesc(raw).trim();
      return val;
    }
    const attrRe = new RegExp(`\\b${tagName}\\s*=\\s*["']([^"']*)["']`, 'i');
    const am = attrRe.exec(xml);
    if (am) return xmlUnesc(am[1]).trim();
    return '';
  };

  const title = extractTag('dc:title');
  if (title) out.title = title;
  const artist = extractTag('dc:creator');
  if (artist) out.artist = artist;
  const url = extractTag('dc:source');
  if (url) out.url = url;
  let desc = extractTag('dc:description');
  if (desc) {
    if (url && desc.endsWith('\n\nURL: ' + url)) {
      desc = desc.slice(0, -('\n\nURL: ' + url).length);
    } else if (url && desc === 'URL: ' + url) {
      desc = '';
    }
    if (desc) {
      // Only map dc:description to `description`. `comment` is read back from the
      // native EXIF UserComment (0x9286); copying the combined description here
      // would make inspect() -> writeTags() re-append the comment on every
      // round-trip (unbounded growth of dc:description).
      out.description = desc;
    }
  }
  const copyright = extractTag('dc:rights');
  if (copyright) out.copyright = copyright;

  const subjMatch = /<dc:subject(?:\s[^>]*)?>([\s\S]*?)<\/dc:subject>/i.exec(xml);
  if (subjMatch) {
    const kws = [];
    const liGlobal = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/gi;
    let m;
    while ((m = liGlobal.exec(subjMatch[1])) !== null) {
      const v = xmlUnesc(m[1]).trim();
      if (v) kws.push(v);
    }
    if (kws.length) out.keywords = kws;
  }

  const createDate = extractTag('xmp:CreateDate');
  if (createDate) out.date = createDate;
  const software = extractTag('xmp:CreatorTool');
  if (software) out.software = software;
  const taggedDate = extractTag('xmp:MetadataDate') || extractTag('xmp:ModifyDate');
  if (taggedDate) out.taggedDate = taggedDate;
  const dateOriginal = extractTag('exif:DateTimeOriginal') || extractTag('photoshop:DateCreated');
  if (dateOriginal) out.dateOriginal = dateOriginal;
  const encodedDate = extractTag('exif:DateTimeDigitized');
  if (encodedDate) out.encodedDate = encodedDate;
  const ratingStr = extractTag('xmp:Rating');
  if (ratingStr !== '' && Number.isFinite(Number(ratingStr))) out.rating = Number(ratingStr);
  const make = extractTag('tiff:Make');
  if (make) out.make = make;
  const model = extractTag('tiff:Model');
  if (model) out.model = model;
  const album = extractTag('xmpDM:album');
  if (album) out.album = album;
  const genre = extractTag('xmpDM:genre');
  if (genre) out.genre = genre;

  const latStr = extractTag('exif:GPSLatitude');
  const lonStr = extractTag('exif:GPSLongitude');
  if (latStr && lonStr) {
    const lat = fromXmpGpsCoord(latStr);
    const lon = fromXmpGpsCoord(lonStr);
    if (lat !== null && lon !== null) {
      let alt = null;
      const altStr = extractTag('exif:GPSAltitude');
      const altRef = extractTag('exif:GPSAltitudeRef');
      if (altStr) {
        const parts = altStr.split('/');
        const num = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(altStr);
        if (Number.isFinite(num)) alt = altRef === '1' ? -num : num;
      }
      try { out.gps = parseGps({ lat, lon, ...(alt !== null ? { alt } : {}) }).iso6709; } catch { /* ignore */ }
    }
  }
  return out;
}

export const XMP_NS = 'http://ns.adobe.com/xap/1.0/';
export const XMP_EXT_NS = 'http://ns.adobe.com/xmp/extension/';

/** Does the segment payload at `at` start with `str` followed by a NUL? */
function payloadIsNs(b, at, str) {
  for (let i = 0; i < str.length; i++) if (b[at + i] !== str.charCodeAt(i)) return false;
  return b[at + str.length] === 0;
}

function buildXmpApp1(tags) {
  const ns = utf8(XMP_NS + '\0');
  const packet = utf8(buildXmpPacket(tags));
  const segLen = 2 + ns.length + packet.length;
  if (segLen > 0xffff) throw fail('XMP_TOO_LARGE', 'XMP packet exceeds JPEG single-segment 64KB limit; shorten the content');
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
  seg.set(ns, 4);
  seg.set(packet, 4 + ns.length);
  return seg;
}

/* --------------------------------- PNG iTXt ------------------------------- */

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function itxtChunk(keyword, value) {
  if (!value) return null;
  const kw = utf8(keyword);
  const val = utf8(String(value));
  // keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text
  const data = cat([kw, new Uint8Array([0, 0, 0]), new Uint8Array([0]), new Uint8Array([0]), val]);
  return pngChunk('iTXt', data);
}

export const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';
/** PNG text chunk keywords that this library writes; existing chunks with
 *  these keywords are removed before writing (ensures idempotency). */
const PNG_OWN_KEYWORDS = new Set([
  'Title', 'Author', 'Description', 'Comment', 'Creation Time',
  'Encoded Time', 'Modify Time', 'Copyright', 'Software',
  'Source', 'Collection', 'Genre', 'Location', 'Rating',
  PNG_XMP_KEYWORD,
]);

function buildPngTextChunks(tags) {
  const t = normalizeTags(tags);
  const gps = t.gps != null && t.gps !== '' ? parseGps(t.gps) : null;
  const rating = t.rating != null && t.rating !== '' ? normalizeRating(t.rating) : null;
  const desc = [t.description, t.comment, t.url ? 'URL: ' + t.url : ''].filter(Boolean).join('\n\n');
  const sourceDevice = [t.make, t.model].filter(Boolean).join(' ');
  const out = [
    itxtChunk(PNG_XMP_KEYWORD, buildXmpPacket(tags)),
    itxtChunk('Title', t.title),
    itxtChunk('Author', t.artist),
    itxtChunk('Description', desc),
    t.description && t.comment ? itxtChunk('Comment', t.comment) : null,
    itxtChunk('Creation Time', t.date || t.dateOriginal || t.encodedDate),
    itxtChunk('Encoded Time', t.encodedDate),
    itxtChunk('Modify Time', t.taggedDate),
    itxtChunk('Copyright', t.copyright),
    itxtChunk('Software', t.software),
    itxtChunk('Source', sourceDevice),
    itxtChunk('Collection', t.album),
    itxtChunk('Genre', t.genre),
    itxtChunk('Location', gps ? gps.iso6709 : ''),
    itxtChunk('Rating', rating !== null ? String(rating) : ''),
  ].filter(Boolean);
  return out.length ? cat(out) : null;
}

/** Decode an uncompressed PNG iTXt or tEXt chunk payload into { keyword, text }. */
function decodePngTextChunk(type, payload) {
  const kwEnd = payload.indexOf(0);
  if (kwEnd < 0) return null;
  const keyword = new TextDecoder().decode(payload.subarray(0, kwEnd));
  if (type === 'tEXt') {
    const text = new TextDecoder().decode(payload.subarray(kwEnd + 1));
    return { keyword, text };
  }
  if (type === 'iTXt') {
    // keyword \0 compFlag(1) compMethod(1) langTag \0 transKw \0 text
    if (kwEnd + 3 > payload.length) return null;
    const compFlag = payload[kwEnd + 1];
    if (compFlag !== 0) return null; // compressed iTXt not decoded
    const langEnd = payload.indexOf(0, kwEnd + 3);
    if (langEnd < 0) return null;
    const transEnd = payload.indexOf(0, langEnd + 1);
    if (transEnd < 0) return null;
    const text = new TextDecoder().decode(payload.subarray(transEnd + 1));
    return { keyword, text };
  }
  return null;
}

/* ------------------------------- MP4 (ISO-BMFF) --------------------------- */

function mp4Box(type, body) {
  const b = new Uint8Array(8 + body.length);
  new DataView(b.buffer).setUint32(0, b.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i) & 0xff;
  b.set(body, 8);
  return b;
}

function mp4FullBox(type, ver, flags, body) {
  const b = new Uint8Array(12 + body.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, b.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i) & 0xff;
  b[8] = ver; b[9] = (flags >> 16) & 0xff; b[10] = (flags >> 8) & 0xff; b[11] = flags & 0xff;
  b.set(body, 12);
  return b;
}

/** name can be a 4-byte atom name like '\xA9nam', or a mdta 4-byte index */
function mp4Data(name, value) {
  const payload = utf8(value);
  const inner = new Uint8Array(16 + payload.length);
  const iv = new DataView(inner.buffer);
  iv.setUint32(0, inner.length);
  for (let i = 0; i < 4; i++) inner[4 + i] = 'data'.charCodeAt(i);
  iv.setUint32(8, 1);   // type_indicator = 1 → UTF-8
  iv.setUint32(12, 0);  // locale
  inner.set(payload, 16);
  return mp4Box(name, inner);
}

/** QuickTime-style: hdlr = 'mdir', atom names are fixed ©nam/©ART/... */
function buildMdirEntries(tags) {
  const t = normalizeTags(tags);
  const gps = t.gps != null && t.gps !== '' ? parseGps(t.gps) : null;
  const rating = t.rating != null && t.rating !== '' ? normalizeRating(t.rating) : null;
  const cmt = [t.comment, t.url ? 'URL: ' + t.url : ''].filter(Boolean).join('\n');
  const kw = Array.isArray(t.keywords) ? t.keywords.filter((k) => String(k ?? '').length > 0).join(', ') : '';
  const list = [];
  if (t.title) list.push(['\xa9nam', t.title]);
  if (t.artist) list.push(['\xa9ART', t.artist]);
  if (t.date || t.dateOriginal) list.push(['\xa9day', t.date || t.dateOriginal]);
  if (t.description) list.push(['desc', t.description]);
  if (cmt) list.push(['\xa9cmt', cmt]);
  if (t.url) list.push(['\xa9url', t.url]);
  if (t.software) list.push(['\xa9too', t.software]);
  if (t.copyright) list.push(['cprt', t.copyright]);
  if (kw) list.push(['\xa9key', kw]);
  if (t.album) list.push(['\xa9alb', t.album]);
  if (t.genre) list.push(['\xa9gen', t.genre]);
  if (t.make) list.push(['\xa9mak', t.make]);
  if (t.model) list.push(['\xa9mod', t.model]);
  if (gps) list.push(['\xa9xyz', gps.iso6709]);
  if (rating !== null) list.push(['rate', String(rating)]);
  return list.map(([n, v]) => ({ name: n, box: mp4Data(n, v), key: null }));
}

/** Modern style: hdlr = 'mdta', keys table + numeric-index ilst */
function buildMdtaEntries(tags) {
  const t = normalizeTags(tags);
  const gps = t.gps != null && t.gps !== '' ? parseGps(t.gps) : null;
  const rating = t.rating != null && t.rating !== '' ? normalizeRating(t.rating) : null;
  const cmt = [t.comment, t.url ? 'URL: ' + t.url : ''].filter(Boolean).join('\n');
  const kw = Array.isArray(t.keywords) ? t.keywords.filter((k) => String(k ?? '').length > 0).join(', ') : '';
  const pairs = [];
  if (t.title) pairs.push(['title', t.title]);
  if (t.artist) pairs.push(['artist', t.artist]);
  if (t.date) pairs.push(['date', t.date]);
  if (t.dateOriginal) pairs.push(['com.apple.quicktime.creationdate', t.dateOriginal]);
  if (t.description) pairs.push(['description', t.description]);
  if (cmt) pairs.push(['comment', cmt]);
  if (t.url) pairs.push(['url', t.url]);
  if (t.software) pairs.push(['software', t.software]);
  if (t.copyright) pairs.push(['copyright', t.copyright]);
  if (kw) pairs.push(['keywords', kw]);
  if (t.album) pairs.push(['album', t.album]);
  if (t.genre) pairs.push(['genre', t.genre]);
  if (t.make) pairs.push(['com.apple.quicktime.make', t.make]);
  if (t.model) pairs.push(['com.apple.quicktime.model', t.model]);
  if (gps) pairs.push(['com.apple.quicktime.location.ISO6709', gps.iso6709]);
  if (rating !== null) pairs.push(['com.apple.quicktime.rating.user', String(rating)]);
  return pairs.map(([k, v]) => ({ name: null, key: k, value: v }));
}

function remapMdtaEntryIndex(raw, keyValue, keys) {
  const idx = keys.indexOf(keyValue);
  if (idx < 0) return raw;
  const out = raw.slice();
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, idx + 1);
  return out;
}

function buildMetaBox(source, tags, targetFormat) {
  let metaBody;
  let preserved = 0;
  if (targetFormat === 'mdta') {
    const keys = source ? source.keys.slice() : [];
    const entries = buildMdtaEntries(tags);
    for (const e of entries) if (!keys.includes(e.key)) keys.push(e.key);
    const rawEntries = [];
    if (source) {
      const convertingFromMdir = source.hdlrType !== 'mdta';
      for (const e of source.entries) {
        if (!e.keyValue && convertingFromMdir && e.name.charCodeAt(0) === 0xa9) continue;
        if (e.keyValue && entries.some((n) => n.key === e.keyValue)) continue;
        rawEntries.push(e.keyValue ? remapMdtaEntryIndex(e.raw, e.keyValue, keys) : e.raw);
        preserved++;
      }
    }
    const ilstChildren = entries.map((e) => {
      const idx = keys.indexOf(e.key);
      return mp4Data(String.fromCharCode(0, 0, 0, idx + 1), e.value);
    });
    const ilst = mp4Box('ilst', cat([...rawEntries, ...ilstChildren]));
    metaBody = cat([buildHdlr('mdta'), buildKeysBox(keys), ilst,
      ...(source ? source.extraMetaChildren : [])]);
  } else {
    const entries = buildMdirEntries(tags);
    const rawEntries = [];
    if (source) {
      for (const e of source.entries) {
        if (e.name.charCodeAt(0) === 0 && e.name.charCodeAt(1) === 0 && e.name.charCodeAt(2) === 0) continue;
        if (entries.some((n) => n.name === e.name)) continue;
        rawEntries.push(e.raw);
        preserved++;
      }
    }
    const ilst = mp4Box('ilst', cat([...rawEntries, ...entries.map((e) => e.box)]));
    metaBody = cat([buildHdlr('mdir'), ilst, ...(source ? source.extraMetaChildren : [])]);
  }
  const iso = !source || source.versionFlags !== false;
  return { bytes: iso ? mp4FullBox('meta', 0, 0, metaBody) : mp4Box('meta', metaBody), preserved };
}

function replaceUdtaMeta(bytes, udta, metaBytes) {
  const kidsEx = listChildrenEx(bytes, udta.pos + 8, udta.end);
  if (kidsEx.malformed) {
    throw fail('MALFORMED_CONTAINER',
      `REFUSE: udta box at offset ${udta.pos} cannot be fully traversed (${kidsEx.reason}); `
      + 'rewriting it would silently drop the bytes after the malformed box');
  }
  const parts = kidsEx.children.map((k) => (k.type === 'meta' ? metaBytes : bytes.slice(k.pos, k.end)));
  return mp4Box('udta', cat(parts));
}

function wrapUdta(metaBytes, extraChildren = []) {
  return mp4Box('udta', cat([metaBytes, ...extraChildren]));
}

function buildHdlr(handlerType) {
  const body = cat([new Uint8Array(8), utf8(handlerType), new Uint8Array(12), new Uint8Array([0])]);
  return mp4Box('hdlr', body);
}

function buildKeysBox(keys) {
  const entries = keys.map((k) => {
    const name = utf8(k);
    const e = new Uint8Array(8 + name.length);
    new DataView(e.buffer).setUint32(0, e.length);
    e.set(utf8('mdta'), 4);
    e.set(name, 8);
    return e;
  });
  const body = new Uint8Array(4 + entries.reduce((a, e) => a + e.length, 0));
  new DataView(body.buffer).setUint32(0, entries.length);
  let o = 4;
  for (const e of entries) { body.set(e, o); o += e.length; }
  return mp4FullBox('keys', 0, 0, body);
}

/**
 * Patch `creation_time` (Encoded date / 编码日期) and `modification_time`
 * (Tagged date / 标记日期) inside `mvhd`, `tkhd`, and `mdhd` boxes in `moov`.
 */
function patchMp4HeaderDates(moovBytes, encodedSec, taggedSec, report) {
  if (encodedSec === null && taggedSec === null) return 0;
  const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  let patched = 0;

  const patchBox = (pos, size) => {
    if (size < 20 || pos + size > moovBytes.length) return;
    const ver = moovBytes[pos + 8];
    if (ver === 0) {
      if (encodedSec !== null) {
        dv.setUint32(pos + 12, Math.min(0xffffffff, Math.max(0, encodedSec)) >>> 0);
      }
      if (taggedSec !== null) {
        dv.setUint32(pos + 16, Math.min(0xffffffff, Math.max(0, taggedSec)) >>> 0);
      }
      patched++;
    } else if (ver === 1 && size >= 28) {
      if (encodedSec !== null) {
        dv.setBigUint64(pos + 12, BigInt(Math.max(0, encodedSec)));
      }
      if (taggedSec !== null) {
        dv.setBigUint64(pos + 20, BigInt(Math.max(0, taggedSec)));
      }
      patched++;
    }
  };

  const walk = (start, end) => {
    let p = start;
    while (p + 8 <= end) {
      const size = u32(moovBytes, p);
      if (size < 8 || p + size > end) break;
      const type = fourcc(moovBytes, p + 4);
      if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') {
        patchBox(p, size);
      } else if (type === 'trak' || type === 'mdia') {
        walk(p + 8, p + size);
      }
      p += size;
    }
  };

  walk(8, moovBytes.length);
  if (patched > 0 && report && Array.isArray(report.notes)) {
    report.notes.push(
      `updated ${patched} MP4 header timestamp box(es) (mvhd/tkhd/mdhd: `
      + `encodedDate=${encodedSec !== null ? fromMp4EpochSeconds(encodedSec) : 'unchanged'}, `
      + `taggedDate=${taggedSec !== null ? fromMp4EpochSeconds(taggedSec) : 'unchanged'})`
    );
  }
  return patched;
}

/** Read movie-level `creation_time` (encodedDate) and `modification_time` (taggedDate) from `moov/mvhd`. */
function readMp4HeaderDates(moovBytes) {
  const mvhd = findChild(moovBytes, 8, 'mvhd', moovBytes.length);
  if (!mvhd || mvhd.size < 20) return { encodedDate: null, taggedDate: null };
  const ver = moovBytes[mvhd.pos + 8];
  if (ver === 0) {
    const c = u32(moovBytes, mvhd.pos + 12);
    const m = u32(moovBytes, mvhd.pos + 16);
    return { encodedDate: fromMp4EpochSeconds(c), taggedDate: fromMp4EpochSeconds(m) };
  }
  if (ver === 1 && mvhd.size >= 28) {
    const c = u64(moovBytes, mvhd.pos + 12);
    const m = u64(moovBytes, mvhd.pos + 20);
    return { encodedDate: fromMp4EpochSeconds(c), taggedDate: fromMp4EpochSeconds(m) };
  }
  return { encodedDate: null, taggedDate: null };
}

/* ===========================================================================
 * 3b. MPF (CIPA DC-007): motion-photo / multi-picture index in APP2
 * ========================================================================= */

const MPF_MAGIC = [0x4d, 0x50, 0x46, 0x00];   // "MPF\0"
const MPF_ENTRY_TAG = 0xb002;
const SEG_HDR = 4;                             // FF E2 + 2-byte length

function looksLikeMpf(b, pos, segLen) {
  if (segLen < 2 + 14) return false;
  for (let i = 0; i < 4; i++) if (b[pos + 4 + i] !== MPF_MAGIC[i]) return false;
  return true;
}

export function parseMpf(seg, segStartAbs, fileSize) {
  const segLen = u16(seg, 2);
  if (seg.length < segLen + 2) throw new Error('MPF segment is truncated');
  if (segLen + 2 < 4 + 14) throw new Error('MPF segment is too small to hold an index');
  const tried = [];
  for (const bomPos of [SEG_HDR + 4, SEG_HDR + 8]) {
    try {
      return parseMpfAt(seg, segLen, segStartAbs, fileSize, bomPos);
    } catch (e) {
      tried.push(e.message);
    }
  }
  throw fail('MPF_INVALID', `MPF index could not be parsed (${tried.join('; ')})`);
}

function parseMpfAt(seg, segLen, segStartAbs, fileSize, e) {
  if (e + 8 > seg.length) throw new Error('MPF byte-order mark is outside the segment');
  const be = seg[e] === 0x4d && seg[e + 1] === 0x4d;
  const le = seg[e] === 0x49 && seg[e + 1] === 0x49;
  if (!be && !le) throw new Error('MPF byte-order mark not found');
  if (be && !(seg[e + 2] === 0x00 && seg[e + 3] === 0x2a)) throw new Error('MPF byte-order mark not found');
  if (le && !(seg[e + 2] === 0x2a && seg[e + 3] === 0x00)) throw new Error('MPF byte-order mark not found');

  const r16 = be ? (o) => u16(seg, o) : (o) => ((seg[o + 1] << 8) | seg[o]) >>> 0;
  const r32 = be ? (o) => u32(seg, o)
    : (o) => (((seg[o + 3] << 24) | (seg[o + 2] << 16) | (seg[o + 1] << 8) | seg[o]) >>> 0);

  const end = segLen + 2;
  const ifd = e + r32(e + 4);
  if (ifd + 2 > end) throw new Error('MPF IFD offset is outside the segment');
  const ifdCount = r16(ifd);
  if (ifdCount < 1 || ifd + 2 + ifdCount * 12 > end) throw new Error('MPF IFD is malformed');

  let entriesOffset = -1, n = 0;
  for (let i = 0; i < ifdCount; i++) {
    const p = ifd + 2 + i * 12;
    if (r16(p) !== MPF_ENTRY_TAG) continue;
    if (r16(p + 2) !== 7) throw new Error('MPF MPEntry is not of undefined type');
    const cnt = r32(p + 4);
    if (cnt % 16 !== 0) throw new Error('MPF MPEntry count is not a multiple of 16');
    n = cnt / 16;
    entriesOffset = cnt <= 4 ? p + 8 : e + r32(p + 8);
    break;
  }
  if (entriesOffset < 0 || n < 1) throw new Error('MPF MPEntry table not found');
  if (n > 64) throw new Error(`MPF declares an implausible image count (${n})`);
  if (entriesOffset + n * 16 > end) throw new Error('MPF MPEntry table runs outside the segment');

  const raw = [];
  for (let i = 0; i < n; i++) {
    const p = entriesOffset + i * 16;
    raw.push({ attr: r32(p), size: r32(p + 4), dataOffset: r32(p + 8) });
  }
  const fits = (base) => raw.every((en) => {
    const s = en.dataOffset === 0 ? 0 : base + en.dataOffset;
    return s >= 0 && s + en.size <= fileSize;
  });
  let baseAbs = segStartAbs + e, baseKind = 'mpEndian';
  if (!fits(baseAbs)) {
    if (fits(0)) { baseAbs = 0; baseKind = 'fileStart'; }
    else throw fail('MPF_INVALID', 'MPF image offsets point outside the file');
  }

  return {
    be, baseAbs, baseKind, entriesOffset, segLen: end,
    entries: raw.map((en) => ({
      attr: en.attr,
      size: en.size,
      dataOffset: en.dataOffset,
      primary: en.dataOffset === 0,
      startAbs: en.dataOffset === 0 ? 0 : baseAbs + en.dataOffset,
    })),
  };
}

function makePosMap(edits) {
  return (p) => {
    let q = p;
    for (const e of edits) {
      if (e.start > p) continue;
      const added = e.bytes ? e.bytes.length : 0;
      const removed = e.end - e.start;
      if (e.end <= p) { q += added - removed; continue; }
      q += added - Math.min(removed, p - e.start);
    }
    return q;
  };
}

export function rebaseMpf(seg, parsed, map) {
  const out = seg.slice();
  const put32 = parsed.be
    ? (o, v) => {
      out[o] = (v >>> 24) & 0xff; out[o + 1] = (v >>> 16) & 0xff;
      out[o + 2] = (v >>> 8) & 0xff; out[o + 3] = v & 0xff;
    }
    : (o, v) => {
      out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff;
      out[o + 2] = (v >>> 16) & 0xff; out[o + 3] = (v >>> 24) & 0xff;
    };

  const newBase = map(parsed.baseAbs);
  let changed = 0;
  parsed.entries.forEach((en, i) => {
    const newStart = map(en.startAbs);
    const newSize = map(en.startAbs + en.size) - newStart;
    const newRel = en.primary ? 0 : newStart - newBase;
    if (!(newSize > 0) || newSize > 0xffffffff)
      throw fail('MPF_INVALID', `MPF image ${i + 1}: length overflows 32 bits after header change`);
    if (newRel < 0 || newRel > 0xffffffff)
      throw fail('MPF_INVALID', `MPF image ${i + 1}: offset overflows 32 bits after header change`);
    if (newSize === en.size && newRel === en.dataOffset) return;
    const p = parsed.entriesOffset + i * 16;
    put32(p + 4, newSize);
    put32(p + 8, newRel);
    changed++;
  });
  return changed ? out : null;
}

/* ===========================================================================
 * 4. JPEG planner: reads only the file header
 * ========================================================================= */

async function scanJpeg(src, report, seed) {
  const MAX_HEAD = 8 << 20;
  let cap = Math.min(64 << 10, src.size);
  for (;;) {
    const head = await readHeadAt(src, cap, seed);
    const r = scanJpegHead(head, src.size);
    if (r.ok) return { head, ...r };
    if (!r.needMore || cap >= MAX_HEAD || cap >= src.size) {
      throw fail('MALFORMED_CONTAINER', 'Could not locate JPEG segment insertion point in file header' + (r.reason ? ': ' + r.reason : ''));
    }
    cap = Math.min(MAX_HEAD, Math.max(cap * 4, r.needTo));
    report.notes.push(`JPEG header scan extended to ${cap} bytes`);
  }
}

function scanJpegHead(b, fileSize) {
  if (b.length < 4) return { ok: false, needMore: true, needTo: 4 };
  if (b[0] !== 0xff || b[1] !== 0xd8) return { ok: false, reason: 'not a JPEG (missing SOI)' };
  let pos = 2, insertAt = -1;
  const removes = [];
  const extRemoves = [];
  const mpf = [];
  const exif = [];
  while (pos + 2 <= b.length) {
    if (b[pos] !== 0xff) return { ok: false, reason: `offset ${pos} is not a marker` };
    const marker = b[pos + 1];
    if (marker === 0xff) { pos += 1; continue; }                       // fill bytes
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; } // no length
    if (marker === 0xd8 || marker === 0xd9) { pos += 2; continue; }
    if (pos + 4 > b.length) return { ok: false, needMore: true, needTo: pos + 4 };
    const segLen = u16(b, pos + 2);
    if (segLen < 2) return { ok: false, reason: 'invalid segment length' };
    const segEnd = pos + 2 + segLen;
    if (segEnd > fileSize) return { ok: false, reason: 'segment length exceeds file size' };
    if (marker === 0xe1) {   // APP1: EXIF, standard XMP, or an Extended XMP fragment
      if (segEnd > b.length) return { ok: false, needMore: true, needTo: segEnd };
      if (payloadIsNs(b, pos + 4, 'Exif')) exif.push({ start: pos, end: segEnd });
      else if (segLen >= 2 + XMP_NS.length + 1 && payloadIsNs(b, pos + 4, XMP_NS)) {
        removes.push({ start: pos, end: segEnd });
      } else if (segLen >= 2 + XMP_EXT_NS.length + 1 && payloadIsNs(b, pos + 4, XMP_EXT_NS)) {
        extRemoves.push({ start: pos, end: segEnd });
      }
    }
    if (marker >= 0xe0 && marker <= 0xef || marker === 0xfe) {
      if (segEnd > b.length) return { ok: false, needMore: true, needTo: segEnd };
      if (marker === 0xe2 && looksLikeMpf(b, pos, segLen)) mpf.push({ start: pos, end: segEnd });
      pos = segEnd; continue;                                          // APPn / COM: skip
    }
    insertAt = pos;                                                    // DQT/SOF/DHT/SOS: insert before it
    break;
  }
  if (insertAt === -1) {
    if (pos >= b.length) return { ok: false, needMore: true, needTo: Math.min(fileSize, b.length * 4) };
    return { ok: false, reason: 'SOS/SOF marker not found' };
  }
  return { ok: true, insertAt, removes, extRemoves, mpf, exif };
}

/* ===========================================================================
 * 4a. EXIF (TIFF) — native fields for OS property sheets
 * ========================================================================= */

const EXIF_PREFIX = 'Exif\0\0';
const EXIF_PREFIX_LEN = 6;

const TAG_IFD0_IMAGE_DESCRIPTION = 0x010e;
const TAG_IFD0_MAKE = 0x010f;
const TAG_IFD0_MODEL = 0x0110;
const TAG_IFD0_DATETIME = 0x0132;          // DateTime ("YYYY:MM:DD HH:MM:SS")
const TAG_IFD0_ARTIST = 0x013b;
const TAG_IFD0_RATING = 0x4746;            // Rating (SHORT 0..5)
const TAG_IFD0_COPYRIGHT = 0x8298;
const TAG_EXIF_IFD_POINTER = 0x8769;       // IFD0 → ExifIFD
const TAG_GPS_IFD_POINTER = 0x8825;        // IFD0 → GPSIFD
const TAG_EXIF_VERSION = 0x9000;           // ExifIFD ExifVersion
const TAG_DATETIME_ORIGINAL = 0x9003;      // ExifIFD DateTimeOriginal
const TAG_DATETIME_DIGITIZED = 0x9004;     // ExifIFD DateTimeDigitized
const TAG_USER_COMMENT = 0x9286;           // ExifIFD UserComment (= Explorer "Comments")

const TIFF_TYPE_BYTE = 1;
const TIFF_TYPE_ASCII = 2;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;
const TIFF_TYPE_RATIONAL = 5;
const TIFF_TYPE_UNDEFINED = 7;
const TIFF_TYPE_WIDTH = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const tiffU16 = (b, o, le) => (le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]));
const tiffU32 = (b, o, le) => (le
  ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
  : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0));
function tiffPutU16(b, o, v, le) {
  if (le) { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; }
  else { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; }
}
function tiffPutU32(b, o, v, le) {
  if (le) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }
  else { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; }
}
/** UTF-16LE code units (surrogate pairs pass through unchanged). */
function utf16le(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = (c >> 8) & 0xff;
  }
  return out;
}

/** ISO-8601 → EXIF "YYYY:MM:DD HH:MM:SS" (the wall-clock time as written). */
function toExifDateTime(value) {
  const s = String(value ?? '').trim().replace(/^UTC\s+/i, '');
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) return `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  const d = /^(\d{4})[-:](\d{2})[-:](\d{2})$/.exec(s);
  return d ? `${d[1]}:${d[2]}:${d[3]} 00:00:00` : null;
}

function encodeUserComment(text) {
  const ascii = /^[\x20-\x7e]*$/.test(text);
  const body = ascii ? utf8(text) : cat([new Uint8Array([0xff, 0xfe]), utf16le(text)]);
  return cat([utf8(ascii ? 'ASCII\0\0\0' : 'UNICODE\0'), body]);
}

function decodeUserComment(bytes) {
  const strip = (s) => s.replace(/\0+$/, '').trim();
  if (!bytes.length) return '';
  const code = new TextDecoder().decode(bytes.subarray(0, 8));
  if (code === 'ASCII\0\0\0') return strip(new TextDecoder().decode(bytes.subarray(8)));
  if (code === 'JIS\0\0\0\0\0') return strip(new TextDecoder().decode(bytes.subarray(8)));
  if (code === 'UNICODE\0') {
    const body = bytes.subarray(8);
    if (!body.length) return '';
    const be = body[0] === 0xfe && body[1] === 0xff;
    const le = body[0] === 0xff && body[1] === 0xfe;
    if (be) return strip(new TextDecoder('utf-16be').decode(body.subarray(2)));
    return strip(new TextDecoder('utf-16le').decode(le ? body.subarray(2) : body));
  }
  return strip(new TextDecoder().decode(bytes));      // no/unknown code: treat as text
}

function encodeGpsCoordRational(deg, le) {
  const abs = Math.abs(deg);
  let d = Math.floor(abs);
  const minFull = (abs - d) * 60;
  let m = Math.floor(minFull);
  let secNum = Math.round((minFull - m) * 60 * 10000);
  if (secNum >= 600000) { secNum -= 600000; m += 1; }
  if (m >= 60) { m -= 60; d += 1; }
  const out = new Uint8Array(24);
  tiffPutU32(out, 0, d, le); tiffPutU32(out, 4, 1, le);
  tiffPutU32(out, 8, m, le); tiffPutU32(out, 12, 1, le);
  tiffPutU32(out, 16, secNum, le); tiffPutU32(out, 20, 10000, le);
  return out;
}

function encodeGpsAltRational(alt, le) {
  const out = new Uint8Array(8);
  tiffPutU32(out, 0, Math.round(Math.abs(alt) * 1000), le);
  tiffPutU32(out, 4, 1000, le);
  return out;
}

function buildGpsFieldSpecs(gps, le) {
  const specs = [
    { tag: 0x0000, type: TIFF_TYPE_BYTE, count: 4, bytes: new Uint8Array([2, 3, 0, 0]) },
    { tag: 0x0001, type: TIFF_TYPE_ASCII, count: 2, bytes: utf8((gps.lat >= 0 ? 'N' : 'S') + '\0') },
    { tag: 0x0002, type: TIFF_TYPE_RATIONAL, count: 3, bytes: encodeGpsCoordRational(gps.lat, le) },
    { tag: 0x0003, type: TIFF_TYPE_ASCII, count: 2, bytes: utf8((gps.lon >= 0 ? 'E' : 'W') + '\0') },
    { tag: 0x0004, type: TIFF_TYPE_RATIONAL, count: 3, bytes: encodeGpsCoordRational(gps.lon, le) },
  ];
  if (gps.alt !== null) {
    specs.push({ tag: 0x0005, type: TIFF_TYPE_BYTE, count: 1, bytes: new Uint8Array([gps.alt < 0 ? 1 : 0]) });
    specs.push({ tag: 0x0006, type: TIFF_TYPE_RATIONAL, count: 1, bytes: encodeGpsAltRational(gps.alt, le) });
  }
  return specs;
}

function nativeExifFields(tags, { dateTime = true } = {}) {
  const t = normalizeTags(tags);
  const ifd0 = [];
  const descOrTitle = String(t.description || t.title);
  if (descOrTitle.length) ifd0.push({ tag: TAG_IFD0_IMAGE_DESCRIPTION, type: TIFF_TYPE_ASCII, value: descOrTitle });
  if (String(t.make).length) ifd0.push({ tag: TAG_IFD0_MAKE, type: TIFF_TYPE_ASCII, value: String(t.make) });
  if (String(t.model).length) ifd0.push({ tag: TAG_IFD0_MODEL, type: TIFF_TYPE_ASCII, value: String(t.model) });
  if (String(t.artist).length) ifd0.push({ tag: TAG_IFD0_ARTIST, type: TIFF_TYPE_ASCII, value: String(t.artist) });
  if (String(t.copyright).length) ifd0.push({ tag: TAG_IFD0_COPYRIGHT, type: TIFF_TYPE_ASCII, value: String(t.copyright) });
  const dtInput = dateTime ? (t.taggedDate || t.date) : '';
  const dt = dtInput ? toExifDateTime(dtInput) : null;
  if (dt) ifd0.push({ tag: TAG_IFD0_DATETIME, type: TIFF_TYPE_ASCII, value: dt });
  if (t.rating != null && t.rating !== '') {
    const r = Math.max(0, Math.min(5, normalizeRating(t.rating)));
    ifd0.push({ tag: TAG_IFD0_RATING, type: TIFF_TYPE_SHORT, shortValue: r });
  }
  ifd0.sort((a, b) => a.tag - b.tag);

  const exifIfd = [];
  const dto = t.dateOriginal ? toExifDateTime(t.dateOriginal) : null;
  if (dto) exifIfd.push({ tag: TAG_DATETIME_ORIGINAL, type: TIFF_TYPE_ASCII, value: dto });
  const dtd = t.encodedDate ? toExifDateTime(t.encodedDate) : null;
  if (dtd) exifIfd.push({ tag: TAG_DATETIME_DIGITIZED, type: TIFF_TYPE_ASCII, value: dtd });

  const comment = String(t.comment).length ? String(t.comment) : null;
  const gps = t.gps != null && t.gps !== '' ? parseGps(t.gps) : null;
  return { ifd0, exifIfd, comment, gps };
}

/** Read one IFD. Returns null when it does not sit inside the block. */
function readTiffIfd(tiff, offset, le) {
  if (offset < 8 || offset + 2 > tiff.length) return null;
  const count = tiffU16(tiff, offset, le);
  const end = offset + 2 + count * 12 + 4;
  if (count > 4096 || end > tiff.length) return null;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12;
    const type = tiffU16(tiff, at + 2, le);
    const n = tiffU32(tiff, at + 4, le);
    const width = TIFF_TYPE_WIDTH[type];
    entries.push({ at, tag: tiffU16(tiff, at, le), type, count: n, byteLen: width ? width * n : -1 });
  }
  return { offset, entries, next: tiffU32(tiff, offset + 2 + count * 12, le), end };
}

/** Value bytes of an entry, or null when they are not addressable. */
function readTiffValue(tiff, entry, le) {
  if (entry.byteLen < 0) return null;
  if (entry.byteLen <= 4) return tiff.slice(entry.at + 8, entry.at + 8 + entry.byteLen);
  const off = tiffU32(tiff, entry.at + 8, le);
  if (off + entry.byteLen > tiff.length) return null;
  return tiff.slice(off, off + entry.byteLen);
}

/** The text an ASCII entry currently holds (trailing NULs stripped). */
function readTiffAscii(tiff, entry, le) {
  if (entry.type !== TIFF_TYPE_ASCII) return null;
  const raw = readTiffValue(tiff, entry, le);
  return raw ? new TextDecoder().decode(raw).replace(/\0+$/, '') : null;
}

function readTiffShort(tiff, entry, le) {
  if (entry.type !== TIFF_TYPE_SHORT || entry.count < 1) return null;
  const raw = readTiffValue(tiff, entry, le);
  return raw && raw.length >= 2 ? tiffU16(raw, 0, le) : null;
}

/** Read existing metadata fields from a TIFF/EXIF block (best-effort for inspect()). */
function readExifTagsFromTiff(tiff) {
  if (!tiff || tiff.length < 8) return {};
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return {};
  if (tiffU16(tiff, 2, le) !== 42) return {};
  const ifd0 = readTiffIfd(tiff, tiffU32(tiff, 4, le), le);
  if (!ifd0) return {};
  const out = {};
  const getAscii = (ifd, tag) => {
    const e = ifd.entries.find((x) => x.tag === tag);
    return e ? readTiffAscii(tiff, e, le) : null;
  };
  const desc = getAscii(ifd0, TAG_IFD0_IMAGE_DESCRIPTION);
  if (desc) out.title = desc;
  const make = getAscii(ifd0, TAG_IFD0_MAKE);
  if (make) out.make = make;
  const model = getAscii(ifd0, TAG_IFD0_MODEL);
  if (model) out.model = model;
  const artist = getAscii(ifd0, TAG_IFD0_ARTIST);
  if (artist) out.artist = artist;
  const copyright = getAscii(ifd0, TAG_IFD0_COPYRIGHT);
  if (copyright) out.copyright = copyright;
  const dt = getAscii(ifd0, TAG_IFD0_DATETIME);
  if (dt) out.date = dt;
  const ratingEntry = ifd0.entries.find((x) => x.tag === TAG_IFD0_RATING);
  if (ratingEntry) {
    const r = readTiffShort(tiff, ratingEntry, le);
    if (r !== null) out.rating = r;
  }
  const ptr = ifd0.entries.find((x) => x.tag === TAG_EXIF_IFD_POINTER);
  const exifIfd = ptr ? readTiffIfd(tiff, tiffU32(tiff, ptr.at + 8, le), le) : null;
  if (exifIfd) {
    const dto = getAscii(exifIfd, TAG_DATETIME_ORIGINAL);
    if (dto) out.dateOriginal = dto;
    const dtd = getAscii(exifIfd, TAG_DATETIME_DIGITIZED);
    if (dtd) out.encodedDate = dtd;
    const ucEntry = exifIfd.entries.find((x) => x.tag === TAG_USER_COMMENT);
    if (ucEntry) {
      const uc = decodeUserComment(readTiffValue(tiff, ucEntry, le) || new Uint8Array(0));
      if (uc) out.comment = uc;
    }
  }
  return out;
}

function tiffAppender(baseLength) {
  const chunks = [];
  let cursor = baseLength;
  return {
    add(bytes) {
      if (cursor % 2) { chunks.push(new Uint8Array(1)); cursor += 1; }
      const at = cursor;
      chunks.push(bytes);
      cursor += bytes.length;
      return at;
    },
    bytes: () => chunks,
  };
}

function writeTiffIfd(le, entries, next) {
  const out = new Uint8Array(2 + entries.length * 12 + 4);
  tiffPutU16(out, 0, entries.length, le);
  entries.forEach((e, i) => {
    const at = 2 + i * 12;
    if (e.raw) { out.set(e.raw, at); return; }
    tiffPutU16(out, at, e.tag, le);
    tiffPutU16(out, at + 2, e.type, le);
    tiffPutU32(out, at + 4, e.count, le);
    if (e.inline) out.set(e.inline, at + 8);
    else tiffPutU32(out, at + 8, e.valueOffset, le);
  });
  tiffPutU32(out, 2 + entries.length * 12, next, le);
  return out;
}

function valueEntries(fields, appender) {
  return fields.map((f) => {
    const count = f.count ?? f.bytes.length;
    if (f.bytes.length <= 4) {
      const inline = new Uint8Array(4);
      inline.set(f.bytes, 0);
      return { tag: f.tag, type: f.type, count, inline };
    }
    return { tag: f.tag, type: f.type, count, valueOffset: appender.add(f.bytes) };
  });
}

function encodeIfdField(f, le) {
  if (f.type === TIFF_TYPE_SHORT) {
    const b = new Uint8Array(2);
    tiffPutU16(b, 0, f.shortValue, le);
    return { tag: f.tag, type: TIFF_TYPE_SHORT, count: 1, bytes: b };
  }
  return { tag: f.tag, type: TIFF_TYPE_ASCII, bytes: utf8(f.value + '\0') };
}

function sortEntries(entries, le) {
  return entries.sort((a, b) => (a.tag ?? tiffU16(a.raw, 0, le)) - (b.tag ?? tiffU16(b.raw, 0, le)));
}

function buildExifTiff(tiff, wants) {
  if (tiff.length < 8) throw fail('EXIF_UNPARSEABLE', 'EXIF block is too short for a TIFF header');
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) throw fail('EXIF_UNPARSEABLE', 'EXIF block has no TIFF byte-order mark');
  if (tiffU16(tiff, 2, le) !== 42) throw fail('EXIF_UNPARSEABLE', 'EXIF TIFF magic is not 42');
  const ifd0 = readTiffIfd(tiff, tiffU32(tiff, 4, le), le);
  if (!ifd0) throw fail('EXIF_UNPARSEABLE', 'EXIF IFD0 is outside the EXIF block');

  const changed = wants.ifd0.filter((f) => {
    const e = ifd0.entries.find((x) => x.tag === f.tag);
    if (!e) return true;
    if (f.type === TIFF_TYPE_SHORT) return readTiffShort(tiff, e, le) !== f.shortValue;
    return readTiffAscii(tiff, e, le) !== f.value;
  });

  const pointer = ifd0.entries.find((e) => e.tag === TAG_EXIF_IFD_POINTER);
  const exifIfd = pointer ? readTiffIfd(tiff, tiffU32(tiff, pointer.at + 8, le), le) : null;
  const changedExif = (wants.exifIfd || []).filter((f) => {
    const e = exifIfd ? exifIfd.entries.find((x) => x.tag === f.tag) : null;
    return !e || readTiffAscii(tiff, e, le) !== f.value;
  });
  let wantsComment = false;
  let commentBlocked = false;
  if (wants.comment) {
    const e = exifIfd ? exifIfd.entries.find((x) => x.tag === TAG_USER_COMMENT) : null;
    const cur = e ? decodeUserComment(readTiffValue(tiff, e, le) || new Uint8Array(0)).trim() : '';
    if (!cur) wantsComment = true;
    else if (cur !== wants.comment.trim()) commentBlocked = true;
  }
  const wantsExifIfd = wantsComment || changedExif.length > 0;

  const gpsPtr = ifd0.entries.find((e) => e.tag === TAG_GPS_IFD_POINTER);
  const gpsIfd = gpsPtr ? readTiffIfd(tiff, tiffU32(tiff, gpsPtr.at + 8, le), le) : null;
  const gpsSpecs = wants.gps ? buildGpsFieldSpecs(wants.gps, le) : [];
  let wantsGps = false;
  if (gpsSpecs.length) {
    if (!gpsIfd) wantsGps = true;
    else {
      wantsGps = gpsSpecs.some((sp) => {
        const e = gpsIfd.entries.find((x) => x.tag === sp.tag);
        if (!e) return true;
        const val = readTiffValue(tiff, e, le);
        return !val || val.length !== sp.bytes.length || !val.every((b, idx) => b === sp.bytes[idx]);
      });
    }
  }

  if (!changed.length && !wantsExifIfd && !wantsGps) {
    return commentBlocked ? { skipped: true, commentBlocked } : null;
  }

  const appender = tiffAppender(tiff.length);
  let newExifIfdOffset = null;
  if (wantsExifIfd) {
    const entries = [];
    const overrideTags = new Set(changedExif.map((f) => f.tag));
    if (wantsComment) overrideTags.add(TAG_USER_COMMENT);
    if (exifIfd) {
      for (const e of exifIfd.entries) {
        if (overrideTags.has(e.tag)) continue;
        entries.push({ tag: e.tag, raw: tiff.slice(e.at, e.at + 12) });
      }
    } else {
      entries.push({ tag: TAG_EXIF_VERSION, type: TIFF_TYPE_UNDEFINED, count: 4, inline: utf8('0232') });
    }
    const newExifFields = changedExif.map((f) => encodeIfdField(f, le));
    if (wantsComment) {
      newExifFields.push({ tag: TAG_USER_COMMENT, type: TIFF_TYPE_UNDEFINED, bytes: encodeUserComment(wants.comment) });
    }
    entries.push(...valueEntries(newExifFields, appender));
    newExifIfdOffset = appender.add(writeTiffIfd(le, sortEntries(entries, le), exifIfd ? exifIfd.next : 0));
  }

  let newGpsIfdOffset = null;
  if (wantsGps) {
    const gpsEntries = valueEntries(gpsSpecs, appender);
    newGpsIfdOffset = appender.add(writeTiffIfd(le, sortEntries(gpsEntries, le), 0));
  }

  const keep = ifd0.entries
    .filter((e) => !changed.some((c) => c.tag === e.tag))
    .filter((e) => !(wantsExifIfd && e.tag === TAG_EXIF_IFD_POINTER))
    .filter((e) => !(wantsGps && e.tag === TAG_GPS_IFD_POINTER))
    .map((e) => ({ tag: e.tag, raw: tiff.slice(e.at, e.at + 12) }));
  const rebuilt = valueEntries(changed.map((f) => encodeIfdField(f, le)), appender);
  if (wantsExifIfd) {
    rebuilt.push({ tag: TAG_EXIF_IFD_POINTER, type: TIFF_TYPE_LONG, count: 1, valueOffset: newExifIfdOffset });
  }
  if (wantsGps) {
    rebuilt.push({ tag: TAG_GPS_IFD_POINTER, type: TIFF_TYPE_LONG, count: 1, valueOffset: newGpsIfdOffset });
  }
  const newIfd0Offset = appender.add(writeTiffIfd(le, sortEntries([...keep, ...rebuilt], le), ifd0.next));

  const out = cat([tiff, ...appender.bytes()]);
  tiffPutU32(out, 4, newIfd0Offset, le);
  return { tiff: out, changed: changed.map((c) => c.tag), commentBlocked };
}

function synthesizeTiff(wants) {
  const le = false;
  const hasExif = Boolean(wants.comment || (wants.exifIfd && wants.exifIfd.length));
  const hasGps = Boolean(wants.gps);

  const ifd0Fields = wants.ifd0.map((f) => encodeIfdField(f, le));
  if (hasExif) ifd0Fields.push({ tag: TAG_EXIF_IFD_POINTER, type: TIFF_TYPE_LONG, count: 1, bytes: new Uint8Array(4) });
  if (hasGps) ifd0Fields.push({ tag: TAG_GPS_IFD_POINTER, type: TIFF_TYPE_LONG, count: 1, bytes: new Uint8Array(4) });
  sortEntries(ifd0Fields, le);

  const exifFields = [];
  if (hasExif) {
    exifFields.push({ tag: TAG_EXIF_VERSION, type: TIFF_TYPE_UNDEFINED, count: 4, bytes: utf8('0232') });
    for (const f of (wants.exifIfd || [])) exifFields.push(encodeIfdField(f, le));
    if (wants.comment) {
      exifFields.push({ tag: TAG_USER_COMMENT, type: TIFF_TYPE_UNDEFINED, bytes: encodeUserComment(wants.comment) });
    }
    exifFields.sort((a, b) => a.tag - b.tag);
  }

  const gpsFields = hasGps ? buildGpsFieldSpecs(wants.gps, le) : [];

  const ifd0Size = 2 + ifd0Fields.length * 12 + 4;
  const exifSize = exifFields.length ? 2 + exifFields.length * 12 + 4 : 0;
  const gpsSize = gpsFields.length ? 2 + gpsFields.length * 12 + 4 : 0;
  const exifAt = 8 + ifd0Size;
  const gpsAt = exifAt + exifSize;
  let cursor = gpsAt + gpsSize;
  const chunks = [];
  const place = (bytes) => {
    if (cursor % 2) { chunks.push(new Uint8Array(1)); cursor += 1; }
    const at = cursor; chunks.push(bytes); cursor += bytes.length; return at;
  };
  const ifd = new Uint8Array(ifd0Size);
  tiffPutU16(ifd, 0, ifd0Fields.length, le);
  ifd0Fields.forEach((e, i) => {
    const at = 2 + i * 12;
    tiffPutU16(ifd, at, e.tag, le);
    tiffPutU16(ifd, at + 2, e.type, le);
    if (e.tag === TAG_EXIF_IFD_POINTER) {
      tiffPutU32(ifd, at + 4, 1, le);
      tiffPutU32(ifd, at + 8, exifAt, le);
      return;
    }
    if (e.tag === TAG_GPS_IFD_POINTER) {
      tiffPutU32(ifd, at + 4, 1, le);
      tiffPutU32(ifd, at + 8, gpsAt, le);
      return;
    }
    const count = e.count ?? e.bytes.length;
    tiffPutU32(ifd, at + 4, count, le);
    if (e.bytes.length <= 4) { ifd.set(e.bytes, at + 8); return; }
    tiffPutU32(ifd, at + 8, place(e.bytes), le);
  });
  tiffPutU32(ifd, 2 + ifd0Fields.length * 12, 0, le);

  let exifIfd = new Uint8Array(0);
  if (exifFields.length) {
    exifIfd = new Uint8Array(exifSize);
    tiffPutU16(exifIfd, 0, exifFields.length, le);
    exifFields.forEach((e, i) => {
      const at = 2 + i * 12;
      const count = e.count ?? e.bytes.length;
      tiffPutU16(exifIfd, at, e.tag, le);
      tiffPutU16(exifIfd, at + 2, e.type, le);
      tiffPutU32(exifIfd, at + 4, count, le);
      if (e.bytes.length <= 4) { exifIfd.set(e.bytes, at + 8); return; }
      tiffPutU32(exifIfd, at + 8, place(e.bytes), le);
    });
    tiffPutU32(exifIfd, 2 + exifFields.length * 12, 0, le);
  }

  let gpsIfd = new Uint8Array(0);
  if (gpsFields.length) {
    gpsIfd = new Uint8Array(gpsSize);
    tiffPutU16(gpsIfd, 0, gpsFields.length, le);
    gpsFields.forEach((e, i) => {
      const at = 2 + i * 12;
      const count = e.count ?? e.bytes.length;
      tiffPutU16(gpsIfd, at, e.tag, le);
      tiffPutU16(gpsIfd, at + 2, e.type, le);
      tiffPutU32(gpsIfd, at + 4, count, le);
      if (e.bytes.length <= 4) { gpsIfd.set(e.bytes, at + 8); return; }
      tiffPutU32(gpsIfd, at + 8, place(e.bytes), le);
    });
    tiffPutU32(gpsIfd, 2 + gpsFields.length * 12, 0, le);
  }

  return cat([new Uint8Array([0x4d, 0x4d]), new Uint8Array([0, 42]), u32be(8), ifd, exifIfd, gpsIfd, ...chunks]);
}
const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

const asExifPayload = (tiff) => cat([utf8(EXIF_PREFIX), tiff]);

function wrapExifApp1(payload) {
  const segLen = 2 + payload.length;
  if (segLen > 0xffff) {
    throw fail('EXIF_TOO_LARGE', 'EXIF block exceeds the JPEG single-segment 64KB limit');
  }
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
  seg.set(payload, 4);
  return seg;
}

function exifInsertPosition(head) {
  const p = 2;
  if (head.length >= 4 && head[p] === 0xff && head[p + 1] === 0xe0) {
    const len = u16(head, p + 2);
    if (len >= 2 && p + 2 + len <= head.length) return p + 2 + len;
  }
  return 2;
}

/**
 * Invert the write-side description/comment combiner. `buildXmpPacket` joins
 * `[description, comment, url]` with '\n\n' into a single `dc:description`, so a
 * naive read-back would feed that combined text back in as both fields and the
 * comment would be appended again on every `inspect() -> writeTags()` round-trip.
 * `comment` is sourced from the native EXIF UserComment, so strip the trailing
 * comment segment here to keep the round-trip idempotent.
 */
function reconcileDescriptionComment(tags) {
  if (!tags || typeof tags.comment !== 'string' || !tags.comment) return tags;
  const c = tags.comment;
  const d = tags.description;
  if (typeof d !== 'string' || !d) return tags;
  if (d === c) tags.description = '';
  else if (d.endsWith('\n\n' + c)) tags.description = d.slice(0, -(c.length + 2));
  return tags;
}

function extractJpegExistingTags(head, removes, exif) {
  let merged = {};
  if (exif && exif.length === 1) {
    const payload = head.subarray(exif[0].start + 4, exif[0].end);
    if (payload.length > EXIF_PREFIX_LEN) {
      merged = { ...merged, ...readExifTagsFromTiff(payload.subarray(EXIF_PREFIX_LEN)) };
    }
  }
  if (removes && removes.length) {
    for (const r of removes) {
      const xml = new TextDecoder().decode(head.subarray(r.start + 4 + XMP_NS.length + 1, r.end));
      const parsed = parseXmpPacket(xml);
      merged = { ...merged, ...parsed };
    }
  }
  if (!Object.keys(merged).length) return null;
  return reconcileDescriptionComment(merged);
}

export async function planJpeg(src, tags, report, seed, opts = {}) {
  validateTags(tags);
  const { head, insertAt, removes, extRemoves, mpf, exif } = await scanJpeg(src, report, seed);
  let effectiveTags = tags;
  if (opts.mergeXmp && removes.length) {
    const existing = extractJpegExistingTags(head, removes, []);
    if (existing) {
      effectiveTags = { ...existing, ...tags };
      report.notes.push('merged existing XMP tags (mergeXmp: true)');
    }
  }
  const seg = buildXmpApp1(effectiveTags);
  const edits = [];
  for (const r of removes) {
    edits.push({ start: r.start, end: r.end, bytes: new Uint8Array(0), what: 'replace existing XMP segment' });
  }
  for (const r of extRemoves) {
    edits.push({ start: r.start, end: r.end, bytes: new Uint8Array(0), what: 'drop stale Extended XMP fragment' });
  }
  if (!removes.length && !extRemoves.length) report.notes.push('JPEG has no existing XMP; inserting new APP1 segment');
  if (extRemoves.length) {
    report.xmp = { replaced: removes.length, staleExtendedFragments: extRemoves.length };
    report.notes.push(`removed ${extRemoves.length} stale Extended XMP fragment(s)`);
  }
  if (opts.nativeExif !== false) {
    const wants = nativeExifFields(effectiveTags);
    if (wants.ifd0.length || wants.exifIfd.length || wants.comment || wants.gps) {
      try {
        if (exif.length > 1) {
          report.warnings.push(`${exif.length} Exif APP1 segments found; native EXIF fields were not written`);
        } else if (exif.length === 1) {
          const payload = head.subarray(exif[0].start + 4, exif[0].end);
          const built = buildExifTiff(payload.subarray(EXIF_PREFIX_LEN), wants);
          if (built && built.tiff) {
            edits.push({
              start: exif[0].start, end: exif[0].end,
              bytes: wrapExifApp1(asExifPayload(built.tiff)), what: 'update EXIF',
            });
            report.exif = { updated: built.changed, userComment: !!wants.comment && !built.commentBlocked };
            if (built.commentBlocked) {
              report.notes.push('existing EXIF UserComment holds other data (e.g. camera parameters); kept it and used XMP for the comment');
            }
            report.notes.push(`EXIF IFD0 updated (${built.changed.length} tag(s): `
              + `${built.changed.map((t) => '0x' + t.toString(16)).join(', ')})`);
          } else {
            if (built && built.commentBlocked) {
              report.notes.push('existing EXIF UserComment holds other data (e.g. camera parameters); kept it and used XMP for the comment');
            }
            report.notes.push('EXIF already holds the requested values; left untouched');
          }
        } else {
          const at = exifInsertPosition(head);
          edits.push({ start: at, end: at, bytes: wrapExifApp1(asExifPayload(synthesizeTiff(wants))), what: 'insert EXIF APP1' });
          report.exif = { created: true, fields: wants.ifd0.map((f) => f.tag), userComment: !!wants.comment };
          report.notes.push('file had no EXIF; created a minimal APP1 EXIF segment');
        }
      } catch (e) {
        report.warnings.push(`native EXIF not updated: ${e.message}`);
      }
    }
  }

  edits.push({ start: insertAt, end: insertAt, bytes: seg, what: 'insert XMP APP1' });

  if (mpf && mpf.length) {
    const map = makePosMap(edits);
    let images = 0;
    for (const m of mpf) {
      const segBytes = head.subarray(m.start, m.end);
      const parsed = parseMpf(segBytes, m.start, src.size);
      const patched = rebaseMpf(segBytes, parsed, map);
      images += parsed.entries.length;
      if (patched) {
        edits.push({ start: m.start, end: m.end, bytes: patched, what: 'rebase MPF multi-picture offsets' });
      }
    }
    report.mpf = { segments: mpf.length, images, rebased: true };
    report.notes.push(`MPF multi-picture index rebased (${images} individual image${images > 1 ? 's' : ''})`);
  }
  return { format: 'jpeg', edits, bytesReadFor: insertAt };
}

/* ===========================================================================
 * 5. PNG planner: reads only the file header (between IHDR and IDAT)
 * ========================================================================= */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function scanPng(src, report, seed) {
  const MAX_HEAD = 8 << 20;
  let cap = Math.min(64 << 10, src.size);
  for (;;) {
    const head = await readHeadAt(src, cap, seed);
    const r = scanPngHead(head, src.size);
    if (r.ok) return { head, ...r };
    if (!r.needMore || cap >= MAX_HEAD || cap >= src.size) {
      throw fail('MALFORMED_CONTAINER', 'Could not locate PNG insertion point' + (r.reason ? ': ' + r.reason : ''));
    }
    cap = Math.min(MAX_HEAD, Math.max(cap * 4, r.needTo));
    report.notes.push(`PNG header scan extended to ${cap} bytes`);
  }
}

function scanPngHead(b, fileSize) {
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return { ok: false, reason: 'not a PNG (signature mismatch)' };
  let pos = 8, insertAt = -1;
  const removes = [];
  const exif = [];
  const textChunks = [];
  let exifTextChunks = 0;
  while (pos + 8 <= b.length) {
    const len = u32(b, pos);
    const type = fourcc(b, pos + 4);
    if (len > 0x7fffffff) return { ok: false, reason: 'invalid chunk length' };
    const end = pos + 12 + len;
    if (end > fileSize) return { ok: false, reason: 'chunk extends past file end' };
    if (type === 'IDAT' || type === 'IEND') { insertAt = pos; break; }
    if (end > b.length) return { ok: false, needMore: true, needTo: end };
    if (type === 'eXIf') exif.push({ start: pos, end, dataAt: pos + 8 });
    if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const kwEnd = b.indexOf(0, pos + 8);
      if (kwEnd > -1 && kwEnd < end) {
        const kw = new TextDecoder().decode(b.subarray(pos + 8, kwEnd));
        if (kw.startsWith('exif:') || kw === 'Raw profile type APP1') exifTextChunks++;
        if (PNG_OWN_KEYWORDS.has(kw)) removes.push({ start: pos, end, kw, what: `replace existing chunk ${kw}` });
        textChunks.push({ type, start: pos, end, dataAt: pos + 8, dataEnd: end - 4, kw });
      }
    }
    pos = end;
  }
  if (insertAt === -1) {
    if (pos + 8 > b.length) return { ok: false, needMore: true, needTo: Math.min(fileSize, b.length * 4) };
    return { ok: false, reason: 'IDAT/IEND not found' };
  }
  return { ok: true, insertAt, removes, exif, exifTextChunks, textChunks };
}

function extractPngExistingTags(head, textChunks, exif) {
  let merged = {};
  if (exif && exif.length === 1) {
    merged = { ...merged, ...readExifTagsFromTiff(head.subarray(exif[0].dataAt, exif[0].end - 4)) };
  }
  if (textChunks && textChunks.length) {
    const kwMap = {
      'Title': 'title',
      'Author': 'artist',
      'Description': 'description',
      'Comment': 'comment',
      'Creation Time': 'date',
      'Encoded Time': 'encodedDate',
      'Modify Time': 'taggedDate',
      'Copyright': 'copyright',
      'Software': 'software',
      'Collection': 'album',
      'Genre': 'genre',
      'Location': 'gps',
    };
    for (const tc of textChunks) {
      const decoded = decodePngTextChunk(tc.type, head.subarray(tc.dataAt, tc.dataEnd));
      if (!decoded || !decoded.text) continue;
      if (decoded.keyword === PNG_XMP_KEYWORD) {
        merged = { ...merged, ...parseXmpPacket(decoded.text) };
      } else if (kwMap[decoded.keyword]) {
        const field = kwMap[decoded.keyword];
        if (!merged[field]) merged[field] = decoded.text;
      } else if (decoded.keyword === 'Rating' && Number.isFinite(Number(decoded.text))) {
        if (merged.rating === undefined) merged.rating = Number(decoded.text);
      }
    }
  }
  if (!Object.keys(merged).length) return null;
  return reconcileDescriptionComment(merged);
}

export async function planPng(src, tags, report, seed, opts = {}) {
  validateTags(tags);
  const { head, insertAt, removes, exif, exifTextChunks, textChunks } = await scanPng(src, report, seed);
  let effectiveTags = tags;
  if (opts.mergeXmp && (removes.length || (textChunks && textChunks.length))) {
    const existing = extractPngExistingTags(head, textChunks, []);
    if (existing) {
      effectiveTags = { ...existing, ...tags };
      report.notes.push('merged existing PNG XMP/text tags (mergeXmp: true)');
    }
  }
  const chunks = buildPngTextChunks(effectiveTags);
  if (!chunks) throw new Error('no writable tags provided');
  const edits = removes.map((r) => ({ start: r.start, end: r.end, bytes: new Uint8Array(0), what: r.what }));

  if (opts.nativeExif !== false) {
    const wants = nativeExifFields(effectiveTags, { dateTime: false });
    if (wants.ifd0.length || wants.exifIfd.length || wants.comment || wants.gps) {
      try {
        if (exif.length > 1) {
          report.warnings.push(`${exif.length} eXIf chunks found; native EXIF fields were not written`);
        } else if (exif.length === 1) {
          const built = buildExifTiff(head.subarray(exif[0].dataAt, exif[0].end - 4), wants);
          if (built && built.tiff) {
            edits.push({ start: exif[0].start, end: exif[0].end,
              bytes: pngChunk('eXIf', built.tiff), what: 'update eXIf chunk' });
            report.exif = { updated: built.changed, userComment: !!wants.comment && !built.commentBlocked };
            report.notes.push(`eXIf chunk updated (${built.changed.length} tag(s))`);
            if (built.commentBlocked) {
              report.notes.push('existing eXIf UserComment holds other data; kept it and used XMP for the comment');
            }
          } else {
            if (built && built.commentBlocked) {
              report.notes.push('existing eXIf UserComment holds other data; kept it and used XMP for the comment');
            }
            report.notes.push('eXIf already holds the requested values; left untouched');
          }
        } else {
          edits.push({ start: insertAt, end: insertAt,
            bytes: pngChunk('eXIf', synthesizeTiff(wants)), what: 'insert eXIf chunk' });
          report.exif = { created: true, fields: wants.ifd0.map((f) => f.tag), userComment: !!wants.comment };
          report.notes.push('file had no eXIf; created one');
        }
      } catch (e) {
        report.warnings.push(`native EXIF not updated: ${e.message}`);
      }
    }
  }

  if (exifTextChunks) {
    report.warnings.push(`this PNG already carries EXIF outside the eXIf chunk `
      + `(${exifTextChunks} text chunk(s): ImageMagick "Raw profile type APP1" or "exif:*"); `
      + 'the new fields went to eXIf and XMP, but readers that prefer those chunks may show the old ones');
  }

  edits.push({ start: insertAt, end: insertAt, bytes: chunks, what: 'insert iTXt text chunks' });
  return { format: 'png', edits, bytesReadFor: insertAt };
}

/* ===========================================================================
 * 6. MP4 planner: reads only box headers + moov
 * ========================================================================= */

export async function probeMp4(src, seed) {
  const win = new HeaderWindow(src, 65536, seed);
  const boxes = [];
  let pos = 0, guard = 0;
  while (pos + 8 <= src.size) {
    if (++guard > 100000) throw new Error('abnormal number of top-level boxes');
    const w = await win.header(pos);
    if (!w) break;
    const { buf, off } = w;
    let size = u32(buf, off), headerSize = 8;
    const type = fourcc(buf, off + 4);
    if (size === 1) {
      if (off + 16 > buf.length) { throw new Error('largesize header spans window boundary; increase window size'); }
      headerSize = 16;
      size = u64(buf, off + 8);
    } else if (size === 0) {
      size = src.size - pos;
    }
    const minValidSize = type === 'ftyp' ? Math.max(headerSize, 16) : headerSize;
    if (size < minValidSize || pos + size > src.size) {
      throw fail('MALFORMED_CONTAINER', `box ${type}@${pos} has invalid size (${size})`);
    }
    boxes.push({ pos, size, headerSize, type, end: pos + size });
    pos += size;
  }
  const moov = boxes.find((b) => b.type === 'moov');
  const mdat = boxes.find((b) => b.type === 'mdat');
  const ftyp = boxes.find((b) => b.type === 'ftyp');
  const free = boxes.filter((b) => b.type === 'free' || b.type === 'skip');
  const moofs = boxes.filter((b) => b.type === 'moof' || b.type === 'sidx');
  return {
    boxes, moov, mdat, ftyp, free, moofs,
    complete: pos >= src.size && pos === src.size,
    hasFragments: moofs.length > 0,
    fastStart: !!(moov && mdat && moov.pos < mdat.pos),
  };
}

function findChild(bytes, base, type, end) {
  const limit = end === undefined ? bytes.length : end;
  let p = base;
  while (p + 8 <= limit) {
    const size = u32(bytes, p);
    if (size < 8 || p + size > limit) return null;
    if (fourcc(bytes, p + 4) === type) return { pos: p, size, end: p + size };
    p += size;
  }
  return null;
}

function listChildrenEx(bytes, base, end) {
  const children = [];
  let p = base;
  let malformed = false;
  let reason = '';
  while (p + 8 <= end) {
    const size = u32(bytes, p);
    if (size === 1) {
      malformed = true; reason = `box ${fourcc(bytes, p + 4)} at ${p} uses a 64-bit largesize header (not supported inside metadata)`;
      break;
    }
    if (size < 8 || p + size > end) {
      malformed = true; reason = `box ${fourcc(bytes, p + 4)} at ${p} declares size ${size} but only ${end - p} bytes remain`;
      break;
    }
    children.push({ pos: p, size, type: fourcc(bytes, p + 4), end: p + size });
    p += size;
  }
  if (!malformed && p !== end) {
    malformed = true;
    reason = `${end - p} trailing byte(s) after the last box at ${p}`;
  }
  return { children, malformed, reason };
}

function listChildren(bytes, base, end) {
  return listChildrenEx(bytes, base, end).children;
}

function metaChildrenEx(bytes, meta) {
  const iso = listChildrenEx(bytes, meta.pos + 12, meta.end);
  const qt = listChildrenEx(bytes, meta.pos + 8, meta.end);
  const hasHdlr = (r) => !r.malformed && r.children.some((c) => c.type === 'hdlr');
  if (hasHdlr(iso)) return { children: iso.children, malformed: false, versionFlags: true };
  if (hasHdlr(qt)) return { children: qt.children, malformed: false, versionFlags: false };
  if (!iso.malformed) return { children: iso.children, malformed: false, versionFlags: true };
  if (!qt.malformed) return { children: qt.children, malformed: false, versionFlags: false };
  return { children: iso.children, malformed: true, versionFlags: true, reason: qt.reason || iso.reason };
}

function parseExistingIlst(moovBytes) {
  const moovKids = listChildrenEx(moovBytes, 8, moovBytes.length);
  if (moovKids.malformed) {
    return { udtas: [], unparseable: true, reason: 'moov contains a child box with an invalid size' };
  }

  const udtas = [];
  const containers = [];
  const ignoredUdtas = [];
  const udtaExtras = [];

  for (const k of moovKids.children) {
    if (k.type === 'udta') {
      const meta = findChild(moovBytes, k.pos + 8, 'meta', k.end);
      if (meta) {
        const kidsEx = listChildrenEx(moovBytes, k.pos + 8, k.end);
        if (kidsEx.malformed) {
          return {
            udtas, containers, ignoredUdtas, hasMetadata: true, unparseable: true,
            reason: `udta box at offset ${k.pos} cannot be fully traversed (${kidsEx.reason})`,
          };
        }
        for (const c of kidsEx.children) {
          if (c.type === 'meta' || c.type === 'free') continue;
          udtaExtras.push(moovBytes.slice(c.pos, c.end));
        }
        udtas.push(k);
        containers.push({ meta, label: `udta@${k.pos}/meta`, udta: k });
        continue;
      }
      const kids = listChildrenEx(moovBytes, k.pos + 8, k.end);
      const qtTags = kids.children.filter((c) => c.type.charCodeAt(0) === 0xa9);
      if (qtTags.length) {
        return {
          udtas, unparseable: true,
          reason: `udta box at offset ${k.pos} holds QuickTime tag atoms `
            + `(${qtTags.map((c) => c.type).join(', ')}) that cannot be merged yet`,
        };
      }
      ignoredUdtas.push(k);
    } else if (k.type === 'meta') {
      containers.push({ meta: { pos: k.pos, size: k.size, end: k.end }, label: 'moov/meta' });
    }
  }

  let hdlrType = 'mdir';
  let keys = [];
  const entries = [];
  const extraMetaChildren = [];
  const hdlrTypes = new Set();

  for (const container of containers) {
    const { meta } = container;
    const metaKids = metaChildrenEx(moovBytes, meta);
    container.versionFlags = metaKids.versionFlags;
    if (metaKids.malformed) {
      return {
        udtas, containers, ignoredUdtas, hasMetadata: true, unparseable: true,
        reason: `meta subtree of ${container.label} is malformed (${metaKids.reason})`,
      };
    }
    const hdlr = metaKids.children.find((k) => k.type === 'hdlr');
    const localHdlr = hdlr ? fourcc(moovBytes, hdlr.pos + 16) : null;
    container.hdlrType = localHdlr;
    if (localHdlr) { hdlrType = localHdlr; hdlrTypes.add(localHdlr); }
    const keysBox = metaKids.children.find((k) => k.type === 'keys');
    const localKeys = [];
    if (keysBox) {
      const count = u32(moovBytes, keysBox.pos + 12);
      let kp = keysBox.pos + 16;
      for (let i = 0; i < count && kp + 8 <= keysBox.end; i++) {
        const s = u32(moovBytes, kp);
        if (s < 8 || kp + s > keysBox.end) {
          return {
            udtas, containers, ignoredUdtas, hasMetadata: true, unparseable: true,
            reason: `keys table of ${container.label} is malformed`,
          };
        }
        localKeys.push(new TextDecoder().decode(moovBytes.subarray(kp + 8, kp + s)));
        kp += s;
      }
      if (kp !== keysBox.end) {
        return {
          udtas, containers, ignoredUdtas, hasMetadata: true, unparseable: true,
          reason: `keys table of ${container.label} does not tile its box`,
        };
      }
    }
    container.keys = localKeys;
    for (const k of localKeys) if (!keys.includes(k)) keys.push(k);

    const localEntries = [];
    const ilst = metaKids.children.find((k) => k.type === 'ilst');
    if (ilst) {
      const ilstKids = listChildrenEx(moovBytes, ilst.pos + 8, ilst.end);
      if (ilstKids.malformed) {
        return {
          udtas, containers, ignoredUdtas, hasMetadata: true, unparseable: true,
          reason: `ilst of ${container.label} is malformed (${ilstKids.reason})`,
        };
      }
      for (const c of ilstKids.children) {
        const name = c.type;
        const numericIndex = name.charCodeAt(0) === 0 && name.charCodeAt(1) === 0 && name.charCodeAt(2) === 0;
        let keyValue = null;
        if (numericIndex) {
          const idx = u32(moovBytes, c.pos + 4);
          if (idx < 1 || idx > localKeys.length) {
            return {
              udtas, containers, ignoredUdtas, hasMetadata: true, unparseable: true,
              reason: `ilst entry index ${idx} of ${container.label} does not resolve in its keys table`,
            };
          }
          keyValue = localKeys[idx - 1];
        }
        localEntries.push({ name, keyValue, numericIndex, raw: moovBytes.slice(c.pos, c.end) });
      }
    }
    container.entries = localEntries;
    entries.push(...localEntries);

    const localExtras = [];
    for (const k of metaKids.children) {
      if (k.type !== 'hdlr' && k.type !== 'keys' && k.type !== 'ilst') {
        localExtras.push(moovBytes.slice(k.pos, k.end));
      }
    }
    container.extraMetaChildren = localExtras;
    extraMetaChildren.push(...localExtras);
  }

  const mixedHandlers = hdlrTypes.size > 1;

  return {
    udtas, containers, ignoredUdtas, udtaExtras,
    hasMetadata: containers.length > 0,
    hdlrType, keys, entries, extraMetaChildren,
    hdlrTypes: [...hdlrTypes], mixedHandlers,
  };
}

function readTagValue(raw) {
  let p = 8;
  while (p + 8 <= raw.length) {
    const size = u32(raw, p);
    if (size < 8 || p + size > raw.length) return '';
    if (fourcc(raw, p + 4) === 'data' && size >= 16) {
      return new TextDecoder().decode(raw.subarray(p + 16, p + size));
    }
    p += size;
  }
  return '';
}

function patchChunkOffsets(bytes, moovStart, moovEnd, delta, threshold, report) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let patched = 0, needCo64 = false;
  const walk = (start, end) => {
    let p = start;
    while (p + 8 <= end) {
      let size = u32(bytes, p), header = 8;
      if (size === 1) { header = 16; size = u64(bytes, p + 8); } else if (size === 0) size = end - p;
      if (size < header || p + size > end) return;
      const type = fourcc(bytes, p + 4);
      if (type === 'stco') {
        const count = u32(bytes, p + 12);
        if (p + 16 + count * 4 > p + size) return;
        for (let i = 0; i < count; i++) {
          const off = p + 16 + i * 4;
          if (off + 4 > end) return;
          const v = dv.getUint32(off);
          if (v >= threshold) {
            const nv = v + delta;
            if (nv < 0 || nv > 0xffffffff) { needCo64 = true; return; }
            dv.setUint32(off, nv >>> 0);
            patched++;
          }
        }
      } else if (type === 'co64') {
        const count = u32(bytes, p + 12);
        if (p + 16 + count * 8 > p + size) return;
        for (let i = 0; i < count; i++) {
          const off = p + 16 + i * 8;
          if (off + 8 > end) return;
          const v = u64(bytes, off);
          if (v >= threshold) {
            const nv = v + delta;
            if (nv < 0) { needCo64 = true; return; }
            if (nv > Number.MAX_SAFE_INTEGER) {
              throw fail('UNSUPPORTED_LARGESIZE',
                `sample offset ${v} + ${delta} exceeds 2^53; refusing to write an imprecise offset`);
            }
            dv.setBigUint64(off, BigInt(nv));
            patched++;
          }
        }
      } else if (['trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        walk(p + header, p + size);
      }
      p += size;
    }
  };
  walk(moovStart + 8, moovEnd);
  report.notes.push(`patched ${patched} stco/co64 entries (threshold 0x${threshold.toString(16)}, delta ${delta})`);
  if (needCo64) throw fail('CO64_REQUIRED', 'stco entry overflows 32 bits; co64 upgrade path was not taken');
}

const OFFSET_CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

function findInconsistentOffsetTable(moovBytes) {
  let bad = null;
  walkOffsetBoxes(moovBytes, 0, moovBytes.length, (type, pos, size) => {
    if (bad) return;
    const width = type === 'stco' ? 4 : 8;
    const count = u32(moovBytes, pos + 12);
    if (16 + count * width > size) {
      const room = Math.max(0, Math.floor((size - 16) / width));
      bad = `${type} at offset ${pos} declares ${count} entries but its box (${size} bytes) `
        + `has room for only ${room}`;
    }
  });
  return bad;
}

const MOOV_MEMORY_FACTOR = 4.2;
const MOOV_WARN_BYTES = 16 << 20;
const REWRITE_CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

function walkOffsetBoxes(bytes, start, end, fn) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(bytes, p);
    let header = 8;
    if (size === 1) { header = 16; size = u64(bytes, p + 8); }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    const type = fourcc(bytes, p + 4);
    if (type === 'stco' || type === 'co64') fn(type, p, size);
    else if (OFFSET_CONTAINERS.includes(type)) walkOffsetBoxes(bytes, p + header, p + size, fn);
    p += size;
  }
}

/**
 * Smallest multiple of 8 `>= prevAligned` that can be reached from `unpadded`
 * by adding either `0` bytes (no `free` box) or `>= 8` bytes (a valid ISO-BMFF
 * `free` box, whose header alone is 8 bytes).
 */
function minAlignedDelta(unpadded, prevAligned = -Infinity) {
  const rem = ((unpadded % 8) + 8) % 8;
  let cand = rem === 0 ? unpadded : unpadded + (16 - rem);
  while (cand < prevAligned || (cand > unpadded && cand - unpadded < 8)) {
    cand += 8;
  }
  return cand;
}

/**
 * Jointly solve for:
 *   - `co64Growth`: extra bytes required by `stco -> co64` upgrades (+4 bytes per entry)
 *   - `padBytes`:   size of the `free` box (0 or >= 8) needed to keep `finalDelta`
 *                   a multiple of 8 (the project's 8-byte shift alignment invariant)
 *   - `finalDelta`: `rawMetaGrowth + co64Growth + padBytes`
 *
 * Upgrading an `stco` box with an odd entry count adds `4 mod 8` bytes, which
 * changes the required padding; conversely, the padding itself increases the
 * shift delta and can push another `stco` entry past `0xFFFFFFFF`. Because
 * `alignedDelta` is strictly non-decreasing across passes, iterating until both
 * `co64Growth` and `alignedDelta` stabilize reaches a true fixed point in at
 * most `(number of stco boxes + 1)` iterations.
 */
function planAlignedMoovGrowth(moovBytes, rawMetaGrowth, threshold) {
  const countOverflowGrowth = (delta) => {
    let needed = 0;
    walkOffsetBoxes(moovBytes, 0, moovBytes.length, (type, pos) => {
      if (type !== 'stco') return;
      const count = u32(moovBytes, pos + 12);
      for (let i = 0; i < count; i++) {
        const v = u32(moovBytes, pos + 16 + i * 4);
        if (v >= threshold && v + delta > 0xffffffff) { needed += count * 4; break; }
      }
    });
    return needed;
  };

  let co64Growth = countOverflowGrowth(rawMetaGrowth);
  let alignedDelta = minAlignedDelta(rawMetaGrowth + co64Growth);
  for (let iter = 0; iter < 64; iter++) {
    const needed = countOverflowGrowth(alignedDelta);
    const nextAligned = minAlignedDelta(rawMetaGrowth + needed, alignedDelta);
    if (needed === co64Growth && nextAligned === alignedDelta) {
      const padBytes = alignedDelta - (rawMetaGrowth + co64Growth);
      return { co64Growth, padBytes, finalDelta: alignedDelta };
    }
    co64Growth = needed;
    alignedDelta = nextAligned;
  }
  throw fail('CONVERGENCE',
    'stco -> co64 upgrade planning did not converge; refusing to rewrite offsets');
}

function rewriteMoov(moovBytes, delta, threshold, report) {
  let upgraded = 0, patched = 0;

  const process = (start, end) => {
    const parts = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(moovBytes, p);
      let header = 8;
      if (size === 1) { header = 16; size = u64(moovBytes, p + 8); }
      else if (size === 0) size = end - p;
      if (size < header || p + size > end) break;
      const type = fourcc(moovBytes, p + 4);

      if (type === 'stco') {
        const count = u32(moovBytes, p + 12);
        if (p + 16 + count * 4 > p + size) break;
        const vals = new Array(count);
        let needs = false;
        for (let i = 0; i < count; i++) {
          const v = u32(moovBytes, p + 16 + i * 4);
          vals[i] = v;
          if (v >= threshold && v + delta > 0xffffffff) needs = true;
        }
        if (needs) {
          const body = new Uint8Array(4 + count * 8);
          const dv = new DataView(body.buffer);
          dv.setUint32(0, count);
          for (let i = 0; i < count; i++) {
            const v = vals[i] >= threshold ? vals[i] + delta : vals[i];
            dv.setBigUint64(4 + i * 8, BigInt(v));
            patched++;
          }
          parts.push(mp4FullBox('co64', 0, 0, body));
          upgraded++;
        } else {
          const body = new Uint8Array(4 + count * 4);
          const dv = new DataView(body.buffer);
          dv.setUint32(0, count);
          for (let i = 0; i < count; i++) {
            const v = vals[i] >= threshold ? vals[i] + delta : vals[i];
            dv.setUint32(4 + i * 4, v >>> 0);
            patched++;
          }
          parts.push(mp4FullBox('stco', 0, 0, body));
        }
      } else if (type === 'co64') {
        const count = u32(moovBytes, p + 12);
        if (p + 16 + count * 8 > p + size) break;
        const body = new Uint8Array(4 + count * 8);
        const dv = new DataView(body.buffer);
        dv.setUint32(0, count);
        for (let i = 0; i < count; i++) {
          let v = u64(moovBytes, p + 16 + i * 8);
          if (v >= threshold) v += delta;
          dv.setBigUint64(4 + i * 8, BigInt(v));
          patched++;
        }
        parts.push(mp4FullBox('co64', 0, 0, body));
      } else if (REWRITE_CONTAINERS.includes(type)) {
        const childBytes = process(p + header, p + size);
        const newSize = header + childBytes.length;
        const out = new Uint8Array(newSize);
        const dv = new DataView(out.buffer);
        if (header === 16) {
          dv.setUint32(0, 1);
          for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
          dv.setBigUint64(8, BigInt(newSize));
        } else {
          dv.setUint32(0, newSize);
          for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        }
        out.set(childBytes, header);
        parts.push(out);
      } else {
        parts.push(moovBytes.subarray(p, p + size));
      }
      p += size;
    }
    return cat(parts);
  };

  const bytes = process(0, moovBytes.length);
  report.notes.push(`rewrote moov: ${patched} offsets shifted, ${upgraded} stco box(es) upgraded to co64`);
  return { bytes, upgraded, patched };
}

export async function planMp4(src, tags, report, opts = {}, seed) {
  validateTags(tags);
  const probe = await probeMp4(src, seed);
  report.probe = {
    fastStart: probe.fastStart,
    moovAt: probe.moov ? probe.moov.pos : -1,
    moovSize: probe.moov ? probe.moov.size : 0,
    boxCount: probe.boxes.length,
    fragmented: probe.hasFragments,
    boxList: probe.boxes.map((b) => b.type).join(','),
  };
  report.probe.metadataContainers = [];
  if (!probe.moov) {
    const brand = seed && seed.length >= 12
      ? String.fromCharCode(seed[8], seed[9], seed[10], seed[11]) : '';
    const kind = ISOBMFF_IMAGE_BRANDS[brand.trim().toLowerCase()];
    throw fail('UNSUPPORTED_FORMAT', kind
      ? `${kind} (ftyp brand "${brand}") is not supported: it carries metadata in meta/iloc, not moov/udta. Supported: JPEG, PNG, MP4/MOV`
      : 'moov box not found (not a recognizable MP4/MOV)');
  }
  report.notes.push(probe.fastStart ? 'faststart: moov precedes mdat' : 'moov is after media data (tail)');
  if (probe.moov.size > MOOV_WARN_BYTES) {
    report.warnings.push(`moov is ${(probe.moov.size / 1048576).toFixed(1)} MB; rewriting it peaks at roughly `
      + `${(probe.moov.size * MOOV_MEMORY_FACTOR / 1048576).toFixed(0)} MB of extra memory `
      + `(≈${MOOV_MEMORY_FACTOR}× moov, independent of the media size). `
      + 'Check inspect().mp4.moovSize before writing very long recordings.');
  }

  const moov = await src._read(probe.moov.pos, probe.moov.end);
  if (moov.length !== probe.moov.size) throw fail('MALFORMED_CONTAINER', 'moov read incomplete');

  const userFormat = opts.metadataFormat || 'auto';
  if (!['auto', 'mdir', 'mdta'].includes(userFormat)) {
    throw fail('BAD_OPTION', `metadataFormat must be 'auto' | 'mdir' | 'mdta', received: ${userFormat}`);
  }

  const norm = normalizeTags(tags);

  if (u32(moov, 0) === 1) {
    throw fail('UNSUPPORTED_LARGESIZE',
      'REFUSE: moov uses a 64-bit largesize header; rewriting it is not supported yet');
  }

  const moovCount = probe.boxes.filter((b) => b.type === 'moov').length;
  if (moovCount > 1) {
    throw fail('MALFORMED_CONTAINER',
      `REFUSE: file contains ${moovCount} moov boxes; only one is meaningful and `
      + 'rewriting it would invalidate the others');
  }

  const badTable = findInconsistentOffsetTable(moov);
  if (badTable) {
    throw fail('MALFORMED_CONTAINER',
      `REFUSE: ${badTable}; patching it would write into the neighbouring box`);
  }

  const existing = parseExistingIlst(moov);

  if (existing.unparseable) {
    throw fail('MALFORMED_CONTAINER',
      `REFUSE: ${existing.reason}; refusing to write to avoid silently dropping metadata`);
  }

  const hasMetadata = existing.hasMetadata;
  report.probe.metadataContainers = existing.containers.map((c) => c.label);
  const metaFormat = userFormat === 'auto'
    ? (hasMetadata && existing.hdlrType === 'mdta' ? 'mdta' : (hasMetadata ? existing.hdlrType : 'mdir'))
    : userFormat;

  const hasIlstEntries = (metaFormat === 'mdta' ? buildMdtaEntries(tags) : buildMdirEntries(tags)).length > 0;
  const splitContainers = hasMetadata && existing.mixedHandlers && userFormat === 'auto';

  // Fast idempotency check when a single udta already holds the exact target
  // `meta` bytes (plus any `free` padding box added by a prior write, e.g.
  // after an odd-entry stco -> co64 upgrade). Preserving the existing udta as-is
  // when `meta` is unchanged guarantees second-write byte identity.
  let ops = [];
  let preservedTotal = 0;
  let appendOp = null;
  if (!hasIlstEntries && !hasMetadata) {
    report.notes.push('header-only timestamp update (no ilst tags requested)');
  } else if (splitContainers) {
    for (const c of existing.containers) {
      const format = c.hdlrType || 'mdir';
      const built = buildMetaBox(c, tags, format);
      preservedTotal += built.preserved;
      if (c.udta) {
        ops.push({ start: c.udta.pos, end: c.udta.end, bytes: replaceUdtaMeta(moov, c.udta, built.bytes) });
      } else {
        ops.push({ start: c.meta.pos, end: c.meta.end, bytes: built.bytes });
      }
    }
    report.notes.push(`mixed metadata handlers (${existing.hdlrTypes.join(' + ')}): `
      + `updated ${existing.containers.length} container(s) in place, each in its own format`);
  } else {
    const merged = buildMetaBox(hasMetadata ? existing : null, tags, metaFormat);
    preservedTotal = merged.preserved;
    const metaIso = merged.bytes;

    // If there is exactly 1 existing udta (and no moov/meta) whose `meta` child
    // is already byte-identical to `metaIso`, keep the existing udta (including
    // its existing alignment padding) untouched.
    const singleUdta = existing.udtas.length === 1 && existing.containers.length === 1 && existing.containers[0].udta;
    const oldMeta = singleUdta ? existing.containers[0].meta : null;
    const metaUnchanged = Boolean(oldMeta && oldMeta.size === metaIso.length
      && moov.subarray(oldMeta.pos, oldMeta.end).every((v, i) => v === metaIso[i]));

    if (!metaUnchanged) {
      if (existing.udtas.length) {
        if (existing.udtas.length > 1) {
          report.warnings.push(`moov has ${existing.udtas.length} udta meta containers (legacy); merged into 1`);
        }
        for (const c of existing.udtas) ops.push({ start: c.pos, end: c.end, bytes: null });
        appendOp = { start: moov.length, end: moov.length, bytes: wrapUdta(metaIso, existing.udtaExtras) };
        ops.push(appendOp);
      }
      for (const c of existing.containers) {
        if (c.label === 'moov/meta') {
          const own = c.versionFlags === false ? buildMetaBox(c, tags, metaFormat).bytes : metaIso;
          ops.push({ start: c.meta.pos, end: c.meta.end, bytes: own });
        }
      }
      if (!ops.length) {
        appendOp = { start: moov.length, end: moov.length, bytes: wrapUdta(metaIso, existing.udtaExtras) };
        ops.push(appendOp);
      }
      if (existing.udtaExtras.length) {
        report.notes.push(`carried over ${existing.udtaExtras.length} non-meta child box(es) of the rewritten udta`);
      }
    }
  }

  if (hasMetadata) {
    report.notes.push(`merged existing metadata (` +
      `${existing.containers.map((c) => c.label).join(' + ')}, hdlr=${existing.hdlrTypes.join('+') || existing.hdlrType}, ` +
      `${existing.entries.length} old entries, preserved ${preservedTotal})`);
  } else if (hasIlstEntries) {
    report.notes.push('no existing metadata; created moov/udta/meta/ilst');
  }
  if (existing.ignoredUdtas.length) {
    report.notes.push(`left ${existing.ignoredUdtas.length} udta box(es) without a meta box untouched`);
  }

  // ---- Unified fixed-point solver: metadata growth + co64 upgrade + 8-byte alignment ----
  // Jointly calculates rawMetaGrowth, stco -> co64 upgrade bytes (4 bytes per
  // entry, which is 4 mod 8 when entry count is odd), and `free` box padding so
  // that `finalDelta` is always a multiple of 8 and converges monotonically.
  let rawMetaGrowth = 0;
  for (const op of ops) rawMetaGrowth += (op.bytes ? op.bytes.length : 0) - (op.end - op.start);
  const { co64Growth, padBytes, finalDelta } = planAlignedMoovGrowth(moov, rawMetaGrowth, probe.moov.end);

  if (padBytes > 0) {
    const padBox = mp4Box('free', new Uint8Array(padBytes - 8));
    if (appendOp) {
      appendOp.bytes = mp4Box('udta', cat([appendOp.bytes.subarray(8), padBox]));
    } else {
      ops.push({ start: moov.length, end: moov.length, bytes: padBox });
    }
  }

  ops.sort((a, b) => a.start - b.start);
  let newMoovLen = moov.length;
  for (const op of ops) newMoovLen += (op.bytes ? op.bytes.length : 0) - (op.end - op.start);
  const outMoov = new Uint8Array(newMoovLen);
  {
    let r = 0, w = 0;
    for (const op of ops) {
      if (op.start < r) throw new Error('overlapping moov rewrite regions');
      outMoov.set(moov.subarray(r, op.start), w); w += op.start - r;
      if (op.bytes) { outMoov.set(op.bytes, w); w += op.bytes.length; }
      r = op.end;
    }
    outMoov.set(moov.subarray(r, moov.length), w); w += moov.length - r;
  }
  new DataView(outMoov.buffer).setUint32(0, outMoov.length);       // sync moov size

  // ---- Patch MP4 Encoded date (creation_time) & Tagged date (modification_time) ----
  const encInput = norm.encodedDate || norm.date || norm.dateOriginal;
  const tagInput = norm.taggedDate || norm.date || norm.dateOriginal;
  const encodedSec = encInput ? toMp4EpochSeconds(encInput) : null;
  const taggedSec = tagInput ? toMp4EpochSeconds(tagInput) : null;
  if (encodedSec !== null || taggedSec !== null) {
    const patchedCount = patchMp4HeaderDates(outMoov, encodedSec, taggedSec, report);
    if (patchedCount > 0) {
      report.mp4Dates = {
        encodedDate: encodedSec !== null ? fromMp4EpochSeconds(encodedSec) : null,
        taggedDate: taggedSec !== null ? fromMp4EpochSeconds(taggedSec) : null,
        boxesPatched: patchedCount,
      };
    }
  }

  if (finalDelta === 0) {
    let identical = true;
    for (let i = 0; i < outMoov.length; i++) if (outMoov[i] !== moov[i]) { identical = false; break; }
    if (identical) {
      report.notes.push('target tags are byte-identical to existing; no modification needed (idempotent no-op)');
      return { format: 'mp4', edits: [], metaFormat, delta: 0, noop: true, bytesReadFor: probe.moov.size,
        preservedTags: preservedTotal, offsets: { stcoUpgraded: false, moovDelta: 0 } };
    }
  }

  if (probe.hasFragments && !opts.allowUnsafeFragmented) {
    throw fail('FRAGMENTED_MP4',
      'REFUSE: this is a fragmented MP4 (moof/sidx present); sample offsets are ' +
      'scattered across trun/tfhd/saio/sidx. Inserting before media data would ' +
      'invalidate all of them. Writing refused (consider re-muxing or keeping the original file).'
    );
  }

  let finalMoov;
  if (co64Growth === 0) {
    patchChunkOffsets(outMoov, 0, outMoov.length, finalDelta, probe.moov.end, report);
    finalMoov = outMoov;
  } else {
    finalMoov = rewriteMoov(outMoov, finalDelta, probe.moov.end, report).bytes;
    report.notes.push(`stco -> co64 upgrade: +${co64Growth} bytes (moov ${moov.length} -> ${finalMoov.length})`);
  }

  const edits = [{ start: probe.moov.pos, end: probe.moov.end, bytes: finalMoov, what: `replace moov (metadata rewritten, size ${moov.length} -> ${finalMoov.length})` }];
  return {
    format: 'mp4', edits, metaFormat, delta: finalDelta, bytesReadFor: probe.moov.size,
    preservedTags: preservedTotal,
    offsets: { stcoUpgraded: co64Growth > 0, moovDelta: finalDelta },
  };
}

/* ===========================================================================
 * 7. Assembly: convert edits into reference slices, then into a Blob or
 *    ReadableStream.
 * ========================================================================= */

function buildParts(src, edits) {
  const sorted = edits.slice().sort((a, b) =>
    (a.start - b.start) || ((a.end - a.start) - (b.end - b.start)));
  const parts = [];
  let cur = 0;
  for (const e of sorted) {
    if (e.start < cur) throw new Error('edit ranges overlap');
    if (e.start > cur) parts.push({ kind: 'ref', start: cur, end: e.start });
    if (e.bytes && e.bytes.length) parts.push({ kind: 'bytes', bytes: e.bytes, what: e.what });
    cur = e.end;
  }
  if (cur < src.size) parts.push({ kind: 'ref', start: cur, end: src.size });
  const size = parts.reduce((a, p) => a + (p.kind === 'bytes' ? p.bytes.length : p.end - p.start), 0);
  return { parts, size };
}

function partsToBlob(src, parts, type) {
  const chunks = parts.map((p) => (p.kind === 'bytes' ? p.bytes : src._slice(p.start, p.end)));
  return new Blob(chunks, { type: type || src.type || 'application/octet-stream' });
}

export function partsToStream(src, parts, chunkSize = 4 << 20) {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0)
    throw new RangeError('chunkSize must be a positive integer');
  let i = 0, offsetInRef = 0;
  return new ReadableStream({
    async pull(controller) {
      while (i < parts.length) {
        const p = parts[i];
        if (p.kind === 'bytes') {
          i++;
          if (p.bytes.length) { controller.enqueue(p.bytes); return; }
          continue;
        }
        const from = p.start + offsetInRef;
        const to = Math.min(p.end, from + chunkSize);
        if (from >= p.end) { i++; offsetInRef = 0; continue; }
        const buf = await src._read(from, to);
        offsetInRef = to - p.start;
        controller.enqueue(buf);
        return;
      }
      controller.close();
    },
  });
}

/* ===========================================================================
 * 8. Public API
 * ========================================================================= */

/** Probe: writes nothing. Returns format, safety assessment, existing metadata,
 *  and container structure details. */
export async function inspect(source) {
  const holder = { src: null };
  try {
    return await inspectSource(source, holder);
  } catch (e) {
    const src = holder.src;
    return {
      format: 'unknown',
      supported: false,
      safeToWrite: false,
      size: src ? src.size : 0,
      mime: src ? (src.type || '') : '',
      capabilities: capabilities('unknown'),
      existingTags: null,
      error: String((e && e.message) || e),
      ...(e && e.code ? { errorCode: e.code } : {}),
      readStats: src ? { ...src.stats } : null,
    };
  }
}

async function inspectSource(source, holder) {
  const src = await normalizeSource(source);
  holder.src = src;
  const head = await readHeadAt(src, 32, null);
  const format = sniff(head, src.type);
  if (!['jpeg', 'png', 'mp4'].includes(format)) {
    const err = unsupportedFormatError(format, head);
    return {
      format,
      supported: false,
      safeToWrite: false,
      size: src.size,
      mime: src.type || '',
      capabilities: capabilities(format),
      existingTags: null,
      error: err.message,
      errorCode: err.code,
      readStats: { ...src.stats },
    };
  }

  const info = {
    format,
    supported: true,
    safeToWrite: false,
    size: src.size,
    mime: src.type || '',
    capabilities: capabilities(format),
    existingTags: null,
  };

  if (format === 'jpeg') {
    try {
      const j = await scanJpeg(src, { notes: [] }, head);
      let mpf = null;
      if (j.mpf && j.mpf.length) {
        const m = j.mpf[0];
        const parsed = parseMpf(j.head.subarray(m.start, m.end), m.start, src.size);
        mpf = {
          images: parsed.entries.length,
          lengths: parsed.entries.map((e) => e.size),
          offsets: parsed.entries.map((e) => e.startAbs),
          offsetBase: parsed.baseKind,
        };
      }
      const existingTags = extractJpegExistingTags(j.head, j.removes, j.exif);
      info.safeToWrite = true;
      info.existingTags = existingTags;
      info.jpeg = {
        safeToWrite: true,
        existingXmp: j.removes.length > 0,
        existingExif: j.exif.length > 0,
        insertionPoint: j.insertAt,
        extendedXmpFragments: j.extRemoves.length,
        multiPicture: mpf,
        existingTags,
      };
    } catch (e) {
      info.safeToWrite = false;
      info.capabilities = capabilities('unknown');
      info.error = String((e && e.message) || e);
      info.errorCode = (e && e.code) || 'MALFORMED_CONTAINER';
      info.jpeg = { safeToWrite: false, error: info.error, errorCode: info.errorCode };
    }
  }

  if (format === 'png') {
    try {
      const p = await scanPng(src, { notes: [] }, head);
      const existingTags = extractPngExistingTags(p.head, p.textChunks, p.exif);
      info.safeToWrite = true;
      info.existingTags = existingTags;
      info.png = {
        safeToWrite: true,
        existingXmp: p.removes.some((r) => r.kw === PNG_XMP_KEYWORD),
        existingExif: p.exif.length > 0,
        insertionPoint: p.insertAt,
        exifTextChunks: p.exifTextChunks,
        existingTags,
      };
    } catch (e) {
      info.safeToWrite = false;
      info.capabilities = capabilities('unknown');
      info.error = String((e && e.message) || e);
      info.errorCode = (e && e.code) || 'MALFORMED_CONTAINER';
      info.png = { safeToWrite: false, error: info.error, errorCode: info.errorCode };
    }
  }

  if (format === 'mp4') {
    try {
      const probe = await probeMp4(src, head);
      if (!probe.moov) {
        const brand = head && head.length >= 12 ? fourcc(head, 8) : '';
        const kind = ISOBMFF_IMAGE_BRANDS[brand.trim().toLowerCase()];
        throw fail(kind ? 'UNSUPPORTED_FORMAT' : 'MALFORMED_CONTAINER', kind
          ? `${kind} (ftyp brand "${brand}") is not supported: it carries metadata in meta/iloc, not moov/udta. Supported: JPEG, PNG, MP4/MOV`
          : 'moov box not found (not a recognizable MP4/MOV)');
      }
      const moov = await src._read(probe.moov.pos, probe.moov.end);
      if (moov.length !== probe.moov.size) {
        throw fail('MALFORMED_CONTAINER', 'moov read incomplete');
      }
      const moovCount = probe.boxes.filter((b) => b.type === 'moov').length;
      const largesizeMoov = u32(moov, 0) === 1;
      const badTable = findInconsistentOffsetTable(moov);
      const stsd = findStsd(moov);
      const existing = parseExistingIlst(moov);
      const headerDates = readMp4HeaderDates(moov);
      const metadataMalformed = !!(existing && existing.unparseable);
      const safeToWrite = Boolean(
        probe.complete && !probe.hasFragments && !metadataMalformed
        && !largesizeMoov && moovCount === 1 && !badTable
      );
      const rawTags = summarizeIlst(moov);
      const normalizedTags = normalizeMp4ExistingTags(rawTags, headerDates);

      info.safeToWrite = safeToWrite;
      info.existingTags = normalizedTags;
      if (!safeToWrite) {
        info.capabilities = capabilities('unknown');
        if (probe.hasFragments) {
          info.errorCode = 'FRAGMENTED_MP4';
          info.error = 'fragmented MP4 (moof/sidx present) cannot be safely rewritten in place';
        } else if (largesizeMoov) {
          info.errorCode = 'UNSUPPORTED_LARGESIZE';
          info.error = 'moov uses a 64-bit largesize header';
        } else if (moovCount > 1) {
          info.errorCode = 'MALFORMED_CONTAINER';
          info.error = `file contains ${moovCount} moov boxes`;
        } else if (badTable) {
          info.errorCode = 'MALFORMED_CONTAINER';
          info.error = badTable;
        } else if (metadataMalformed) {
          info.errorCode = 'MALFORMED_CONTAINER';
          info.error = existing.reason;
        } else if (!probe.complete) {
          info.errorCode = 'MALFORMED_CONTAINER';
          info.error = 'top-level box chain is incomplete or truncated';
        }
      }
      info.mp4 = {
        fastStart: probe.fastStart,
        fragmented: probe.hasFragments,
        moovAt: probe.moov.pos,
        moovSize: probe.moov.size,
        safeToWrite,
        ...(metadataMalformed ? { metadataMalformed: existing.reason } : {}),
        ...(existing && existing.hasMetadata ? {
          metadataFormat: existing.mixedHandlers ? 'mixed' : (existing.hdlrType || 'mdir'),
          metadataContainers: existing.containers.map((c) => c.label),
        } : {}),
        codec: stsd ? stsd.codec : null,
        video: stsd ? stsd.video : null,
        durationSec: stsd ? stsd.durationSec : null,
        bitrate: stsd ? stsd.bitrate : null,
        encodedDate: headerDates.encodedDate,
        taggedDate: headerDates.taggedDate,
        existingTags: rawTags,
      };
    } catch (e) {
      info.safeToWrite = false;
      info.capabilities = capabilities('unknown');
      info.error = String((e && e.message) || e);
      info.errorCode = (e && e.code) || 'MALFORMED_CONTAINER';
      info.mp4 = {
        fastStart: false,
        fragmented: false,
        moovAt: -1,
        moovSize: 0,
        safeToWrite: false,
        error: info.error,
        errorCode: info.errorCode,
      };
    }
  }
  info.readStats = { ...src.stats };
  return info;
}

function summarizeIlst(moov) {
  const ex = parseExistingIlst(moov);
  if (!ex || ex.unparseable || !ex.hasMetadata) return null;
  const out = {};
  for (const e of ex.entries) {
    const key = e.keyValue || e.name.replace(/\xa9/, '©');
    out[key] = readTagValue(e.raw).slice(0, 80);
  }
  return out;
}

function normalizeMp4ExistingTags(rawTags, headerDates) {
  const out = {};
  if (rawTags) {
    const map = {
      '©nam': 'title', 'title': 'title',
      '©ART': 'artist', 'artist': 'artist',
      '©day': 'date', 'date': 'date',
      'com.apple.quicktime.creationdate': 'dateOriginal',
      'desc': 'description', 'description': 'description',
      '©cmt': 'comment', 'comment': 'comment',
      '©url': 'url', 'url': 'url',
      '©too': 'software', 'software': 'software',
      'cprt': 'copyright', 'copyright': 'copyright',
      '©alb': 'album', 'album': 'album',
      '©gen': 'genre', 'genre': 'genre',
      '©mak': 'make', 'com.apple.quicktime.make': 'make',
      '©mod': 'model', 'com.apple.quicktime.model': 'model',
      '©xyz': 'gps', 'com.apple.quicktime.location.ISO6709': 'gps',
    };
    for (const [k, v] of Object.entries(rawTags)) {
      if (!v) continue;
      if (k === '©key' || k === 'keywords') {
        out.keywords = String(v).split(',').map((s) => s.trim()).filter(Boolean);
      } else if (k === 'rate' || k === 'com.apple.quicktime.rating.user') {
        if (Number.isFinite(Number(v))) out.rating = Number(v);
      } else if (map[k] && !out[map[k]]) {
        out[map[k]] = v;
      }
    }
  }
  // Invert the write-side comment/url combiner: buildMdirEntries/buildMdtaEntries
  // join `[comment, 'URL: ' + url]` with '\n' into the ©cmt/comment atom. Without
  // stripping it here the URL is re-appended on every inspect() -> writeTags()
  // round-trip and grows without bound.
  if (typeof out.comment === 'string' && out.comment && out.url) {
    const suffix = '\nURL: ' + out.url;
    if (out.comment === 'URL: ' + out.url) out.comment = '';
    else if (out.comment.endsWith(suffix)) out.comment = out.comment.slice(0, -suffix.length);
  }
  if (headerDates && headerDates.encodedDate) out.encodedDate = headerDates.encodedDate;
  if (headerDates && headerDates.taggedDate) out.taggedDate = headerDates.taggedDate;
  return Object.keys(out).length ? out : null;
}

/** Read stsd from moov: codec, resolution, duration, bitrate. */
function findStsd(moov) {
  const traks = listChildren(moov, 8, moov.length).filter((b) => b.type === 'trak');
  let result = null;
  for (const trak of traks) {
    const mdia = findChild(moov, trak.pos + 8, 'mdia', trak.end);
    if (!mdia) continue;
    const mdhd = findChild(moov, mdia.pos + 8, 'mdhd', mdia.end);
    const hdlr = findChild(moov, mdia.pos + 8, 'hdlr', mdia.end);
    const handler = hdlr ? fourcc(moov, hdlr.pos + 16) : '';
    const minf = findChild(moov, mdia.pos + 8, 'minf', mdia.end);
    if (!minf) continue;
    const stbl = findChild(moov, minf.pos + 8, 'stbl', minf.end);
    if (!stbl) continue;
    const stsd = findChild(moov, stbl.pos + 8, 'stsd', stbl.end);
    const stsz = findChild(moov, stbl.pos + 8, 'stsz', stbl.end);
    let durationSec = null;
    if (mdhd) {
      const ver = moov[mdhd.pos + 8];
      const ts = ver === 1 ? u32(moov, mdhd.pos + 28) : u32(moov, mdhd.pos + 20);
      const dur = ver === 1 ? u64(moov, mdhd.pos + 32) : u32(moov, mdhd.pos + 24);
      if (ts) durationSec = dur / ts;
    }
    let mediaBytes = 0;
    if (stsz) {
      const sampleSize = u32(moov, stsz.pos + 12);
      const count = u32(moov, stsz.pos + 16);
      mediaBytes = sampleSize ? sampleSize * count : (() => {
        let s = 0;
        for (let i = 0; i < count && stsz.pos + 20 + i * 4 + 4 <= stsz.end; i++) s += u32(moov, stsz.pos + 20 + i * 4);
        return s;
      })();
    }
    let codec = null, video = null;
    if (stsd && stsd.pos + 16 <= stsd.end && u32(moov, stsd.pos + 12) > 0) {
      const entry = stsd.pos + 16;
      if (entry + 8 <= stsd.end) codec = fourcc(moov, entry + 4);
      if (handler === 'vide' && entry + 36 <= stsd.end) {
        video = { width: u16(moov, entry + 32), height: u16(moov, entry + 34) };
      }
    }
    const info = {
      handler, codec, video, durationSec,
      mediaBytes,
      bitrate: durationSec ? Math.round((mediaBytes * 8) / durationSec) : null,
    };
    if (handler === 'vide') return info;
    if (!result) result = info;
  }
  return result;
}

/**
 * Main entry: writes tags into a media file.
 * @returns {Promise<{ok:boolean, blob?:Blob, stream?:ReadableStream, parts?:Array, report:Object, error?:string}>}
 */
export async function writeTags(source, tags, opts = {}) {
  let src = null;
  let statsOverride;
  const report = { format: null, strategy: null, notes: [], warnings: [] };
  Object.defineProperty(report, 'stats', {
    enumerable: true,
    get: () => (statsOverride !== undefined ? statsOverride : (src ? { ...src.stats } : null)),
    set: (v) => { statsOverride = v; },
  });
  try {
    src = await normalizeSource(source);
    const head = await readHeadAt(src, 32, null);
    const format = sniff(head, src.type);
    report.format = format;
    // Validate date, GPS, and rating inputs uniformly before format dispatch
    validateTags(tags);
    if (!hasWritableTags(tags)) {
      throw fail('NO_TAGS', 'no writable tags supplied: pass at least one non-empty field '
        + `(${TAG_FIELDS.join(', ')})`);
    }
    if (!['jpeg', 'png', 'mp4'].includes(format)) {
      throw unsupportedFormatError(format, head);
    }
    const caps = capabilities(format);
    const unsupported = requestedFields(tags).filter((k) => !caps.supported.includes(k));
    if (unsupported.length) {
      report.unsupportedTags = unsupported;
      report.supportedTags = caps.supported;
      throw fail('UNSUPPORTED_TAG',
        `${unsupported.join(', ')} cannot be stored in ${format.toUpperCase()}; `
        + `this container supports: ${caps.supported.join(', ')}`);
    }
    let plan;
    if (format === 'jpeg') plan = await planJpeg(src, tags, report, head, opts);
    else if (format === 'png') plan = await planPng(src, tags, report, head, opts);
    else plan = await planMp4(src, tags, report, opts, head);

    report.strategy = plan.format === 'mp4'
      ? (report.probe.fastStart ? 'moov-at-head-shift-offsets' : 'moov-at-tail-zero-offset')
      : 'header-in-place-insert';
    const { parts, size } = buildParts(src, plan.edits);
    report.outputSize = size;
    report.edits = plan.edits.map((e) => ({ start: e.start, end: e.end, bytes: e.bytes.length, what: e.what }));
    if (plan.metaFormat !== undefined) report.metaFormat = plan.metaFormat;
    if (plan.delta !== undefined) report.delta = plan.delta;

    const inserted = plan.edits.reduce((a, e) => a + (e.bytes ? e.bytes.length : 0), 0);
    const removedBytes = plan.edits.reduce((a, e) => a + (e.end - e.start), 0);
    report.input = { size: src.size, mime: src.type || '' };
    report.changes = {
      metadataBytes: inserted,
      bytesRemoved: removedBytes,
      netDelta: size - src.size,
      mediaBytesChanged: false,
      reencoded: false,
    };
    report.metadata = {
      format: plan.metaFormat || (plan.format === 'mp4' ? 'moov/udta/meta' : 'xmp'),
      addedTags: requestedFields(tags).filter((k) => caps.supported.includes(k)),
      ...(plan.preservedTags !== undefined ? { preservedTags: plan.preservedTags } : {}),
      ...(report.probe && report.probe.metadataContainers
        ? { existingContainers: report.probe.metadataContainers } : {}),
    };
    report.offsets = { shifted: size !== src.size, delta: size - src.size, ...(plan.offsets || {}) };
    report.planning = {
      readCalls: src.stats.readCalls,
      bytesRead: src.stats.bytesRead,
      maxReadSize: src.stats.maxReadSize,
    };

    if (opts.materialize === false) {
      report.stats = { ...src.stats };
      return { ok: true, parts, size, report };
    }

    const out = { ok: true, parts, size, report };
    if (src.canSlice() && typeof Blob === 'function') {
      out.blob = partsToBlob(src, parts, opts.mimeType);
      report.stats = { ...src.stats };
      report.notes.push(`output as Blob: ${parts.length} slices assembled by reference`);
    } else {
      out.stream = partsToStream(src, parts, opts.chunkSize);
      report.notes.push('output as ReadableStream (source does not support local slicing; pipe to file system writer)');
    }
    return out;
  } catch (e) {
    report.error = String((e && e.message) || e);
    if (e && e.code) report.errorCode = e.code;
    report.stats = src ? { ...src.stats } : null;
    return { ok: false, report };
  }
}

async function normalizeSource(source) {
  if (source instanceof Source) {
    if (source instanceof HttpSource && source.rangeSupported === null && !source.size) {
      throw fail('SOURCE_NOT_READY',
        'this HttpSource has not been initialized; `await new HttpSource(url).init()` is required '
        + 'before use (init() resolves the size and whether the server supports Range requests)');
    }
    return source;
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return new BufferSource(source);
  if (typeof Blob === 'function' && source instanceof Blob) return new BlobSource(source);
  if (typeof source === 'string') {
    const http = new HttpSource(source);
    try {
      return await http.init();
    } catch (e) {
      if (e && e.code) throw e;
      throw fail('SOURCE_UNREACHABLE',
        `could not open ${source} as a random-access source: ${(e && e.message) || e}`);
    }
  }
  if (source && typeof source.read === 'function' && typeof source.size === 'number') {
    const wrapped = {
      size: source.size,
      type: source.type || '',
      stats: { readCalls: 0, bytesRead: 0, maxReadSize: 0, sliceCalls: 0 },
      canSlice: () => (typeof source.canSlice === 'function' ? !!source.canSlice() : false),
      slice: typeof source.slice === 'function'
        ? (start, end) => { wrapped.stats.sliceCalls++; return source.slice(start, end); }
        : () => { throw new Error('this source does not support reference slicing'); },
      read: (start, end) => source.read(start, end),
      async _read(start, end) {
        start = Math.max(0, Math.floor(start));
        end = Math.min(wrapped.size, Math.ceil(end));
        if (!(end > start)) return new Uint8Array(0);
        const out = await wrapped.read(start, end);
        wrapped.stats.readCalls++;
        wrapped.stats.bytesRead += out.length;
        if (out.length > wrapped.stats.maxReadSize) wrapped.stats.maxReadSize = out.length;
        return out;
      },
    };
    return wrapped;
  }
  throw fail('UNSUPPORTED_SOURCE',
    'unrecognized data source: expected a URL string, a Blob, a Uint8Array/ArrayBuffer, '
    + 'a stamp-js Source, or an object exposing read() and size');
}

export default {
  writeTags, inspect, capabilities, TAG_FIELDS, MP4_EPOCH_OFFSET,
  validateTags, parseDateToMs, toMp4EpochSeconds, fromMp4EpochSeconds, parseGps,
  buildXmpPacket, parseXmpPacket, planJpeg, planPng, planMp4, probeMp4, parseMpf, rebaseMpf,
  Source, BlobSource, BufferSource, HttpSource, partsToStream,
};
