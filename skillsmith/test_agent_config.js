#!/usr/bin/env node
/**
 * 智能体配置功能测试：增 / 改 / 删 / 重命名 / 删内置 / 恢复默认
 * 直接调 agent-config.js，不经过 HTTP —— 验证核心逻辑。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const cfg = require(path.join(__dirname, 'agent-config.js'));

const CFG_FILE = cfg.CONFIG_FILE;
let pass = 0, fail = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

function clean() {
  try { fs.unlinkSync(CFG_FILE); } catch (e) { /* 不存在 */ }
}

console.log('\n=== 1. 初始状态 ===');
clean();
check('无配置文件时返回 10 个内置端', cfg.listAgents().length === 10, cfg.listAgents().length);
check('含 Trae 国际版', cfg.listAgents().some(a => a.name === 'Trae 国际版'));
check('Trae 国际版路径正确',
  cfg.listAgents().find(a => a.name === 'Trae 国际版').dir === path.join(os.homedir(), '.trae', 'skills'));

console.log('\n=== 2. 新增自定义端 ===');
cfg.saveAgent({ id: 'zed', name: 'Zed 端', dir: '~/.zed/skills', mode: 'junction' });
let list = cfg.listAgents();
check('端数变 11', list.length === 11, list.length);
check('新增端存在', list.some(a => a.name === 'Zed 端'));
check('标记为自定义', list.find(a => a.id === 'zed').builtin === false);
check('~ 已展开为绝对路径', !list.find(a => a.id === 'zed').dir.includes('~'), list.find(a => a.id === 'zed').dir);

console.log('\n=== 3. 重命名（改显示名，不改 id）===');
cfg.saveAgent({ id: 'zed', name: 'Zed 新名字', dir: '~/.zed/skills', mode: 'junction' });
list = cfg.listAgents();
check('显示名已改', list.some(a => a.name === 'Zed 新名字'));
check('旧名已消失', !list.some(a => a.name === 'Zed 端'));
check('id 保持不变', list.find(a => a.id === 'zed') !== undefined);

console.log('\n=== 4. 停用（enabled=false）===');
cfg.saveAgent({ id: 'zed', name: 'Zed 新名字', dir: '~/.zed/skills', mode: 'junction', enabled: false });
list = cfg.listAgents();
check('仍列出但标记停用', list.find(a => a.id === 'zed').enabled === false);
check('不出现在生效映射里', !('Zed 新名字' in cfg.agentsMap()));

console.log('\n=== 5. 删除自定义端 ===');
cfg.saveAgent({ id: 'zed', name: 'Zed 新名字', dir: '~/.zed/skills', mode: 'junction' }, true);
list = cfg.listAgents();
check('端数回到 10', list.length === 10, list.length);
check('配置无残留', !fs.existsSync(CFG_FILE) ||
  !fs.readFileSync(CFG_FILE, 'utf8').includes('"zed"'),
  fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null);

console.log('\n=== 6. 删除内置端 ===');
cfg.saveAgent({ id: 'qoder', name: '阿里 Qoder', dir: 'x', mode: 'junction' }, true);
list = cfg.listAgents();
check('Qoder 已消失', !list.some(a => a.id === 'qoder'));
check('端数变 9', list.length === 9, list.length);
check('写了 remove 标记', fs.readFileSync(CFG_FILE, 'utf8').includes('remove'));

console.log('\n=== 7. 恢复默认 ===');
cfg.resetAgents();
list = cfg.listAgents();
check('端数回到 10', list.length === 10, list.length);
check('Qoder 回来了', list.some(a => a.id === 'qoder'));

console.log('\n=== 8. 改内置端路径（覆盖）===');
cfg.saveAgent({ id: 'claude-code', name: 'Claude Code', dir: '~/.claude/skills2', mode: 'junction' });
list = cfg.listAgents();
check('路径已覆盖', list.find(a => a.id === 'claude-code').dir.endsWith('skills2'),
  list.find(a => a.id === 'claude-code').dir);
check('仍标记为内置', list.find(a => a.id === 'claude-code').builtin === true);

console.log('\n=== 9. 改内置端机制（junction → realdir）===');
cfg.resetAgents();
cfg.saveAgent({ id: 'codearts', name: '华为 CodeArts', dir: '~/.codeartsdoer/skills',
  mode: 'realdir', statusFile: '~/.codeartsdoer/skills/UserSkillStatus.txt',
  statusKind: 'kv_lines' });
list = cfg.listAgents();
check('机制已改为 realdir', list.find(a => a.id === 'codearts').mode === 'realdir');
check('状态清单格式保留', list.find(a => a.id === 'codearts').statusKind === 'kv_lines');

console.log('\n=== 10. 改内置端的状态清单位置（客户端装在别的盘）===');
cfg.saveAgent({ id: 'trae-intl', name: 'Trae 国际版', dir: 'D:/Trae/skills',
  mode: 'junction', statusFile: 'D:/Trae/skill-config.json',
  statusKind: 'json_array', statusKey: 'disabledSkills' });
list = cfg.listAgents();
const traeIntl = list.find(a => a.id === 'trae-intl');
check('技能目录已改', traeIntl.dir.endsWith('Trae/skills') || traeIntl.dir.endsWith('Trae\\skills'), traeIntl.dir);
check('状态清单已改到新位置', (traeIntl.statusFile || '').includes('Trae'), traeIntl.statusFile);

console.log('\n=== 11. 清空内置端的状态清单 ===');
cfg.saveAgent({ id: 'trae-intl', name: 'Trae 国际版', dir: 'D:/Trae/skills',
  mode: 'junction', statusFile: '', statusKind: '', statusKey: '' });
list = cfg.listAgents();
check('状态清单已清空', !list.find(a => a.id === 'trae-intl').statusFile,
  list.find(a => a.id === 'trae-intl').statusFile);
check('清空后仍保留自定义路径', list.find(a => a.id === 'trae-intl').dir.includes('Trae'));

console.log('\n=== 12. 停用端不会丢掉自定义的状态清单 ===');
cfg.saveAgent({ id: 'trae-intl', name: 'Trae 国际版', dir: 'D:/Trae/skills',
  mode: 'junction', statusFile: 'D:/Trae/skill-config.json',
  statusKind: 'json_array', statusKey: 'disabledSkills' });
// 模拟界面上的「停用」按钮：只改 enabled，其余字段原样带回
cfg.saveAgent({ id: 'trae-intl', name: 'Trae 国际版', dir: 'D:/Trae/skills',
  mode: 'junction', enabled: false, statusFile: 'D:/Trae/skill-config.json',
  statusKind: 'json_array', statusKey: 'disabledSkills' });
list = cfg.listAgents();
check('端已停用', list.find(a => a.id === 'trae-intl').enabled === false);
check('状态清单没被内置默认值覆盖',
  (list.find(a => a.id === 'trae-intl').statusFile || '').includes('Trae'),
  list.find(a => a.id === 'trae-intl').statusFile);

console.log('\n=== 13. 损坏配置不崩 ===');
fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
fs.writeFileSync(CFG_FILE, '{ 这不是合法 JSON', 'utf8');
let crashed = false;
try { cfg.listAgents(); } catch (e) { crashed = true; }
check('损坏配置被安全忽略', !crashed);

console.log('\n=== 清理 ===');
clean();
console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
