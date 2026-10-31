# 渲染层算法细节与推导

所有内容来自 190 秒横屏版 + 86 秒竖屏版的实际渲染与验证。

## zoompan 帧数

```python
vf = (f"{base},zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={W}x{H}:fps={fps},"
      f"setsar=1,format=yuv420p")
cmd = ["ffmpeg", "-v", "error", "-y", "-i", path,
       "-vf", vf, "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast",
       "-crf", str(CLIP_CRF), "-pix_fmt", "yuv420p", out]
```

**单帧输入 + `zoompan` 的 `d=frames`，输出正好 frames 帧。**

加 `-loop 1` 会让输入变成无限帧流，`zoompan` 的 `d=frames` 对每一帧都重新展开，输出帧数 = 输入帧数 × frames，指数级膨胀。

## 60fps 不需要 AI 插帧

RIFE 类模型在本机无法由 ComfyUI 核心加载：

- `rife47.pth` 权重是 RIFE 3.x 旧结构：`encode.0/1` 单尺度、4 个 IFBlock
- 核心 IFNet 需要 `encode.cnn0~cnn3` 四级结构、5 个 IFBlock
- 键名重映射无法解决结构差异

但静态图根本不需要猜中间帧。`zoompan` 可以直接原生计算任意帧率：

```
60fps 跨 2 帧位移 / 30fps 跨 1 帧位移 = 1.009
相邻帧均不同，无复制帧
```

比 AI 插帧更准确——AI 插帧是在两张猜测的帧之间编造中间态，静态图推移的中间态本来就是解析可算的。

结论：**素材是静态图时，直接 `--fps 60`，不要走插帧。**

## cover vs contain

```python
if fit == "cover" and not person and not is_video:
    base = (f"scale={int(W*1.35)}:{int(H*1.35)}:force_original_aspect_ratio=increase,"
            f"crop={int(W*1.35)}:{int(H*1.35)},setsar=1")
else:  # contain：方图放中间，上下用自身模糊背景
    BW, BH = int(W * 1.35), int(H * 1.35)
    zoom = 1.45 if (person and H > W and not is_video) else 1.0
    fg = (f"scale={int(BW*zoom)}:{int(BH*zoom)}:force_original_aspect_ratio=decrease"
          if zoom > 1 else f"scale={BW}:{BH}:force_original_aspect_ratio=decrease")
    blur, bright = (200, 0.02) if is_video else (90, -0.06)
    base = (f"split=2[b][f];"
            f"[b]scale={BW}:{BH}:force_original_aspect_ratio=increase,"
            f"crop={BW}:{BH},gblur=sigma={blur}:steps=3,"
            f"eq=brightness={bright}:saturation=0.88[b2];"
            f"[f]{fg}[f2];"
            f"[b2][f2]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1")
```

要点：
- **人物一律 contain**。cover 裁切会把头顶切掉。
- 竖屏人物镜头放大 1.45 倍（脸占画面更多），只做极缓推近（`hold`），不乱摇。
- 视频源人物占比大，模糊后会在上下留一圈暗影，所以 `blur` 取 200（接近纯色），静态图取 90。

## 视频源片段

```python
vd = probe_dur(path)
pad = f",tpad=stop_mode=clone:stop_duration={max(0.0, dur - vd):.2f}" if vd < dur else ""
vf = (f"{base},fps={fps},scale={W}:{H},setsar=1,format=yuv420p{pad},"
      f"trim=duration={dur},setpts=PTS-STARTPTS")
cmd = ["ffmpeg", "-v", "error", "-y", "-t", f"{dur + 1:.3f}",
       "-i", path, "-vf", vf, "-r", str(fps), ...]
```

- 已有运动，**不再加 zoompan**（会打架）
- 比镜头短用 `tpad=stop_mode=clone` 用最后一帧定格收尾，**不要 loop**（循环看得出动作重复）
- `trim=duration` + `setpts=PTS-STARTPTS` 精修时长，输出端 `-t` 放宽到 `dur + 1` 避免输入被截断过早

## 推移效果

```python
Z = 0.10
hold:    z = f"1+0.045*on/{frames}"                          # 极缓推近，人物用
push:    z = f"min(1+{Z}*on/{frames},1+{Z})"
push_slow: z = f"min(1+{Z/2}*on/{frames},1+{Z/2})"
pull:    z = f"max(1+{Z}-{Z}*on/{frames},1.0)"
pan_r:   z = f"{1+Z/1.5}";  x = f"(iw-iw/zoom)*on/{frames}"
pan_l:   z = f"{1+Z/1.5}";  x = f"(iw-iw/zoom)*(1-on/{frames})"
pan_up:  z = f"{1+Z/1.5}";  y = f"(ih-ih/zoom)*on/{frames}"
```

`x = "iw/2-(iw/zoom/2)"` / `y = "ih/2-(ih/zoom/2)"` 是居中锚点。

运动种类多于 4 种，镜头数上百时才不会看出循环。

## 时长分配与总长补齐

```python
d = seg / n
if not (si == len(secs) - 1 and i == n - 1):
    d += overlap
...
total = sum(x[1] for x in plan) - overlap * max(0, len(plan) - 1)
if ad and abs(ad - total) > 0.05:
    p0, d0, e0 = plan[-1]
    plan[-1] = (p0, max(1.0, d0 + (ad - total)), e0)
```

1. 每镜时长 = 段长 / 段内镜头数
2. 除最后一段的最后一镜外，每镜都 +overlap（默认 0.6s）——每镜的**实际占用**是 `d - overlap`，段边界自然对齐
3. 总长 = Σd − overlap × (n−1)。因为有 n−1 镜带了 +overlap，要减掉，否则总长虚高
4. 补齐：若 |audio_dur − total| > 0.05，差值全部加到最后一镜（保底 `max(1.0, ...)`）

## xfade 串联

```python
lines = []
cur = "0:v"
acc = plan[0][1]
for i in range(1, len(clips)):
    off = acc - overlap
    tagv = f"x{i}"
    lines.append(f"[{cur}][{i}:v]xfade=transition=fade:duration={overlap}:offset={off:.4f}[{tagv}]")
    cur = tagv
    acc = acc + plan[i][1] - overlap
```

- `acc` = 已拼好的时间轴当前总长
- 第 i 镜的编码时长是 `plan[i][1]`（已含 +overlap）
- 叠化起点 = `acc − overlap`，叠化时长 = overlap → 叠化在 `acc` 处结束
- 叠化后总长 = `acc + plan[i][1] − overlap`

第 0 镜没带 +overlap（`plan[0][1]` 已经是净长），第 1..n−1 镜都带了 +overlap，所以 `acc` 的更新式与总长公式完全自洽。

## 首尾与音频

```python
fi, fo = 0.7, 1.8
fo = min(fo, max(0.5, total * 0.15))
fc = (";".join(lines) + f";[{cur}]{GRAIN},"
      f"fade=t=in:st=0:d={fi},fade=t=out:st={total - fo:.3f}:d={fo:.3f},"
      f"format=yuv420p[vout]")
ao = min(2.6, total * 0.16)
afade = f"afade=t=in:st=0:d=0.55,afade=t=out:st={total - ao:.3f}:d={ao:.3f}"
```

| 位置 | 时长 | 做法 |
|---|---|---|
| 开场 | 0.7s | 从全黑浮出 |
| 结尾画面 | 1.8s | 沉回黑 |
| 结尾音乐 | 2.6s | 比画面早落，不戛然而止 |
| 镜头之间 | 0.6s | xfade 交叉溶解 |

颗粒：`GRAIN = "noise=alls=4:allf=t+u"`。画面本身就干净时重颗粒会脏。

## 超分消除二次插值

渲染的推移基准是 `1920*1.35 = 2592x1458`。原生 1536x864 直接拉到 2592 是 1.69 倍纯插值，线条（窗框、电线、栏杆）会发软。

先 4x-UltraSharp 超到 6144x3456，再 Lanczos 缩到 2592x1458，等于「先有细节再缩小」。分块 `TILE, PAD = 512, 24`。

渲染时 1:1 使用超分图，不再二次插值。

## 其他已验证的坑

- 竖版 768x1344 会把方图纵向拉长 1.75 倍（first_frame 是 stretch 不是 pad），人变瘦。要么用方图出，要么先把输入 pad 成竖版。
- 首尾帧锁同一张图并不能锁住构图，输出仍可能退成中景。只能多抽几条挑。
- 临时片段不要批量删（几十个文件会触发安全确认），要清就删整个 WORK 目录。
- `--reuse` 复用已渲片段：改完时间轴只重拼接时快很多。
