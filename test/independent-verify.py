#!/usr/bin/env python3
"""
stamp-js 独立验证套件（不依赖库自身的断言，全部用第三方工具+手工解析反查）。

与 test/run.mjs（自测）和 test/real-file-test.py（真实素材）互补：
  - run.mjs 用的是库自己的 expected 值；本脚本用 exiftool / Pillow / 手工 box 解析
    独立重建「期望结果」，因此能发现库与测试同步写错的情况。
  - 覆盖：像素级一致性、mdat 载荷哈希、stco 平移量、逐样本数据回查、
    多轮幂等、拒绝路径、特殊字符/超长、PNG、非 faststart(moov-at-tail)。

运行：python3 test/independent-verify.py
依赖：node>=18 / exiftool / Pillow
"""
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys

try:
    from PIL import Image
except ImportError:                                  # handled by the guard below
    Image = None

HERE = os.path.dirname(os.path.abspath(__file__))
STAMP = os.path.join(HERE, '..', 'src', 'stamp.js')
# Real device files live outside the repository, so CI (which only has the
# checkout) runs the synthetic sections and skips the real-material ones.
# Point STAMP_TEST_MEDIA at a directory holding the four files for a full run.
MEDIA = os.environ.get('STAMP_TEST_MEDIA', '/workspace/upload')
WORK = '/tmp/stamp-independent'

PASS = 0
FAIL = 0
GAPS = []

# --------------------------------------------------------------------------
# Dependency guard. Every assertion here rebuilds its expected value with a
# third-party tool, so a missing tool means the suite cannot verify anything.
# Report that clearly instead of dying halfway through with a traceback
# (exit 2 = dependencies missing, distinct from 0 = pass and 1 = assertion).
# --------------------------------------------------------------------------
MISSING_DEPS = [t for t in ('node', 'exiftool') if shutil.which(t) is None]
if Image is None:
    MISSING_DEPS.append('Pillow')
if MISSING_DEPS:
    print('\n\033[33mSKIP\033[0m 缺少验证依赖: ' + ', '.join(MISSING_DEPS))
    print('  本套件用第三方工具（exiftool / Pillow）重建期望值，缺依赖时不做降级断言，')
    print('  因此以退出码 2 结束（0=全部通过、1=断言失败）。')
    print('  安装: apt-get install -y libimage-exiftool-perl python3-pil')
    sys.exit(2)


def media(name):
    p = os.path.join(MEDIA, name)
    return p if os.path.exists(p) else None


VIVO = media('IMG_20260922_005901.jpg')      # vivo X200 Pro 动态照片（MPF 多图）
SHOT = media('Screenshot_20260914_143408.jpg')
MM = media('mmexport1787323235398.mp4')
WX = media('wx_camera_1788147011771.mp4')
HAVE_REAL = all([VIVO, SHOT, MM, WX])

SKIP_NOTE = (f'\033[33m△\033[0m 未找到真实素材（{MEDIA}），跳过该小节；'
             '设置 STAMP_TEST_MEDIA=<dir> 可运行完整套件')


def base_jpeg_bytes():
    """真实截图优先；CI 里没有素材时用 Pillow 现造一张，保证合成用例照常运行。"""
    if SHOT:
        return open(SHOT, 'rb').read()
    import io
    buf = io.BytesIO()
    Image.new('RGB', (320, 240), (40, 90, 160)).save(buf, 'JPEG')
    return buf.getvalue()


TAGS = {
    'title': 'Independent Verify',
    'artist': '第三方校验',
    'comment': 'A & B <C> "D" \'E\' 🚀',
    'date': '2026-09-22T12:00:00Z',
    'software': 'stamp-js',
}


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  \033[32m✓\033[0m {name}')
    else:
        FAIL += 1
        print(f'  \033[31m✗\033[0m {name}' + (f'  \033[33m→ {extra}\033[0m' if extra else ''))


def note_gap(name, detail):
    GAPS.append((name, detail))
    print(f'  \033[33m△\033[0m {name} (已知缺口)  → {detail}')


def sha(b):
    return hashlib.sha256(b).hexdigest()[:16]


# --------------------------------------------------------------------------
# 通过 node 调用 stamp-js
# --------------------------------------------------------------------------
def stamp_write(inp, outp, tags=TAGS, opts=None):
    script = f"""
import {{ writeTags, BlobSource }} from '{STAMP}';
import fs from 'node:fs';
const blob = await fs.openAsBlob({json.dumps(inp)});
const res = await writeTags(new BlobSource(blob), {json.dumps(tags)}, {json.dumps(opts or {})});
if (!res.ok) {{ console.log(JSON.stringify({{ok:false, error:res.report.error}})); process.exit(0); }}
fs.writeFileSync({json.dumps(outp)}, Buffer.from(await res.blob.arrayBuffer()));
console.log(JSON.stringify({{ok:true, size:res.blob.size, bytesRead:res.report.stats.bytesRead,
  strategy:res.report.strategy, metaFormat:res.report.metaFormat, warnings:res.report.warnings}}));
"""
    r = subprocess.run(['node', '--input-type=module', '-e', script],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return {'ok': False, 'error': (r.stderr or r.stdout).strip()[:200]}
    return json.loads(r.stdout.strip())


def exif(path):
    r = subprocess.run(['exiftool', '-j', '-G1', path], capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)[0] if r.stdout.strip() else {}
    except Exception:
        return {}


# --------------------------------------------------------------------------
# 独立 JPEG 解析
# --------------------------------------------------------------------------
STD_XMP = b'http://ns.adobe.com/xap/1.0/\x00'
EXT_XMP = b'http://ns.adobe.com/xmp/extension/\x00'


def jpeg_segments(path):
    d = open(path, 'rb').read()
    out, i = [], 2
    while i + 4 <= len(d) and d[i] == 0xFF:
        m = d[i + 1]
        if m in (0xDA, 0xD9):
            break
        if m == 0x01 or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        if m == 0xFF:
            i += 1
            continue
        ln = struct.unpack('>H', d[i + 2:i + 4])[0]
        body = d[i + 4:i + 2 + ln]
        if m == 0xE1 and body.startswith(STD_XMP):
            name = 'XMP'
        elif m == 0xE1 and body.startswith(EXT_XMP):
            name = 'XMPEXT'
        else:
            name = f'APP{m - 0xE0}' if 0xE0 <= m <= 0xEF else f'FF{m:02X}'
        out.append(name)
        i += 2 + ln
    return out


def jpeg_pixels(path):
    with Image.open(path) as im:
        im = im.convert('RGB')
        return im.tobytes(), im.size


# --------------------------------------------------------------------------
# 独立 MP4 box / sample table 解析
# --------------------------------------------------------------------------
def _boxes(d, s, e):
    p = s
    while p + 8 <= e:
        sz = struct.unpack('>I', d[p:p + 4])[0]
        t = d[p + 4:p + 8].decode('latin1', 'replace')
        hdr = 8
        if sz == 1:
            sz = struct.unpack('>Q', d[p + 8:p + 16])[0]
            hdr = 16
        elif sz == 0:
            sz = e - p
        if sz < hdr or p + sz > e:
            return
        yield t, p, sz, hdr
        p += sz


def find_child(d, start, end, name):
    """在 [start,end) 内查找直接子盒（start 必须已是父盒内容起点）"""
    for t, p, sz, hdr in _boxes(d, start, end):
        if t == name:
            return p, sz, hdr
    return None


def mdat_payload(d):
    for t, p, sz, hdr in _boxes(d, 0, len(d)):
        if t == 'mdat':
            return d[p + hdr:p + sz]
    return None


def sample_offsets(d):
    """独立解析 stco/co64 -> {trak序号: (盒子名, [偏移,...])}"""
    moov = find_child(d, 0, len(d), 'moov')
    if not moov:
        return {}
    res, ti = {}, 0
    for t, p, sz, hdr in _boxes(d, moov[0] + moov[2], moov[0] + moov[1]):
        if t != 'trak':
            continue
        ti += 1
        mdia = find_child(d, p + hdr, p + sz, 'mdia')
        if not mdia:
            continue
        minf = find_child(d, mdia[0] + mdia[2], mdia[0] + mdia[1], 'minf')
        if not minf:
            continue
        stbl = find_child(d, minf[0] + minf[2], minf[0] + minf[1], 'stbl')
        if not stbl:
            continue
        for t2, p2, sz2, h2 in _boxes(d, stbl[0] + stbl[2], stbl[0] + stbl[1]):
            if t2 in ('stco', 'co64'):
                n = struct.unpack('>I', d[p2 + 12:p2 + 16])[0]
                w, f = (4, '>I') if t2 == 'stco' else (8, '>Q')
                offs = [struct.unpack(f, d[p2 + 16 + w * i:p2 + 16 + w * (i + 1)])[0] for i in range(n)]
                res[ti] = (t2, offs)
    return res


def top_level(path):
    d = open(path, 'rb').read()
    return [t for t, p, sz, hdr in _boxes(d, 0, len(d))], d


# ==========================================================================
print('\033[1m' + '=' * 74)
print(' stamp-js 独立验证套件 / INDEPENDENT VERIFICATION')
print('=' * 74 + '\033[0m')
shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK, exist_ok=True)

# ---- A. JPEG：像素级一致性 + 元数据可读 + 段结构 ----
print('\n\033[1m▌ A. JPEG 真实素材：像素级一致性 + 标签可读\033[0m\n')
real_jpegs = [(l, p) for l, p in [('vivo 4.5MB(含MPF多图)', VIVO), ('Android 截图 567KB', SHOT)] if p]
if not real_jpegs:
    print('  ' + SKIP_NOTE)
for label, src in real_jpegs:
    out = os.path.join(WORK, 'a_' + os.path.basename(src))
    res = stamp_write(src, out)
    check(f'{label}: 写入成功', res.get('ok'), res.get('error', ''))
    if not res.get('ok'):
        continue
    pa, sa = jpeg_pixels(src)
    pb, sb = jpeg_pixels(out)
    check(f'{label}: 像素逐字节一致 ({sa})', pa == pb and sa == sb, f'{sha(pa)} vs {sha(pb)}')
    j = exif(out)
    check(f'{label}: exiftool 读到 XMP-dc:Title', j.get('XMP-dc:Title') == TAGS['title'], f'got {j.get("XMP-dc:Title")!r}')
    check(f'{label}: 特殊字符/emoji 原样还原', j.get('XMP-dc:Description') == TAGS['comment'],
          f'got {j.get("XMP-dc:Description")!r}')
    check(f'{label}: 非 ASCII Artist 原样还原', j.get('XMP-dc:Creator') == TAGS['artist'],
          f'got {j.get("XMP-dc:Creator")!r}')
    segs = jpeg_segments(out)
    check(f'{label}: 输出只有 1 个 XMP 段', segs.count('XMP') == 1, f'{segs.count("XMP")}')
    if os.path.basename(src).startswith('Screenshot'):
        check(f'{label}: 原有 APP1/APP0/APP2 保留', all(x in segs for x in ('APP0', 'APP2')),
              str([s for s in segs if s.startswith('APP')]))

# ---- B. MP4：mdat 载荷 + stco 平移 + 逐样本回查 ----
print('\n\033[1m▌ B. MP4 真实素材：mdat 完整性 + sample table 偏移正确性\033[0m\n')
real_mp4s = [(l, p) for l, p in [('mmexport(mdir)', MM), ('wx_camera(mdta)', WX)] if p]
if not real_mp4s:
    print('  ' + SKIP_NOTE)
for label, src in real_mp4s:
    out = os.path.join(WORK, 'b_' + os.path.basename(src))
    res = stamp_write(src, out)
    check(f'{label}: 写入成功', res.get('ok'), res.get('error', ''))
    if not res.get('ok'):
        continue
    do = open(src, 'rb').read()
    dt = open(out, 'rb').read()
    a, b = mdat_payload(do), mdat_payload(dt)
    check(f'{label}: mdat 载荷逐字节一致', a == b, f'{sha(a)} vs {sha(b)}')

    sa, sb = sample_offsets(do), sample_offsets(dt)
    deltas = set()
    for ti in sa:
        if ti not in sb:
            deltas.add('missing')
            continue
        deltas |= {y - x for x, y in zip(sa[ti][1], sb[ti][1])}
    check(f'{label}: 所有 stco 条目统一平移（无漏改/错改）', len(deltas) == 1, f'deltas={sorted(deltas)[:4]}')
    check(f'{label}: 平移量 == moov 增长量', deltas == {len(dt) - len(do)}, f'delta={deltas} 文件增长={len(dt) - len(do)}')

    bad, cnt = 0, 0
    for ti in sa:
        for x, y in zip(sa[ti][1], sb[ti][1]):
            if do[x:x + 64] != dt[y:y + 64]:
                bad += 1
            cnt += 1
    check(f'{label}: 按输出偏移回查样本数据全部命中（{cnt} 个样本点）', bad == 0, f'{bad} 个不符')

    ja, jb = exif(src), exif(out)
    check(f'{label}: Duration 未变', ja.get('QuickTime:Duration') == jb.get('QuickTime:Duration'),
          f'{ja.get("QuickTime:Duration")} -> {jb.get("QuickTime:Duration")}')
    title = jb.get('ItemList:Title') or jb.get('Keys:Title')
    check(f'{label}: 标题可被 exiftool 读出（跟随原风格）', title == TAGS['title'], f'got {title!r}')

    tops, _ = top_level(out)
    check(f'{label}: 顶层盒子结构合法', 'moov' in tops and 'mdat' in tops, str(tops))

# ---- C. 多轮幂等 ----
print('\n\033[1m▌ C. 幂等性：连续 3 轮写入\033[0m\n')
idem_targets = [(l, p) for l, p in [('vivo JPEG', VIVO), ('mmexport MP4', MM)] if p]
if not idem_targets:
    print('  ' + SKIP_NOTE)
for label, src in idem_targets:
    cur, outs = src, []
    for i in range(3):
        o = os.path.join(WORK, f'c{i}_' + os.path.basename(src))
        r = stamp_write(cur, o)
        if not r.get('ok'):
            outs = []
            break
        outs.append(open(o, 'rb').read())
        cur = o
    check(f'{label}: 第 2、3 轮输出与第 1 轮字节完全一致',
          len(outs) == 3 and outs[1] == outs[0] and outs[2] == outs[0],
          f'sizes={[len(x) for x in outs]}')

# ---- D. 拒绝路径 ----
print('\n\033[1m▌ D. 拒绝路径：必须 ok:false 且给出原因（绝不输出损坏文件）\033[0m\n')


def synthetic_mp4(kind):
    """手搓 MP4 头，用来构造「结构损坏」的输入（不依赖真实素材）。"""
    ftyp = struct.pack('>I', 20) + b'ftyp' + b'isom' + struct.pack('>I', 0x200) + b'isom'
    if kind == 'trunc':
        return ftyp + struct.pack('>I', 5000) + b'moov' + b'\x00' * 100   # 声明 5000 但文件只有 108
    return ftyp + struct.pack('>I', 0xFFFFFFF0) + b'moov' + b'\x00' * 32  # box 尺寸越界


# 声明长度超出文件的 JPEG 头（裁在 APP 段中间，库必须拒绝）
truncated_jpeg = b'\xff\xd8' + b'\xff\xfe' + struct.pack('>H', 2 + 5000) + b'C' * 100

cases = [
    ('非媒体文本', b'hello world, not media at all' * 10),
    ('空文件', b''),
    ('随机字节', bytes(range(256)) * 400),
    ('截断 JPEG(APP 段声明超长)', truncated_jpeg),
    ('截断 MP4(moov 内)', synthetic_mp4('trunc')),
    ('坏 box size', synthetic_mp4('overflow')),
]
for name, buf in cases:
    p = os.path.join(WORK, 'd_' + name.replace('/', '_').replace(' ', '_') + '.bin')
    open(p, 'wb').write(bytes(buf))
    r = stamp_write(p, p + '.out')
    refused = (not r.get('ok')) and bool(r.get('error'))
    check(f'{name}: 被拒绝且有原因', refused, json.dumps(r, ensure_ascii=False)[:120])
    check(f'{name}: 未产出文件', not os.path.exists(p + '.out'))

# ---- E. 特殊值 / 超长 ----
print('\n\033[1m▌ E. 特殊值与长度上限\033[0m\n')
e_src = os.path.join(WORK, 'e_src.jpg')
open(e_src, 'wb').write(base_jpeg_bytes())
r = stamp_write(e_src, os.path.join(WORK, 'e_long.jpg'), {'title': 'T' * 5000, 'comment': 'C' * 60000})
check('超长 XMP(>64KB)：明确拒绝而非产出坏文件', (not r.get('ok')) and '64' in (r.get('error') or ''), str(r.get('error'))[:100])
r = stamp_write(e_src, os.path.join(WORK, 'e_unknown.jpg'), {'title': 'ok', 'bogus': 'nope'})
check('未知字段：写入成功', r.get('ok'), r.get('error', ''))
if r.get('ok'):
    j = exif(os.path.join(WORK, 'e_unknown.jpg'))
    check('未知字段：未落盘', not any('bogus' in k.lower() for k in j) and not any('nope' in str(v) for v in j.values()))

# ---- F. PNG ----
print('\n\033[1m▌ F. PNG：新写 / 替换既有 iTXt / 保留其他 iTXt\033[0m\n')
try:
    png = os.path.join(WORK, 'f_plain.png')
    Image.new('RGB', (640, 480), (30, 120, 200)).save(png)
    out = os.path.join(WORK, 'f_tagged.png')
    r = stamp_write(png, out)
    check('PNG: 写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        a, sa = jpeg_pixels(png)
        b, sb = jpeg_pixels(out)
        check('PNG: 像素逐字节一致', a == b)
        j = exif(out)
        check('PNG: 标题可读', j.get('XMP-dc:Title') == TAGS['title'], f'got {j.get("XMP-dc:Title")!r}')
except Exception as e:  # pragma: no cover
    check('PNG 测试执行', False, str(e))

# ---- G. 非 faststart（moov 在文件尾）----
print('\n\033[1m▌ G. 非 faststart：moov 位于文件尾（零偏移路径）\033[0m\n')
try:
    # 真实素材优先；CI 里没有素材时用 JS 夹具生成同布局（ftyp+moov+free+mdat）的合成文件
    if MM:
        g_src = MM
    else:
        g_src = os.path.join(WORK, 'g_synth.mp4')
        g_script = (f"import * as F from {json.dumps(os.path.join(HERE, 'fixtures.mjs'))};"
                    "import fs from 'node:fs';"
                    f"fs.writeFileSync({json.dumps(g_src)},"
                    " Buffer.from(F.buildMp4({ layout: 'free', chunks: 8, chunkSize: 4096 }).bytes));")
        subprocess.run(['node', '--input-type=module', '-e', g_script], check=True, timeout=60)
    d = open(g_src, 'rb').read()
    tops = {t: (p, sz, hdr) for t, p, sz, hdr in _boxes(d, 0, len(d))}
    ftyp, moov, free, mdat = tops['ftyp'], tops['moov'], tops['free'], tops['mdat']
    gap = moov[1] + free[1]                      # 用 free 占位，保持 mdat 起始偏移不变
    newfree = struct.pack('>I', gap) + b'free' + b'\x00' * (gap - 8)
    tail = os.path.join(WORK, 'g_tailmoov.mp4')
    with open(tail, 'wb') as f:
        f.write(d[ftyp[0]:ftyp[0] + ftyp[1]])
        f.write(newfree)
        f.write(d[mdat[0]:mdat[0] + mdat[1]])
        f.write(d[moov[0]:moov[0] + moov[1]])
    out = os.path.join(WORK, 'g_tagged.mp4')
    r = stamp_write(tail, out)
    check('moov-at-tail: 写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        check('moov-at-tail: 走零偏移策略', r.get('strategy') == 'moov-at-tail-zero-offset', str(r.get('strategy')))
        a, b = mdat_payload(open(tail, 'rb').read()), mdat_payload(open(out, 'rb').read())
        check('moov-at-tail: mdat 载荷不变', a == b)
        sa, sb = sample_offsets(open(tail, 'rb').read()), sample_offsets(open(out, 'rb').read())
        same = all(sa[ti][1] == sb[ti][1] for ti in sa)
        check('moov-at-tail: stco 偏移应完全不变', same)
        j = exif(out)
        check('moov-at-tail: 标题可读', (j.get('ItemList:Title') or j.get('Keys:Title')) == TAGS['title'])
except Exception as e:
    check('moov-at-tail 测试执行', False, str(e))

# ---- I. 动态照片 / MPF 多图索引平移 ----
print('\n\033[1m▌ I. 动态照片（MPF 多图索引）绝对偏移平移\033[0m\n')


def read_mpf(path):
    """独立解析 APP2 MPF（不依赖 stamp-js），返回 base 与逐图 size/offset。"""
    d = open(path, 'rb').read()
    i = 2
    while i + 4 <= len(d) and d[i] == 0xFF:
        m = d[i + 1]
        if m in (0xDA, 0xD9):
            break
        if m == 0x01 or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        if m == 0xFF:
            i += 1
            continue
        ln = struct.unpack('>H', d[i + 2:i + 4])[0]
        if m == 0xE2 and d[i + 4:i + 7] == b'MPF':
            p4, p8 = i + 8, i + 12
            if d[p8:p8 + 2] == b'MM':
                bo, e = '>', p8
            elif d[p8:p8 + 2] == b'II':
                bo, e = '<', p8
            elif d[p4:p4 + 2] == b'MM':
                bo, e = '>', p4
            elif d[p4:p4 + 2] == b'II':
                bo, e = '<', p4
            else:
                return None
            mp_off = struct.unpack(bo + 'I', d[e + 4:e + 8])[0]
            ifd = e + mp_off
            n = struct.unpack(bo + 'H', d[ifd:ifd + 2])[0]
            table, cnt = None, 0
            for k in range(n):
                q = ifd + 2 + k * 12
                tag = struct.unpack(bo + 'H', d[q:q + 2])[0]
                cc, vv = struct.unpack(bo + 'II', d[q + 4:q + 12])
                if tag == 0xB002:
                    cnt = cc // 16
                    table = (e + vv) if cc > 4 else q + 8
            out = []
            for k in range(cnt):
                q = table + k * 16
                attr, size, off = struct.unpack(bo + 'III', d[q:q + 12])
                out.append({'size': size, 'offset': off,
                            'abs': 0 if off == 0 else e + off})
            return {'size': len(d), 'base': e, 'entries': out}
        i += 2 + ln
    return None


def exif_mpf(path):
    """用 exiftool 独立读出 MPImage{n} 的 Start/Length（绝对偏移）。"""
    out = subprocess.run(['exiftool', '-a', '-G1', '-s', '-MPF:all', path],
                         capture_output=True, text=True).stdout
    return {(int(a), b): int(c)
            for a, b, c in re.findall(r'\[MPImage(\d)\]\s+MPImage(Start|Length)\s*:\s*(\d+)', out)}


def build_mpf_jpeg(base, payload, version=False, big=True, bom_override=None):
    """构造动态照片夹具：JPEG + 追加载荷 + APP2 MPF 索引。

    MP 头 = "MPF\\0" + TIFF 字节序标记 + MP Offset；MPEntry 的偏移以字节序
    标记为基准（与 vivo 实拍文件、exiftool 的读法一致）。
    """
    bom = bom_override if bom_override else (b'MM\x00*' if big else b'II*\x00')
    P = (lambda v: struct.pack('>I', v)) if big else (lambda v: struct.pack('<I', v))
    H = (lambda v: struct.pack('>H', v)) if big else (lambda v: struct.pack('<H', v))
    pre = b'MPF\x00' + (b'0100' if version else b'')
    e_seg = 4 + len(pre)                 # 字节序标记在「段」内的偏移
    ifd_seg = e_seg + 8                  # MP Offset = 8（相对字节序标记）
    table_seg = ifd_seg + 2 + 3 * 12 + 4

    def body(size1, size2, off2):
        ifd = H(3)
        ifd += H(0xB000) + H(7) + P(4) + b'0100'                # MPFVersion
        ifd += H(0xB001) + H(4) + P(1) + P(2)                   # NumberOfImages
        ifd += H(0xB002) + H(7) + P(32) + P(table_seg - e_seg)  # MPEntry 表
        ifd += P(0)                                             # next IFD
        table = P(0x00030000) + P(size1) + P(0) + P(0)
        table += P(0x00000000) + P(size2) + P(off2) + P(0)
        hdr = pre + bom + P(8)
        return hdr + b'\x00' * (ifd_seg - (4 + len(hdr))) + ifd + table

    body_len = len(body(0, 0, 0))
    primary_end = 2 + (4 + body_len) + (len(base) - 2)
    abs_bom = 2 + e_seg
    body = body(primary_end, len(payload), primary_end - abs_bom)
    assert len(body) == body_len
    seg = b'\xff\xe2' + struct.pack('>H', len(body) + 2) + body
    return base[:2] + seg + base[2:] + payload


# I1. 真实动态照片（vivo）：更小 / 更大的新标签都必须保持索引正确
orig = open(VIVO, 'rb').read() if VIVO else b''
ref = read_mpf(VIVO) if VIVO else None
if not VIVO:
    print('  ' + SKIP_NOTE + '（合成动态照片用例仍在下方运行）')
else:
    check('I1 真实动态照片：能独立解析出 MPF 索引（2 图）',
          ref is not None and len(ref['entries']) == 2, str(ref and ref['entries']))
    check('I1 真实动态照片：解析结果与 exiftool 一致',
          read_mpf(VIVO) is not None and
          exif_mpf(VIVO).get((2, 'Start')) == ref['entries'][1]['abs'] and
          exif_mpf(VIVO).get((2, 'Length')) == ref['entries'][1]['size'],
          str(exif_mpf(VIVO)))
payload_ref = orig[ref['entries'][1]['abs']:ref['entries'][1]['abs'] + ref['entries'][1]['size']] if ref else b''

for label, tags in ([('更小标签', {'title': 'S', 'artist': 'A', 'software': 'stamp-js'}),
                     ('更大标签', {'title': 'B', 'comment': 'C' * 3000, 'software': 'stamp-js'})]
                    if ref else []):
    out = os.path.join(WORK, f'i1_{len(tags.get("comment", ""))}.jpg')
    r = stamp_write(VIVO, out, tags)
    check(f'I1 真实动态照片({label}): 写入成功', r.get('ok'), r.get('error', ''))
    if not r.get('ok'):
        continue
    d = open(out, 'rb').read()
    m = read_mpf(out)
    delta = len(d) - len(orig)
    e1, e2 = m['entries'][0], m['entries'][1]
    check(f'I1 真实动态照片({label}): 主图长度随文件增量平移',
          e1['size'] == ref['entries'][0]['size'] + delta,
          f'{e1["size"]} vs {ref["entries"][0]["size"]} + {delta}')
    check(f'I1 真实动态照片({label}): 附加图偏移随文件增量平移',
          e2['abs'] == ref['entries'][1]['abs'] + delta,
          f'{e2["abs"]} vs {ref["entries"][1]["abs"]} + {delta}')
    check(f'I1 真实动态照片({label}): 新偏移与 exiftool 结论一致',
          exif_mpf(out).get((2, 'Start')) == e2['abs'] and exif_mpf(out).get((2, 'Length')) == e2['size'],
          str(exif_mpf(out)))
    check(f'I1 真实动态照片({label}): 新偏移处是合法 JPEG 起点', d[e2['abs']:e2['abs'] + 2] == b'\xff\xd8')
    check(f'I1 真实动态照片({label}): 附加图载荷逐字节未变',
          d[e2['abs']:e2['abs'] + e2['size']] == payload_ref)
    pa, _ = jpeg_pixels(VIVO)
    pb, _ = jpeg_pixels(out)
    check(f'I1 真实动态照片({label}): 主图像素未变', pa == pb)

# I2. 合成：附加载荷是视频（移动端动态照片的另一种形态）
base = base_jpeg_bytes()
fake_video = (b'\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41'
              b'moov\x00\x00\x00\x08' + bytes(range(256)) * 40)
fixture = os.path.join(WORK, 'i2_video_motion.jpg')
open(fixture, 'wb').write(build_mpf_jpeg(base, fake_video))
refv = read_mpf(fixture)
check('I2 合成夹具：MPF 索引指向追加的视频载荷',
      refv is not None and refv['entries'][1]['abs'] == os.path.getsize(fixture) - len(fake_video),
      str(refv and refv['entries']))
out = os.path.join(WORK, 'i2_tagged.jpg')
r = stamp_write(fixture, out, TAGS)
check('I2 视频型动态照片: 写入成功', r.get('ok'), r.get('error', ''))
if r.get('ok'):
    d = open(out, 'rb').read()
    m = read_mpf(out)
    e1, e2 = m['entries'][0], m['entries'][1]
    delta = len(d) - os.path.getsize(fixture)
    check('I2 视频型动态照片: 视频载荷偏移被平移', e2['abs'] == refv['entries'][1]['abs'] + delta,
          f'{e2["abs"]} vs {refv["entries"][1]["abs"]} + {delta}')
    check('I2 视频型动态照片: 视频载荷逐字节未变',
          d[e2['abs']:e2['abs'] + e2['size']] == fake_video)
    check('I2 视频型动态照片: 主图长度被平移', e1['size'] == refv['entries'][0]['size'] + delta)
    check('I2 视频型动态照片: exiftool 读出的偏移与库一致',
          exif_mpf(out).get((2, 'Start')) == e2['abs'], str(exif_mpf(out)))

# I3. 合成：真实布局 + 小端字节序 + 无版本字段的扩展布局（用真 JPEG 载荷，
#     以便 exiftool 完整解析并交叉核对）
small_jpg = os.path.join(WORK, 'i3_payload.jpg')
Image.new('RGB', (160, 120), (200, 30, 30)).save(small_jpg)
jpg_payload = open(small_jpg, 'rb').read()
for label, kw in [('真实布局(大端)', dict(version=False, big=True)),
                  ('小端字节序', dict(version=False, big=False)),
                  ('扩展布局(头部带版本字段)', dict(version=True, big=True))]:
    fx = os.path.join(WORK, f'i3_{label}.jpg'.replace('/', '_'))
    open(fx, 'wb').write(build_mpf_jpeg(base, jpg_payload, **kw))
    refx = read_mpf(fx)
    check(f'I3 {label}: 夹具与 exiftool 一致' if not kw['version'] else f'I3 {label}: 夹具自校验',
          refx is not None and
          (kw['version'] or exif_mpf(fx).get((2, 'Start')) == refx['entries'][1]['abs']),
          str(refx and refx['entries']))
    out = os.path.join(WORK, f'i3_out_{label}.jpg'.replace('/', '_'))
    r = stamp_write(fx, out, TAGS)
    check(f'I3 {label}: 写入成功', r.get('ok'), r.get('error', ''))
    if not r.get('ok'):
        continue
    d = open(out, 'rb').read()
    m = read_mpf(out)
    delta = len(d) - os.path.getsize(fx)
    check(f'I3 {label}: 附加载荷偏移平移正确',
          m['entries'][1]['abs'] == refx['entries'][1]['abs'] + delta,
          f'{m["entries"][1]["abs"]} vs {refx["entries"][1]["abs"]} + {delta}')
    check(f'I3 {label}: 载荷未变',
          d[m['entries'][1]['abs']:m['entries'][1]['abs'] + m['entries'][1]['size']] == jpg_payload)
    if not kw['version']:
        check(f'I3 {label}: exiftool 交叉核对新偏移',
              exif_mpf(out).get((2, 'Start')) == m['entries'][1]['abs'] and
              exif_mpf(out).get((2, 'Length')) == len(jpg_payload),
              str(exif_mpf(out)))

# I4. 索引损坏时必须拒绝，而不是留下悬空指针
bad = os.path.join(WORK, 'i4_broken.jpg')
open(bad, 'wb').write(build_mpf_jpeg(base, jpg_payload, bom_override=b'XX\x00*'))
r = stamp_write(bad, os.path.join(WORK, 'i4_out.jpg'), TAGS)
check('I4 损坏的 MPF 索引：拒绝写入并说明原因',
      (not r.get('ok')) and 'MPF' in (r.get('error') or ''), str(r.get('error'))[:100])
check('I4 损坏的 MPF 索引：未产出文件', not os.path.exists(os.path.join(WORK, 'i4_out.jpg')))

# I5. 无 MPF 的普通 JPEG 不受影响
plain_src = os.path.join(WORK, 'i5_plain_src.jpg')
open(plain_src, 'wb').write(base_jpeg_bytes())
out = os.path.join(WORK, 'i5_plain.jpg')
r = stamp_write(plain_src, out, TAGS)
check('I5 普通 JPEG（无 MPF）: 写入成功且无 MPF 报告', r.get('ok') and read_mpf(out) is None,
      str(r.get('error') or 'found MPF'))

# ---- H. 扩展 XMP（Extended XMP）分片清理 ----
print('\n\033[1m▌ H. 扩展 XMP：旧分片必须随标准包一并清除\033[0m\n')


def app1(payload):
    return b'\xff\xe1' + struct.pack('>H', len(payload) + 2) + payload


def jpeg_seg_sizes(path):
    """返回 [(类别, 段总长度)]，类别为 XMP / XMPEXT / EXIF。"""
    d = open(path, 'rb').read()
    out, i = [], 2
    while i + 4 <= len(d) and d[i] == 0xFF:
        m = d[i + 1]
        if m in (0xDA, 0xD9):
            break
        if m == 0x01 or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        if m == 0xFF:
            i += 1
            continue
        ln = struct.unpack('>H', d[i + 2:i + 4])[0]
        body = d[i + 4:i + 2 + ln]
        if m == 0xE1 and body.startswith(b'Exif\x00\x00'):
            out.append(('EXIF', 2 + ln))
        elif m == 0xE1 and body.startswith(STD_XMP):
            out.append(('XMP', 2 + ln))
        elif m == 0xE1 and body.startswith(EXT_XMP):
            out.append(('XMPEXT', 2 + ln))
        i += 2 + ln
    return out


try:
    d = base_jpeg_bytes()
    guid = b'ABCDEF0123456789ABCDEF0123456789'
    stale = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description '
             b'xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="STALE_EXT_PAYLOAD"/></rdf:RDF></x:xmpmeta>')
    # 扩展分段载荷 = 命名空间前缀 + GUID(32) + 全长(4) + 本段偏移(4) + 数据
    ext_payload = EXT_XMP + guid + struct.pack('>I', len(stale)) + struct.pack('>I', 0) + stale
    std = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description '
           b'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpNote="http://ns.adobe.com/xmp/note/" '
           b'xmpNote:HasExtendedXMP="ABCDEF0123456789ABCDEF0123456789" dc:title="OLD"/></rdf:RDF></x:xmpmeta>')

    src = os.path.join(WORK, 'h_extxmp.jpg')
    open(src, 'wb').write(d[:2] + app1(STD_XMP + std) + app1(ext_payload) + d[2:])
    check('扩展 XMP：夹具构造成功（1 标准包 + 1 extension 分片）',
          [n for n, _ in jpeg_seg_sizes(src)].count('XMP') == 1 and
          [n for n, _ in jpeg_seg_sizes(src)].count('XMPEXT') == 1,
          str(jpeg_seg_sizes(src)))

    out = os.path.join(WORK, 'h_tagged.jpg')
    r = stamp_write(src, out, TAGS)
    check('扩展 XMP：写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        after = jpeg_seg_sizes(out)
        names = [n for n, _ in after]
        data = open(out, 'rb').read()
        check('扩展 XMP：旧 extension 分片已被清除', names.count('XMPEXT') == 0, str(after))
        check('扩展 XMP：输出只剩 1 个标准包', names.count('XMP') == 1, str(after))
        j = exif(out)
        check('扩展 XMP：新标题可读（旧标准包已替换）', j.get('XMP-dc:Title') == TAGS['title'],
              f'got {j.get("XMP-dc:Title")!r}')
        check('扩展 XMP：旧分片内容已从文件中彻底消失', b'STALE_EXT_PAYLOAD' not in data)
        old_std = [s for n, s in jpeg_seg_sizes(src) if n == 'XMP'][0]
        ext_total = sum(s for n, s in jpeg_seg_sizes(src) if n == 'XMPEXT')
        new_std = [s for n, s in after if n == 'XMP'][0]
        # 本库还会补/重写一段原生 EXIF。注意源文件本来就可能已有 EXIF（真实截图就有），
        # 库是**原地重写**那一段，所以这里必须用「增量」而不是「输出中的总量」，
        # 否则基底换成真实素材时这条断言会凭空差出原有 EXIF 段的大小。
        old_exif = sum(s for n, s in jpeg_seg_sizes(src) if n == 'EXIF')
        new_exif = sum(s for n, s in after if n == 'EXIF')
        check('扩展 XMP：体积变化 == 新包增量 - 被删分片 (+ 原生 EXIF 增量)',
              len(data) == os.path.getsize(src) - ext_total + (new_std - old_std) + (new_exif - old_exif),
              f'{len(data)} != {os.path.getsize(src)} - {ext_total} + ({new_std} - {old_std}) + ({new_exif} - {old_exif})')
        check('扩展 XMP：主图像素未变', jpeg_pixels(src)[0] == jpeg_pixels(out)[0])
except Exception as e:
    check('扩展 XMP 场景执行', False, str(e)[:120])

# ---- J. 多 udta + mdta：合并 keys 表后数字索引必须重映射 ----
# 期望值由 exiftool 独立读出（不复用库自身断言）：若索引未重映射，
# 第二个 udta 的 artist 条目会按合并后的表解析成 title。
print('\n\033[1m▌ J. 多 udta + mdta：keys 表合并后数字索引必须重映射\033[0m\n')
try:
    import struct as _s

    def _box(t, *body):
        b = b''.join(body)
        return _s.pack('>I', 8 + len(b)) + t + b

    def _full(t, *body):
        b = b''.join(body)
        return _s.pack('>I', 12 + len(b)) + t + b'\x00\x00\x00\x00' + b

    def _idx_entry(i, val):
        payload = val.encode()
        inner = _s.pack('>I', 16 + len(payload)) + b'data' + _s.pack('>II', 1, 0) + payload
        return _s.pack('>I', 8 + len(inner)) + _s.pack('>I', i) + inner

    def _hdlr():
        body = b'\x00' * 4 + b'mdta' + b'\x00' * 12 + b'\x00'
        return _s.pack('>I', 12 + len(body)) + b'hdlr' + b'\x00\x00\x00\x00' + body

    def _keys(names):
        ents = b''.join(_s.pack('>I', 8 + len(n)) + b'mdta' + n.encode() for n in names)
        return _full(b'keys', _s.pack('>I', len(names)), ents)

    def _udta(names, entries):
        ilst = _box(b'ilst', *[_idx_entry(i, v) for i, v in entries])
        return _box(b'udta', _full(b'meta', _hdlr(), _keys(names), ilst))

    ftyp = _s.pack('>I', 32) + b'ftypisom' + _s.pack('>I', 0x200) + b'isomiso2avc1mp41'
    mvhd = _s.pack('>I', 108) + b'mvhd' + b'\x00' * 100
    # A: keys=[title, genre]; B: keys=[artist, genre]
    # 'artist' 在 B 里是索引 1，合并后是索引 3
    udta_a = _udta(['title', 'genre'], [(1, 'A0title'), (2, 'A0genre')])
    udta_b = _udta(['artist', 'genre'], [(1, 'ARTISTVALUE'), (2, 'B0genre')])
    moov = _box(b'moov', mvhd, udta_a, udta_b)
    mdat = _s.pack('>I', 8 + 4096) + b'mdat' + b'\x42' * 4096
    src = os.path.join(WORK, 'j_multi_src.mp4')
    open(src, 'wb').write(ftyp + moov + mdat)

    out = os.path.join(WORK, 'j_multi.mp4')
    r = stamp_write(src, out, {'title': 'NEWTITLE'})
    check('J 多 udta + mdta: 写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        j = exif(out)
        keys_seen = {k: v for k, v in j.items() if k.startswith('Keys:')}
        check('J 多 udta + mdta: artist 条目仍解析为 artist（索引已重映射）',
              j.get('Keys:Artist') == 'ARTISTVALUE', str(keys_seen))
        check('J 多 udta + mdta: title 为新值，未被 artist 条目污染',
              j.get('Keys:Title') == 'NEWTITLE', str(j.get('Keys:Title')))
        check('J 多 udta + mdta: 旧 genre 条目仍可读',
              j.get('Keys:Genre') in ('A0genre', 'B0genre'), str(j.get('Keys:Genre')))
        out2 = os.path.join(WORK, 'j_multi2.mp4')
        r2 = stamp_write(out, out2, {'title': 'NEWTITLE'})
        check('J 多 udta + mdta: 二次写入字节一致',
              bool(r2.get('ok')) and open(out, 'rb').read() == open(out2, 'rb').read())
except Exception as e:
    check('J 多 udta + mdta 场景执行', False, str(e)[:120])

# ---- K. moov/meta（Android/MediaTek 布局，QuickTime 风格）----
# 期望值由 exiftool 独立读出：真实 vivo/MediaTek 视频把标签放在 moov/meta，
# 且该 meta 没有 version/flags；旁边还有一个不含 meta 的 udta 占位盒。
print('\n\033[1m▌ K. moov/meta（QuickTime 风格）与无 meta 的 udta 占位盒\033[0m\n')
try:
    import struct as _s2

    def _b2(t, *body):
        x = b''.join(body)
        return _s2.pack('>I', 8 + len(x)) + t + x

    def _f2(t, *body):
        x = b''.join(body)
        return _s2.pack('>I', 12 + len(x)) + t + b'\x00\x00\x00\x00' + x

    def _idx2(i, val):
        payload = val.encode()
        inner = _s2.pack('>I', 16 + len(payload)) + b'data' + _s2.pack('>II', 1, 0) + payload
        return _s2.pack('>I', 8 + len(inner)) + _s2.pack('>I', i) + inner

    def _hdlr2():
        body = b'\x00' * 4 + b'mdta' + b'\x00' * 12 + b'\x00'
        return _s2.pack('>I', 12 + len(body)) + b'hdlr' + b'\x00\x00\x00\x00' + body

    def _keys2(names):
        ents = b''.join(_s2.pack('>I', 8 + len(n)) + b'mdta' + n.encode() for n in names)
        return _f2(b'keys', _s2.pack('>I', len(names)), ents)

    ftyp2 = _s2.pack('>I', 32) + b'ftypisom' + _s2.pack('>I', 0x200) + b'isomiso2avc1mp41'
    mvhd2 = _s2.pack('>I', 108) + b'mvhd' + b'\x00' * 100
    placeholder = _b2(b'udta', _s2.pack('>I', 30) + b'\x00' * 26)          # 无 meta 的占位 udta
    # 关键：meta 直接挂在 moov 下，且不带 version/flags（QuickTime 风格）
    meta_qt = _b2(b'meta', _hdlr2(), _keys2(['com.android.version']), _b2(b'ilst', _idx2(1, '16')))
    moov2 = _b2(b'moov', mvhd2, placeholder, meta_qt)
    mdat2 = _s2.pack('>I', 8 + 512) + b'mdat' + b'\x42' * 512
    src2 = os.path.join(WORK, 'k_moovmeta_src.mp4')
    open(src2, 'wb').write(ftyp2 + moov2 + mdat2)

    before = exif(src2)
    check('K 夹具：exiftool 能从 moov/meta 读出既有键',
          str(before.get('Keys:AndroidVersion')) == '16', str({k: v for k, v in before.items() if 'Keys' in k}))

    out2 = os.path.join(WORK, 'k_moovmeta_out.mp4')
    r = stamp_write(src2, out2, {'title': 'K title', 'artist': 'K artist'})
    check('K moov/meta: 写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        j = exif(out2)
        check('K moov/meta: exiftool 读到新标题', j.get('Keys:Title') == 'K title', str(j.get('Keys:Title')))
        check('K moov/meta: 既有键仍可读（未被破坏）',
              str(j.get('Keys:AndroidVersion')) == '16', str({k: v for k, v in j.items() if 'Keys' in k}))
        a = open(src2, 'rb').read(); b = open(out2, 'rb').read()
        check('K moov/meta: mdat 载荷逐字节不变',
              a.split(b'mdat', 1)[1] == b.split(b'mdat', 1)[1])
        # 无 meta 的 udta 占位盒必须原样保留
        check('K moov/meta: 无 meta 的 udta 占位盒原样保留', placeholder in b)
except Exception as e:
    check('K moov/meta 场景执行', False, str(e)[:120])

# ---- L. MP4 copyright 落到 exiftool 认得的字段；PNG IDAT 哈希不变 ----
print('\n\033[1m▌ L. MP4 copyright 映射（exiftool 反查）与 PNG IDAT 完整性\033[0m\n')
try:
    import struct as _s3

    def _b3(t, *body):
        x = b''.join(body)
        return _s3.pack('>I', 8 + len(x)) + t + x

    def _f3(t, *body):
        x = b''.join(body)
        return _s3.pack('>I', 12 + len(x)) + t + b'\x00\x00\x00\x00' + x

    def _data3(v):
        p = v.encode()
        return _s3.pack('>I', 16 + len(p)) + b'data' + _s3.pack('>II', 1, 0) + p

    def _hdlr3(kind):
        body = b'\x00' * 4 + kind.encode() + b'\x00' * 12 + b'\x00'
        return _s3.pack('>I', 12 + len(body)) + b'hdlr' + b'\x00\x00\x00\x00' + body

    ftyp3 = _s3.pack('>I', 32) + b'ftypisom' + _s3.pack('>I', 0x200) + b'isomiso2avc1mp41'
    mvhd3 = _s3.pack('>I', 108) + b'mvhd' + b'\x00' * 100
    mdat3 = _s3.pack('>I', 8 + 256) + b'mdat' + b'\x42' * 256

    # (a) mdir: copyright 必须写进 exiftool 认得的 ItemList:Copyright
    mdir = _b3(b'moov', mvhd3, _b3(b'udta', _f3(b'meta', _hdlr3('mdir'),
               _b3(b'ilst', _b3(b'\xa9cmt', _data3('keepme'))))))
    src_m = os.path.join(WORK, 'l_mdir_src.mp4')
    open(src_m, 'wb').write(ftyp3 + mdir + mdat3)
    out_m = os.path.join(WORK, 'l_mdir_out.mp4')
    r = stamp_write(src_m, out_m, {'copyright': 'COPYRIGHT-MDIR', 'title': 'L title'})
    check('L mdir: 写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        j = exif(out_m)
        check('L mdir: exiftool 读到 Copyright（映射正确）',
              j.get('ItemList:Copyright') == 'COPYRIGHT-MDIR', str(j.get('ItemList:Copyright')))
        check('L mdir: 既有条目保留', j.get('ItemList:Comment') == 'keepme', str(j.get('ItemList:Comment')))

    # (b) mdta: copyright 必须出现在 keys 表并落在 Keys:Copyright
    key_ent = _s3.pack('>I', 8 + len(b'genre')) + b'mdta' + b'genre'
    _val = b'Mgenre'
    _databox = _s3.pack('>I', 16 + len(_val)) + b'data' + _s3.pack('>II', 1, 0) + _val
    _entry = _s3.pack('>I', 8 + len(_databox)) + b'\x00\x00\x00\x01' + _databox
    meta_mdta = _b3(b'meta', _hdlr3('mdta'), _f3(b'keys', _s3.pack('>I', 1), key_ent),
                    _b3(b'ilst', _entry))
    src_d = os.path.join(WORK, 'l_mdta_src.mp4')
    open(src_d, 'wb').write(ftyp3 + _b3(b'moov', mvhd3, _b3(b'udta', meta_mdta)) + mdat3)
    out_d = os.path.join(WORK, 'l_mdta_out.mp4')
    r = stamp_write(src_d, out_d, {'copyright': 'COPYRIGHT-MDTA'})
    check('L mdta: 写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        j = exif(out_d)
        check('L mdta: exiftool 读到 Copyright', j.get('Keys:Copyright') == 'COPYRIGHT-MDTA',
              str(j.get('Keys:Copyright')))
        check('L mdta: 既有 key 保留', j.get('Keys:Genre') == 'Mgenre', str(j.get('Keys:Genre')))

    # (c) PNG: IDAT 字节完全不变（CRC 正确只能证明自洽，证明不了内容没被改）
    png_src = os.path.join(WORK, 'l_src.png')
    Image.new('RGB', (400, 300), (10, 120, 200)).save(png_src, 'PNG', compress_level=6)
    png_out = os.path.join(WORK, 'l_out.png')
    r = stamp_write(png_src, png_out, {'title': 'L png', 'keywords': ['k1', 'k2']})
    check('L PNG: 写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        def idat_bytes(path):
            d = open(path, 'rb').read()
            acc = b''; p = 8
            while p + 8 <= len(d):
                ln = _s3.unpack('>I', d[p:p+4])[0]; t = d[p+4:p+8]
                if t == b'IDAT':
                    acc += d[p+8:p+8+ln]
                if t == b'IEND':
                    break
                p += 12 + ln
            return acc
        a, b = idat_bytes(png_src), idat_bytes(png_out)
        check('L PNG: IDAT sha256 与输入一致', hashlib.sha256(a).hexdigest() == hashlib.sha256(b).hexdigest(),
              f'{sha(a)} vs {sha(b)} ({len(a)} bytes)')
        check('L PNG: exiftool 读到新标题', exif(png_out).get('XMP-dc:Title') == 'L png')
except Exception as e:
    check('L 场景执行', False, str(e)[:160])

# ---- M. JPEG 原生 EXIF IFD0：第三方确认 + 其余 EXIF 未被破坏 ----
print('\n\033[1m▌ M. JPEG native EXIF（IFD0）与既有 EXIF 的完整性\033[0m\n')
try:
    FIXTURE = os.path.join(WORK, 'm_exif_src.jpg')
    gen = (f"import * as F from {json.dumps(os.path.join(HERE, 'fixtures.mjs'))};"
           "import fs from 'node:fs';"
           f"fs.writeFileSync({json.dumps(FIXTURE)}, Buffer.from(F.buildJpegWithExif().bytes));")
    subprocess.run(['node', '--input-type=module', '-e', gen], check=True, timeout=60, capture_output=True)

    NATIVE = {'title': 'Native 标题', 'artist': 'Native Artist', 'copyright': '© 2026 asinnny',
              'date': '2026-09-23T01:02:03Z', 'comment': 'XMP only', 'software': 'stamp-js'}

    def check_native(label, src, out, ignore_targets=True):
        a, b = exif(src), exif(out)
        ok = True
        if b.get('IFD0:ImageDescription') != NATIVE['title']:
            check(f'{label}: IFD0 ImageDescription = 标题', False, repr(b.get('IFD0:ImageDescription'))); ok = False
        if b.get('IFD0:Artist') != NATIVE['artist']:
            check(f'{label}: IFD0 Artist = 作者', False, repr(b.get('IFD0:Artist'))); ok = False
        if b.get('IFD0:Copyright') != NATIVE['copyright']:
            check(f'{label}: IFD0 Copyright = 版权', False, repr(b.get('IFD0:Copyright'))); ok = False
        if b.get('IFD0:ModifyDate') != '2026:09:23 01:02:03':
            check(f'{label}: IFD0 DateTime 已转换', False, repr(b.get('IFD0:ModifyDate'))); ok = False
        if ok:
            check(f'{label}: exiftool 读到 4 个原生字段（Title/Artist/Copyright/DateTime）', True)
        # 除目标字段（含 XMP 重写）外，任何 EXIF 字段都不许变
        target = {'IFD0:ImageDescription', 'IFD0:Artist', 'IFD0:Copyright', 'IFD0:ModifyDate',
                  'ExifIFD:UserComment'}
        skip = ('SourceFile', 'File:', 'System:', 'ExifTool:', 'Composite:', 'XMP-', 'Photoshop:')
        diff = {k: (a.get(k), b.get(k)) for k in set(a) | set(b)
                if k not in target and not k.startswith(skip) and a.get(k) != b.get(k)}
        check(f'{label}: 其余 EXIF 字段零差异（GPS/ExifIFD/缩略图/MakerNotes）',
              not diff, str(list(diff.items())[:2]) if diff else '')
        return a, b

    # (a) 合成夹具：结构完整、exiftool -validate OK
    base = exif(FIXTURE)
    check('M 夹具：exiftool 能读出 Make/Model/GPS/DateTimeOriginal',
          base.get('IFD0:Make') == 'TESTCAM' and base.get('GPS:GPSLatitude') is not None
          and base.get('ExifIFD:DateTimeOriginal') == '2020:01:01 00:00:00', str(base.get('IFD0:Make')))
    out_exif = os.path.join(WORK, 'm_exif_out.jpg')
    r = stamp_write(FIXTURE, out_exif, NATIVE)
    check('M 夹具：写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        a, b = check_native('M 夹具', FIXTURE, out_exif)
        check('M 夹具：DateTimeOriginal 未被覆写（真实拍摄时间应保留）',
              b.get('ExifIFD:DateTimeOriginal') == '2020:01:01 00:00:00', repr(b.get('ExifIFD:DateTimeOriginal')))
        check('M 夹具：IFD0 Software 未被覆写（相机固件串保留）',
              b.get('IFD0:Software') == 'FW 01.0', repr(b.get('IFD0:Software')))
        check('M 夹具：XMP 侧仍完整（comment/url/keywords 走 XMP）',
              b.get('XMP-dc:Description') is not None and b.get('XMP-dc:Creator') == NATIVE['artist'])
        # Compare against the input instead of demanding "OK": the fixture carries a
        # placeholder thumbnail, and exiftool versions differ in what they warn
        # about, so what matters is that *our write* adds no new warning.
        def validate_warnings(path):
            out = subprocess.run(['exiftool', '-s', '-validate', path], capture_output=True, text=True).stdout
            return out.count('Warning'), out.strip().replace('\n', ' | ')[:140]
        w_in, t_in = validate_warnings(FIXTURE)
        w_out, t_out = validate_warnings(out_exif)
        check('M 夹具：写入未引入新的 exiftool 告警', w_out <= w_in,
              'in=%d out=%d\n      %s\n      %s' % (w_in, w_out, t_in, t_out))

    # (b) PNG eXIf + UserComment（第三方确认）
    PNG_FIX = os.path.join(WORK, 'm_exif_src.png')
    gen2 = (f"import * as F from {json.dumps(os.path.join(HERE, 'fixtures.mjs'))};"
            "import fs from 'node:fs';"
            f"fs.writeFileSync({json.dumps(PNG_FIX)}, Buffer.from(F.buildPngWithExif().bytes));")
    subprocess.run(['node', '--input-type=module', '-e', gen2], check=True, timeout=60, capture_output=True)
    base_png = exif(PNG_FIX)
    check('M PNG 夹具：exiftool 从 eXIf 读出 Make/GPS',
          base_png.get('IFD0:Make') == 'TESTCAM' and base_png.get('GPS:GPSLatitude') is not None,
          str(base_png.get('IFD0:Make')))
    out_png = os.path.join(WORK, 'm_exif_out.png')
    r = stamp_write(PNG_FIX, out_png, NATIVE)
    check('M PNG eXIf：写入成功', r.get('ok'), r.get('error', ''))
    if r.get('ok'):
        b = exif(out_png)
        check('M PNG eXIf：exiftool 读到原生字段（日期走 PNG 自己的 Creation Time 块）',
              b.get('IFD0:ImageDescription') == NATIVE['title']
              and b.get('IFD0:Artist') == NATIVE['artist']
              and b.get('IFD0:Copyright') == NATIVE['copyright']
              and b.get('IFD0:ModifyDate') is None
              and b.get('PNG:CreationTime') == '2026-09-23T01:02:03Z',
              repr([b.get('IFD0:ImageDescription'), b.get('IFD0:ModifyDate'), b.get('PNG:CreationTime')]))
        check('M PNG eXIf：GPS/缩略图不变（仅追加）',
              b.get('GPS:GPSLatitude') == base_png.get('GPS:GPSLatitude')
              and b.get('IFD1:ThumbnailLength') == base_png.get('IFD1:ThumbnailLength'),
              '%s / %s' % (b.get('GPS:GPSLatitude'), b.get('IFD1:ThumbnailLength')))
        v = subprocess.run(['exiftool', '-s', '-validate', out_png], capture_output=True, text=True).stdout
        check('M PNG eXIf：写入未引入新的 exiftool 告警',
              'Error' not in v and 'Non standard PNG date' not in v, v.strip()[:80])

    # (c) UserComment 的字符集前缀（ASCII 与 UNICODE+BOM）
    ascii_out = os.path.join(WORK, 'm_uc_ascii.jpg')
    r = stamp_write(FIXTURE, ascii_out, {**NATIVE, 'comment': 'plain ascii comment'})
    if r.get('ok'):
        check('M UserComment(ASCII)：exiftool 正确读出',
              exif(ascii_out).get('ExifIFD:UserComment') == 'plain ascii comment',
              repr(exif(ascii_out).get('ExifIFD:UserComment')))
    cn_out = os.path.join(WORK, 'm_uc_cn.jpg')
    r = stamp_write(FIXTURE, cn_out, {**NATIVE, 'comment': '中文备注 🚀'})
    if r.get('ok'):
        got = exif(cn_out).get('ExifIFD:UserComment')
        check('M UserComment(UNICODE+BOM)：中文/emoji 正确读出', got == '中文备注 🚀', repr(got))
        check('M UserComment：DateTimeOriginal 未被覆写',
              exif(cn_out).get('ExifIFD:DateTimeOriginal') == '2020:01:01 00:00:00')

    # (d) 真实素材（不含素材时自动跳过）
    real = [p for p in [VIVO, SHOT] if p] + \
           [os.path.join(MEDIA, n) for n in ('IMG_20260829_205846.jpg', 'IMG_20260915_114241.jpg')
            if os.path.exists(os.path.join(MEDIA, n))]
    rich = [p for p in real if exif(p).get('IFD0:Make')]
    if not rich:
        print('  ' + SKIP_NOTE)
    for src in rich:
        name = os.path.basename(src)
        dst = os.path.join(WORK, 'm_real_' + name)
        r = stamp_write(src, dst, NATIVE)
        check(f'M 真实素材 {name}: 写入成功', r.get('ok'), r.get('error', ''))
        if not r.get('ok'):
            continue
        a, b = check_native('M 真实素材 ' + name, src, dst)
        check(f'M 真实素材 {name}: Make/Model 保留',
              b.get('IFD0:Make') == a.get('IFD0:Make') and b.get('IFD0:Model') == a.get('IFD0:Model'),
              '%s/%s' % (b.get('IFD0:Make'), b.get('IFD0:Model')))
except Exception as e:
    check('M 原生 EXIF 场景执行', False, str(e)[:160])

# ---- 汇总 ----
print('\n' + '=' * 74)
print(f' {"ALL PASSED" if FAIL == 0 else "SOME FAILED"}   {PASS} passed, {FAIL} failed, {len(GAPS)} known gap(s)')
if GAPS:
    for n, det in GAPS:
        print(f'   △ {n}: {det}')
print('=' * 74)
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(0 if FAIL == 0 else 1)
