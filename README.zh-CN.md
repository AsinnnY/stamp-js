# stamp-js

[![CI](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/stamp-js.svg)](https://www.npmjs.com/package/stamp-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

向 JPEG、PNG、MP4、MOV 写入元数据（XMP / iTunes 标签），**不把媒体数据读入内存**。

[English](README.md) | 简体中文

## 为什么用它

多数浏览器端元数据写入器把整个文件读出、改完再写回 —— 峰值内存约为文件大小的
3–4 倍，500 MB 视频会卡死或崩溃标签页。stamp-js 只读容器头，只改必须改的几个字节，
输出由原文件的**引用切片**组装而成。媒体数据不被复制、不被解析，内存开销与文件大小无关。

准确地说，这是**随机访问式元数据手术 + 引用切片组装 + 流式输出**，而不是
`输入流 → transform → 输出流` 的转换管道：对 `Blob`/`File`，输出就是
`new Blob([原文件切片, 新字节, 原文件切片, …])`；只有无法本地切片的数据源
（HTTP Range、`NodeFileSource`）才会以 `ReadableStream` 形式导出。

| | 读整个文件再写回 | stamp-js |
|---|---|---|
| 读取量（2 GiB MP4） | 2 GiB | 66 KB（0.0031%） |
| 峰值内存（256 MiB 实测） | ~1024 MB | 0.01 MB |
| 编解码器 / 未知盒子 | 必须能解析 | 无关 —— 字节不碰 |
| 失败行为 | 可能损坏文件 | 拒绝并返回原因 |
| 重新封装 / 重新编码 | 是 | 否 |

数据来自 Node 22（稀疏文件 + 真实 `Blob`，`npm test` 实测）。

## 特点

- **内存恒定**：`report.bytesRead` 可读且被断言在 2 / 4 / 8 GiB 文件下仅几十 KB。
- **媒体数据逐字节保留**：写入后对 `mdat` 做哈希、重新解码图片验证。
- **同时写原生 EXIF**：JPEG 写入 IFD0 的 `ImageDescription` / `Artist` / `Copyright` /
  `DateTime`（以及 ExifIFD 的 `UserComment`），PNG 写入等价的 `eXIf` 块；因此即使某些
  构建的 Windows 资源管理器忽略 XMP，"属性 → 详细信息"里的标题与作者也能正常显示。
- **真实文件**：动态照片（MPF）、640 KB 厂商 JPEG 段、微信导出、`moov` 在尾的视频、
  >4 GiB 的 64 位偏移文件，以及把标签放在 `moov/meta`（QuickTime 布局）、
  `moov/udta` 里没有 meta 的 Android/MediaTek 视频。
- **幂等**：同名字段替换而非叠加；二次写入字节完全一致。
- **默认安全**：分片 MP4、损坏文件、结构畸形的元数据树（`udta`/`meta`/`ilst`
  无法完整遍历）、不支持的容器、超大元数据、无法解析的索引一律拒绝并给原因，
  绝不产出半个文件。
- **零依赖**：ESM + UMD，无需打包。浏览器 / Node / Deno / Bun / Web Worker / 油猴。

## 安装

```bash
npm install stamp-js
```

```js
import { writeTags, BlobSource } from 'stamp-js';

const res = await writeTags(new BlobSource(file), {
  title: '标题', artist: '作者', date: '2026-04-02T09:30:00Z',
  comment: '…', url: 'https://…', software: '…', copyright: '…',
  keywords: ['a', 'b'],
});
if (res.ok) download(res.blob);     // Blob/File → blob；URL 源 → stream
else console.warn(res.report.error);
```

浏览器、Node、油猴的入口一致；Node 下 ≥4 GiB 文件见[大文件](#大文件)。

## 大文件

Node 22 的 `fs.openAsBlob()` 对 ≥4 GiB 的文件把 size 截断成 32 位
（4 GiB→0、8 GiB→0），会静默读错容器。改用 Node 源：

```js
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeTags } from 'stamp-js';
import { NodeFileSource } from 'stamp-js/node';

const src = new NodeFileSource('huge.mp4');          // fstat 取真实 64 位大小
const res = await writeTags(src, { title: '大文件' });
if (res.ok) await pipeline(Readable.fromWeb(res.stream), fs.createWriteStream('out.mp4'));
src.close();                                        // 需在流被排空之后
```

浏览器里 `<input>` / 拖拽得到的 `File` 大小准确，无需特殊处理。实测：8 GiB MP4
读取 66 KB（0.00077%）即可完成写入。

## API

```ts
writeTags(source: Blob | File | Uint8Array | ArrayBuffer | string | Source,
          tags: { title?, artist?, date?, comment?, url?, software?, copyright?, keywords?[] },
          options?: { metadataFormat?: 'auto'|'mdir'|'mdta', materialize?: boolean,
                      chunkSize?: number, mimeType?: string })
  → Promise<{ ok: true, blob?: Blob, stream?: ReadableStream, parts, size, report }
  | { ok: false, report }>     // report.error 说明拒绝原因

inspect(source) → Promise<MediaInfo>      // 只探测不写入
```

- `options.nativeExif: false` 可关闭 EXIF IFD0 镜像（XMP 仍会写入）。
- `source` 是 `Blob`/`File`/字节 → `result.blob`；是 URL（需 HTTP Range）→ `result.stream`
  （接 `showSaveFilePicker()` 或 `fs.createWriteStream`）。
- `report` 含 `bytesRead` / `readCalls` / `sliceCalls` / `strategy` / `notes` / `warnings`，
  平移动态照片索引时多 `mpf`，清理过期扩展 XMP 时多 `xmp`。
- 至少需要一个非空标签；空对象会被**拒绝**，而不是静默清空已有元数据。
- 目标容器存不下的字段会被**拒绝**（`ok:false`、`report.errorCode: 'UNSUPPORTED_TAG'`、
  `report.unsupportedTags`），而不是悄悄丢掉。可用 `capabilities(format)` 预先查询，
  `inspect()` 也会以 `capabilities` 返回。

| 字段 | JPEG | PNG | MP4 / MOV |
|---|---|---|---|
| title、artist、date、comment、url、software、copyright | ✅ | ✅ | ✅ |
| keywords | ✅ | ✅ | ❌ 拒绝（MP4 无标准位置） |

导出的底层部件：`capabilities`、`probeMp4`、`planJpeg`、`planPng`、`planMp4`、`parseMpf`、`rebaseMpf`、
`partsToStream`、`Source`、`BlobSource`、`BufferSource`、`HttpSource`
（以及 `stamp-js/node` 的 `NodeFileSource`）。

## 兼容性

| 运行时 | 版本 | 运行时 | 版本 |
|---|---|---|---|
| Node.js | 18+（≥4 GiB 用 `stamp-js/node`） | Chrome / Edge | 67+ |
| Firefox | 68+ | Safari | 15+ |
| Deno / Bun | 当前版本 | Web Worker / Service Worker | ✅ |
| 油猴 | ✅（`dist/stamp.umd.js`） | | |

BigInt / `setBigUint64` 仅在处理含 64 位块偏移的 MP4 时才会用到。
所谓"支持 64 位"指 **64 位块偏移（`co64`）与 64 位 largesize 的 `mdat`**；
`moov` 自身或元数据树内部的盒子使用 largesize 头时一律拒绝，不做改写。

| 容器 | 写入 | 状态 |
|---|---|---|
| JPEG | XMP（APP1）+ EXIF IFD0 | ✅ 替换 XMP、清理扩展 XMP、平移 MPF 偏移，并把 4 个字段镜像进 IFD0 |
| PNG | XMP + iTXt + eXIf | ✅ 替换文本块（`IDAT` 不碰），并把原生字段写进 `eXIf` |
| MP4 / MOV | `moov/udta/meta/ilst`、`moov/meta/ilst` | ✅ `stco`/`co64` 平移、自动升 64 位、合并已有标签 |

**主动拒绝**（均给出原因与可编程的 `report.errorCode`）：分片 MP4/CMAF、损坏或截断文件、
结构畸形的元数据树、MP4/MOV 的 `keywords`、AVIF/HEIC/WebP/WebM/MKV/MP3/FLAC（未实现）、
超过 64 KB 单段上限的元数据、无法解析的 JPEG MPF 索引、不支持 Range 的 HTTP、
**返回区间与请求不符的 HTTP**、空标签对象、64 位 largesize 头的 `moov`、
元数据树内部使用 64 位 largesize 的盒子。

## 测试

| 套件 | 命令 | 断言数 |
|---|---|---|
| 单元 + 回归 | `npm test` | 323 |
| 畸形 / fuzz 矩阵 | `npm run test:fuzz` | 196 |
| 互操作（exiftool + Pillow） | `npm run test:interop` | 38 |
| 真实素材 | `npm run test:real` | 34 |
| 独立验证 | `npm run test:verify` | 90（CI）+ 47（真实素材） |
| ffprobe 交叉校验 | `npm run test:ffprobe` | 每个真实视频 4 项 |

`npm test` 在 Node 20/22 下为 340 条断言，Node 18 下为 333 条（跳过两个依赖
`fs.openAsBlob` 的稀疏文件用例，该 API 需要 Node 20+；稀疏路径在 Node 18 下仍由
`NodeFileSource` 用例覆盖）。`npm run test:all` 跑前四项。fuzz 矩阵喂入损坏的 JPEG / PNG / MP4，对每个用例
断言同一组不变式：不抛异常、失败必带原因、输出结构自洽、媒体载荷逐字节不变、幂等。

`STAMP_TEST_MEDIA=<dir>` 指定真实素材目录。CI 跑 `npm test`（Node 18/20/22）与
interop job，并在 `dist/` 与 `src/` 不同步时失败。两个 Python 套件在缺少
`exiftool`/Pillow 时**以退出码 2 SKIP**（绝不抛 traceback）——因为它们的期望值
全部由第三方工具重建，缺依赖时不做降级断言。

## 限制

- **JPEG/PNG 的插入点必须位于前 8 MiB 内**：头部扫描从 64 KB 起步、上限 8 MiB；
  插入点更靠后的文件会被拒绝。只有用数 MB 厂商段填充的文件才会碰到这个边界
  （例如 9 个 65 KB 私有段的 JPEG 只读约 1.3 MB，正常）。
- **JPEG 只把 4 个字段镜像进 EXIF IFD0**（`0x010E` ImageDescription、
  `0x013B` Artist、`0x8298` Copyright、`0x0132` DateTime）。刻意不动的有：
  `0x0131` Software 保留**相机固件串**（本库的 `software` 语义是"写入工具"，
  对应 XMP 的 `CreatorTool`）；ExifIFD 的 `DateTimeOriginal` 保留**真实拍摄时间**
  （Explorer 的"拍摄日期"读的正是它）；`comment`/`url`/`keywords` 仍只走 XMP。
  EXIF 块中的其它内容 —— GPS、ExifIFD、IFD1/缩略图、厂商 MakerNotes ——
  **逐字节保留**：IFD0 在 TIFF 块末尾重建，只改 TIFF 头的 IFD0 指针，其余偏移一律不动。
- **MP4 的内存取决于 `moov`，与媒体大小无关**：峰值约为 `moov` 的 4.2 倍（实测）。
  普通文件无影响；超长录像可能出现 16 MB 以上的 `moov`，此时 `report.warnings`
  会给出预警，也可先用 `inspect().mp4.moovSize` 预判。
- 超过 64 KB 单段上限的 XMP 会被拒绝（写出扩展 XMP 在路线图上；读取/合并已支持）。
- 不更新 C2PA / JUMBF 内容凭证 —— 写入后凭证会显示为已修改（任何元数据编辑器都如此）。
- MP4 跳过空标签值，JPEG 会写成空字段。
- `NodeFileSource` 必须在返回的 `ReadableStream` 被完整消费之后才能 `close()`：
  流是惰性读取文件句柄的，提前关闭会导致消费失败。

## 许可证

MIT。另见 [ARCHITECTURE.md](ARCHITECTURE.md)、[CHANGELOG.md](CHANGELOG.md)、
[CONTRIBUTING.md](CONTRIBUTING.md)。
