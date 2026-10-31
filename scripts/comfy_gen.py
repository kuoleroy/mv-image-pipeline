# -*- coding: utf-8 -*-
"""通用：ComfyUI 出图机位库（Qwen Image 2.1）

与具体项目无关。配置全部在 shots.json 里，本脚本只负责执行。

shots.json 结构：
{
  "out_dir": "机位库",
  "width": 1536, "height": 864,
  "unet": "qwen_image_2.1_int8_convrot.safetensors",
  "clip": "qwen3vl_8b_w4a8.safetensors",
  "vae": "qwen_image_2.1_vae_bf16.safetensors",
  "style_anchor": "Japanese anime film still, ...",
  "negative": "photorealistic, ...",
  "extra_negative": "",
  "seed": 20261031,
  "shots": [
    {"id": "A01", "scene": "wide shot ...", "tags": ["dusk"]},
    {"id": "A02", "scene": "...", "person": "full", "tail": "walking toward camera"}
  ]
}

用法：
    python comfy_gen.py                       # 全跑（跳过已存在的）
    python comfy_gen.py --only A --limit 3    # 只跑某前缀 / 限量
    python comfy_gen.py --redo A01,A02        # 强制重做
    python comfy_gen.py --turbo               # 快速模型，只用于验构图
"""
import argparse
import json
import os
import shutil
import sys
import time
import urllib.request

API = os.environ.get("COMFY_API", "http://127.0.0.1:8188")


def _comfy_roots():
    """自动探测 ComfyUI 安装目录，兼容不同平台的安装位置。

    优先级：
      1. 环境变量 COMFY_HOME（直接指到 ComfyUI 根目录）
      2. 环境变量 COMFY_OUT（直接指到 output 目录）
      3. 常见安装路径探测
    """
    roots = []
    home = os.environ.get("COMFY_HOME", "").strip()
    if home:
        roots.append(os.path.expanduser(home))
    roots += [
        os.path.expanduser("~/.local/share/ComfyUI"),
        os.path.expanduser("~/ComfyUI"),
        os.path.expanduser("~/AppData/Local/Comfy-Desktop/ComfyUI-Installs/local/ComfyUI"),
        "/Applications/ComfyUI.app/Contents/Resources/ComfyUI",
    ]
    return [r for r in roots if os.path.isdir(r)]


def _output_dirs():
    """ComfyUI 输出目录可能有多个（桌面版 Shared vs 手动启动 Installs）。"""
    out = os.environ.get("COMFY_OUT", "").strip()
    if out:
        return [os.path.expanduser(out)]
    dirs = []
    for root in _comfy_roots():
        dirs.append(os.path.join(root, "output"))
    seen, uniq = set(), []
    for d in dirs:
        k = os.path.normcase(os.path.abspath(d))
        if k not in seen:
            seen.add(k)
            uniq.append(d)
    return [d for d in uniq if os.path.isdir(d)] or [os.path.join(_comfy_roots()[0], "output")]

# 本机装了系统代理，urllib 会走代理导致连不上 127.0.0.1，必须显式绕过
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 人物三档：特写绝不能用 full，否则服装描述会把画面拽回中景
PERSON = {
    "full": ("a slim young woman with short black bob hair, wearing an oversized "
             "white linen shirt and grey trousers, pale tired face, no makeup"),
    "face": "the pale tired face of a young woman with short black bob hair, no makeup",
    "hand": "a pale hand with short clean nails",
    "back": ("a slim young woman with short black bob hair seen from behind, "
             "oversized white linen shirt, grey trousers"),
}


def load_cfg(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_wf(cfg, prompt, neg, prefix, turbo, seed):
    unet = cfg["unet"]
    steps, sampler_cfg = cfg.get("steps", 25), cfg.get("cfg", 2.5)
    if turbo:
        unet = cfg.get("turbo_unet", unet.replace("_int8_", "_turbo_int8_"))
        steps, sampler_cfg = 8, 1.0
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": cfg["clip"], "type": "qwen_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": cfg["vae"]}},
        "4": {"class_type": "TextEncodeQwenImage21", "inputs": {
            "clip": ["2", 0], "prompt": prompt, "negative_prompt": neg,
            "resolution": cfg.get("resolution", 1024)}},
        "5": {"class_type": "EmptySD3LatentImage", "inputs": {
            "width": cfg["width"], "height": cfg["height"], "batch_size": 1}},
        "6": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["4", 0], "negative": ["4", 1],
            "latent_image": ["5", 0], "seed": seed, "steps": steps,
            "cfg": sampler_cfg, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1.0}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {
            "images": ["7", 0], "filename_prefix": prefix}},
    }


def submit(wf):
    req = urllib.request.Request(
        API + "/prompt", data=json.dumps({"prompt": wf}).encode(),
        headers={"Content-Type": "application/json"})
    return json.load(op.open(req, timeout=60))["prompt_id"]


def wait(pid, timeout=1800):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.load(op.open(API + "/history/" + pid, timeout=30))
        if pid in h:
            st = h[pid]["status"]
            if st.get("status_str") != "success":
                for m in st.get("messages", [])[-3:]:
                    print("    ERR", str(m)[:300], flush=True)
                return None
            return h[pid]["outputs"]
        time.sleep(3)
    return None


def compose(cfg, shot):
    """组装顺序：scene → [人物] → [收尾句] → 风格锚点。竖屏在 scene 后插竖屏锚点。"""
    parts = [shot["scene"]]
    if cfg.get("vertical_anchor"):
        parts.append(cfg["vertical_anchor"])
    if shot.get("person"):
        parts.append(PERSON[shot["person"]])
    if shot.get("tail"):
        parts.append(shot["tail"])
    parts.append(cfg["style_anchor"])
    if shot.get("tone"):
        parts.append(cfg.get("tones", {}).get(shot["tone"], ""))
    neg = cfg["negative"]
    if cfg.get("extra_negative"):
        neg = neg + ", " + cfg["extra_negative"]
    if cfg.get("vertical_extra_negative"):
        neg = neg + ", " + cfg["vertical_extra_negative"]
    return ", ".join(p for p in parts if p), neg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="shots.json")
    ap.add_argument("--only", default="")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--redo", default="")
    ap.add_argument("--turbo", action="store_true")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    cfg = load_cfg(args.config)
    out_dir = os.path.abspath(cfg["out_dir"])
    os.makedirs(out_dir, exist_ok=True)
    redo = set(x for x in args.redo.split(",") if x)
    seed = args.seed if args.seed is not None else cfg.get("seed", 20261031)

    shots = cfg["shots"]
    if args.only:
        shots = [s for s in shots if s["id"].startswith(args.only)]
    if args.limit:
        shots = shots[:args.limit]

    print("待生成 %d 张 → %dx%d  输出 %s"
          % (len(shots), cfg["width"], cfg["height"], out_dir), flush=True)

    done = skip = fail = 0
    t0 = time.time()
    for shot in shots:
        iid = shot["id"]
        dst = os.path.join(out_dir, iid + ".png")
        # 三个条件才跳过：存在 + >10000 字节（防半截文件）+ 不在 redo 列表
        if os.path.exists(dst) and os.path.getsize(dst) > 10000 and iid not in redo:
            skip += 1
            continue
        prompt, neg = compose(cfg, shot)
        wf = build_wf(cfg, prompt, neg, "_g_" + iid, args.turbo, seed)
        try:
            pid = submit(wf)
        except Exception as e:
            print("  [%s] 提交失败 %s" % (iid, e), flush=True)
            fail += 1
            continue
        outs = wait(pid)
        if not outs:
            print("  [%s] 生成失败" % iid, flush=True)
            fail += 1
            continue
        saved = False
        for node in outs.values():
            for im in node.get("images", []):
                # 输出可能在多个目录（桌面版 Shared / 手动启动 Installs），逐个找
                for outdir in _output_dirs():
                    src = os.path.join(outdir, im["filename"])
                    if os.path.exists(src):
                        shutil.copy2(src, dst)
                        saved = True
                        break
                if saved:
                    break
        if saved:
            done += 1
            el = time.time() - t0
            print("  [%d/%d] %s  %.1fs  用时 %.1f 分  剩余约 %.0f 分"
                  % (done, len(shots), iid, el / max(1, done), el / 60,
                     el / max(1, done) * (len(shots) - done) / 60), flush=True)
        else:
            print("  [%s] 未找到输出文件" % iid, flush=True)
            fail += 1

    print("完成 %d 张 / 跳过 %d / 失败 %d" % (done, skip, fail))


if __name__ == "__main__":
    main()
