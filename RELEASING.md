# Releasing

Checklist for cutting a release. Everything below is a *guard*: the library's
promise is that it never writes a file it cannot justify, so the release process
should not be able to ship something unverified either.

## 0. Information the maintainer has to supply first

These cannot be derived from the code — fill them in before the first publish:

| Field | Needed for | Example |
|---|---|---|
| GitHub repository | `package.json` `repository` / `bugs` / `homepage`, README badge | `AsinnnY/stamp-js` |
| npm package name | `package.json` `name` | `@asinnn/stamp-js` — the unscoped `stamp-js` is refused by npm as too similar to the existing `stampjs` |
| Author name + email | `package.json` `author`, `LICENSE` copyright line | `Asinnny <…@…>` |
| Whether `README.zh-CN.md` / `VERIFICATION.md` / `test/` ship in the tarball | `package.json` `files` | currently: docs + `src` + `dist` only |
| Release notes source | GitHub release body | the `[Unreleased]` section of `CHANGELOG.md` |

## 1. Pre-flight (automatic)

```bash
npm run build          # regenerate dist/stamp.umd.js from src/
npm test               # unit + regression, incl. sparse 4/8 GiB
npm run test:fuzz      # malformed / fuzz matrix
npm run test:interop   # exiftool + Pillow interop  (exit 2 if a tool is missing)
npm run test:verify    # independent verification   (exit 2 if a tool is missing)
```

`prepublishOnly` runs `build + test + fuzz` automatically, so a broken bundle or
a failed regression cannot be published by accident.

Two things the local run cannot cover:
- `dist/` must be committed and in sync (CI enforces it).
- The Python suites need `exiftool` and Pillow; a missing tool exits **2**, never
  0, so a green run always means "actually verified".

## 2. Real material (Tier 3)

Real device files are not redistributable, so they live outside the repo:

```bash
STAMP_TEST_MEDIA=/path/to/material npm run test:real
STAMP_TEST_MEDIA=/path/to/material npm run test:verify   # +47 assertions
STAMP_TEST_MEDIA=/path/to/material npm run test:ffprobe  # needs ffmpeg
```

Recommended material for a release: vivo motion photo (MPF), an iPhone JPEG with
MakerNotes and EXIF, a WeChat/iOS MP4 (mdta), an Android/MediaTek video
(`moov/meta`), a faststart MP4, and a `moov`-at-tail MP4.

In CI this is the `tier3-release` job; point the `STAMP_TEST_MEDIA` repository
variable at a downloaded artifact directory, or attach the material as a release
artifact.

## 3. Version and tag

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version and
   date it.
2. `npm version <patch|minor|major>` (updates `package.json`, commits, tags).
3. `git push --follow-tags`.

Semantic-versioning notes specific to this library:
- A new **refusal** can be a breaking change for a caller that relied on the old
  behaviour (e.g. `keywords` on MP4 now returns `ok:false`), so it belongs in a
  minor release at least, with a `CHANGELOG` entry under **Changed**.
- The `report` object only ever *gains* fields (`input` / `changes` / `metadata`
  / `offsets` were added without touching `notes` / `warnings` / `stats`).

## 4. Publish

```bash
npm pack --dry-run     # inspect the file list before publishing
npm publish            # add --access public for a scoped package
```

Then create the GitHub release from the `CHANGELOG` entry and (optionally) attach
the tagged sample outputs used for verification.

## 5. Post-publish

- Verify the published tarball installs and works:
  `npm i <name>@<version>` in an empty directory and run the README example.
- Confirm the README's testing table still matches reality
  (`npm test` / `test:fuzz` / `test:verify` counts).
