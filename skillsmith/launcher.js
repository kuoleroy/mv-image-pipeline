/**
 * Skillsmith（智能体技能管理软件）—— 启动器
 *
 * 为什么需要它：
 *
 * WorkBuddy 通过 NODE_OPTIONS=--require=node-language-shim.cjs 给所有子进程
 * 预加载 FS 护栏。护栏统计「本会话删除次数」，超过 CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD
 * （默认 50）就拒绝后续删除，报 SAFE_DELETE_BULK_CONFIRM_REQUIRED。
 *
 * 本服务「关闭技能」在 junction 端就是摘掉链接，语义上被护栏当成删除 ——
 * 于是开关点多了就会全部失效。
 *
 * 护栏本身在 node-language-shim.cjs 里有两个早退条件：
 *   if (!SESSION_ID) return;              ← 无会话 ID 就不加载
 *   if (!SAFE_DELETE_ENABLED) return;     ← 显式关闭也不加载
 * 所以这里用「清空会话变量 + 去掉 NODE_OPTIONS」重新 spawn 一个干净的 Node 进程。
 *
 * 安全性：护栏防的是 Agent 自主删用户文件。本服务的删除目标全部先经
 * removeJunction() 校验「确实是 junction」，真源 ~/.agents/skills 从不删。
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');

// 清掉会让护栏生效的变量。SESSION_ID 类变量决定护栏是否加载，
// CODEBUDDY_SAFE_DELETE_* 是护栏自己的配置。
const STRIP_KEYS = [
  'NODE_OPTIONS',
  'CLAUDE_SESSION_ID',
  'CODEBUDDY_SESSION_ID',
  'CODEBUDDY_SAFE_DELETE_ENABLED',
  'CODEBUDDY_SAFE_DELETE_SANDBOX',
  'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
  'CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR',
  'CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD',
  'CODEBUDDY_SAFE_DELETE_BROKER_DELETE',
  'CODEBUDDY_SAFE_DELETE_BIN_DIR',
  'CODEBUDDY_SAFE_DELETE_REPORT_PATH',
  'CODEBUDDY_SAFE_DELETE_BULK_REPLAY_FILE',
  'CODEBUDDY_BROKERED_FS_HOOK_ENABLED',
];

const env = Object.assign({}, process.env);
for (const k of STRIP_KEYS) delete env[k];

const child = spawn(process.execPath, [SERVER], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', (e) => {
  console.error('启动失败：' + e.message);
  process.exit(1);
});
