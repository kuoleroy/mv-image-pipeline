#!/usr/bin/env node
/**
 * 把仓库里的技能本体同步到共享真源
 * ============================================================
 *  为什么需要这个：
 *    mv-image-pipeline 这个技能有两份存在：
 *      · 仓库   —— 开发用，带 .git，改动在这里发生
 *      · 真源   —— 各客户端实际读取的地方，纯可分发产物
 *    真源里不能放 .git 和开发工具（行业规范：skill 目录只放
 *    SKILL.md + scripts/ + references/ + assets/）。
 *
 *  真源地址从 Skillsmith 的配置读（~/.agents/skillsmith/settings.json），
 *  所以改了真源地址后本脚本自动跟着走，不需要改这里。
 *
 *  用法：
 *    node scripts/sync_skill_to_canon.js          # 同步
 *    node scripts/sync_skill_to_canon.js --check  # 只检查差异，不写入
 *
 *  安全：
 *    · 只覆盖下面列出的可分发内容，不碰真源里的其它文件
 *    · 删除时逐个文件/目录确认路径在目标技能目录内
 *    · 不删真源里未知的文件（用户可能自己加过东西）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_NAME = 'mv-image-pipeline';
const REPO_ROOT = path.join(__dirname, '..');

/** 可分发内容：目录整体同步，文件整体覆盖 */
const DIRS = ['scripts', 'references', 'assets'];
const FILES = ['SKILL.md', 'README.md', 'LICENSE'];

/** 读真源地址（与 Skillsmith 共用配置） */
function readCanonRoot() {
  const cfg = path.join(os.homedir(), '.agents', 'skillsmith', 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (raw && typeof raw.canonRoot === 'string' && raw.canonRoot.trim()) {
      let p = raw.canonRoot.trim();
      if (p === '~') p = os.homedir();
      else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
      return path.resolve(p);
    }
  } catch (e) {
    // 没配置就用默认
  }
  return path.join(os.homedir(), '.agents', 'skills');
}

const CHECK_ONLY = process.argv.includes('--check');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function rmSafe(p) {
  // 只允许删目标技能目录内的路径
  if (!p.startsWith(TARGET + path.sep) && p !== TARGET) {
    throw new Error('拒绝删除越界路径：' + p);
  }
  fs.rmSync(p, { recursive: true, force: true });
}

const CANON = readCanonRoot();
const TARGET = path.join(CANON, SKILL_NAME);

console.log('仓库   :', REPO_ROOT);
console.log('真源   :', CANON);
console.log('目标   :', TARGET);
console.log('模式   :', CHECK_ONLY ? '检查（不写入）' : '同步');
console.log('');

if (!fs.existsSync(path.join(REPO_ROOT, 'SKILL.md'))) {
  console.error('✗ 仓库里没有 SKILL.md，路径不对');
  process.exit(2);
}

let changed = 0, same = 0;

// ── 文件 ────────────────────────────────────────────────────────
for (const f of FILES) {
  const src = path.join(REPO_ROOT, f);
  const dst = path.join(TARGET, f);
  if (!fs.existsSync(src)) {
    if (fs.existsSync(dst)) {
      console.log('  ⊘ 仓库没有、目标有：' + f + (CHECK_ONLY ? '' : '  → 删除'));
      if (!CHECK_ONLY) { rmSafe(dst); changed++; }
    }
    continue;
  }
  const same_ = fs.existsSync(dst)
    && fs.readFileSync(src).equals(fs.readFileSync(dst));
  if (same_) { same++; continue; }
  console.log('  ● ' + f + (CHECK_ONLY ? '  （有差异）' : '  → 复制'));
  if (!CHECK_ONLY) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    changed++;
  } else changed++;
}

// ── 目录 ────────────────────────────────────────────────────────
for (const d of DIRS) {
  const src = path.join(REPO_ROOT, d);
  const dst = path.join(TARGET, d);
  if (!fs.existsSync(src)) continue;
  if (!CHECK_ONLY) {
    rmSafe(dst);
    copyDir(src, dst);
  }
  changed++;
  console.log('  ● ' + d + '/  → 整目录同步');
}

// ── 清理真源里不该有的东西 ──────────────────────────────────────
//  真源是可分发产物：只留技能内容，仓库配置与开发工具都要清掉。
const JUNK = [
  '.git', '.github', '.gitattributes', '.gitignore',
  'skillsmith', 'node_modules', 'dist', 'build', 'app',
  '__pycache__',
];
for (const j of JUNK) {
  const p = path.join(TARGET, j);
  if (!fs.existsSync(p)) continue;
  console.log('  ✗ 真源里有 ' + j + '（不该在可分发包里）' + (CHECK_ONLY ? '' : '  → 删除'));
  if (!CHECK_ONLY) { rmSafe(p); changed++; }
}

console.log('');
console.log(CHECK_ONLY
  ? `检查完成：${changed} 处差异，${same} 处一致`
  : `同步完成：${changed} 项更新，${same} 项一致`);

// ── 结果 ────────────────────────────────────────────────────────
if (!CHECK_ONLY) {
  const kb = (d) => {
    let n = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const s = path.join(p, e.name);
        if (e.isDirectory()) walk(s);
        else if (e.isFile()) n += fs.statSync(s).size;
      }
    };
    try { walk(d); } catch (e) { /* ignore */ }
    return (n / 1024).toFixed(0) + ' KB';
  };
  console.log('');
  console.log('真源技能包体积：' + kb(TARGET));
  const st = fs.statSync(path.join(TARGET, 'SKILL.md'));
  console.log('SKILL.md 可读   ：是');
  console.log('内容长度        ：' + st.size + ' 字节');
}
