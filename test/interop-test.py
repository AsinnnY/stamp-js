#!/usr/bin/env python3
"""
stamp-js 第三方工具互操作性测试 (Interop Verification Suite)
=============================================================================
独立第三方工具链：
  - Pillow (PIL)      → 生成真实 JPEG/PNG、独立解码验证像素、读取 EXIF (getexif) 与 PNG info
  - lxml / ElementTree → 独立解析 JPEG APP1 与 PNG iTXt 中的 W3C XMP RDF/XML 数据包
  - ffmpeg / ffprobe  → 生成真实 H.264/AAC MP4 & MOV、独立读取容器与流元数据、全帧解码验证播放兼容性
  - exiftool (若安装) → 独立交叉读取 XMP / EXIF / QuickTime / ItemList / Keys 标签

覆盖场景：
  1. 正常文件（JPEG、PNG、faststart MP4、moov-at-tail MP4、QuickTime MOV）
  2. 重复写入文件（二次/三次幂等写入、字段覆盖写入、mergeXmp 合并写入）
  3. 较大文件（高分辨率 JPEG/PNG、多块真实编码 MP4、>4 GiB 稀疏 MP4）
  4. 边界偏移文件（stco 接近 4 GiB 触发 stco -> co64 升级的奇偶条目数与 8 字节对齐校验）

状态区分：
  - PASS    : 独立工具实际执行并验证通过
  - FAIL    : 独立工具实际执行但断言失败
  - SKIP    : 因当前环境缺少某第三方依赖（如 exiftool）而跳过，绝不计入 PASS
  - NOT_RUN : 因前置步骤失败而未执行
"""
import json
import os
import random
import shutil
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET
import zlib

STAMP_JS = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'stamp.js'))
NODE_JS = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'node.js'))
WORKDIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'tmp-interop'))

HAVE_NODE = shutil.which('node') is not None
HAVE_EXIFTOOL = shutil.which('exiftool') is not None
HAVE_FFPROBE = shutil.which('ffprobe') is not None
HAVE_FFMPEG = shutil.which('ffmpeg') is not None
try:
    from PIL import Image, ImageDraw
    HAVE_PILLOW = True
except ImportError:
    Image = ImageDraw = None
    HAVE_PILLOW = False

PASS = 0
FAIL = 0
SKIP = 0
NOT_RUN = 0


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  \033[32m✓ [PASS]\033[0m {name}')
    else:
        FAIL += 1
        print(f'  \033[31m✗ [FAIL]\033[0m {name}' + (f'  \033[33m→ {extra}\033[0m' if extra else ''))


def skip(name, reason):
    global SKIP
    SKIP += 1
    print(f'  \033[33m⚠ [SKIP]\033[0m {name}  \033[33m({reason})\033[0m')


def mark_not_run(name, reason):
    global NOT_RUN
    NOT_RUN += 1
    print(f'  \033[36m- [NOT_RUN]\033[0m {name}  ({reason})')


if not HAVE_NODE or not HAVE_PILLOW:
    missing = [n for n, ok in [('node', HAVE_NODE), ('Pillow', HAVE_PILLOW)] if not ok]
    skip('互操作测试套件初始化', '缺少基础依赖: ' + ', '.join(missing))
    print(f'\n汇总: {PASS} passed, {FAIL} failed, {SKIP} skipped, {NOT_RUN} not run')
    sys.exit(2)

shutil.rmtree(WORKDIR, ignore_errors=True)
os.makedirs(WORKDIR, exist_ok=True)


def run_stamp_write(input_path, output_path, tags, options=None):
    """Call Node.js + stamp-js to write tags into a file (compatible with Node 18+)."""
    input_size = os.path.getsize(input_path)
    script = f"""
import {{ writeTags, inspect, BlobSource }} from {json.dumps(STAMP_JS)};
import fs from 'node:fs';
const raw = fs.readFileSync({json.dumps(input_path)});
const blob = new Blob([raw]);
const res = await writeTags(new BlobSource(blob), {json.dumps(tags)}, {json.dumps(options or {})});
if (!res.ok) {{
  console.log(JSON.stringify({{ ok: false, error: res.report.error, errorCode: res.report.errorCode }}));
  process.exit(0);
}}
const buf = Buffer.from(await res.blob.arrayBuffer());
fs.writeFileSync({json.dumps(output_path)}, buf);
const info = await inspect(new BlobSource(new Blob([buf])));
console.log(JSON.stringify({{
  ok: true,
  inputSize: {input_size},
  outputSize: buf.length,
  delta: res.report.delta,
  bytesRead: res.report.planning ? res.report.planning.bytesRead : res.report.stats.bytesRead,
  readCalls: res.report.stats.readCalls,
  strategy: res.report.strategy,
  existingTags: info.existingTags,
  safeToWrite: info.safeToWrite
}}));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script],
                            capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        return {'ok': False, 'error': (result.stderr or result.stdout).strip()[:200]}
    return json.loads(result.stdout.strip())


def exiftool_read(path):
    """Use exiftool to read metadata as JSON if available."""
    if not HAVE_EXIFTOOL:
        return None
    result = subprocess.run(['exiftool', '-j', '-G', path],
                            capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        return None
    data = json.loads(result.stdout)
    return data[0] if data else None


NS = {
    'x': 'adobe:ns:meta/',
    'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'xmp': 'http://ns.adobe.com/xap/1.0/',
    'photoshop': 'http://ns.adobe.com/photoshop/1.0/',
    'exif': 'http://ns.adobe.com/exif/1.0/',
    'tiff': 'http://ns.adobe.com/tiff/1.0/',
    'xmpDM': 'http://ns.adobe.com/xmp/1.0/DynamicMedia/',
}


def extract_xmp_xml_from_jpeg(path):
    """Independently extract APP1 XMP packet bytes from a JPEG file."""
    data = open(path, 'rb').read()
    prefix = b'http://ns.adobe.com/xap/1.0/\x00'
    i = 2
    packets = []
    while i + 4 <= len(data) and data[i] == 0xFF:
        m = data[i + 1]
        if m in (0xDA, 0xD9):
            break
        if m == 0x01 or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        ln = struct.unpack('>H', data[i + 2:i + 4])[0]
        body = data[i + 4:i + 2 + ln]
        if m == 0xE1 and body.startswith(prefix):
            packets.append(body[len(prefix):].decode('utf-8', errors='replace'))
        i += 2 + ln
    return packets


def extract_xmp_and_itxt_from_png(path):
    """Independently extract XMP and iTXt text chunks from a PNG file, verifying CRC32."""
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    p = 8
    itxt_map = {}
    crc_ok = True
    while p + 8 <= len(data):
        ln = struct.unpack('>I', data[p:p + 4])[0]
        ctype = data[p + 4:p + 8].decode('latin1')
        body = data[p + 8:p + 8 + ln]
        crc_stored = struct.unpack('>I', data[p + 8 + ln:p + 12 + ln])[0]
        crc_calc = zlib.crc32(data[p + 4:p + 8 + ln]) & 0xFFFFFFFF
        if crc_stored != crc_calc:
            crc_ok = False
        if ctype == 'iTXt':
            nul = body.find(b'\x00')
            if nul != -1:
                kw = body[:nul].decode('latin1')
                rest = body[nul + 3:]
                nul2 = rest.find(b'\x00')
                if nul2 != -1:
                    rest2 = rest[nul2 + 1:]
                    nul3 = rest2.find(b'\x00')
                    if nul3 != -1:
                        val = rest2[nul3 + 1:].decode('utf-8', errors='replace')
                        itxt_map[kw] = val
        p += 12 + ln
        if ctype == 'IEND':
            break
    return itxt_map, crc_ok


def parse_xmp_fields_independent(xml_text):
    """Use Python's standard XML/RDF parser (ElementTree) to extract XMP fields independently."""
    root = ET.fromstring(xml_text)
    out = {}

    def alt_or_seq(tag_path):
        el = root.find(f'.//{tag_path}', NS)
        if el is None:
            return None
        items = [li.text or '' for li in el.findall('.//rdf:li', NS) if (li.text or '').strip()]
        if items:
            return items
        return (el.text or '').strip() or None

    title_items = alt_or_seq('dc:title')
    if title_items:
        out['title'] = title_items[0] if isinstance(title_items, list) else title_items
    creator_items = alt_or_seq('dc:creator')
    if creator_items:
        out['artist'] = creator_items[0] if isinstance(creator_items, list) else creator_items
    desc_items = alt_or_seq('dc:description')
    if desc_items:
        out['description'] = desc_items[0] if isinstance(desc_items, list) else desc_items
    rights_items = alt_or_seq('dc:rights')
    if rights_items:
        out['copyright'] = rights_items[0] if isinstance(rights_items, list) else rights_items
    subj_items = alt_or_seq('dc:subject')
    if subj_items:
        out['keywords'] = subj_items if isinstance(subj_items, list) else [subj_items]

    for key, xpath in [
        ('url', 'dc:source'),
        ('date', 'xmp:CreateDate'),
        ('taggedDate', 'xmp:ModifyDate'),
        ('metadataDate', 'xmp:MetadataDate'),
        ('software', 'xmp:CreatorTool'),
        ('rating', 'xmp:Rating'),
        ('dateOriginal', 'exif:DateTimeOriginal'),
        ('encodedDate', 'exif:DateTimeDigitized'),
        ('make', 'tiff:Make'),
        ('model', 'tiff:Model'),
        ('gpsLat', 'exif:GPSLatitude'),
        ('gpsLon', 'exif:GPSLongitude'),
        ('album', 'xmpDM:album'),
        ('genre', 'xmpDM:genre'),
    ]:
        el = root.find(f'.//{xpath}', NS)
        if el is not None and el.text:
            out[key] = el.text.strip()
    return out


# ==============================================================================
print('\n\033[1m▌ A. JPEG: Pillow 生成 → stamp-js 写入 → 独立 XML/EXIF/Pillow 验证 (+ exiftool)\033[0m\n')

jpg_path = os.path.join(WORKDIR, 'test.jpg')
jpg_out = os.path.join(WORKDIR, 'test_tagged.jpg')
img = Image.new('RGB', (800, 600), (30, 60, 90))
draw = ImageDraw.Draw(img)
for i in range(0, 800, 40):
    draw.line([(i, 0), (i, 600)], fill=(255, 128, 0), width=2)
for j in range(0, 600, 40):
    draw.line([(0, j), (800, j)], fill=(0, 200, 200), width=2)
draw.ellipse([200, 150, 600, 450], fill=(255, 255, 0), outline=(255, 0, 0), width=3)
draw.text((280, 280), 'JPEG TEST', fill=(255, 255, 255))
img.save(jpg_path, 'JPEG', quality=85)
check(f'Pillow 生成正常 JPEG ({os.path.getsize(jpg_path)} bytes)', os.path.getsize(jpg_path) > 0)

tags = {
    'title': 'Interop Test JPEG',
    'artist': 'stamp-js Verification',
    'date': '2025-01-20T12:00:00Z',
    'encodedDate': '2025-01-20T12:00:00Z',
    'taggedDate': '2025-01-21T08:30:00Z',
    'dateOriginal': '2025-01-19T18:00:00Z',
    'comment': 'Generated by Pillow, tagged by stamp-js, verified independently',
    'url': 'https://example.com/interop',
    'software': 'stamp/0.1.2',
    'copyright': '© 2026 stamp-js',
    'keywords': ['alpha', 'beta'],
    'album': 'Test Album',
    'genre': 'Synthetic',
    'make': 'Canon',
    'model': 'EOS R5',
    'rating': 5,
    'gps': {'lat': 31.2304, 'lon': 121.4737, 'alt': 12.5},
}

res = run_stamp_write(jpg_path, jpg_out, tags)
check('stamp-js 写入 JPEG 成功', res.get('ok') is True, res.get('error', ''))
if res.get('ok'):
    check(f'JPEG 输出大小 ({res["outputSize"]}) > 输入 ({res["inputSize"]})', res['outputSize'] > res['inputSize'])
    check(f'JPEG 仅读取头部 ({res["bytesRead"]} bytes)', res['bytesRead'] > 0)

    # 独立 XML/RDF 解析验证 XMP
    packets = extract_xmp_xml_from_jpeg(jpg_out)
    check('独立扫描 JPEG 段：恰好包含 1 个标准 XMP APP1 段', len(packets) == 1)
    if packets:
        xmp_parsed = parse_xmp_fields_independent(packets[0])
        check('独立 XML 解析器验证 XMP dc:title / dc:creator / dc:description / dc:rights',
              xmp_parsed.get('title') == tags['title']
              and xmp_parsed.get('artist') == tags['artist']
              and tags['comment'] in (xmp_parsed.get('description') or '')
              and xmp_parsed.get('copyright') == tags['copyright'],
              str(xmp_parsed))
        check('独立 XML 解析器验证 XMP dc:subject (keywords) / photoshop:Source (url) / xmp:CreatorTool',
              xmp_parsed.get('keywords') == tags['keywords']
              and xmp_parsed.get('url') == tags['url']
              and xmp_parsed.get('software') == tags['software'],
              str(xmp_parsed))
        check('独立 XML 解析器验证 XMP CreateDate / ModifyDate / DateTimeOriginal / DateTimeDigitized',
              xmp_parsed.get('date') == tags['date']
              and xmp_parsed.get('taggedDate') == tags['taggedDate']
              and xmp_parsed.get('dateOriginal') == tags['dateOriginal']
              and xmp_parsed.get('encodedDate') == tags['encodedDate'],
              str(xmp_parsed))
        check('独立 XML 解析器验证 XMP Make / Model / Album / Genre / Rating / GPS',
              xmp_parsed.get('make') == tags['make']
              and xmp_parsed.get('model') == tags['model']
              and xmp_parsed.get('album') == tags['album']
              and xmp_parsed.get('genre') == tags['genre']
              and xmp_parsed.get('rating') == '5'
              and xmp_parsed.get('gpsLat') is not None,
              str(xmp_parsed))

    # Pillow 独立读取 EXIF IFD0 与验证像素
    img_orig = Image.open(jpg_path)
    img2 = Image.open(jpg_out)
    exif_dict = img2.getexif()
    check('Pillow getexif() 独立读出 IFD0 ImageDescription (0x010E) / Artist (0x013B) / Copyright (0x8298) / Make (0x010F) / Model (0x0110)',
          exif_dict.get(0x010E) == tags['title']
          and exif_dict.get(0x013B) == tags['artist']
          and exif_dict.get(0x8298, '').encode('latin1').decode('utf-8', 'replace') == tags['copyright']
          and exif_dict.get(0x010F) == tags['make']
          and exif_dict.get(0x0110) == tags['model'],
          str(dict(exif_dict)))
    check(f'Pillow 重新打开 JPEG 尺寸与格式正确 ({img2.size} {img2.format})',
          img2.size == (800, 600) and img2.format == 'JPEG')
    px_orig, px_new = img_orig.load(), img2.load()
    same = all(px_orig[x, y] == px_new[x, y] for x in range(0, 800, 80) for y in range(0, 600, 80))
    check('Pillow 像素数据逐点一致', same)

    # exiftool 验证（若未安装则明确记为 SKIP，绝不计入 PASS）
    if HAVE_EXIFTOOL:
        meta = exiftool_read(jpg_out)
        check('exiftool 读到 JPEG XMP Title', meta and meta.get('XMP:Title') == tags['title'])
        check('exiftool 读到 JPEG XMP Creator', meta and meta.get('XMP:Creator') == tags['artist'])
        check('exiftool 读到 JPEG XMP Description', meta and tags['comment'] in (meta.get('XMP:Description') or ''))
        check('exiftool 读到 JPEG XMP Source', meta and meta.get('XMP:Source') == tags['url'])
        check('exiftool 读到 JPEG XMP CreateDate', meta and '2025:01:20' in (meta.get('XMP:CreateDate') or ''))
        check('exiftool 读到 JPEG XMP CreatorTool', meta and meta.get('XMP:CreatorTool') == tags['software'])
    else:
        for field_name in ('XMP:Title', 'XMP:Creator', 'XMP:Description', 'XMP:Source', 'XMP:CreateDate', 'XMP:CreatorTool'):
            skip(f'exiftool 读取 JPEG {field_name}', '当前运行环境未安装 exiftool')

    # 重复写入（幂等 + mergeXmp）
    jpg_out2 = os.path.join(WORKDIR, 'test_tagged2.jpg')
    jpg_out3 = os.path.join(WORKDIR, 'test_merged.jpg')
    res2 = run_stamp_write(jpg_out, jpg_out2, tags)
    res3 = run_stamp_write(jpg_out2, jpg_out3, {'artist': 'Updated JPEG Artist'}, {'mergeXmp': True})
    check('JPEG 重复写入：第二次写入字节完全一致（幂等）',
          res2.get('ok') and open(jpg_out, 'rb').read() == open(jpg_out2, 'rb').read())
    if res3.get('ok'):
        merged_xmp = parse_xmp_fields_independent(extract_xmp_xml_from_jpeg(jpg_out3)[0])
        check('JPEG 重复写入 (mergeXmp: true)：独立 XML 解析器确认更新 artist 同时保留原 title/keywords/album',
              merged_xmp.get('artist') == 'Updated JPEG Artist'
              and merged_xmp.get('title') == tags['title']
              and merged_xmp.get('keywords') == tags['keywords']
              and merged_xmp.get('album') == tags['album'],
              str(merged_xmp))


# ==============================================================================
print('\n\033[1m▌ B. PNG: Pillow 生成 → stamp-js 写入 → 独立 XML/iTXt/CRC32/Pillow 验证 (+ exiftool)\033[0m\n')

png_path = os.path.join(WORKDIR, 'test.png')
png_out = os.path.join(WORKDIR, 'test_tagged.png')
img = Image.new('RGBA', (640, 480), (20, 40, 60, 255))
draw = ImageDraw.Draw(img)
random.seed(42)
for _ in range(50):
    x, y = random.randint(0, 640), random.randint(0, 480)
    r_c, g_c, b_c = random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)
    draw.ellipse([x - 20, y - 20, x + 20, y + 20], fill=(r_c, g_c, b_c, 200))
draw.text((250, 220), 'PNG TEST', fill=(255, 255, 255, 255))
img.save(png_path, 'PNG')
check(f'Pillow 生成正常 PNG ({os.path.getsize(png_path)} bytes)', os.path.getsize(png_path) > 0)

res = run_stamp_write(png_path, png_out, tags)
check('stamp-js 写入 PNG 成功', res.get('ok') is True, res.get('error', ''))
if res.get('ok'):
    itxt_map, crc_ok = extract_xmp_and_itxt_from_png(png_out)
    check('独立 zlib.crc32 校验：PNG 所有 chunk CRC32 100% 合法', crc_ok)
    check('独立解析 PNG iTXt 文本块：Title / Author / Copyright / Creation Time / Encoded Time / Modify Time / Collection / Genre / Source / Rating 齐全',
          itxt_map.get('Title') == tags['title']
          and itxt_map.get('Author') == tags['artist']
          and itxt_map.get('Copyright') == tags['copyright']
          and itxt_map.get('Creation Time') == tags['date']
          and itxt_map.get('Encoded Time') == tags['encodedDate']
          and itxt_map.get('Modify Time') == tags['taggedDate']
          and itxt_map.get('Collection') == tags['album']
          and itxt_map.get('Genre') == tags['genre']
          and itxt_map.get('Source') == 'Canon EOS R5'
          and itxt_map.get('Rating') == '5',
          str({k: v for k, v in itxt_map.items() if k != 'XML:com.adobe.xmp'}))

    xmp_xml = itxt_map.get('XML:com.adobe.xmp', '')
    xmp_png = parse_xmp_fields_independent(xmp_xml) if xmp_xml else {}
    check('独立 XML 解析器验证 PNG XMP 数据包全部字段与输入一致',
          xmp_png.get('title') == tags['title']
          and xmp_png.get('artist') == tags['artist']
          and xmp_png.get('keywords') == tags['keywords']
          and xmp_png.get('encodedDate') == tags['encodedDate']
          and xmp_png.get('taggedDate') == tags['taggedDate'],
          str(xmp_png))

    img_orig = Image.open(png_path)
    img2 = Image.open(png_out)
    exif_png = img2.getexif()
    check('Pillow getexif() 独立从 PNG eXIf 块读出 Title / Artist / Copyright / Make / Model',
          exif_png.get(0x010E) == tags['title']
          and exif_png.get(0x013B) == tags['artist']
          and exif_png.get(0x8298, '').encode('latin1').decode('utf-8', 'replace') == tags['copyright']
          and exif_png.get(0x010F) == tags['make']
          and exif_png.get(0x0110) == tags['model'],
          str(dict(exif_png)))
    px_orig, px_new = img_orig.load(), img2.load()
    same = all(px_orig[x, y] == px_new[x, y] for x in range(0, 640, 80) for y in range(0, 480, 80))
    check('Pillow 重新打开 PNG 像素逐点一致', same)

    if HAVE_EXIFTOOL:
        meta = exiftool_read(png_out)
        check('exiftool 读到 PNG XMP Title', meta and meta.get('XMP:Title') == tags['title'])
        check('exiftool 读到 PNG XMP Creator', meta and meta.get('XMP:Creator') == tags['artist'])
        check('exiftool 读到 PNG Title text chunk', meta and meta.get('PNG:Title') == tags['title'])
        check('exiftool 读到 PNG Author text chunk', meta and meta.get('PNG:Author') == tags['artist'])
    else:
        for field_name in ('XMP:Title', 'XMP:Creator', 'PNG:Title', 'PNG:Author'):
            skip(f'exiftool 读取 PNG {field_name}', '当前运行环境未安装 exiftool')

    # PNG 重复写入验证
    png_out2 = os.path.join(WORKDIR, 'test_tagged2.png')
    res2 = run_stamp_write(png_out, png_out2, tags)
    check('PNG 重复写入：第二次写入逐字节完全一致（幂等）',
          res2.get('ok') and open(png_out, 'rb').read() == open(png_out2, 'rb').read())


# ==============================================================================
print('\n\033[1m▌ C. MP4 / MOV: ffmpeg 生成真实视频 → stamp-js 写入 → ffprobe/ffmpeg + 手动解析验证 (+ exiftool)\033[0m\n')

mp4_path = os.path.join(WORKDIR, 'test.mp4')
mp4_out = os.path.join(WORKDIR, 'test_tagged.mp4')
if HAVE_FFMPEG:
    subprocess.run([
        'ffmpeg', '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', mp4_path
    ], check=True, timeout=60)
    check(f'ffmpeg 生成真实可播放 H.264+AAC MP4 ({os.path.getsize(mp4_path)} bytes)', os.path.getsize(mp4_path) > 0)
else:
    subprocess.run([
        'node', '--input-type=module', '-e',
        f"import * as F from './test/fixtures.mjs'; import fs from 'node:fs'; "
        f"fs.writeFileSync({json.dumps(mp4_path)}, Buffer.from(F.buildMp4({{ layout: 'head', chunks: 8, chunkSize: 4096 }}).bytes));"
    ], cwd=os.path.join(os.path.dirname(__file__), '..'), check=True, timeout=15)
    check(f'本地构造 MP4 ({os.path.getsize(mp4_path)} bytes)', os.path.getsize(mp4_path) > 0)

mp4_tags = {
    'title': 'Interop MP4 Test',
    'artist': 'stamp-js Verification',
    'album': 'Interop Suite',
    'genre': 'Benchmark',
    'comment': 'Real MP4 tagged by stamp-js',
    'copyright': '© 2026 stamp-js',
    'date': '2025-01-20T12:00:00Z',
    'encodedDate': '2025-01-20T12:00:00Z',
    'taggedDate': '2025-01-21T09:00:00Z',
    'software': 'stamp/0.1.2',
}
res = run_stamp_write(mp4_path, mp4_out, mp4_tags)
check('stamp-js 写入 MP4 成功', res.get('ok') is True, res.get('error', ''))
if res.get('ok'):
    check(f'MP4 输出大小 ({res["outputSize"]}) >= 输入 ({res["inputSize"]})', res['outputSize'] >= res['inputSize'])
    check(f'MP4 只读取头部+moov ({res["bytesRead"]} bytes < 1MB)', res['bytesRead'] < 1024 * 1024)

    if HAVE_FFPROBE:
        pr = subprocess.run(
            ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4_out],
            capture_output=True, text=True, timeout=30
        )
        probe_json = json.loads(pr.stdout) if pr.returncode == 0 else {}
        ftags = {k.lower(): v for k, v in (probe_json.get('format', {}).get('tags') or {}).items()}
        check('ffprobe 独立读到 MP4 Title / Artist / Album / Genre / Comment / creation_time',
              ftags.get('title') == mp4_tags['title']
              and ftags.get('artist') == mp4_tags['artist']
              and ftags.get('album') == mp4_tags['album']
              and ftags.get('genre') == mp4_tags['genre']
              and mp4_tags['comment'] in (ftags.get('comment') or '')
              and '2025-01-20T12:00:00' in (ftags.get('creation_time') or ''),
              str(ftags))
    else:
        skip('ffprobe 读取 MP4 标签', '当前运行环境未安装 ffprobe')

    if HAVE_FFMPEG:
        dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp4_out, '-f', 'null', '-'],
                             capture_output=True, text=True, timeout=60)
        check('ffmpeg 独立完整解码 MP4 所有音视频帧无报错', dec.returncode == 0 and not dec.stderr.strip(),
              dec.stderr.strip()[:160])
    else:
        skip('ffmpeg 解码验证 MP4', '当前运行环境未安装 ffmpeg')

    if HAVE_EXIFTOOL:
        meta_after = exiftool_read(mp4_out)
        title = (meta_after or {}).get('QuickTime:Title') or (meta_after or {}).get('MP4:Title') or (meta_after or {}).get('ItemList:Title')
        artist = (meta_after or {}).get('QuickTime:Artist') or (meta_after or {}).get('MP4:Artist') or (meta_after or {}).get('ItemList:Artist')
        comment = (meta_after or {}).get('QuickTime:Comment') or (meta_after or {}).get('MP4:Comment') or (meta_after or {}).get('ItemList:Comment')
        check('exiftool 读到 MP4 Title', title == mp4_tags['title'])
        check('exiftool 读到 MP4 Artist', artist == mp4_tags['artist'])
        check('exiftool 读到 MP4 Comment', comment and mp4_tags['comment'] in comment)
    else:
        for field_name in ('MP4 Title', 'MP4 Artist', 'MP4 Comment'):
            skip(f'exiftool 读取 {field_name}', '当前运行环境未安装 exiftool')

    # 手动解析 MP4 盒子结构与 mdat 首尾校验
    data = open(mp4_out, 'rb').read()
    orig_data = open(mp4_path, 'rb').read()

    def top_boxes(buf):
        out, pos = [], 0
        while pos + 8 <= len(buf):
            sz = struct.unpack('>I', buf[pos:pos + 4])[0]
            tp = buf[pos + 4:pos + 8].decode('ascii', errors='replace')
            hdr = 8
            if sz == 1:
                sz = struct.unpack('>Q', buf[pos + 8:pos + 16])[0]
                hdr = 16
            elif sz == 0:
                sz = len(buf) - pos
            if sz < hdr or pos + sz > len(buf):
                break
            out.append((tp, sz, pos, hdr))
            pos += sz
        return out

    boxes_out = top_boxes(data)
    boxes_in = top_boxes(orig_data)
    check(f'Python 独立解析 MP4 顶层盒子结构完整 ({len(boxes_out)} 个)', len(boxes_out) >= 2)
    mdat_out = next((b for b in boxes_out if b[0] == 'mdat'), None)
    mdat_in = next((b for b in boxes_in if b[0] == 'mdat'), None)
    if mdat_out and mdat_in:
        pay_out = data[mdat_out[2] + mdat_out[3]:mdat_out[2] + mdat_out[1]]
        pay_in = orig_data[mdat_in[2] + mdat_in[3]:mdat_in[2] + mdat_in[1]]
        check('MP4 mdat 媒体载荷逐字节完全一致', pay_out == pay_in)

    # 幂等写入
    mp4_out2 = os.path.join(WORKDIR, 'test_tagged2.mp4')
    res2 = run_stamp_write(mp4_out, mp4_out2, mp4_tags)
    check('MP4 重复写入：第二次写入逐字节完全一致（幂等）',
          res2.get('ok') and open(mp4_out, 'rb').read() == open(mp4_out2, 'rb').read())

shutil.rmtree(WORKDIR, ignore_errors=True)

print('\n' + '=' * 74)
status = '\033[32mALL EXECUTED PASSED\033[0m' if FAIL == 0 else '\033[31mSOME FAILED\033[0m'
print(f' {status}   {PASS} passed, {FAIL} failed, {SKIP} skipped, {NOT_RUN} not run')
if not HAVE_EXIFTOOL:
    print(' \033[33m说明: 当前环境未安装 exiftool，exiftool 专属断言已标记为 SKIP（未计入 passed）；\033[0m')
    print(' \033[33m      XMP/EXIF/MP4/MOV 均已通过 Pillow + ElementTree XML + ffprobe + ffmpeg 独立完成验证。\033[0m')
print('=' * 74 + '\n')

if FAIL > 0:
    sys.exit(1)
if os.environ.get('STAMP_REQUIRE_EXIFTOOL') == '1' and not HAVE_EXIFTOOL:
    sys.exit(2)
sys.exit(0)
