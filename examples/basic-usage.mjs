/**
 * Basic usage examples for stamp-js.
 *
 * Run with Node 18+:
 *   node examples/basic-usage.mjs
 *
 * The Node examples use `NodeFileSource` (`stamp-js/node`): it takes the file
 * size from `fstat`, so it is correct for files of any size. The shorter
 * `fs.openAsBlob(path)` + `BlobSource` route needs **Node 20+** and reports a
 * 32-bit-truncated size for files >= 4 GiB, so it is only worth using for small
 * files in a browser-like setting.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import { writeTags, inspect, BlobSource, BufferSource, HttpSource, partsToStream } from '../src/stamp.js';
import { NodeFileSource } from '../src/node.js';

/* ------------------------------------------------------------------ *
 * 1) Write tags into a local file (file → stream → disk)
 * ------------------------------------------------------------------ */
export async function writeTagsToFile(filePath, tags, outPath) {
  const src = new NodeFileSource(filePath);
  try {
    const res = await writeTags(src, tags);
    if (!res.ok) {
      console.warn('[stamp] Skipped:', res.report.error);
      return null;
    }
    // Media data is never copied into the heap: the stream reads the original
    // bytes through reference slices while writing.
    await pipeline(Readable.fromWeb(res.stream), fs.createWriteStream(outPath));
    console.log(`[stamp] Wrote ${res.size} bytes (read ${res.report.stats.bytesRead} from source)`);
    return outPath;
  } finally {
    src.close();   // only after the stream has been drained
  }
}

/* ------------------------------------------------------------------ *
 * 2) Inspect before writing: is it safe? what codec?
 * ------------------------------------------------------------------ */
export async function inspectFile(filePath) {
  const src = new NodeFileSource(filePath);
  try {
    const info = await inspect(src);
    console.log('[stamp] Inspect result:', JSON.stringify(info, null, 2));
    return info;
  } finally {
    src.close();
  }
}

/* ------------------------------------------------------------------ *
 * 3) Network source → disk: zero-heap pipeline (Chromium desktop)
 *    Requires server-side Range support.
 * ------------------------------------------------------------------ */
export async function downloadToDiskWithTags(url, saveName, tags) {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    console.warn('[stamp] File System Access API not available in this environment');
    return { ok: false };
  }

  const src = await new HttpSource(url).init();
  const plan = await writeTags(src, tags, { materialize: false });
  if (!plan.ok) return { ok: false, reason: plan.report.error };

  const handle = await window.showSaveFilePicker({
    suggestedName: saveName,
    types: [{ description: 'Media', accept: { 'video/mp4': ['.mp4'], 'image/jpeg': ['.jpg'], 'image/png': ['.png'] } }],
  });
  const writable = await handle.createWritable();
  // Header (rewritten moov) + media data (from network Range stream) piped to disk
  await partsToStream(src, plan.parts, 4 << 20).pipeTo(writable);
  return { ok: true, bytesRead: plan.report.stats.bytesRead };
}

/* ------------------------------------------------------------------ *
 * 4) Graceful fallback: always return the original on failure
 * ------------------------------------------------------------------ */
export async function safeWriteTags(blob, tags) {
  if (!tags || !blob) return blob;
  try {
    const res = await writeTags(new BlobSource(blob), tags);
    if (!res.ok) {
      console.warn('[stamp] Skipped:', res.report.error);
      return blob;  // fragmented MP4 / unrecognized format / corrupt → return original
    }
    return res.blob || blob;
  } catch (e) {
    console.warn('[stamp] Error, returning original:', e);
    return blob;
  }
}

// CLI demo
if (process.argv[1] && process.argv[1].endsWith('basic-usage.mjs')) {
  console.log('This file contains examples. Import the functions or see README.md for usage.');
}
