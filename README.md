# stamp-js

[![CI](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@asinnn/stamp-js.svg)](https://www.npmjs.com/package/@asinnn/stamp-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Stop loading the ffmpeg.wasm core (62 MB unpacked) just to change a video's title.**

stamp-js writes XMP, native EXIF (JPEG IFD0, PNG `eXIf`) and iTunes-style tags
into JPEG, PNG, MP4 and MOV at the box/chunk level — no re-encode, no re-mux,
and the media payload never enters the JavaScript heap. It reads the container
header, plans the edits, and returns a `Blob` / `ReadableStream` assembled from
**reference slices** of the original file.

Measured by `npm test` (Node 22, sparse files):

| | |
|---|---|
| 4 GiB MP4 — metadata surgery | **~4 ms**, after reading **66 KB** (0.0015% of the file) |
| 2 GiB MP4 — Blob assembled by reference | **26 ms**, after reading 66 KB |
| 256 MiB file — peak heap, new vs read-everything | **0.01 MB** vs ~1 GB |
| Bundle | ~32 KB gzipped, zero dependencies |

Producing the *output* is a copy of the untouched payload, so it is bounded by
your disk or network speed (13 s for 4 GiB here, ~0.3 GB/s). The point is that
**the metadata work itself never scales with the media size, and the payload is
never parsed** — no codec, no container walk over `mdat`, no re-encode.

To describe the architecture precisely: **random-access metadata surgery +
reference-slice assembly + streaming output**, not a transform-stream pipeline
(`input stream → transform → output stream`). For a `Blob`/`File` the result is
`new Blob([original slice, new bytes, original slice, …])`; only sources that
cannot be sliced locally (HTTP Range, `NodeFileSource`) are piped out as a
`ReadableStream`.

English | [简体中文](README.zh-CN.md)

## Why

Most browser-side metadata writers read the whole file, modify it, and write it
back — peak memory ≈ 3–4× file size, so a 500 MB video freezes or crashes the
tab. stamp-js reads only the container header, rewrites only the bytes that
must change, and assembles the output from reference slices of the original.

| | Read-everything writers | stamp-js |
|---|---|---|
| Bytes read (2 GiB MP4) | 2 GiB | 66 KB (0.0031%) |
| Peak memory (256 MiB, measured) | ~1024 MB | 0.01 MB |
| Codec / unknown boxes | must parse | irrelevant — bytes untouched |
| Failure mode | may corrupt | refuses, returns the reason |
| Re-mux / re-encode | yes | no |

Measured on Node 22 with sparse files and real `Blob`s (`npm test`).

## Features

- **Flat memory.** `report.bytesRead` is reported and asserted to stay in the
  KB range for 2 / 4 / 8 GiB files.
- **Byte-for-byte media preservation.** `mdat` payloads are hashed and images
  re-decoded after a write.
- **Native EXIF too.** JPEG gets IFD0 `ImageDescription` / `Artist` / `Copyright` /
  `DateTime` (plus `UserComment` in the ExifIFD) and PNG gets the same fields in
  an `eXIf` chunk, so Windows Explorer's *Properties → Details* shows a Title and
  Authors even on builds that ignore XMP.
- **Real-world files.** Motion photos (MPF), 640 KB vendor JPEG segments,
  WeChat exports, `moov`-at-tail videos, >4 GiB files with 64-bit offsets,
  Android/MediaTek movies that keep tags in `moov/meta` (QuickTime layout) next
  to a tag-less `moov/udta`.
- **Idempotent.** Same-name fields are replaced, not duplicated; a second write
  is byte-identical.
- **Safe by default.** Fragmented MP4, corrupt files, malformed metadata trees,
  unsupported containers, oversized metadata and unparseable indexes are
  refused with a reason — never a half-written file.
- **Zero dependencies.** ESM + UMD, no bundler. Browsers, Node, Deno, Bun,
  Web Workers, Tampermonkey.

## Install

```bash
npm install @asinnn/stamp-js
```

```js
import { writeTags, BlobSource } from '@asinnn/stamp-js';

const res = await writeTags(new BlobSource(file), {
  title: 'Title', artist: 'Artist', date: '2026-04-02T09:30:00Z',
  comment: '…', url: 'https://…', software: '…', copyright: '…',
  keywords: ['a', 'b'],
});
if (res.ok) download(res.blob);     // Blob / File → blob; URL source → stream
else console.warn(res.report.error);
```

Browser, Node, and Tampermonkey entry points are identical; for ≥4 GiB files
in Node see [Large files](#large-files).

## Large files

Node 22's `fs.openAsBlob()` reports a 32-bit-truncated size for files ≥ 4 GiB
(4 GiB → 0, 8 GiB → 0), which silently mis-reads the container. Use the Node
source instead:

```js
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeTags } from '@asinnn/stamp-js';
import { NodeFileSource } from '@asinnn/stamp-js/node';

const src = new NodeFileSource('huge.mp4');          // true 64-bit size via fstat
const res = await writeTags(src, { title: 'Big file' });
if (res.ok) await pipeline(Readable.fromWeb(res.stream), fs.createWriteStream('out.mp4'));
src.close();                                        // only after the stream is drained
```

In browsers, `File` from `<input>` / drag-and-drop reports the correct size — no
special handling needed. Measured: an 8 GiB MP4 is tagged after reading 66 KB
(0.00077%).

## API

```ts
writeTags(source: Blob | File | Uint8Array | ArrayBuffer | string | Source,
          tags: { title?, artist?, date?, comment?, url?, software?, copyright?, keywords?[] },
          options?: { metadataFormat?: 'auto'|'mdir'|'mdta', materialize?: boolean,
                      chunkSize?: number, mimeType?: string })
  → Promise<{ ok: true, blob?: Blob, stream?: ReadableStream, parts, size, report }
  | { ok: false, report }>     // report.error explains the refusal

inspect(source) → Promise<MediaInfo>      // probe without writing
```

- `options.nativeExif: false` skips the EXIF IFD0 mirror (XMP still written).
- `source` is a `Blob`/`File`/bytes → `result.blob`; a URL (needs HTTP Range)
  → `result.stream` (pipe to `showSaveFilePicker()` or `fs.createWriteStream`).
- `report` carries `bytesRead` / `readCalls` / `sliceCalls` / `strategy` /
  `notes` / `warnings`, plus `mpf` when a motion-photo index was rebased and
  `xmp` when stale Extended XMP fragments were dropped.
- At least one non-empty tag is required; an empty object is **refused** rather
  than silently wiping existing metadata.
- A field the target container cannot store is **refused** (`ok:false`,
  `report.errorCode: 'UNSUPPORTED_TAG'`, `report.unsupportedTags`) instead of
  being dropped quietly. `capabilities(format)` reports the matrix up front, and
  `inspect()` returns it as `capabilities`.

| Field | JPEG | PNG | MP4 / MOV |
|---|---|---|---|
| title, artist, date, comment, url, software, copyright | ✅ | ✅ | ✅ |
| keywords | ✅ | ✅ | ❌ refused (no standard MP4 tag) |

Exported building blocks: `capabilities`, `probeMp4`, `planJpeg`, `planPng`,
`planMp4`, `parseMpf`, `rebaseMpf`, `partsToStream`, `Source`, `BlobSource`,
`BufferSource`, `HttpSource` (and `NodeFileSource` from `stamp-js/node`).

## Compatibility

| Runtime | Version | Runtime | Version |
|---|---|---|---|
| Node.js | 18+ (≥4 GiB → `stamp-js/node`) | Chrome / Edge | 67+ |
| Firefox | 68+ | Safari | 15+ |
| Deno / Bun | current | Web Workers / Service Workers | ✅ |
| Tampermonkey | ✅ (`dist/stamp.umd.js`) | | |

BigInt / `setBigUint64` are exercised only for MP4s with 64-bit chunk offsets.
"64-bit support" means **64-bit chunk offsets (`co64`) and a 64-bit largesize
`mdat`** — a `moov`, or a box inside the metadata tree, that uses a largesize
header is refused rather than rewritten.

| Container | Writes | Status |
|---|---|---|
| JPEG | XMP (APP1) + EXIF IFD0 | ✅ replaces XMP, drops Extended XMP, rebases MPF offsets, mirrors 4 fields into IFD0 |
| PNG | XMP + iTXt + eXIf | ✅ replaces text chunks (`IDAT` untouched), mirrors the native fields into `eXIf` |
| MP4 / MOV | `moov/udta/meta/ilst`, `moov/meta/ilst` | ✅ `stco`/`co64` rebasing, auto 64-bit upgrade, tag merge |

**Refused** (always with a reason, and a machine-readable `report.errorCode`):
fragmented MP4/CMAF, corrupt or truncated files, malformed metadata trees (a
udta/meta/ilst that cannot be fully traversed), `keywords` for MP4/MOV,
AVIF/HEIC/WebP/WebM/MKV/MP3/FLAC (not implemented), metadata >64 KB
single-segment limit, unparseable JPEG MPF index, HTTP without Range,
HTTP answers that do not match the requested range, empty tag object,
`moov` with a 64-bit largesize header, 64-bit largesize boxes *inside* the
metadata tree.

## Testing

| Suite | Command | Assertions |
|---|---|---|
| Unit + regression | `npm test` | 323 |
| Malformed / fuzz matrix | `npm run test:fuzz` | 196 |
| Interop (exiftool + Pillow) | `npm run test:interop` | 38 |
| Real device files | `npm run test:real` | 34 |
| Independent verification | `npm run test:verify` | 90 (CI) + 47 real-media |
| ffprobe cross-check | `npm run test:ffprobe` | 4 per real video |

`npm test` reports 340 assertions on Node 20/22 and 333 on Node 18, which skips
the two `fs.openAsBlob`-backed sparse-file cases (that API is Node 20+); the
sparse path is still covered there through `NodeFileSource`.
`npm run test:all` runs the first four. The fuzz matrix feeds corrupt JPEG / PNG
/ MP4 inputs and asserts the same invariants for every one of them: no throw,
refuse-with-a-reason on failure, structurally valid output, byte-identical media
payload, idempotency.

`STAMP_TEST_MEDIA=<dir>` relocates the real-material suites. CI runs `npm test`
(Node 18/20/22) and the interop job, and fails if `dist/` is stale vs `src/`.
The two Python suites **skip with exit code 2** (never a traceback) when
`exiftool`/Pillow are missing, because every assertion there is built from a
third-party tool rather than from the library's own expectations.

## Limitations

- **JPEG/PNG insertion point must live in the first 8 MiB.** The header scan is
  capped there (it starts at 64 KB and grows up to 8 MiB); a JPEG/PNG whose
  insert point sits past that is refused. This matters only for files padded
  with megabytes of vendor segments — a file with 9 × 65 KB vendor APP
  segments reads ~1.3 MB and is fine.
- **JPEG mirrors only four fields into EXIF IFD0** (`0x010E` ImageDescription,
  `0x013B` Artist, `0x8298` Copyright, `0x0132` DateTime). Deliberately left
  alone: `0x0131` Software keeps the *camera firmware* string (our `software`
  means "tool that wrote this", which is XMP's `CreatorTool`), the ExifIFD's
  `DateTimeOriginal` keeps the real capture time (it is what Explorer shows as
  "Date taken"), and `comment`/`url`/`keywords` stay XMP-only. Everything else in
  the EXIF block — GPS, ExifIFD, IFD1/thumbnail, MakerNotes — is preserved
  byte-for-byte: the IFD0 is rebuilt at the end of the TIFF block and only the
  TIFF header's IFD0 pointer changes, so no other offset moves.
- **MP4 memory scales with `moov`, not with the media.** A rewrite peaks at
  ≈4.2× the `moov` size (measured) — irrelevant for normal files, but a very
  long recording can reach a 16 MB+ `moov`, which raises a warning in
  `report.warnings`. Pre-check with `inspect().mp4.moovSize`.
- XMP above the 64 KB segment limit is refused (Extended XMP write is on the
  roadmap; reading/merging it is already supported).
- C2PA / JUMBF manifests are not updated — content credentials report as
  modified after tagging (true of any metadata editor).
- MP4 skips empty tag values, JPEG writes them as empty fields.
- `NodeFileSource` must stay open until the returned `ReadableStream` has been
  fully consumed: the stream reads through the file handle lazily, so closing
  early makes consumption fail.

## License

MIT. See [ARCHITECTURE.md](ARCHITECTURE.md), [CHANGELOG.md](CHANGELOG.md),
[CONTRIBUTING.md](CONTRIBUTING.md).
