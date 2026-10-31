# -*- coding: utf-8 -*-
"""通用：MV 成片质检 + 镜头表生成 + 审图拼贴

子命令：
    python mv_qc.py check  <video>            # 分辨率/帧率/时长/码率/解码零报错/响度
    python mv_qc.py shots <timeline.json>     # 镜头表（markdown）
    python mv_qc.py sheet  <dir> <out.jpg>    # 审图拼贴（每行 N 张）
    python mv_qc.py bright <video> <t1,t2,...> # 指定时间点的画面平均亮度（字幕分档用）

亮度分档是字幕配色的唯一依据：亮场用墨字，暗场用米白字。
不量亮度就配字幕，必有一半画面上的字看不见。
"""
import argparse
import glob
import json
import os
import subprocess
import sys


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def probe(video):
    r = run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
             "-of", "json", video])
    if r.returncode != 0:
        print("ffprobe 失败：", r.stderr[-400:])
        return None
    return json.loads(r.stdout)


def fmt_size(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return "%.1f %s" % (n, u)
        n /= 1024
    return "%.1f TB" % n


def cmd_check(video):
    d = probe(video)
    if not d:
        return 1
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    a = next((s for s in d["streams"] if s["codec_type"] == "audio"), None)
    dur = float(d["format"].get("duration", 0))
    size = int(d["format"].get("size", os.path.getsize(video)))
    bps = int(d["format"].get("bit_rate", 0))

    fps = 0.0
    if "r_frame_rate" in v:
        a_, b_ = v["r_frame_rate"].split("/")
        fps = float(a_) / float(b_) if float(b_) else 0.0

    print("文件      %s" % os.path.basename(video))
    print("分辨率    %sx%s" % (v.get("width"), v.get("height")))
    print("帧率      %.3f fps" % fps)
    print("时长      %.2f s" % dur)
    print("大小      %s" % fmt_size(size))
    print("码率      %.2f Mbps" % (bps / 1e6 if bps else 0))
    print("视频编码  %s / %s" % (v.get("codec_name"), v.get("pix_fmt")))
    if a:
        print("音频      %s %sHz %sch" % (a.get("codec_name"),
                                          a.get("sample_rate"), a.get("channels")))
    nf = int(v.get("nb_frames", 0) or 0)
    if nf and fps:
        print("总帧数    %d（与时长匹配：%s）" % (nf, "是" if abs(nf / fps - dur) < 0.2 else "否"))

    # 全片解码零报错检测：这一项比任何参数检查都重要
    r = run(["ffmpeg", "-v", "error", "-i", video, "-f", "null", "-"])
    errs = [l for l in r.stderr.splitlines() if l.strip()]
    if errs:
        print("!! 解码报错 %d 处：" % len(errs))
        for e in errs[:10]:
            print("   ", e[:200])
    else:
        print("解码      全片零报错 ✓")

    # 响度（平台推荐 -14 LUFS 左右）
    r = run(["ffmpeg", "-hide_banner", "-i", video, "-af", "ebur128=peak=true",
             "-f", "null", "-"])
    lines = r.stderr.splitlines()
    for i, l in enumerate(lines):
        if "I:" in l and "LUFS" in l:
            print("响度      %s" % l.strip()[-40:])
            break
    return 0


def cmd_shots(timeline):
    with open(timeline, encoding="utf-8") as f:
        d = json.load(f)
    print("# 镜头表\n")
    print("总时长 %.2fs / %d 段 / %d 镜\n" % (d.get("audio_dur", 0),
                                               len(d["sections"]),
                                               sum(len(s["ids"]) for s in d["sections"])))
    print("| 段 | 起 | 止 | 时长 | 镜数 | 每镜 | 镜头 ID |")
    print("|---|---|---|---|---|---|---|")
    for s in d["sections"]:
        dur = s["t1"] - s["t0"]
        n = len(s["ids"])
        print("| %s | %.2f | %.2f | %.2f | %d | %.2f | %s |"
              % (s["name"], s["t0"], s["t1"], dur, n, dur / max(1, n),
                 " ".join(s["ids"])))
    # 体检：缺图 / 重复 / 相邻重复
    print("\n## 体检\n")
    used = [i for s in d["sections"] for i in s["ids"]]
    print("- 总镜数 %d，唯一 %d，重复 %d" % (len(used), len(set(used)), len(used) - len(set(used))))
    adj = [(used[k - 1], used[k]) for k in range(1, len(used)) if used[k] == used[k - 1]]
    print("- 相邻重复 %d %s" % (len(adj), adj[:5] if adj else ""))
    density = sum(len(s["ids"]) for s in d["sections"]) / max(0.01, d.get("audio_dur", 1))
    print("- 镜头密度 %.2f 镜/秒（每镜 %.2fs）" % (density, 1 / density if density else 0))
    return 0


def cmd_sheet(dirpath, out, cols=6, rows=6, cell=220):
    files = sorted(glob.glob(os.path.join(dirpath, "*.png")))
    if not files:
        print("目录无 PNG：%s" % dirpath)
        return 1
    from PIL import Image, ImageDraw
    per = cols * rows
    pages = (len(files) + per - 1) // per
    for p in range(pages):
        chunk = files[p * per:(p + 1) * per]
        sheet = Image.new("RGB", (cols * cell, rows * cell), (18, 18, 20))
        dr = ImageDraw.Draw(sheet)
        for i, f in enumerate(chunk):
            try:
                im = Image.open(f).convert("RGB")
            except Exception:
                continue
            im.thumbnail((cell - 8, cell - 24))
            x = (i % cols) * cell + (cell - im.width) // 2
            y = (i // cols) * cell + 4
            sheet.paste(im, (x, y))
            dr.text(((i % cols) * cell + 6, (i // cols) * cell + cell - 18),
                    os.path.basename(f)[:-4], fill=(200, 200, 200))
        po = out if pages == 1 else out.replace(".jpg", "_p%d.jpg" % (p + 1))
        sheet.save(po, quality=90)
        print("写入 %s（%d 张）" % (po, len(chunk)))
    return 0


def cmd_bright(video, times):
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        print("需要 numpy + Pillow")
        return 1
    print("时间点平均亮度（0=黑 255=白）：")
    for t in times:
        r = run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", video,
                 "-frames:v", "1", "-f", "image2", "-y", "_bright_tmp.png"])
        if r.returncode != 0:
            print("  %.2fs  取帧失败" % t)
            continue
        try:
            a = np.array(Image.open("_bright_tmp.png").convert("L"))
            print("  %6.2fs  平均 %5.1f  峰值 %3d" % (t, a.mean(), a.max()))
        except Exception as e:
            print("  %.2fs  读取失败 %s" % (t, e))
    try:
        os.remove("_bright_tmp.png")
    except OSError:
        pass
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("check"); p.add_argument("video")
    p = sub.add_parser("shots"); p.add_argument("timeline")
    p = sub.add_parser("sheet"); p.add_argument("dir"); p.add_argument("out")
    p = sub.add_parser("bright"); p.add_argument("video"); p.add_argument("times")

    args = ap.parse_args()
    if args.cmd == "check":
        return cmd_check(args.video)
    if args.cmd == "shots":
        return cmd_shots(args.timeline)
    if args.cmd == "sheet":
        return cmd_sheet(args.dir, args.out)
    if args.cmd == "bright":
        ts = [float(x) for x in args.times.split(",")]
        return cmd_bright(args.video, ts)
    return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
