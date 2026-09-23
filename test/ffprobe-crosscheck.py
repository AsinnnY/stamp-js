#!/usr/bin/env python3
"""
ffprobe 交叉校验：真实视频写入标签后，仍应能解出**相同的流数量与时长**。
=============================================================================
这是唯一需要 ffmpeg/ffprobe 的套件（其它套件只用 exiftool / Pillow）：
  - 它对"容器是否仍然可被独立解码器正常打开"给出第三方判据，
    而 mdat 哈希只能证明字节没动，证明不了容器结构仍然自洽。

素材目录：STAMP_TEST_MEDIA（默认 /workspace/upload），没有视频时明确跳过。

运行：python3 test/ffprobe-crosscheck.py
依赖：node>=18 / ffprobe
"""
import glob
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STAMP = os.path.join(HERE, '..', 'src', 'stamp.js')
MEDIA = os.environ.get('STAMP_TEST_MEDIA') or '/workspace/upload'
WORK = '/tmp/stamp-ffprobe'

# 缺依赖时明确 SKIP（退出码 2），不做降级断言 —— 与其它验证套件一致
MISSING = [t for t in ('node', 'ffprobe') if shutil.which(t) is None]
if MISSING:
    print('\n\033[33mSKIP\033[0m 缺少依赖: ' + ', '.join(MISSING))
    print('  ffprobe 交叉校验需要 node 与 ffprobe（apt-get install -y ffmpeg）')
    print('  以退出码 2 结束（0=通过、1=断言失败、2=缺依赖）')
    sys.exit(2)

vids = sorted(glob.glob(os.path.join(MEDIA, '*.mp4')) + glob.glob(os.path.join(MEDIA, '*.mov')))
if not vids:
    print('\n\033[33mSKIP\033[0m %s 下没有 mp4/mov 素材' % MEDIA)
    sys.exit(0)

os.makedirs(WORK, exist_ok=True)
PASS = FAIL = 0


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  \033[32m✓\033[0m %s' % name)
    else:
        FAIL += 1
        print('  \033[31m✗\033[0m %s%s' % (name, ('  \033[33m→ ' + str(extra) + '\033[0m') if extra else ''))


def write_tags(src, dst):
    script = f"""
import {{ writeTags, capabilities, BlobSource }} from {json.dumps(os.path.abspath(STAMP))};
import fs from 'node:fs';
const blob = await fs.openAsBlob({json.dumps(src)});
const full = {{ title: 'ffprobe crosscheck', artist: 'ci', date: '2026-09-23T00:00:00Z',
               comment: 'container must stay decodable', software: 'stamp-js' }};
let res = await writeTags(new BlobSource(blob), full);
if (!res.ok && res.report.errorCode === 'UNSUPPORTED_TAG') {{
  console.log(JSON.stringify({{ ok: false, error: res.report.error }})); process.exit(0);
}}
if (!res.ok) {{ console.log(JSON.stringify({{ ok: false, error: res.report.error }})); process.exit(0); }}
fs.writeFileSync({json.dumps(dst)}, Buffer.from(await res.blob.arrayBuffer()));
console.log(JSON.stringify({{ ok: true, bytesRead: res.report.stats.bytesRead }}));
"""
    r = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return {'ok': False, 'error': (r.stderr or r.stdout).strip()[:200]}
    return json.loads(r.stdout.strip())


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json',
                        '-show_streams', '-show_format', path], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    d = json.loads(r.stdout)
    return {
        'streams': len(d.get('streams', [])),
        'duration': round(float(d.get('format', {}).get('duration') or 0), 2),
        'codecs': sorted(s.get('codec_name') for s in d.get('streams', [])),
    }


print('\n\033[1m▌ ffprobe 交叉校验：标签写入后容器仍可正常解析\033[0m\n')
for src in vids:
    name = os.path.basename(src)
    before = probe(src)
    if before is None:
        check('%s: 输入可被 ffprobe 解析' % name, False, 'ffprobe failed on the input')
        continue
    dst = os.path.join(WORK, name)
    r = write_tags(src, dst)
    check('%s: 写入成功' % name, r.get('ok'), r.get('error', ''))
    if not r.get('ok'):
        continue
    after = probe(dst)
    check('%s: 输出仍可被 ffprobe 解析' % name, after is not None, 'ffprobe failed on the output')
    if after is None:
        continue
    check('%s: 流数量一致（%d）' % (name, before['streams']), after['streams'] == before['streams'],
          '%s vs %s' % (before, after))
    check('%s: 时长一致（%.2fs）' % (name, before['duration']), after['duration'] == before['duration'],
          '%s vs %s' % (before['duration'], after['duration']))
    check('%s: 编解码器一致' % name, after['codecs'] == before['codecs'],
          '%s vs %s' % (before['codecs'], after['codecs']))
    print('      bytesRead=%s' % r.get('bytesRead'))

print('\n' + '=' * 70)
print(' %s   %d passed, %d failed' % ('\033[32mALL PASSED\033[0m' if FAIL == 0 else '\033[31mSOME FAILED\033[0m', PASS, FAIL))
print('=' * 70)
sys.exit(0 if FAIL == 0 else 1)
