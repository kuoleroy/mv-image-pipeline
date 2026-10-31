# 提示词工程

## 失败模式只有一个

**场景描述不够「有动作 / 有空间关系」时，模型会退回正面站立全身。**

修法不是加形容词，而是给出 **强动作 + 前景遮挡 + 物理反应**。

## 风格锚点

二次元（BASE，横竖屏共用）：

```
Japanese anime film still, hand-drawn cel shading, 90s anime aesthetic,
cinematic composition, soft film grain, atmospheric haze,
muted desaturated color palette, environment stays readable
```

竖屏追加（紧贴 scene 之后）：

```
vertical 9:16 composition, tall narrow framing, strong vertical lines
```

写实：

```
35mm film photography, japanese indie film aesthetic, natural window light,
pale cream walls, muted low-saturation tones, fine film grain,
shallow depth of field
```

六档色调：

```
dusk:  warm dusk light, pale orange and grey-blue palette
rain:  cold rainy night, sodium and cyan light, wet reflections
pale:  washed-out watercolor light, near monochrome pale grey and cream, soft edges, dreamlike, slightly translucent
dawn:  pale blue dawn light, almost no color, very quiet
room:  dim interior light, warm dust in the air, low key
dark:  deep night, single hard light source, most of the frame in shadow but shapes still readable
```

## 负面词

二次元：

```
photorealistic, 3d render, cgi, chibi, moe, big sparkling eyes, blush,
bright saturated colors, glossy, text, watermark, signature, lettering,
signage text, chinese characters, kanji, japanese characters,
readable signs, posters with text, subtitles,
extra fingers, deformed hands, oversaturated, plastic skin, low quality,
blurry, extra limbs, monochrome black void background, pure black frame
```

写实：

```
anime, illustration, drawing, painting, 3d render, cgi, text, watermark,
signature, lettering, extra fingers, deformed hands, oversaturated,
plastic skin, low quality, blurry, extra limbs, makeup, glamour,
studio lighting, posed
```

竖屏额外加三项（压掉横构图）：

```
landscape orientation, wide horizontal composition, letterboxing
```

## 人物三档

```
full: a slim young woman with short black bob hair, wearing an oversized white linen shirt and grey trousers, pale tired face, no makeup
face: the pale tired face of a young woman with short black bob hair, no makeup, slightly chapped lips
hand: a pale hand with short clean nails
back: a slim young woman with short black bob hair seen from behind, oversized white linen shirt, grey trousers
```

**特写绝不能用 full**，服装描述会把画面拽回中景。

## 组装顺序

横屏：`scene → [人物] → [收尾句] → 风格锚点`
竖屏：`scene → 竖屏锚点 → [人物] → [收尾句] → 风格锚点`

## 失败改写对照（真实案例）

### 动作缺失 → 正面站立

| 原 | 改后 |
|---|---|
| 站在路中央 | `she kneels down in the flooded street, both palms pressed flat into the water, the reflection breaking apart around her hands, rain coming down hard` |
| 站着不动 | `wide shot from a very low angle just above the water, she walks toward the camera through ankle deep water, her reflection torn apart beneath her, neon light smeared high above` |
| 走出黑暗 | `medium shot, she walks straight at the camera and is only half out of the darkness, the rim light catching one side of her face, jaw and shoulder, the rest of her still black` |

收尾句（插在人物之后、风格锚点之前）：
`kneeling, low camera` / `walking toward camera` / `seen through glass` / `bird's eye` / `strong physical reaction` / `half in shadow` / `she leans over the lens`

### 空间关系缺失 → 构图扁平

| 原 | 改后 |
|---|---|
| 俯拍 | `high angle shot from a fire escape directly overhead, she stands in the narrow alley below, the wet ground filling most of the frame, only the top of her head and shoulders visible` |
| 从地板仰视 | `extreme low angle from the floorboards, she leans over the camera looking straight down, her hair falling toward the lens, one hand braced flat on the floor beside the camera, hard top light` |

### 抽象 → 具体

抽象描述模型只能给个大概，必须落到具体可见的物件与动作。

| 抽象 | 具体 |
|---|---|
| 鸟瞰一个人 | 换**蹲姿**（蹲姿比站姿更容易做出来）+ 单灯逆光 + 影子朝镜头：`she crouches low at the mouth of the alley, backlit by one street light behind her, the alley walls closing in on both sides, rain falling through the beam, her shadow thrown toward the camera` |
| 床单有凹陷 | `a white bedsheet with deep creases and a long hollow pressed into it, one corner dragged off the mattress, an empty pillow beside it` |
| 脸被裂缝劈开 | `her face divided by a crack running down the mirror, one eye on each side of the break, the two halves slightly misaligned` |
| 空气扭曲 | `she is thrown back against the wall as the air bursts outward, her hair and shirt blown hard to one side, the curtains ripped toward the window, loose papers in the air` |

### 手部崩坏 → 降低手部风险

| 原 | 改后 |
|---|---|
| 手握麦克风 | `close shot of a microphone on a stand, the grille dented and torn, one cable hanging loose and swinging, a single hard light from above, dust in the beam, no people, no hand` |
| 撕纸 | `close shot of a sheet of paper caught mid-tear, the two halves separating, hands only at the very edges of the frame, hard side light, dark background` |

**把手挪到画面边缘，或干脆改成无人道具**，叙事等价但崩坏率大降。

### 隔玻璃拍摄

```
close shot from the other side of a wet window, a palm pressed flat against the glass,
rain running down the outside over the hand, her blurred face visible behind the glass
```

## 竖屏构图语法

16:9 裁成 9:16 要切掉约 68% 的宽度，天台远景会变成一根柱子，窗框构图只剩窗棂。**竖屏必须按竖屏语法重新写，不能裁横屏图。**

| 横屏 16:9 | 竖屏 9:16 |
|---|---|
| `extreme wide shot, vast empty sky filling two thirds of the frame` | `extreme wide vertical shot looking straight up between two tall buildings` |
| `wide shot down an empty street` | `vertical shot down a very narrow alley, walls close on both sides` |
| `low angle shot from the ground looking up` | `low angle full body shot, she stands in the rain looking up at the sky` |
| `high angle shot looking down into a concrete underpass` | `high angle shot looking straight down at one open umbrella on wet asphalt` |
| `close shot of the city seen through a window` | `vertical shot of rain streaming down a tall window pane` |

常用短语：`vertical shot` / `vertical framing` / `vertical composition` / `looking straight up` / `looking straight down` / `receding` / `deep perspective` / `vanishing point high in the frame`

## 通用纪律

1. **每条以「景别 + 角度」开头，结尾再收一次**，避免模型漂回正面中景。
2. **写意象，不写情绪。** `孤独的房间` 出不来图；`一张床，只有一侧有褶皱，另一侧平整得像没人睡过` 能出来。情绪是观众自己产生的，画面只提供事实。
3. **空镜一律不塞人物描述。**
4. **负面词强压文字/招牌字**，模型很爱生成汉字招牌。
5. **审图后重做要留底**（`.bak` / `.v2` 后缀），新的失败可回滚。
6. **审图拼贴**：`python scripts/mv_qc.py sheet 机位库 审图.jpg`，每页 36 张，快速过一遍。
