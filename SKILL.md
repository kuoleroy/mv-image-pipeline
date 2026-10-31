---
name: mv-image-pipeline
description: 用 AI 生成的静态图片库制作音乐视频（MV）与 AI 爆款短视频。涵盖机位库生成（ComfyUI/Qwen Image）、4x 超分、歌词或节拍时间轴、Ken Burns 推移渲染、ASS 字幕烧制、成片质检。适用于"做 MV""把这首歌做成视频""AI 短视频""抖音视频""竖屏视频""横屏视频""歌词视频""BGM 蒙太奇"等需求。纯 CPU 渲染，不依赖显卡性能。
agent_created: true
---

# 图片烧 MV / 爆款短视频流水线

把「一堆静态图」变成一条有呼吸、有节奏、有字幕的成片。

## 核心认知

**这条流水线的产物是视频，素材是图片。** 显卡只在出图和超分时工作，渲染全程 CPU。

**镜头密度比图片数量重要。** 观感由「每秒切几刀」决定，不由「图有多少张」决定：

| 用途 | 时长 | 镜头数 | 每镜 | 切点依据 |
|---|---|---|---|---|
| MV 完整版 | 190s | 80 | 2.4s | 唱词（LRC 行首） |
| 抖音竖屏 | 86s | 38 | 2.3s | 唱词 |
| 爆款短视频 | 42s | 45 | 0.9s | 节拍（BPM 网格） |

所以：**库要生成到 250+ 张供挑选，但入片镜头数按段落情绪排，不是每张都用。** 库深是成本问题，镜头数是效果问题。

## 目录约定

在一个工作目录下：

```
项目/
├── 原曲.wav              音频
├── 歌词/歌名.lrc          歌词时间轴
├── 机位库/               出图原生（1536x864 或 864x1536）
├── 机位库_2k/            4x 超分后缩到渲染基准（2592x1458 / 1458x2592）
├── 时间轴.json            段 → 镜头 ID 的映射
├── 字幕.ass
└── 成片.mp4
```

## 流水线

### 0. 准备 ComfyUI

出图需要本地 ComfyUI 跑在 8188。检查与启动：

```bash
curl -s http://127.0.0.1:8188/system_stats
```

未启动则（12GB 显卡必须带 lowvram）：

```bash
cd <ComfyUI>/ && ./.venv/Scripts/python.exe main.py --port 8188 --lowvram --disable-smart-memory
```

桌面版 ComfyUI 自带模型路径配置，手动启动时 Installs 与 Shared 两个 models 目录都要有模型文件。详见 `references/comfy-setup.md`。

### 1. 定义机位库

写 `shots.json`（结构见 `assets/shots.example.json`），每条是一个镜头：

```json
{
  "id": "A01",
  "scene": "wide shot, a lone figure on a rooftop at dusk, vast empty sky filling two thirds of the frame",
  "person": "full",
  "tail": "small in frame, low camera",
  "tone": "dusk"
}
```

**提示词纪律**（细节见 `references/prompt-craft.md`）：

- 每条以「景别 + 角度」开头，结尾再收一次，避免漂回正面中景
- 人物分三档：`full` / `face` / `hand`。**特写绝不能用 full**，服装描述会把画面拽回中景
- 空镜一律不塞人物描述
- 负面词强压文字招牌（模型很爱生成汉字招牌）
- **写意象，不写情绪**。`孤独的房间` 出不来图；`一张床，只有一侧有褶皱，另一侧平整得像没人睡过` 能出来

### 2. 出图

```bash
python scripts/comfy_gen.py --config shots.json
```

产出 `机位库/*.png`。脚本幂等：已存在且 >10000 字节的会跳过；`--redo A01,A02` 强制重做。

**审图是必做环节，不是可选。** 模型退化只有一个模式：场景描述不够「有动作 + 有空间关系」时，退回正面站立全身。修法不是加形容词，而是给**强动作 + 前景遮挡 + 物理反应**。

```bash
python scripts/mv_qc.py sheet 机位库 审图.jpg     # 拼贴，快速过一遍
```

失败的镜头改写 prompt 后 `--redo` 重跑。失败样本与改写对照见 `references/prompt-craft.md`。

### 3. 超分

渲染的推移基准是 `1920*1.35 = 2592x1458`（竖屏 `1458x2592`）。原生图直接拉到基准是 1.69 倍纯插值，线条会发软。先 4x 超分再 Lanczos 缩到基准，边缘明显更实。

```bash
<ComfyUI>/.venv/Scripts/python.exe scripts/upscale.py \
  --src 机位库 --dst 机位库_2k --target 2592,1458
```

必须用 ComfyUI 的 venv，那里才有 torch+cuda。

### 4. 时间轴

**MV 模式**（切点跟唱词）：

```bash
python scripts/timeline_build.py lrc --lrc 歌词/歌名.lrc --map 映射.json \
  --audio 原曲.wav --out 时间轴.json
```

映射文件格式：`[[起始秒, 段名, [镜头ID...]], ...]`，起始秒必须与 LRC 行首严格一致。

**节拍模式**（爆款短视频，切点跟节拍）：

```bash
python scripts/timeline_build.py beat --bpm 92 --duration 42 --hook 3 \
  --pool 机位库_竖屏 --out 时间轴.json
```

切点密度：hook 段半拍切（最快）→ 主体一拍切 → 尾部两拍切（留呼吸）。

**单镜最短 0.5s**（`--min-cut`）。低于 0.5s 画面来不及看清，只会变闪。爆款视频的钩子是「切得快」不是「切得碎」——92 BPM 下 hook 段 0.5s、主体 0.65s、尾部 1.3s 是合理分布。

**排序原则**：每个副歌走「全景建立 → 逐步收紧 → 特写砸下 → 再放开」的呼吸，相邻两镜不重复景别。段内图片均分该段时长；想给某张图更多时间，就把它单独拆成一段。

### 5. 渲染

写 `config.json`（见 `assets/render.example.json`），然后：

```bash
python scripts/mv_render.py --config config.json
```

- `--fps 60` 出 60fps 版本。**静态图不需要 AI 插帧**：`zoompan` 直接原生计算任意帧率，比 RIFE 猜中间帧更准（实测 60fps 跨 2 帧位移与 30fps 跨 1 帧位移之比 = 1.009，相邻帧均不同，无复制帧）
- `--vertical` 切竖屏
- `--reuse` 复用已渲片段，改完时间轴只重拼接时快很多
- `--clean` 渲染完清理临时片段目录

**渲染层硬规则**（改代码前先读 `references/rendering.md`）：

- 单帧输入 + `zoompan` 的 `d=frames`。**绝不能加 `-loop 1`**，会让帧数指数爆炸
- 人物镜头一律 `contain`（模糊底 + 居中），`cover` 裁切会切掉头顶
- 视频源片段不加 `zoompan`（已有运动会打架）；比镜头短用 `tpad=stop_mode=clone`，循环会看出重复
- 每镜时长 = 段长/段内镜数，除末镜外各 +overlap；总长 = Σd − overlap×(n−1)

### 6. 字幕

**先量亮度，再定颜色。** 这是最关键的一步，不量就配必有一半画面上的字看不见。

```bash
python scripts/mv_qc.py bright 成片.mp4 0,4,10,20,40
```

按结果分三档：

| 档 | 场景 | 字色 | 描边 |
|---|---|---|---|
| `ink` | 亮场（米白墙、天空） | 墨色 `#1E1A18` | 柔白 2.0 |
| `light` | 暗场（雨夜、逆光） | 米白 `#EDE7DC` | 深色 2.2 |
| `pale` | 极亮淡彩 | 墨色实心 | 无描边，只留投影 |

白描边在近白底上会啃掉细笔画（放大看像空心字），所以 `pale` 必须去描边。

写 `subs.json`（见 `assets/subs.example.json`）：

```bash
python scripts/subs_build.py --config subs.json --out 字幕.ass
python scripts/subs_build.py --config subs.json --burn 无词成片.mp4 --out 带词成片.mp4
```

**用整句淡入（plain）而不是逐字扫色。** 逐字扫色会让「还没唱到」的字停在浅灰，压在灰路面、灰沙发这类中间调背景上几乎看不见。

字幕位置换算：配置里的 `y` 是 **1080x1920 基准值**，脚本按画布高度换算。横屏（1080 高）时若直接传像素值，会被压到画面中央。

### 7. 质检

```bash
python scripts/mv_qc.py check 成片.mp4
python scripts/mv_qc.py shots 时间轴.json
```

**解码零报错是硬指标。** 其他参数再好，只要有一处解码报错就是废片。

**字幕重叠必须扫。** 分段生成时每段末句会多吃一条 2.2s 尾巴，导致相邻两句同屏。`subs_build.py` 内置收紧算法，但换流程后仍要验证。

### 8. 多 Agent 共享（可选）

如果要在这台机器上的多个 AI Agent（Claude Code / Codex / Cursor / WorkBuddy 等）之间共用本 Skill：

```bash
python scripts/share_skills.py list                     # 扫描已装 Agent
python scripts/share_skills.py link mv-image-pipeline   # 软链分发到所有 Agent
python scripts/share_skills.py status mv-image-pipeline # 看分发状态
```

原理是**单一真源 + 软链**：真源放 `~/.agents/skills/<name>`，其他 Agent 目录放软链指过去，改一处全端生效。

Windows 上 `~/.workbuddy` 不允许 symlink，必须用 NTFS junction（目录联接），脚本已自动处理。WorkBuddy 不在 Vercel `npx skills` 的官方 Agent 列表里，所以用自带脚本更直接。

#### 各端现场写 skill 后如何收敛

Skill 常常是在某个 Agent 会话里现场写出来的（Claude Code 写个 review skill、CodeBuddy 写个 deploy skill），此时它只存在于那一个端。用 `converge_skills.py` 收拢：

```bash
python scripts/converge_skills.py collect          # 试运行：列出将要收拢的 skill
python scripts/converge_skills.py collect --apply  # 真正执行
python scripts/converge_skills.py link --apply     # 分发到所有已装 Agent
python scripts/converge_skills.py status           # 看收敛与分发状态
```

规则：

| 情况 | 处理 |
|---|---|
| 各端各建了不同 skill | 全部收拢到真源，再软链分发回各端 |
| 多端同名、内容不同 | 取 mtime 新的做真源，其余备份为 `<name>.conflict-<agent>`，**不静默丢弃** |
| 含 `_skillhub_meta.json` | **跳过**，不搬动 —— marketplace 更新机制依赖其中的绝对路径 |
| 真源新建了 skill | junction 只映射已存在的目录，**必须重跑 `link`** 才会补建链接 |
| 真源删除了 skill | 重跑 `link` 会自动清理各端的孤儿链接 |

默认 dry-run，加 `--apply` 才写盘。

## 平台交付

| 平台 | 规格 | 关键点 |
|---|---|---|
| 抖音 | 1080x1920 / 30fps / 60-90s | 标题 + 话题；**必须勾选「内容由 AI 生成」**；电脑端不关联正式音源，避免从 0 秒播放导致音画错位 |
| B站 | 1920x1080 / 30fps / 3-4min | 封面 + 简介 + 分区；参加「新世代音乐人计划」对应 AI/手搓赛道 |
| 视频号 | 1080x1920 / **60fps** / 60-90s | **手机相册直传或「视频号助手」网页上传**，不要经微信聊天窗口传，可能被压成 640p |

码率别省：平台会二次编码，没余量就出块状噪点。

## 爆款短视频变体

爆款短视频本质也是「视觉蒙太奇 + BGM」，与 MV 同构，出图与渲染层 100% 复用。三处必须改：

1. **切点跟节拍，不跟唱词** → 用 `timeline_build.py beat`
2. **密度提到 0.8–1.5s/镜** → MV 的 2.4s 在竖屏短视频里会被划走
3. **前 3 秒必须有钩子** → `--hook 3`，最密最快；MV 可以慢慢建立，短视频不行

字幕也要改：短视频大量人静音刷，关键词卡要**超大号**，不能是歌词小字幕。

## 常见错误速查

| 现象 | 原因 | 修法 |
|---|---|---|
| 渲染输出帧数爆炸 | 加了 `-loop 1` | 单帧输入 + `zoompan` 的 `d=frames` |
| 人物头顶被切掉 | 人物走了 cover 裁切 | 人物永远 contain |
| 横屏字幕跑到画面中央 | `y` 没按基准换算 | `y` 用 1080x1920 基准值 |
| 相邻两句字幕同屏 | 段末句多吃 2.2s 尾巴 | 收紧算法：end 收到 `next_start + 0.12` |
| 字幕在暗背景上消失 | 没量亮度就配了墨字 | 先 `mv_qc.py bright`，按三档分 |
| 白描边把细笔画啃空 | 亮底上仍用白描边 | `pale` 档去描边，只留投影 |
| 模型把人物画成正面站立 | 场景缺动作与空间关系 | 加强动作 + 前景遮挡 + 物理反应 |
| 出图连不上 ComfyUI | urllib 走了系统代理 | `ProxyHandler({})` 绕过 |
| 生成出汉字招牌 | 负面词没压文字 | 负面词加 `text, signage text, chinese characters` |
| 竖屏图里出现横构图 | 没显式压制 | 负面词加 `landscape orientation, wide horizontal composition, letterboxing` |
| 视频源片段动作重复 | 用了循环补时长 | `tpad=stop_mode=clone` |

## 参考资料

- `references/prompt-craft.md` — 提示词工程：失败模式与改写对照
- `references/rendering.md` — 渲染层算法细节与推导
- `references/subtitles.md` — libass 硬约束与字幕分档
- `references/comfy-setup.md` — 本机 ComfyUI 模型路径与显存配置
- `references/verified-recipes.md` — 已验证可用的完整配置样例
