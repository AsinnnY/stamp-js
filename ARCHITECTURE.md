# Architecture

This document explains the internal design of stamp-js for contributors and
maintainers.

## Core idea

Writing a few KB of metadata into a media file should not require loading the
entire file into memory. stamp-js achieves this through three mechanisms:

1. **Random-access reads** — only the bytes needed for planning are read.
2. **Box-level surgery** — only the box being modified is rewritten; every
   other byte in the file is preserved as-is.
3. **Reference-slice assembly** — output is a list of slices pointing back to
   the original data, not a single contiguous buffer.

## Source abstraction

```
Source (abstract)
├── read(start, end)    → Uint8Array   (random access, counted in stats)
├── slice(start, end)   → reference    (no copy; Blob/Buffer only)
├── _read(start, end)   → Uint8Array   (wrapper: validates + updates stats)
├── _slice(start, end)  → reference    (wrapper: validates + updates stats)
├── BlobSource          (blob.slice — browser/Node)
├── BufferSource        (subarray — in-memory Uint8Array)
├── HttpSource          (HTTP Range — refuses if server doesn't support Range)
└── NodeFileSource      (src/node.js — fs.read + fstat; see "Large files" below)
```

The `stats` object (`readCalls`, `bytesRead`, `maxReadSize`, `sliceCalls`)
makes memory behavior measurable and testable.

### Large files: why `NodeFileSource` exists

`fs.openAsBlob()` on Node 22 reports a **32-bit-truncated size** for files of
4 GiB and above (4 GiB → 0, 4.5 GiB → 512 MiB, 8 GiB → 0). Since the planners
trust `src.size`, that silently mis-reads the container — the failure mode is a
"successful" write against the wrong view of the file. `NodeFileSource` takes
the size from `fstat` (true 64-bit) and serves reads with `fs.read`, so the
advertised >4 GiB support is real. It cannot slice locally, so its output is a
`ReadableStream`.

A related trap in tests and fixtures: sizes and offsets that exceed 32 bits must
never be written into 32-bit fields. A >4 GiB `mdat` needs the 64-bit
*largesize* header, and `stco` cannot hold offsets ≥ 2^32 (such files are
already `co64`). `test/fixtures.mjs#buildSparseMp4Plan` enforces this instead of
letting values wrap — a wrapped fixture plus a truncated `Blob.size` cancel out
and produce a test that passes while verifying nothing.

## Format planners

Each format has a `planXxx()` function that returns `{ format, edits,
bytesReadFor }`. The `edits` array describes byte ranges to replace or
insert.

### JPEG
- Scans markers from SOI until the first SOF/DQT/DHT/SOS marker.
- **Native EXIF IFD0** — see "EXIF (TIFF IFD0)" below.
- Insertion point is before that marker (APP1 XMP goes in the header).
- All existing XMP APP1 segments are removed (idempotent), and so are stale
  **Extended XMP** fragments (`APP1 xmp/extension`): the new packet never
  declares `xmpNote:HasExtendedXMP`, so every fragment is stale by definition.
  Matching is a plain namespace prefix scan — no XML parser needed.
- **MPF (CIPA DC-007)** — the motion-photo / multi-picture index in `APP2` —
  stores absolute image lengths and data offsets (the JPEG counterpart of MP4's
  `stco`). When the header length changes they are rebased through the same
  position map used for stco (`parseMpf` / `rebaseMpf`). A length is rebased as
  `map(end) - map(start)` so regions that *contain* the edited header stay
  correct. Unparseable indexes are refused, 32-bit overflow is refused.
- Only the file header is read (usually ≤64 KB; vendor deep-data segments can
  reach a few MB, hard cap 8 MiB).

### PNG
- Scans chunks from IHDR until IDAT or IEND.
- Insertion point is before IDAT (iTXt chunks go before image data).
- **IDAT body is never read** — the chunk header alone determines the
  insertion point. This handles arbitrarily large IDAT chunks.
- Existing iTXt/tEXt/zTXt chunks with owned keywords are removed.
- Only the file header is read.

### MP4 / MOV (ISO-BMFF)
- Probes top-level box headers (16 bytes each, with a 64 KB sliding window).
- Reads only `moov` into memory.
- Detects: faststart (moov before mdat), fragmentation (moof/sidx),
  largesize (64-bit boxes), co64 (64-bit offsets).
- **Fragmented MP4 is refused** — offsets in trun/tfhd/saio/sidx would be
  invalidated.
- Updates every metadata container in place: merged `udta/meta` boxes become one
  new `udta` appended at moov end, and a `moov/meta` box is replaced where it is
  (see "udta merging").
- For faststart: patches stco/co64 offsets by the moov size delta.
- Supports both mdir (QuickTime ©nam/©ART) and mdta (keys table + index)
  styles; `metadataFormat: 'auto'` follows the file's existing style.

## Offset patching and stco -> co64 upgrade

When moov grows by Δ bytes (faststart layout), every absolute media offset
in stco/co64 must increase by Δ. The `patchChunkOffsets()` function walks
the moov tree recursively (trak → mdia → minf → stbl), patching only
offsets that fall after moov's end (the threshold). This is O(chunk count)
and operates entirely within the moov buffer — media data is never touched.

### The overflow fixed-point problem

`stco` stores 32-bit offsets. A file whose media data sits near 4 GB can
have an offset that overflows `2^32-1` after adding Δ. The fix is to
upgrade the affected `stco` box to `co64` (64-bit offsets), which adds 4
bytes per entry.

This creates a circular dependency:

```
upgrade stco -> co64  →  moov grows  →  Δ grows  →  more offsets overflow  →  more upgrades
```

Because Δ grows monotonically with the number of upgrades, iterating from
`growth = 0` converges: each pass can only mark *more* boxes for upgrade,
never fewer. `planStcoUpgrade()` performs this iteration (bounded to 64
passes), then `rewriteMoov()` rebuilds the moov once with the final Δ,
upgrading exactly the boxes that overflow and shifting all offsets.
Container sizes are recalculated bottom-up during the rebuild.

Key properties:
- Only overflowing boxes are upgraded — a file with one 32-bit trak and one
  64-bit trak keeps the small trak as `stco`.
- `co64` boxes are always shifted by Δ (never downgraded).
- When no overflow occurs, the cheaper in-place `patchChunkOffsets()` path
  is used instead of a full rebuild.

## moov memory model

Only the header and `moov` are read, so peak memory is decoupled from the media
size — but it is *not* constant: it scales with `moov`.

Measured with `--expose-gc` (peak heap delta during `writeTags`):

| moov | file | peak extra memory | factor |
|---|---|---|---|
| 0.08 MB | 0.4 MB | 0.62 MB | 8.0× |
| 0.38 MB | 1.9 MB | 2.15 MB | 5.6× |
| 1.53 MB | 7.6 MB | 6.53 MB | 4.3× |
| 3.82 MB | 19 MB | 16.0 MB | 4.2× |

The cost is the original `moov` + the rebuilt `moov` + the box tables held at
the same time; the factor converges to ≈4.2× and is independent of the media
size. `moov` grows with the *sample count*, so it is long recordings that push
it: a 3-hour 4K30 video is a few MB, a 10-hour recording 20 MB+.

Above `MOOV_WARN_BYTES` (16 MB, ≈67 MB of extra memory) the planner adds a
`report.warnings` entry so callers can react; `inspect().mp4.moovSize` lets them
decide before writing. Verified: an MP4 with a 16 MB `moov` inside a 240 MB file
is written after reading 16.9 MB (header + `moov`), leaving the media untouched.

## EXIF (TIFF IFD0)

XMP alone is not enough for OS property sheets: some Windows builds read the
native TIFF fields, so an XMP-only JPEG shows an empty Title/Authors there. The
caller's `title` / `artist` / `copyright` / `date` are mirrored into IFD0
(`0x010E`, `0x013B`, `0x8298`, `0x0132`).

The trick that makes this safe without understanding the whole TIFF block:
**every offset inside TIFF is relative to the TIFF header**, so the IFD being
changed can be rebuilt *at the end of the block* and its pointer updated.
Nothing else moves:

```
TIFF header ──► IFD0 (new copy, appended)
                 │ unchanged entries copied verbatim
                 └► ExifIFD / GPS / IFD1 / thumbnail / MakerNotes  ← untouched
     original IFD0 bytes stay in place, now unreferenced
```

Consequences:
- GPS, the ExifIFD, the IFD1 thumbnail and vendor MakerNotes keep both their
  bytes and their offsets — including blocks with undocumented internal offsets
  that a parse-and-reserialize would corrupt.
- The testable invariant is *append-only*: the original TIFF is still a
  byte-exact prefix of the new one, apart from the 4-byte IFD0 pointer.
- Values are only rewritten when they differ, so a second write is a no-op and
  the output stays byte-identical (idempotency).
- A file with no EXIF gets a minimal, spec-shaped `Exif\0\0` APP1 instead.
- Deliberately **not** mirrored: `software` (0x0131 holds the camera firmware),
  the ExifIFD `DateTimeOriginal` (the real capture time, i.e. Explorer's "Date
  taken"), and `comment`/`url`/`keywords` (XMP only).
- Unparseable EXIF degrades to `report.warnings` and the XMP is still written;
  `opts.nativeExif: false` opts out entirely.
- The same machinery serves **PNG**, where the TIFF block lives in an `eXIf`
  chunk (no `Exif\0\0` prefix). The date is skipped for PNG: the format has its
  own canonical place for it (`Creation Time` text chunk) and an EXIF date in
  `eXIf` is flagged by validators. A PNG that keeps EXIF in a text chunk
  (ImageMagick `Raw profile type APP1`, `exif:*`) gets a warning, because
  readers that prefer those chunks will keep showing the old values.
- `UserComment` (ExifIFD `0x9286`) is only *filled in*, never overwritten:
  vendors park processing parameters there, and vivo/MediaTek write it without
  the spec's 8-byte character code. Non-ASCII text uses `UNICODE\0` + UTF-16LE
  **with a BOM** (without it, readers assume big-endian and show mojibake).

## udta merging

Metadata is read from **every** container that holds it and written back to the
same places:

| Location | Written by | Handling |
|---|---|---|
| `moov/udta/meta/ilst` | iTunes, ffmpeg, QuickTime | all such udta boxes are merged into one, appended at moov end |
| `moov/meta/ilst` | Android/MediaTek, ISO 14496-12 | replaced in place, layout preserved |
| one container with `mdir`, another with `mdta` | iOS/macOS QuickTime | each updated **in place, in its own format** (see below) |
| neither | — | a new `moov/udta/meta/ilst` is created |

### Mixed handler types are never merged

A `moov/udta/meta` written as `mdir` (©-atom names) next to a `moov/meta`
written as `mdta` (numeric index into a `keys` table) is the normal iOS/macOS
QuickTime layout, not a malformed file. The two are **not** interchangeable:
under `mdta` an ilst entry named `©cmt` is not a tag but a nonsense index, and
under `mdir` a numeric entry means nothing. Merging them into one ilst would
therefore silently corrupt one side.

With `metadataFormat: 'auto'` each container is rewritten in place using its own
handler and its own preserved entries. Forcing `'mdir'`/`'mdta'` still means
"convert everything to that format", which merges as before (and may drop what
the target format cannot express).

A `udta` box *without* a `meta` child is not a metadata container. It is left
byte-identical (vivo/MediaTek write an all-zero placeholder there), unless it
holds QuickTime `©xxx` tag atoms directly — those cannot be merged yet, so the
write is refused rather than silently dropped.

### `meta` has two layouts

ISO/IEC 14496-12 declares `meta` a FullBox, so its children follow a 4-byte
version/flags field. QuickTime — and Android/MediaTek muxers that follow it —
**omit** that field, shifting every child 4 bytes earlier. Reading the bare form
with the ISO layout lands inside the first child and produces garbage sizes.
`metaChildrenEx()` tries both, preferring the interpretation that tiles the box
exactly and contains the mandatory `hdlr`, and remembers which one applied so the
box can be written back in the same form. This is why `moov/meta` in an Android
movie survives a write unchanged in style.

### Child lookup is bounded

`findChild(bytes, from, type, end)` takes the parent's end offset. Without it the
scan runs to the end of the whole buffer and can match a *sibling* box — reading
`moov/meta` as if it were inside `moov/udta`, which is exactly the shape
Android videos have.

When the file already contains udta/meta/ilst:
- All existing udta boxes are found and parsed.
- ilst entries from every udta are merged.
- Entries with the same name/key as the new tags are replaced (idempotent).
- Non-conflicting entries (e.g. `©gen`) are preserved.
- Unknown meta children are retained to avoid data loss.
- **Numeric (mdta) indices are rebased.** An ilst entry's index is relative to
  *its own* udta's keys table; concatenating several tables renumbers them. A
  preserved entry's index is therefore rewritten to its position in the merged
  table — otherwise an entry taken from a second udta would silently read back
  as a different tag.
- **Anything that cannot be fully traversed is refused.** `listChildrenEx()`
  reports a chain that does not tile its range exactly (a box with `size < 8`,
  a box running past its parent, or leftover bytes). A malformed
  `moov`/`meta`/`ilst`/`keys` subtree, or a numeric index that does not resolve
  in its own keys table, marks the moov unparseable and `writeTags()` refuses
  with the reason. Stopping at the bad box and rewriting anyway would drop
  everything after it while still reporting success — the failure mode this
  check exists to prevent.

`inspect()` surfaces the same check as `mp4.safeToWrite: false` together with an
`mp4.metadataMalformed` reason, so a caller can pre-check before writing.

## mdir ↔ mdta conversion

When `metadataFormat` is forced (not 'auto'):
- Forcing mdta discards mdir-style entries (©nam etc. without key indices).
- Forcing mdir discards mdta-style entries (numeric-index names).
- This prevents mixed ilst structures where entries from both styles
  coexist under a single hdlr.

## Tag capabilities

The public tag object is uniform, the containers are not. `capabilities(format)`
returns `{ format, supported, unsupported }` and `writeTags()` refuses a request
that names a field the container cannot store (`ok:false`,
`report.errorCode === 'UNSUPPORTED_TAG'`, `report.unsupportedTags`). Writing a
subset and reporting success would be worse than failing: the caller cannot tell
a stored tag from a dropped one.

| Field | JPEG / PNG (XMP) | MP4 / MOV |
|---|---|---|
| title, artist, date, comment, url, software, copyright | ✅ | ✅ (`©nam`/`©ART`/`©day`/`©cmt`/`©too`/`cprt`, or the mdta keys `title`/`artist`/`date`/`comment`/`software`/`copyright`) |
| keywords | ✅ `dc:subject` | ❌ refused — no standard MP4 tag; writing it somewhere invented would be a lie |

`copyright` uses `cprt` for `mdir` and the `copyright` key for `mdta`; both are
resolved by exiftool (`ItemList:Copyright` / `Keys:Copyright`). The plausible
looking `©cpy` atom is *not* recognised by any reader and is not used.

## Assembly

`buildParts()` converts edits into a sorted list of reference slices and
byte insertions. This list can be materialized two ways:

- **Blob** (sliceable sources): `new Blob([...slices])` — in runtimes with
  reference-based Blob composition, media data is not copied.
- **ReadableStream** (non-sliceable sources like HttpSource): chunks are
  read on-demand and piped to a WritableStream (e.g. File System Access API).

## Decision matrix

| Condition | Strategy |
|---|---|
| moov at tail (not faststart) | Append udta; zero offset change |
| moov at head (faststart) | Append udta; shift stco/co64 by Δ |
| Shifted offset exceeds 32 bits | Upgrade stco -> co64 (fixed-point iteration) |
| Fragmented (moof/sidx) | **Refuse** (offsets in trun/saio/sidx would break) |
| moov uses 64-bit largesize header | **Refuse** (not yet supported) |
| Multiple udta | Merge all; rebase mdta indices; preserve unknown content | 
| `moov/meta` (Android/MediaTek) | Update in place, keep its QuickTime/ISO layout |
| Mixed mdir + mdta containers | Update each in its own format (never merge) |
| Field the container cannot store (MP4 `keywords`) | **Refuse**, name it in `unsupportedTags` |
| udta without a meta box | Leave byte-identical (refuse if it holds ©tag atoms) |
| Malformed metadata tree | **Refuse** (never rewrite a partly understood tree) |
| mdta freeform (`----`) entries | Preserve (never dropped) |
| JPEG with a parseable MPF index | Rebase MPEntry lengths/offsets |
| JPEG with an unparseable MPF index | **Refuse** (never leave a dangling index) |
| JPEG with Extended XMP fragments | Drop them with the packet they belong to |
| No non-empty tag given ({}, unknown-only) | **Refuse** (would wipe existing metadata) |
| AVIF / HEIC (ISOBMFF ftyp brands) | **Refuse**, naming the detected brand |
| WebP / WebM / MKV / MP3 / FLAC | **Refuse**, naming the container and why |
| HTTP without Range | **Refuse** random access |
| Source reports a size it cannot back up | Nothing to detect — see `NodeFileSource` |

## Testing strategy

### Malformed inputs (`test/malformed.mjs`)

Corrupt containers are not tested against hand-written expectations: every case
asserts the same five invariants — I1 no throw, I2 refusal carries a reason and
`errorCode` and produces no output, I3 the output is structurally valid (when
the input was), I4 the media payload is byte-identical, I5 a second write is
byte-identical. That shape is what catches "reads past the end of a box and
patches the neighbour", which is how the `stco`/`co64` count-overflow bug was
found (`findInconsistentOffsetTable()` now refuses such tables up front).


- **Unit tests** (`test/run.mjs`, 340 assertions): correctness, safety,
  idempotency, memory, MPF rebasing, Extended XMP cleanup and input validation.
  Uses hand-crafted ISO-BMFF/JPEG/PNG fixtures with canary bytes, so sample data
  integrity after offset shifts is verified by reading the data back through the
  *shifted* offsets.
- **Sparse-file memory tests**: 2 GiB (plan-only), and — via `NodeFileSource` —
  real 4 GiB, 8 GiB faststart and 8 GiB moov-at-tail files, asserting that only
  tens of KB are read (≤0.002% of the file). Large fixtures use 64-bit
  largesize `mdat` headers and `co64` when offsets need more than 32 bits, so
  the >4 GiB path is exercised with valid data rather than wrapped values.
- **Independent verification** (`test/independent-verify.py`): every expected
  value is rebuilt with third-party tools (exiftool, Pillow) or hand-written
  parsers instead of the library's own assertions — the check that catches a
  library and its test agreeing on the same mistake.
- **Real device files** (`test/real-file-test.py`): vivo motion photo (MPF),
  Android screenshot, WeChat exports; auto-skips when the files are absent.
- **Regression tests**: every bug fix from external review has a dedicated case
  in section G, and the CI run also fails if `dist/stamp.umd.js` is stale.
