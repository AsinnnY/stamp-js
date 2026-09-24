#!/usr/bin/env python3
"""
真实文件互操作性测试：用用户上传的 4 个真实媒体文件验证 stamp-js。

文件来源：
  IMG_20260922_005901.jpg     vivo X200 Pro 手机拍摄（含 EXIF+XMP+ICC+640KB APP 段）
  Screenshot_20260914_143408.jpg  Android 截图（含 EXIF+JFIF+ICC）
  mmexport1787323235398.mp4   微信导出视频（faststart + mdir 标签）
  wx_camera_1788147011771.mp4 微信拍摄视频（faststart + mdta 标签）

验证链：
  原始文件 → stamp-js 写入 → exiftool 独立读取 → Pillow 完整性检查

运行：python3 test/real-file-test.py
"""
import subprocess
import json
import os
import re
import sys
import shutil
import struct
from PIL import Image

UPLOAD = os.environ.get('STAMP_TEST_MEDIA', '/workspace/upload')
WORK = '/tmp/real-file-test'
STAMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'stamp.js')

# 真实素材不在仓库里（CI 只有 checkout），缺文件时优雅跳过而不是抛异常。
REQUIRED = ['IMG_20260922_005901.jpg', 'Screenshot_20260914_143408.jpg',
            'mmexport1787323235398.mp4', 'wx_camera_1788147011771.mp4']
_missing = [f for f in REQUIRED if not os.path.exists(os.path.join(UPLOAD, f))]
if _missing:
    print(f'\n\033[33m跳过真实素材测试\033[0m：{UPLOAD} 下缺少 {len(_missing)}/{len(REQUIRED)} 个文件'
          f'（{", ".join(_missing)}）')
    print('把素材放到该目录，或设置 STAMP_TEST_MEDIA=<dir> 后重跑。')
    sys.exit(0)

PASS = 0
FAIL = 0

def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  \033[32m\xe2\x9c\x93\033[0m {name}')
    else:
        FAIL += 1
        print(f'  \033[31m\xe2\x9c\x97\033[0m {name}  \033[33m\xe2\x86\x92 {extra}\033[0m')

def exif(path):
    r = subprocess.run(['exiftool', '-j', '-G1', path], capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout)[0] if r.stdout.strip() else {}
    except Exception:
        return {}


def mpf_info(path):
    """用 exiftool 独立读出 (MPImage1Length, MPImage2Start, MPImage2Length)。

    动态照片（长按变视频 / 多图 JPEG）把次级载荷的绝对偏移记在 APP2 MPF 里，
    写入时必须随头部长度变化一起平移，否则次级载荷会失联。
    """
    r = subprocess.run(['exiftool', '-a', '-G1', '-s', '-MPF:all', path],
                       capture_output=True, text=True, timeout=30)
    d = {}
    for m in re.finditer(r'\[MPImage(\d)\]\s+MPImage(Start|Length)\s*:\s*(\d+)', r.stdout):
        d[(int(m.group(1)), m.group(2))] = int(m.group(3))
    return d.get((1, 'Length')), d.get((2, 'Start')), d.get((2, 'Length'))

def stamp_write(inp, outp, tags):
    tj = json.dumps(tags)
    script = f"""
import {{ writeTags, BlobSource }} from '{STAMP}';
import fs from 'node:fs';
const blob = await fs.openAsBlob('{inp}');
const res = await writeTags(new BlobSource(blob), {tj});
if (!res.ok) {{ console.error(JSON.stringify({{ok:false,error:res.report.error}})); process.exit(1); }}
fs.writeFileSync('{outp}', Buffer.from(await res.blob.arrayBuffer()));
console.log(JSON.stringify({{ok:true,size:res.blob.size,bytesRead:res.report.stats.bytesRead,strategy:res.report.strategy,metaFormat:res.report.metaFormat,notes:res.report.notes}}));
"""
    r = subprocess.run(['node', '--input-type=module', '-e', script],
                      capture_output=True, text=True, timeout=90)
    if r.returncode != 0:
        return {'ok': False, 'error': (r.stderr or r.stdout).strip()}
    return json.loads(r.stdout.strip())

def jpeg_segments(path):
    with open(path, 'rb') as f:
        d = f.read()
    out = []
    p = 2
    while p + 4 <= len(d):
        if d[p] != 0xff:
            break
        m = d[p + 1]
        if m == 0xda:
            out.append(('SOS', p, None))
            break
        if m == 0xd9:
            break
        if m == 0x01 or 0xd0 <= m <= 0xd7:
            p += 2
            continue
        if m == 0xff:
            p += 1
            continue
        ln = struct.unpack('>H', d[p + 2:p + 4])[0]
        name = f'APP{m - 0xe0}' if 0xe0 <= m <= 0xef else f'FF{m:02X}'
        if m == 0xe1:
            ns = d[p + 4:p + 4 + 32]
            if ns.startswith(b'Exif'):
                name = 'APP1-EXIF'
            elif ns.startswith(b'http://ns.adobe.com/xap/1.0/'):
                name = 'APP1-XMP'
            elif ns.startswith(b'http://ns.adobe.com/xmp/extension/'):
                name = 'APP1-XMPEXT'
        elif m == 0xe2:
            if d[p + 4:p + 16] == b'ICC_PROFILE\x00':
                name = 'APP2-ICC'
            elif d[p + 4:p + 7] == b'MPF':
                name = 'APP2-MPF'
        out.append((name, p, ln))
        p += 2 + ln
    return out

def video_boxes(path):
    with open(path, 'rb') as f:
        d = f.read()
    out = []
    p = 0
    while p + 8 <= len(d):
        sz = struct.unpack('>I', d[p:p + 4])[0]
        t = d[p + 4:p + 8].decode('latin1')
        hdr = 8
        if sz == 1:
            sz = struct.unpack('>Q', d[p + 8:p + 16])[0]
            hdr = 16
        elif sz == 0:
            sz = len(d) - p
        if sz < hdr or p + sz > len(d):
            break
        out.append((t, sz, p))
        p += sz
    return out

def find_box(d, type_, start, end):
    p = start
    while p + 8 <= end:
        sz = struct.unpack('>I', d[p:p + 4])[0]
        hdr = 8
        t = d[p + 4:p + 8].decode('latin1')
        if sz == 1:
            sz = struct.unpack('>Q', d[p + 8:p + 16])[0]
            hdr = 16
        elif sz == 0:
            sz = end - p
        if sz < hdr or p + sz > end:
            return None
        if t == type_:
            return (p, sz, hdr)
        p += sz
    return None

TAGS = {
    'title': 'Real File Interop Test',
    'artist': 'stamp-js verification',
    'comment': 'Written by stamp-js into a real device file',
    'date': '2026-09-22T00:00:00Z',
    'software': 'stamp/0.1.0',
}


print('\n\033[1m' + '=' * 72 + '\033[0m')
print('\033[1m  REAL-FILE INTEROP TEST (4 files from user devices)\033[0m')
print('\033[1m' + '=' * 72 + '\033[0m')

os.makedirs(WORK, exist_ok=True)

# =====================================================================
print('\n\033[1m▌ A. vivo X200 Pro JPEG (4.5 MB, EXIF+XMP+ICC+640KB APP segments)\033[0m\n')
src = os.path.join(UPLOAD, 'IMG_20260922_005901.jpg')
out = os.path.join(WORK, 'vivo_tagged.jpg')

before = exif(src)
before_segs = jpeg_segments(src)
before_xmp_count = sum(1 for s in before_segs if s[0] == 'APP1-XMP')
app_bytes = sum(s[2] for s in before_segs if s[0].startswith('APP') and s[2])

print(f'  原始: Make={before.get("IFD0:Make")}, Model={before.get("IFD0:Model")}')
print(f'  原始: {len(before_segs)} 个段, XMP={before_xmp_count}, APP 段总字节={app_bytes}')
print(f'  原始: GPS={before.get("GPS:GPSLatitude", "none")}, ICC={ "yes" if "APP2-ICC" in [s[0] for s in before_segs] else "no"}')

res = stamp_write(src, out, TAGS)
check('vivo JPEG: write succeeds', res.get('ok'), res.get('error', ''))
if res.get('ok'):
    print(f'  写入: {res["size"]} bytes (原始 {os.path.getsize(src)}), 读取 {res["bytesRead"]} bytes')
    print(f'  策略: {res.get("strategy")}')

    after = exif(out)
    after_segs = jpeg_segments(out)

    # 1. 新标签可被 exiftool 读取
    # 注意：exiftool -G1 对 XMP 的 dc 命名空间输出 'XMP-dc:' 前缀（Title 属 dc:title），
    # 不存在裸 'XMP:Title' 键，用错键名会恒为 None 造成假失败。
    check(f'vivo JPEG: XMP title readable by exiftool (= "{TAGS["title"]}")',
          after.get('XMP-dc:Title', '') == TAGS['title'], f'got "{after.get("XMP-dc:Title")}"')
    check('vivo JPEG: XMP creator readable', after.get('XMP-dc:Creator', '') == TAGS['artist'])

    # 2. 原始 EXIF 保留（关键！）
    check(f'vivo JPEG: original EXIF Make preserved ({before.get("IFD0:Make")})',
          after.get('IFD0:Make') == before.get('IFD0:Make'), f'before={before.get("IFD0:Make")} after={after.get("IFD0:Make")}')
    check(f'vivo JPEG: original EXIF Model preserved',
          after.get('IFD0:Model') == before.get('IFD0:Model'))
    check('vivo JPEG: original EXIF DateTimeOriginal preserved',
          after.get('ExifIFD:DateTimeOriginal') == before.get('ExifIFD:DateTimeOriginal'),
          f'before={before.get("ExifIFD:DateTimeOriginal")} after={after.get("ExifIFD:DateTimeOriginal")}')

    # 3. ICC profile 保留
    before_names = [s[0] for s in after_segs]
    check('vivo JPEG: ICC profile preserved', 'APP2-ICC' in before_names)
    check('vivo JPEG: EXIF APP1 preserved', 'APP1-EXIF' in before_names)

    # 4. XMP 段数量：应该只有 1 个（旧的被替换）
    after_xmp = sum(1 for s in after_segs if s[0] == 'APP1-XMP')
    check(f'vivo JPEG: exactly 1 XMP segment (was {before_xmp_count})', after_xmp == 1, f'got {after_xmp}')

    # 5. Pillow 完整性
    img = Image.open(out)
    check(f'vivo JPEG: Pillow reopens image {img.size}', img.size == (3060, 4080), str(img.size))
    img.close()

    # 6. 深度数据段保留（APP5-APP11）
    deep_before = sum(1 for s in before_segs if s[0] in [f'APP{i}' for i in range(5, 12)])
    deep_after = sum(1 for s in after_segs if s[0] in [f'APP{i}' for i in range(5, 12)])
    check(f'vivo JPEG: vendor deep-data segments preserved ({deep_before} -> {deep_after})',
          deep_after == deep_before, f'{deep_before} vs {deep_after}')

    # 7. 动态照片（MPF 多图索引）: 绝对偏移必须随头部长度变化一起平移
    mb_mpf = mpf_info(src)
    ma_mpf = mpf_info(out)
    if mb_mpf[0] is None:
        print('  (该文件无 MPF 索引，跳过动态照片检查)')
    else:
        delta = os.path.getsize(out) - os.path.getsize(src)
        print(f'  动态照片: MPImage1Length {mb_mpf[0]} -> {ma_mpf[0]}, '
              f'MPImage2Start {mb_mpf[1]} -> {ma_mpf[1]} (文件增量 {delta:+d})')
        check('vivo JPEG: 动态照片主图长度随文件增量平移',
              ma_mpf[0] == mb_mpf[0] + delta, f'{mb_mpf[0]} + {delta} != {ma_mpf[0]}')
        check('vivo JPEG: 动态照片次级图偏移随文件增量平移',
              ma_mpf[1] == mb_mpf[1] + delta, f'{mb_mpf[1]} + {delta} != {ma_mpf[1]}')
        with open(out, 'rb') as f:
            da2 = f.read()
        check('vivo JPEG: 平移后新偏移处仍是合法 JPEG 起点',
              da2[ma_mpf[1]:ma_mpf[1] + 2] == b'\xff\xd8', str(da2[ma_mpf[1]:ma_mpf[1] + 2]))
        check('vivo JPEG: 次级图长度字段未被改动',
              ma_mpf[2] == mb_mpf[2], f'{mb_mpf[2]} -> {ma_mpf[2]}')

# =====================================================================
print('\n\033[1m▌ B. Android Screenshot JPEG (567 KB, EXIF+JFIF+ICC)\033[0m\n')
src = os.path.join(UPLOAD, 'Screenshot_20260914_143408.jpg')
out = os.path.join(WORK, 'screenshot_tagged.jpg')

before = exif(src)
before_segs = jpeg_segments(src)
print(f'  原始: Software={before.get("IFD0:Software")}, 段={[s[0] for s in before_segs]}')

res = stamp_write(src, out, TAGS)
check('screenshot JPEG: write succeeds', res.get('ok'), res.get('error', ''))
if res.get('ok'):
    after = exif(out)
    after_segs = jpeg_segments(out)
    check('screenshot JPEG: XMP title readable', after.get('XMP-dc:Title', '') == TAGS['title'],
          f'got "{after.get("XMP-dc:Title")}"')
    check('screenshot JPEG: original EXIF DateTimeOriginal preserved',
          after.get('ExifIFD:DateTimeOriginal') == before.get('ExifIFD:DateTimeOriginal'))
    check('screenshot JPEG: ICC preserved', 'APP2-ICC' in [s[0] for s in after_segs])
    check('screenshot JPEG: JFIF preserved', 'APP0' in [s[0] for s in after_segs])
    img = Image.open(out)
    check(f'screenshot JPEG: Pillow reopens {img.size}', img.size == (1260, 2800))
    img.close()

# =====================================================================
print('\n\033[1m▌ C. WeChat exported MP4 (faststart + mdir tags)\033[0m\n')
src = os.path.join(UPLOAD, 'mmexport1787323235398.mp4')
out = os.path.join(WORK, 'mmexport_tagged.mp4')

before = exif(src)
boxes_before = video_boxes(src)
with open(src, 'rb') as f:
    db = f.read()
print(f'  原始: 顶层盒={[b[0] for b in boxes_before]}')
print(f'  原始: Duration={before.get("QuickTime:Duration")}')

res = stamp_write(src, out, TAGS)
check('mmexport MP4: write succeeds', res.get('ok'), res.get('error', ''))
if res.get('ok'):
    print(f'  策略: {res.get("strategy")}, metaFormat={res.get("metaFormat")}, 读取 {res["bytesRead"]} bytes')
    after = exif(out)
    # iTunes 风格 ilst 标签在 exiftool -G1 下归入 'ItemList' 组（不是 'QuickTime'）
    check(f'mmexport MP4: Title readable (= "{TAGS["title"]}")',
          after.get('ItemList:Title', '') == TAGS['title'], f'got "{after.get("ItemList:Title")}"')
    check('mmexport MP4: Artist readable', after.get('ItemList:Artist', '') == TAGS['artist'])
    check('mmexport MP4: duration preserved', after.get('QuickTime:Duration') == before.get('QuickTime:Duration'))

    # mdat 数据完整性
    with open(out, 'rb') as f:
        da = f.read()
    mb = find_box(db, 'mdat', 0, len(db))
    ma = find_box(da, 'mdat', 0, len(da))
    if mb and ma:
        head_ok = db[mb[0] + mb[2]:mb[0] + mb[2] + 4096] == da[ma[0] + ma[2]:ma[0] + ma[2] + 4096]
        tail_off_b = mb[0] + mb[1] - 4096
        tail_off_a = ma[0] + ma[1] - 4096
        tail_ok = db[tail_off_b:mb[0] + mb[1]] == da[tail_off_a:ma[0] + ma[1]]
        check('mmexport MP4: mdat head 4KB unchanged', head_ok)
        check('mmexport MP4: mdat tail 4KB unchanged', tail_ok)

# =====================================================================
print('\n\033[1m▌ D. WeChat camera MP4 (faststart + mdta tags + keys table)\033[0m\n')
src = os.path.join(UPLOAD, 'wx_camera_1788147011771.mp4')
out = os.path.join(WORK, 'wx_camera_tagged.mp4')

before = exif(src)
with open(src, 'rb') as f:
    db = f.read()
moov = find_box(db, 'moov', 0, len(db))
# 注意：find_box 的区间是「盒子内部」的遍历范围，必须跳过父盒头（moov[2] 为头部长度），
# 否则会从 moov 自身开始遍历、永远找不到子盒。
udta = find_box(db, 'udta', moov[0] + moov[2], moov[0] + moov[1]) if moov else None
print(f'  原始: moov @{moov[0]} size={moov[1]}')
# 找 meta 的 hdlr
meta = find_box(db, 'meta', udta[0] + udta[2], udta[0] + udta[1]) if udta else None
hdlr_type = None
if meta:
    h = find_box(db, 'hdlr', meta[0] + 12, meta[0] + meta[1])
    if h:
        hdlr_type = db[h[0] + 16:h[0] + 20].decode('latin1')
print(f'  原始: 已有 udta/meta, hdlr={hdlr_type}')
print(f'  原始: Duration={before.get("QuickTime:Duration")}')

res = stamp_write(src, out, TAGS)
check('wx_camera MP4: write succeeds', res.get('ok'), res.get('error', ''))
if res.get('ok'):
    print(f'  策略: {res.get("strategy")}, metaFormat={res.get("metaFormat")}, 读取 {res["bytesRead"]} bytes')
    after = exif(out)
    # mdta 风格（带 keys 表）exiftool 归入 'Keys' 组，mdir 风格归入 'ItemList' 组；
    # stamp-js 默认跟随文件原有风格，故两种都接受。
    title_after = after.get('ItemList:Title') or after.get('Keys:Title')
    check(f'wx_camera MP4: Title readable', title_after == TAGS['title'],
          f'got "{title_after}"')
    check('wx_camera MP4: duration preserved', after.get('QuickTime:Duration') == before.get('QuickTime:Duration'))

    # 验证 hdlr 仍为 mdta（保持原风格）。
    # meta 既可能在 udta 内（iTunes 风格），也可能是 moov 的直接子盒
    # （Android/MediaTek 风格）；两种都找，找不到就明确失败，而不是崩在 None[0] 上
    # ——一次下标异常会把后面所有断言一起吞掉，等于没有信号。
    with open(out, 'rb') as f:
        da = f.read()
    moov_a = find_box(da, 'moov', 0, len(da))
    meta_a = None
    if moov_a:
        udta_a = find_box(da, 'udta', moov_a[0] + moov_a[2], moov_a[0] + moov_a[1])
        if udta_a:
            meta_a = find_box(da, 'meta', udta_a[0] + udta_a[2], udta_a[0] + udta_a[1])
        if not meta_a:
            meta_a = find_box(da, 'meta', moov_a[0] + moov_a[2], moov_a[0] + moov_a[1])
    h_a = find_box(da, 'hdlr', meta_a[0] + 12, meta_a[0] + meta_a[1]) if meta_a else None
    if not h_a:
        check('wx_camera MP4: hdlr still mdta (preserved style)', False,
              f'meta/hdlr not found; moov={moov_a}')
    else:
        hdlr_after = da[h_a[0] + 16:h_a[0] + 20].decode('latin1')
        check('wx_camera MP4: hdlr still mdta (preserved style)', hdlr_after == hdlr_type,
              f'{hdlr_type} -> {hdlr_after}')

    # mdat 完整性
    mb = find_box(db, 'mdat', 0, len(db))
    ma = find_box(da, 'mdat', 0, len(da))
    if mb and ma:
        head_ok = db[mb[0] + mb[2]:mb[0] + mb[2] + 4096] == da[ma[0] + ma[2]:ma[0] + ma[2] + 4096]
        check('wx_camera MP4: mdat head 4KB unchanged', head_ok)

# =====================================================================
# E. 幂等性检查（写入两次）
print('\n\033[1m▌ E. Idempotency on real files\033[0m\n')
for name, f in [('vivo JPEG', 'IMG_20260922_005901.jpg'),
                ('wx_camera MP4', 'wx_camera_1788147011771.mp4')]:
    src = os.path.join(UPLOAD, f)
    o1 = os.path.join(WORK, f'idem1_{f}')
    o2 = os.path.join(WORK, f'idem2_{f}')
    r1 = stamp_write(src, o1, TAGS)
    r2 = stamp_write(o1, o2, TAGS)
    if r1.get('ok') and r2.get('ok'):
        same = open(o1, 'rb').read() == open(o2, 'rb').read()
        check(f'{name}: second write produces identical bytes', same)
    else:
        check(f'{name}: idempotency test', False, str(r1.get('error') or r2.get('error')))

shutil.rmtree(WORK, ignore_errors=True)

print(f'\n\033[1m{"ALL PASSED" if FAIL == 0 else "SOME FAILED"}\033[0m  {PASS} passed, {FAIL} failed\n')
sys.exit(0 if FAIL == 0 else 1)
