export interface GpsCoordinates {
  lat: number;
  lon: number;
  alt?: number;
}

export interface Tags {
  title?: string;
  artist?: string;
  date?: string | Date | number;
  encodedDate?: string | Date | number;
  taggedDate?: string | Date | number;
  dateOriginal?: string | Date | number;
  description?: string;
  comment?: string;
  url?: string;
  software?: string;
  copyright?: string;
  keywords?: string[] | string;
  album?: string;
  genre?: string;
  make?: string;
  model?: string;
  gps?: GpsCoordinates | string;
  rating?: number;
  creationTime?: string | Date | number;
  modificationTime?: string | Date | number;
  modifyDate?: string | Date | number;
  captureDate?: string | Date | number;
  location?: GpsCoordinates | string;
}

export interface WriteOptions {
  metadataFormat?: "auto" | "mdir" | "mdta";
  nativeExif?: boolean;
  mergeXmp?: boolean;
  materialize?: boolean;
  chunkSize?: number;
  mimeType?: string;
  allowUnsafeFragmented?: boolean;
}

export interface SourceStats {
  readCalls: number;
  bytesRead: number;
  maxReadSize: number;
  sliceCalls: number;
}

export class Source {
  size: number;
  type: string;
  stats: SourceStats;
  read(start: number, end: number): Promise<Uint8Array>;
  slice(start: number, end: number): unknown;
  canSlice(): boolean;
  resetStats(): void;
}

export class BlobSource extends Source {
  blob: Blob;
  constructor(blob: Blob);
}

export class BufferSource extends Source {
  bytes: Uint8Array;
  constructor(bytes: Uint8Array | ArrayBuffer, type?: string);
}

export class HttpSource extends Source {
  url: string;
  rangeSupported: boolean;
  constructor(url: string, fetchImpl?: typeof fetch, headers?: Record<string, string>);
  init(): Promise<this>;
}

export type MediaFormat = "jpeg" | "png" | "mp4" | "avif" | "heic" | "riff" | "ebml" | "mp3" | "flac" | "unknown";

export interface CapabilityMatrix {
  format: string;
  supported: string[];
  unsupported: string[];
}

export interface WriteReport {
  format?: string;
  strategy?: string;
  outputSize?: number;
  delta?: number;
  metaFormat?: string;
  noop?: boolean;
  error?: string;
  errorCode?: string;
  unsupportedTags?: string[];
  warnings: string[];
  notes: string[];
  stats: SourceStats;
  planning?: SourceStats;
  input?: { size: number; mime: string };
  changes?: {
    metadataBytes: number;
    bytesRemoved: number;
    netDelta: number;
    mediaBytesChanged: boolean;
    reencoded: boolean;
  };
  metadata?: {
    format: string;
    addedTags: string[];
    preservedTags?: number;
    existingContainers?: string[];
  };
  offsets?: {
    shifted: boolean;
    delta: number;
    stcoUpgraded?: boolean;
  };
  exif?: Record<string, unknown>;
  mpf?: Record<string, unknown>;
  xmp?: Record<string, unknown>;
  mp4Dates?: {
    encodedDate: string | null;
    taggedDate: string | null;
    boxesPatched: number;
  };
  probe?: Record<string, unknown>;
}

export type WritePart =
  | { kind: "ref"; start: number; end: number }
  | { kind: "bytes"; bytes: Uint8Array; what?: string };

export type WriteResult =
  | {
      ok: true;
      blob?: Blob;
      stream?: ReadableStream<Uint8Array>;
      parts: WritePart[];
      size: number;
      report: WriteReport;
    }
  | {
      ok: false;
      report: WriteReport;
    };

export interface InspectInfo {
  format: MediaFormat;
  supported?: boolean;
  safeToWrite: boolean;
  size: number;
  mime: string;
  capabilities: CapabilityMatrix;
  existingTags: Partial<Tags> | null;
  error?: string;
  errorCode?: string;
  jpeg?: {
    existingXmp: number;
    insertionPoint: number;
    extendedXmpFragments: number;
    multiPicture: Record<string, unknown> | null;
  };
  png?: {
    existingXmp: number;
    insertionPoint: number;
  };
  mp4?: {
    fastStart: boolean;
    fragmented: boolean;
    safeToWrite: boolean;
    moovAt?: number;
    moovSize?: number;
    topBoxes: Array<{ type: string; pos: number; size: number }>;
    codec?: string | null;
    resolution?: { width: number; height: number } | null;
    durationSec?: number | null;
    estimatedBitrateKbps?: number | null;
    encodedDate?: string | null;
    taggedDate?: string | null;
    existingTags?: Record<string, string>;
    metadataFormat?: string | null;
    metadataContainers?: string[];
    metadataMalformed?: string | null;
  };
  readStats: SourceStats | null;
}

export type InputSource = Blob | File | Uint8Array | ArrayBuffer | string | Source | { read: (start: number, end: number) => Promise<Uint8Array>; size: number; type?: string };

export const XMP_EXT_NS: string;
export const TAG_FIELDS: readonly string[];

export function capabilities(format: string): CapabilityMatrix;
export function sniff(head: Uint8Array): MediaFormat;
export function normalizeTags(tags?: Tags): Record<string, unknown>;
export function buildXmpPacket(tags: Tags): Uint8Array;
export function parseXmpPacket(xmlBytes: Uint8Array | string): Partial<Tags>;
export function parseMpf(body: Uint8Array, segStart?: number, fileSize?: number): Record<string, unknown>;
export function rebaseMpf(body: Uint8Array, segStart: number, mapPos: (pos: number) => number, fileSize?: number): { body: Uint8Array; images: number };
export function planJpeg(src: Source, tags: Tags, report: WriteReport, opts?: WriteOptions): Promise<Record<string, unknown>>;
export function planPng(src: Source, tags: Tags, report: WriteReport, opts?: WriteOptions): Promise<Record<string, unknown>>;
export function probeMp4(src: Source, seed?: Uint8Array): Promise<Record<string, unknown>>;
export function planMp4(src: Source, tags: Tags, report: WriteReport, opts?: WriteOptions, seed?: Uint8Array): Promise<Record<string, unknown>>;
export function partsToStream(src: Source, parts: WritePart[], chunkSize?: number): ReadableStream<Uint8Array>;
export function inspect(source: InputSource): Promise<InspectInfo>;
export function writeTags(source: InputSource, tags: Tags, options?: WriteOptions): Promise<WriteResult>;
export function u16(b: Uint8Array, o: number): number;
export function u32(b: Uint8Array, o: number): number;
export function u64(b: Uint8Array, o: number): number;
export function fourcc(b: Uint8Array, o: number): string;

declare const _default: {
  writeTags: typeof writeTags;
  inspect: typeof inspect;
  capabilities: typeof capabilities;
  sniff: typeof sniff;
  normalizeTags: typeof normalizeTags;
  buildXmpPacket: typeof buildXmpPacket;
  parseXmpPacket: typeof parseXmpPacket;
  parseMpf: typeof parseMpf;
  rebaseMpf: typeof rebaseMpf;
  planJpeg: typeof planJpeg;
  planPng: typeof planPng;
  planMp4: typeof planMp4;
  probeMp4: typeof probeMp4;
  partsToStream: typeof partsToStream;
  Source: typeof Source;
  BlobSource: typeof BlobSource;
  BufferSource: typeof BufferSource;
  HttpSource: typeof HttpSource;
};
export default _default;
