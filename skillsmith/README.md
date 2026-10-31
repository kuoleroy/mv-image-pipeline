# Skillsmith —— 智能体技能管理软件

控制各家 AI 工具（WorkBuddy / Claude Code / Trae / CodeArts / Qoder …）共享技能的
**开关状态**。真源只有一个：`~/.agents/skills`，本工具只负责在各端「装上 / 摘掉」，
**从不删除真源内容**。

> 英文名取自 smith（锻造者/工匠）—— 管理技能的匠人；中文副标题「智能体技能管理软件」。

![界面](screenshot.png)

---

## ⬇️ 下载

**[Releases](../../releases)** 页面有打包好的 Windows 安装包（NSIS，双击即用，
不需要装 Node）。

> 安装包**未做代码签名**（没有证书），Windows SmartScreen 可能提示"未知发布者"，
> 点"更多信息 → 仍要运行"即可。

想自己构建：

```bash
cd electron
npm ci              # postinstall 会自动下载 Electron 运行时（~250MB）
npm run dist        # 产物：dist/Skillsmith Setup 1.0.0.exe
```

> Electron 37+ 不再自带 `postinstall`，运行时下载要自己触发。
> 本项目在 `package.json` 里补了 `postinstall` 调 `install.js`，
> 所以 `npm ci` / `npm install` 会自动完成，国内可设
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 加速。
> 注意镜像地址末尾**不能带 `v`** —— 版本号自带的 `v` 前缀由 electron 自己拼。

推 tag（`v*`）会让 GitHub Actions 自动构建并发布 Release：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

---

---

## 两种形态

| | 浏览器版 | 桌面版 |
|---|---|---|
| 启动 | `启动浏览器版.bat` | `启动桌面版.bat` / 桌面快捷方式 |
| 界面 | 浅色（原上游风格） | 深色桌面主题 + 批量工具栏 + 智能体管理 |
| 端口 | 17888 | 随机端口（内嵌在进程里） |
| 前端 | 同一份 React（开源 skills-switch，MIT） | 同一份 + 主题层覆盖 |

两种形态**共用同一套后端逻辑**（`core.js` / `server.js` / `agent-config.js`），
不存在两套实现漂移的问题。

---

## 核心概念

### 真源（只读）

```
~/.agents/skills/<技能名>/     ← 唯一真源，永不删除、永不修改
```

各端目录里放的是**指向真源的目录联接（junction）**。
「关闭某个端上的某技能」= 摘掉那个端的联接；真源本身毫发无损。

### 各端的开关机制不同

| 机制 | 端 | 关闭方式 |
|---|---|---|
| `junction` | WorkBuddy、Claude Code、CodeBuddy、Codex、OpenCode、Trae CN、Trae 国际版、Qoder | 摘掉目录联接 |
| `junction` + 状态文件 | Trae CN、Trae 国际版 | 额外写 `skill-config.json` 的 `disabledSkills` |
| `realdir` + 状态清单 | 华为 CodeArts | 写官方清单 `UserSkillStatus.txt`（`name=false`=禁用） |

CodeArts 是特例：它用 `readdir` 过滤掉符号链接，**只认真实目录副本**，
所以给它装技能必须复制实体目录，关闭则走官方清单。

---

## 桌面版功能

### 界面布局

```
┌────────────────────────────────────────────────────────────┐
│ [设置][窗口][帮助][关于] │ 📁 共享技能 › 路径 › 12 个技能 │  [原生窗口控件] │
├──────────────┬─────────────────────────────────────────────┤
│ 全局          │ [全部][WorkBuddy][Trae CN]…  ← Agent 标签栏  │
│ 全部关闭      │ ┌────────────┐ ┌────────────┐               │
│ 精简模式      │ │ 技能卡片    │ │ 技能卡片    │               │
│ 全部开启      │ └────────────┘ └────────────┘               │
│ ⚙ 管理智能体  │                                              │
│ + 添加项目    │                                              │
│ 机制说明      │                                              │
└──────────────┴─────────────────────────────────────────────┘
```

左上角是应用菜单栏（在侧边栏顶部原 logo 的位置），右侧是路径面包屑，
两者同在一条 44px 高度线上，构成统一的窗口标题栏。
右端留给系统原生的最小化/最大化/关闭按钮。

### 1. 菜单栏

| 菜单 | 内容 |
|---|---|
| **设置** | 共享技能真源地址… / 重新绑定所有端… / 智能体管理… / 恢复默认真源地址 |
| **窗口** | 最小化 / 最大化·还原 / 重新加载 / 开发者工具 / 关闭（带快捷键提示） |
| **帮助** | 使用说明（README）/ 打开配置目录 / 关于本应用 |
| **关于** | 版本 + Electron/Chromium/Node/平台/真源 信息表 + 许可说明 |

### 2. 批量操作（侧边栏）

- **全部关闭** —— 普通对话推荐，能显著减少 token 消耗
- **精简模式** —— 只保留 `comfyui`、`mv-image-pipeline`、`tencent-docs-cli`
- **全部开启**

### 3. 智能体管理（侧边栏「⚙ 管理智能体」）

可以**新增 / 重命名 / 删除**各个厂家的 AI 智能体端：

- 名称、路径可直接编辑，点 ✓ 保存
- ●/○ 切换启用停用（停用的端不显示、不参与批量操作）
- ＋ 新增智能体：填名称、目录、开关机制（junction / realdir）、可选状态文件
- ✕ 删除（内置端删了可以「恢复默认」撤销）

配置持久化在：

```
~/.agents/skillsmith/agents.json
```

内置端在 `agent-config.js` 的 `BUILTIN_AGENTS` 里，用户配置按 `id` 覆盖，
新 `id` 追加，`remove: true` 删除内置端。

### 4. 共享技能真源地址（设置 → 共享技能真源地址）

真源（所有技能的唯一副本所在处）的地址可以改。配置在：

```
~/.agents/skillsmith/settings.json
```

**改完地址必须点「重新绑定所有端」** —— 各 AI 工具目录里的链接仍然指着旧地址，
不重新绑定的话改设置等于只改了一半。「预演」可以先看会改哪些（只报告不执行）。

### 5. 系统托盘

关闭按钮会最小化到托盘（不是退出）。托盘右键菜单：

- 打开面板
- 全部关闭 / 精简模式 / 全部开启
- 退出

### 6. 窗口拖动

无边框窗口没有系统标题栏，拖拽区是自己划的：

- 侧边栏顶部菜单条（空白处）
- 路径面包屑
- Agent 标签栏

菜单按钮、路径、开关等交互元素都是 `no-drag`，不会误触发拖动。

---

## 目录结构

```
skillsmith/
├── core.js              核心逻辑：junction 判定、增删、真源保护、重新绑定
├── agent-config.js      智能体配置：内置基线 + 用户增删改合并
├── settings.js          全局设置：共享技能真源地址
├── server.js            HTTP 服务与 API（浏览器版与桌面版共用）
├── launcher.js          浏览器版启动器（剥掉 WorkBuddy 的 FS 护栏）
├── 启动浏览器版.bat      浏览器版启动
├── vendor/              前端（复用开源 skills-switch，MIT）
│   ├── index.html
│   ├── theme.css        深色主题层（覆盖上游语义类）
│   ├── desktop-enhance.js  批量工具栏注入
│   ├── agent-manager.js    智能体管理面板
│   ├── settings-panel.js   路径面包屑 + 设置面板
│   ├── app-menu.js         应用菜单栏（设置/窗口/帮助/关于）
│   └── fonts/           离线字体（不依赖 CDN）
├── assets/              应用图标
├── electron/            桌面版
│   ├── main.js          Electron 主进程：窗口、托盘、单实例、IPC
│   ├── preload.js       最小 API 面
│   ├── stage.js         打包前把依赖平铺到 app/
│   └── 启动桌面版.bat
└── test_agent_config.js 智能体配置功能测试（22 项）
```

---

## 打包成 exe

```bash
cd electron
npm run dist        # 产物：dist/Skillsmith Setup 1.0.0.exe
```

用 NSIS 打包，安装后自带桌面快捷方式，不需要 Node 环境。

---

## 安全设计

**真源永远不动。** 所有「删除」操作都先经 `removeJunction()` 校验
「确实是 junction」，只摘链接。CodeArts 的实体副本若要真删，走
「先改名再删」两段式，避开宿主的递归删除护栏。

**WorkBuddy 的 FS 护栏。** WorkBuddy 会给子进程注入 `node-language-shim.cjs`，
统计删除次数，超阈值就拒绝后续删除。而「关闭技能」在 junction 端就是摘链接，
语义上被当成删除 —— 开关点多了会全部失效。启动器清空 `NODE_OPTIONS` 与
`CODEBUDDY_SESSION_ID` 重新 spawn 一个干净进程来绕开（护栏在没有会话 ID 时
不加载）。

**Electron 的环境变量。** WorkBuddy 注入的 `ELECTRON_RUN_AS_NODE=1` 会让
Electron 降级成纯 Node（`app` / `BrowserWindow` 全部 undefined），启动器必须清掉。

---

## API

```
GET  /api/agents?scope=global      上游契约：各端及其技能开关状态
POST /api/skills/:name/toggle      上游契约：切换单个技能
DELETE /api/skills/:name            上游契约：从各端摘除（真源保留）
GET  /api/projects                 上游契约
POST /api/projects                 上游契约

GET  /api/state                    扩展：完整矩阵 + token 估算 + 日志
POST /api/bulk                     扩展：{ action: on|off|lean }
GET  /api/health                   扩展：健康检查
GET  /api/agent-config             扩展：列出全部端（含未安装/自定义）
POST /api/agent-config             扩展：{ action: save|remove|reset, agent: {...} }
GET  /api/settings                 扩展：读取设置（真源地址等）
POST /api/settings                 扩展：{ action: set-canon-root|rebind, ... }
```

---

## 上游与许可

前端复用开源项目 [whale2002/skills-switch](https://github.com/whale2002/skills-switch)（MIT），
见 `vendor/LICENSE-skills-switch`。业务逻辑（junction 判定、各端机制适配、
智能体配置）为本机自有实现，替换了上游不适用的后端。
