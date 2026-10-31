/**
 * 智能体（Agent 端）配置管理
 * ============================================================================
 *
 *  为什么要做成可配置的：
 *    各家 AI 工具的 skills 目录不固定 —— 官方版/国际版/测试版路径不同，
 *    第三方工具（如 Trae 国际版 ~/.trae/skills）也各有各的规矩。
 *    写死在代码里意味着每遇到一个新版本就要改代码重新打包。
 *
 *    所以拆成两层：
 *      · 内置（BUILTIN_AGENTS）—— 已知厂商的默认配置，随程序发布
 *      · 用户配置（用户 JSON）  —— 在内置基础上做增/删/改，覆盖优先级更高
 *
 *  配置文件位置：~/.agents/skill-switcher/agents.json
 *    放在 ~/.agents 下是因为这个目录本来就是本工具的地盘，
 *    且 skills 真源就在旁边，语义一致。
 *
 *  配置格式：
 *  {
 *    "version": 1,
 *    "agents": [
 *      {
 *        "id": "trae-intl",              // 稳定标识，重命名不会变
 *        "name": "Trae 国际版",          // 显示名，可改
 *        "dir": "C:\\Users\\xxx\\.trae\\skills",
 *        "mode": "junction",             // junction | realdir
 *        "statusFile": "...",            // 可选：额外状态文件
 *        "statusKind": "json_array",     // 可选：json_array | kv_lines
 *        "statusKey": "disabledSkills",  // 可选：json_array 的字段名
 *        "enabled": true,                // 停用的端不显示、不参与批量操作
 *        "hidden": false                 // 隐藏但保留（临时收起）
 *      }
 *    ]
 *  }
 *
 *  合并规则：
 *    · 用户配置里同 id 的条目 → 覆盖内置同 id 条目（逐字段合并）
 *    · 用户配置里的新 id     → 追加
 *    · 内置条目未出现在用户配置里 → 保留
 *    · 用户条目有 "remove": true → 删除该内置条目
 *  这样用户既能改内置的，也能删内置的，还能加全新的。
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
// 配置目录统一由 settings.js 定义（避免两处各写一份，改名时漏改）
const { CONFIG_DIR } = require('./settings.js');
const CONFIG_FILE = path.join(CONFIG_DIR, 'agents.json');

/** 内置端（随程序发布，用户可覆盖/删除） */
const BUILTIN_AGENTS = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    dir: path.join(HOME, '.workbuddy', 'skills'),
    mode: 'junction',
    note: '跟随链接读取，摘 junction 即关闭',
  },
  {
    id: 'workbuddy-intl',
    name: 'WorkBuddy 国际版',
    dir: path.join(HOME, '.workbuddy-ai', 'skills'),
    mode: 'junction',
    note: '跟随链接读取，摘 junction 即关闭',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    dir: path.join(HOME, '.claude', 'skills'),
    mode: 'junction',
    note: '目录扫描，摘 junction 即关闭',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    dir: path.join(HOME, '.codebuddy', 'skills'),
    mode: 'junction',
    note: '目录扫描，摘 junction 即关闭',
  },
  {
    id: 'codex-old',
    name: 'Codex(旧)',
    dir: path.join(HOME, '.codex', 'skills'),
    mode: 'junction',
    note: '目录扫描，摘 junction 即关闭',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    dir: path.join(HOME, '.config', 'opencode', 'skills'),
    mode: 'junction',
    note: '目录扫描，摘 junction 即关闭',
  },
  {
    id: 'trae-cn',
    name: 'Trae CN',
    dir: path.join(HOME, '.trae-cn', 'skills'),
    mode: 'junction',
    statusFile: path.join(HOME, '.trae-cn', 'skill-config.json'),
    statusKind: 'json_array',
    statusKey: 'disabledSkills',
    note: '摘 junction + skill-config.json 的 disabledSkills 双保险',
  },
  {
    id: 'trae-intl',
    name: 'Trae 国际版',
    dir: path.join(HOME, '.trae', 'skills'),
    mode: 'junction',
    statusFile: path.join(HOME, '.trae', 'skill-config.json'),
    statusKind: 'json_array',
    statusKey: 'disabledSkills',
    note: '与 Trae CN 同机制：junction + skill-config.json 双保险',
  },
  {
    id: 'codearts',
    name: '华为 CodeArts',
    dir: path.join(HOME, '.codeartsdoer', 'skills'),
    mode: 'realdir',
    statusFile: path.join(HOME, '.codeartsdoer', 'skills', 'UserSkillStatus.txt'),
    statusKind: 'kv_lines',
    note: '只认真实目录副本；开关走官方清单 UserSkillStatus.txt',
  },
  {
    id: 'qoder',
    name: '阿里 Qoder',
    dir: path.join(HOME, '.qoder', 'skills'),
    mode: 'junction',
    note: '目录扫描（实测已认共享技能），摘 junction 即关闭',
  },
];

// ---------------------------------------------------------------- 读配置

function readUserConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { version: 1, agents: [] };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      version: Number(raw.version) || 1,
      agents: Array.isArray(raw.agents) ? raw.agents : [],
    };
  } catch (e) {
    // 配置损坏时不能拖垮整个面板 —— 回退到空配置，用户还能手动改。
    return { version: 1, agents: [] };
  }
}

function writeUserConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const payload = { version: 1, agents: cfg.agents || [] };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8');
  invalidate();   // 写完立刻失效缓存，保证下一次读到的就是新配置
  return payload;
}

// ---------------------------------------------------------------- 合并

/** 逐字段合并：用户配置覆盖内置的同名 id */
function mergeAgent(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === 'remove') continue;
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

function mergeAll() {
  const user = readUserConfig();
  const byId = new Map();

  // 1) 先铺内置
  for (const a of BUILTIN_AGENTS) byId.set(a.id, { ...a, builtin: true });

  // 2) 用户条目覆盖 / 追加 / 删除
  for (const u of user.agents) {
    if (!u || !u.id) continue;
    if (u.remove === true) {
      byId.delete(u.id);
      continue;
    }
    const base = byId.get(u.id);
    byId.set(u.id, base ? mergeAgent(base, u) : { ...u, builtin: false });
  }

  // 3) 排序：内置在前（按内置顺序），自定义在后
  const order = new Map(BUILTIN_AGENTS.map((a, i) => [a.id, i]));
  const list = [...byId.values()].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : 1000;
    const bi = order.has(b.id) ? order.get(b.id) : 1000;
    if (ai !== bi) return ai - bi;
    return String(a.name).localeCompare(String(b.name));
  });

  return list;
}

// ---------------------------------------------------------------- 缓存

/**
 * 合并结果缓存。
 *
 * 为什么要缓存：core.js 里 AGENTS 是一个 Proxy，每次属性访问都会调
 * agentsMap()，而 agentsMap() 要读文件 + 合并。snapshot() 会遍历
 * 几百次属性访问 —— 实测单次 snapshot 要 1.7 秒，界面上会明显卡。
 *
 * 策略：缓存合并结果，用配置文件 mtime + size 做失效依据。
 * 用户改了配置（mtime 变）就自动重算；程序内写配置后主动 invalidate。
 */
let _cache = null;
let _cacheKey = '';

function configStatKey() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return 'none';
  }
}

function invalidate() {
  _cache = null;
  _cacheKey = '';
  _mapCache = null;
  _mapCacheKey = '';
}

/** 取合并结果（带缓存） */
function merged() {
  const key = configStatKey();
  if (_cache && _cacheKey === key) return _cache;
  _cache = mergeAll();
  _cacheKey = key;
  return _cache;
}

// ---------------------------------------------------------------- 对外 API

/** 当前生效的全部端（合并后） */
function listAgents() {
  return merged().map((a) => ({
    ...a,
    // dir 允许写 ~ 开头，展开成绝对路径
    dir: expandHome(a.dir),
    statusFile: a.statusFile ? expandHome(a.statusFile) : undefined,
    enabled: a.enabled !== false,
    hidden: a.hidden === true,
    installed: fs.existsSync(expandHome(a.dir)),
  }));
}

/**
 * 按显示名索引的映射（core.js 内部用的 AGENTS 形态）。
 *
 * 同样带缓存：core.js 的 AGENTS 是一个 Proxy，Object.entries() 一次
 * 遍历就会触发 1 次 ownKeys + 2N 次属性访问，每次都重建这张表的话
 * 就是 O(N²) 的重复计算。这里按配置文件的 stat 键缓存整张表。
 */
let _mapCache = null;
let _mapCacheKey = '';

function agentsMap() {
  const key = configStatKey();
  if (_mapCache && _mapCacheKey === key) return _mapCache;
  const out = {};
  for (const a of listAgents()) {
    if (!a.enabled || a.hidden) continue;
    out[a.name] = {
      dir: a.dir,
      mode: a.mode,
      statusFile: a.statusFile,
      statusKind: a.statusKind,
      statusKey: a.statusKey,
      note: a.note,
      id: a.id,
    };
  }
  _mapCache = out;
  _mapCacheKey = key;
  return out;
}

/** 展开 ~ 与环境变量 */
function expandHome(p) {
  if (!p) return p;
  let s = String(p).trim();
  if (s === '~') s = HOME;
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(HOME, s.slice(2));
  s = s.replace(/%USERPROFILE%/gi, HOME);
  s = s.replace(/%APPDATA%/gi, path.join(HOME, 'AppData', 'Roaming'));
  s = s.replace(/%LOCALAPPDATA%/gi, path.join(HOME, 'AppData', 'Local'));
  return path.resolve(s);
}

/**
 * 新增或更新一个端。
 * @param {object} data 端配置
 * @param {boolean} remove 是否删除
 */
function saveAgent(data, remove) {
  const user = readUserConfig();
  const isBuiltin = BUILTIN_AGENTS.some((b) => b.id === data.id);

  if (remove) {
    // 内置端：程序下次启动会被合并逻辑补回来，所以必须写 remove 标记。
    // 自定义端：直接从用户列表里删掉，不留残留。
    const list = user.agents.filter((a) => a && a.id !== data.id);
    if (isBuiltin) {
      list.push({ id: data.id, remove: true });
    }
    user.agents = list;
    writeUserConfig(user);
    return { ok: true, removed: true, builtin: isBuiltin };
  }

  // 保存/更新：同 id 的旧条目先移除，再追加新的
  const list = user.agents.filter((a) => a && a.id !== data.id);

  const entry = {
    id: data.id,
    name: data.name,
    dir: data.dir,
    mode: data.mode === 'realdir' ? 'realdir' : 'junction',
  };
  if (data.statusFile) entry.statusFile = data.statusFile;
  if (data.statusKind) entry.statusKind = data.statusKind;
  if (data.statusKey) entry.statusKey = data.statusKey;
  if (data.note) entry.note = data.note;
  if (data.enabled === false) entry.enabled = false;
  if (data.hidden === true) entry.hidden = true;

  list.push(entry);
  user.agents = list;
  writeUserConfig(user);
  return { ok: true, removed: false };
}

/** 恢复出厂：清空用户配置 */
function resetAgents() {
  writeUserConfig({ version: 1, agents: [] });
  return { ok: true };
}

module.exports = {
  BUILTIN_AGENTS,
  CONFIG_FILE,
  listAgents,
  agentsMap,
  saveAgent,
  resetAgents,
  readUserConfig,
  mergeAll,
  expandHome,
};
