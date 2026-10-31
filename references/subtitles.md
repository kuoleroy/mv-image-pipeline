# 字幕：libass 硬约束与分档

## libass 十条硬约束

1. **字体加载**：本机只有铁蒺藜体（`Tiejili SC`）能被 libass 直接加载（它带 TrueType hinting 表）。`Noto Sans SC` 是可变字体，会被渲染成极细 Thin 且**加粗无效**——`ink` 风格正是利用这一点做质感，但想用它做粗体不行。要粗体用 `Microsoft YaHei` 或 `Source Han Sans SC`。`LXGW WenKai Mono`（霞鹜文楷）可用，OFL 协议可商用。

   志莽行书、马善政这类书法字体 libass 读不到，会回退黑体。要用书法字只能走 `brush_render.py` 把字形轮廓抽成 ASS 矢量路径（`\p1`），完全绕开字体加载。

2. **ASS 颜色是 `&HBBGGRR`**，不是 `&HRRGGBB`。写反了红色会变蓝紫。

3. **`\1c` 是累积标签**，不逐字重置。颜色会串到后面所有字。关键词变色必须每字显式写回。

4. **`\pos` 和 `\move` 不能同时出现**，否则位置行为不确定。

5. **`\kf` 是逐字染色本体**，扫色确实从左往右推进；但两个颜色明度太接近时肉眼分不出来（尤其压在亮背景上），未唱色必须够深。

6. **ASS 时间戳必须写成 `0:00:03.10`**，写成 `3.10` 会被 libass **静默丢弃整条事件**（不报错，只是不显示）。

7. **ffmpeg 截帧时 `-ss` 放 `-i` 前**会导致字幕时间轴错位、画面空白。

8. **`-ss` 放在 `-i` 前面会把 pts 重置为 0**，截到的其实是「第 0 秒」那一帧，此时字幕还没开始，会误以为渲染失败。截帧预览用输出端 seek（`-i` 之后）。

9. **Windows 路径里的 `C:` 冒号会被 ffmpeg 当参数分隔符。** 用 `cwd=临时目录` + 相对文件名绕开。手写命令时路径含中文/冒号容易踩。

10. **逐字节奏是按字数均分的估算**（LRC 只有行级时间）。快段会差半拍。真逐字数据在 MFA 的 `words` 层。

## 双系数缩放模型

一切字幕坐标问题的根源。

```python
W, H = 1080, 1920
SCALE = 1.0      # 位置缩放（按画布高度）
FSCALE = 1.0     # 字号缩放（按高度 + 宽度）

_FONT_KEYS = ("size", "spacing", "border", "shadow",
              "glow_blur", "glow_border", "max_size", "drop_px")
_POS_KEYS = ("y", "margin")


def set_canvas(w, h):
    global W, H, SCALE, FSCALE
    W, H = int(w), int(h)
    SCALE = H / 1920.0
    FSCALE = max(SCALE, (W / 1080.0) * 0.52)
    return W, H, SCALE


def scaled(cfg):
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
```

实测值：

| 画布 | SCALE | FSCALE |
|---|---|---|
| 1080x1920（竖屏） | 1.0 | 1.0 |
| 1920x1080（横屏） | 0.5625 | 0.92444 |

字号除高度外还参考宽度，否则横屏上字会瘦得像小字报（竖屏 70px 占宽 6.5%，横屏若只按高度缩放只剩 2%）。

### 为什么横屏 y=948 会跑到画面中央

配置里的 `y` 是 **1080x1920 基准值**，不是目标画布像素值。

目标：横屏 1920x1080 上字幕中心离画面底 132px，即 y = 1080 − 132 = **948 实际像素**。

换算：`scaled()` 会把 y 乘一次 SCALE（横屏 0.5625），所以配置值要写 `948 / 0.5625 = 1685`，渲染时再乘回 0.5625 → 947.8 → **947**，位置正确。

若直接传 y=948：`948 × 0.5625 = 533` → **画面正中央**。

`subs_build.py` 里的做法就是：配置写基准值，脚本内部换算。

## 三档色调

字幕颜色跟**画面亮度**走，不跟歌词段落走。

| 档 | 场景 | sung | unsung | outline | border | shadow |
|---|---|---|---|---|---|---|
| `ink` | 亮场（米白墙、黄昏天空） | `&H001E1A18` 墨色 | `&H0092969C` | `&H96FFFFFF` 柔白 | 2.0 | 1 |
| `light` | 暗场（雨夜、逆光） | `&H00DCE7ED` 米白 | `&H00909A96` 灰蓝 | `&H90000000` 深 | 2.2 | 3 |
| `pale` | 极亮淡彩 | `&H001E1A18` 墨色 | `&H00504A44` | `&HFF000000`（去描边） | 0.6 | 1 |

**暗场为什么不用墨字**：墨色在雨夜里只剩一团白晕，改米白字 + 深描边。

**极亮底为什么去描边**：白描边在近白底上不但没用，还会啃掉细笔画。**放大取像素看，会像空心字。** 只留一点投影，让墨字自己说话。

**不要只靠缩略图判断字形是否空心**——缩略图已经造成过两次误判。必须放大到像素级看。

## 整句淡入 vs 逐字扫色

```python
if cfg.get("plain"):
    pos = "\\pos(%.1f,%d)" % (W / 2.0, cfg["y"])
    ev.append("Dialogue: 3,%s,%s,K,,0,0,0,,{%s%s\\1c%s}%s"
              % (a, b, pos, cfg["intro"], cfg["sung"], text))
```

**默认用 plain（整句淡入）。**

逐字扫色（`\kf`）会让「还没唱到」的字停在浅灰（unsung 色），压在灰路面、灰沙发这类中间调背景上几乎看不见。叙事型 MV 尤其致命。

扫色适合：卡拉OK 式跟唱、明显的音乐教学。歌词 MV 用 plain。

`plain` 模式必须显式写 `\1c{sung}`，因为 `\1c` 是累积标签，不写就继承 Style 的 Primary。

## 时长与重叠

```python
nxt = lines[i + 1][0] if i + 1 < n else st + 7.0
est = len(text) / cfg["speed"]
dur = min(est * 1.10, max(nxt - st - 0.10, est * 0.55))
if dur < 0.8:
    dur = min(est, max(nxt - st, 0.8))

show_end = min(nxt + 0.12, st + dur + 1.6)
if i + 1 >= n:
    show_end = st + dur + 2.2
```

- `speed` 是每 style 的字/秒，`ink` = 3.2
- 非末行：`show_end = min(下一句起点 + 0.12, 本句起点 + dur + 1.6)`，自带 0.12s 交叉淡入
- 末行：`show_end = st + dur + 2.2`

### 重叠的成因与修复

**成因**：末行的 +2.2s 尾巴本意是给全曲最后一句做长淡出。**分段生成时，每段的最后一行都吃到了这个尾巴。**

真实案例：`fG1~fG4` 是四个独立单句段，于是每句都被加了 2.2s：
- 「如果哪天你路过」179.37 + 2.41 + 2.2 = 183.98
- 「就当没听见」181.89 就开始了
- **重叠 2.09s**，即 3:03 处的双行同屏

**修复算法**：

```python
order = sorted(range(len(events)), key=lambda i: _sec(events[i].split(",", 9)[1]))
for k in range(len(order) - 1):
    i, j = order[k], order[k + 1]
    fi = events[i].split(",", 9)
    nxt = _sec(events[j].split(",", 9)[1])
    if _sec(fi[2]) > nxt + 0.13:
        fi[2] = ts(nxt + 0.12)
        events[i] = ",".join(fi)
```

按 Start 排序 → 相邻对 → 若 `end > next_start + 0.13` 则把 end 收到 `next_start + 0.12`（0.12 是本来就有的交叉淡入宽度，保留）。

**所有版本都要跑这个算法**，包括派生版本（换池、分段、竖屏重调）。实测发现 90 秒版及其派生曾漏掉这段逻辑，残留 0.24s 重叠。

## 多段合并

`karaoke.py` 写死的 Style 名是 `K` / `G`，多段合并必然互相覆盖。

```python
for i, p in enumerate(parts):
    st, ev = read_sections(p)
    for s in st:
        head, body = s.split(",", 1)
        nm = head.split(":", 1)[1].strip()
        all_styles.append("Style: %s%d,%s" % (nm, i, body))
    for s in ev:
        f = s.split(",", 9)
        f[3] = f[3] + str(i)          # Style 字段加序号，防同名覆盖
        all_events.append(",".join(f))
```

**Style 名和 Dialogue 第 4 字段必须同步改。**

## 末句定位不能用文本匹配

`\kf` 是逐字包裹的（`{\kf34}就{\kf34}当…`），`"就当没听见" in text` 永远为 False。要按 Start 时间匹配。

## 字号要按最长句算

配合 `WrapStyle: 2`（**不做自动换行**，只认 `\N`），长句会直接溢出画面边界。

例：104 号 × 11 字 = 1144 > 1080，右边直接被裁。长句段压到 92（11 字占 94% 宽）刚好。

**字号还要跟镜头景别走，不能按歌词段落一刀切。** 特写镜头（楼梯低头）上压大字会毁情绪；留白多的大镜头才有资格上大字。

## 巨字（开场标题）

字体试过 6 种，最终选 **霞鹜文楷（LXGW WenKai Mono，OFL 可商用）**——手写楷，撇捺带锋，比宋体有体温，比黑体不廉价。

- SimSun / SimHei 属中易字体，**商用授权有争议**，必须换
- Noto Serif SC Black 够厚但印刷感强，不是这首歌的情绪
- 楷体 Regular 笔画偏细 → 用**同色描边 3.5px** 补厚度（不同色描边会变贴纸字）
- 描边 2.5 偏细、4.5 把楷书笔锋撑圆、人工 bold 退化成黑体，**3.5 是唯一一档笔锋完整又够重**

颜色试过 7 种，选 **藏青 #22344A**：冷、有距离、像夜里的调音台。ASS 里写 BGR 倒序 `&H004A3422`。

**正文与巨字要分层**：正文墨色 `#1E1A18`，巨字藏青——读的字和喊的字不是同一层。

巨字每行字数随画幅自适应：竖屏 4-5 字一行，横屏一行能放更多（`per_line = max(per_line, 8 if W/H < 2.0 else 10)`），否则三行会把 1080 高撑满。

## 烧制命令

```bash
# 用 cwd + 相对文件名绕开 C: 冒号
ffmpeg -y -v error -i 成片.mp4 -vf "eq=brightness=-0.0700:saturation=1.140,ass=filename=sub.ass" \
  -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart 输出.mp4
```

`ass` 滤镜支持 `filename` / `original_size` / `fontsdir` / `alpha` / `shaping`，本项目一个都不传，全走默认。

**视频分辨率必须与 ASS 的 PlayRes 一致**，否则字幕整体缩放。

## 字体可用性速查

| 字体 | 位置 | libass |
|---|---|---|
| `Noto Sans SC` | `C:/Windows/Fonts/NotoSansSC-VF.ttf` | 可用，**可变字体 → 极细 Thin，加粗无效** |
| `Microsoft YaHei` | `C:/Windows/Fonts/msyh.ttc` | 可用，要粗体用这个 |
| `Source Han Sans SC` | 系统 | 可用，要粗体用这个 |
| `LXGW WenKai Mono` | 用户级安装目录 | 可用，OFL 可商用 |
| `Tiejili SC` | 用户级 + 项目 fonts 目录 | 可用，唯一带 TrueType hinting |
| `Ma Shan Zheng` / `ZhiMangXing` | 项目 fonts 目录 | **libass 读不到** → 走矢量线 |

项目 `fonts/` 目录不是给 ffmpeg/libass 用的（没有 `fontsdir` 参数）。它被 `brush.py` 用 fontTools 读取，把字形轮廓抽成 ASS 矢量绘图。

## 其他约束

- **亮画面别用 `ink`**。深墨色细字压在浅色画面上几乎看不见，只在白墙/浅木这类干净背景上成立。
- **`mirror` 只在暗背景成立**。倒影压在浅色画面上等于没有。
- 逐字精度：现在按字数均分，快段差半拍。真数据在 MFA 的 `words` 层。
- 关键词语义是给具体某首歌写死的，换歌要改。
