# -*- coding: utf-8 -*-
"""通用：机位库 4 倍超分后缩到渲染基准尺寸，消除渲染端的二次插值。

背景：机位库原图 1536x864，而渲染的推移基准是 1920*1.35 = 2592x1458。
直接从 1536 拉到 2592 等于 1.69 倍纯插值，线条（窗框、电线、栏杆）会发软。
先用 4x-UltraSharp 超到 6144x3456，再 Lanczos 缩到 2592x1458，
等于「先有细节再缩小」，边缘明显更实。

必须用 ComfyUI 的 venv，那里才有 torch+cuda：
    <comfy>/.venv/Scripts/python.exe upscale.py --src 机位库 --dst 机位库_2k --target 2592,1458
"""
import argparse
import glob
import os
import time

import numpy as np
from PIL import Image
import torch
from spandrel import ModelLoader

TILE, PAD = 512, 24


def _model_dirs():
    """探测 upscale_models 目录，兼容不同平台安装位置。

    优先级：
      1. 环境变量 COMFY_MODEL_DIRS（os.pathsep 分隔多个路径）
      2. 环境变量 COMFY_HOME 下的 models/upscale_models
      3. 常见安装路径探测
    """
    env = os.environ.get("COMFY_MODEL_DIRS", "").strip()
    if env:
        return [os.path.expanduser(p) for p in env.split(os.pathsep) if p.strip()]
    dirs = []
    home = os.environ.get("COMFY_HOME", "").strip()
    if home:
        dirs.append(os.path.join(os.path.expanduser(home), "models", "upscale_models"))
    for root in [
        os.path.expanduser("~/.local/share/ComfyUI"),
        os.path.expanduser("~/ComfyUI"),
        os.path.expanduser("~/AppData/Local/Comfy-Desktop/ComfyUI-Installs/local/ComfyUI"),
        os.path.expanduser("~/AppData/Local/Comfy-Desktop/ComfyUI-Shared"),
        "/Applications/ComfyUI.app/Contents/Resources/ComfyUI",
    ]:
        dirs.append(os.path.join(root, "models", "upscale_models"))
    return [d for d in dirs if os.path.isdir(d)]


MODEL_DIRS = _model_dirs()
DEV = "cuda" if torch.cuda.is_available() else "cpu"


def find_model(name):
    for d in MODEL_DIRS:
        p = os.path.join(d, name + ".pth")
        if os.path.exists(p):
            return p
    raise SystemExit("找不到模型 %s.pth" % name)


def load_model(name):
    desc = ModelLoader().load_from_file(find_model(name))
    m = desc.model.eval().to(DEV)
    if DEV == "cuda":
        m = m.half()
    print("模型 %s  架构 %s  %dx  -> %s" % (name, desc.architecture.name, desc.scale, DEV),
          flush=True)
    return m, desc.scale


@torch.no_grad()
def upscale(model, scale, img):
    W, H = img.size
    out = Image.new("RGB", (W * scale, H * scale))
    step = TILE - PAD * 2
    xs = list(range(0, max(1, W - PAD * 2), step))
    ys = list(range(0, max(1, H - PAD * 2), step))
    for y in ys:
        for x in xs:
            x0, y0 = max(0, x - PAD), max(0, y - PAD)
            x1, y1 = min(W, x + TILE - PAD), min(H, y + TILE - PAD)
            t = torch.from_numpy(np.array(img.crop((x0, y0, x1, y1)))).to(DEV)
            t = t.permute(2, 0, 1).float().div(255).unsqueeze(0)
            if DEV == "cuda":
                t = t.half()
            o = model(t).squeeze(0).float().clamp(0, 1).permute(1, 2, 0).cpu().numpy()
            tile = Image.fromarray((o * 255).round().astype(np.uint8))
            lx, ly = (x - x0) * scale, (y - y0) * scale
            w, h = (x1 - x) * scale, (y1 - y) * scale
            out.paste(tile.crop((lx, ly, lx + w, ly + h)), (x * scale, y * scale))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--target", required=True, help="宽,高 例如 2592,1458")
    ap.add_argument("--model", default="4x-UltraSharp")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--redo", action="store_true")
    args = ap.parse_args()

    tw, th = [int(x) for x in args.target.split(",")]
    model, scale = load_model(args.model)
    os.makedirs(args.dst, exist_ok=True)

    files = sorted(glob.glob(os.path.join(args.src, "*.png")))
    print("待处理 %d 张 → %dx%d" % (len(files), tw, th), flush=True)
    done = skip = 0
    t0 = time.time()
    for src in files:
        if os.path.getsize(src) < 10000:
            continue
        dst = os.path.join(args.dst, os.path.basename(src))
        if os.path.exists(dst) and not args.redo:
            skip += 1
            continue
        img = Image.open(src).convert("RGB")
        big = upscale(model, scale, img)
        big.resize((tw, th), Image.LANCZOS).save(dst, compress_level=1)
        done += 1
        el = time.time() - t0
        print("  [%d] %s  %.1fs  已用 %.1f 分  剩余约 %.0f 分"
              % (done, os.path.basename(src), el / max(1, done), el / 60,
                 el / max(1, done) * (len(files) - done - skip) / 60), flush=True)
    print("完成 %d 张 / 跳过 %d / 用时 %.1f 分" % (done, skip, (time.time() - t0) / 60))


if __name__ == "__main__":
    main()
