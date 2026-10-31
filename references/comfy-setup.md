# ComfyUI 配置

## 路径

脚本会自动探测常见安装位置，也可以用环境变量指定：

| 环境变量 | 作用 | 示例 |
|---|---|---|
| `COMFY_HOME` | ComfyUI 根目录 | `~/AppData/Local/Comfy-Desktop/ComfyUI-Installs/local/ComfyUI` |
| `COMFY_API` | ComfyUI 服务地址 | `http://127.0.0.1:8188` |
| `COMFY_OUT` | 输出目录（多个用 `;` 分隔） | `~/ComfyUI/output` |
| `COMFY_MODEL_DIRS` | 模型目录（多个用 `;` 分隔） | `~/ComfyUI/models/upscale_models` |

Windows 桌面版安装（Comfy-Desktop）的典型布局：

```
ComfyUI-Installs/local/ComfyUI   ← 手动启动时读这里的 models
ComfyUI-Shared/models            ← 桌面版「共享模型库」，启动时排最前
```

其他平台：`~/.local/share/ComfyUI`（Linux）、`~/ComfyUI`（源码安装）、`/Applications/ComfyUI.app/Contents/Resources/ComfyUI`（macOS）。

## 两个 models 目录都要有模型

桌面版有两处模型目录：

- `ComfyUI-Shared/models` — 桌面版官方「共享模型库」，由 `settings.json` 的 `modelsDirs` + `instance-model-paths\inst-*.yaml` 里 `is_default: true` 指定，桌面版启动会传 `--extra-model-paths-config`，搜索时排最前
- `ComfyUI-Installs/local/ComfyUI/models` — 安装自带目录，手动 `python main.py` 不带该参数时**只读这里**

手动启动时如果模型只在 Shared 里，会报找不到模型。**最简单的做法：两个目录都放一份。**

## 启动命令

```bash
cd <comfy-dir>
./.venv/Scripts/python.exe main.py --port 8188 --lowvram --disable-smart-memory
```

**12GB 显存（RTX 3060）必须带 `--lowvram --disable-smart-memory`**，否则 OOM。

桌面版已启动时不要重复启动，端口会冲突。

## 检查是否在跑

```bash
curl -s http://127.0.0.1:8188/system_stats
```

返回 JSON 就是活的。返回连接失败就是没启动。

## 常见故障

### `FileNotFoundError: extra_models.yaml`

手动启动时误传了 `--extra-model-paths-config` 指向不存在的文件。**去掉这个参数**即可——模型已经在 Installs 的 models 目录里。

### urllib 连不上 127.0.0.1:8188

本机装了系统代理，urllib 会走代理导致本地端口连不通。

```python
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
```

**必须加。**

### 输出目录不一致

桌面版的 `outputDir` 指向 `ComfyUI-Shared/output`，而脚本里的 `COMFY_OUT` 常写 `Installs/.../ComfyUI/output`。手动启动的实例输出到 Installs，桌面版输出到 Shared。

脚本用 `history` 接口返回的 `filename` 拼路径，所以两个目录都扫一遍最稳：

```python
for d in (INSTALLS_OUT, SHARED_OUT):
    src = os.path.join(d, im["filename"])
    if os.path.exists(src):
        ...
```

## Qwen Image 2.1 出图模型

### 权重

| 用途 | 文件 | 位置 |
|---|---|---|
| 标准出图 | `qwen_image_2.1_int8_convrot.safetensors` | `diffusion_models/` |
| 快速出图（验构图） | `qwen_image_2.1_turbo_int8_convrot.safetensors` | `diffusion_models/` |
| 文本编码器 | `qwen3vl_8b_w4a8.safetensors` | `text_encoders/` |
| VAE | `qwen_image_2.1_vae_bf16.safetensors` | `vae/` |

其他可用模型：`qwen3vl_32b_minimax_h3-Q4_K_M.gguf`（图生视频用）、`MiniMax-H3-FL2VA / Ref2VA Q4_K_S.gguf`（图生视频，带 MiniMaxH3ImageToVideo 节点）、`triposplat_fp16.safetensors`（3D）、`acestep_v1.5_turbo.safetensors`（音乐）。

### 节点结构

**没有 `ModelPatchLoader`。** Qwen Image 用 `UNETLoader` + `TextEncodeQwenImage21`。

```json
{
  "1": {"class_type": "UNETLoader", "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors", "weight_dtype": "default"}},
  "2": {"class_type": "CLIPLoader", "inputs": {
      "clip_name": "qwen3vl_8b_w4a8.safetensors", "type": "qwen_image"}},
  "3": {"class_type": "VAELoader", "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
  "4": {"class_type": "TextEncodeQwenImage21", "inputs": {
      "clip": ["2", 0], "prompt": "<prompt>", "negative_prompt": "<neg>",
      "resolution": 1024}},
  "5": {"class_type": "EmptySD3LatentImage", "inputs": {
      "width": 1536, "height": 864, "batch_size": 1}},
  "6": {"class_type": "KSampler", "inputs": {
      "model": ["1", 0], "positive": ["4", 0], "negative": ["4", 1],
      "latent_image": ["5", 0], "seed": 20261031, "steps": 25, "cfg": 2.5,
      "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
  "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
  "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "_g_A01"}}
}
```

关键点：
- `TextEncodeQwenImage21` **单节点同时出 positive + negative**，输出 0 = pos，输出 1 = neg
- `CLIPLoader` 的 `type` 必须是 `qwen_image`
- 用 `EmptySD3LatentImage`（SD3 风格 16ch latent），不是 `EmptyLatentImage`
- turbo 模型：`steps=8, cfg=1.0`；标准：`steps=25, cfg=2.5`
- `sampler_name=euler`, `scheduler=simple`

### 尺寸

原生出图用 `1536x864`（横屏）或 `864x1536`（竖屏），渲染时 1.25x 到成片尺寸。超分后按 1.35 基准出图，渲染 1:1 使用。

### seed

可以写死一个固定 seed，靠 prompt 区分；也可以每张递增。重做某张时保持 seed 不变，重现性好。

## 输出回填

不靠文件名解析，靠 `history` 接口：

```python
saved = False
for node in outs.values():
    for im in node.get("images", []):
        src = os.path.join(COMFY_OUT, im["filename"])
        if os.path.exists(src):
            shutil.copy2(src, dst)
            saved = True
```

最终文件名 = 镜头 ID + `.png`。

## 图生视频（本机可用，但慢）

节点：`LoadImage` → `UnetLoaderGGUF` → `CLIPLoaderGGUF`（type=`minimax`）→ `MiniMaxH3SigmaShift` → `MiniMaxH3ImageToVideo` → `ConditioningZeroOut` → `SaveWEBM`

- 单条约 8 分钟（含模型加载）
- 产出率约 2/3（构图和脸会漂，靠多抽选）
- 12GB 显存必须 lowvram

**图片推视频路线不需要这个。** 图生视频适合做少量动态镜头点缀，整片用静态图推移更可控、更快、不挑显存。

## 插帧模型

`rife47.pth` **无法由 ComfyUI 核心加载**：

- 权重是 RIFE 3.x 旧结构：`encode.0/1` 单尺度、4 个 IFBlock
- 核心 IFNet 需要 `encode.cnn0~cnn3` 四级结构、5 个 IFBlock
- 键名重映射无法解决结构差异

**静态图素材不需要插帧。** `zoompan` 直接原生算 60fps，比 AI 猜中间帧更准。
