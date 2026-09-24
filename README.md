# stamp-js

[![CI](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@asinnn/stamp-js.svg)](https://www.npmjs.com/package/@asinnn/stamp-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Zero-dependency · Instant writes · Low memory footprint
Inject metadata into multi-gigabyte media files without loading the media payload.

**stamp-js** is a low-memory metadata writer for **JPEG, PNG, MP4 and MOV**.

It performs container-level metadata surgery without decoding media, without re-encoding, and without reading the media payload into a JavaScript buffer.

**The core idea is simple:** read only the bytes needed to understand and rewrite metadata, then assemble the result from the new bytes plus slices of the original file.

**English | [简体中文](README.zh-CN.md)**

---

## 8 GiB MP4 → about 66 KiB read

That is the number worth remembering.

For a large MP4, stamp-js can locate and rewrite metadata while leaving the actual media payload untouched. In the project's large-file verification, an 8 GiB MP4 was tagged after reading about **66 KiB** of input — roughly **0.00077%** of the file size.

| | Whole-file processing | stamp-js |
|---|---:|---:|
| Input: 8 GiB MP4 | reads the entire media | **~66 KiB read** |
| Media payload | parsed / copied | **untouched** |
| Re-encoding | may be part of the workflow | **never** |
| Re-muxing | common in media pipelines | **not required** |
| Unknown codec bytes | may pass through a media stack | **never parsed** |

> **Important:** “low memory” does not mean constant memory for every possible file. For MP4, memory is primarily determined by the size and complexity of the `moov` metadata structure, not by the size of the `mdat` media payload.

---

## Why is this different?

A conventional browser-side file transformation often looks like this:

```text
Input file
   ↓
read the whole file
   ↓
ArrayBuffer / Uint8Array
   ↓
modify
   ↓
create another large buffer
   ↓
output
```

For a multi-gigabyte video, that can turn a small metadata change into a large memory problem.

stamp-js takes a different path:

```text
                       random-access reads
                              ↓
Input file ───────► container metadata
                              │
                              ▼
                       modify only what
                           must change
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          new metadata                 original slices
                │                           │
                └─────────────┬─────────────┘
                              ▼
                            output
```

The important part is what **does not** happen:

```text
✗ No full-file ArrayBuffer for Blob/File sources
✗ No media decoding
✗ No media payload parsing
✗ No re-encoding
✗ No re-muxing
✗ No silent dropping of unsupported requested tags
```

Technically, this is **random-access metadata surgery + reference-slice assembly + streaming output**. It is not a transform-stream pipeline of the form `input stream → transform every byte → output stream`.

For a local `Blob`/`File`, the output can be represented as:

```js
new Blob([
  original.slice(0, editStart),
  newBytes,
  original.slice(editEnd),
]);
```

Only sources that cannot be sliced locally — such as HTTP Range sources and `NodeFileSource` — are emitted as a `ReadableStream` that reads the original file lazily.

---

## The mechanism: random access + container surgery

The browser already exposes the primitive this design needs:

```js
file.slice(start, end)
```

stamp-js builds a source abstraction around that primitive and asks only for specific ranges.

An MP4/ISO-BMFF file is a hierarchy of boxes:

```text
┌──────────┬──────────┬─────────────────────┐
│ size     │ type     │ payload             │
├──────────┼──────────┼─────────────────────┤
│ 4/8+ B   │ 4 bytes  │ size - header bytes  │
└──────────┴──────────┴─────────────────────┘
```

Conceptually, an MP4 may be arranged as:

```text
[ ftyp ][ moov ][ mdat........................................ ]
```

or:

```text
[ ftyp ][ mdat........................................ ][ moov ]
```

stamp-js does not need to read `mdat` simply because `mdat` may be enormous. It locates the relevant container structures, reads the `moov` when required, rewrites metadata there, patches offsets when layout changes require it, and preserves the media bytes as original slices.

The same principle is used for JPEG and PNG header structures: the library finds the metadata insertion/replacement point without reading image payload data such as JPEG scan data or PNG `IDAT` bodies.

---

## What it writes

| Container | Metadata written | Status |
|---|---|---|
| JPEG | XMP + native EXIF IFD0 | ✅ |
| PNG | XMP + iTXt + native `eXIf` | ✅ |
| MP4 / MOV | iTunes / QuickTime (`mdir`) + `mdta` metadata | ✅ |

### Supported fields

| Field | JPEG | PNG | MP4 / MOV |
|---|---|---|---|
| `title` | ✅ | ✅ | ✅ |
| `artist` | ✅ | ✅ | ✅ |
| `date` | ✅ | ✅ | ✅ |
| `comment` | ✅ | ✅ | ✅ |
| `url` | ✅ | ✅ | ✅ |
| `software` | ✅ | ✅ | ✅ |
| `copyright` | ✅ | ✅ | ✅ |
| `keywords` | ✅ | ✅ | ❌ refused |

`keywords` is deliberately refused for MP4/MOV because this library does not claim a standard MP4 location for that field. A requested field that the target container cannot store is reported as an error instead of being silently discarded.

---

## Native EXIF, not just XMP

For JPEG, XMP alone is not enough for every consumer. Some operating-system property sheets and software prefer native TIFF/EXIF fields.

stamp-js therefore mirrors selected fields into JPEG EXIF IFD0:

```text
ImageDescription  0x010E  ← title
Artist            0x013B  ← artist
Copyright         0x8298  ← copyright
DateTime          0x0132  ← date
```

The EXIF implementation is deliberately conservative. The existing EXIF block is not blindly parsed and serialized back from scratch. The rewritten IFD0 is placed at the end of the TIFF block and the TIFF header's IFD0 pointer is updated, while other regions such as GPS, ExifIFD, IFD1/thumbnail and vendor MakerNotes remain in place.

`UserComment` is only filled when appropriate and is not blindly overwritten, because vendors may store processing information there.

PNG uses the same TIFF machinery inside an `eXIf` chunk. The PNG date is kept in its canonical `Creation Time` text location rather than mirrored into EXIF by default.

You can opt out of native EXIF mirroring with:

```js
{ nativeExif: false }
```

XMP is still written.

---

## MP4 / MOV: metadata surgery, not video processing

The MP4/MOV planner works at the ISO-BMFF box level.

It can handle metadata stored in layouts including:

```text
moov/udta/meta/ilst
moov/meta/ilst
```

It understands both common metadata handler styles:

```text
mdir  → QuickTime / iTunes-style named atoms
mdta  → keys table + indexed entries
```

With `metadataFormat: 'auto'`, each existing metadata container follows its own existing handler format where applicable.

### Existing metadata is merged carefully

Multiple `moov/udta/meta` containers can be merged into one updated metadata container. A `mdir` container and an `mdta` container are **not** blindly merged with each other, because their `ilst` semantics are different.

When no supported metadata container exists, stamp-js creates one.

---

## Offset rebasing and 64-bit offsets

Changing a `moov` located before `mdat` may change the absolute position of media samples.

For example:

```text
before:
[ moov ][ mdat................ ]
        ↑
      sample offsets

            + Δ metadata bytes

after:
[ new moov ][ mdat................ ]
            ↑
      sample offsets moved
```

The MP4 planner therefore rebases absolute chunk offsets in `stco` and `co64` when the fast-start layout requires it.

If a 32-bit `stco` offset would overflow after rebasing, the planner can upgrade that specific table to `co64`.

The upgrade itself changes the size of `moov`, which changes the offset delta again. stamp-js resolves this with a bounded monotonic fixed-point iteration before rebuilding the final `moov`.

This is entirely a metadata-side operation: the `mdat` payload does not need to be opened or rewritten.

### What “64-bit support” means here

The implementation supports:

- 64-bit chunk offsets in `co64`;
- a 64-bit `largesize` `mdat`;
- correct handling of files larger than 4 GiB when the appropriate source reports the true 64-bit size.

For safety, a `moov` itself using a `largesize` header — or a `largesize` box inside the metadata tree — is refused rather than rewritten.

---

## Memory model

The most important promise is **not** “memory is always constant”. The more precise property is:

> **Memory is decoupled from the size of the media payload.**

For MP4, the main in-memory object is `moov`.

The project's measurements show a peak heap delta converging around 4.2× the `moov` size during rewrite because the original `moov`, rebuilt `moov`, and supporting box tables may coexist.

| `moov` | File | Measured peak extra heap |
|---:|---:|---:|
| 0.08 MB | 0.4 MB | 0.62 MB |
| 0.38 MB | 1.9 MB | 2.15 MB |
| 1.53 MB | 7.6 MB | 6.53 MB |
| 3.82 MB | 19 MB | 16.0 MB |

The important observation is that the media payload can be hundreds of megabytes or several gigabytes without becoming the dominant JavaScript allocation.

A warning is emitted above the configured `moov` warning threshold (16 MiB). You can inspect the file first and make an application-level decision before rewriting.

```js
const info = await inspect(file);
console.log(info.mp4?.moovSize);
```

---

## JPEG and PNG read only their headers

### JPEG

The planner scans JPEG markers until the insertion point before the image data. Existing XMP and stale Extended XMP fragments are replaced/removed as part of an idempotent write.

Motion-photo / Multi-Picture Format (MPF) indexes are also handled. If header sizes move, MPF offsets and lengths are rebased through the same position map used for other absolute file references. An unparseable or overflowing MPF index is refused.

The JPEG header scan starts at 64 KiB and can grow up to an 8 MiB cap. A file whose insertion point is beyond that limit is refused rather than forcing a full-file scan.

### PNG

The planner walks chunks from `IHDR` toward `IDAT` / `IEND` and inserts metadata before the image payload.

The `IDAT` body is never read. A chunk header is enough to find the insertion boundary, even when the image data is enormous.

Existing owned XMP/text chunks are replaced without touching the image data.

---

## Safety by refusal

A metadata editor should fail safely when it does not understand the structure it needs to modify.

stamp-js follows this rule:

```text
Can rewrite safely
       ↓
      write

Cannot prove the rewrite is safe
       ↓
     refuse
       ↓
 return a machine-readable reason
```

Examples of refused inputs include:

- fragmented MP4 / CMAF;
- corrupt or truncated containers;
- malformed metadata trees that cannot be fully traversed;
- unsupported containers;
- MP4/MOV `keywords`;
- metadata larger than the supported 64 KiB single-segment limit;
- unparseable JPEG MPF indexes;
- HTTP sources without Range support;
- HTTP responses that do not match the requested byte range;
- empty tag objects;
- `moov` boxes using unsupported `largesize` headers;
- `largesize` boxes inside metadata trees that the planner cannot safely rewrite.

The API returns `ok: false` and keeps the failure reason in `report.error` / `report.errorCode` instead of returning a misleading success value.

Source failures follow the same rule — `writeTags()` and `inspect()` never throw. Passing a URL directly is documented usage, so a URL that cannot be opened (DNS failure, connection refused, TLS error) comes back as `ok: false` with `report.errorCode === 'SOURCE_UNREACHABLE'`; a source of an unrecognized type as `'UNSUPPORTED_SOURCE'`; and an `HttpSource` instance that was never `init()`ed as `'SOURCE_NOT_READY'`, with a message naming the missing call. A server that answers but cannot serve byte ranges keeps `'RANGE_UNSUPPORTED'`.

---

## XMP is replaced wholesale

For JPEG and PNG the XMP packet is **rebuilt in full on every write**, not merged
field by field. Fields you do not pass are written as empty elements, so

```js
await writeTags(jpeg, { artist: 'X' });
```

clears any pre-existing `title`, `description` and `keywords` in the XMP packet.
This keeps writes idempotent and the packet self-consistent, but it means you
must pass every field you want to keep:

```js
await writeTags(jpeg, { title: oldTitle, description: oldDescription, artist: 'X' });
```

An entirely empty tag object is refused rather than treated as "wipe everything".
`inspect()` reports the fields that are currently present, which is the intended
way to read them first if you need to round-trip a file.

(MP4/MOV behaves differently: existing `ilst` entries that you did not ask to
change are preserved, because they live in a keyed table rather than in one
replaced packet.)

---

## Idempotent writes

Writing the same tags repeatedly is designed to be stable:

```text
write(tags)
    ↓
write(tags)
    ↓
no duplicate metadata
no endlessly growing headers
same resulting bytes when the operation is already satisfied
```

Same-name fields are replaced rather than appended as duplicates.

---

## Byte preservation

stamp-js is intentionally conservative about bytes it does not own.

The verification suite checks properties including:

```text
metadata changed        ✅
media payload changed   ❌
unknown boxes changed   ❌ where they are outside the planned edits
output structurally sane ✅
second write            stable / idempotent
```

For MP4, the `mdat` payload is kept as original slices. For images, payload data is not decoded or reconstructed as part of the metadata write.

---

## A small API

### Install

```bash
npm install @asinnn/stamp-js
```

### Browser / Blob / File

```js
import { writeTags, BlobSource } from '@asinnn/stamp-js';

const result = await writeTags(new BlobSource(file), {
  title: 'My Video',
  artist: 'Alice',
  date: '2026-04-02T09:30:00Z',
  comment: 'Recorded on device',
  url: 'https://example.com/item/123',
  software: 'My App',
  copyright: '© 2026 Alice',
});

if (result.ok) {
  // result.blob for Blob/File sources
  download(result.blob);
} else {
  console.warn(result.report.errorCode, result.report.error);
}
```

### Inspect without writing

```js
import { inspect } from '@asinnn/stamp-js';

const info = await inspect(file);

console.log(info.format);
console.log(info.capabilities);
console.log(info.mp4?.moovSize);
```

### HTTP Range source

A URL source requires a server that correctly supports byte ranges.

```js
import { writeTags } from '@asinnn/stamp-js';

const result = await writeTags('https://example.com/video.mp4', {
  title: 'Remote video',
});

if (result.ok) {
  // URL sources are emitted as a ReadableStream.
  await streamToYourWriter(result.stream);
}
```

### Node.js files, including >4 GiB

For very large files in Node, use `NodeFileSource` rather than relying on `fs.openAsBlob()` for size reporting.

```js
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeTags } from '@asinnn/stamp-js';
import { NodeFileSource } from '@asinnn/stamp-js/node';

const src = new NodeFileSource('huge.mp4');

try {
  const result = await writeTags(src, { title: 'Big file' });

  if (!result.ok) {
    throw new Error(result.report.error);
  }

  await pipeline(
    Readable.fromWeb(result.stream),
    fs.createWriteStream('out.mp4'),
  );
} finally {
  // NodeFileSource reads lazily while the output stream is consumed.
  src.close();
}
```

`NodeFileSource` obtains the true file size through `fstat` and serves random-access reads through `fs.read`. It cannot provide local reference slices, so its output is a `ReadableStream`.

---

## API surface

```ts
type Tags = {
  title?: string;
  artist?: string;
  date?: string;
  comment?: string;
  url?: string;
  software?: string;
  copyright?: string;
  keywords?: string[];
};

type WriteOptions = {
  metadataFormat?: 'auto' | 'mdir' | 'mdta';
  nativeExif?: boolean;
  materialize?: boolean;
  chunkSize?: number;
  mimeType?: string;
};

writeTags(
  source: Blob | File | Uint8Array | ArrayBuffer | string | Source,
  tags: Tags,
  options?: WriteOptions,
): Promise<
  | {
      ok: true;
      blob?: Blob;
      stream?: ReadableStream;
      parts: Array<unknown>;
      size: number;
      report: object;
    }
  | {
      ok: false;
      report: object;
    }
>;

inspect(source): Promise<MediaInfo>;
```

### Useful options

`metadataFormat`

Controls the MP4 metadata handler format. `auto` follows the existing layout where applicable; `mdir` and `mdta` explicitly select a format for newly built metadata.

`nativeExif`

Defaults to enabled. Set `false` to skip the native EXIF mirror while continuing to write XMP.

`materialize`

Set `false` when you want the rewrite plan and parts without immediately materializing a Blob or creating an output stream.

`chunkSize`

Controls the chunk size used by `partsToStream()` for stream-based sources.

`mimeType`

Optional output MIME type for Blob materialization.

---

## Reports are measurable

The source layer exposes counters so applications and tests can observe the I/O strategy instead of trusting a marketing claim.

Typical statistics include:

```text
readCalls
bytesRead
maxReadSize
sliceCalls
```

The write report also contains structured information about:

```text
format
strategy
outputSize
edits
input
changes
metadata
offsets
warnings
notes
stats
planning
```

`stats` is a **live view** of the source counters: it reports the reads performed
so far, so it keeps growing if you go on to consume `result.stream` (piping a
stream to disk legitimately reads the whole file). `planning` is the same shape,
pinned at the moment the metadata plan was finished — use it for the "how much
did the metadata surgery cost?" number:

```js
planning.bytesRead     // header + metadata reads; does NOT grow with the output
planning.readCalls
planning.maxReadSize
```

For example:

```js
if (result.ok) {
  console.log({
    bytesRead: result.report.stats?.bytesRead,
    reads: result.report.stats?.readCalls,
    slices: result.report.stats?.sliceCalls,
    strategy: result.report.strategy,
    warnings: result.report.warnings,
  });
}
```

This makes “large-file friendly” behavior measurable in CI and in applications.

---

## Low-level building blocks

The package also exposes the lower-level components used by the main API:

```text
capabilities
probeMp4
planJpeg
planPng
planMp4
parseMpf
rebaseMpf
partsToStream
Source
BlobSource
BufferSource
HttpSource
```

Node adds:

```text
NodeFileSource
openFile
```

This separation is intentional. The high-level API handles common metadata writes, while the planners and source abstractions can also serve applications that need more direct control over container-level editing.

---

## Supported environments

| Runtime | Support |
|---|---|
| Node.js | 18+ |
| Chrome / Edge | 67+ |
| Firefox | 68+ |
| Safari | 15+ |
| Deno / Bun | current versions |
| Web Workers | ✅ |
| Service Workers | ✅ |
| Tampermonkey | ✅ via `dist/stamp.umd.js` |

The package ships ESM and UMD builds and has no runtime dependencies.

---

## What is intentionally not implemented

stamp-js is a metadata/container editor, not a general media-processing framework.

The following are intentionally refused or not implemented in the current release:

```text
AVIF
HEIC
WebP
WebM
MKV
MP3
FLAC
fragmented MP4 / CMAF
MP4 keyword writing
```

XMP writes above the supported 64 KiB single-segment limit are also refused. Extended XMP fragments are recognised and removed — a fragment is stale the moment the standard packet is replaced — but their *content* is not merged into the rebuilt packet, and writing Extended XMP is a future extension.

C2PA / JUMBF manifests are not updated by metadata writes. Applications that depend on content credentials should treat a metadata edit as a credential-affecting operation.

---

## Important limitations

### JPEG / PNG header scan cap

The insertion point must be within the first **8 MiB**. The scan starts small and grows as necessary rather than immediately loading 8 MiB.

### MP4 memory depends on `moov`

Large recordings can have large sample tables and therefore a larger `moov`. The payload size itself is not what drives the rewrite buffer.

Use `inspect().mp4.moovSize` or the warning field before writing when processing long recordings.

### Extended XMP fragments are dropped, not merged

A JPEG whose XMP was split into a standard packet plus Extended XMP fragments
(the >64 KiB layout Adobe writers produce) ends up with neither: the standard
packet is rebuilt from the fields you pass, and every `xmp/extension` fragment is
removed, because the rebuilt packet never declares `xmpNote:HasExtendedXMP` and a
fragment whose GUID is not referenced is stale by definition. Verified against a
file written by exiftool itself (2 fragments): both were removed, no dangling
`HasExtendedXMP` was left behind, and exiftool reads the result. Fields that
existed *only* inside the fragments are not carried over.

### Synthesized EXIF on a file that has none

When a JPEG carries no EXIF at all, stamp-js creates a minimal APP1 block so that
`title` / `artist` / `copyright` still reach OS property sheets. That block
contains only the fields being written, so `exiftool -validate` reports the other
ExifIFD/IFD0 tags it expects in a camera JPEG as missing (`0x9101`
ComponentsConfiguration, `0xa001` ColorSpace, `0xa002`/`0xa003` image
dimensions, `0x0213` YCbCrPositioning — 5 warnings, measured on
`1940534161.jpeg`, which validated clean before the write). A file that already
had EXIF is unaffected: the rewrite is append-only and the same verification run
saw a camera JPEG's 61 pre-existing warnings *drop* to 60.

### Node stream lifetime

`NodeFileSource` performs lazy reads while the output `ReadableStream` is consumed. Do not close the source before the stream is completely drained.

---

## Verification

The package includes several verification layers covering unit behavior, malformed inputs, interoperability and real media.

| Suite | Command | Assertion count in this release (0.1.1) |
|---|---|---:|
| Unit + regression | `npm test` | 387 on Node 20/22 |
| Malformed / fuzz matrix | `npm run test:fuzz` | 196 |
| Interop (`exiftool` + Pillow) | `npm run test:interop` | 38 |
| Real device files | `npm run test:real` | 34 |
| Independent verification | `npm run test:verify` | 90 CI + 47 real-media |
| `ffprobe` cross-check | `npm run test:ffprobe` | 4 per real video |

The malformed-input suite checks invariants such as:

```text
no unexpected throw
failure includes a reason
output remains structurally valid
media payload remains byte-identical
repeat writes are idempotent
```

The real-media coverage includes examples such as motion photos, vendor-heavy JPEGs, WeChat exports, `moov`-at-tail videos, >4 GiB files with 64-bit offsets, and Android/MediaTek-style metadata layouts.

The package's CI also checks that the built `dist/` output is not stale compared with the source.

---

## Architecture

The design is intentionally split into four layers:

```text
             Source
               │
      random-access reads
               ↓
       container probe/parser
               ↓
          rewrite planner
               ↓
      reference-slice output
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed implementation notes, including:

- the `Source` abstraction;
- JPEG MPF rebasing;
- PNG insertion without reading `IDAT`;
- MP4 `moov` handling;
- `stco` / `co64` rebasing;
- fixed-point `stco → co64` upgrades;
- EXIF IFD0 preservation strategy;
- mixed `mdir` / `mdta` handling;
- the MP4 memory model.

---

## Why the project is deliberately small

stamp-js is small because it does **not** try to become a video codec, media decoder, or universal file converter.

Its job is narrower:

```text
Find the bytes that describe the file.
Change only those bytes.
Leave the media alone.
```

That narrow contract is what makes a very large input compatible with a comparatively small JavaScript memory footprint.

---

## License

MIT.

See also [ARCHITECTURE.md](ARCHITECTURE.md), [CHANGELOG.md](CHANGELOG.md), and [RELEASING.md](RELEASING.md).
