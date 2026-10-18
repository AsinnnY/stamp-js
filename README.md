# stamp-js

[![CI](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@asinnn/stamp-js.svg)](https://www.npmjs.com/package/@asinnn/stamp-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Zero runtime dependencies · Container-level metadata surgery · Ultra-low memory footprint**
>
> Write **XMP / EXIF / iTunes (`mdir`) / QuickTime (`mdta`)** metadata and timestamps into multi-gigabyte **JPEG, PNG, MP4, and MOV** files in browsers, Node.js, Web Workers, or Tampermonkey userscripts — **without decoding media, without re-encoding, without re-muxing, and without reading the media payload into JavaScript memory.**

**English | [简体中文 (详细中文文档)](README.zh-CN.md)**

---

## Table of Contents

1. [Why stamp-js?](#1-why-stamp-js)
2. [Key Features](#2-key-features)
3. [Core Capabilities & How It Works](#3-core-capabilities--how-it-works)
4. [Supported Metadata Fields Reference (18 Fields + 5 Aliases)](#4-supported-metadata-fields-reference-18-fields--5-aliases)
5. [Special Field Formats & Validation Rules](#5-special-field-formats--validation-rules)
6. [Step-by-Step Usage Tutorials](#6-step-by-step-usage-tutorials)
   - [6.1 Installation & Importing Across Environments](#61-installation--importing-across-environments)
   - [6.2 Browser File / Blob Tagging & Download](#62-browser-file--blob-tagging--download)
   - [6.3 Writing MP4/MOV Encoded Date & Tagged Date](#63-writing-mp4mov-encoded-date--tagged-date)
   - [6.4 Inspecting Media Files & Reading Existing Tags (`inspect()`)](#64-inspecting-media-files--reading-existing-tags-inspect)
   - [6.5 Preserving & Merging Existing Metadata (`mergeXmp` & `existingTags`)](#65-preserving--merging-existing-metadata-mergexmp--existingtags)
   - [6.6 Node.js Local Files & `>4 GiB` Large Video Streaming (`NodeFileSource`)](#66-nodejs-local-files--4-gib-large-video-streaming-nodefilesource)
   - [6.7 HTTP Range Remote Video/Image Streaming](#67-http-range-remote-videoimage-streaming)
   - [6.8 Custom Data Sources & Plan-Only Mode (`materialize: false`)](#68-custom-data-sources--plan-only-mode-materialize-false)
   - [6.9 Error Handling & Machine-Readable `errorCode` Reference](#69-error-handling--machine-readable-errorcode-reference)
7. [Complete API Reference](#7-complete-api-reference)
8. [Memory Model & Safety Boundaries](#8-memory-model--safety-boundaries)
9. [Verification & Test Suite](#9-verification--test-suite)

---

## 1. Why stamp-js?

### 8 GiB MP4 → ~66 KiB read

Conventional browser or Node.js metadata workflows often load the entire file into an `ArrayBuffer` or invoke a heavy WebAssembly media pipeline to demux and remux the streams. On multi-hundred-megabyte or multi-gigabyte 4K videos, that turns a tiny metadata edit into an out-of-memory crash or a slow full-disk copy.

**stamp-js uses random-access container surgery + reference-slice assembly:**

| Metric | Whole-file / re-muxing tools | **stamp-js** |
|---|---|---|
| **Bytes read on an 8 GiB MP4** | Reads all 8 GiB of media | **~66 KiB read (~0.00077% of file)** |
| **Media payload (`mdat` / `IDAT` / scan)** | Parsed, copied, or remuxed | **100% untouched (reference slices)** |
| **Re-encoding** | May occur in transcode pipelines | **Never (100% lossless)** |
| **Re-muxing** | Demuxes and rebuilds sample tables | **Never (in-place box surgery)** |
| **Dependencies & bundle size** | Multi-MB WASM or native binaries | **Zero dependencies, pure JS** |

```text
                        random-access header/moov reads
                                      ↓
Input Media File ───────► Container probe & safety check
                                      │
                                      ▼
                         Rewrite only metadata bytes
                         & rebase affected offset tables
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
                  New metadata                Original media slices
                  (Uint8Array)                (Blob.slice / stream ranges)
                        │                           │
                        └─────────────┬─────────────┘
                                      ▼
                        Zero-copy output (Blob / Stream)
```

For a local `File` or `Blob`, the resulting file is assembled by reference:

```js
new Blob([
  originalFile.slice(0, editStart),
  newMetadataBytes,
  originalFile.slice(editEnd, originalFile.size),
]);
```

---

## 2. Key Features

* **Unified 18-Field Metadata Model**: One consistent `tags` object works across **JPEG, PNG, MP4, and MOV**, supporting `title`, `artist`, `date`, `encodedDate`, `taggedDate`, `dateOriginal`, `description`, `comment`, `url`, `software`, `copyright`, `keywords`, `album`, `genre`, `make`, `model`, `gps`, and `rating`.
* **Dual-Track Metadata Writing (XMP + Native EXIF/iTXt/Boxes)**:
  * **JPEG**: Writes standard **W3C XMP (`APP1`)** plus **native EXIF (`IFD0` / `ExifIFD` / `GPSIFD`)** so OS property sheets (Windows Explorer, macOS Finder), photo managers, and ExifTool all read the tags.
  * **PNG**: Writes **XMP (`iTXt`)**, **14 standard `iTXt` text chunks**, and a **native `eXIf` chunk**, with full CRC32 calculation.
  * **MP4 / MOV**: Writes both **`ilst` metadata atoms** (automatically preserving existing Apple iTunes `mdir` or QuickTime `mdta` `keys` styles) and **`mvhd` / `tkhd` / `mdhd` header timestamps** (32-bit v0 and 64-bit v1).
* **Read Existing Metadata (`inspect().existingTags`) & Smart Merge (`mergeXmp: true`)**: `inspect()` parses existing XMP, EXIF, PNG `iTXt`, and MP4 `ilst`/`mvhd` metadata into `info.existingTags`. Pass `{ mergeXmp: true }` to `writeTags()` to automatically merge new fields with existing JPEG/PNG XMP fields.
* **Automatic `stco → co64` 64-bit Upgrade & 8-Byte Alignment Solver**: When tagging a `faststart` MP4 near or above 4 GiB pushes 32-bit chunk offsets (`stco`) past `0xFFFFFFFF`, stamp-js upgrades overflowing tracks to 64-bit `co64` and solves for metadata growth, `co64` growth, and `free` box padding in a single monotonic fixed-point loop (`planAlignedMoovGrowth`), maintaining the project's 8-byte shift alignment invariant.
* **Motion Photo (MPF CIPA DC-007) Offset Rebasing**: Automatically updates absolute image lengths and secondary video/image offsets in `APP2 MPF` when JPEG header sizes change.
* **Safety by Refusal**: Never throws uncaught exceptions, never silently drops unsupported tags, and refuses fragmented MP4s (fMP4/CMAF) or malformed containers with machine-readable `errorCode`s.
* **Strict Idempotency**: Writing the same tags twice produces byte-for-byte identical output without stacking duplicate XMP segments or `udta` boxes.

---

## 3. Core Capabilities & How It Works

### 3.1 JPEG: Header-Only Scan + Append-Only EXIF + Motion Photo MPF

1. **Header-only scan**: Scans markers from `SOI (0xFFD8)` up to the first image coding marker (`DQT` / `SOF` / `DHT` / `SOS`), starting with a 64 KiB window (expanding up to an 8 MiB hard cap for vendor deep-data headers) and never reading entropy-coded scan data.
2. **XMP & stale Extended XMP cleanup**: Replaces existing standard XMP `APP1` segments and drops orphaned `http://ns.adobe.com/xmp/extension/` fragments.
3. **Append-only native EXIF surgery**: Because all offsets inside a TIFF block are relative to the TIFF header, updated `IFD0`, `ExifIFD`, and `GPSIFD` tables are appended at the end of the existing TIFF block and only the 4-byte `IFD0` pointer in the TIFF header is updated. Existing camera `MakerNotes` and `IFD1` thumbnails keep both their exact bytes and their exact offsets.

### 3.2 PNG: Zero IDAT Reads + Triple Metadata Layers

1. **Never reads `IDAT` bodies**: Walks chunk headers (`length` + `type`) from `IHDR` to the first `IDAT` chunk and inserts metadata before `IDAT`, even if `IDAT` is hundreds of megabytes.
2. **Triple layer**: Writes `XML:com.adobe.xmp` (`iTXt`), standard `iTXt` keywords (`Title`, `Author`, `Creation Time`, `Encoded Time`, `Modify Time`, `Collection`, `Genre`, `Source`, `Location`, `Rating`, etc.), and native `eXIf`.

### 3.3 MP4 / MOV: Box-Level Surgery + Offset Rebasing + Header Timestamps

1. **Layout-aware planning**:
   * **`moov` at tail**: Appends/updates metadata at the end of the file with zero sample offset changes (`moov-at-tail-zero-offset`).
   * **`moov` at head (`faststart`)**: Rewrites `moov` and shifts all `stco` / `co64` chunk offsets after `moov` by the exact `moov` size delta (`moov-at-head-shift-offsets`).
2. **`mdir` and `mdta` dual handler support**: Preserves existing non-conflicting entries, rebases `mdta` numeric key indices when merging multiple `udta` boxes, retains `----` freeform atoms, and updates mixed `mdir` + `mdta` containers in place in their respective formats.
3. **Header timestamp patching (`encodedDate` & `taggedDate`)**: Converts dates to QuickTime/MP4 epoch seconds (since `1904-01-01T00:00:00Z`) and patches `creation_time` and `modification_time` in `mvhd`, `tkhd`, and `mdhd` (both v0 32-bit and v1 64-bit).

---

## 4. Supported Metadata Fields Reference (18 Fields + 5 Aliases)

All **18 standard fields** are supported across **JPEG, PNG, and MP4/MOV**:

| Field | Aliases | Type | Description | JPEG Target (XMP + EXIF) | PNG Target (XMP + iTXt + eXIf) | MP4 / MOV Target (`mdir` / `mdta` / Header) |
|---|---|---|---|---|---|---|
| **`title`** | — | `string` | Title / work name | `dc:title` + `IFD0 0x010E` | `dc:title` + `iTXt["Title"]` + `eXIf 0x010E` | `©nam` / `keys["title"]` |
| **`artist`** | — | `string` | Author / creator / artist | `dc:creator` + `IFD0 0x013B` | `dc:creator` + `iTXt["Author"]` + `eXIf 0x013B` | `©ART` / `keys["artist"]` |
| **`date`** | — | `string \| Date \| number` | Creation date | `xmp:CreateDate` + `IFD0 0x0132` | `xmp:CreateDate` + `iTXt["Creation Time"]` | `©day` / `keys["date"]` + syncs `mvhd/tkhd/mdhd` |
| **`encodedDate`** | `creationTime` | `string \| Date \| number` | **Encoded / digitized date** (`Encoded date` in MediaInfo) | `exif:DateTimeDigitized` + `xmp:CreateDate` + `ExifIFD 0x9004` | `exif:DateTimeDigitized` + `iTXt["Encoded Time"]` + `eXIf 0x9004` | **`mvhd` / `tkhd` / `mdhd` `creation_time`** (v0 32-bit & v1 64-bit) |
| **`taggedDate`** | `modificationTime`, `modifyDate` | `string \| Date \| number` | **Tagged / modification date** (`Tagged date` in MediaInfo) | `xmp:ModifyDate` + `xmp:MetadataDate` + `IFD0 0x0132` | `xmp:ModifyDate` + `xmp:MetadataDate` + `iTXt["Modify Time"]` | **`mvhd` / `tkhd` / `mdhd` `modification_time`** (v0 32-bit & v1 64-bit) |
| **`dateOriginal`** | `captureDate` | `string \| Date \| number` | **Original capture date** | `exif:DateTimeOriginal` + `ExifIFD 0x9003` | `exif:DateTimeOriginal` + `eXIf 0x9003` | `©day` / `keys["com.apple.quicktime.creationdate"]` |
| **`description`** | — | `string` | Detailed description / caption | `dc:description` + `IFD0 0x010E` | `dc:description` + `iTXt["Description"]` + `eXIf 0x010E` | `desc` / `keys["description"]` |
| **`comment`** | — | `string` | User comment / notes | `dc:description` + `ExifIFD 0x9286 (UserComment)` (when empty) | `dc:description` + `iTXt["Comment"]` + `eXIf 0x9286` | `©cmt` / `keys["comment"]` |
| **`url`** | — | `string` | Source URL / link | `dc:source` + appended to `dc:description` | `dc:source` + appended to `iTXt["Description"]` | `©url` / `keys["url"]` + appended to comment |
| **`software`** | — | `string` | Creator tool / software | `xmp:CreatorTool` (leaves `0x0131` camera firmware intact) | `xmp:CreatorTool` + `iTXt["Software"]` | `©too` / `keys["software"]` |
| **`copyright`** | — | `string` | Copyright notice | `dc:rights` + `IFD0 0x8298` | `dc:rights` + `iTXt["Copyright"]` + `eXIf 0x8298` | `cprt` / `keys["copyright"]` |
| **`keywords`** | — | `string[] \| string` | Keywords / subject tags | `dc:subject` (`<rdf:Bag><rdf:li>...`) | `dc:subject` (`<rdf:Bag><rdf:li>...`) | `©key` / `keys["keywords"]` (comma-joined) |
| **`album`** | — | `string` | Album / collection | `xmpDM:album` | `xmpDM:album` + `iTXt["Collection"]` | `©alb` / `keys["album"]` |
| **`genre`** | — | `string` | Genre / category | `xmpDM:genre` | `xmpDM:genre` + `iTXt["Genre"]` | `©gen` / `keys["genre"]` |
| **`make`** | — | `string` | Camera / device manufacturer | `tiff:Make` + `IFD0 0x010F` | `tiff:Make` + `iTXt["Source"]` + `eXIf 0x010F` | `©mak` / `keys["com.apple.quicktime.make"]` |
| **`model`** | — | `string` | Camera / device model | `tiff:Model` + `IFD0 0x0110` | `tiff:Model` + `iTXt["Source"]` + `eXIf 0x0110` | `©mod` / `keys["com.apple.quicktime.model"]` |
| **`gps`** | `location` | `GpsObject \| string` | GPS coordinates (lat, lon, optional alt) | `exif:GPS*` + `GPSIFD (0x0000..0x0006)` | `exif:GPS*` + `iTXt["Location"]` + `eXIf GPSIFD` | `©xyz` / `keys["com.apple.quicktime.location.ISO6709"]` |
| **`rating`** | — | `number` | Star rating (`-1` rejected, `0..5` stars) | `xmp:Rating` + `IFD0 0x4746` | `xmp:Rating` + `iTXt["Rating"]` + `eXIf 0x4746` | `rate` / `keys["com.apple.quicktime.rating.user"]` |

---

## 5. Special Field Formats & Validation Rules

All date, GPS, and rating inputs are validated uniformly by `validateTags()` before dispatching to any format planner.

### 5.1 Date Fields (`date`, `encodedDate`, `taggedDate`, `dateOriginal`)

**Accepted formats**:
1. **ISO-8601 date-time or date-only string**: `'2026-04-02T09:30:00Z'`, `'2026-04-02T17:30:00+08:00'`, `'2026-04-02 09:30:00'`, `'2026-04-02'`
2. **EXIF date string**: `'2026:04:02 09:30:00'` or `'2026:04:02'`
3. **MediaInfo UTC string**: `'UTC 2026-04-02 09:30:00'`
4. **Valid `Date` instance**: `new Date('2026-04-02T09:30:00Z')` (`!Number.isNaN(d.getTime())`)
5. **Non-negative finite number**: Unix epoch milliseconds (`1775122200000`) or seconds (`1775122200`)

**Rejected inputs (`ok: false`, `report.errorCode === 'BAD_OPTION'`)**:
* `new Date(NaN)` or `new Date('invalid')`
* `NaN`, `Infinity`, or negative numbers
* Unparseable strings (`'INVALID_DATE'`, `'not-a-date'`)
* Impossible calendar dates (`'2026-02-30T10:00:00Z'`, non-leap `'2026-02-29'`, month `13`)

### 5.2 GPS Coordinates (`gps` or `location`)

```js
// 1. Short object keys
gps: { lat: 31.2304, lon: 121.4737, alt: 12.5 }

// 2. Full object keys
gps: { latitude: 31.2304, longitude: 121.4737, altitude: 12.5 }

// 3. ISO-6709 string
gps: '+31.2304+121.4737+12.50/'

// 4. Comma-separated string
gps: '31.2304, 121.4737, 12.5'
```

---

## 6. Step-by-Step Usage Tutorials

### 6.1 Installation & Importing Across Environments

```bash
npm install @asinnn/stamp-js
```

```js
// ESM (Browser bundlers, Node.js 18+, Deno, Bun)
import { writeTags, inspect, capabilities, BlobSource, BufferSource, HttpSource } from '@asinnn/stamp-js';
import { NodeFileSource, openFile } from '@asinnn/stamp-js/node';
```

For `<script>` tags or Tampermonkey userscripts:

```html
<script src="https://unpkg.com/@asinnn/stamp-js@0.1.2/dist/stamp.umd.js"></script>
<script>
  const { writeTags, inspect, capabilities } = window.stamp;
</script>
```

---

### 6.2 Browser File / Blob Tagging & Download

```js
import { writeTags } from '@asinnn/stamp-js';

const result = await writeTags(file, {
  title: 'Qinghai Lake Sunset Aerial',
  artist: 'Asinnn',
  date: '2026-08-15T18:20:00Z',
  encodedDate: '2026-08-15T18:20:00Z',
  taggedDate: new Date(),
  dateOriginal: '2026-08-15T17:55:10Z',
  description: '4K HDR time-lapse captured by drone',
  comment: 'Original ungraded archive',
  url: 'https://example.com/videos/qinghai-lake',
  software: 'MyMediaApp/1.0',
  copyright: '© 2026 Asinnn. All rights reserved.',
  keywords: ['Qinghai', 'Aerial', 'Sunset', '4K'],
  album: '2026 Northwest Trip',
  genre: 'Nature',
  make: 'DJI',
  model: 'Mavic 3 Pro',
  gps: { lat: 36.8869, lon: 100.1408, alt: 3205 },
  rating: 5,
});

if (result.ok) {
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tagged_${file.name}`;
  a.click();
  URL.revokeObjectURL(url);
} else {
  console.error(result.report.errorCode, result.report.error);
}
```

---

### 6.3 Writing MP4/MOV Encoded Date & Tagged Date

```js
import { writeTags } from '@asinnn/stamp-js';

// Header-only timestamp update (delta === 0, zero file growth, no offset shift):
const resHeaderOnly = await writeTags(mp4File, {
  encodedDate: '2026-05-01T10:00:00Z', // or alias: creationTime
  taggedDate: '2026-05-02T15:30:00Z',  // or alias: modificationTime / modifyDate
});

if (resHeaderOnly.ok) {
  console.log(resHeaderOnly.report.mp4Dates);
  // { encodedDate: '2026-05-01T10:00:00Z', taggedDate: '2026-05-02T15:30:00Z', boxesPatched: 3 }
}
```

---

### 6.4 Inspecting Media Files & Reading Existing Tags (`inspect()`)

```js
import { inspect } from '@asinnn/stamp-js';

const info = await inspect(file);

console.log(info.format);                 // 'jpeg' | 'png' | 'mp4' | 'avif' | 'heic' | 'riff' | 'ebml' | 'unknown'
console.log(info.safeToWrite);            // true | false
console.log(info.capabilities.supported); // 18 field names (or [] for unsupported formats)
console.log(info.existingTags);           // Normalized existing metadata (title, artist, encodedDate, keywords, etc.)
console.log(info.mp4?.moovSize);          // MP4 moov size in bytes
```

---

### 6.5 Preserving & Merging Existing Metadata (`mergeXmp` & `existingTags`)

* **MP4 / MOV**: Existing `ilst` tags that you do not overwrite are preserved automatically.
* **JPEG / PNG**: By default (`mergeXmp: false`), the XMP packet is rebuilt in full from the supplied `tags` object. To update a subset of fields while keeping all existing XMP fields:

```js
// Option 1: Automatic merge via { mergeXmp: true }
await writeTags(jpegFile, { artist: 'Updated Artist' }, { mergeXmp: true });

// Option 2: Explicit round-trip via inspect().existingTags
const info = await inspect(jpegFile);
if (info.safeToWrite) {
  await writeTags(jpegFile, { ...info.existingTags, artist: 'Updated Artist' });
}
```

---

### 6.6 Node.js Local Files & `>4 GiB` Large Video Streaming (`NodeFileSource`)

Node 22's `fs.openAsBlob()` truncates file sizes `>= 4 GiB` to 32 bits. Use `NodeFileSource` from `@asinnn/stamp-js/node` for reliable 64-bit file sizes (`fstat`) and lazy streaming output:

```js
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeTags } from '@asinnn/stamp-js';
import { NodeFileSource } from '@asinnn/stamp-js/node';

const src = new NodeFileSource('huge-8gb.mp4');

try {
  const result = await writeTags(src, {
    title: '8 GiB Master Archive',
    encodedDate: '2026-10-15T08:00:00Z',
  });
  if (!result.ok) throw new Error(result.report.error);

  await pipeline(
    Readable.fromWeb(result.stream),
    fs.createWriteStream('huge-8gb-tagged.mp4')
  );
} finally {
  src.close();
}
```

---

### 6.7 HTTP Range Remote Video/Image Streaming

```js
import { writeTags } from '@asinnn/stamp-js';

const result = await writeTags('https://cdn.example.com/video.mp4', {
  title: 'Streamed Remote Video',
});

if (result.ok) {
  // result.stream is a standard ReadableStream<Uint8Array>
  await streamToDestination(result.stream);
}
```

---

### 6.8 Custom Data Sources & Plan-Only Mode (`materialize: false`)

Pass `{ materialize: false }` to inspect the exact byte edit plan (`result.parts`) and planning I/O counters (`result.report.planning`) without constructing a `Blob` or `ReadableStream`:

```js
const plan = await writeTags(file, { title: 'Plan Only' }, { materialize: false });
console.log(plan.parts, plan.report.planning);
```

---

### 6.9 Error Handling & Machine-Readable `errorCode` Reference

`writeTags()` and `inspect()` never throw. Refusals return `ok: false` with `report.errorCode`:

| `errorCode` | Meaning |
|---|---|
| `NO_TAGS` | Empty `{}` tags object, empty strings, or unknown-only keys |
| `BAD_OPTION` | Invalid `Date` (`new Date(NaN)`), invalid date string (`'2026-02-30'`), invalid `gps` or `rating`, or bad `metadataFormat` |
| `UNSUPPORTED_FORMAT` | Unsupported container (`AVIF`, `HEIC`, `WebP/RIFF`, `WebM/MKV`, or unknown binary) |
| `UNSUPPORTED_TAG` | Requested field not supported by the target container |
| `FRAGMENTED_MP4` | Fragmented MP4 / CMAF (`moof`/`sidx` present) |
| `MALFORMED_CONTAINER` | Truncated headers, out-of-bounds box sizes, multiple `moov` boxes, or corrupt metadata/offset tables |
| `UNSUPPORTED_LARGESIZE` | 64-bit `largesize` on `moov` or metadata children, or offset `> 2^53` |
| `XMP_TOO_LARGE` | XMP packet exceeds JPEG 64 KiB single-segment limit |
| `MPF_INVALID` | Corrupt or overflowing JPEG `APP2 MPF` motion-photo index |
| `RANGE_UNSUPPORTED` | HTTP server does not support `206 Partial Content` byte ranges |
| `RANGE_MISMATCH` | HTTP server returned a `Content-Range` or body length that does not match the request |
| `SOURCE_UNREACHABLE` | Network/DNS/TLS error opening a URL source |
| `SOURCE_NOT_READY` | `HttpSource` passed before `await src.init()` |
| `UNSUPPORTED_SOURCE` | Unrecognized source argument type |
| `CONVERGENCE` | `stco -> co64` fixed-point loop did not converge within 64 iterations |

---

## 7. Complete API Reference

```ts
type WriteOptions = {
  metadataFormat?: 'auto' | 'mdir' | 'mdta';
  nativeExif?: boolean; // default: true
  mergeXmp?: boolean;   // default: false
  materialize?: boolean; // default: true
  chunkSize?: number;   // default: 4194304 (4 MiB)
  mimeType?: string;
};

writeTags(source, tags, options?): Promise<WriteResult>;
inspect(source): Promise<InspectInfo>;
capabilities(format): { format: string, supported: string[], unsupported: string[] };
sniff(headBytes, mimeType?): string;
```

Full TypeScript declarations are bundled in `src/stamp.d.ts` and `src/node.d.ts`.

---

## 8. Memory Model & Safety Boundaries

* **MP4 memory scales with `moov`, not `mdat`**: Peak extra heap during an MP4 rewrite is `≈ 4.2× moovSize` (e.g., ~16 MB for a 3.82 MB `moov`, regardless of whether `mdat` is 20 MB or 8 GiB). A warning is added to `report.warnings` when `moov > 16 MiB`.
* **JPEG / PNG header scan cap**: The insertion point must lie within the first **8 MiB** of the file.
* **Project 8-byte shift alignment invariant**: When rewriting `moov` (including odd/even `stco → co64` upgrades), `planAlignedMoovGrowth()` pads with a `free` box so `finalDelta % 8 === 0`. (Note: ISO-BMFF does not mandate 8-byte media chunk offset alignment; this is a project-defined invariant.)

---

## 9. Verification & Test Suite

| Suite | Command | Assertion count in v0.1.2 |
|---|---|---:|
| Unit + regression | `npm test` | **498** on Node 18 / **505** on Node 20/22 |
| Malformed / fuzz matrix | `npm run test:fuzz` | **196** (plus 3 skipped pre-malformed inputs) |
| `ffprobe` / `ffmpeg` cross-check | `npm run test:ffprobe` | **79** (normal, repeated, large & boundary MP4/MOV + full decode) |
| Interop (Pillow + XML + `ffprobe` + `exiftool`) | `npm run test:interop` | **31** baseline (+ **13** `exiftool` CLI checks) |
| Independent verification | `npm run test:verify` | **90** baseline / **139** with real media (auto-skips when absent) |
| Real device files | `npm run test:real` | **51** with the 6-file sample (auto-discovers media under `STAMP_TEST_MEDIA`) |

All test runners strictly distinguish `PASS`, `FAIL`, `SKIP` (never counted as passed), and `NOT_RUN`.

---

## License

[MIT](LICENSE) · See also [ARCHITECTURE.md](ARCHITECTURE.md), [CHANGELOG.md](CHANGELOG.md), and [VERIFICATION.md](VERIFICATION.md).
