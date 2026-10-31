/**
 * Skillsmith（智能体技能管理软件）—— 桌面版主进程
 *
 * ─────────────────────────────────────────────────────────────
 *  设计原则：
 *  1. 不重写业务逻辑。开关真源、junction 判定、CodeArts/Trae 状态文件
 *     全部复用上级目录的 core.js / server.js —— 桌面版与浏览器版
 *     跑的是同一套代码，避免两套实现漂移。
 *
 *  2. 前端仍然加载 vendor/ 里那份开源 skills-switch（MIT）的 React 界面。
 *     本文件只负责「桌面外壳」：窗口、托盘、菜单、单实例、快捷键。
 *
 *  3. 内嵌 HTTP 服务而不是 file://。因为前端要 fetch('/api/...')，
 *     file:// 协议下会被 CORS 拦住。服务随机端口，不与浏览器版冲突。
 *
 *  4. 安全：nodeIntegration=false + contextIsolation=true + sandbox=true，
 *     渲染进程没有 Node 能力。所有危险操作（摘 junction、写状态文件）
 *     都只在主进程通过 core.js 发生，渲染进程只能通过 IPC 请求。
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  dialog,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────
//  依赖解析
//
//  这套代码要同时在两种形态下跑：
//    开发态：electron/ 目录，core.js / server.js / vendor 在上一级
//    打包态：electron-builder 把文件平铺到 app.asar 里，同级
//  所以不能写死相对路径，逐个候选探测，找到就用。
// ─────────────────────────────────────────────────────────────

function resolveDep(name) {
  const candidates = [
    path.join(__dirname, name),                       // 打包态：同级
    path.join(__dirname, '..', name),                 // 开发态：上一级
    path.join(__dirname, '..', '..', name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`找不到依赖：${name}`);
}

const ROOT = fs.existsSync(path.join(__dirname, 'vendor'))
  ? __dirname
  : path.join(__dirname, '..');   // vendor 在哪，资源根就在哪

const core = require(resolveDep('core.js'));
const { createServer } = require(resolveDep('server.js'));
const agentConfig = require(resolveDep('agent-config.js'));

let mainWindow = null;
let tray = null;
let httpServer = null;
let httpPort = 0;

// 单实例：第二次启动时聚焦已有窗口，而不是再开一个
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ───────────────────────────────────── 窗口

function iconPath() {
  const p = path.join(ROOT, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#14161b',
    title: 'Skillsmith',
    icon: iconPath(),
    autoHideMenuBar: true,
    // 无边框 + 原生窗口控件叠加。
    // 这样标题栏区域可以自己画（拖拽区、批量操作按钮），
    // 而右上角仍然保留系统原生的最小化/最大化/关闭 —— 手感和原生应用一致。
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#14161b',
      symbolColor: '#9aa3b2',
      height: 44,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 外部链接交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    // 关闭时最小化到托盘 —— 这是桌面应用该有的行为，
    // 否则用户误点关闭按钮就再也找不回来了。
    if (!app.isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (httpPort) {
    mainWindow.loadURL(`http://127.0.0.1:${httpPort}/`);
  }
}

// ───────────────────────────────────── 托盘

function buildTray() {
  const img = iconPath() ? nativeImage.createFromPath(iconPath()) : null;
  if (img) img.setTemplateImage(false);
  tray = new Tray(img);
  refreshTrayMenu();
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: () => { mainWindow && (mainWindow.show(), mainWindow.focus()); } },
    { type: 'separator' },
    {
      label: '全部关闭（省 token）',
      click: () => bulk('off'),
    },
    {
      label: '精简模式（只留常用）',
      click: () => bulk('lean'),
    },
    {
      label: '全部开启',
      click: () => bulk('on'),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('Skillsmith — 智能体技能管理软件');
}

function bulk(action) {
  try {
    core.bulk(action, null);
    mainWindow && mainWindow.webContents.send('skills:changed');
  } catch (e) {
    dialog.showErrorBox('操作失败', e.message);
  }
}

// ───────────────────────────────────── IPC（渲染进程只能通过这里请求操作）

ipcMain.handle('skills:state', () => {
  const snap = core.snapshot();
  for (const a of snap.agents) a.tokens = core.estimateTokens(a.name);
  return snap;
});

ipcMain.handle('skills:toggle', (_e, name, agent) => {
  const onlyAgent = !agent || agent === 'all' || agent === 'ALL' ? null : agent;
  const snap = core.snapshot();
  const row = snap.rows.find((r) => r.name === name);
  if (!row) throw new Error(`Skill not found: ${name}`);
  const relevant = onlyAgent
    ? [onlyAgent]
    : Object.keys(core.AGENTS).filter((a) => core.targetsFor(name, a).length > 0);
  const on = relevant.some((a) => row.cells[a] && row.cells[a].on);
  const results = on ? core.disable(name, onlyAgent) : core.enable(name, onlyAgent);
  return { results, state: ipcMain.__state() };
});

ipcMain.handle('skills:bulk', (_e, action, agent) => {
  const onlyAgent = !agent || agent === 'ALL' || agent === 'all' ? null : agent;
  const report = core.bulk(action, onlyAgent);
  return { report, state: ipcMain.__state() };
});

ipcMain.handle('skills:agentConfig', () => {
  return {
    agents: agentConfig.listAgents(),
    configFile: agentConfig.CONFIG_FILE,
  };
});

ipcMain.handle('skills:saveAgent', (_e, data, remove) => {
  const r = agentConfig.saveAgent(data, !!remove);
  return { ...r, agents: agentConfig.listAgents() };
});

ipcMain.handle('skills:resetAgents', () => {
  const r = agentConfig.resetAgents();
  return { ...r, agents: agentConfig.listAgents() };
});

// ───────────────────────────────── 窗口控制（菜单栏用）

ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
  return { ok: true };
});

ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return { ok: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close();
  return { ok: true };
});

ipcMain.handle('window:isMaximized', () => {
  return { maximized: mainWindow ? mainWindow.isMaximized() : false };
});

ipcMain.handle('window:toggleDevTools', () => {
  if (mainWindow) {
    if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools();
    else mainWindow.webContents.toggleDevTools();
  }
  return { ok: true };
});

// ───────────────────────────────── 关于 / 打开路径

ipcMain.handle('app:info', () => {
  const pkgPath = path.join(__dirname, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { /* ignore */ }
  const settingsMod = require(resolveDep('settings.js'));
  return {
    name: 'Skillsmith',
    subtitle: '智能体技能管理软件',
    version: pkg.version || '1.0.0',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    canonRoot: core.canonRoot(),
    defaultCanonRoot: settingsMod.DEFAULT_CANON_ROOT,
    configFile: agentConfig.CONFIG_FILE,
    settingsFile: settingsMod.CONFIG_FILE,
    readme: path.join(ROOT, 'README.md'),
  };
});

ipcMain.handle('app:openPath', (_e, target) => {
  if (!target) return { ok: false };
  const r = shell.openPath(String(target));
  return { ok: !r, error: r || undefined };
});

ipcMain.handle('app:openExternal', (_e, url) => {
  if (!/^https?:\/\//i.test(String(url))) return { ok: false };
  shell.openExternal(String(url));
  return { ok: true };
});

// 内部复用：拿完整快照
ipcMain.__state = () => {
  const snap = core.snapshot();
  for (const a of snap.agents) a.tokens = core.estimateTokens(a.name);
  return snap;
};

// ───────────────────────────────────── 生命周期

app.whenReady().then(async () => {
  app.setAppUserModelId('com.local.skillswitcher');

  // 调试端口：仅在显式开启时打开（开发/验收用）。
  // 用 --remote-debugging-port=9222 启动 Electron 即可，无需改代码。
  if (process.argv.some((a) => a.startsWith('--remote-debugging-port='))) {
    console.log('[debug] remote debugging enabled');
  }

  try {
    const { port } = await new Promise((resolve, reject) => {
      const s = createServer(true);   // desktop=true：注入批量工具栏
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
      httpServer = s;
    });
    httpPort = port;
  } catch (e) {
    dialog.showErrorBox('无法启动本地服务', e.message);
    app.quit();
    return;
  }

  createWindow();
  buildTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 托盘常驻，不退出
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (httpServer) {
    try { httpServer.close(); } catch (_) { /* ignore */ }
  }
});
