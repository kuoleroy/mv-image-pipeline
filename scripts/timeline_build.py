# -*- coding: utf-8 -*-
"""通用：时间轴生成器 —— 两种模式

模式 A：歌词模式（MV）
    段边界取自 LRC 行首时间戳，段内图片均分该段时长。
    段名同时是歌词句的标识，字幕靠它做 key 匹配。

模式 B：节拍模式（爆款短视频 / AI 短视频）
    切点取自 BPM 网格 + 手动强调点，不依赖歌词。
    - --bpm 90        每拍 0.667s；--bars 4 每小节 4 拍
    - --cut 每小节切 1/2/1/4 拍
    - --hook 3       前 N 秒单独成段（钩子，必须最快最密）
    - --shot-pool 机位库目录，自动按节奏挑图
    - --density 0.9  平均每镜秒数（爆款取 0.8-1.5，MV 取 2.0-3.0）

节拍模式下会按「副歌/高潮密度更高」的直觉自动分配：hook 段用最短切点，
主体段稍慢，尾部再放慢留呼吸。

用法：
    # MV：从 LRC 生成
    python timeline_build.py lrc --lrc 歌词/xx.lrc --audio 原曲.wav \
        --map 时间轴映射.json --out 时间轴.json

    # 爆款短视频：从 BPM 生成
    python timeline_build.py beat --bpm 92 --duration 42 --hook 3 \
        --pool 机位库_竖屏 --out 时间轴_爆款.json --orientation vertical
"""
import argparse
import glob
import json
import os
import re
import subprocess


def probe_dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", p], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def parse_lrc(path):
    out = []
    meta = re.compile(r"^(作词|作曲|编曲|制作|演唱|混音|母带|出品|词|曲)")
    for ln in open(path, encoding="utf-8-sig"):
        m = re.match(r"\[(\d+):(\d+\.\d+)\](.*)", ln.strip())
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        txt = m.group(3).strip()
        if txt and not meta.match(txt):
            out.append((t, txt))
    return out


# ---------------------------------------------------------------- 模式 A
def build_from_lrc(args):
    lrc = parse_lrc(args.lrc)
    with open(args.map, encoding="utf-8") as f:
        mp = json.load(f)
    # map: [[start, name, [ids]], ...]，start 必须与 LRC 行首严格一致
    lrc_times = {round(t, 2) for t, _ in lrc}
    secs = []
    for i, item in enumerate(mp):
        t0 = float(item[0])
        name = item[1]
        ids = item[2]
        t1 = float(mp[i + 1][0]) if i + 1 < len(mp) else args.duration
        if round(t0, 2) not in lrc_times:
            print("  [警告] 段 %s 起点 %.2f 不在 LRC 中" % (name, t0))
        secs.append({"name": name, "t0": round(t0, 2), "t1": round(t1, 2), "ids": ids})
    dur = args.duration or probe_dur(args.audio) if args.audio else secs[-1]["t1"]
    return {"note": os.path.basename(args.out), "audio_dur": round(dur, 2), "sections": secs}


# ---------------------------------------------------------------- 模式 B
def build_from_beat(args):
    beat = 60.0 / args.bpm
    bar = beat * args.bars
    total = args.duration
    pool = []
    if args.pool:
        pool = sorted(glob.glob(os.path.join(args.pool, "*.png")))
        pool = [os.path.splitext(os.path.basename(p))[0] for p in pool]
    if not pool:
        print("!! 机位库为空，无法生成节拍时间轴")
        return None

    # 切点密度：hook 最快 → 主体稍慢 → 尾部最慢
    # 注意下限：单镜短于 0.5s 会看不清画面，只会变闪。
    # 爆款视频的钩子是「切得快」而不是「切得碎」——0.5s 是可读下限。
    def cut_len(t):
        if t < args.hook:
            return max(beat * 0.5, args.min_cut)   # hook：半拍或下限，取大
        if t < total * 0.75:
            return max(beat, args.min_cut)
        return max(beat * 2, args.min_cut)

    secs = []
    t = 0.0
    idx = 0
    seg_i = 0
    while t < total - 0.05:
        cl = cut_len(t)
        end = min(t + cl, total)
        if t < args.hook:
            name = "hook%d" % (seg_i + 1)
        elif end >= total:
            name = "outro"
        else:
            name = "body%d" % (seg_i + 1)
        n = max(1, int(round((end - t) / cl)))
        ids = []
        for _ in range(n):
            ids.append(pool[idx % len(pool)])
            idx += 1
        secs.append({"name": name, "t0": round(t, 2), "t1": round(end, 2), "ids": ids})
        t = end
        seg_i += 1

    # 相邻重复检查（爆款视频最忌讳连着两帧一样）
    used = [i for s in secs for i in s["ids"]]
    dup = len(used) - len(set(used))
    adj = sum(1 for k in range(1, len(used)) if used[k] == used[k - 1])
    print("  %d 段 / %d 镜 / %.2fs / %.2f 镜每秒"
          % (len(secs), len(used), total, len(used) / total))
    print("  重复 %d / 相邻重复 %d" % (dup, adj))
    return {"note": os.path.basename(args.out), "audio_dur": total, "sections": secs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["lrc", "beat"])
    ap.add_argument("--lrc"); ap.add_argument("--map"); ap.add_argument("--audio")
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration", type=float, default=0.0)

    ap.add_argument("--bpm", type=float, default=92.0)
    ap.add_argument("--bars", type=int, default=4)
    ap.add_argument("--hook", type=float, default=3.0)
    ap.add_argument("--pool")
    ap.add_argument("--min-cut", type=float, default=0.5,
                    help="单镜最短秒数。低于 0.5s 画面来不及看清，只会变闪")

    args = ap.parse_args()
    if not args.duration and args.audio:
        args.duration = probe_dur(args.audio)

    if args.mode == "lrc":
        if not args.lrc or not args.map:
            print("lrc 模式需要 --lrc 和 --map")
            return 1
        d = build_from_lrc(args)
    else:
        if not args.duration:
            print("beat 模式需要 --duration 或 --audio")
            return 1
        d = build_from_beat(args)
    if not d:
        return 1

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    print("写入 %s" % args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
