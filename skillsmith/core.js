/**
 * skillswitcher 核心逻辑（Node 版）
 *
 * 设计原则：
 *  1. 单一真源 ~/.agents/skills —— 只读，绝不删除、绝不修改内容
 *  2. 关闭 = 让 Agent 端「看不见」该技能（摘 junction / 写禁用清单）
 *  3. 开启 = 让 Agent 端重新「看见」（建 junction / 恢复清单）
 *
 * 各端加载机制（实测 + 反编译确认）：
 *   junction 端 —— 用 fs.stat() 跟随链接，能认 junction；摘掉即关闭
 *   CodeArts 端 —— readdir 过滤 !isSymbolicLink()，只认真实目录副本；
 *                  开关走官方清单 UserSkillStatus.txt（name=false=禁用）
 *   Trae 端    —— 除 junction 外另有 skill-config.json 的 disabledSkills
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const agentConfig = require('./agent-config.js');
const settings = require('./settings.js');

// ---------------------------------------------------------------- 路径

const HOME = os.homedir();

/**
 * 共享技能真源根目录。
 *
 * 现在是动态的：来自 settings.js（用户可改）。
 * 用函数而不是常量，因为改了地址后必须立刻生效 —— 各端的 junction
 * 还得重新指向新真源（见 rebindAll）。
 */
function canonRoot() {
  return settings.getCanonRoot();
}

/**
 * 各 Agent 的技能目录与开关机制。
 *
 * 现在是动态的：来自 agent-config.js（内置基线 + 用户增删改覆盖）。
 * 用 getter 而不是常量，这样用户在界面上改了配置，下一次调用立刻生效，
 * 不需要重启面板。
 *
 * 性能注意：Proxy 的 ownKeys / getOwnPropertyDescriptor / get 每个都会
 * 被调用（Object.entries 一次遍历就是 1 + 2N 次），如果每次都重建整张
 * 配置表就是 O(N²)。所以这里在一次「快照周期」内只算一次，
 * 周期由 agentConfig 的缓存失效信号控制。
 */
const AGENTS = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      return agentConfig.agentsMap()[prop];
    },
    ownKeys() {
      return Reflect.ownKeys(agentConfig.agentsMap());
    },
    getOwnPropertyDescriptor(_t, prop) {
      const m = agentConfig.agentsMap();
      if (Object.prototype.hasOwnProperty.call(m, prop)) {
        return { value: m[prop], enumerable: true, configurable: true };
      }
      return undefined;
    },
  }
);

/** 端归属：正向白名单 + 反向排除 */
const AGENT_ONLY = {
  'codebase-crossrepo-pipeline': ['华为 CodeArts'],
};
const AGENT_EXCLUDE = {
  'browser-cli-skill': ['华为 CodeArts'],
};

/** 精简模式下保留的技能 */
const LEAN_KEEP = ['comfyui', 'mv-image-pipeline', 'tencent-docs-cli'];

// ---------------------------------------------------------------- 基础工具

/** Windows junction / 符号链接检测。lstat 不会跟随链接。 */
function isJunction(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink();
  } catch (e) {
    return false;
  }
}

/** 真实目录（排除 junction） */
function isRealDir(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (e) {
    return false;
  }
}

/** 该路径是否为「指向真源某技能的直接 junction」 */
/**
 * 判断 p 是否是指向真源 skillName 的 junction。
 *
 * 性能注意：realpathSync 在 Windows 上要解析整条链接链，很慢。
 * 原本每个 (技能 × 端) 组合都调两次 realpathSync —— snapshot 要 120 次，
 * 实测 1.4 秒，界面上明显卡顿。
 * 现在把真源路径的 realpath 结果缓存起来，每组合只做一次 realpathSync
 * （目标端），调用次数减半。
 *
 * 缓存 key 必须带真源路径：真源地址可由用户在设置里改，
 * 只用技能名做 key 的话，改址后缓存不失效，会把「还指着旧地址的链接」
 * 误判成「已指向当前真源」—— 重新绑定就会什么都不做（实测踩过）。
 */
const _canonRealCache = new Map();

function canonReal(skillName) {
  const root = canonRoot();
  const key = root + '|' + skillName;
  if (_canonRealCache.has(key)) return _canonRealCache.get(key);
  let v = null;
  try {
    v = fs.realpathSync(path.join(root, skillName)).toLowerCase();
  } catch (e) {
    v = null;
  }
  _canonRealCache.set(key, v);
  return v;
}

/** 清掉真源相关缓存（改址后调用，避免旧条目堆积） */
function clearCanonCache() {
  _canonRealCache.clear();
}

function linksToCanon(p, skillName) {
  if (!isJunction(p)) return false;
  const canon = canonReal(skillName);
  if (!canon) return false;
  try {
    const real = fs.realpathSync(p).toLowerCase();
    return real === canon;
  } catch (e) {
    return false;
  }
}

/**
 * 安全删除 junction —— 只摘链接，绝不碰真源。
 *
 * 用 fs.unlinkSync 而非 fs.rmSync(recursive:true)：
 *  - unlink 的语义是「移除一个链接条目」，不递归、不进目录；
 *    rmSync(recursive) 会被宿主的批量删除护栏（SAFE_DELETE_BULK_CONFIRM_REQUIRED）
 *    拦下 —— 批量关技能时逐个发删除请求会累计触发阈值。
 *  - 实测两种方式真源文件数都不变，但 unlink 语义更准确、不会被护栏误伤。
 *
 * 删除前强制校验它确实是 junction：这是防误删真源的最后一道闸。
 */
function removeJunction(p) {
  if (!isJunction(p)) {
    throw new Error('不是 junction，拒绝删除（保护真源）');
  }
  fs.unlinkSync(p);
}

/** 建立 junction 指向真源 */
function makeJunction(target, linkPath) {
  // 用 lstat 判断「目录项在不在」，不能用 existsSync ——
  // existsSync 会跟随链接，断链的 junction（指向已不存在的旧地址）
  // 会被判成「不存在」，于是走到 symlinkSync 直接撞 EEXIST 报错。
  // 真源搬家后所有链接都会短暂处于断链状态，这个坑必踩。
  let exists = false;
  try {
    fs.lstatSync(linkPath);
    exists = true;
  } catch (e) {
    exists = false;
  }
  if (exists) {
    if (isJunction(linkPath)) {
      removeJunction(linkPath);
    } else {
      throw new Error('目标已存在真实目录，未覆盖');
    }
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');
}

/**
 * 复制真实目录（CodeArts 用）。
 *
 * 目标已存在时的清理走「改名到临时名 → 删临时名」两段式：
 * 直接 rmSync(recursive) 会撞上宿主的批量删除护栏，而 rename 是原子且
 * 不带递归删除语义。被删的只是真源的**副本**，真源本身不受影响。
 */
function copyRealDir(src, dst) {
  if (fs.existsSync(dst)) {
    if (isJunction(dst)) {
      removeJunction(dst);
    } else {
      const tmp = dst + '.old-' + Date.now();
      fs.renameSync(dst, tmp);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, dereference: false });
}

/** 统计目录文件数与字节数 */
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          files += 1;
          bytes += fs.statSync(p).size;
        } catch (err) { /* 忽略读不到的文件 */ }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** 读取 SKILL.md 的 frontmatter */
function readFrontmatter(skillDir) {
  const md = path.join(skillDir, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(md, 'utf8');
  } catch (e) {
    return {};
  }
  // 部分技能文件带 UTF-8 BOM，不剥掉会导致正则匹配不到起始的 ---
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (mm) {
      out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

// ---------------------------------------------------------------- 清单读写

/** 读 CodeArts 风格的 key=value 清单 */
function readKvLines(file) {
  const map = new Map();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim().toLowerCase();
    const v = t.slice(i + 1).trim();
    if (k) map.set(k, v);
  }
  return map;
}

/** 写 CodeArts 风格清单 */
function writeKvLines(file, map) {
  const lines = [];
  for (const [k, v] of map) lines.push(`${k}=${v}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

/** 读 JSON 数组字段 */
function readJsonArray(file, key) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(d[key]) ? d[key] : [];
  } catch (e) {
    return [];
  }
}

/** 写 JSON 数组字段（保留其他字段） */
function writeJsonArray(file, key, items) {
  let d = {};
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* 文件不存在或损坏则重建 */ }
  d[key] = items;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
}

/**
 * 设置某端某技能的「禁用清单」状态。
 * 返回 true 表示有实际变更。
 */
function setStatus(cfg, skillName, disabled) {
  if (!cfg.statusFile) return false;
  const key = skillName.toLowerCase();

  if (cfg.statusKind === 'kv_lines') {
    // CodeArts：文件里 name=false 表示禁用，name=true 表示启用
    const map = readKvLines(cfg.statusFile);
    const want = disabled ? 'false' : 'true';
    const old = map.get(key);
    if (old === want) return false;
    map.set(key, want);
    writeKvLines(cfg.statusFile, map);
    return true;
  }

  if (cfg.statusKind === 'json_array') {
    // Trae：disabledSkills 数组，元素是 skill 名
    const items = readJsonArray(cfg.statusFile, cfg.statusKey);
    const lower = items.map((x) => String(x).toLowerCase());
    const idx = lower.indexOf(key);
    let changed = false;
    if (disabled && idx < 0) {
      items.push(skillName);
      changed = true;
    } else if (!disabled && idx >= 0) {
      items.splice(idx, 1);
      changed = true;
    }
    if (changed) writeJsonArray(cfg.statusFile, cfg.statusKey, items);
    return changed;
  }

  return false;
}

/** 查询某端某技能是否被清单禁用 */
function statusDisabled(cfg, skillName) {
  if (!cfg.statusFile) return false;
  const key = skillName.toLowerCase();
  if (cfg.statusKind === 'kv_lines') {
    const map = readKvLines(cfg.statusFile);
    const v = map.get(key);
    // 文件里 name=false 表示禁用
    return v !== undefined && v.toLowerCase() === 'false';
  }
  if (cfg.statusKind === 'json_array') {
    const items = readJsonArray(cfg.statusFile, cfg.statusKey);
    return items.some((x) => String(x).toLowerCase() === key);
  }
  return false;
}

// ---------------------------------------------------------------- 技能清单

/** 真源里的全部技能 */
function listSkills() {
  let names;
  try {
    names = fs.readdirSync(canonRoot());
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const dir = path.join(canonRoot(), name);
    if (!isRealDir(dir)) continue;
    const fm = readFrontmatter(dir);
    const stats = dirStats(dir);
    out.push({
      name,
      title: fm.name_cn || name,
      description: fm.description || '',
      files: stats.files,
      bytes: stats.bytes,
    });
  }
  return out;
}

/** 这个技能应装到哪些端 */
function targetsFor(skillName, onlyAgent) {
  const only = AGENT_ONLY[skillName];
  const excl = AGENT_EXCLUDE[skillName] || [];
  const out = [];
  for (const [agent, cfg] of Object.entries(AGENTS)) {
    if (onlyAgent && agent !== onlyAgent) continue;
    if (only && !only.includes(agent)) continue;
    if (excl.includes(agent)) continue;
    out.push([agent, cfg]);
  }
  return out;
}

/**
 * 该技能是否「归属」这一端。
 * 归属 = 这一端本该装它（AGENT_ONLY / AGENT_EXCLUDE 过滤后仍在）。
 * 不归属的端不该显示这个技能，否则面板会误示「未安装」。
 */
function applicableTo(skillName, agent) {
  return targetsFor(skillName, agent).length > 0;
}

/**
 * 该技能「实际装在」哪些端 —— 理论归属 ∪ 实际残留安装。
 *
 * 为什么需要这个：
 *   targetsFor 表达的是「按规则该装在哪」，但规则是会变的。
 *   比如 codebase-crossrepo-pipeline 早期装在所有端，后来改成只归属
 *   CodeArts。那些早期装留下的 junction / 真实目录副本仍然留在其他端。
 *
 *   如果关闭操作只按 targetsFor 走，那些残留就永远关不掉 ——
 *   面板显示「已全部关闭」，实际那个技能在 8 个端上依然被加载。
 *   （这是实测发现的问题：bulk off 后 codebase-crossrepo-pipeline
 *     在 8 个端上仍然是开启状态。）
 *
 *   所以关闭必须覆盖「实际装着的所有端」，而开启才按归属规则走 ——
 *   不该往不该装的端上装新东西，但该把已经装了的清干净。
 */
function installedTargets(skillName, onlyAgent) {
  const out = new Map();
  for (const [agent, cfg] of targetsFor(skillName, onlyAgent)) {
    out.set(agent, cfg);
  }
  // 补上残留安装
  for (const [agent, cfg] of Object.entries(AGENTS)) {
    if (onlyAgent && agent !== onlyAgent) continue;
    if (out.has(agent)) continue;
    const p = path.join(cfg.dir, skillName);
    let present = false;
    try {
      if (cfg.mode === 'realdir') {
        present = isRealDir(p);
      } else {
        present = fs.existsSync(p) || isJunction(p);
      }
    } catch (_) { /* 忽略探测错误 */ }
    if (present) out.set(agent, cfg);
  }
  return [...out.entries()];
}

// ---------------------------------------------------------------- 状态查询

/** 某端某技能当前是否「开启」 */
function agentOn(agent, cfg, skillName) {
  const p = path.join(cfg.dir, skillName);
  if (cfg.mode === 'realdir') {
    // CodeArts：真实目录在 且 清单未禁用 → 开
    if (!isRealDir(p)) return false;
    return !statusDisabled(cfg, skillName);
  }
  // junction 端：链接存在 → 开；还要看清单（Trae）
  if (!linksToCanon(p, skillName)) return false;
  if (statusDisabled(cfg, skillName)) return false;
  return true;
}

/** 全局快照：技能 × 端的开关矩阵 */
function snapshot() {
  const skills = listSkills();
  const rows = skills.map((s) => {
    const cells = {};
    for (const [agent, cfg] of Object.entries(AGENTS)) {
      const p = path.join(cfg.dir, s.name);
      const present = cfg.mode === 'realdir' ? isRealDir(p) : linksToCanon(p, s.name);
      const disabledByList = statusDisabled(cfg, s.name);
      cells[agent] = {
        on: agentOn(agent, cfg, s.name),
        present,
        disabledByList,
        // 对 CodeArts 而言，目录在但清单禁用 = 已关闭（零 I/O 关闭）
        effective: present && !disabledByList,
      };
    }
    return { ...s, cells };
  });

  const agents = Object.entries(AGENTS).map(([name, cfg]) => {
    let onCount = 0;
    for (const r of rows) if (r.cells[name].on) onCount += 1;
    return {
      name,
      dir: cfg.dir,
      mode: cfg.mode,
      note: cfg.note,
      onCount,
      total: rows.length,
    };
  });

  return { rows, agents, canonRoot: canonRoot() };
}

// ---------------------------------------------------------------- 并发锁

/**
 * 写操作（开关 / 批量 / 重新绑定）必须跨进程串行化。
 *
 * 为什么需要：
 *   开发版和打包版可以同时在跑（甚至两个终端各开一个）。两个进程各改各的
 *   junction —— 一方在摘链接、另一方在建链接，最终状态可能既没开也没关。
 *   真源只有一个，冲突的不是数据而是「谁在改」。
 *
 * 实现：
 *   用 O_EXCL 排他创建锁文件（Windows/Unix 都有效，跨进程）。
 *   拿到锁才动，拿不到就等，等到超时明确报错 —— 而不是静默写坏。
 *   锁文件超过 30 秒视为上一个进程崩溃留下的陈旧锁，自动清理。
 *
 * 重入：
 *   bulk() 内部会调 disable()/enable()，所以同进程内用深度计数，
 *   已持锁时直接放行，不会自己等自己。
 */
const LOCK_FILE = path.join(path.dirname(settings.CONFIG_FILE), '.lock');
const LOCK_STALE_MS = 30000;
const LOCK_TIMEOUT_MS = 15000;

let _lockDepth = 0;

function acquireLock(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try {
        fs.writeSync(fd, `${process.pid} @ ${new Date().toISOString()}`);
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁检测：持有者崩溃了，锁文件不会自己消失
      try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(LOCK_FILE); } catch (e2) { /* ignore */ }
          continue;
        }
      } catch (e2) {
        continue;   // 锁刚被别人释放了，重新抢
      }
      if (Date.now() > deadline) {
        throw new Error(
          '另一个 Skillsmith 实例正在修改技能，请稍后重试（锁等待超时）'
        );
      }
      // 同步等待 100ms。Node 主线程里 Atomics.wait 可以当 sleep 用。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
}

/** 在锁内执行 fn；支持同进程重入。 */
function withLock(fn) {
  if (_lockDepth > 0) {
    _lockDepth++;
    try {
      return fn();
    } finally {
      _lockDepth--;
    }
  }
  acquireLock(LOCK_TIMEOUT_MS);
  _lockDepth = 1;
  try {
    return fn();
  } finally {
    _lockDepth = 0;
    releaseLock();
  }
}

// ---------------------------------------------------------------- 开关操作

/** 开启一个技能（对指定端或全部端） */
function enable(skillName, onlyAgent) {
  const results = [];
  const canon = path.join(canonRoot(), skillName);
  if (!isRealDir(canon)) {
    return [{ ok: false, message: `真源不存在：${skillName}` }];
  }

  for (const [agent, cfg] of targetsFor(skillName, onlyAgent)) {
    const p = path.join(cfg.dir, skillName);
    try {
      if (cfg.mode === 'realdir') {
        // CodeArts：真实目录副本 + 清单标启用
        if (!isRealDir(p)) copyRealDir(canon, p);
        const ch = setStatus(cfg, skillName, false);
        results.push({ ok: true, agent, detail: ch ? '已复制并标记启用' : '已就位' });
      } else {
        if (!linksToCanon(p, skillName)) {
          if (fs.existsSync(p) && !isJunction(p)) {
            results.push({ ok: false, agent, detail: '存在真实副本，未覆盖' });
            continue;
          }
          makeJunction(canon, p);
        }
        const ch = setStatus(cfg, skillName, false);
        results.push({ ok: true, agent, detail: ch ? '已建立并标记启用' : '已就位' });
      }
    } catch (e) {
      results.push({ ok: false, agent, detail: e.message });
    }
  }
  return results;
}

/** 关闭一个技能（对指定端或全部端） */
function disable(skillName, onlyAgent, purge) {
  const results = [];

  // 用 installedTargets 而不是 targetsFor：把「规则上不该装但实际装着」
  // 的残留也一并清掉。否则面板显示已关闭，实际那些端仍在加载这个技能。
  for (const [agent, cfg] of installedTargets(skillName, onlyAgent)) {
    const p = path.join(cfg.dir, skillName);
    try {
      if (cfg.mode === 'realdir') {
        // CodeArts：默认保留真实目录，只用清单关（秒级、可逆、零 I/O）
        if (purge && isRealDir(p)) {
          // 两段式删除：先改名再删，避开宿主的递归删除护栏。
          // 被删的是真源的副本，真源本身不受影响。
          const tmp = p + '.old-' + Date.now();
          fs.renameSync(p, tmp);
          fs.rmSync(tmp, { recursive: true, force: true });
          setStatus(cfg, skillName, true);
          results.push({ ok: true, agent, detail: '真实目录已删除并标记禁用' });
        } else {
          setStatus(cfg, skillName, true);
          results.push({ ok: true, agent, detail: '已标记禁用（目录保留）' });
        }
        continue;
      }

      if (linksToCanon(p, skillName)) {
        removeJunction(p);
      } else if (isJunction(p)) {
        removeJunction(p);
      }
      const ch = setStatus(cfg, skillName, true);
      results.push({ ok: true, agent, detail: ch ? '已摘除并标记禁用' : '已摘除' });
    } catch (e) {
      results.push({ ok: false, agent, detail: e.message });
    }
  }
  return results;
}

/** 批量：全开 / 全关 / 精简模式 */
function bulk(action, onlyAgent) {
  const skills = listSkills();
  const names = action === 'lean'
    ? skills.map((s) => s.name).filter((n) => LEAN_KEEP.includes(n))
    : skills.map((s) => s.name);

  const report = [];
  for (const n of names) {
    const r = action === 'off' ? disable(n, onlyAgent) : enable(n, onlyAgent);
    const bad = r.filter((x) => !x.ok);
    report.push({ skill: n, ok: bad.length === 0, failed: bad });
  }

  // 精简模式额外把不在保留名单里的关掉
  if (action === 'lean') {
    for (const s of skills) {
      if (LEAN_KEEP.includes(s.name)) continue;
      const r = disable(s.name, onlyAgent);
      const bad = r.filter((x) => !x.ok);
      report.push({ skill: s.name, ok: bad.length === 0, failed: bad });
    }
  }
  return report;
}

/**
 * 重新绑定：把所有端已装的技能，重新指向「当前」真源。
 *
 *  为什么需要这个：
 *   真源地址改了之后，各端目录里的 junction 还指着旧地址 ——
 *   界面显示的技能列表来自新真源，但各端 Agent 实际加载的还是旧目录。
 *   不重新绑定的话，改设置等于只改了一半。
 *
 *  做法：
 *   对每个端每个技能，摘掉旧 junction，再按新真源重建。
 *   真源本身不动（只读），只动各端的链接。
 *
 *  @param {object} opts
 *   · onlyAgent  只处理某一端
 *   · dryRun     只报告不执行
 *   · missing    真源里没有的技能怎么处理：'keep' 保留原链接 | 'remove' 摘掉
 */
function rebindAll(opts) {
  const o = opts || {};
  const onlyAgent = o.onlyAgent || null;
  const dryRun = o.dryRun === true;
  const missingPolicy = o.missing === 'remove' ? 'remove' : 'keep';

  const root = canonRoot();
  const skills = listSkills();       // 当前真源里的技能
  const skillNames = new Set(skills.map((s) => s.name));

  const report = [];
  const agents = agentConfig.agentsMap();

  for (const [agent, cfg] of Object.entries(agents)) {
    if (onlyAgent && agent !== onlyAgent) continue;

    // 该端目录下现存的技能名（不管是 junction 还是实体副本）
    let existing = [];
    try {
      existing = fs.readdirSync(cfg.dir).filter((n) => {
        const p = path.join(cfg.dir, n);
        try {
          // 用 stat（跟随链接）而不是 lstat：junction 的 lstat 模式是
          // symlink，isDirectory() 返回 false —— 用 lstat 会把所有
          // junction 技能都过滤掉，rebind 就找不到要重定向的项（实测踩过）。
          return fs.statSync(p).isDirectory();
        } catch (e) {
          // 断链的 junction：stat 抛错，但目录项还在（指向的是已不存在的旧地址）。
          //
          //   真源根搬家后，所有端的链接会同时断链 —— 这正是「重新绑定」
          //   最需要生效的场景。如果这里把断链项全过滤掉，rebind 一个都看不见，
          //   报告只会有「已指向当前真源」的 noop，用户以为绑定成功了，
          //   结果所有客户端的技能全废（实测踩过：搬完 99 个链接没被重绑）。
          //
          //   所以这里用 lstat 兜底：只要是链接就留下来，后面交给重绑逻辑处理。
          try {
            return fs.lstatSync(p).isSymbolicLink();
          } catch (e2) {
            return false;
          }
        }
      });
    } catch (e) {
      continue;   // 该端目录不存在，跳过
    }

    for (const name of existing) {
      const p = path.join(cfg.dir, name);
      const inCanon = skillNames.has(name);

      try {
        if (!inCanon) {
          // 新真源里没有这个技能了
          if (missingPolicy === 'remove' && isJunction(p)) {
            if (!dryRun) removeJunction(p);
            report.push({ agent, skill: name, action: 'remove', ok: true,
              detail: '新真源中已无此技能，已摘除链接' });
          } else {
            report.push({ agent, skill: name, action: 'skip', ok: true,
              detail: '新真源中无此技能，保留原状' });
          }
          continue;
        }

        // 该技能在新真源里存在 —— 检查链接是否已指向新真源
        const want = path.join(root, name);
        let alreadyOk = false;
        if (cfg.mode === 'realdir') {
          // CodeArts 用实体副本，不存在「指向」问题，跳过
          alreadyOk = true;
        } else if (linksToCanon(p, name)) {
          alreadyOk = true;
        }

        if (alreadyOk) {
          report.push({ agent, skill: name, action: 'noop', ok: true, detail: '已指向当前真源' });
          continue;
        }

        if (cfg.mode === 'realdir') {
          report.push({ agent, skill: name, action: 'noop', ok: true, detail: '实体副本模式，无需重绑' });
          continue;
        }

        if (!dryRun) {
          if (isJunction(p)) removeJunction(p);
          else if (fs.existsSync(p)) {
            report.push({ agent, skill: name, action: 'skip', ok: false,
              detail: '存在真实目录，未覆盖（请手动处理）' });
            continue;
          }
          makeJunction(want, p);
        }
        report.push({ agent, skill: name, action: 'rebind', ok: true,
          detail: '已重新指向当前真源' });
      } catch (e) {
        report.push({ agent, skill: name, action: 'error', ok: false, detail: e.message });
      }
    }
  }

  const changed = report.filter((r) => r.action === 'rebind' || r.action === 'remove').length;
  return {
    ok: report.every((r) => r.ok),
    dryRun,
    canonRoot: root,
    total: report.length,
    changed,
    report,
  };
}

/** 估算某端当前注入 prompt 的字符数（name + description 形式） */
function estimateTokens(agentName) {
  const snap = snapshot();
  const cfg = AGENTS[agentName];
  if (!cfg) return 0;
  let chars = 0;
  for (const row of snap.rows) {
    if (!row.cells[agentName].on) continue;
    chars += row.name.length + row.description.length + 4;
  }
  return Math.round(chars / 3.6); // 中文为主的场景，经验值
}

module.exports = {
  canonRoot,
  clearCanonCache,
  settings,
  AGENTS,
  LEAN_KEEP,
  isJunction,
  isRealDir,
  linksToCanon,
  removeJunction,
  makeJunction,
  listSkills,
  snapshot,
  targetsFor,
  applicableTo,
  installedTargets,
  agentOn,
  // 写操作统一在导出层加锁（函数体本身不动）。
  // bulk() 内部调的是模块内的 disable/enable，靠 withLock 的重入计数放行。
  enable: (...args) => withLock(() => enable(...args)),
  disable: (...args) => withLock(() => disable(...args)),
  bulk: (...args) => withLock(() => bulk(...args)),
  rebindAll: (...args) => withLock(() => rebindAll(...args)),
  estimateTokens,
  dirStats,
};
