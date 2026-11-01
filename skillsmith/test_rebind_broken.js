#!/usr/bin/env node
/**
 * 回归测试：真源搬家后「重新绑定」必须能看见断链的 junction
 * ============================================================
 *  复现的 bug：
 *    1) rebindAll 用 stat()（跟随链接）过滤端目录下的技能项，
 *       断链的 junction stat 抛错被丢弃 → 搬家后一个链接都没重绑。
 *    2) makeJunction 用 existsSync 判断存在性，
 *       断链的 junction 被误判成「不存在」→ symlinkSync 撞 EEXIST。
 *
 *  测试方法：
 *    造一个指向「不存在的旧地址」的断链 junction，
 *    然后跑 rebindAll，验证它被摘除并重建到当前真源。
 *
 *  安全性：全程只在本工具的测试目录里造/删链接，
 *          真源 ~/.agents/skills 只读。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_DIR = __dirname;
const core = require(path.join(SKILL_DIR, 'core.js'));

const HOME = os.homedir();
const SANDBOX = path.join(HOME, '.agents', 'skillsmith-test-rebind');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

function cleanup() {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('\n=== 1. 准备：造一个断链的 junction ===');
cleanup();
const broken = path.join(SANDBOX, 'agent', 'skills', 'demo-skill');
fs.mkdirSync(path.dirname(broken), { recursive: true });
// 指向一个根本不存在的地址
fs.symlinkSync(path.join(SANDBOX, 'OLD-NONEXISTENT-PATH', 'demo-skill'), broken, 'junction');
check('断链 junction 已创建', fs.lstatSync(broken).isSymbolicLink());
check('existsSync 判为不存在（这正是 bug 根源）', !fs.existsSync(broken));
check('lstat 判为符号链接（修复后靠它识别）', fs.lstatSync(broken).isSymbolicLink());

console.log('\n=== 2. makeJunction 能覆盖断链链接（不撞 EEXIST）===');
const target = path.join(core.canonRoot(), 'score-rewrite');
const real = fs.existsSync(target);
let mkErr = null;
try {
  core.makeJunction(target, broken);
} catch (e) { mkErr = e.message; }
check('makeJunction 未报 EEXIST', !mkErr, mkErr);
check('已指向真实存在的真源技能', core.linksToCanon(broken, 'score-rewrite'), real);
core.removeJunction(broken);

console.log('\n=== 3. rebindAll 能看见断链项并重绑 ===');
// 再造一个断链
fs.symlinkSync(path.join(SANDBOX, 'OLD-NONEXISTENT-PATH', 'demo-skill'), broken, 'junction');

// 用真实的 agent 配置跑一次 dryRun，看它是否把断链项纳入报告
const agents = core.AGENTS;
// 找一个真实端（WorkBuddy），造一个指向旧地址的断链技能
const agentName = Object.keys(agents)[0];
const cfg = agents[agentName];
const skill = core.listSkills()[0].name;
const p = path.join(cfg.dir, skill);

// 记下原状，测完要原样恢复 —— 测试不该留下痕迹
const wasLink = core.isJunction(p);
const wasTarget = wasLink ? (() => {
  try { return fs.readlinkSync(p); } catch (e) { return null; }
})() : null;

// 先摘掉它（如果存在），造一个断链版本
if (wasLink) core.removeJunction(p);
const oldTarget = path.join(SANDBOX, 'OLD-NONEXISTENT-PATH', skill);
fs.mkdirSync(path.dirname(p), { recursive: true });
fs.symlinkSync(oldTarget, p, 'junction');
check('已造出断链：' + agentName + '/' + skill, fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p));

const dry = core.rebindAll({ dryRun: true, missing: 'keep' });
const item = dry.report.find(r => r.agent === agentName && r.skill === skill);
check('dryRun 报告里包含这个断链项', !!item, dry.report.length);
check('dryRun 判定为需要 rebind', item && item.action === 'rebind', item);

const real2 = core.rebindAll({ dryRun: false, missing: 'keep' });
const item2 = real2.report.find(r => r.agent === agentName && r.skill === skill);
check('正式重绑后已指向当前真源',
  core.linksToCanon(p, skill), item2);
check('真源内容完好', fs.existsSync(path.join(core.canonRoot(), skill)));

console.log('\n=== 4. 还原原状 ===');
// 恢复成测试前的样子（原来是指向真源的 junction，就恢复成那样）
if (core.isJunction(p)) core.removeJunction(p);
if (wasLink) {
  core.makeJunction(wasTarget || path.join(core.canonRoot(), skill), p);
  check('已恢复为测试前的链接', core.linksToCanon(p, skill));
} else {
  check('测试前不是链接，保持不存在', !fs.existsSync(p));
}
cleanup();
console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
