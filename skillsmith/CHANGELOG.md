# 更新日志

Skillsmith 的版本记录。Release 正文默认取这里对应版本的段落。

## 未发布

**Skillsmith v1.0.1 — 智能体管理增强 + 不支持客户端保护**

- 智能体管理：每行可改开关机制（junction / realdir）与状态清单位置
  （路径 / 格式 / 字段名），客户端装在非默认位置时不用删了再加
- 修：清空状态清单会被内置默认值覆盖；启停按钮会丢掉自定义的状态清单位置
- 保护：TeleAgent 明确不支持接入 —— 保存时拒绝，且即便手工改配置也不会进生效映射，
  开关 / 批量 / 重新绑定一律不碰它

## v1.0.0

**Skillsmith v1.0.0 — 智能体技能管理软件**

跨 AI 客户端的共享技能开关工具。桌面版（Electron）+ 浏览器版共用同一套后端。

### 功能

- 10 个 Agent 端开关联动：WorkBuddy / WorkBuddy 国际版 / Claude Code /
  CodeBuddy / Codex(旧) / OpenCode / Trae CN / Trae 国际版 / 华为 CodeArts / 阿里 Qoder
- 批量开关：全部关闭 / 精简模式 / 全部开启
  （普通对话关掉 skills，用时再开 —— 能省下约 70% 的技能描述 token）
- 智能体管理：新增 / 删除 / 重命名 / 启停任意厂商的端
- 共享技能真源地址可配，改址后可「重新绑定」把各端链接重新指向新位置
- 路径面包屑 + 应用菜单（设置 / 窗口 / 帮助 / 关于）

### 安全

- 真源 `~/.agents/skills` 永远只读，永不删除
- 摘链接前校验确实是 junction，避免顺着链接误删真源
- 写操作跨进程加锁，多实例同时运行不会互相覆盖

### 技术

- 前端复用开源 [whale2002/skills-switch](https://github.com/whale2002/skills-switch)（MIT）
  的 React 产物，逻辑零改动
- 自研后端适配各端的加载差异（Junction / 真实目录副本 / 状态文件清单）
- 打包版由 GitHub Actions 自动构建，仓库只放源码
