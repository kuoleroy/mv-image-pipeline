/**
 * preload —— 暴露最小 API 面给渲染进程
 *
 * 渲染进程 sandbox=true，没有 Node 能力。它只能通过这几条通道
 * 请求宿主做事：读状态、切开关、批量操作。
 *
 * 前端那套 React 界面用的是 fetch('/api/...')，在 Electron 里
 * 页面是从 http://127.0.0.1:随机端口 加载的，所以 fetch 本身就能通。
 * 这个 preload 只是额外提供一条「不经 HTTP」的直接通道，用于托盘
 * 触发的变更广播等场景。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skillsDesktop', {
  isDesktop: true,
  getState: () => ipcRenderer.invoke('skills:state'),
  toggle: (name, agent) => ipcRenderer.invoke('skills:toggle', name, agent),
  bulk: (action, agent) => ipcRenderer.invoke('skills:bulk', action, agent),
  // 智能体（Agent 端）配置管理
  getAgentConfig: () => ipcRenderer.invoke('skills:agentConfig'),
  saveAgent: (agent, remove) => ipcRenderer.invoke('skills:saveAgent', agent, remove),
  resetAgents: () => ipcRenderer.invoke('skills:resetAgents'),
  // 窗口控制（菜单栏用）
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  toggleDevTools: () => ipcRenderer.invoke('window:toggleDevTools'),
  // 关于 / 打开文件
  appInfo: () => ipcRenderer.invoke('app:info'),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  openExternal: (u) => ipcRenderer.invoke('app:openExternal', u),
  onChanged: (cb) => {
    ipcRenderer.on('skills:changed', () => cb());
  },
});
