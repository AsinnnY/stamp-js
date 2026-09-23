/**
 * Node: tag a file of any size — including files >= 4 GiB.
 *
 * Why not fs.openAsBlob? On Node 22 it reports a 32-bit-truncated size for
 * files of 4 GiB and above (4 GiB -> 0, 8 GiB -> 0), which makes the planner
 * read a wrong container. NodeFileSource gets the real 64-bit size from fstat,
 * so large files behave exactly like small ones — and the media payload never
 * enters memory:
 *
 *   node examples/node-large-file.mjs input.mp4 output.mp4
 *
 * Measured: an 8 GiB MP4 is tagged after reading ~66 KB (0.00077% of the file).
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
// From a checkout the imports are relative; in an installed package they are:
//   import { writeTags } from 'stamp-js';
//   import { NodeFileSource } from 'stamp-js/node';
import { writeTags } from '../src/stamp.js';
import { NodeFileSource } from '../src/node.js';

const [, , inputPath, outputPath = 'tagged.mp4'] = process.argv;
if (!inputPath) {
  console.error('usage: node examples/node-large-file.mjs <input> [output]');
  process.exit(2);
}

const src = new NodeFileSource(inputPath);
console.log(`input      ${inputPath}`);
console.log(`size       ${src.size} bytes (${(src.size / 1024 ** 3).toFixed(2)} GiB)`);

try {
  const result = await writeTags(src, {
    title: 'Tagged by stamp-js',
    comment: 'Written without reading the media payload',
    software: 'stamp-js',
  });

  if (!result.ok) {
    console.error(`refused:   ${result.report.error}`);
    process.exit(1);
  }

  console.log(`read       ${result.report.stats.bytesRead} bytes `
    + `(${(result.report.stats.bytesRead / src.size * 100).toFixed(5)}% of the file) `
    + `in ${result.report.stats.readCalls} read(s)`);
  console.log(`strategy   ${result.report.strategy}`);
  console.log(`output     ${result.size} bytes -> ${outputPath}`);

  // NodeFileSource cannot slice locally, so the result is a Web ReadableStream:
  // convert it and pipe straight to disk. The media payload is never held in memory.
  await pipeline(Readable.fromWeb(result.stream), fs.createWriteStream(outputPath));
  console.log('done');
} finally {
  src.close();
}
