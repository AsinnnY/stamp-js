# stamp-js

[![CI](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AsinnnY/stamp-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@asinnn/stamp-js.svg)](https://www.npmjs.com/package/@asinnn/stamp-js)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **零运行时依赖 · 容器级无损手术 · 极低内存开销**
>
> 在浏览器、Node.js、Web Worker 或油猴脚本中，向数 GB 级的 **JPEG、PNG、MP4、MOV** 媒体文件瞬间写入 **XMP / EXIF / iTunes (`mdir`) / QuickTime (`mdta`)** 元数据与时间戳——**无需解码、无需重编码、无需重封装（re-mux），更无需将媒体数据读入内存。**

**[English](README.md) | 简体中文**

---

## 目录

1. [为什么选择 stamp-js？](#1-为什么选择-stamp-js)
2. [项目核心特性](#2-项目核心特性)
3. [核心功能与底层机制介绍](#3-核心功能与底层机制介绍)
4. [支持的元数据字段全量详解（18 字段 + 5 别名）](#4-支持的元数据字段全量详解18-字段--5-别名)
5. [特殊字段格式规范与校验规则](#5-特殊字段格式规范与校验规则)
6. [详细调用方法教程（从入门到进阶）](#6-详细调用方法教程从入门到进阶)
   - [6.1 安装与各环境引入方式](#61-安装与各环境引入方式)
   - [6.2 浏览器端写入文件并触发下载（File / Blob）](#62-浏览器端写入文件并触发下载file--blob)
   - [6.3 写入与更新 MP4/MOV 的编码日期与标记日期](#63-写入与更新-mp4mov-的编码日期与标记日期)
   - [6.4 读取与探测媒体信息（`inspect()` 详解）](#64-读取与探测媒体信息inspect-详解)
   - [6.5 保留原有元数据并增量更新（`mergeXmp` 与 `existingTags`）](#65-保留原有元数据并增量更新mergexmp-与-existingtags)
   - [6.6 Node.js 本地文件读写与 `>4 GiB` 超大视频处理](#66-nodejs-本地文件读写与-4-gib-超大视频处理)
   - [6.7 HTTP Range 远程文件流式写入（无需下载整文件）](#67-http-range-远程文件流式写入无需下载整文件)
   - [6.8 自定义数据源与高级规划模式（`materialize: false`）](#68-自定义数据源与高级规划模式materialize-false)
   - [6.9 错误处理与机器可读错误码（`errorCode` 速查表）](#69-错误处理与机器可读错误码errorcode-速查表)
7. [API 完整参考手册](#7-api-完整参考手册)
8. [内存模型与安全边界](#8-内存模型与安全边界)
9. [测试与独立验证体系](#9-测试与独立验证体系)

---

## 1. 为什么选择 stamp-js？

### 8 GiB 的 MP4 视频，写入标签只需读取约 66 KiB

传统的浏览器端或 Node.js 媒体处理工具在修改一条简单的标题或日期时，往往需要把整个文件读入 `ArrayBuffer`，或者调用庞大的 WebAssembly 音视频框架重新解复用（re-mux）。面对几百 MB 甚至数 GB 的 4K 视频时，这会直接导致浏览器标签页内存溢出（OOM）或耗费数十秒的磁盘拷贝。

**stamp-js 采用截然不同的“容器级定点手术 + 引用切片组装”架构：**

| 对比维度 | 传统整文件处理 / 重封装方案 | **stamp-js** |
|---|---|---|
| **处理 8 GiB MP4 时的读取量** | 读取全部 8 GiB 媒体字节 | **仅读取约 66 KiB（占文件 0.00077%）** |
| **媒体载荷（`mdat` / `IDAT` / 扫描区）** | 全量解析、拷贝或重打包 | **100% 零触碰（保持原文件切片引用）** |
| **重编码（Re-encoding）** | 部分工具会触发重编码损失画质 | **绝不重编码（画质/音质 100% 无损）** |
| **重封装（Re-muxing）** | 需要拆解音视频轨再重新合成 | **绝不重封装（直接原位修改元数据盒）** |
| **运行时依赖与体积** | 动辄数 MB 至数十 MB 的 WASM/二进制依赖 | **0 依赖纯 JavaScript，单文件即可运行** |

```text
                        按需随机读取头部/moov
                                 ↓
输入媒体文件 ─────────► 容器结构探测与安全校验
                                 │
                                 ▼
                      仅构建需要变更的元数据字节
                      并重算受影响的绝对偏移表
                                 │
                   ┌─────────────┴─────────────┐
                   ▼                           ▼
             新生成的元数据块            原文件媒体区切片引用
             (Uint8Array)               (Blob.slice / 流区间)
                   │                           │
                   └─────────────┬─────────────┘
                                 ▼
                     零拷贝组装输出 (Blob / Stream)
```

对于本地 `File` 或 `Blob`，最终产出的文件在底层等价于：

```js
new Blob([
  originalFile.slice(0, editStart),
  newMetadataBytes,
  originalFile.slice(editEnd, originalFile.size),
]);
```

媒体载荷字节从未进入 JavaScript 堆内存。

---

## 2. 项目核心特性

* **全平台统一 18 字段元数据模型**：一套统一的 `tags` 对象同时支持 **JPEG、PNG、MP4、MOV**，涵盖标题、作者、创建日期、编码日期（`encodedDate`）、标记日期（`taggedDate`）、原始拍摄日期（`dateOriginal`）、描述、备注、来源 URL、软件、版权、关键词、专辑/合集、流派/分类、拍摄设备品牌/型号、GPS 经纬度海拔、星级评分。
* **双重写入保障（标准 XMP + 原生 EXIF/iTXt/Box）**：
  * **JPEG**：同时写入标准 **XMP (`APP1`)** 与 **原生 EXIF (`IFD0` / `ExifIFD` / `GPSIFD`)**，确保 Windows 资源管理器属性页、macOS 访达、Adobe 工具链及专业看图软件均能识别。
  * **PNG**：同时写入 **XMP (`iTXt`)**、**14 种标准 `iTXt` 文本块**与 **原生 `eXIf` 块**，并自动计算全部 chunk 的 CRC32。
  * **MP4 / MOV**：同时支持写入 **`ilst` 元数据容器**（自动识别并保持文件原有的 Apple iTunes `mdir` 风格或 QuickTime `mdta` `keys` 表风格）以及 **`mvhd` / `tkhd` / `mdhd` 头部时间戳**（32 位 v0 与 64 位 v1 自动适配）。
* **支持读取既有元数据（`inspect().existingTags`）与智能合并（`mergeXmp: true`）**：调用 `inspect()` 即可无损读取 JPEG/PNG/MP4 中现有的 18 类元数据字段；写入时既可整包替换，也可开启 `{ mergeXmp: true }` 自动保留未修改的既有字段。
* **突破 4 GiB 限制的 `stco → co64` 自动升级与 8 字节对齐求解器**：当 `faststart`（`moov` 在文件头）的大体积 MP4 因写入元数据导致 32 位块偏移（`stco`）溢出 `0xFFFFFFFF` 时，自动将溢出轨道升级为 64 位 `co64`，并通过单调不动点求解器 `planAlignedMoovGrowth()` 联合计算元数据增量、`co64` 升级增量与 `free` 补齐量，严格维持项目设定的 8 字节对齐不变式。
* **动态照片（Motion Photo / Live Photo）MPF 偏移自动重定位**：修改 vivo、三星、小米等安卓旗舰手机拍摄的动态照片（含 `APP2 MPF` 多图索引及尾部附加视频/图像）时，自动按头部长度变化量平移 `MPEntry` 中的主图长度与次级载荷绝对偏移，防止“长按播放动态照片”失效。
* **防御式安全拒绝机制（Safety by Refusal）**：绝不抛出未捕获异常，绝不静默丢弃不支持的字段，绝不在容器结构损坏或分片流（fMP4/CMAF）下强行写出损坏文件。所有拒绝均返回 `{ ok: false, report: { error, errorCode } }`。
* **严格的幂等性（Idempotency）**：相同标签连续写入 N 次，输出文件逐字节 100% 一致，不会产生重复堆叠的 XMP 段或 `udta` 盒。
* **完整的 I/O 可观测性**：每次操作均在 `report.planning` 与 `report.stats` 中精确记录读取次数（`readCalls`）、总读取字节数（`bytesRead`）、最大单次读取（`maxReadSize`）和切片数（`sliceCalls`）。

---

## 3. 核心功能与底层机制介绍

### 3.1 JPEG：头部扫描 + 尾部追加式原生 EXIF + 动态照片 MPF 维护

1. **只读文件头**：从 `SOI (0xFFD8)` 扫描至第一个图像数据段（`DQT` / `SOF` / `DHT` / `SOS`）前，默认仅读取前 64 KiB（若遇大型厂商私有段则按需扩展，硬上限 8 MiB），绝不触碰 `SOS` 之后的压缩图像扫描数据及尾部动态照片视频流。
2. **XMP 与陈旧扩展分片清理**：替换原有的标准 XMP `APP1` 段，同时自动清除已失效的 `http://ns.adobe.com/xmp/extension/` 扩展分片，杜绝旧元数据残留泄露。
3. **尾部追加式原生 EXIF 更新（Append-Only TIFF Surgery）**：由于 TIFF 内部所有偏移均相对于 TIFF 头计算，stamp-js 将更新后的 `IFD0` / `ExifIFD` / `GPSIFD` 追加到原 TIFF 块末尾，并仅修改 TIFF 头第 4~7 字节的 `IFD0` 指针。**原有的相机 `MakerNotes`（如 Apple/vivo 私有块）、缩略图（`IFD1`）不仅字节未变，连相对偏移都完全不变**，从而实现 100% 安全的 EXIF 更新。
4. **保护相机 `UserComment`**：手机厂商常在 `ExifIFD.UserComment` 中存放人像算法参数（如 `filter: 0; module: portrait`）。stamp-js 仅在 `UserComment` 为空或缺失时填入 `comment`，若已有其他数据则原样保留并通过 XMP 存储备注。

### 3.2 PNG：零 IDAT 读取 + 双轨元数据写入

1. **跳过巨型 IDAT**：扫描块头（长度 4B + 类型 4B）定位到第一个 `IDAT` 前插入元数据，即使单个 `IDAT` 块高达数百 MB 也完全不会读入内存。
2. **三层写入**：写入 `XML:com.adobe.xmp` 的 `iTXt` 块、标准关键字 `iTXt` 块（`Title`、`Author`、`Creation Time`、`Encoded Time`、`Modify Time` 等）以及原生 `eXIf` 块（自动遵循 PNG 规范不在 `eXIf` 中重复写入日期，避免触发校验器告警）。

### 3.3 MP4 / MOV：盒子级手术 + 双格式兼容 + 偏移重定位

1. **自动识别 `faststart` 与 `moov-at-tail`**：
   * 若 `moov` 位于 `mdat` 之后（如 `ffmpeg` 默认输出），直接更新文件尾部的 `moov`，所有媒体采样偏移零改动（`moov-at-tail-zero-offset`）。
   * 若 `moov` 位于 `mdat` 之前（`faststart` 布局），重写 `moov` 后自动遍历所有轨道的 `stco`（32 位）与 `co64`（64 位）块偏移表，将位于 `moov` 之后的媒体偏移统一平移 `Δ` 字节（`moov-at-head-shift-offsets`）。
2. **`mdir` 与 `mdta` 双风格自适应**：
   * **`mdir`（iTunes / QuickTime 传统风格）**：使用 `©nam`、`©ART`、`©day`、`cprt`、`©xyz` 等四字符原子名。
   * **`mdta`（现代 QuickTime / Android `keys` 表风格）**：维护 `keys` 字符串表与数字索引 `ilst` 条目，合并多个 `udta` 时自动重映射（rebase）保留条目的数字索引，并完整保留 `----` 自由格式（freeform）条目与未知子盒。
   * **混合容器就地更新**：若文件同时存在 `moov/udta/meta (mdir)` 与 `moov/meta (mdta)`，在 `metadataFormat: 'auto'` 下各自按原格式就地更新，绝不混写损坏。
3. **头部时间戳（编码日期 & 标记日期）**：
   * 自动将 `encodedDate`（未传时回退 `date` / `dateOriginal`）转换为苹果 QuickTime HFS+ 纪元秒数（自 `1904-01-01T00:00:00Z` 起），写入 `mvhd`、所有 `tkhd` 及所有 `mdhd` 的 `creation_time`。
   * 自动将 `taggedDate`（未传时回退 `date` / `dateOriginal`）写入 `mvhd`、`tkhd`、`mdhd` 的 `modification_time`。
   * 当仅传入 `{ encodedDate, taggedDate }` 且无需新增 `ilst` 标签时，直接在原 `moov` 头部原地修改时间戳，文件体积零增长（`delta === 0`），也无需重算 `stco`/`co64` 偏移！

---

## 4. 支持的元数据字段全量详解（18 字段 + 5 别名）

`writeTags(source, tags, options)` 与 `inspect(source)` 支持以下 **18 个标准字段**（在 JPEG、PNG、MP4/MOV 三大类容器中**全部受支持**）：

| 字段名 | 可用别名 | 类型 | 功能说明 | JPEG 底层写入位置 (XMP + EXIF) | PNG 底层写入位置 (XMP + iTXt + eXIf) | MP4 / MOV 底层写入位置 (`mdir` / `mdta` / Header) |
|---|---|---|---|---|---|---|
| **`title`** | — | `string` | 标题 / 作品名称 | `dc:title` + `IFD0 0x010E (ImageDescription)` | `dc:title` + `iTXt["Title"]` + `eXIf 0x010E` | `©nam` / `keys["title"]` |
| **`artist`** | — | `string` | 作者 / 创作者 / 艺术家 | `dc:creator` + `IFD0 0x013B (Artist)` | `dc:creator` + `iTXt["Author"]` + `eXIf 0x013B` | `©ART` / `keys["artist"]` |
| **`date`** | — | `string \| Date \| number` | 通用创建日期 | `xmp:CreateDate` + `IFD0 0x0132 (DateTime)` | `xmp:CreateDate` + `iTXt["Creation Time"]` | `©day` / `keys["date"]` + 同步 `mvhd/tkhd/mdhd` |
| **`encodedDate`** | `creationTime` | `string \| Date \| number` | **编码日期 / 数字化日期**（MediaInfo 显示的 `Encoded date`） | `exif:DateTimeDigitized` + `xmp:CreateDate` + `ExifIFD 0x9004` | `exif:DateTimeDigitized` + `iTXt["Encoded Time"]` + `eXIf 0x9004` | **`mvhd` / `tkhd` / `mdhd` 的 `creation_time`**（支持 v0 32 位与 v1 64 位） |
| **`taggedDate`** | `modificationTime`, `modifyDate` | `string \| Date \| number` | **标记日期 / 修改日期**（MediaInfo 显示的 `Tagged date`） | `xmp:ModifyDate` + `xmp:MetadataDate` + `IFD0 0x0132` | `xmp:ModifyDate` + `xmp:MetadataDate` + `iTXt["Modify Time"]` | **`mvhd` / `tkhd` / `mdhd` 的 `modification_time`**（支持 v0 32 位与 v1 64 位） |
| **`dateOriginal`** | `captureDate` | `string \| Date \| number` | **原始拍摄日期**（快门触发时间） | `exif:DateTimeOriginal` + `ExifIFD 0x9003` | `exif:DateTimeOriginal` + `eXIf 0x9003` | `©day` / `keys["com.apple.quicktime.creationdate"]` |
| **`description`** | — | `string` | 详细描述 / 图注 | `dc:description` + `IFD0 0x010E`（优先于 `title`） | `dc:description` + `iTXt["Description"]` + `eXIf 0x010E` | `desc` / `keys["description"]` |
| **`comment`** | — | `string` | 备注 / 注释 | `dc:description` + `ExifIFD 0x9286 (UserComment)`（空时填入） | `dc:description` + `iTXt["Comment"]` + `eXIf 0x9286` | `©cmt` / `keys["comment"]` |
| **`url`** | — | `string` | 来源网址 / 作品链接 | `dc:source` + 附加至 `dc:description` | `dc:source` + 附加至 `iTXt["Description"]` | `©url` / `keys["url"]` + 附加至备注 |
| **`software`** | — | `string` | 编码工具 / 写入软件名称 | `xmp:CreatorTool`（刻意不覆写 `IFD0 0x0131` 相机固件名） | `xmp:CreatorTool` + `iTXt["Software"]` | `©too` / `keys["software"]` |
| **`copyright`** | — | `string` | 版权声明 | `dc:rights` + `IFD0 0x8298 (Copyright)` | `dc:rights` + `iTXt["Copyright"]` + `eXIf 0x8298` | `cprt` / `keys["copyright"]` |
| **`keywords`** | — | `string[] \| string` | 关键词 / 标签列表 | `dc:subject` (`<rdf:Bag><rdf:li>...`) | `dc:subject` (`<rdf:Bag><rdf:li>...`) | `©key` / `keys["keywords"]`（逗号分隔） |
| **`album`** | — | `string` | 专辑 / 合集 / 归档集 | `xmpDM:album` | `xmpDM:album` + `iTXt["Collection"]` | `©alb` / `keys["album"]` |
| **`genre`** | — | `string` | 流派 / 分类 / 风格 | `xmpDM:genre` | `xmpDM:genre` + `iTXt["Genre"]` | `©gen` / `keys["genre"]` |
| **`make`** | — | `string` | 拍摄设备制造商（如 `Canon`、`Apple`） | `tiff:Make` + `IFD0 0x010F (Make)` | `tiff:Make` + `iTXt["Source"]` + `eXIf 0x010F` | `©mak` / `keys["com.apple.quicktime.make"]` |
| **`model`** | — | `string` | 拍摄设备型号（如 `EOS R5`、`iPhone 16 Pro`） | `tiff:Model` + `IFD0 0x0110 (Model)` | `tiff:Model` + `iTXt["Source"]` + `eXIf 0x0110` | `©mod` / `keys["com.apple.quicktime.model"]` |
| **`gps`** | `location` | `GpsObject \| string` | GPS 地理坐标（纬度、经度、可选海拔） | `exif:GPSLatitude/Longitude/Altitude` + `GPSIFD (0x0000..0x0006)` | `exif:GPS*` + `iTXt["Location"]` + `eXIf GPSIFD` | `©xyz` / `keys["com.apple.quicktime.location.ISO6709"]` |
| **`rating`** | — | `number` | 星级评分（`-1` 拒绝，`0..5` 星） | `xmp:Rating` + `IFD0 0x4746 (Rating)` | `xmp:Rating` + `iTXt["Rating"]` + `eXIf 0x4746` | `rate` / `keys["com.apple.quicktime.rating.user"]` |

---

## 5. 特殊字段格式规范与校验规则

为防止非法数据（如 `INVALID_DATE` 或越界坐标）污染媒体文件，stamp-js 在进入任何格式规划器前均执行严格的统一前置校验（`validateTags()`）：

### 5.1 日期时间字段（`date` / `encodedDate` / `taggedDate` / `dateOriginal`）

**合法输入格式（自动归一化为标准 UTC ISO-8601 字符串与容器对应格式）**：

1. **ISO-8601 日期时间或纯日期字符串**：
   * `'2026-04-02T09:30:00Z'`
   * `'2026-04-02T17:30:00+08:00'`
   * `'2026-04-02T09:30:00.123Z'`
   * `'2026-04-02 09:30:00'` 或 `'2026-04-02'`
2. **EXIF 标准格式字符串**：
   * `'2026:04:02 09:30:00'` 或 `'2026:04:02'`
3. **MediaInfo UTC 格式字符串**：
   * `'UTC 2026-04-02 09:30:00'`
4. **JavaScript `Date` 实例**：
   * `new Date('2026-04-02T09:30:00Z')` 或 `new Date()`（必须满足 `!Number.isNaN(d.getTime())`）
5. **非负有限数字（Unix 时间戳）**：
   * `1775122200000`（毫秒时间戳，`> 1e11` 自动按毫秒处理）或 `1775122200`（秒级时间戳）

**会被明确拒绝（返回 `ok: false, report.errorCode === 'BAD_OPTION'`）的非法输入**：
* `new Date(NaN)` 或 `new Date('invalid')`
* `NaN`、`Infinity`、负数时间戳
* 无法解析的字符串（如 `'INVALID_DATE'`、`'not-a-date'`）
* 不存在的日历日期（如平年 `'2026-02-29'`、`'2026-02-30T10:00:00Z'`、月份 `'2026-13-01'`、小时 `'25:00:00'`）

### 5.2 GPS 坐标字段（`gps` 或别名 `location`）

支持以下 4 种写法（要求纬度 `lat` 在 `[-90, 90]`、经度 `lon` 在 `[-180, 180]`，海拔 `alt` 为有限数字，单位米）：

```js
// 写法 1：简写属性对象（推荐）
gps: { lat: 31.2304, lon: 121.4737, alt: 12.5 }

// 写法 2：完整属性名对象
gps: { latitude: 31.2304, longitude: 121.4737, altitude: 12.5 }

// 写法 3：ISO-6709 标准字符串（Apple QuickTime / MP4 原生格式）
gps: '+31.2304+121.4737+12.50/'

// 写法 4：逗号分隔的经纬度（可选海拔）字符串
gps: '31.2304, 121.4737, 12.5'
```

### 5.3 关键词（`keywords`）与评分（`rating`）

* **`keywords`**：支持字符串数组 `['旅行', '4K', '航拍']` 或逗号分隔字符串 `'旅行, 4K, 航拍'`（自动去空白并过滤空项；传入空数组 `[]` 且无其他有效字段时将被拒绝）。
* **`rating`**：支持 `-1` 至 `5` 之间的有限数字（如 `5`，浮点数会自动四舍五入为整数；超出 `[-1, 5]` 范围或传入 `NaN` 返回 `BAD_OPTION`）。

---

## 6. 详细调用方法教程（从入门到进阶）

### 6.1 安装与各环境引入方式

#### 方式 A：NPM 安装（Node.js / Vite / Webpack / Rollup 等现代工程）

```bash
npm install @asinnn/stamp-js
```

```js
import { writeTags, inspect, capabilities, BlobSource, BufferSource, HttpSource } from '@asinnn/stamp-js';
// Node.js 专用的大文件数据源（可选）：
import { NodeFileSource, openFile } from '@asinnn/stamp-js/node';
```

#### 方式 B：浏览器 `<script>` 标签或 Tampermonkey 油猴脚本（UMD 构建）

```html
<script src="https://unpkg.com/@asinnn/stamp-js@0.1.2/dist/stamp.umd.js"></script>
<script>
  const { writeTags, inspect, capabilities } = window.stamp;
</script>
```

在油猴（Tampermonkey）脚本头部直接声明：

```js
// ==UserScript==
// @name         Media Metadata Stamper
// @match        https://example.com/*
// @require      https://unpkg.com/@asinnn/stamp-js@0.1.2/dist/stamp.umd.js
// ==/UserScript==

const { writeTags, inspect } = window.stamp;
```

---

### 6.2 浏览器端写入文件并触发下载（File / Blob）

当用户通过 `<input type="file">` 选择或拖拽一个 JPEG、PNG、MP4、MOV 文件时，可直接将 `File`（或 `new BlobSource(file)`）传给 `writeTags()`：

```js
import { writeTags } from '@asinnn/stamp-js';

const fileInput = document.querySelector('#file-input');

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const result = await writeTags(file, {
    title: '青海湖日落航拍',
    artist: 'Asinnn',
    date: '2026-08-15T18:20:00Z',
    encodedDate: '2026-08-15T18:20:00Z',
    taggedDate: new Date(),
    dateOriginal: '2026-08-15T17:55:10Z',
    description: '使用无人机拍摄的 4K HDR 延时摄影素材',
    comment: '无调色原片，直出归档',
    url: 'https://example.com/videos/qinghai-lake',
    software: 'MyMediaApp/1.0',
    copyright: '© 2026 Asinnn. All rights reserved.',
    keywords: ['青海湖', '航拍', '日落', '4K'],
    album: '2026 西北行',
    genre: 'Nature',
    make: 'DJI',
    model: 'Mavic 3 Pro',
    gps: { lat: 36.8869, lon: 100.1408, alt: 3205 },
    rating: 5,
  });

  if (!result.ok) {
    console.error('写入失败:', result.report.errorCode, result.report.error);
    return;
  }

  console.log('规划阶段仅读取字节数:', result.report.planning.bytesRead);
  console.log('写入策略:', result.report.strategy);

  // result.blob 是通过引用切片零拷贝组装出的新 Blob，可直接下载
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tagged_${file.name}`;
  a.click();
  URL.revokeObjectURL(url);
});
```

---

### 6.3 写入与更新 MP4/MOV 的编码日期与标记日期

针对视频归档工具、MediaInfo 检查或剪辑软件常见的 **编码日期（`Encoded date`）** 与 **标记日期（`Tagged date`）** 需求：

```js
import { writeTags } from '@asinnn/stamp-js';

// 场景 1：仅修改 MP4/MOV 的编码日期与标记日期（不添加新的 ilst 文本标签）
// 此时库直接在 moov 的 mvhd / tkhd / mdhd 头内原地修补时间戳，
// 文件大小零变化 (delta === 0)，不产生任何偏移平移！
const resHeaderOnly = await writeTags(mp4File, {
  encodedDate: '2026-05-01T10:00:00Z', // 也可使用别名 creationTime
  taggedDate: '2026-05-02T15:30:00Z',  // 也可使用别名 modificationTime 或 modifyDate
});

if (resHeaderOnly.ok) {
  console.log(resHeaderOnly.report.mp4Dates);
  // 输出:
  // {
  //   encodedDate: '2026-05-01T10:00:00Z',
  //   taggedDate: '2026-05-02T15:30:00Z',
  //   boxesPatched: 3 // mvhd + 音视频轨 tkhd/mdhd 同步更新的总盒数
  // }
}

// 场景 2：同时写入 ilst 标签与编码/标记日期
const resFull = await writeTags(mp4File, {
  title: '产品发布会全程录像',
  artist: 'Media Team',
  encodedDate: '2026-05-01T10:00:00Z',
  taggedDate: '2026-05-02T15:30:00Z',
  dateOriginal: '2026-05-01T09:00:00Z', // 写入 QuickTime creationdate / ©day
});
```

> **提示**：如果你只传了 `date`（或 `dateOriginal`）而未单独指定 `encodedDate` / `taggedDate`，MP4 规划器也会自动用 `date` 同步更新 `mvhd`/`tkhd`/`mdhd` 的 `creation_time` 和 `modification_time`。

---

### 6.4 读取与探测媒体信息（`inspect()` 详解）

在执行写入前，你可以调用 `inspect(source)` 在不改动任何字节的前提下探测容器格式、是否安全可写、支持哪些字段、视频流参数及文件中现有的元数据标签：

```js
import { inspect } from '@asinnn/stamp-js';

const info = await inspect(file);

console.log('识别格式:', info.format);         // 'jpeg' | 'png' | 'mp4' | 'avif' | 'heic' | 'riff' | 'ebml' | 'unknown'
console.log('是否支持:', info.supported);      // true | false
console.log('是否可安全写入:', info.safeToWrite); // true | false
console.log('支持字段列表:', info.capabilities.supported); // 18 个字段名数组（不支持格式为 []）
console.log('现有归一化标签:', info.existingTags);
// 例如:
// {
//   title: '旧标题',
//   artist: '旧作者',
//   encodedDate: '2026-05-01T10:00:00Z',
//   taggedDate: '2026-05-02T15:30:00Z',
//   keywords: ['k1', 'k2'],
//   rating: 5
// }

if (!info.safeToWrite) {
  console.warn('文件不可安全写入，原因:', info.errorCode, info.error);
}

// 针对 MP4/MOV 的专属结构信息：
if (info.format === 'mp4' && info.mp4) {
  console.log({
    fastStart: info.mp4.fastStart,           // moov 是否在 mdat 之前
    fragmented: info.mp4.fragmented,         // 是否为分片 MP4 (fMP4)
    moovSize: info.mp4.moovSize,             // moov 盒字节大小（可用于评估大文件内存）
    codec: info.mp4.codec,                   // 例如 'avc1', 'hvc1', 'mp4a'
    video: info.mp4.video,                   // 例如 { width: 1920, height: 1080 }
    durationSec: info.mp4.durationSec,       // 时长（秒）
    bitrate: info.mp4.bitrate,               // 估算码率（bps）
    encodedDate: info.mp4.encodedDate,       // mvhd creation_time (ISO-8601)
    taggedDate: info.mp4.taggedDate,         // mvhd modification_time (ISO-8601)
    metadataFormat: info.mp4.metadataFormat, // 'mdir' | 'mdta' | 'mixed'
  });
}

// 针对 JPEG 的专属结构信息：
if (info.format === 'jpeg' && info.jpeg) {
  console.log({
    existingXmp: info.jpeg.existingXmp,                   // 是否已有 XMP
    existingExif: info.jpeg.existingExif,                 // 是否已有 EXIF
    extendedXmpFragments: info.jpeg.extendedXmpFragments, // 扩展 XMP 分片数
    multiPicture: info.jpeg.multiPicture,                 // 动态照片 MPF 索引详情（普通 JPEG 为 null）
  });
}
```

---

### 6.5 保留原有元数据并增量更新（`mergeXmp` 与 `existingTags`）

不同容器对“未传入字段”的默认处理机制如下：

* **MP4 / MOV**：元数据存放在键值表（`ilst`）中，**默认自动保留**所有未声明覆盖的既有标签条目。
* **JPEG / PNG**：XMP 是一个完整的 XML 数据包。为保证幂等性与包内一致性，**默认（`mergeXmp: false`）会按本次传入的 `tags` 整体重建 XMP 包**（未传入的 XMP 字段会被清空）。

如果你想在 JPEG / PNG 上**只修改某几个字段，同时保留原有的其余 XMP 字段**，有以下两种推荐方式：

```js
import { writeTags, inspect } from '@asinnn/stamp-js';

// 方式一（最简）：直接开启 { mergeXmp: true } 选项
// 库会自动先解析原有的 XMP/文本块字段，再将你传入的新字段覆盖上去
const result1 = await writeTags(
  jpegOrPngFile,
  { artist: '新作者名称', rating: 5 },
  { mergeXmp: true }
);

// 方式二（显式控制）：先通过 inspect() 读取 existingTags，筛选或修改后再写回
const info = await inspect(jpegOrPngFile);
if (info.safeToWrite) {
  const nextTags = {
    ...info.existingTags,
    artist: '新作者名称',
    keywords: [...(info.existingTags?.keywords || []), '新增标签'],
  };
  const result2 = await writeTags(jpegOrPngFile, nextTags);
}
```

---

### 6.6 Node.js 本地文件读写与 `>4 GiB` 超大视频处理

#### 场景 A：中小型文件（使用内存 `Buffer` / `Uint8Array`）

```js
import fs from 'node:fs';
import { writeTags } from '@asinnn/stamp-js';

const inputBytes = fs.readFileSync('photo.jpg');
const res = await writeTags(inputBytes, {
  title: 'Node.js 写入示例',
  artist: 'Backend Service',
  copyright: '© 2026 Example Corp',
});

if (res.ok) {
  const outBytes = Buffer.from(await res.blob.arrayBuffer());
  fs.writeFileSync('photo_tagged.jpg', outBytes);
}
```

#### 场景 B：大文件与 `>= 4 GiB` 视频文件（使用 `NodeFileSource` 流式管道）

> **重要工程背景**：在 Node.js 22 中，内置的 `fs.openAsBlob(path)` 存在将 `>= 4 GiB` 文件的 `blob.size` 截断为 32 位整数的缺陷（例如 4 GiB 报告为 0 字节，8 GiB 报告为 0 字节）。因此，在 Node.js 中处理大型视频时，**强烈建议使用 `@asinnn/stamp-js/node` 提供的 `NodeFileSource`**——它通过 `fs.fstatSync` 获取真实的 64 位文件大小，并通过 `ReadableStream` 流式输出：

```js
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeTags } from '@asinnn/stamp-js';
import { NodeFileSource } from '@asinnn/stamp-js/node';

const src = new NodeFileSource('/path/to/8GB-4k-video.mp4');

try {
  const result = await writeTags(src, {
    title: '8GB 4K 母版归档',
    artist: 'Studio Pipeline',
    encodedDate: '2026-10-15T08:00:00Z',
    taggedDate: '2026-10-15T12:00:00Z',
  });

  if (!result.ok) {
    throw new Error(`[${result.report.errorCode}] ${result.report.error}`);
  }

  console.log('规划阶段仅读取字节:', result.report.planning.bytesRead); // 仅 ~66 KiB！

  // 将 Web ReadableStream 转换为 Node 流并写入目标文件
  await pipeline(
    Readable.fromWeb(result.stream),
    fs.createWriteStream('/path/to/8GB-4k-video-tagged.mp4')
  );
} finally {
  // 注意：必须在输出流完全消费完毕后再关闭文件描述符！
  src.close();
}
```

---

### 6.7 HTTP Range 远程文件流式写入（无需下载整文件）

只要远程对象存储（S3 / OSS / R2 / CDN）支持标准的 `HTTP 206 Partial Content` 字节范围请求（Range Requests），stamp-js 就可以只通过几次几十 KB 的 Range 请求完成元数据规划，并产出一个按需拉取的 `ReadableStream`：

```js
import { writeTags, HttpSource } from '@asinnn/stamp-js';

// 写法 1：直接传入 URL 字符串（内部自动调用 HttpSource.init()）
const result = await writeTags('https://cdn.example.com/videos/demo.mp4', {
  title: '远程云端流式打标视频',
  artist: 'Cloud Worker',
});

if (result.ok) {
  // result.stream 是 Web 标准 ReadableStream<Uint8Array>
  // 可直接作为 Cloudflare Worker / Next.js Route Handler 的下载响应返回：
  // return new Response(result.stream, { headers: { 'Content-Type': 'video/mp4' } });
}

// 写法 2：自定义 fetch 实现（例如注入鉴权 Header）
const customSource = await new HttpSource('https://api.example.com/private.mp4', {
  fetchImpl: (url, init) => fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: 'Bearer <TOKEN>' },
  }),
}).init();

const result2 = await writeTags(customSource, { title: '带鉴权的远程视频' });
```

---

### 6.8 自定义数据源与高级规划模式（`materialize: false`）

#### 自定义数据源（对接 OPFS / IndexedDB / Electron IPC 等）

任何实现了 `{ size: number, read(start, end): Promise<Uint8Array> }` 的对象，或继承自 `Source` 的类，都可以直接传给 `inspect()` 和 `writeTags()`：

```js
import { writeTags } from '@asinnn/stamp-js';

const myCustomSource = {
  size: totalFileBytes,
  type: 'video/mp4',
  async read(start, end) {
    // 只需返回 [start, end) 区间的 Uint8Array
    return await myStorage.readRange(start, end);
  },
};

const result = await writeTags(myCustomSource, { title: 'Custom Storage Video' });
```

#### 仅生成重写计划而不立即生成 Blob/Stream（`materialize: false`）

当你希望利用底层的写入指令自行在文件句柄上执行原位写或自定义分片拼接时，可传入 `{ materialize: false }`：

```js
const planResult = await writeTags(file, { title: 'Plan Only' }, { materialize: false });

if (planResult.ok) {
  console.log('输出总字节数:', planResult.size);
  for (const part of planResult.parts) {
    if (part.kind === 'ref') {
      console.log(`复用原文件区间: [${part.start}, ${part.end})`);
    } else {
      console.log(`写入新元数据块 (${part.what}): ${part.bytes.byteLength} 字节`);
    }
  }
}
```

---

### 6.9 错误处理与机器可读错误码（`errorCode` 速查表）

`writeTags()` 和 `inspect()` **永远不会抛出未捕获的异常**。所有错误都会以结构化形式通过 `result.ok === false`（或 `info.safeToWrite === false`）及 `errorCode` 返回，方便业务代码精确分支处理：

| `errorCode` | 触发场景说明 | 建议处理方式 |
|---|---|---|
| **`NO_TAGS`** | 传入了空对象 `{}`、所有字段均为空字符串、未知字段或空数组 `keywords: []` | 至少传入一个非空的有效标签字段 |
| **`BAD_OPTION`** | 传入了无效的 `Date`（如 `new Date(NaN)`）、非法日期字符串（如 `'2026-02-30'`）、越界 `gps` 坐标、越界 `rating`（非 `-1..5`）或非法的 `metadataFormat` | 检查并修正用户输入的日期、坐标或评分格式 |
| **`UNSUPPORTED_FORMAT`** | 传入了当前不支持写入的格式（如 `AVIF`、`HEIC`、`WebP/RIFF`、`WebM/MKV` 或纯文本） | 在前端通过 `inspect()` 或文件类型过滤，仅对 JPEG/PNG/MP4/MOV 启用写入 |
| **`UNSUPPORTED_TAG`** | 请求了当前容器不支持存储的字段（同时在 `report.unsupportedTags` 中列出） | 先调用 `capabilities(format)` 获取该容器支持的字段列表 |
| **`FRAGMENTED_MP4`** | 目标文件是分片 MP4（fMP4 / CMAF，含 `moof` / `sidx`），其采样偏移分散在各 `trun`/`saio` 中，直接插入会破坏流寻址 | 提示用户先用 `ffmpeg -c copy` 转为普通 MP4，或保留原文件 |
| **`MALFORMED_CONTAINER`** | 容器头部截断、Box 尺寸越界、多于 1 个 `moov`、`stco`/`co64` 表声明条目超出盒子边界，或 `udta`/`meta` 子树损坏 | 拒绝写入以防静默丢数据；提示用户原文件结构已损坏 |
| **`UNSUPPORTED_LARGESIZE`** | `moov` 自身或 `meta` 子盒使用了罕见的 64 位 `largesize` 头部，或偏移量超过 `2^53`（PB 级） | 当前仅支持 `mdat` 使用 64 位 `largesize`，拒绝改写超巨型 `moov` |
| **`XMP_TOO_LARGE`** | 生成的单段 XMP 数据包超过 JPEG APP1 单段 64 KiB 上限 | 精简过长的 `description` / `comment` / `keywords` |
| **`MPF_INVALID`** | 动态照片的 `APP2 MPF` 多图索引损坏或平移后发生 32 位溢出 | 拒绝写入，防止破坏动态照片次级视频轨道指针 |
| **`RANGE_UNSUPPORTED`** | 远程 HTTP 服务器不支持 `206 Partial Content` 字节范围请求 | 为静态资源服务器开启 `Accept-Ranges: bytes` 支持，或先下载到本地再处理 |
| **`RANGE_MISMATCH`** | 远程服务器返回的 `Content-Range` 区间或字节长度与请求不一致 | 检查 CDN / 代理服务器是否正确转发 `Range` 请求头 |
| **`SOURCE_UNREACHABLE`** | 传入的 URL 无法连接（DNS 解析失败、TLS 错误、连接被拒等） | 检查网络连接、URL 拼写或跨域（CORS）配置 |
| **`SOURCE_NOT_READY`** | 构造了 `new HttpSource(url)` 实例但未调用 `await src.init()` 即直接传入 | 改用 `await new HttpSource(url).init()`，或直接向 `writeTags(url, ...)` 传字符串 |
| **`UNSUPPORTED_SOURCE`** | 传入了无法识别的数据源类型（如 `null`、数字等） | 传入 `File`、`Blob`、`Uint8Array`、`ArrayBuffer`、URL 字符串或 `Source` 实例 |
| **`CONVERGENCE`** | `stco → co64` 升级规划超过 64 轮迭代仍未收敛（防御性保护） | 拒绝改写以保护原文件偏移表 |

---

## 7. API 完整参考手册

### 7.1 `writeTags(source, tags, options?)`

```ts
function writeTags(
  source: Blob | File | Uint8Array | ArrayBuffer | string | Source | CustomSource,
  tags: Tags,
  options?: WriteOptions
): Promise<WriteResult>;
```

#### `options` 配置项详解

| 选项名 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| **`metadataFormat`** | `'auto' \| 'mdir' \| 'mdta'` | `'auto'` | 控制 MP4/MOV 的元数据容器风格。`'auto'` 自动跟随文件原有风格（无元数据时默认新建兼容性最广的 `'mdir'`，混合容器各自就地更新）；显式指定 `'mdir'` 或 `'mdta'` 时会强制转换为目标风格。 |
| **`nativeExif`** | `boolean` | `true` | 是否在 JPEG（`APP1 Exif`）和 PNG（`eXIf` 块）中同步写入原生 TIFF/EXIF 字段。设为 `false` 时仅写入 XMP（及 PNG `iTXt`），不触碰 EXIF。 |
| **`mergeXmp`** | `boolean` | `false` | 针对 JPEG 和 PNG：设为 `true` 时，自动读取文件原有的 XMP / 文本块字段并与本次传入的 `tags` 合并，未传入的既有字段予以保留；默认 `false` 为整包替换模式。 |
| **`materialize`** | `boolean` | `true` | 设为 `false` 时仅执行探测与规划，返回 `{ ok: true, parts, size, report }`，不组装 `blob` 或 `stream`。 |
| **`chunkSize`** | `number` | `4194304` (4 MiB) | 当输出为 `ReadableStream` 时，从源按需拉取切片的单块字节大小（必须为正整数）。 |
| **`mimeType`** | `string` | 原源 `type` | 组装输出 `Blob` 时指定的 MIME 类型（如 `'video/mp4'`、`'image/jpeg'`）。 |

#### `WriteResult` 与 `report` 返回值结构

```ts
// 成功时 (result.ok === true)：
{
  ok: true,
  blob?: Blob,                         // 当数据源支持本地 slice (File/Blob/Uint8Array) 时返回
  stream?: ReadableStream<Uint8Array>, // 当数据源不支持本地 slice (HttpSource/NodeFileSource) 时返回
  parts: Array<
    | { kind: 'ref', start: number, end: number }
    | { kind: 'bytes', bytes: Uint8Array, what: string }
  >,
  size: number,                        // 输出文件总字节数
  report: {
    format: 'jpeg' | 'png' | 'mp4',
    strategy: 'header-in-place-insert' | 'moov-at-head-shift-offsets' | 'moov-at-tail-zero-offset',
    outputSize: number,
    delta?: number,                    // MP4 moov 净增长字节数（满足 8 字节对齐不变式）
    metaFormat?: 'mdir' | 'mdta',
    input: { size: number, mime: string },
    changes: {
      metadataBytes: number,
      bytesRemoved: number,
      netDelta: number,
      mediaBytesChanged: false,        // 恒为 false（媒体载荷零改动）
      reencoded: false,                // 恒为 false（零重编码）
    },
    metadata: {
      format: string,
      addedTags: string[],
      preservedTags?: number,
      existingContainers?: string[],
    },
    offsets: {
      shifted: boolean,
      delta: number,
      stcoUpgraded?: boolean,          // 是否触发了 stco -> co64 64 位偏移升级
      moovDelta?: number,
    },
    mp4Dates?: {                       // MP4 头部时间戳更新详情
      encodedDate: string | null,
      taggedDate: string | null,
      boxesPatched: number,
    },
    exif?: object,                     // 原生 EXIF 更新摘要
    mpf?: object,                      // 动态照片 MPF 偏移重定位摘要
    xmp?: object,                      // 扩展 XMP 分片清理摘要
    planning: {                        // 规划阶段锁定的 I/O 统计（不随流消费增长）
      readCalls: number,
      bytesRead: number,
      maxReadSize: number,
    },
    stats: {                           // 实时 I/O 统计视图
      readCalls: number,
      bytesRead: number,
      maxReadSize: number,
      sliceCalls: number,
    },
    notes: string[],
    warnings: string[],
  }
}
```

### 7.2 辅助函数与底层工具导出列表

除了 `writeTags` 与 `inspect`，包还导出了以下纯函数与类，供高级自定义流水线直接调用：

* **`capabilities(format)`**：返回 `{ format, supported, unsupported }`。
* **`sniff(headBytes, mimeType?)`**：根据前 32 字节魔数与 `ftyp` 品牌识别容器格式（精确区分 `'mp4'`、`'avif'`、`'heic'`、`'jpeg'`、`'png'`、`'riff'`、`'ebml'`、`'unknown'`）。
* **`validateTags(tags)` / `parseDateToMs(input)` / `parseGps(input)`**：独立调用参数校验、日期解析与 GPS 坐标归一化。
* **`toMp4EpochSeconds(input)` / `fromMp4EpochSeconds(sec)`**：Unix/ISO 时间与 MP4 1904 纪元秒数的双向转换。
* **`buildXmpPacket(tags)` / `parseXmpPacket(xmlString)`**：XMP 数据包的生成与解析。
* **`parseMpf(segBytes, segStart, fileSize)` / `rebaseMpf(segBytes, parsed, posMap)`**：CIPA DC-007 多图索引解析与偏移重算。
* **`probeMp4` / `planJpeg` / `planPng` / `planMp4` / `partsToStream`**：底层容器规划器与流组装器。
* **`Source` / `BlobSource` / `BufferSource` / `HttpSource`**（主入口）及 **`NodeFileSource` / `openFile`**（`@asinnn/stamp-js/node` 子入口）。

---

## 8. 内存模型与安全边界

### 8.1 MP4 的内存开销模型

对于 MP4/MOV，峰值内存**与媒体载荷（`mdat`）大小完全解耦**，仅取决于 `moov` 元数据盒的大小。实测重写期间的峰值额外堆内存约为 `moov` 大小的 **4.2 倍**（因为原 `moov`、重建后的 `moov` 与盒结构表短暂共存）：

| `moov` 大小 | 视频文件总大小 | 实测峰值额外 JS 堆内存 |
|---:|---:|---:|
| 0.08 MB | 0.4 MB | 0.62 MB |
| 0.38 MB | 1.9 MB | 2.15 MB |
| 1.53 MB | 7.6 MB | 6.53 MB |
| 3.82 MB | 19.0 MB / 8 GiB | 16.0 MB |

当遇到超长录制视频导致 `moov > 16 MiB` 时，库会在 `report.warnings` 中输出内存预估提示；调用方也可先通过 `inspect().mp4.moovSize` 进行预判。

### 8.2 当前版本刻意不做 / 主动拒绝的范围

* **不支持的容器格式**：`AVIF`、`HEIC`（使用 `meta/iloc` 项定址体系而非 `moov/udta`）、`WebP (RIFF)`、`WebM / MKV (EBML)`、`MP3`、`FLAC`。
* **分片 MP4（fMP4 / CMAF）**：含 `moof` / `sidx` 的流媒体分片文件主动拒绝。
* **单段超过 64 KiB 的 XMP**：JPEG 标准 `APP1` 段上限为 64 KiB，超长内容主动拒绝（返回 `XMP_TOO_LARGE`）。
* **C2PA / JUMBF 内容凭证**：写入元数据不会重新签名 C2PA 凭证（任何元数据修改都会使既有数字签名失效）。

---

## 9. 测试与独立验证体系

项目内置多层自动化测试与跨语言第三方工具（`ffmpeg` / `ffprobe` / `Pillow` / `ElementTree XML` / `exiftool`）独立交叉验证套件：

| 测试套件 | 运行命令 | 0.1.2 断言规模与覆盖范围 |
|---|---|---|
| **单元与回归测试** | `npm test` | **498 项**（Node 18）/ **505 项**（Node 20/22），含 4 GiB / 8 GiB 稀疏大文件、MPF、Extended XMP、18 字段矩阵、往返幂等（`M5`）及 v0.1.2 全部审计回归用例 |
| **畸形输入 / Fuzz 矩阵** | `npm run test:fuzz` | **196 项**不变式断言（对损坏输入验证：永不抛异常、拒绝必带 `errorCode` 且不产出文件、成功输出结构自洽、媒体载荷 SHA-256 不变、二次写入幂等） |
| **`ffprobe` / `ffmpeg` 交叉校验** | `npm run test:ffprobe` | **79 项**（覆盖正常 MP4/MOV、连续 3 次重复写入、19.6 MB 多块大视频、奇偶条目 `stco → co64` 边界升级及 `ffmpeg` 全帧解码播放兼容性验证） |
| **第三方工具互操作测试** | `npm run test:interop` | **31 项**基线（`Pillow` + `ElementTree` XML + `zlib.crc32` + `ffprobe` + `ffmpeg`）+ **13 项** `exiftool` CLI 断言 |
| **独立验证套件** | `npm run test:verify` | **90 项**基线（完全不依赖库自身断言，由独立解析器重建期望值）/ **139 项**（含实拍设备素材校验；无素材时自动跳过） |
| **真实设备素材测试** | `npm run test:real` | **51 项**（自动发现 `STAMP_TEST_MEDIA` 目录下的全部 JPEG/MP4/MOV，文件名无关） |

所有测试运行器均严格区分 `PASS`（通过）、`FAIL`（失败）、`SKIP`（因缺少可选外部二进制依赖或实拍素材而跳过，绝不计入 `PASS`）与 `NOT_RUN`（未执行）。

---

## 许可证

[MIT](LICENSE) · 更多内部设计细节请参阅 [ARCHITECTURE.md](ARCHITECTURE.md)、[CHANGELOG.md](CHANGELOG.md) 与 [VERIFICATION.md](VERIFICATION.md)。
