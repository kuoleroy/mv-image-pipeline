/**
 * 全局设置（当前只有一项：共享技能真源地址）
 * ============================================================================
 *
 *  为什么真源地址要可配：
 *    原来硬编码 ~/.agents/skills，但换机器、换用户名、用外置盘、
 *    或者同时维护多套技能时，都需要改。真源地址一变，各端的 junction
 *    就全指错地方了 —— 所以设置里必须配套「重新绑定」动作。
 *
 *  配置文件：~/.agents/skill-switcher/settings.json
 *    与 agents.json 同目录，同属本工具的配置。
 *
 *  格式：
 *  {
 *    "canonRoot": "C:\\Users\\admin\\.agents\\skills"
 *  }
 *
 *  读取策略：
 *    · 文件不存在 → 用默认 ~/.agents/skills
 *    · 配置里的路径不存在 → 仍然用它，但 UI 会标「目录不存在」
 *      （用户可能要先创建好再回来填；不能因为目录不存在就退回默认，
 *        那会让用户填的路径莫名其妙失效）
 *
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.agents', 'skillsmith');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

/** 旧版目录（产品改名前）—— 首次启动时把配置搬过来 */
const LEGACY_CONFIG_DIR = path.join(HOME, '.agents', 'skill-switcher');

const DEFAULT_CANON_ROOT = path.join(HOME, '.agents', 'skills');

/**
 * 旧配置目录 → 新目录的一次性迁移。
 *
 *  产品从「Skills 开关面板」改名为 Skillsmith 时，配置目录也跟着改。
 *  这里在模块加载时自动把旧目录里的文件搬过来（同名不覆盖），
 *  这样用户升级后设置和智能体列表不会丢。
 */
function migrateLegacyConfig() {
  try {
    if (!fs.existsSync(LEGACY_CONFIG_DIR)) return;
    const files = fs.readdirSync(LEGACY_CONFIG_DIR);
    if (!files.length) {
      try { fs.rmdirSync(LEGACY_CONFIG_DIR); } catch (e) { /* ignore */ }
      return;
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    for (const f of files) {
      const from = path.join(LEGACY_CONFIG_DIR, f);
      const to = path.join(CONFIG_DIR, f);
      if (fs.existsSync(to)) continue;      // 新目录已有同名文件，不覆盖
      try { fs.renameSync(from, to); } catch (e) { /* ignore */ }
    }
    try { fs.rmdirSync(LEGACY_CONFIG_DIR); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
}

migrateLegacyConfig();

// ---------------------------------------------------------------- 读

let _cache = null;
let _cacheKey = '';

function statKey() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return 'none';
  }
}

function readSettings() {
  const key = statKey();
  if (_cache && _cacheKey === key) return _cache;
  let s = { canonRoot: DEFAULT_CANON_ROOT };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (raw && typeof raw.canonRoot === 'string' && raw.canonRoot.trim()) {
        s.canonRoot = expandHome(raw.canonRoot.trim());
      }
    }
  } catch (e) {
    // 配置损坏：退回默认，不崩
  }
  _cache = s;
  _cacheKey = key;
  return s;
}

// ---------------------------------------------------------------- 写

function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  _cache = null;
  _cacheKey = '';
  return readSettings();
}

// ---------------------------------------------------------------- 路径

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

/** 当前生效的真源根目录 */
function getCanonRoot() {
  return readSettings().canonRoot;
}

/**
 * 设置真源根目录。
 * @returns {{ok:boolean, canonRoot:string, exists:boolean, message?:string}}
 */
function setCanonRoot(p) {
  if (!p || !String(p).trim()) {
    return { ok: false, message: '路径不能为空' };
  }
  const abs = expandHome(p);
  const s = writeSettings({ canonRoot: abs });
  return {
    ok: true,
    canonRoot: s.canonRoot,
    exists: fs.existsSync(s.canonRoot),
    message: fs.existsSync(s.canonRoot)
      ? '已切换真源。若各端仍指向旧地址，请执行「重新绑定」。'
      : '已保存，但该目录当前不存在。',
  };
}

/** 真源目录是否存在 */
function canonRootExists() {
  return fs.existsSync(getCanonRoot());
}

/** 全部设置（供 UI 展示） */
function all() {
  const s = readSettings();
  return {
    canonRoot: s.canonRoot,
    canonRootExists: fs.existsSync(s.canonRoot),
    defaultCanonRoot: DEFAULT_CANON_ROOT,
    configFile: CONFIG_FILE,
  };
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CANON_ROOT,
  getCanonRoot,
  setCanonRoot,
  canonRootExists,
  expandHome,
  all,
  readSettings,
  writeSettings,
};
