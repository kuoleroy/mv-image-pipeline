<p align="center">
  <img src="https://img.shields.io/npm/v/skills-switch" alt="npm version">
  <img src="https://img.shields.io/npm/l/skills-switch" alt="license">
</p>

# Skills Switch

> Enable, disable, or delete AI agent skills — across all your agents, from one panel.
>
> 启用、禁用、删除 AI agent 的 skill —— 一个面板，覆盖所有 agent。

[English](README.md)

**Skills Switch** 是一个轻量级的命令行工具，为所有 AI agent 的 skill 提供一个可视化的控制面板。它不做安装、不连任何市场——只扫描你本机已有的 skill，让你在浏览器里一键启用、禁用或删除，覆盖 16 个主流 agent。

### 为什么做这个

市面上有大量 "skill manager" 帮你在市场里搜索和安装新 skill。但没人管你装了 30 个 skill 之后的事——agent 上下文越来越臃肿、prompt 越来越慢，你却没有一个方便的办法暂时关掉几个。

**Skills Switch 就是那个开关。** 当你想着"Jira 集成暂时用不上，先关了吧"——这件事应该是一键完成，而不是打开终端敲命令。

## 功能

- **开关控制** — 一键启用/禁用任意 skill（通过给目录加 `.disabled` 后缀实现）
- **安全删除** — 从单个 agent 删除 skill，或一键清理所有 agent 中的同名 skill
- **16 个 agent** — 支持 Claude Code、Cursor、Codex、Copilot、Windsurf、Gemini CLI、Cline 等主流 agent
- **全局 + 项目双视图** — 同时管理全局安装的 skill 和项目级别的 skill
- **"全部"视图** — 一目了然地看到每个 skill 安装在哪些 agent 中
- **零配置** — `npx skills-switch` 启动，浏览器自动打开，直接开始操作

## 快速开始

```bash
npx skills-switch
```

本地服务器启动后会自动在浏览器打开面板。点击开关，完事。

如果想全局安装：

```bash
npm install -g skills-switch
skills-switch
```

## 使用说明

面板分为三个区域：

| 区域 | 说明 |
|------|------|
| **左侧边栏** | 在「全局」skill 和各项目之间切换。点击「添加项目」可以把任意目录加入列表。 |
| **顶部标签** | 按 agent 筛选 skill。「全部」显示所有 agent 的 skill，并标注每个 skill 安装在哪些 agent 中。 |
| **Skill 卡片** | 每张卡片显示 skill 名称、描述和开关。垃圾桶图标用于删除（有二次确认）。 |

### "启用"是什么意思

Skills Switch 采用一个简单的约定：目录名为 `my-skill` 表示**已启用**，`my-skill.disabled` 表示**已禁用**。大多数 agent 都遵循这个命名约定，所以在这里切换开关后，下次使用 agent 时就会立即生效。

## 支持的 Agent

| Agent | 全局 skill 目录 |
|-------|----------------|
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.agents/skills/` |
| Cursor | `~/.agents/skills/` |
| Gemini CLI | `~/.agents/skills/` |
| GitHub Copilot | `~/.agents/skills/` |
| Cline | `~/.agents/skills/` |
| OpenCode | `~/.agents/skills/` |
| Kimi Code CLI | `~/.agents/skills/` |
| Warp | `~/.agents/skills/` |
| Windsurf | `~/.codeium/windsurf/skills/` |
| Goose | `~/.config/goose/skills/` |
| Continue | `~/.continue/skills/` |
| Roo Code | `~/.roo/skills/` |
| Trae | `~/.trae/skills/` |
| Trae CN | `~/.trae-cn/skills/` |
| Qwen Code | `~/.qwen/skills/` |

> **关于 `~/.agents/skills/`**：这是多个 agent 共享的规范目录（canonical directory）。官方的 [Anthropic skills CLI](https://github.com/anthropics/skills) 将 skill 安装到这个目录，使所有兼容的 agent 都能直接使用。Skills Switch 会为每个使用该目录的 agent 扫描它——如果一个 skill 在这里，它会自动出现在 Codex、Cursor、Copilot 等所有通用 agent 的下方。

## 工作原理

Skills Switch 是一个纯本地的 Web 应用——所有数据都在你的机器上。

```
npx skills-switch
  → 在 localhost 启动 Express 服务器
  → 扫描磁盘上的 skill 目录
  → 在浏览器打开控制面板
```

- **扫描**：读取每个 agent skill 目录下的 `SKILL.md` 文件来构建 skill 列表
- **切换**：重命名目录——`my-skill` ↔ `my-skill.disabled`
- **删除**：用 `fs.rmSync` 删除目录。开启「彻底删除」模式会同时清理所有 agent 中的同名 skill 和残余符号链接
- **添加项目**：仅在当前会话中生效（重启后重置）。项目级别的 skill 存放在 `<项目>/.agents/skills/` 和 `<项目>/<agent>/skills/`

## 如何新增 Agent

Agent 定义在 [`src/agents.ts`](src/agents.ts) 中。每个条目需要以下字段：

```ts
{
  id: "agent-id",           // 内部标识符
  displayName: "Agent 名称",  // 界面显示的名称
  globalSkillsDirs: [       // 全局 skill 目录列表（支持多个）
    path.join(HOME, ".agent", "skills")
  ],
  homeDirMarker: path.join(HOME, ".agent"),  // 用于检测 agent 是否已安装
}
```

要找到某个 agent 正确的 skill 目录，请参考官方的 [Anthropics skills](https://github.com/anthropics/skills) 仓库——具体看 [`src/agents.ts`](https://github.com/anthropics/skills/blob/main/src/agents.ts) 文件。它定义了 50+ 个 agent 的 `skillsDir`（项目级别）和 `globalSkillsDir`（全局级别），是最权威的参考。

新增 agent 时需要留意：

1. **通用型 vs. 独立型**：如果 agent 的 `skillsDir` 是 `.agents/skills`，说明它是通用型 agent，应该把 `~/.agents/skills/` 放在 `globalSkillsDirs` 数组的第一位。这是多个 agent 共享的规范目录。
2. **检测方式**：`homeDirMarker` 应指向一个只有该 agent 安装后才存在的目录。
3. **优先级**：规范/共享目录放在数组前面，agent 专属目录放在后面。扫描器按名称去重，保留第一个匹配项。

## 开发

```bash
git clone https://github.com/user/skills-switch.git
cd skills-switch
npm install
cd web && npm install && cd ..

# 终端 1：启动后端开发服务器
npm run dev

# 终端 2：启动前端开发服务器（支持热更新）
npm run dev:web

# 构建生产版本
npm run build
```

- **后端**：Node.js + Express + TypeScript（`src/`）
- **前端**：React + Vite + TypeScript + Tailwind CSS（`web/`）
- **设计**：采用 Claude.com 设计语言——Cormorant Garamond 衬线标题、Inter 无衬线正文、暖色奶油底色、珊瑚色点缀

## License

MIT
