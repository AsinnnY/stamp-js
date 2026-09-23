/**
 * stamp-js — Node.js file source
 * =============================================================================
 *
 * The core library is runtime-agnostic and depends only on `Blob.slice()`. In
 * Node that normally means `fs.openAsBlob(path)`, which is convenient — but on
 * Node 22 it reports a **32-bit-truncated size** for files of 4 GiB and above
 * (4 GiB → 0, 4.5 GiB → 512 MiB, 8 GiB → 0). A wrong size silently makes the
 * planner mis-read the container, so large-file tagging cannot be trusted
 * through that path.
 *
 * `NodeFileSource` reads the file descriptor's real 64-bit size with
 * `fstat` and serves random-access reads with `read`, so files of any size —
 * including the >4 GiB case the library advertises — are handled correctly.
 * It cannot be sliced locally, so the result is a `ReadableStream` you pipe to
 * disk (see examples/node-large-file.mjs).
 *
 * Quick check on your Node version:
 *
 *   node -e "const fs=require('node:fs');const f='/tmp/probe';const fd=fs.openSync(f,'w');\
 *   fs.ftruncateSync(fd,4*1024**3+1024);fs.closeSync(fd);\
 *   fs.openAsBlob(f).then(b=>console.log(b.size, fs.statSync(f).size));"
 *
 * Import as a separate entry point so the browser/UMD builds never see node:fs:
 *
 *   import { NodeFileSource } from 'stamp-js/node';
 */
import fs from 'node:fs';
import { Source } from './stamp.js';

export class NodeFileSource extends Source {
  /**
   * @param {string} path       file to read
   * @param {object} [options]
   *   type:string    MIME type to report (default '' — content is sniffed)
   */
  constructor(path, { type = '' } = {}) {
    super();
    this.path = path;
    this.fd = fs.openSync(path, 'r');
    this.size = fs.fstatSync(this.fd).size;   // 64-bit, unlike openAsBlob on >= 4 GiB
    this.type = type;
    this.rangeSupported = true;
  }

  async read(start, end) {
    const len = Math.max(0, end - start);
    if (len === 0) return new Uint8Array(0);
    // Allocating per read keeps peak memory at one chunk; callers only ever ask
    // for headers and the moov, never for the media payload.
    const buf = Buffer.allocUnsafe(len);
    let done = 0;
    while (done < len) {
      const n = fs.readSync(this.fd, buf, done, len - done, start + done);
      if (n <= 0) break;
      done += n;
    }
    // Copy out of the pooled Buffer so the result owns its memory.
    return new Uint8Array(buf.subarray(0, done));
  }

  // No local slicing: output is a ReadableStream, pipe it to a WritableStream.
  canSlice() { return false; }

  /** Release the file descriptor. */
  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
  }
}

/** Convenience wrapper: open a file as a source. */
export function openFile(path, options) {
  return new NodeFileSource(path, options);
}

export default { NodeFileSource, openFile };
