# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-10-18

### Added
- **MP4/MOV `encodedDate` & `taggedDate` header timestamp writing and reading**:
  updates `creation_time` and `modification_time` (Mac HFS+ epoch, seconds since
  `1904-01-01T00:00:00Z`) across `mvhd`, all `tkhd`, and all `mdhd` boxes (supporting
  both 32-bit v0 and 64-bit v1 boxes), and reads them back in `inspect().mp4` and
  `inspect().existingTags`. Supports zero-growth header-only timestamp updates when
  no `ilst` tags are modified.
- **Unified 18-field metadata matrix across JPEG, PNG, and MP4/MOV**:
  `title`, `artist`, `date`, `encodedDate`, `taggedDate`, `dateOriginal`,
  `description`, `comment`, `url`, `software`, `copyright`, `keywords`, `album`,
  `genre`, `make`, `model`, `gps` (`{ lat, lon, alt }` or ISO-6709 string), and
  `rating` (`-1..5`), plus aliases (`creationTime`, `modificationTime`,
  `modifyDate`, `captureDate`, `location`).
- **`inspect().existingTags` for JPEG, PNG, and MP4/MOV (`parseXmpPacket` + EXIF/iTXt fallback)**:
  `inspect()` now parses and returns existing metadata fields (`title`, `artist`,
  `description`, `comment`, `url`, `copyright`, `keywords`, `date`, `encodedDate`,
  `taggedDate`, `dateOriginal`, `software`, `make`, `model`, `album`, `genre`,
  `rating`, `gps`) from JPEG (XMP `APP1` + native EXIF `IFD0`/`ExifIFD`/`GPSIFD`),
  PNG (XMP `iTXt` + standard `iTXt` text chunks + `eXIf`), and MP4/MOV (`mvhd` + `ilst`).
- **`options.mergeXmp` (`{ mergeXmp: true }`)**: optional automatic XMP field merging
  for JPEG and PNG so callers can update individual fields without manually
  spreading `inspect().existingTags`, while keeping full-packet replacement as the
  default idempotent mode.
- **TypeScript declarations (`src/stamp.d.ts` and `src/node.d.ts`)** included in
  the published npm package alongside updated `exports` map.
- **Regression suite sections L & M (`test/run.mjs`)**: 118 new assertions (total
  486 on Node 18 / 493 on Node 20/22) covering MP4 `encodedDate`/`taggedDate`,
  extended 18-field matrix, `stco -> co64` odd/even entry alignment, strict date
  validation, `inspect()` vs `writeTags()` format consistency, and XMP round-trip/merge.

- **`M5` round-trip idempotency regression suite (`test/run.mjs`)**: 12 new assertions
  proving `description`/`comment` (JPEG & PNG) and `comment`/`url` (MP4 `mdir` &
  `mdta`) do not grow across repeated `inspect()` → `writeTags()` round-trips
  (total **505** on Node 20/22).

### Changed
- **Real-media test suites auto-discover files**: `test/real-file-test.py` and the
  real-material sections of `test/independent-verify.py` now glob the
  `STAMP_TEST_MEDIA` directory (`*.jpg` / `*.jpeg` / `*.mp4` / `*.mov`) instead of
  hardcoding four filenames, so any real media set runs without editing the scripts.
  The Extended-XMP size assertion in `test/independent-verify.py` now accounts for an
  existing EXIF segment in the base file.

### Fixed
- **P1 — MP4 `stco -> co64` upgrade 8-byte alignment invariant (`planAlignedMoovGrowth`)**:
  Previously, `udta` `free` padding was computed from `rawMetaGrowth` alone before
  evaluating `stco -> co64` upgrades (+4 bytes per entry). When an upgraded `stco`
  table had an odd entry count, `co64Growth` added `4 (mod 8)` bytes, breaking the
  project-defined 8-byte shift alignment invariant (`finalDelta % 8 === 0`).
  `planAlignedMoovGrowth()` now jointly solves for `rawMetaGrowth`, `co64Growth`,
  and `free` box padding (`0` or `>= 8` bytes) in a monotonic fixed-point loop so
  `finalDelta` always converges to a multiple of 8 for both odd and even entry
  counts and multi-trak cascades. (Note: ISO-BMFF does not mandate 8-byte chunk
  offset alignment; this maintains the project's own alignment invariant.)
- **P1 — Unified strict date validation before format dispatch (`validateTags` / `parseDateToMs`)**:
  Invalid `Date` objects (`new Date(NaN)`), `NaN`, non-finite numbers, unparseable
  strings (`"INVALID_DATE"`, `"not-a-date"`), and impossible calendar dates
  (e.g. `"2026-02-30T10:00:00Z"`, month `13`) across `date`, `dateOriginal`,
  `encodedDate`, `taggedDate` (and aliases `creationTime`, `modificationTime`,
  `modifyDate`, `captureDate`) are now rejected up front with `ok: false` and
  `report.errorCode: "BAD_OPTION"`, preventing `"INVALID_DATE"` from ever being
  written into JPEG/PNG XMP or MP4 boxes.
- **P1 — `sniff()`, `inspect()`, and `writeTags()` consistency on unsupported & malformed ISO-BMFF inputs**:
  `sniff()` now inspects `ftyp` major and compatible brands to distinguish `avif`
  and `heic` from supported `mp4`/`mov`. `capabilities()` returns
  `supported: []` for unsupported formats. `probeMp4()` enforces the minimum
  16-byte `ftyp` header size. `inspect()` now consistently reports
  `safeToWrite: false`, `capabilities.supported: []`, and matching `errorCode`
  (`UNSUPPORTED_FORMAT` or `MALFORMED_CONTAINER`) for AVIF, HEIC, unknown formats,
  MP4/MOV missing `moov`, and corrupt `ftyp` headers.
- **P2 — Independent verification runners (`test/ffprobe-crosscheck.py`, `test/interop-test.py`, `test/independent-verify.py`)**:
  Updated for Node 18+ compatibility (`fs.readFileSync` + `Blob`), added independent
  `ElementTree` XML/RDF, `Pillow` `Image.Exif()`, `ffprobe`, and `ffmpeg` full-frame
  decode checks covering normal files, repeated writes, large files, and boundary
  `stco -> co64` offset files, and strictly separated `PASS`, `FAIL`, `SKIP` (never
  counted as passed), and `NOT_RUN`.
- **JPEG / PNG round-trip duplication (`inspect()` → `writeTags()`)**: `parseXmpPacket()`
  mapped `dc:description` to **both** `description` and `comment`, while
  `buildXmpPacket()` re-joins `[description, comment, url]` into `dc:description`.
  Every round-trip through `inspect().existingTags` (or `{ mergeXmp: true }`)
  therefore doubled the text without bound. `parseXmpPacket()` now maps
  `dc:description` to `description` only; `comment` is sourced from the native EXIF
  UserComment, and a new `reconcileDescriptionComment()` helper strips the trailing
  comment segment so the round-trip is idempotent.
- **MP4 / MOV round-trip URL re-append**: `buildMdirEntries()` / `buildMdtaEntries()`
  join `[comment, 'URL: ' + url]` into the comment atom, but
  `normalizeMp4ExistingTags()` returned it verbatim, so the URL was appended again on
  every round-trip. The URL suffix is now stripped on read-back.

## [0.1.1] - 2026-09-24

### Added
- **PNG `eXIf` chunk.** PNG gets the same native fields as JPEG (`0x010E`,
  `0x013B`, `0x8298`) plus `UserComment`, written into an `eXIf` chunk. The date
  is deliberately *not* duplicated there — PNG already has a canonical
  `Creation Time` text chunk (which this library writes), and validators flag an
  EXIF date in `eXIf` as a non-standard PNG date. A PNG that keeps its EXIF
  outside `eXIf` (ImageMagick's `Raw profile type APP1`, or `exif:*` keys) is
  reported in `report.warnings`, because readers that prefer those chunks
  (exiftool does) will keep showing the old values.
- **`ExifIFD` `UserComment`.** The caller's `comment` fills `UserComment` — but
  only when it is absent or empty. Phone vendors store their processing
  parameters there (`filter: 0; module: portrait; …`), and vivo/MediaTek write
  the value *without* the 8-byte character-code prefix the spec asks for; both
  cases are now detected and the existing data is kept (with a note in
  `report.notes`). Non-ASCII comments are written as `UNICODE\0` + UTF-16LE with
  a BOM, since without the BOM readers guess the byte order and show mojibake.
- **JPEG native EXIF IFD0.** `title` / `artist` / `copyright` / `date` are now
  also mirrored into the native TIFF fields (`0x010E` ImageDescription, `0x013B`
  Artist, `0x8298` Copyright, `0x0132` DateTime), so OS property sheets that
  ignore XMP (some Windows Explorer builds) show a Title and Authors. The IFD0
  is rebuilt *at the end of the TIFF block* and only the TIFF header's IFD0
  pointer is updated, so GPS, the ExifIFD, the IFD1 thumbnail and vendor
  MakerNotes keep their bytes **and** their offsets — the original TIFF stays a
  byte-exact prefix of the new one (asserted by the tests). A file with no EXIF
  gets a minimal spec-shaped APP1; a file whose EXIF cannot be parsed degrades to
  `report.warnings` and still gets its XMP. Deliberately not mirrored: `software`
  (0x0131 is the camera firmware string), ExifIFD `DateTimeOriginal` (the real
  capture time = Explorer's "Date taken"), and `comment`/`url`/`keywords`.
  `options.nativeExif: false` opts out. `exiftool -validate` stays OK, and
  verified against 4 real camera files (GPS + Apple MakerNotes intact).
- **Malformed / fuzz matrix** (`npm run test:fuzz`, 196 assertions). Corrupt
  JPEG / PNG / MP4 inputs are checked against five invariants instead of
  hand-written expectations: no throw, refusal carries a reason + `errorCode`
  and produces no output, the output is structurally valid, the media payload
  is byte-identical, and a second write is byte-identical.
- **`test/ffprobe-crosscheck.py`** (`npm run test:ffprobe`): after tagging, every
  real video must still demux to the same streams, codecs and duration under an
  independent decoder. Skips with exit code 2 when ffprobe is absent.
- **Three-tier CI** (`tier1-gate` / `tier2-verify` / `tier3-release`) replacing
  the previous two jobs; see `CONTRIBUTING.md#ci`.
- **Structured `report` sections** (additive — `notes` / `warnings` / `stats`
  are unchanged): `report.input {size, mime}`,
  `report.changes {metadataBytes, bytesRemoved, netDelta, mediaBytesChanged: false, reencoded: false}`,
  `report.metadata {format, addedTags, preservedTags?, existingContainers?}` and
  `report.offsets {shifted, delta, stcoUpgraded?}`.
- **`capabilities(format)`** — returns `{ format, supported, unsupported }` for
  the tag matrix, and `inspect()` carries it as `capabilities` so a UI can
  disable unsupported fields before the user hits write.
- **`report.errorCode`** on refusals, plus `report.unsupportedTags` for
  `UNSUPPORTED_TAG`: `NO_TAGS`, `UNSUPPORTED_TAG`, `UNSUPPORTED_FORMAT`,
  `MALFORMED_CONTAINER`, `UNSUPPORTED_LARGESIZE`, `BAD_OPTION`, `CONVERGENCE`,
  `RANGE_UNSUPPORTED`, `RANGE_MISMATCH`. Callers can branch on a code instead of
  matching error strings.
- `inspect().mp4` now also reports `metadataFormat` (`mdir`/`mdta`/`mixed`) and
  `metadataContainers`, and `NodeFileSource` lifecycle is documented in both
  READMEs.
- **Large-`moov` memory warning.** An MP4 rewrite holds the original `moov`, the
  rebuilt `moov` and the box tables at once — measured peak ≈ 4.2× the `moov`
  size, independent of the media size. Above a 16 MB `moov` (≈67 MB of extra
  memory) `report.warnings` now carries an estimate, and
  `inspect().mp4.moovSize` lets callers pre-check very long recordings.
- **`NodeFileSource` (`stamp-js/node`)** — a Node file source that takes the
  file size from `fstat` instead of `Blob.size`. Node 22's `fs.openAsBlob()`
  reports a 32-bit-truncated size for files ≥ 4 GiB (4 GiB → 0, 8 GiB → 0), which
  makes the planners read a wrong container; this entry point makes the
  advertised large-file support real. Output is a `ReadableStream` (see
  `examples/node-large-file.mjs`).
- **Motion photo / multi-picture JPEG support (MPF, CIPA DC-007)**: the
  absolute image lengths and data offsets in `APP2 MPF` are rebased whenever
  the JPEG header length changes, so "live"/"dynamic" photo secondary payloads
  (appended JPEG *or* video) stay reachable after tagging — the JPEG
  counterpart of the MP4 `stco`/`co64` shift. Supports both byte orders and
  both MP header variants, resolves a file-absolute base for non-conforming
  writers, and **refuses** (`ok:false`) when the index cannot be parsed safely
  instead of leaving a dangling pointer.
- `inspect()` now reports `jpeg.multiPicture` (image count, lengths, absolute
  offsets, offset base), `jpeg.existingXmp`, `jpeg.insertionPoint` and
  `jpeg.extendedXmpFragments`, so callers can detect a motion photo or stale
  metadata before writing.
- `inspect().mp4` now reports `safeToWrite: false` plus a `metadataMalformed`
  reason when the existing metadata tree cannot be fully parsed, so callers can
  pre-check the same condition `writeTags()` refuses on.
- `parseMpf()` / `rebaseMpf()` and `XMP_EXT_NS` exported for custom pipelines.
- **Documentation**: README rewritten for first-time readers (problem framing,
  how it works, quick starts per runtime, large-file caveats, compatibility
  matrix, testing) plus a full **Chinese translation** (`README.zh-CN.md`), the
  two cross-linked at the top of each file.
- `test/run.mjs`: sections for MPF (39 assertions), Extended XMP (18) and input
  validation / format clarity (15); large-file section now covers real 4 GiB
  (co64 upgrade) and 8 GiB (existing co64, and moov-at-tail) sparse files.
- `test/independent-verify.py`: independent verification suite built only from
  third-party tools (exiftool, Pillow) and hand-written parsers. Real-material
  sections self-skip when the device files are absent, so it runs in CI;
  `STAMP_TEST_MEDIA=<dir>` enables the full run.
- CI: the independent suite runs in the `interop` job, and a new check fails
  the build when `dist/stamp.umd.js` is stale relative to `src/`.
- `npm run test:real` and `npm run test:verify` scripts.
- **46 regression assertions** (`test/run.mjs`, section "K. Review fixes") that
  pin every fix below: source failures return a report instead of throwing, a
  malformed udta chain is refused, udta siblings survive a merge, the mdat shift
  is a multiple of 8, streamed reads reach `report.stats`, a truncated `stsd`
  reports no codec, and a hand-rolled `{read, size}` source works.

### Fixed
- **`writeTags()` / `inspect()` could throw instead of reporting a failure.**
  The documented "pass a URL string" usage — `writeTags('https://…', tags)`,
  followed by `if (result.ok)`, exactly as the README shows — resolved the source
  *before* entering the `try` block, and opening a URL performs a real request.
  An unreachable host, a DNS/TLS failure or a malformed `Content-Range` therefore
  escaped as a rejected promise, breaking the "never throws, always returns a
  report" contract callers rely on. Source resolution is now inside the guarded
  region, `inspect()` grew an outer `try`, and such failures carry stable codes
  (`SOURCE_UNREACHABLE`, `UNSUPPORTED_SOURCE`, `SOURCE_NOT_READY`) instead of a
  bare `TypeError`. The library's own codes (`RANGE_UNSUPPORTED`,
  `RANGE_MISMATCH`) are passed through unchanged.
- **A `udta` with a malformed child chain was rewritten anyway, dropping bytes.**
  `replaceUdtaMeta()` took `listChildrenEx().children` and discarded the
  `.malformed` flag, while `parseExistingIlst()` located `meta` with `findChild()`
  without checking that the udta tiled its own range. A file with a corrupted
  sibling box after `meta` came back `ok: true` with every byte after the bad box
  silently gone — the exact failure `listChildrenEx()` exists to prevent. Every
  udta that is going to be rewritten is now validated up front and refused with
  `MALFORMED_CONTAINER`, on both the in-place and the merged path.
- **Non-`meta` children of a rewritten `udta` were dropped on the merge path.**
  Vendor boxes and QuickTime `©tag` atoms sitting beside `meta` survived an
  in-place update but vanished when several containers were merged into one
  appended udta. They are now carried over verbatim; `free` is excluded because
  it is pure padding and carrying it would make repeated writes grow the file.
- **The mdat shift was not necessarily 8-byte aligned.** `wrapUdta()` padded the
  *new* udta to a multiple of 8, which guarantees nothing when the udta boxes it
  replaces were not themselves aligned (`Δ = new − Σremoved`), nor when a
  `moov/meta` box is rewritten in place and changes length. Measured on a fixture
  holding a 105-byte old udta, a 31-byte Δ pushed an 8-aligned mdat to offset 466.
  Alignment is now applied once, to the net change of the whole moov.
- **Streamed output was invisible to `report.stats`.** `partsToStream()` read
  through `src.read()`, bypassing the counters, and `writeTags()` snapshotted
  `stats` *before* the lazy stream was consumed — so ~33 KB of streamed reads
  showed up as 0 extra bytes. The stream path now uses `_read()`, and
  `report.stats` is a live view of the source counters. It still reads as a plain
  object; assigning to it pins an explicit snapshot, which is what the Blob and
  error paths do. Because a live view necessarily keeps growing while the output
  stream is consumed (piping to disk reads the whole file), a new
  `report.planning` object carries the same counters **pinned when the plan
  finished**, so the headline "reads only the header + moov" number stays
  measurable after the caller has drained the stream.
- **`inspect()` could report a codec read from a neighbouring box.** `findStsd()`
  read the sample entry at fixed offsets (`+4` format, `+32/+34` dimensions)
  without checking that they fell inside `stsd`. A truncated entry reported
  `codec: "stco"` — the type of the box that followed it — plus a bogus `0×0`
  resolution. Out-of-range reads now yield `null` ("unknown") instead of a guess.
- **A `co64` offset that crossed 2^53 was patched with a rounded value.** `u64()`
  rejects *stored* offsets ≥ 2^53, but adding Δ could cross that line, and
  `BigInt(nv)` would then silently encode the already-imprecise `Number`. It is
  refused with `UNSUPPORTED_LARGESIZE` instead. (Petabyte-scale files only; a
  guard against writing a wrong offset, not a practical limitation.)
- **A `{read, size}` source object was accepted and then failed obscurely.**
  `normalizeSource()` returned it unchanged, so the first planner call died with
  `src._read is not a function`. Such sources are now wrapped with the
  bounds-checked, counted `_read()` the rest of the library uses.
- **A malformed `stco`/`co64` entry count corrupted the neighbouring box.**
  When a chunk-offset table declared more entries than its own box could hold,
  the offset walkers kept reading — and *patching* — the bytes of whatever box
  followed, so unrelated data was silently rewritten (`0xAAAAAAAA` came back as
  `0xAAAAAAF2` in a canary test). `findInconsistentOffsetTable()` now validates
  every table before anything touches it and refuses with
  `MALFORMED_CONTAINER`; the walkers are bounded as well. Found by the new
  malformed/fuzz matrix.
- **A file with more than one `moov` was rewritten anyway.** Only the first
  `moov` would be updated, leaving the others pointing at the old layout. It is
  now refused.
- **The PNG header-scan refusal carried no `errorCode`**, and the 2^53 guard
  reported "box exceeds 2^53 bytes" even when the value was a 64-bit chunk
  offset. Both fixed (`MALFORMED_CONTAINER` / `UNSUPPORTED_LARGESIZE`).
- **MP4 `copyright` was reported as written but silently dropped.** Neither
  `buildMdirEntries()` nor `buildMdtaEntries()` knew the field, so
  `writeTags(mp4, { copyright: 'X' })` returned `ok:true` and stored nothing.
  `copyright` now maps to `cprt` (mdir) or the `copyright` key (mdta) — both
  resolved by exiftool — and `keywords`, which has no standard MP4 home, is
  **refused** with `ok:false`, `report.errorCode: 'UNSUPPORTED_TAG'` and
  `report.unsupportedTags` instead of being dropped. `capabilities(format)`
  exposes the matrix; `inspect()` returns it as `capabilities`.
- **Mixed `mdir`/`mdta` containers were merged into one ilst, corrupting the
  semantics of one side.** An iTunes `moov/udta/meta` (©-atom names) next to an
  Android/iOS `moov/meta` (numeric index into a `keys` table) is a normal
  layout, but the two are not interchangeable: a `©cmt` entry read as an mdta
  index is garbage, and vice versa. With `metadataFormat: 'auto'` each container
  is now rewritten in place in its own format, with its own preserved entries.
  Forcing `'mdir'`/`'mdta'` still converts (and documents what that drops).
- **HTTP range responses were trusted on status alone.** `read()` accepted any
  `206` and fed whatever body came back into the parser — a proxy or buggy
  origin answering with the wrong window would produce a silently misaligned
  rewrite. `Content-Range` must now match the requested `start`-`end - 1`, and a
  short body is refused (`RANGE_MISMATCH`).
- **`HttpSource.init()` leaked the probe response body when the server had no
  Range support** (only the 206 branch cancelled it). The body is now released
  on both paths.
- **`planStcoUpgrade()` silently returned a stale `growth` when it hit its
  64-iteration guard**, which would shift every `stco`/`co64` offset by the
  wrong delta. Non-convergence now refuses (`CONVERGENCE`).
- **64-bit largesize boxes had misleading diagnostics.** A largesize `moov`
  reported "a child box with an invalid size"; a largesize box inside the
  metadata tree reported a generic "malformed". Both are now named as
  largesize, and the `moov` case carries `errorCode: 'UNSUPPORTED_LARGESIZE'`.
- **`test:interop` / `test:verify` crashed with a Python traceback when
  exiftool was absent.** They now print a clear `SKIP: missing …` and exit with
  code 2 (distinct from 0 = pass and 1 = assertion failure), so a green run can
  never be mistaken for "verified without the tool".
- **Android/MediaTek movies (`moov/meta`) were refused, and before that were
  mis-parsed.** A real vivo recording keeps its tags in `moov/meta` — a sibling
  of `moov/udta`, written in the bare QuickTime form (no 4-byte version/flags).
  Three defects met:
  * `findChild()` scanned to the end of the buffer instead of the parent's end,
    so `udta/meta` lookup matched the *sibling* `moov/meta`;
  * `meta` children were only ever read with the ISO (+12) layout, so the
    QuickTime (+8) form produced garbage sizes;
  * `moov/meta` was not recognised as a metadata location at all.
  `findChild()` is now bounded, `metaChildrenEx()` detects both layouts and
  remembers which one applied, and `parseExistingIlst()` treats `moov/meta` as a
  first-class container — updated in place, with its layout preserved. A `udta`
  without a `meta` child (vivo writes an all-zero placeholder there) is now left
  byte-identical instead of being removed; if it holds QuickTime `©xxx` tag atoms
  the write is still refused, because those cannot be merged yet.
- **mdta indices were not rebased when merging multiple `udta` boxes.** An ilst
  entry's numeric index is relative to *its own* udta's `keys` table. Merging
  several tables renumbers them, but preserved entries kept their raw index, so
  a tag from a second udta silently read back as whichever key now occupied the
  slot (e.g. `artist` → `title`). Preserved entries are now rebased onto the
  merged table; unmodified files are unaffected.
- **A malformed metadata subtree was rewritten instead of refused.** The child
  walk stopped at the first bad box and the rewrite then dropped every box after
  it — while still reporting a successful write. Traversal now reports a chain
  that does not tile its range exactly, and `writeTags()` refuses with a reason
  (`meta subtree … is malformed`, `keys table … is malformed`, `ilst entry index
  N … does not resolve`, …). A well-formed udta with unknown meta children is
  still merged and preserved as before.
- **The `>4 GB sparse file` test was a false positive.** Its fixture wrote a
  >4 GiB `mdat` size into a 32-bit field (which wraps to 299) while Node's
  `fs.openAsBlob` reported a truncated size (499) — the two errors cancelled
  out, so the test passed without exercising any 64-bit behaviour. Large
  fixtures now use the 64-bit largesize header and `co64` where offsets exceed
  32 bits, and read through `NodeFileSource`.
- **Stale Extended XMP fragments are now dropped.** Replacing the standard XMP
  packet used to leave `APP1 http://ns.adobe.com/xmp/extension/` fragments
  orphaned in the file (their `xmpNote:HasExtendedXMP` reference disappears
  with the old packet), so descriptions and keywords the caller believed were
  overwritten could survive — a privacy leak plus wasted bytes.
- `test/real-file-test.py` could never pass and crashed on the WeChat mdta
  file: exiftool group-qualified keys (`XMP-dc:Title`, `ItemList:Title`,
  `Keys:Title`) plus `find_box()` calls that did not skip the parent box
  header. It now also verifies MPF rebasing on the vivo motion photo and skips
  gracefully when the device files are absent.

### Changed
- **An empty tag object is refused** (`ok:false`, "no writable tags supplied")
  instead of silently replacing existing metadata with an empty XMP packet.
  Passing only unknown fields, only empty strings, or an empty `keywords` array
  is treated the same way.
- **Refusal messages name the container**: AVIF/HEIC (detected via the `ftyp`
  brand, which previously fell through as "moov box not found"), WebP/RIFF and
  WebM/MKV now explain what was detected and why it is not supported yet.
- **Documented limits made explicit**: README (both languages) now states that
  JPEG writes XMP only — native EXIF/IFD0 fields such as `ImageDescription` and
  `Artist` are not populated, so readers that ignore XMP show no title — and
  spells out the `moov`-proportional memory model with the measured 4.2× factor.

## [0.1.0] - 2025-01-15

### Added
- JPEG XMP APP1 segment writing (insert before first SOF/DQT/SOS marker)
- PNG iTXt chunk writing (insert before IDAT, with XMP + text chunks)
- MP4/MOV `moov/udta/meta/ilst` writing (mdir and mdta styles)
- stco/co64 offset patching for faststart MP4 (moov-at-head layout)
- 64-bit largesize box support
- Fragmented MP4 (fMP4/CMAF) detection and refusal
- `inspect()` API: format, codec, resolution, duration, bitrate, safety
- `HttpSource` with HTTP Range support
- `ReadableStream` output for non-sliceable sources
- Idempotent writes (same-name fields replaced, not duplicated)
- Existing tag merging (non-conflicting entries preserved)
- 8-byte alignment via `free` box padding in udta
- Automatic **stco -> co64 upgrade** when chunk offsets would overflow
  32 bits — enables metadata writes to faststart MP4 files larger than 4 GB
  (previously refused outright). Uses fixed-point iteration because the
  upgrade itself enlarges moov, which changes the shift delta, which can
  push further entries past the 32-bit ceiling.
- 118 test assertions (86 core + 32 regression)

### Fixed (from external review)
- **PNG**: Large IDAT chunks no longer force reading the chunk body into
  memory. The insertion point is determined from the chunk header alone.
- **HttpSource**: When the server does not support Range requests (returns
  200 instead of 206), `read()` now refuses instead of loading the entire
  response body into memory.
- **MP4**: Multiple `udta` boxes are now safely merged — all ilst entries
  from every udta are preserved, and unknown meta children are retained.
  Previously, only the first udta was parsed while all were deleted.
- **JPEG**: Multiple existing XMP segments are now all removed (was: only
  the last one). Uses an array like the PNG path already did.
- **chunkSize**: `partsToStream()` now validates that chunkSize is a
  positive integer, preventing infinite empty-chunk loops.
- **metadataFormat**: Invalid values (e.g. `'wat'`) are now rejected with
  `ok:false` instead of silently falling back to mdir.
- **mdir/mdta conversion**: Forcing a format now discards legacy entries
  from the other format, preventing mixed ilst structures.
- **report.stats**: Statistics are now captured after Blob assembly, so
  `sliceCalls` reflects the actual assembly phase.
- **MP4 mdta freeform entries**: `----` freeform entries (e.g.
  `com.apple.quicktime.location.ISO6709`) in mdta-style files are now
  preserved. Previously they were discarded because they lack a key index.
  Only genuine mdir-style atoms (`©xxx`) are dropped when converting
  mdir → mdta.
- **MP4 stco overflow**: faststart files whose shifted chunk offsets exceed
  32 bits are now upgraded to `co64` instead of being refused. Only the
  overflowing stco boxes are upgraded; mixed layouts (some traks 32-bit,
  some 64-bit) are handled correctly.
