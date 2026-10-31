# -*- coding: utf-8 -*-
"""通用：图片库 → Ken Burns 推移 + 叠化 → MV 成片（纯 CPU，不吃显卡）

设计要点（全部来自实战验证，勿轻易改动）：
  · 单帧输入 + zoompan 的 d=frames。绝不能加 -loop 1，会让帧数指数爆炸。
  · 人物镜头一律 contain（模糊底 + 居中）。cover 裁切会切掉头顶。
  · 视频源片段不加 zoompan（已有运动）；比镜头短用 tpad=stop_mode=clone，循环会露馅。
  · 每镜时长 = 段长/段内镜数，除末镜外各 +overlap；总长 = Σd − overlap×(n−1)。
  · xfade offset = acc − overlap，acc 递推 acc + d − overlap。
  · 补齐总长：差值全部加到最后一镜。

时间轴 JSON：
{
  "audio_dur": 85.74,
  "sections": [
    {"name": "副歌2a", "t0": 0.0, "t1": 4.56, "ids": ["Y31", "Y01"]}
  ]
}

ID 路由（按前缀，可在 config.json 覆盖）：
  A-F  横屏二次元   G  横屏写实   Y  竖屏   P/Q  人物图   V  视频片段
  超分目录（*_2k）存在则优先，避免二次插值。

用法：
    python mv_render.py --config config.json
    python mv_render.py --config config.json --fps 60 --vertical
    python mv_render.py --config config.json --reuse   # 复用已渲片段
"""
import argparse
import json
import os
import shutil
import subprocess
import sys


def probe_dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", p], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def load_cfg(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class Router:
    """ID → 文件路径。目录存在就用，存在 _2k 超分版就用超分版。"""

    def __init__(self, cfg, base):
        self.cfg = cfg
        self.base = base
        self.routes = cfg.get("routes", {})
        self.video_ext = (".mp4", ".webm", ".mov")

    def _dirs(self, prefix):
        r = self.routes.get(prefix)
        if not r:
            return []
        out = []
        for d in r:
            out.append(os.path.join(self.base, d))
        return out

    def path_of(self, iid):
        for prefix, dirs in self.routes.items():
            if not iid.startswith(prefix):
                continue
            if prefix == "V":
                for d in dirs:
                    if os.path.isdir(d):
                        for f in sorted(os.listdir(d)):
                            if f.lower().endswith(self.video_ext) and f.startswith("d" + iid[1:]):
                                return os.path.join(d, f)
                continue
            for d in dirs:
                p = os.path.join(d, iid + ".png")
                if os.path.exists(p):
                    return p
        return None

    def is_video(self, iid):
        return iid.startswith("V")

    def is_person(self, iid):
        return iid.startswith(("P", "Q"))


def build_plan(timeline, router, overlap):
    """返回 [(path, dur, effect), ...]"""
    plan = []
    secs = timeline["sections"]
    effects = ["push", "pull", "pan_r", "pan_l", "push_slow", "pan_up"]
    for si, s in enumerate(secs):
        t0, t1, ids = s["t0"], s["t1"], s["ids"]
        seg = t1 - t0
        n = len(ids)
        for i, iid in enumerate(ids):
            p = router.path_of(iid)
            if not p:
                print("  [跳过] 缺图 %s" % iid)
                continue
            d = seg / n
            if not (si == len(secs) - 1 and i == n - 1):
                d += overlap
            # 人物镜头只做极缓推近：动作小，脸和姿态才站得住
            effect = "hold" if router.is_person(iid) else effects[len(plan) % len(effects)]
            plan.append((p, d, effect))
    # 补齐总长到音频时长（差值全给最后一镜）
    ad = timeline.get("audio_dur")
    total = sum(x[1] for x in plan) - overlap * max(0, len(plan) - 1)
    if ad and abs(ad - total) > 0.05 and plan:
        p0, d0, e0 = plan[-1]
        plan[-1] = (p0, max(1.0, d0 + (ad - total)), e0)
        print("  补齐总长：%.2fs → %.2fs（末段加 %+.2fs）" % (total, ad, ad - total))
    return plan


def make_clip(idx, path, dur, effect, W, H, fps, fit, person, crf, work):
    out = os.path.join(work, "c%03d.mp4" % idx)
    frames = max(2, int(round(dur * fps)))
    is_vid = path.lower().endswith((".mp4", ".webm", ".mov"))

    if fit == "cover" and not person and not is_vid:
        # 空镜可裁；人物一旦裁到 16:9 会切掉头顶，所以人物永远走 contain
        base = ("scale=%d:%d:force_original_aspect_ratio=increase,"
                "crop=%d:%d,setsar=1" % (int(W * 1.35), int(H * 1.35),
                                         int(W * 1.35), int(H * 1.35)))
    else:
        BW, BH = int(W * 1.35), int(H * 1.35)
        zoom = 1.45 if (person and H > W and not is_vid) else 1.0
        fg = ("scale=%d:%d:force_original_aspect_ratio=decrease"
              % (int(BW * zoom), int(BH * zoom)) if zoom > 1 else
              "scale=%d:%d:force_original_aspect_ratio=decrease" % (BW, BH))
        # 视频源人物占比大，模糊后上下留一圈暗影，所以糊到接近纯色
        blur, bright = (200, 0.02) if is_vid else (90, -0.06)
        base = ("split=2[b][f];"
                "[b]scale=%d:%d:force_original_aspect_ratio=increase,"
                "crop=%d:%d,gblur=sigma=%d:steps=3,eq=brightness=%s:saturation=0.88[b2];"
                "[f]%s[f2];"
                "[b2][f2]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1"
                % (BW, BH, BW, BH, blur, bright, fg))

    Z = 0.10
    if effect == "hold":
        z = "1+0.045*on/%d" % frames
        x = "iw/2-(iw/zoom/2)"; y = "ih/2-(ih/zoom/2)"
    elif effect == "push":
        z = "min(1+%s*on/%d,1+%s)" % (Z, frames, Z)
        x = "iw/2-(iw/zoom/2)"; y = "ih/2-(ih/zoom/2)"
    elif effect == "push_slow":
        z = "min(1+%s*on/%d,1+%s)" % (Z / 2, frames, Z / 2)
        x = "iw/2-(iw/zoom/2)"; y = "ih/2-(ih/zoom/2)"
    elif effect == "pull":
        z = "max(1+%s-%s*on/%d,1.0)" % (Z, Z, frames)
        x = "iw/2-(iw/zoom/2)"; y = "ih/2-(ih/zoom/2)"
    elif effect == "pan_r":
        z = "%s" % (1 + Z / 1.5)
        x = "(iw-iw/zoom)*on/%d" % frames; y = "ih/2-(ih/zoom/2)"
    elif effect == "pan_l":
        z = "%s" % (1 + Z / 1.5)
        x = "(iw-iw/zoom)*(1-on/%d)" % frames; y = "ih/2-(ih/zoom/2)"
    else:  # pan_up
        z = "%s" % (1 + Z / 1.5)
        x = "iw/2-(iw/zoom/2)"; y = "(ih-ih/zoom)*on/%d" % frames

    if is_vid:
        vd = probe_dur(path)
        pad = (",tpad=stop_mode=clone:stop_duration=%.2f" % max(0.0, dur - vd)) if vd < dur else ""
        vf = ("%s,fps=%d,scale=%d:%d,setsar=1,format=yuv420p%s,"
              "trim=duration=%.3f,setpts=PTS-STARTPTS"
              % (base, fps, W, H, pad, dur))
        cmd = ["ffmpeg", "-v", "error", "-y", "-t", "%.3f" % (dur + 1),
               "-i", path, "-vf", vf, "-r", str(fps), "-c:v", "libx264",
               "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", out]
    else:
        vf = ("%s,zoompan=z='%s':x='%s':y='%s':d=%d:s=%dx%d:fps=%d,"
              "setsar=1,format=yuv420p" % (base, z, x, y, frames, W, H, fps))
        # 单帧输入 + zoompan 的 d=frames，输出正好 frames 帧
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", path,
               "-vf", vf, "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast",
               "-crf", str(crf), "-pix_fmt", "yuv420p", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("  [clip失败]", os.path.basename(path), r.stderr[-300:])
        return None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--fps", type=int, default=None)
    ap.add_argument("--crf", type=int, default=None)
    ap.add_argument("--clipcrf", type=int, default=None)
    ap.add_argument("--overlap", type=float, default=None)
    ap.add_argument("--fit", default=None, choices=["cover", "contain"])
    ap.add_argument("--vertical", action="store_true")
    ap.add_argument("--reuse", action="store_true")
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    cfg = load_cfg(args.config)
    base = os.path.abspath(cfg.get("base_dir", "."))
    W, H = cfg["width"], cfg["height"]
    if args.vertical:
        W, H = H, W
    fps = args.fps or cfg.get("fps", 30)
    crf = args.crf if args.crf is not None else cfg.get("crf", 19)
    clip_crf = args.clipcrf if args.clipcrf is not None else cfg.get("clipcrf", 20)
    overlap = args.overlap if args.overlap is not None else cfg.get("overlap", 0.6)
    fit = args.fit or cfg.get("fit", "cover")

    tl_path = os.path.join(base, cfg["timeline"])
    with open(tl_path, encoding="utf-8") as f:
        timeline = json.load(f)

    audio = os.path.join(base, cfg["audio"])
    out = os.path.join(base, cfg["output"])
    work = os.path.join(base, cfg.get("work_dir", "_clips_tmp"))

    router = Router(cfg, base)
    plan = build_plan(timeline, router, overlap)
    print("共 %d 镜，画布 %dx%d，%dfps，叠化 %.2fs，模式 %s"
          % (len(plan), W, H, fps, overlap, fit), flush=True)

    reuse = args.reuse and os.path.isdir(work) and len(os.listdir(work)) > 1
    if not reuse:
        if os.path.isdir(work):
            shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)

    clips = []
    for i, (p, d, eff) in enumerate(plan):
        cached = os.path.join(work, "c%03d.mp4" % i)
        if reuse and os.path.exists(cached):
            clips.append(cached)
            print("  [复用 %d/%d] %s" % (i + 1, len(plan), os.path.basename(p)), flush=True)
            continue
        c = make_clip(i, p, d, eff, W, H, fps, fit, router.is_person(os.path.basename(p)[:-4]),
                      clip_crf, work)
        if c:
            clips.append(c)
            print("  [%d/%d] %-12s %5.2fs %s" % (i + 1, len(plan), os.path.basename(p), d, eff),
                  flush=True)

    if not clips:
        print("没有可用片段")
        return

    # xfade 串联：offset = acc − overlap
    lines = []
    cur = "0:v"
    acc = plan[0][1]
    for i in range(1, len(clips)):
        off = acc - overlap
        tag = "x%d" % i
        lines.append("[%s][%d:v]xfade=transition=fade:duration=%.4f:offset=%.4f[%s]"
                     % (cur, i, overlap, off, tag))
        cur = tag
        acc = acc + plan[i][1] - overlap

    total = acc
    fi, fo = 0.7, 1.8
    fo = min(fo, max(0.5, total * 0.15))
    grain = cfg.get("grain", "noise=alls=4:allf=t+u")
    fc = (";".join(lines) + ";[%s]%s,"
          "fade=t=in:st=0:d=%.2f,fade=t=out:st=%.3f:d=%.2f,format=yuv420p[vout]"
          % (cur, grain, fi, total - fo, fo))
    # 音频比画面早一点落，收尾才不戛然而止
    ao = min(2.6, total * 0.16)
    afade = "afade=t=in:st=0:d=0.55,afade=t=out:st=%.3f:d=%.3f" % (total - ao, ao)

    cmd = ["ffmpeg", "-v", "error", "-y"]
    for c in clips:
        cmd += ["-i", c]
    cmd += ["-i", audio, "-filter_complex", fc,
            "-map", "[vout]", "-map", "%d:a" % len(clips),
            "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-r", str(fps),
            "-af", afade, "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", out]
    print("拼接中… %d 段，滤镜长度 %d" % (len(clips), len(fc)), flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("拼接失败：", r.stderr[-1500:])
        return

    print("完成：%s  %.1fs  %.1fMB" % (out, probe_dur(out), os.path.getsize(out) / 1e6))
    if args.clean:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
