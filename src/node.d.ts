import { Source } from "./stamp.js";

export interface NodeFileSourceOptions {
  type?: string;
}

export class NodeFileSource extends Source {
  path: string;
  fd: number | null;
  rangeSupported: boolean;
  constructor(path: string, options?: NodeFileSourceOptions);
  read(start: number, end: number): Promise<Uint8Array>;
  canSlice(): boolean;
  close(): void;
}

export function openFile(path: string, options?: NodeFileSourceOptions): NodeFileSource;

declare const _default: {
  NodeFileSource: typeof NodeFileSource;
  openFile: typeof openFile;
};
export default _default;
