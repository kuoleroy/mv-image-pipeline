# -*- coding: utf-8 -*-
"""通用：ASS 歌词/关键词字幕生成 + 烧制

解决的核心问题
  1. 双系数缩放：位置按画布高度缩放，字号按高度+宽度缩放。横竖屏共用一套基准值。
  2. 段内尾句不重叠：分段生成时每段末句会多吃 2.2s 尾巴，必须统一收紧。
  3. 字幕颜色跟画面亮度走，不跟歌词段落走。分三档 ink / light / pale。
  4. 整句淡入（plain）比逐字扫色更可读：未唱字停在浅色会消失在中间调背景上。

配置 subs.json：
{
  "canvas": [1080, 1920],
  "lrc": "歌词/xx.lrc",
  "audio_dur": 85.74,
  "offset": 0.0,
  "segments": [
    {"name": "inkA", "from": 104.22, "to": 118.98, "tone": "ink", "size": 92, "spacing": 4}
  ],
  "styles": { ... 见 styles.json 模板 ... }
}

用法：
    python subs_build.py --config subs.json --out 字幕.ass
    python subs_build.py --config subs.json --burn 成片.mp4 --out 带词.mp4
"""
import argparse
import copy
import json
import os
import re
import subprocess
import tempfile

# ---------------------------------------------------------------- 画布与缩放
W, H = 1080, 1920
SCALE = 1.0      # 位置缩放（按高度）
FSCALE = 1.0     # 字号缩放（按高度 + 宽度）

_FONT_KEYS = ("size", "spacing", "border", "shadow",
              "glow_blur", "glow_border", "max_size", "drop_px")
_POS_KEYS = ("y", "margin")


def set_canvas(w, h):
    """基准是 1080x1920（竖屏）。
    位置按高度缩放；字号除高度外还参考宽度，否则横屏上字会瘦得像小字报
    （竖屏 70px 占宽 6.5%，横屏若只按高度缩放只剩 2%）。"""
    global W, H, SCALE, FSCALE
    W, H = int(w), int(h)
    SCALE = H / 1920.0
    FSCALE = max(SCALE, (W / 1080.0) * 0.52)
    return W, H, SCALE


def scaled(cfg):
    """返回按当前画布缩放过的参数副本：字号类走 FSCALE，位置类走 SCALE"""
    c = dict(cfg)
    for k in _FONT_KEYS:
        if k in c and isinstance(c[k], (int, float)):
            c[k] = c[k] * FSCALE
    for k in _POS_KEYS:
        if k in c and isinstance(c[k], (int, float)):
            c[k] = c[k] * SCALE
    if "x" in c:
        c["x_ratio"] = c["x"] / 1080.0
        c["x"] = W * c["x_ratio"]
    if "{" in c.get("intro", ""):
        c["intro"] = c["intro"].format(
            CX=W / 2.0, Y0=c["y"] + 22 * SCALE, Y1=c["y"] - 2 * SCALE)
    return c


def ts(t):
    """ASS 时间戳必须写成 0:00:03.10，写成 3.10 会被 libass 静默丢弃整条事件"""
    t = max(t, 0)
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return "%d:%02d:%05.2f" % (h, m, s)


def _sec(tstr):
    h, m, x = tstr.split(":")
    return int(h) * 3600 + int(m) * 60 + float(x)


PUNCT = "，。！？、；：“”‘’（）…—《》·,.!?;:"
META = re.compile(r"^(作词|作曲|编曲|制作|演唱|混音|母带|出品|词|曲)")


def cweight(ch):
    """标点不发音，占时短"""
    return 0.32 if ch in PUNCT else 1.0


def parse_lrc(path):
    out = []
    for ln in open(path, encoding="utf-8-sig"):
        m = re.match(r"\[(\d+):(\d+\.\d+)\](.*)", ln.strip())
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        txt = m.group(3).strip()
        if not txt or META.match(txt):
            continue
        out.append((t, txt))
    return out


# ---------------------------------------------------------------- 三档色调
# ink  = 亮场：墨字 + 柔白描边
# light= 暗场：米白字 + 深描边（墨字在雨夜里只剩一团白晕）
# pale = 极亮淡彩：去描边留投影，白描边会啃掉细笔画
TONES = {
    "ink": dict(sung="&H001E1A18", unsung="&H0092969C", outline="&H96FFFFFF",
                border=2.0, bold=1, glow_color=None, glow_blur=0, shadow=1),
    "light": dict(sung="&H00DCE7ED", unsung="&H00909A96", outline="&H90000000",
                  border=2.2, glow_color=None, glow_blur=0, shadow=3),
    "pale": dict(sung="&H001E1A18", unsung="&H00504A44",
                 outline="&HFF000000", border=0.6,
                 glow_color=None, glow_blur=0, shadow=1),
}


def header(cfg):
    base = [
        "[Script Info]", "ScriptType: v4.00+",
        "PlayResX: %d" % W, "PlayResY: %d" % H,
        "WrapStyle: 2", "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: K,%s,%d,%s,%s,%s,&HA0000000,%d,0,0,0,100,100,%d,0,1,%.1f,%.1f,%d,40,40,%d,1"
        % (cfg["font"], cfg["size"], cfg["sung"], cfg["unsung"],
           cfg["outline"], cfg["bold"], cfg["spacing"], cfg["border"],
           cfg["shadow"], cfg["an"], cfg["y"]),
        "Style: G,%s,%d,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,%d,0,0,0,"
        "100,100,%d,0,1,0,0,%d,40,40,%d,1"
        % (cfg["font"], cfg["size"], cfg["bold"], cfg["spacing"],
           cfg["an"], cfg["y"]),
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
        "MarginV, Effect, Text",
    ]
    return "\n".join(base)


def build_events(cfg, lines, offset, plain=True):
    """按行生成 ASS 事件。
    plain=True：整句淡入（不逐字扫色）。叙事型 MV 里逐字扫色会让
    「还没唱到」的字停在浅灰，压在灰路面/灰沙发上几乎看不见。"""
    ev = []
    n = len(lines)
    for i, (st, text) in enumerate(lines):
        nxt = lines[i + 1][0] if i + 1 < n else st + 7.0
        est = len(text) / cfg.get("speed", 3.2)
        dur = min(est * 1.10, max(nxt - st - 0.10, est * 0.55))
        if dur < 0.8:
            dur = min(est, max(nxt - st, 0.8))
        dur_cs = int(round(dur * 100))

        show_end = min(nxt + 0.12, st + dur + 1.6)
        if i + 1 >= n:
            show_end = st + dur + 2.2

        a = st - offset
        b = show_end - offset
        if b <= a:
            b = a + 0.5

        if plain:
            pos = "\\pos(%.1f,%d)" % (W / 2.0, cfg["y"])
            ev.append("Dialogue: 3,%s,%s,K,,0,0,0,,{%s%s\\1c%s}%s"
                      % (ts(a), ts(b), pos, cfg.get("intro", ""), cfg["sung"], text))
        else:
            pos = "" if "\\move(" in cfg.get("intro", "") else "\\pos(%.1f,%d)" % (W / 2.0, cfg["y"])
            body = ""
            used = 0
            for ch in text:
                cs = max(int(round(cweight(ch) * dur_cs / (sum(cweight(c) for c in text) or 1))), 1)
                body += "{\\kf%d}%s" % (cs, ch)
                used += cs
            if cfg.get("glow_color"):
                ev.append("Dialogue: 1,%s,%s,G,,0,0,0,,"
                          "{%s%s\\1c%s\\bord%d\\shad0\\blur%d\\alpha&H30&}%s"
                          % (ts(a), ts(b), pos, cfg.get("intro", ""), cfg["glow_color"],
                             cfg.get("glow_border", 10), cfg.get("glow_blur", 20), body))
            ev.append("Dialogue: 3,%s,%s,K,,0,0,0,,{%s%s\\1c%s}%s"
                      % (ts(a), ts(b), pos, cfg.get("intro", ""), cfg["sung"], body))
    return ev


def tighten(events, tol=0.13, keep=0.12):
    """收紧重叠：按起始排序，任何超过下一句起点 tol 以上的结尾，
    收回到「下一句起点 + keep」。keep 是各句本来就有的交叉淡入宽度。
    起因：分段生成时每段末句都多吃了 2.2s 尾巴。"""
    order = sorted(range(len(events)),
                   key=lambda i: _sec(events[i].split(",", 9)[1]))
    fixed = 0
    for k in range(len(order) - 1):
        i, j = order[k], order[k + 1]
        fi = events[i].split(",", 9)
        nxt = _sec(events[j].split(",", 9)[1])
        if _sec(fi[2]) > nxt + tol:
            old = fi[2]
            fi[2] = ts(nxt + keep)
            events[i] = ",".join(fi)
            fixed += 1
            print("  收紧 %s %s -> %s" % (fi[1], old, fi[2]))
    return events, fixed


def check_overlap(events, tol=0.13):
    """返回真实重叠的 (A, B, 重叠秒数) 列表"""
    order = sorted(range(len(events)),
                   key=lambda i: _sec(events[i].split(",", 9)[1]))
    bad = []
    for k in range(len(order) - 1):
        i, j = order[k], order[k + 1]
        fi = events[i].split(",", 9)
        fj = events[j].split(",", 9)
        if fi[3] == "G" or fj[3] == "G":
            continue
        end = _sec(fi[2]); start = _sec(fj[1])
        if end > start + tol:
            bad.append((fi[1], fj[1], round(end - start, 2)))
    return bad


def burn(src, ass_path, out, crf=19, dim=0.0, sat=1.0, preset="medium"):
    """烧字幕。
    用 cwd + 相对文件名绕开 Windows 路径里 C: 冒号被 ffmpeg 当参数分隔符。"""
    work = tempfile.mkdtemp(prefix="sub_", dir=os.path.dirname(os.path.abspath(src)) or ".")
    ass_name = "sub.ass"
    with open(os.path.join(work, ass_name), "w", encoding="utf-8") as f:
        f.write(open(ass_path, encoding="utf-8").read())
    vf = []
    if dim or sat != 1.0:
        vf.append("eq=brightness=-%.4f:saturation=%.3f" % (dim, sat))
    vf.append("ass=filename=%s" % ass_name)
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", os.path.abspath(src),
           "-vf", ",".join(vf),
           "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", os.path.abspath(out)]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=work)
    if r.returncode != 0:
        print("烧字幕失败：", r.stderr[-1200:])
        return False
    print("烧制完成：%s" % out)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--burn", default=None, help="传入视频路径则同时烧制")
    ap.add_argument("--crf", type=int, default=19)
    ap.add_argument("--dim", type=float, default=0.0)
    ap.add_argument("--sat", type=float, default=1.0)
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    base = os.path.abspath(cfg.get("base_dir", "."))
    set_canvas(*cfg.get("canvas", [1080, 1920]))
    print("画布 %dx%d  SCALE=%.4f  FSCALE=%.4f" % (W, H, SCALE, FSCALE))

    lrc = parse_lrc(os.path.join(base, cfg["lrc"]))
    offset = cfg.get("offset", 0.0)
    styles = cfg.get("styles", {})
    all_styles = []
    all_events = []
    for si, seg in enumerate(cfg["segments"]):
        st, en = seg["from"], seg["to"]
        lines = [(t, x) for t, x in lrc if st <= t <= en]
        if not lines:
            print("  [跳过] 段 %s 无歌词" % seg.get("name"))
            continue
        base_style = copy.deepcopy(styles[seg.get("base", "ink")])
        base_style.update(size=seg.get("size", base_style["size"]),
                          spacing=seg.get("spacing", base_style["spacing"]),
                          y=seg.get("y", base_style["y"]))
        base_style.update(TONES[seg.get("tone", "ink")])
        base_style["plain"] = seg.get("plain", True)
        s = scaled(base_style)
        s["speed"] = base_style.get("speed", 3.2)

        header_txt = header(s)
        for ln in header_txt.splitlines():
            if ln.startswith("Style: "):
                nm = ln.split(",", 1)[0].split(":", 1)[1].strip()
                all_styles.append("Style: %s%d,%s" % (nm, si, ln.split(",", 1)[1]))
        for e in build_events(s, lines, offset, plain=seg.get("plain", True)):
            f9 = e.split(",", 9)
            f9[3] = f9[3] + str(si)      # Style 名加段序号，防同名覆盖
            all_events.append(",".join(f9))
        print("  段 %s: %d 句" % (seg.get("name", si), len(lines)))

    all_events, n = tighten(all_events)
    bad = check_overlap(all_events)
    if bad:
        print("!! 仍有重叠 %d 处：" % len(bad))
        for a, b, d in bad:
            print("   %s -> %s  重叠 %.2fs" % (a, b, d))
    else:
        print("重叠校验通过（零真实重叠）")

    out = os.path.abspath(args.out)
    with open(out, "w", encoding="utf-8") as f:
        f.write("[Script Info]\nScriptType: v4.00+\n")
        f.write("PlayResX: %d\nPlayResY: %d\n" % (W, H))
        f.write("WrapStyle: 2\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n")
        f.write("[V4+ Styles]\n")
        f.write("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
                "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
                "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
                "Alignment, MarginL, MarginR, MarginV, Encoding\n")
        for s in all_styles:
            f.write(s + "\n")
        f.write("\n[Events]\n")
        f.write("Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
                "MarginV, Effect, Text\n")
        for e in all_events:
            f.write(e + "\n")
    print("写入 %s（%d 样式 / %d 事件）" % (out, len(all_styles), len(all_events)))

    if args.burn:
        burn(args.burn, out, cfg.get("burn_out", "带词.mp4"),
             crf=args.crf, dim=args.dim, sat=args.sat)


if __name__ == "__main__":
    main()
