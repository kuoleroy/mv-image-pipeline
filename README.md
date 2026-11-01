# 图片烧 MV / 爆款短视频流水线 · Skill

> **本仓库现在只是「技能」** —— 图片烧 MV / 爆款短视频流水线，供 ComfyUI 出图使用。
> 共享技能的**开关管理软件**（Skillsmith）已独立成仓：
> **https://github.com/kuoleroy/skillsmith**（安装包在它的 Releases 里）。

把「一堆静态图」变成一条有呼吸、有节奏、有字幕的成片。

针对的硬约束只有一个：**显卡不行也能出片**。显卡只在出图和超分两个环节工作，渲染全程 CPU 跑 ffmpeg，12GB 显存甚至更低都能完成整条链路。

---

## 这个技能解决什么

| 症状 | 根因 | 本技能的做法 |
|---|---|---|
| 显卡不够，跑不动视频模型 | 图生视频要吃满显存 | 改成「静态图 + Ken Burns 推移」，渲染零 GPU 占用 |
| 出图全变成正面站立 | 场景描述缺动作与空间关系 | 强动作 + 前景遮挡 + 物理反应，三件套改写 |
| 画面像 PPT 幻灯片 | 镜头密度不足 | 每镜压到 2.3–2.4s，相邻不重复景别 |
| 字幕在暗背景上看不见 | 没量亮度就配了墨字 | 先 `bright` 采样，再按 ink/light/pale 三档配色 |
| 相邻两句字幕叠在一起 | 分段生成时末句多吃 2.2s 尾巴 | 内置收紧算法：`end` 收到 `next_start + 0.12` |
| 人物头顶被切掉 | 人物镜头走了 cover 裁切 | 人物永远 contain，模糊底 + 居中 |
| 渲染输出帧数爆炸 | 给 `zoompan` 加了 `-loop 1` | 单帧输入，`zoompan` 的 `d=frames` |
| 帧率上不去只能靠 AI 插帧 | 误以为静态图必须插帧 | `zoompan` 原生算任意帧率，60fps 无复制帧 |
| 竖屏图里出现横构图 | 提示词没压制 | 负面词加 `landscape orientation, letterboxing` |

---

## 核心认知：镜头密度 ≠ 图片数量

观感由「每秒切几刀」决定，不由「图有多少张」决定。

| 用途 | 时长 | 镜头数 | 每镜 | 切点依据 |
|---|---|---|---|---|
| MV 完整版 | 190s | 80 | 2.4s | 唱词（LRC 行首） |
| 抖音竖屏 | 86s | 38 | 2.3s | 唱词 |
| 爆款短视频 | 42s | 45 | 0.9s | 节拍（BPM 网格） |

**库要生成到 250+ 张供挑选，但入片镜头数按段落情绪排，不是每张都用。**

实测参考：一次实战生成 120 张，入片 80 张，审图后重做 13 张。

---

## 快速开始

```bash
# 1. 出图（需要本地 ComfyUI 跑在 8188）
python3 scripts/comfy_gen.py --config shots.json

# 2. 审图拼贴，快速过一遍
python3 scripts/mv_qc.py sheet 机位库 审图.jpg

# 3. 超分到渲染基准（必须用 ComfyUI 的 venv，那里才有 torch+cuda）
<comfy>/.venv/bin/python scripts/upscale.py \
  --src 机位库 --dst 机位库_2k --target 2592,1458

# 4. 时间轴（MV 模式：切点跟唱词）
python3 scripts/timeline_build.py lrc --lrc 歌词/歌名.lrc --map 映射.json \
  --audio 原曲.wav --out 时间轴.json

# 5. 渲染
python3 scripts/mv_render.py --config config.json

# 6. 采样亮度，决定字幕配色
python3 scripts/mv_qc.py bright 成片.mp4 0,4,10,20,40

# 7. 字幕（先出 ASS，再烧）
python3 scripts/subs_build.py --config subs.json --out 字幕.ass
python3 scripts/subs_build.py --config subs.json --burn 无词成片.mp4 --out 带词成片.mp4

# 8. 质检
python3 scripts/mv_qc.py check 成片.mp4
```

装进 WorkBuddy：

```
WorkBuddy → 设置 → 技能 → 添加本地技能 → 选 mv-image-pipeline 目录
```

---

## 流水线全貌

```
定义机位库 shots.json
  ↓  comfy_gen.py                          ← ComfyUI 批量出图（幂等，可断点续跑）
  ↓  mv_qc.py sheet                        ← 审图拼贴（必做，不是可选）
  ↓  --redo 重做失败镜头
机位库/*.png
  ↓  upscale.py                            ← 4x 超分后缩到渲染基准，消除二次插值
机位库_2k/*.png
  ↓  timeline_build.py lrc|beat            ← 段 → 镜头 ID 映射
时间轴.json
  ↓  mv_render.py --fps 60                 ← Ken Burns 推移 + xfade 拼接（纯 CPU）
无词成片.mp4
  ↓  mv_qc.py bright                       ← 采样亮度
  ↓  subs_build.py                         ← 分档配色 + 收紧算法 + 烧字幕
带词成片.mp4
  ↓  mv_qc.py check                        ← 解码零报错（硬指标）
成片.mp4
```

---

## 目录结构

```
mv-image-pipeline/
├── SKILL.md                          核心方法论与完整流程
├── references/
│   ├── prompt-craft.md               提示词工程：失败模式与改写对照 ★
│   ├── rendering.md                  渲染层算法细节与推导 ★
│   ├── subtitles.md                  libass 硬约束与字幕三档配色 ★
│   ├── comfy-setup.md                ComfyUI 路径探测与显存配置
│   └── verified-recipes.md           已验证可用的完整配置样例 ★
├── scripts/
│   ├── comfy_gen.py                  ComfyUI 批量出图（幂等 / 断点续跑）
│   ├── upscale.py                    4x 超分 + Lanczos 缩放
│   ├── timeline_build.py             时间轴生成（lrc 模式 / beat 模式）
│   ├── mv_render.py                  成片渲染（zoompan + xfade）
│   ├── subs_build.py                 字幕生成与烧制
│   ├── mv_qc.py                      质检（解码 / 亮度 / 镜头表 / 审图拼贴）
│   └── share_skills.py               跨 Agent 分发本 Skill（软链/联接）★
├── assets/                           各配置样例（可直接改用）
    ├── shots.example.json            机位库定义
    ├── render.example.json           渲染配置
    └── subs.example.json             字幕配置
```

---

## 在多个 AI Agent 之间共享本 Skill

每个 Agent 有自己的 skills 目录，同一份 Skill 复制到多处必然不同步。
本仓库附带了 `share_skills.py`，用**单一真源 + 软链分发**解决：

```bash
# 扫描本机装了哪些 Agent
python3 scripts/share_skills.py list

# 把 mv-image-pipeline 软链到所有已装 Agent
python3 scripts/share_skills.py link mv-image-pipeline

# 看当前分发状态
python3 scripts/share_skills.py status mv-image-pipeline

# 解除软链（真源保留）
python3 scripts/share_skills.py unlink mv-image-pipeline
```

**原理**：真源放在 `~/.agents/skills/<name>`（Codex / Cursor / Copilot 共用这个路径），
其他 Agent 目录里放软链指过去。改真源一次，所有 Agent 同时生效。

| Agent | 全局 skills 路径 |
|---|---|
| WorkBuddy | `~/.workbuddy/skills/` |
| WorkBuddy 国际版 | `~/.workbuddy-ai/skills/` |
| 天翼 TeleAgent | `~/.config/TeleAgent/users/<user_id>/skills/` |
| 华为 CodeArts Doer | `~/.codeartsdoer/skills/` |
| 阿里 Qoder | `~/.qoder/skills/` |
| Claude Code | `~/.claude/skills/` |
| Codex / Cursor / Copilot | `~/.agents/skills/` |
| CodeBuddy | `~/.codebuddy/skills/` |
| Gemini CLI | `~/.gemini/skills/` |
| OpenCode | `~/.config/opencode/skills/` |

**Windows 注意**：`~/.workbuddy` 不允许创建符号链接（`ln -s` 报 `Operation not permitted`），
必须用 NTFS junction（目录联接）。脚本已自动处理，且 junction 不需要管理员权限。

**脚手架目录**：以 `_` 开头的目录（如国际版的 `_template/`）是新建 skill 的模板，
不是可调用 skill。`converge_skills.py` 会自动跳过，不会把它们搬走或分发。

**受管 skill 不搬动**：两类 skill 会被自动跳过 ——

| 类型 | 判据 | 原因 |
|---|---|---|
| skillhub 托管 | 目录内有 `_skillhub_meta.json` | 元数据存绝对路径，搬动会破坏 marketplace 更新 |
| TeleAgent 内置 | 名字在安装包 `resources/skills/buildin-meta.json` 里 | 带 `versionId`/`serverId`，由服务端同步更新 |

TeleAgent 的用户 ID 随账号变化，脚本用 glob 动态发现，不硬编码路径。

> 同在 `.config/` 下的两个目录容易混淆：`~/.config/opencode/skills/`（OpenCode 本体）
> 和 `~/.config/TeleAgent/users/<id>/skills/`（天翼 TeleAgent）——是两个不同的 Agent。
> OpenCode 全机只有 `~/.config/opencode/skills/` 一个 skills 目录；
> 它的 `.local/share/opencode/` 里没有 skills，不用管。

**插件托管的 skill 不归我们管**：Qoder 的插件 skill 在 `~/.qoder/plugins/cache/<来源>/<版本>/skills/`
下，由 marketplace 管理，市场更新会整包替换。本脚本只碰 `~/.qoder/skills/`（用户级），两者互不干扰。

**端专属 skill**：`browser-cli-skill` 依赖 TeleAgent 打包的 `tele_opencli` 运行时
（`~/.local/share/TeleAgent/`），`codebase-crossrepo-pipeline` 依赖华为 CodeArts 工具链的
`cb` / `codegraph` CLI —— 二者只在对应端有意义，因此只分发到那一端。


> 另一个跨端方案是 Vercel 的 `npx skills add <repo>`：一条命令装到 75+ 个 Agent，
> 同样是软链分发。但 **WorkBuddy 不在它的官方支持列表里**，所以本仓库自带脚本更直接。

---

## 关键设计决策

### 静态图不需要 AI 插帧

常见误区是「30fps 视频要变 60fps，得上 RIFE」。实测不成立：

```
60fps 跨 2 帧位移 / 30fps 跨 1 帧位移 = 1.009
相邻帧均不同，无复制帧
```

`zoompan` 能原生计算任意帧率，位移比与帧率严格成比例，比 RIFE 猜中间帧更准。

而 `rife47.pth` 本身**无法由 ComfyUI 核心加载** —— 权重是 RIFE 3.x 旧结构（`encode.0/1` 单尺度、4 个 IFBlock），核心 IFNet 需要 `encode.cnn0~cnn3` 四级结构、5 个 IFBlock，键名重映射解决不了结构差异。

### 字幕必须先量亮度

不量就配必有一半画面上的字看不见。三档：

| 档 | 场景 | 字色 | 描边 |
|---|---|---|---|
| `ink` | 亮场（米白墙、天空） | 墨色 `#1E1A18` | 柔白 2.0 |
| `light` | 暗场（雨夜、逆光） | 米白 `#EDE7DC` | 深色 2.2 |
| `pale` | 极亮淡彩 | 墨色实心 | 无描边，只留投影 |

白描边在近白底上会啃掉细笔画（放大看像空心字），所以 `pale` 必须去描边。**判断字形是否空心必须放大取像素，缩略图会误判。**

### 用整句淡入，不用逐字扫色

逐字扫色（`\kf`）会让「还没唱到」的字停在浅灰，压在灰路面、灰沙发这类中间调背景上几乎看不见。改用整句 `\fad` 淡入。

### 字幕重叠必须全量扫

分段生成时每个独立单句段都会被误加全曲末句的 +2.2s 尾巴，导致相邻两句同屏。收紧算法：

```
按 Start 排序，凡 end > next_start + 0.13，统一收回到 next_start + 0.12
```

---

## 渲染层硬规则

改代码前先读 `references/rendering.md`。

- 单帧输入 + `zoompan` 的 `d=frames`。**绝不能加 `-loop 1`**，帧数会指数爆炸
- 人物镜头一律 `contain`（模糊底 + 居中），`cover` 裁切会切掉头顶
- 视频源片段不加 `zoompan`（已有运动会打架）；比镜头短用 `tpad=stop_mode=clone`，循环会看出重复
- 每镜时长 = 段长/段内镜数，除末镜外各 +overlap；总长 = Σd − overlap×(n−1)
- 字幕位置：`y` 是 **1080x1920 基准值**，按画布高度换算。横屏（1080 高）时直接传像素值会被压到画面中央

---

## 爆款短视频变体

爆款短视频本质也是「视觉蒙太奇 + BGM」，与 MV 同构，**出图与渲染层 100% 复用**。三处必须改：

1. **切点跟节拍，不跟唱词** → `timeline_build.py beat`
2. **密度提到 0.8–1.5s/镜** → MV 的 2.4s 在竖屏短视频里会被划走
3. **前 3 秒必须有钩子** → `--hook 3`，最密最快；MV 可以慢慢建立，短视频不行

```bash
python3 scripts/timeline_build.py beat --bpm 92 --duration 42 --hook 3 \
  --pool 机位库_竖屏 --out 时间轴.json
```

单镜最短 **0.5s**（`--min-cut`）。低于此画面来不及看清，只会变闪。爆款视频的钩子是「切得快」不是「切得碎」—— 92 BPM 下 hook 段 0.5s、主体 0.65s、尾部 1.3s 是合理分布。

字幕也要改：短视频大量人静音刷，关键词卡要**超大号**，不能是歌词小字幕。

---

## 平台交付

| 平台 | 规格 | 关键点 |
|---|---|---|
| 抖音 | 1080x1920 / 30fps / 60-90s | 标题 + 话题；**必须勾选「内容由 AI 生成」**；电脑端不关联正式音源，避免从 0 秒播放导致音画错位 |
| B站 | 1920x1080 / 30fps / 3-4min | 封面 + 简介 + 分区；参加「新世代音乐人计划」对应 AI/手搓赛道 |
| 视频号 | 1080x1920 / **60fps** / 60-90s | **手机相册直传或「视频号助手」网页上传**，不要经微信聊天窗口传，可能被压成 640p |

码率别省：平台会二次编码，没余量就出块状噪点。

---

## 环境变量

出图相关路径全部自动探测，也可显式指定：

| 变量 | 作用 | 示例 |
|---|---|---|
| `COMFY_HOME` | ComfyUI 根目录 | `~/ComfyUI` |
| `COMFY_API` | ComfyUI 服务地址 | `http://127.0.0.1:8188` |
| `COMFY_OUT` | 输出目录 | `~/ComfyUI/output` |
| `COMFY_MODEL_DIRS` | 模型目录 | `~/ComfyUI/models/upscale_models` |

---

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| ComfyUI | 本地 8188 端口 | 出图与超分 |
| Qwen Image 2.1 | `diffusion_models/` + `text_encoders/` + `vae/` | 出图模型，见 `references/comfy-setup.md` |
| Python | 3.10+ | 渲染与字幕脚本 |
| ffmpeg | 任意近期版本 | 渲染与烧字幕，需 libass |
| GPU | 非必需 | 渲染全程 CPU；出图建议 12GB + `--lowvram` |

---

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
| 竖屏图里出现横构图 | 没显式压制 | 负面词加 `landscape orientation, letterboxing` |
| 视频源片段动作重复 | 用了循环补时长 | `tpad=stop_mode=clone` |
| 渲染很慢 | 走了 AI 插帧 | 静态图直接 `--fps 60`，别插帧 |

---

## 许可

MIT

<!-- 本地 Skill 目录即 Git 仓库，可直接 git push -->
