# stamp-js 测试报告

日期：2026-09-22 ｜ 环境：Node v22.22.1、exiftool 13.50、Pillow 12.1.1、Python 3.14
测试对象：`stamp-js`（`src/stamp.js` 核心 + `src/node.js` Node 源）
素材：`upload/` 下 4 个真实文件（vivo X200 Pro 动态照片 4.5 MB、Android 截图 567 KB、
微信导出 MP4、微信拍摄 MP4）

---

## 一、最终状态

| 层面 | 结论 |
|---|---|
| 核心功能 | ✅ 正确。元数据可被 exiftool 独立读出；媒体数据零改动；幂等；失败路径干净 |
| 大文件（≥4 GiB） | ✅ 已用**合法**的 4 GiB / 8 GiB 稀疏文件验证（含 co64 升级、moov-in-tail） |
| 动态照片（MPF） | ✅ 已实现并验证 |
| 扩展 XMP 清理 | ✅ 已实现并验证 |
| 运行时兼容性 | ✅ 依赖仅 BigInt / `setBigUint64` / `Blob` / `ReadableStream`（可选 `fetch`） |
| 遗留缺口 | 0（产品范围问题另列） |

### 测试套件

| 套件 | 命令 | 结果 |
|---|---|---|
| 单元 + 回归 | `npm test` | ✅ **275 passed** |
| 第三方工具互操作 | `npm run test:interop` | ✅ **38 passed** |
| 真实素材 | `npm run test:real` | ✅ **34 passed** |
| 独立验证（有素材） | `npm run test:verify` | ✅ **121 passed / 0 缺口** |
| 独立验证（模拟 CI 无素材） | `STAMP_TEST_MEDIA=/nonexistent …` | ✅ **74 passed**（自动跳过） |
| Node 大文件示例 | `node examples/node-large-file.mjs …` | ✅ 标签写入正确、`mdat` 逐字节一致 |

---

## 二、本轮最重要的发现：`>4 GB` 测试是假阳性

在压测大文件时发现原 `real sparse >4GB` 用例（`run.mjs` G14）**pass 但什么都没验证**：

```
真实文件          4,294,967,795 字节
夹具写入的 mdat 尺寸   299   ← (2^32 + 299) 写进 32 位字段时回绕
Node openAsBlob 报告  499   ← 同一原因，Blob.size 被截断成 32 位
库的视角          文件 499 字节，mdat 头 200 + 尺寸 299 = 499  ← 自洽！
```

**两个 32 位错误互相抵消**，于是测试全绿，却从未触及任何 64 位路径。

同时确认了一个真实的运行时坑：**Node 22 的 `fs.openAsBlob()` 对 ≥4 GiB 的文件
把 size 截断成 32 位**（精确边界：`0xFFFFFFFF` 正常，`0x100000000` 起变 0；
4.5 GiB→512 MiB、5 GiB→1 GiB、8 GiB→0）。库按 `src.size` 规划，因此这条路
会让它读到错误的容器结构。

### 修复

1. **夹具改为产出合法的大文件**：`mdat` 超过 2³² 时用 64 位 largesize 头；
   `stco` 装不下的偏移必须显式改用 `co64`（越界直接抛错，不再静默回绕）；
   新增 `layout: 'tail'`（ffmpeg 默认的 moov 在尾布局）。
2. **新增 `src/node.js` 的 `NodeFileSource`**（`stamp-js/node` 入口，用 `fstat`
   取真实 64 位大小，`fs.read` 随机读；不引入核心依赖、UMD 不含 `node:fs`）。
3. **重写大文件测试**，用 `NodeFileSource` 覆盖三种真实布局：

| 用例 | 文件 | 读取量 | 断言 |
|---|---|---|---|
| faststart + stco 逼近 2³² | 4.00 GiB | 66,158 B（0.0015%） | 升级为 co64、偏移 = 原值 + Δ、largesize 头保留 |
| faststart + 原本已是 co64 | 8.00 GiB | 66,254 B（0.0008%） | 保持 co64、偏移 = 原值 + Δ、最大值 > 4 GiB |
| moov 在文件尾（零偏移） | 8.00 GiB | 66,828 B（0.0008%） | 走零偏移策略、偏移完全不变 |

---

## 三、兼容性审计结果

### 真实世界写法（全部通过）

| 场景 | 结果 |
|---|---|
| `mdat` 的 size 字段为 0（延伸到文件尾） | ✅ 正确识别并写入 |
| `mdat` 使用 64 位 largesize | ✅ 保持并平移 |
| MOV 风格：`ftyp` + `wide` + `mdat` + `moov`（尾） | ✅ 未知顶层盒原样保留 |
| 两个 `mdat` 盒 | ✅ |
| `trak` 级 `udta` 存在 | ✅ 不破坏、不重复 |
| 多 `udta`、`mdta` freeform（`----`）条目 | ✅ 合并保留 |
| PNG：`iCCP` + `zTXt` + `tEXt` + `eXIf` + XMP 共存 | ✅ 只替换 XMP，其余保留 |
| 非 faststart（moov 在尾） | ✅ 零偏移策略 |
| 空 `moov`（没有 trak）等畸形输入 | ✅ 拒绝并给出原因 |

### 主动拒绝（消息更清晰）

| 输入 | 之前 | 现在 |
|---|---|---|
| AVIF | `moov box not found` | `AVIF image (ftyp brand "avif") is not supported: it carries metadata in meta/iloc, not moov/udta…` |
| HEIC / HEIF / `mif1` | 同上 | 指名品牌 |
| WebP（RIFF） | `unsupported format: riff` | 说明 WebP/RIFF 的 XMP 块尚未实现 |
| WebM / MKV（EBML） | `unsupported format: ebml` | 说明需要重算 SeekHead/Cues |
| `moov` 用 64 位 largesize 头 | 拒绝 | 拒绝（保持） |
| **空标签对象 `{}`** | **静默把已有 XMP 清空** | ✅ **拒绝**：`no writable tags supplied…` |

最后一条是本轮新增的**行为变更**：传 `{}`、只传未知字段、只传空字符串、
`keywords: []` 都会被拒绝，避免"看起来是空操作、实际清空了用户元数据"。

### 运行时依赖（据此写进 README）

`TextEncoder/TextDecoder`、`DataView`、`Blob`、`ReadableStream`、可选 `fetch`；
BigInt / `setBigUint64` **仅在处理含 64 位块偏移的 MP4 时**才会用到。
→ Node 18+、Chrome/Edge 67+、Firefox 68+、Safari 15+、Deno/Bun、Web Worker。
无 `replaceAll` / `.at()` / `structuredClone` / `Object.hasOwn` 等新语法依赖。

---

## 四、开发过程中被测试抓到的 bug（累计）

| # | 问题 | 是谁抓到的 |
|---|---|---|
| 1 | MPF 字节序标记位置漏算 4 字节段头（应段内 12/8，误写 8/4） | 合成夹具（vivo 真实文件恰好是 8，掩盖了它） |
| 2 | 误以为存在"头部带版本字段"的标准 MPF 布局 | 对照实验（exiftool 只认 `MPF\0` 紧跟字节序标记） |
| 3 | `>4 GB` 测试两处 32 位错误互相抵消 → 假阳性 | 大文件压测（本轮） |
| 4 | Node `openAsBlob` 截断 ≥4 GiB 文件大小 | 大文件压测（本轮） |
| 5 | 测试脚本断言键名错误导致 6 项假失败 + 崩溃 | 首轮（`XMP-dc:` / `ItemList:` / `Keys:` / 父盒头） |

---

## 五、质量保障现状

- **单元 275 项**覆盖：盒子结构、偏移平移、内存上限、拒绝路径、MPF、
  扩展 XMP、输入校验与大文件（含 4/8 GiB 稀疏文件）
- **独立验证 121 项**（无素材时 74 项）：期望值全部由 exiftool / Pillow / 手写解析器重建，
  不复用库自身断言 —— 这是唯一能发现"库和测试一起写错"的层
- **真实素材 34 项**：四个手机文件（含动态照片偏移核对）
- **CI**：Node 18/20/22 跑 `run.mjs`；`interop` job 跑 exiftool 互操作 +
  独立验证套件；新增 `dist/` 与 `src/` 同步检查（防止改了源码忘了构建 UMD）
- **文档**：README（面向非专家，含运行逻辑图解）+ 中文版（互相切换）、
  ARCHITECTURE、CHANGELOG、本报告

---

## 六、复现命令

```bash
cd /workspace/output/stamp-js

npm test                      # 275 项单元 + 回归（CI 门槛）
npm run test:interop          # 38 项第三方工具互操作
npm run test:real             # 34 项真实素材
npm run test:verify           # 121 项独立验证（无素材 74 项）

node examples/node-large-file.mjs input.mp4 out.mp4   # 大文件（≥4 GiB）用法

# 素材不在默认位置时
STAMP_TEST_MEDIA=/path/to/media npm run test:real
```

---

## 七、外部审查核实

对提交来的 5 条审查意见逐条实测核实（能实测的实测，测不了的明说）：

| # | 审查观点 | 核实结论 | 证据 |
|---|---|---|---|
| 1 | JPEG 只写 XMP，不写原生 TIFF/EXIF；部分读取方只认 IFD0，会让用户以为没写进去 | **机理成立**。实测写入后 XMP 侧齐全（Title/Creator/Description），而原生侧 `IFD0:ImageDescription` 为**空值**、`Artist` 不存在；相机原有的 `DateTimeOriginal`/`UserComment` 被正确保留未被覆盖。至于"Windows 属性页优先甚至只认 IFD0"的**程度**，本环境（Linux）无法验证，未予确认——Windows 属性系统对 JPEG 的 XMP 是有支持的，实际影响可能比审查描述窄，但老式查看器/部分构建确实读不到 | exiftool 实测（写入前后对照） |
| 2 | WebP/AVIF/HEIC 缺席；WebP 的 RIFF 处理相对简单；AVIF/HEIC 走 meta/iloc 较复杂 | **成立**。构造最小 WebP 验证：RIFF 内唯一需要改写的绝对量就是偏移 4 处的 size 字段（实测值 40 == 文件长−8），块内不含绝对文件偏移（VP8X 记画布尺寸、ANMF 记帧在画布内的位置）→ 追加 XMP 块 + 改 4 字节即可；AVIF/HEIC 现已被点名拒绝（`AVIF image (ftyp brand "avif") is not supported: … meta/iloc …`） | 构造 WebP/AVIF/HEIC 实测 |
| 3 | Blob 切片链过深在移动端 WebKit 有极小概率崩溃/超时 | **前提不成立**。实测全场景切片数 **2–6**：JPEG 插入 3、JPEG 替换 4、PNG 3、MP4 2–3、真实 vivo 动态照片 6；即便人为造 20 个扩展 XMP 分片，也只有 **4 片**（相邻删除区间会被 `buildParts` 自动合并）。移动端 WebKit 的具体行为无法在本环境验证 | 切片数实测 |
| 4 | 超大 moov 一次性读入，100MB+ 会触发 GC 抖动 | **成立，且已量化**。`src._read(moov.pos, moov.end)` 确实整块读入；实测峰值额外内存 ≈ **4.2× moov**（与媒体大小无关）：0.08 MB moov→0.62 MB、1.53 MB→6.53 MB、3.82 MB→16.0 MB。长录像的 moov 才大（3 小时 4K30 约几 MB，10 小时以上 20 MB+），100 MB 级 moov 需要上千万样本，属极端 | `--expose-gc` 内存实测 |
| 5 | （审查未提，顺带核验）未知盒子的保留承诺 | **成立**。在 moov 内注入未知子盒 `Xtra` + 私有载荷，写入后**完整保留**，仅 moov 尺寸正常增长 | 注入实验结果 |

### 本轮因此产生的改动

- **新增 moov 内存预警**：`moov > 16 MB` 时在 `report.warnings` 给出预估峰值（≈4.2×），
  并提示可用 `inspect().mp4.moovSize` 预判——第 4 条从"文档说明"升级为"可编程感知"
- **新增 4 项测试**：正常 moov 无预警、16 MB moov 触发预警、240 MB 文件仅读 header+moov
  （实测 16.9 MB，未触碰媒体）、未知盒子保留
- **文档写明边界**：README（中英）明确列出"JPEG 只写 XMP"的观感后果与"MP4 内存随 moov
  增长"的模型；ARCHITECTURE 补上内存实测表

### 后续建议（按价值排序）

1. **JPEG 写入原生 EXIF IFD0**（0x010E ImageDescription、0x013B Artist、0x9286 UserComment、
   0x0132 DateTime 镜像）——直接解决第 1 条的实际观感问题。EXIF APP1 是段内相对偏移的
   TIFF 结构、不含绝对文件偏移，可在现有 edits 机制内整段重建；文件无 EXIF 时需合成最小
   EXIF APP1。工作量中等，价值高。
2. **WebP 支持**——追加 XMP 块 + 改写 RIFF size（4 字节），实测无其它绝对偏移。
   工作量小，覆盖现代 Web 的主要格式占比。
3. **AVIF / HEIC**——meta/iloc 体系，需新增 item 并更新 iloc/iinf，工作量较大。
4. 大 moov 的分块/流式重写（把 4.2× 系数降下来）——收益有限，且会显著增加复杂度，暂不建议。

---

## 八、剩余的已知产品范围问题（非缺陷）

- **只写单个 XMP 段**：超过 64 KB 的元数据会被拒绝，而不是拆成扩展 XMP
- **不更新 C2PA / JUMBF 内容凭证**：写入后凭证会显示"已修改"（任何元数据编辑都如此）
- **空值处理不一致**：MP4 跳过空字符串，JPEG 会写成空字段（已记入 README 已知缺口）
- **`moov` 使用 64 位 largesize 头**：拒绝（极罕见）

---

## 九、第二轮外部审查核实（本轮）

对第二轮审查提出的两个"应当修的点"逐条**先复现、后修复**：

| # | 审查观点 | 复现结论 | 处理 |
|---|---|---|---|
| 1 | 多 `udta` + `mdta` 时，`keys` 表被合并却未重写每个数字索引条目的索引 → 语义错乱 | **真实 bug（P1）**。构造 udtaA `keys=[title,genre]`、udtaB `keys=[artist,genre]`，写入后合并表为 `[title,genre,artist]`；udtaB 的 `artist` 条目仍保留 `rawIndex=1`，按新表解析成 `title`。结果：输出出现两条 `title`、`artist` 消失 | 已修：保留条目的索引按合并后的表重写（新测试 G15，7 项断言） |
| 2 | 畸形 `meta` 子树只 `break` 不报错，上层仍认为可处理 → 坏盒之后的元数据在重写时消失 | **真实 bug**。在 `meta` 子盒序列中插入 `size=4` 的坏盒，其后放带标记的未知盒：写入返回 `ok:true`，但标记数据**静默丢失** | 已修：遍历改为精确铺满检查（`listChildrenEx`），任何无法完整遍历的 `moov`/`meta`/`ilst`/`keys` 一律拒绝（新测试 G16，5 项断言） |

### 本轮因此产生的改动

- **索引重映射**：`parseExistingIlst()` 为每个条目记录其解析出的键名；
  合并 `keys` 表后，保留条目的数字索引重写为新表位置（`remapMdtaEntryIndex`）。
  单 `udta` 文件行为不变，幂等性保持（重写后二次写入字节一致）。
- **严格拒绝**：新增 `listChildrenEx()` 返回 `{ children, malformed }`；
  畸形子树、无 `meta` 的 `udta`、无法解析的数字索引、不铺满的 `keys` 表
  都会让 `writeTags()` 以 `REFUSE: …` 返回原因。
- **`inspect()` 同步预检**：`mp4.safeToWrite=false` + `mp4.metadataMalformed=<原因>`，
  调用方可在写入前发现同一问题。
- **措辞修正**：README（中英）明确本库是"随机访问式元数据手术 + 引用切片组装 +
  流式输出"，而非 `输入流 → transform → 输出流` 管道——避免"streaming 修改"的过度联想。
  同时把 "malformed metadata tree" 补进主动拒绝清单。
- **测试**：新增 G15/G16 共 12 项断言（208 → 220），其中 G16 还包含一个
  "格式正确的未知 meta 子盒必须保留"的对照用例，防止严格化导致过度拒绝。
- **独立验证新增 J 节**（`test/independent-verify.py`）：构造多 `udta` + `mdta` 文件写入后，
  用 **exiftool** 读出 `Keys:Artist` / `Keys:Title` / `Keys:Genre` 作为期望值，
  第三方确认索引已重映射（修复前该节会看到 artist 条目被解析成 title）。
  5 项断言：无素材 54 → 59，有素材 101 → 106。

### 关于"世界唯一"类表述

代码与文档（README 中英、ARCHITECTURE、package.json）**未出现**"世界唯一/第一/唯一实现"
等表述，无需删改；README 的定位陈述为"不把媒体数据读入内存"，属可验证的机制描述。

---

## 十、真实平台素材实测（15 个文件）

素材：X（Twitter）、微博、微信、QQ、vivo X200 Pro、iPhone、vivo/MediaTek 视频，
共 10×JPEG、1×PNG、4×MP4，合计 47.2 MB。

### 素材特征（决定了测试覆盖面）

| 文件 | 特征 |
|---|---|
| `2voevxs1…jpg`、`4w9s933a…jpg` | iPhone 17 Pro EXIF；**EOI 之后有 144 B 的 vivo 动态照片标记** |
| `IMG_20260911_154429.jpg` | vivo X200 Pro；EXIF+ICC；**9 个 65 KB 私有 APP 段**；EOI 后 357 B `streaminfo`+`livephoto` 尾巴 |
| `wx_camera_*.jpg` | 微信相机；JFIF+ICC |
| `爆辣…_新时代牛马饲料.jpg` | 渐进式；**已有 XMP**（X 平台 `X-Vault` 写入） |
| `爆辣…_三角洲….jpg` | 渐进式；仅 JFIF+ICC |
| `3zk3ys1…jpg` 等 4 张 | 平台下载后元数据已被剥离，只剩 JFIF |
| `Image_1790100230865_549.png` | 4.1 MB RGBA，95 个 IDAT；**5 个 `exif:*` tEXt 块** |
| `5341362783784820_weibo.mp4` | faststart；已有 mdta（Lavf60 写入的 Keys） |
| `video_20260909_214517.mp4` | **moov 在尾**；已有 `moov/meta`（QuickTime 风格）；`vivoMediaExtInfo` uuid 盒 |
| `爆辣…_出生年份….mp4` | faststart；无任何元数据 |
| `爆辣…_水个视频….mp4` | faststart；已有 mdir（ItemList） |

**注意（如实说明）**：这 15 个文件里**没有**内嵌第二帧/视频的动态照片
（无 `APP2 MPF`、无追加 MP4），那两张 vivo 图只带动态照片 *ID 标记*。
因此本轮**没有**覆盖 MPF 偏移重算路径——该路径由 `run.mjs` H 节（39 项断言）
与 `independent-verify.py` I 节（exiftool 交叉核对）覆盖。

### 结果

| 阶段 | 结果 |
|---|---|
| 修复前 | 15 个中 **14 个写入成功**、**1 个被拒绝**（`video_20260909_214517.mp4`） |
| 修复后 | **15 / 15 全部成功**，二次写入 **15 / 15 字节一致（幂等）** |

独立校验（不复用库的断言，全部由 exiftool / Pillow / 手写解析器给出）：

- **JPEG**：输出有且仅有 1 个新 XMP、无残留扩展 XMP；**其余全部段按序逐字节保留**
  （含 vivo 的 9 个私有 APP 段、ICC、EXIF）；**从 SOS 到文件尾逐字节一致**
  （含 EOI 之后的 144 B / 357 B 动态照片尾巴）；Pillow 像素逐字节一致。
  XMP 插入点落在全部私有段之后、DQT 之前，故私有段与尾部记录的绝对偏移不受影响。
- **PNG**：IDAT 逐字节一致、5 个 `exif:*` tEXt 块保留、像素逐字节一致。
- **MP4**：`mdat` 载荷 sha256 一致；stco/co64 表结构一致；**3407 个样本偏移在输出中
  逐个指向与输入完全相同的字节（0 处不一致）**，偏移位移恰为 moov 增量（moov 在尾时为 0）；
  exiftool 读出的时长/帧率/分辨率/编码/码率/声道与输入完全一致；既有 `Keys:AndroidVersion`、
  `Keys:IsOpenGop`、`Keys:MoovAhead` 等保留。
- **vivo 视频**：占位 `udta` 逐字节未动；`moov/meta` 由 118 B 变为 465 B 且**仍是
  QuickTime 风格**；moov 增长 347 B；`AndroidVersion` 保留。

### 本轮修掉的缺陷（由真实素材暴露）

1. `findChild()` 未限定父盒范围，会把 `moov/meta` 当作 `udta/meta` 读到。
2. `meta` 子盒只按 ISO FullBox（+12）解析，QuickTime 布局（+8）读成垃圾。
3. `moov/meta`（Android/MediaTek 实际使用的元数据位置）根本不支持。
4. 无 `meta` 的 `udta` 占位盒被当作"无法解析"→ 过度拒绝。

修复见 CHANGELOG；新测试 **G17（17 项）** 覆盖 QuickTime/ISO 两种 `moov/meta`、
无 meta 的 udta 保留、©-atom udta 拒绝；独立验证新增 **K 节（6 项）**
用 exiftool 交叉核对 `moov/meta` 场景。

### 读取量实测（本批素材）

| 文件 | bytesRead | 说明 |
|---|---|---|
| 普通 JPEG（头 <64 KB） | 65,536 | 只读文件头 |
| `IMG_20260911_154429.jpg`（9×65 KB 私有段） | 1,376,224 | 头部长达 632 KB，随私有段增长 |
| `5341362783784820_weibo.mp4`（moov 18 KB） | 83,807 | 只读容器头 + moov |
| `视频 video_20260909`（moov 在尾，10 KB） | 87,452 | 只读容器头 + moov，未触碰 17.7 MB 媒体 |
| `爆辣…_出生年份.mp4`（moov 62 KB） | 128,059 | 只读容器头 + moov |

即：**读取量与媒体大小解耦**（vivo 17.7 MB 视频只读 87 KB），
而带 588 KB 私有段的 JPEG 因为头部本身大，读取量随之到 1.3 MB —— 属预期行为。

---

## 十一、第三轮外部审查核实（发布前审计清单）

对送审清单里的 9 类主张逐条**先复现、后判定**（能实测的实测，文档类核对原文）：

| 编号 | 主张 | 核实结论 | 处理 |
|---|---|---|---|
| BUG-01 | MP4 的 `copyright`/`keywords` "返回 ok:true 但没写进去" | **属实**。实测 `{copyright:'COPY'}`、`{keywords:[...]}` 都返回 `ok:true` 且文件里找不到内容 | 已修：`copyright` 真正写入（mdir `cprt` / mdta `copyright`，均由 exiftool 反查确认）；`keywords` 明确拒绝 |
| BUG-02 | 不同 container 的 hdlr 类型会被混合 | **属实**。构造 mdir+mdta 混合容器，输出出现"hdlr=mdta 但 ilst 里带 `©cmt`"的混合 ilst | 已修：`auto` 下各容器按自身格式就地更新，永不混合；新增 G19 |
| BUG-03 | HTTP Range 只校验 206，不校验 `Content-Range` | **属实**。实测服务器返回错位区间时被当作正确数据接受 | 已修：校验 `Content-Range` 起止 + 长度，`RANGE_MISMATCH` 拒绝 |
| BUG-04 | `init()` 在无 Range 时未消费 response body | **属实**。实测 200 分支未调用 `cancel()` | 已修：两条路径都在 `finally` 中释放 body |
| BUG-05 | JPEG/PNG 头扫描有 8 MiB 硬上限，README 未写明 | **属实**（代码确认 `MAX_HEAD = 8 << 20`，README 未提及） | 已修文档：README 中英明确写出边界与触发条件 |
| BUG-06 | metadata 子盒的 largesize 支持不完整 | **属实**（子盒 `size==1` 不被支持）。但原描述"会认为 size<8"不准确——旧代码会**静默 break**，本轮之前已改为拒绝 | 已修诊断：现在明确报 `uses a 64-bit largesize header`，并在 README 写明 |
| BUG-07 | `moov` 自身 largesize 直接拒绝 | **属实**，但"README 没写"**不准确**——README 的 Refused 清单里原本就有这一条 | 已改进：提早检查、报文精确（`UNSUPPORTED_LARGESIZE`），README 补上"64 位支持"的确切范围 |
| BUG-08 | `planStcoUpgrade()` 缺不收敛保护 | **属实**。原代码打满 64 次后直接返回**过期的 growth**，会让所有偏移按错误增量平移 | 已修：不收敛时 `CONVERGENCE` 拒绝 |
| BUG-09 | API 的 tag 模型对 MP4 名不副实 | **部分属实**：MP4 确实只有 6/8（与 BUG-01 同源），但"PNG 7/8"**不准确**——实测 PNG 经 XMP 支持全部 8 个字段（`XMP-dc:Subject` 已确认） | 已修：`capabilities()` + `report.unsupportedTags` + `inspect().capabilities`；README 给出能力矩阵 |

### 关于建议中不准确/需要修正的两处

1. **`©cpy` 不是可用的映射**。建议里写 `copyright → ©cpy`，但实测 exiftool 13.50 对 ilst 里的
   `©cpy` **完全不识别**；`cprt` 才会被读成 `ItemList:Copyright`。mdta 侧用键名 `copyright`
   （exiftool 读作 `Keys:Copyright`）。故采用 `cprt` / `copyright`。
2. **"mixed handler 一律拒绝"过于激进**。`moov/udta/meta`(mdir) + `moov/meta`(mdta) 是
   iOS/QuickTime 的**正常布局**，一律拒绝会把大量真实文件拒之门外。已改为
   "各容器按自身格式就地更新"，既不猜也不拒。

### 关于测试缺口的核实

清单提出的不变式断言，实测**大部分已存在**：
- MP4 `mdat` 逐字节 + 每个样本 64 字节回查 + stco 统一平移量：`independent-verify.py` B 节已有；
- JPEG 像素哈希 + 插入点之后字节不变：已有；
- **PNG IDAT 哈希确实缺失**（只校验了 CRC，而 CRC 只能证明输出自洽）。

因此本轮补齐：`run.mjs` G22 新增 PNG IDAT / JPEG 熵编码段 / MP4 mdat 三处 sha256 不变式；
`independent-verify.py` L 节新增 PNG IDAT 哈希 + MP4 copyright 的 exiftool 反查。

### 本轮结论

清单中 **7 个 P0/P1 全部属实并已修复**，另 2 条（BUG-06/07）是**已声明的能力边界**，
本轮只改进了诊断与文档。建议中 3 处需修正（`©cpy`、mixed handler 拒绝过激、
"PNG 7/8"不准确）。清单未再发现架构级问题。
测试数：单元 **237 → 275**，独立验证 **65 → 74**（无素材口径）。

`report.errorCode` 已覆盖 26 个用户可见的拒绝点（`NO_TAGS` / `UNSUPPORTED_TAG` /
`UNSUPPORTED_FORMAT` / `MALFORMED_CONTAINER` / `UNSUPPORTED_LARGESIZE` /
`FRAGMENTED_MP4` / `XMP_TOO_LARGE` / `MPF_INVALID` / `CO64_REQUIRED` /
`BAD_OPTION` / `CONVERGENCE` / `RANGE_UNSUPPORTED` / `RANGE_MISMATCH`）；
剩余 21 处 `throw` 是源抽象与内部不变式（如 `Source.read() not implemented`、
`edit ranges overlap`），MPF 内部细节则由外层 `MPF_INVALID` 统一包装。

---

## 十二、第四轮：真实素材 34 个 + 畸形/fuzz 矩阵 + 三项工程收尾

### 素材

`upload/` 共 **34 个**（69.6 MB）：新增 19 个，含几类此前没覆盖过的形态：

| 新素材 | 特点 |
|---|---|
| `1767180493359.jpg` | **扩展名是 .jpg，内容其实是 PNG**（库按内容判别，正确识别为 png） |
| `1771397403249.png` 等 3 个 | PNG + **C2PA `caBX` 盒** + `zTXt` + `sBIT` |
| `IMG_20260907_194031.png` | PNG + `eXIf` + `iCCP` |
| `IMG_20260915_114241.jpg` | 又一张 vivo X200 Pro（9 个 65 KB 私有 APP 段 + 357 B 尾巴） |
| `video_20260909_214438.mp4` | 又一个 vivo/MediaTek 视频：`moov` 在尾 + **`moov/meta`（QuickTime 风格）** + `uuid` 盒 |
| `IMG_20260829_205846.jpg`、`Screenshot_20260903_230603.jpg` | 带 385 B / 285 B 尾部载荷 |

### 结果

| 项目 | 结果 |
|---|---|
| 写入 | **34 / 34 成功**，幂等 34 / 34 |
| 独立校验（`_verify.py`，按内容判别格式） | **304 / 304 通过** |
| 视频样本寻址（`_verify_seek.py`） | 4 个视频、**3413 个样本点 0 不一致**，流属性一致 |
| 新增不变式 | PNG「非库自有 chunk 按序逐字节保留」（覆盖 caBX/eXIf/iCCP/sBIT）、MP4「moov 之外顶层盒逐字节不变」（覆盖 uuid/free） |

### 本轮新增的工程三项

1. **畸形/fuzz 矩阵** `test/malformed.mjs`（`npm run test:fuzz`，196 断言）。
   不写死期望值，而是对每个损坏输入断言同一组不变式：
   I1 不抛异常、I2 失败必带原因与 errorCode 且不产出、I3 输出结构自洽、
   I4 媒体载荷 sha256 不变、I5 二次写入字节一致。
   **它抓到一个真 bug**（见下）。
2. **`report` 结构化字段**（附加式，旧字段不变）：`input` / `changes` /
   `metadata` / `offsets`。
3. **CI 三层分级** + `test/ffprobe-crosscheck.py`（唯一需要 ffprobe 的套件，
   验证标签写入后视频仍能解出相同的流/编解码/时长）。
   两个 Python 套件缺依赖时一律**退出码 2** 而非 traceback。

### 本轮修掉的缺陷

| # | 问题 | 证据 |
|---|---|---|
| 1 | **`stco`/`co64` 声明 count 超出盒子时，会读到盒子外并把补丁写进相邻盒** | canary 测试：`AA AA AA AA` 被改成 `AA AA AB 0A`；现已 `MALFORMED_CONTAINER` 拒绝 |
| 2 | 含**多个 `moov`** 的文件被照常改写，只更新第一个 → 其余指向旧布局 | 新增拒绝 |
| 3 | PNG 头扫描的拒绝缺 `errorCode` | fuzz I2 抓到 |
| 4 | 2^53 溢出报"box exceeds 2^53 bytes"，但触发者可能是 64 位**偏移**而非盒尺寸 | 报文已改为涵盖两者 |

### 汇总

| 套件 | 断言数 | 结果 |
|---|---|---|
| 单元 + 回归 `npm test` | 298 | ✅ |
| 畸形/fuzz `npm run test:fuzz` | 196 | ✅ |
| 互操作 `test:interop` | 38 | ✅ |
| 独立验证 `test:verify` | 74（CI）/ 121（含素材） | ✅ |
| ffprobe `test:ffprobe` | — | 本机无 ffprobe，按设计 SKIP（exit 2） |

---

## 十三、第五轮：JPEG 原生 EXIF (IFD0) + 发布前收尾

### 新增能力：JPEG 原生 EXIF

XMP 之外，`title` / `artist` / `copyright` / `date` 现在同时写入 **IFD0 原生字段**
（`0x010E` ImageDescription、`0x013B` Artist、`0x8298` Copyright、`0x0132` DateTime），
因此在忽略 XMP 的 Windows 资源管理器构建里，"属性 → 详细信息"的标题/作者也能显示。

**关键做法**：TIFF 内所有偏移都相对 TIFF 头，所以只把 IFD0 **重建到块尾追加区**、
改 TIFF 头的 IFD0 指针 —— 其余字节原地不动。这带来一个可测试的强不变式：

> 原 TIFF 仍是新 TIFF 的**逐字节前缀**（除 4 字节 IFD0 指针）。

后果是 GPS、ExifIFD、IFD1/缩略图、厂商 MakerNotes 的**字节与偏移全部保持有效**，
包括那些内部偏移未公开、一旦"解析再重写"就会被写坏的块。

**刻意不镜像**（避免破坏相机数据）：

| 字段 | 原因 |
|---|---|
| `software` → `0x0131` | 该标签存的是**相机固件串**（如 "MediaTek Camera Application"）；本库的 `software` 语义是"写入工具"（XMP `CreatorTool`），覆写会丢信息 |
| `date` → ExifIFD `0x9003` | `DateTimeOriginal` 是**真实拍摄时间**，也正是 Explorer 的"拍摄日期"；覆写等于改写历史 |
| `comment` / `url` / `keywords` | EXIF 无对应位置（UserComment 另有字符集约定），XMP 已覆盖 Windows 的"备注" |

### 验证

| 项目 | 结果 |
|---|---|
| 单元测试新增 K 节 | 25 项断言（含"仅追加前缀"不变式、幂等、`nativeExif:false`、无 EXIF 时合成、坏 EXIF 降级为 warning） |
| 独立验证新增 M 节 | 16 项（exiftool 反查 4 个原生字段、其余字段零差异、`-validate` 仍 OK） |
| 真实相机素材 | 4 张（vivo×3 带 **10 个 GPS 标签**、iPhone×1 带 **Apple MakerNotes**）：目标字段写入、**其余字段零差异**、Make/Model 保留 |
| 34 个素材全量回归 | 34/34 成功且幂等；独立校验 **326/326**；5 个带 EXIF 的素材**逐一通过"仅追加"不变式** |

### 发布前收尾

- 删除一次性脚本 `verification/verify-critique.mjs`（其结论已并入本文档 § 九/§ 十一），
  `verification/` 目录移除。
- 新增 `.gitignore`（`node_modules/`、`tmp-interop/`、`__pycache__/`、`*.pyc`）。
- `package.json` 增加 `prepublishOnly` 守卫：发布前强制 `build + test + fuzz`。
- 确认 `dist/package.json`（`{"type":"commonjs"}`）**不是残留**：它让根包为 ESM 时
  仍能 `require('./dist/stamp.umd.js')`，CI 的 UMD smoke 依赖它。

### 第六轮补充：PNG eXIf 与 UserComment

| 项目 | 说明 |
|---|---|
| PNG `eXIf` | 与 JPEG 同源：TIFF 块直接放在 `eXIf` 块里（无 `Exif\0\0` 前缀）。示例：`IMG_20260907_194031.png` 原地更新、`consultant.png` 等无 eXIf 的文件补齐一段 |
| PNG 的日期 | **不在 eXIf 里重复写**：PNG 有规范的 `Creation Time` 文本块（本库已在写），eXIf 里放 EXIF 日期会被校验器判为 `Non standard PNG date/time format` |
| PNG 的 exif-as-text | 语料中 4 个 PNG 用 ImageMagick 的 `Raw profile type APP1`（zTXt）保存 EXIF，exiftool 优先读它 → 本库在 `report.warnings` 中明确告知"读者可能仍显示旧值" |
| `UserComment` | **仅在缺失/为空时写入**。实测 vivo/MediaTek 在该标签存放处理参数（`filter: 0; module: portrait; …`）且**不带规范的 8 字节字符集前缀**——早期实现会把它当空值覆盖，已修正为完整保留并在 `report.notes` 说明 |
| 非 ASCII 备注 | 写 `UNICODE\0` + 带 BOM 的 UTF-16LE（实测无 BOM 时 exiftool 按大端解析 → 乱码） |
| 真实素材复核 | vivo×2 的 UserComment 逐字节保留；Apple/无该标签的文件正常填充；34 素材 **334/334** 独立校验通过 |

**待补充的发布元数据**（需仓库所有者提供，见 `RELEASING.md`）：
`repository` / `bugs` / `homepage` / `author` / npm 包名（`stamp-js` 在 npm 上极可能已被占用）。





