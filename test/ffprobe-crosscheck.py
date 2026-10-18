#!/usr/bin/env python3
"""
ffprobe / ffmpeg 独立交叉校验套件
=============================================================================
使用独立第三方多媒体工具链 (ffmpeg / ffprobe) 验证 stamp-js 的 MP4 / MOV 写入：
  1. 正常文件：faststart MP4、moov-at-tail MP4、QuickTime MOV（含 H.264 视频流 + AAC 音频流）
  2. 元数据读取：通过 ffprobe 独立验证 title / artist / album / genre / comment /
     date / encodedDate (creation_time) 等标签与容器时长、流数量、编解码器一致
  3. 播放与解码兼容性：通过 `ffmpeg -v error -i <file> -f null -` 独立完整解码音视频帧，
     证明重写 moov 及平移 stco/co64 后容器可被标准播放器无错解码播放
  4. 重复写入文件：连续 3 次写入同一文件，以及覆盖写入新标签，验证字节幂等与可解码性
  5. 较大文件：构造数 MB 的多塊真实编码 MP4 视频，验证仅读取头部+moov 且解码无损
  6. 边界偏移文件：stco 接近 4 GiB (0xFFFFFFFF) 的奇数/偶数条目升级为 co64，
     独立验证 8 字节对齐不变式 (delta % 8 == 0) 与全部 64 位偏移准确性

测试状态严格区分：PASS（通过）、FAIL（失败）、SKIP（因依赖或外部素材缺失跳过，绝不计入 PASS）、NOT_RUN（未执行）。
"""
import glob
import json
import os
import shutil
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STAMP = os.path.abspath(os.path.join(HERE, '..', 'src', 'stamp.js'))
MEDIA = os.environ.get('STAMP_TEST_MEDIA') or '/workspace/upload'
WORK = '/tmp/stamp-ffprobe'

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


MISSING = [t for t in ('node', 'ffprobe', 'ffmpeg') if shutil.which(t) is None]
if MISSING:
    skip('ffprobe/ffmpeg 独立交叉校验套件', '缺少依赖: ' + ', '.join(MISSING))
    print(f'\n汇总: {PASS} passed, {FAIL} failed, {SKIP} skipped, {NOT_RUN} not run')
    sys.exit(2)

shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK, exist_ok=True)


def write_tags_node(src, dst, tags, opts=None):
    script = f"""
import {{ writeTags, inspect, BlobSource }} from {json.dumps(STAMP)};
import fs from 'node:fs';
const buf = fs.readFileSync({json.dumps(src)});
const blob = new Blob([buf]);
const res = await writeTags(new BlobSource(blob), {json.dumps(tags)}, {json.dumps(opts or {})});
if (!res.ok) {{
  console.log(JSON.stringify({{ ok: false, error: res.report.error, errorCode: res.report.errorCode }}));
  process.exit(0);
}}
const outBuf = Buffer.from(await res.blob.arrayBuffer());
fs.writeFileSync({json.dumps(dst)}, outBuf);
const info = await inspect(new BlobSource(new Blob([outBuf])));
console.log(JSON.stringify({{
  ok: true,
  inputSize: buf.length,
  outputSize: outBuf.length,
  delta: res.report.delta,
  bytesRead: res.report.planning ? res.report.planning.bytesRead : res.report.stats.bytesRead,
  strategy: res.report.strategy,
  inspectSafe: info.safeToWrite,
  existingTags: info.existingTags
}}));
"""
    r = subprocess.run(['node', '--input-type=module', '-e', script],
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return {'ok': False, 'error': (r.stderr or r.stdout).strip()[:240]}
    return json.loads(r.stdout.strip())


def ffprobe_info(path):
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
        capture_output=True, text=True, timeout=60
    )
    if r.returncode != 0:
        return None
    d = json.loads(r.stdout)
    fmt = d.get('format', {})
    streams = d.get('streams', [])
    return {
        'streams': len(streams),
        'duration': round(float(fmt.get('duration') or 0), 2),
        'codecs': sorted(s.get('codec_name', '') for s in streams),
        'tags': {k.lower(): v for k, v in (fmt.get('tags') or {}).items()},
        'stream_creation_times': [
            (s.get('tags') or {}).get('creation_time') for s in streams
        ],
    }


def ffmpeg_decode_ok(path):
    """Run full audio/video stream decoding via ffmpeg to verify playback compatibility."""
    r = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'],
        capture_output=True, text=True, timeout=120
    )
    return r.returncode == 0 and not r.stderr.strip(), r.stderr.strip()[:200]


def generate_ffmpeg_media():
    """Generate real playable H.264 + AAC MP4 (faststart & tail) and MOV files."""
    mp4_fast = os.path.join(WORK, 'gen_faststart.mp4')
    mp4_tail = os.path.join(WORK, 'gen_tail.mp4')
    mov_fast = os.path.join(WORK, 'gen_faststart.mov')
    mp4_large = os.path.join(WORK, 'gen_large.mp4')

    base_cmd = [
        'ffmpeg', '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=1.5:size=320x240:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '64k',
    ]
    subprocess.run(base_cmd + ['-movflags', '+faststart', mp4_fast], check=True, timeout=60)
    subprocess.run(base_cmd + [mp4_tail], check=True, timeout=60)
    subprocess.run(base_cmd + ['-bitexact', '-movflags', '+faststart', '-f', 'mov', mov_fast], check=True, timeout=60)

    # Larger multi-chunk video (high-entropy noise frames so mdat is ~1.5-3 MB)
    large_cmd = [
        'ffmpeg', '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'nullsrc=s=640x480:d=3:r=25,geq=random(1)*255:128:128',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '10',
        '-g', '5', '-c:a', 'aac', '-movflags', '+faststart', mp4_large,
    ]
    subprocess.run(large_cmd, check=True, timeout=90)
    return [
        ('MP4 faststart (moov-at-head)', mp4_fast),
        ('MP4 moov-at-tail', mp4_tail),
        ('QuickTime MOV (faststart)', mov_fast),
        ('Larger multi-chunk MP4', mp4_large),
    ]


print('\n\033[1m▌ 1. 正常文件与较大文件：MP4/MOV 写入 + ffprobe 标签读取 + ffmpeg 全帧解码播放验证\033[0m\n')

TAGS = {
    'title': 'FFprobe Verified Title',
    'artist': 'stamp-js 0.1.2',
    'album': 'Verification Suite',
    'genre': 'Technology',
    'comment': 'Verified by ffprobe and ffmpeg decode',
    'copyright': '© 2026 stamp-js',
    'date': '2026-04-02T09:30:00Z',
    'encodedDate': '2026-04-02T09:30:00Z',
    'taggedDate': '2026-04-03T15:45:00Z',
    'software': 'stamp-js/0.1.2',
}

generated = generate_ffmpeg_media()
for label, src in generated:
    before = ffprobe_info(src)
    check(f'{label}: 原始文件可被 ffprobe 解析', before is not None)
    if before is None:
        mark_not_run(f'{label}: 后续校验', '输入无法被 ffprobe 解析')
        continue

    dst = src + '.tagged.mp4' if src.endswith('.mp4') else src + '.tagged.mov'
    r = write_tags_node(src, dst, TAGS)
    check(f'{label}: stamp-js 写入成功', r.get('ok') is True, r.get('error', ''))
    if not r.get('ok'):
        mark_not_run(f'{label}: ffprobe/ffmpeg 校验', '写入失败')
        continue

    after = ffprobe_info(dst)
    check(f'{label}: 写入后可被 ffprobe 解析', after is not None)
    if after:
        check(f'{label}: 流数量一致 ({before["streams"]})', after['streams'] == before['streams'])
        check(f'{label}: 时长一致 ({before["duration"]}s)', after['duration'] == before['duration'])
        check(f'{label}: 编解码器一致 ({",".join(before["codecs"])})', after['codecs'] == before['codecs'])
        t = after['tags']
        check(f'{label}: ffprobe 读出 title == "{TAGS["title"]}"', t.get('title') == TAGS['title'], str(t))
        check(f'{label}: ffprobe 读出 artist == "{TAGS["artist"]}"', t.get('artist') == TAGS['artist'], str(t))
        check(f'{label}: ffprobe 读出 album == "{TAGS["album"]}"', t.get('album') == TAGS['album'], str(t))
        check(f'{label}: ffprobe 读出 genre == "{TAGS["genre"]}"', t.get('genre') == TAGS['genre'], str(t))
        check(f'{label}: ffprobe 读出 comment', TAGS['comment'] in (t.get('comment') or ''), str(t))
        check(f'{label}: ffprobe 读出 creation_time (encodedDate = 2026-04-02T09:30:00)',
              '2026-04-02T09:30:00' in (t.get('creation_time') or ''), str(t.get('creation_time')))
        check(f'{label}: 所有媒体流 tkhd/mdhd creation_time 已同步更新',
              all('2026-04-02T09:30:00' in (ct or '') for ct in after['stream_creation_times']),
              str(after['stream_creation_times']))

    dec_ok, dec_err = ffmpeg_decode_ok(dst)
    check(f'{label}: ffmpeg 完整解码所有音视频帧无报错（播放兼容性验证）', dec_ok, dec_err)

    if 'Larger' in label:
        check(f'{label}: 较大文件 ({r["inputSize"]} B) 仅读取头部+moov ({r["bytesRead"]} B < 15%)',
              r['bytesRead'] < r['inputSize'] * 0.15,
              f'bytesRead={r["bytesRead"]} inputSize={r["inputSize"]}')


print('\n\033[1m▌ 2. 重复写入文件：连续多次写入与覆盖写入验证\033[0m\n')
for label, src in generated[:3]:
    p1 = src + '.rep1'
    p2 = src + '.rep2'
    p3 = src + '.rep3'
    r1 = write_tags_node(src, p1, TAGS)
    r2 = write_tags_node(p1, p2, TAGS)
    r3 = write_tags_node(p2, p3, {**TAGS, 'title': 'Overwritten Title', 'artist': 'New Artist'})
    check(f'{label}: 连续 3 次写入全部成功', r1.get('ok') and r2.get('ok') and r3.get('ok'))
    if r1.get('ok') and r2.get('ok') and r3.get('ok'):
        b1, b2 = open(p1, 'rb').read(), open(p2, 'rb').read()
        check(f'{label}: 相同标签第二次写入逐字节完全一致（幂等）', b1 == b2, f'{len(b1)} vs {len(b2)}')
        after3 = ffprobe_info(p3)
        dec3_ok, dec3_err = ffmpeg_decode_ok(p3)
        check(f'{label}: 覆盖写入后 ffprobe 读出新标题且保留原 album/genre',
              after3 is not None
              and after3['tags'].get('title') == 'Overwritten Title'
              and after3['tags'].get('artist') == 'New Artist'
              and after3['tags'].get('album') == TAGS['album']
              and after3['tags'].get('genre') == TAGS['genre'],
              str(after3 and after3['tags']))
        check(f'{label}: 覆盖写入后 ffmpeg 完整解码播放无报错', dec3_ok, dec3_err)


print('\n\033[1m▌ 3. 边界偏移文件：stco 接近 4 GiB 升级为 co64（奇偶条目 + 8 字节对齐独立验证）\033[0m\n')
boundary_script = f"""
import {{ writeTags, BufferSource, u32, u64, fourcc }} from {json.dumps(STAMP)};
const cat = (...a) => {{ const f = a.flat(); const n = f.reduce((s, c) => s + c.length, 0); const o = new Uint8Array(n); let p = 0; for (const c of f) {{ o.set(c, p); p += c.length; }} return o; }};
const u2 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const a2 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
const z2 = (n) => new Uint8Array(n);
const box2 = (t, ...b) => {{ const x = cat(...b); return cat(u2(8 + x.length), a2(t), x); }};
const full2 = (t, ...b) => {{ const x = cat(...b); return cat(u2(12 + x.length), a2(t), z2(4), x); }};

const results = [];
for (const count of [1, 2, 3, 4, 5]) {{
  const baseOff = 0xFFFFFFF0 - (count - 1) * 4;
  const rawOffsets = Array.from({{ length: count }}, (_, i) => baseOff + i * 4);
  const FAKE_SIZE = 0xFFFFFFFF + 4096;
  const ftp = cat(u2(32), a2('ftyp'), a2('isom'), u2(0x200), a2('isom'), a2('iso2'), a2('avc1'), a2('mp41'));
  const mvhd = cat(u2(108), a2('mvhd'), z2(100));
  const stco = full2('stco', u2(count), ...rawOffsets.map(u2));
  const trak = box2('trak', box2('mdia', box2('minf', box2('stbl', stco))));
  const moov = box2('moov', mvhd, trak);
  const mdatSz = FAKE_SIZE - ftp.length - moov.length;
  const b8 = new Uint8Array(8);
  new DataView(b8.buffer).setBigUint64(0, BigInt(mdatSz));
  const head = cat(ftp, moov, u2(1), a2('mdat'), b8);

  class BoundarySource extends BufferSource {{
    constructor() {{ super(head, 'video/mp4'); this.size = FAKE_SIZE; }}
    async read(s, e) {{
      if (e <= this.bytes.length) return this.bytes.subarray(s, e);
      const out = new Uint8Array(e - s);
      const avail = Math.max(0, Math.min(this.bytes.length - s, out.length));
      if (avail > 0) out.set(this.bytes.subarray(s, s + avail), 0);
      return out;
    }}
    canSlice() {{ return false; }}
  }}
  const res = await writeTags(new BoundarySource(), {{ title: 'Boundary Test' }}, {{ materialize: false }});
  const outMoov = res.parts.find((p) => p.kind === 'bytes').bytes;
  results.push({{
    count,
    ok: res.ok,
    origMoovLen: moov.length,
    newMoovLen: outMoov.length,
    reportDelta: res.report.delta,
    rawOffsets,
    moovHex: Buffer.from(outMoov).toString('hex')
  }});
}}
console.log(JSON.stringify(results));
"""
r_bound = subprocess.run(['node', '--input-type=module', '-e', boundary_script],
                         capture_output=True, text=True, check=True, timeout=60)
bound_cases = json.loads(r_bound.stdout.strip())


def parse_co64_from_moov(moov_bytes):
    """Independent Python parser for stco/co64 inside moov."""
    stco_list, co64_list = [], []

    def walk(s, e):
        p = s
        while p + 8 <= e:
            sz = struct.unpack('>I', moov_bytes[p:p + 4])[0]
            tp = moov_bytes[p + 4:p + 8].decode('latin1')
            hdr = 8
            if sz == 1:
                sz = struct.unpack('>Q', moov_bytes[p + 8:p + 16])[0]
                hdr = 16
            elif sz == 0:
                sz = e - p
            if sz < hdr or p + sz > e:
                break
            if tp == 'stco':
                n = struct.unpack('>I', moov_bytes[p + 12:p + 16])[0]
                stco_list.extend(struct.unpack(f'>{n}I', moov_bytes[p + 16:p + 16 + 4 * n]))
            elif tp == 'co64':
                n = struct.unpack('>I', moov_bytes[p + 12:p + 16])[0]
                co64_list.extend(struct.unpack(f'>{n}Q', moov_bytes[p + 16:p + 16 + 8 * n]))
            elif tp in ('moov', 'trak', 'mdia', 'minf', 'stbl'):
                walk(p + hdr, p + sz)
            p += sz

    walk(0, len(moov_bytes))
    return stco_list, co64_list


for bc in bound_cases:
    cnt = bc['count']
    moov_b = bytes.fromhex(bc['moovHex'])
    delta = bc['newMoovLen'] - bc['origMoovLen']
    stco_out, co64_out = parse_co64_from_moov(moov_b)
    check(f'边界 stco->co64 (entries={cnt}, {"奇数" if cnt % 2 else "偶数"}): 写入成功且最终增长量 ({delta}) 满足 8 字节对齐不变式',
          bc['ok'] and delta == bc['reportDelta'] and delta % 8 == 0,
          f'delta={delta}, reportDelta={bc["reportDelta"]}')
    expected = [x + delta for x in bc['rawOffsets']]
    check(f'边界 stco->co64 (entries={cnt}): Python 独立解析确认全部 {cnt} 个偏移升级为 co64 且等于 orig + {delta}',
          len(stco_out) == 0 and co64_out == expected,
          f'co64={co64_out} expected={expected}')


print('\n\033[1m▌ 4. 外部真实设备视频素材（可选目录 STAMP_TEST_MEDIA）\033[0m\n')
vids = sorted(glob.glob(os.path.join(MEDIA, '*.mp4')) + glob.glob(os.path.join(MEDIA, '*.mov')))
if not vids:
    skip(f'外部真实设备素材目录 ({MEDIA})', '当前环境未挂载外部实拍视频文件')
else:
    for src in vids:
        name = os.path.basename(src)
        before = ffprobe_info(src)
        if before is None:
            check(f'{name}: 输入可被 ffprobe 解析', False, 'ffprobe failed on input')
            continue
        dst = os.path.join(WORK, name)
        r = write_tags_node(src, dst, TAGS)
        check(f'{name}: 写入成功', r.get('ok'), r.get('error', ''))
        if not r.get('ok'):
            continue
        after = ffprobe_info(dst)
        check(f'{name}: 输出仍可被 ffprobe 解析', after is not None)
        if after:
            check(f'{name}: 流数量一致 ({before["streams"]})', after['streams'] == before['streams'])
            check(f'{name}: 时长一致 ({before["duration"]:.2f}s)', after['duration'] == before['duration'])
            check(f'{name}: 编解码器一致', after['codecs'] == before['codecs'])
        dec_ok, dec_err = ffmpeg_decode_ok(dst)
        check(f'{name}: ffmpeg 完整解码无报错', dec_ok, dec_err)

shutil.rmtree(WORK, ignore_errors=True)

print('\n' + '=' * 74)
status_str = '\033[32mALL EXECUTED PASSED\033[0m' if FAIL == 0 else '\033[31mSOME FAILED\033[0m'
print(f' {status_str}   {PASS} passed, {FAIL} failed, {SKIP} skipped, {NOT_RUN} not run')
print('=' * 74)
sys.exit(0 if FAIL == 0 else 1)
