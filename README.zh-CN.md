# stamp-js

[![CI](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@asinnn/stamp-js.svg)](https://www.npmjs.com/package/@asinnn/stamp-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 给几十 GB 的媒体写元数据，也不必把媒体数据整体读进内存

**stamp-js** 是一个面向 **JPEG、PNG、MP4、MOV** 的低内存元数据写入库。

它直接在容器结构层进行 metadata surgery：**不解码媒体、不重新编码、不重新封装，也不把媒体 payload 整体读进 JavaScript 内存。**

**核心思路非常简单：**只读取定位和修改元数据所必须的字节，然后用“新元数据 + 原文件切片”组装输出。

**[English](README.md) | 简体中文**

---

## 8 GiB MP4 → 约 66 KiB 读取

这是这个项目最值得记住的数字。

在项目的大文件验证中，一个 **8 GiB MP4** 完成元数据写入时，实际读取量约为 **66 KiB**，约占整个文件的 **0.00077%**。

也就是说：**文件可以很大，但真正需要读取的只是容器结构中的少量数据。**

| | 读完整文件再处理 | stamp-js |
|---|---:|---:|
| 输入：8 GiB MP4 | 读取整个媒体 | **约 66 KiB** |
| 媒体 payload | 可能被读取/复制 | **原样保留** |
| 重新编码 | 媒体工作流中常见 | **不会做** |
| 重新封装 | 常见的媒体处理手段 | **不需要** |
| 编解码器 | 可能需要进入媒体处理链 | **完全不关心** |

> **注意：**“低内存”并不等于“任何文件都恒定只占几 KB”。对于 MP4，内存主要取决于 `moov` 元数据结构的大小与复杂度，而不是 `mdat` 媒体 payload 有多少 GB。

---

## 为什么它和普通 metadata writer 不一样？

很多浏览器端文件处理方案大致是这样：

```text
输入文件
   ↓
把整个文件读出来
   ↓
ArrayBuffer / Uint8Array
   ↓
修改
   ↓
重新创建一个大 Buffer
   ↓
输出
```

对于几个 GB 的视频，一个几 KB 的元数据改动就可能变成一个很大的内存问题。

stamp-js 走的是另一条路线：

```text
                       随机读取
                          ↓
输入文件 ─────────► 容器元数据
                          │
                          ▼
                     只修改必要部分
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
          新元数据                 原文件切片
              │                       │
              └───────────┬───────────┘
                          ▼
                         输出
```

真正重要的是下面这些事情**不会发生**：

```text
✗ Blob/File 不会为了写 metadata 而整体转成大 ArrayBuffer
✗ 不做媒体解码
✗ 不解析媒体 payload
✗ 不重新编码
✗ 不重新封装
✗ 用户要求的字段如果目标容器无法存储，不会静默丢弃
```

从技术上说，它不是 `输入流 → 对每个字节做 transform → 输出流` 的流水线，而是：

> **随机访问式元数据手术 + 引用切片组装 + 流式输出**

对于本地 `Blob` / `File`，输出可以直接表示成：

```js
new Blob([
  original.slice(0, editStart),
  newBytes,
  original.slice(editEnd),
]);
```

只有无法本地切片的数据源，例如 HTTP Range 和 `NodeFileSource`，才会以 `ReadableStream` 形式惰性输出原文件。

---

## 核心机制：随机读取 + 容器级手术

浏览器本身已经提供了关键的底层能力：

```js
file.slice(start, end)
```

stamp-js 在此基础上抽象出统一的 Source，然后只读取真正需要的范围。

MP4 / ISO-BMFF 本质上是一个由 box/atom 构成的层级结构：

```text
┌──────────┬──────────┬─────────────────────┐
│ size     │ type     │ payload             │
├──────────┼──────────┼─────────────────────┤
│ 4/8+ B   │ 4 bytes  │ size - header bytes  │
└──────────┴──────────┴─────────────────────┘
```

MP4 可能是：

```text
[ ftyp ][ moov ][ mdat........................................ ]
```

也可能是：

```text
[ ftyp ][ mdat........................................ ][ moov ]
```

无论 `moov` 位于头部还是尾部，stamp-js 都不需要因为 `mdat` 很大就把 `mdat` 打开。它只需要定位相关容器结构，读取需要修改的 `moov`，完成 metadata 手术，并在必要时修正 offset，最后把媒体数据继续作为原文件切片复用。

JPEG 和 PNG 也遵循相同思想：定位头部中的元数据插入/替换位置，但不读取真正的图像 payload，例如 JPEG 扫描数据和 PNG `IDAT` 数据体。

---

## 能写什么？

| 容器 | 写入内容 | 状态 |
|---|---|---|
| JPEG | XMP + 原生 EXIF IFD0 | ✅ |
| PNG | XMP + iTXt + 原生 `eXIf` | ✅ |
| MP4 / MOV | iTunes / QuickTime（`mdir`）+ `mdta` 元数据 | ✅ |

### 支持字段

| 字段 | JPEG | PNG | MP4 / MOV |
|---|---|---|---|
| `title` | ✅ | ✅ | ✅ |
| `artist` | ✅ | ✅ | ✅ |
| `date` | ✅ | ✅ | ✅ |
| `comment` | ✅ | ✅ | ✅ |
| `url` | ✅ | ✅ | ✅ |
| `software` | ✅ | ✅ | ✅ |
| `copyright` | ✅ | ✅ | ✅ |
| `keywords` | ✅ | ✅ | ❌ 拒绝 |

对于 MP4/MOV，库没有声称 `keywords` 存在一个统一、标准的位置，因此会主动返回拒绝，而不是“调用成功但实际上没写进去”。

---

## 不只是 XMP：原生 EXIF 也会同步

对于 JPEG，只写 XMP 并不能保证所有系统都能正常看到标题、作者等字段。有些操作系统属性页和软件更依赖原生 TIFF/EXIF。

因此 stamp-js 会把部分字段镜像到 JPEG 的 EXIF IFD0：

```text
ImageDescription  0x010E  ← title
Artist            0x013B  ← artist
Copyright         0x8298  ← copyright
DateTime          0x0132  ← date
```

EXIF 这里采用的是比较保守的策略：不是把整个 TIFF/EXIF 区域“解析完再序列化一次”。新的 IFD0 放到 TIFF 块末尾，只更新 TIFF header 中指向 IFD0 的指针，GPS、ExifIFD、IFD1/缩略图、厂商 MakerNotes 等其它区域尽量保持原位置和原字节。

`UserComment` 只在需要时填充，而不是无脑覆盖，因为一些厂商会在这里保存处理参数。

PNG 使用同一套 TIFF IFD 机制，只不过它位于 `eXIf` chunk 中。PNG 的日期则保留在自己的规范位置 `Creation Time`，默认不会再写一份 EXIF 日期。

如果不想镜像原生 EXIF，可以：

```js
{ nativeExif: false }
```

XMP 仍然会正常写入。

---

## MP4 / MOV：处理的是容器，不是视频

MP4/MOV planner 在 ISO-BMFF box 层操作。

它可以处理这样的 metadata 布局：

```text
moov/udta/meta/ilst
moov/meta/ilst
```

同时理解两类常见 metadata handler：

```text
mdir  → QuickTime / iTunes 风格的命名 atom
mdta  → keys 表 + 索引式条目
```

使用 `metadataFormat: 'auto'` 时，会尽可能遵循文件原有的 metadata handler 布局。

### 已有 metadata 会谨慎合并

多个 `moov/udta/meta` 容器可以合并成一个新的 metadata 容器；但 `mdir` 和 `mdta` **不会被强行混成一个 `ilst`**，因为两种 handler 的索引语义并不相同。

如果原文件没有可用的 metadata 容器，stamp-js 会创建新的容器。

---

## Offset 平移与 64 位偏移

当 `moov` 位于 `mdat` 之前时，metadata 变大可能会导致整个媒体区域后移：

```text
修改前：
[ moov ][ mdat................ ]
        ↑
      sample offsets

             + Δ metadata bytes

修改后：
[ new moov ][ mdat................ ]
            ↑
      sample offsets moved
```

所以不能简单地“把几个 metadata 字节塞进去就完事”。MP4 planner 会在需要时处理 `stco` 和 `co64` 中的绝对 chunk offset。

如果某个 32 位 `stco` 在平移之后会溢出，planner 可以把它升级成 `co64`。

这里存在一个有趣的循环：

```text
stco → co64
   ↓
moov 变大
   ↓
offset delta 变大
   ↓
更多 stco 可能溢出
   ↓
更多 stco → co64
```

stamp-js 用有界的单调 fixed-point 迭代解决这个问题，然后再构建最终的 `moov`。

整个过程仍然只在 `moov` 这一侧完成，**不会打开或重写 `mdat` 媒体 payload。**

### 这里所谓的“64 位支持”具体指什么？

当前实现支持：

- `co64` 64 位 chunk offset；
- 64 位 `largesize` 的 `mdat`；
- 文件大于 4 GiB 时，在使用能够正确报告 64 位文件大小的 Source 后进行处理。

为了保证安全，`moov` 自己使用 `largesize` header，或者 metadata 树内部存在无法安全重写的 `largesize` box 时，会主动拒绝，而不是冒险改写。

---

## 内存模型

真正准确的表述不是：

> “内存永远恒定。”

而是：

> **媒体 payload 的大小不会强迫 JavaScript 按比例分配对应大小的内存。**

对 MP4 来说，主要的内存对象是 `moov`。

项目实测中，重写期间的峰值 heap delta 最终大约收敛到 `moov` 的 **4.2 倍**左右，这是因为原始 `moov`、重建后的 `moov` 和 box table 等对象可能在同一时间存在。

| `moov` | 文件 | 实测峰值额外 heap |
|---:|---:|---:|
| 0.08 MB | 0.4 MB | 0.62 MB |
| 0.38 MB | 1.9 MB | 2.15 MB |
| 1.53 MB | 7.6 MB | 6.53 MB |
| 3.82 MB | 19 MB | 16.0 MB |

这里最关键的不是倍率，而是：**媒体 payload 可以从几百 MB 增长到数 GB，而它本身不会成为 JavaScript 的主要内存分配。**

当 `moov` 超过配置的 16 MiB 警告阈值时，库会在 `report.warnings` 中提示。应用还可以先：

```js
const info = await inspect(file);
console.log(info.mp4?.moovSize);
```

在真正写入之前自行决定是否继续。

---

## JPEG / PNG 只读取头部

### JPEG

planner 会扫描 JPEG marker，找到图像数据开始前的插入点。已有 XMP 以及旧的 Extended XMP fragment 会按幂等写入逻辑被替换/清理。

动态照片 / Multi-Picture Format（MPF）同样被考虑：如果 metadata header 长度发生变化，MPF 中记录的 offset 和长度会通过统一的 position map 重新计算。无法解析或者发生 32 位溢出的 MPF 会直接拒绝。

JPEG 头部扫描从 64 KiB 开始，根据需要扩大，硬上限为 8 MiB。插入点超过这个范围时，库会拒绝，而不是为了写一个 metadata 去扫描整个文件。

### PNG

planner 从 `IHDR` 向 `IDAT` / `IEND` 扫描，在图像数据之前插入 metadata。

**`IDAT` 的数据体不会被读取。**只通过 chunk header 就可以确定插入位置，即使 `IDAT` 本身非常巨大也一样。

已有、由库管理的 XMP/text chunks 会被替换，而图像数据本身不动。

---

## 默认策略：不能证明安全，就拒绝

一个底层 metadata writer 最怕的不是“报错”，而是“看起来成功，实际上把文件弄坏了”。

stamp-js 的策略是：

```text
能安全重写
    ↓
   写入

无法证明安全
    ↓
   拒绝
    ↓
返回机器可读的原因
```

例如这些情况会主动拒绝：

- fragmented MP4 / CMAF；
- 损坏或截断的容器；
- 无法完整遍历的 metadata tree；
- 不支持的容器；
- MP4/MOV 的 `keywords`；
- 超过当前支持的单段 64 KiB 元数据上限；
- 无法解析的 JPEG MPF index；
- 不支持 HTTP Range 的远程源；
- HTTP 返回的字节区间与请求不匹配；
- 空标签对象；
- `moov` 使用不支持的 `largesize` header；
- metadata tree 内部存在无法安全重写的 `largesize` box。

API 会返回 `ok: false`，同时在 `report.error` / `report.errorCode` 中给出原因，而不是返回一个误导性的成功结果。

---

## 幂等写入

同一份 tags 重复写入，设计目标是稳定而可预测：

```text
write(tags)
    ↓
write(tags)
    ↓
不重复追加 metadata
不无限膨胀 header
已经满足目标状态时保持相同结果
```

同名字段会被替换，而不是不断追加副本。

---

## 媒体数据保真

stamp-js 对“不属于本次修改范围”的字节非常保守。

验证体系会检查类似这些不变式：

```text
metadata 发生变化       ✅
媒体 payload 发生变化   ❌
未知区域被随意改写      ❌（不在 planned edits 内）
输出结构仍然有效        ✅
再次写入保持稳定        ✅
```

对 MP4，`mdat` 会以原文件 slice 的形式继续存在；对图片，写 metadata 的过程不会重新解码并重建图像 payload。

---

## API 很小

### 安装

```bash
npm install @asinnn/stamp-js
```

### 浏览器 / Blob / File

```js
import { writeTags, BlobSource } from '@asinnn/stamp-js';

const result = await writeTags(new BlobSource(file), {
  title: '我的视频',
  artist: 'Alice',
  date: '2026-04-02T09:30:00Z',
  comment: 'Recorded on device',
  url: 'https://example.com/item/123',
  software: 'My App',
  copyright: '© 2026 Alice',
});

if (result.ok) {
  // Blob / File source → result.blob
  download(result.blob);
} else {
  console.warn(result.report.errorCode, result.report.error);
}
```

### 只检查，不写入

```js
import { inspect } from '@asinnn/stamp-js';

const info = await inspect(file);

console.log(info.format);
console.log(info.capabilities);
console.log(info.mp4?.moovSize);
```

### HTTP Range 源

URL 源需要服务器正确支持字节范围请求（HTTP Range）。

```js
import { writeTags } from '@asinnn/stamp-js';

const result = await writeTags('https://example.com/video.mp4', {
  title: '远程视频',
});

if (result.ok) {
  // URL source → ReadableStream
  await streamToYourWriter(result.stream);
}
```

### Node.js 文件，包括 >4 GiB

Node 处理超大文件时，建议使用 `NodeFileSource`，不要把 `fs.openAsBlob()` 当作所有 >4 GiB 场景的可靠尺寸来源。

```js
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeTags } from '@asinnn/stamp-js';
import { NodeFileSource } from '@asinnn/stamp-js/node';

const src = new NodeFileSource('huge.mp4');

try {
  const result = await writeTags(src, { title: '大文件' });

  if (!result.ok) {
    throw new Error(result.report.error);
  }

  await pipeline(
    Readable.fromWeb(result.stream),
    fs.createWriteStream('out.mp4'),
  );
} finally {
  // NodeFileSource 是惰性读取，必须等输出流消费完成后再关闭。
  src.close();
}
```

`NodeFileSource` 通过 `fstat` 获取真实的 64 位文件大小，并使用 `fs.read` 提供随机读取。由于它不能提供本地 reference slice，输出形式为 `ReadableStream`。

---

## API 结构

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

### 常用选项

`metadataFormat`

控制 MP4 metadata handler 格式。`auto` 尽可能遵循已有布局；`mdir` 与 `mdta` 可显式指定新建 metadata 的格式。

`nativeExif`

默认开启。设为 `false` 可以关闭原生 EXIF 镜像，但 XMP 仍然正常写入。

`materialize`

设为 `false` 时，只返回 rewrite plan / parts，而不立即生成 Blob 或创建输出流。

`chunkSize`

控制 `partsToStream()` 对流式源进行输出时的 chunk 大小。

`mimeType`

可选的 Blob 输出 MIME 类型。

---

## 低内存不是口号：I/O 本身可以被测量

Source 层提供了统计信息，因此应用和测试可以直接观察读取策略，而不是只相信 README。

常见统计包括：

```text
readCalls
bytesRead
maxReadSize
sliceCalls
```

写入报告还会提供结构化信息，例如：

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
```

例如：

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

所以“适合大文件”不是一句无法验证的口号，而可以直接在 CI 和真实应用里观察 `bytesRead`、读取次数和 slice 数量。

---

## 底层 building blocks

除了高层 `writeTags()`，包还导出了用于构建容器级操作的底层组件：

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

Node 额外提供：

```text
NodeFileSource
openFile
```

这层次划分是有意的：高层 API 服务常见元数据写入；planner 和 Source 抽象则可以被需要更底层容器控制的应用直接使用。

---

## 支持环境

| 运行时 | 支持 |
|---|---|
| Node.js | 18+ |
| Chrome / Edge | 67+ |
| Firefox | 68+ |
| Safari | 15+ |
| Deno / Bun | 当前版本 |
| Web Worker | ✅ |
| Service Worker | ✅ |
| 油猴 | ✅，使用 `dist/stamp.umd.js` |

包同时提供 ESM 与 UMD 构建，**无运行时依赖**。

---

## 当前版本刻意不做什么？

stamp-js 是“元数据 / 容器编辑器”，不是通用的视频处理框架。

当前版本会主动拒绝或尚未实现：

```text
AVIF
HEIC
WebP
WebM
MKV
MP3
FLAC
fragmented MP4 / CMAF
MP4 keywords
```

超过当前 64 KiB 单段限制的 XMP 也会被拒绝。读取和合并 Extended XMP 已经支持；写出 Extended XMP 属于后续扩展方向。

C2PA / JUMBF 内容凭证当前不会随 metadata 写入而更新。依赖 Content Credentials 的应用应把元数据编辑视为会影响凭证状态的操作。

---

## 重要限制

### JPEG / PNG 头部扫描上限

插入点必须位于文件前 **8 MiB** 内。扫描会从较小窗口开始，根据需要扩展，而不是一上来就把 8 MiB 全读进内存。

### MP4 内存由 `moov` 决定

超长录制可能拥有更大的 sample table，从而产生更大的 `moov`。真正影响 planner 内存的主要是这个结构，而不是媒体本身有多少 GB。

长视频处理前可以先通过 `inspect().mp4.moovSize` 或 warning 判断。

### Node stream 生命周期

`NodeFileSource` 在输出 `ReadableStream` 被消费时才会继续读取文件。因此不要在流真正消费完之前关闭 source。

---

## 验证体系

这个版本包含多层验证：单元与回归、畸形输入、第三方工具互操作、真实设备素材和独立验证。

| 套件 | 命令 | 0.1.0 包当前断言规模 |
|---|---|---:|
| 单元 + 回归 | `npm test` | 基线 323 / Node 20/22 为 340 |
| 畸形 / fuzz 矩阵 | `npm run test:fuzz` | 196 |
| 互操作（`exiftool` + Pillow） | `npm run test:interop` | 38 |
| 真实设备文件 | `npm run test:real` | 34 |
| 独立验证 | `npm run test:verify` | CI 90 + 真实媒体 47 |
| `ffprobe` 交叉校验 | `npm run test:ffprobe` | 每个真实视频 4 项 |

畸形输入测试会反复验证这些不变式：

```text
不会出现意外 throw
失败一定给出原因
输出结构保持有效
媒体 payload 保持逐字节不变
重复写入保持幂等
```

真实素材覆盖了动态照片、带大量厂商段的 JPEG、微信导出文件、`moov` 位于尾部的视频、带 64 位 offset 的 >4 GiB 文件，以及 Android / MediaTek 风格的 metadata 布局。

CI 同时检查 `dist/` 是否和 `src/` 同步，避免发布出过期构建。

---

## 架构

整个设计可以概括成四层：

```text
             Source
               │
             随机读取
               ↓
        容器 probe / parser
               ↓
          rewrite planner
               ↓
        reference-slice 输出
```

详细实现见 [ARCHITECTURE.md](ARCHITECTURE.md)，包括：

- `Source` 抽象；
- JPEG MPF offset 平移；
- PNG 不读取 `IDAT` 的插入机制；
- MP4 `moov` 处理；
- `stco` / `co64` offset 重定位；
- `stco → co64` fixed-point 升级；
- EXIF IFD0 保留策略；
- `mdir` / `mdta` 混合布局处理；
- MP4 的实际内存模型。

---

## 为什么代码可以很小？

因为它没有试图成为一个“什么都处理”的媒体框架。

它只做一件事：

```text
找到描述文件的那部分字节。
只修改这些字节。
媒体本身不要碰。
```

浏览器已经提供了随机切片读取、Blob/File 和流等底层能力；stamp-js 做的，是把这些原语与容器格式知识组合起来，形成一个针对 metadata surgery 的小而明确的工具链。

所以这个项目真正的技术点，不在于“用了很多代码”，而在于：

> **用很少的额外抽象，把文件大小和 JavaScript 内存之间原本的强耦合拆开。**

---

## 许可证

MIT。

另见 [ARCHITECTURE.md](ARCHITECTURE.md)、[CHANGELOG.md](CHANGELOG.md) 与 [RELEASING.md](RELEASING.md)。
