/**
 * 桌面版增强（二）：智能体管理面板
 * ============================================================================
 *
 *  功能：新增 / 编辑 / 重命名 / 删除各个厂家的 AI 智能体端
 *
 *  为什么用注入而不是改 React：
 *  上游 skills-switch 的 React 组件没有「管理端」的概念，而重写它
 *  等于丢掉它全部的交互逻辑。这里沿用与批量工具栏相同的思路 ——
 *  运行时注入一个模态框，走 /api/agent-config 接口。
 *
 *  数据流：
 *    GET  /api/agent-config   → 列出全部端（含未安装的、自定义的）
 *    POST /api/agent-config   → { action: 'save'|'remove'|'reset', agent: {...} }
 *
 *  配置文件：~/.agents/skill-switcher/agents.json
 *
 * ============================================================================
 */

(function () {
  'use strict';

  const API = '/api/agent-config';

  // ──────────────────────────────────────────── 样式

  const CSS = `
.sw-modal-backdrop {
  position: fixed; inset: 0; z-index: 900;
  background: rgba(6, 8, 12, 0.72);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  animation: swFade .16s ease;
}
@keyframes swFade { from { opacity: 0 } to { opacity: 1 } }

.sw-modal {
  width: min(760px, calc(100vw - 64px));
  max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  background: #1b1f27;
  border: 1px solid #2b313d;
  border-radius: 14px;
  box-shadow: 0 28px 70px rgba(0,0,0,.6);
  overflow: hidden;
  animation: swPop .18s cubic-bezier(.32,.72,0,1);
}
@keyframes swPop { from { opacity:0; transform: translateY(8px) scale(.985) } to { opacity:1; transform:none } }

.sw-modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid #262c37;
  flex-shrink: 0;
}
.sw-modal-head h2 { margin:0; font-size:15px; font-weight:600; color:#eef1f6; letter-spacing:-.01em; }
.sw-modal-head p  { margin:4px 0 0; font-size:11.5px; color:#6b7484; }

.sw-modal-body { padding: 16px 20px; overflow-y: auto; flex: 1; }

.sw-modal-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 13px 20px; border-top: 1px solid #262c37; flex-shrink: 0;
}

.sw-btn {
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:32px; padding:0 14px; border-radius:8px; cursor:pointer;
  border:1px solid #2b313d; background:#1e222b; color:#9aa3b2;
  font-size:12.5px; font-weight:500; font-family:inherit;
  transition: background-color .16s, color .16s, border-color .16s;
}
.sw-btn:hover { background:#252a34; color:#eef1f6; border-color:#3a4252; }
.sw-btn.primary {
  background:#f0a34a; border-color:#f0a34a; color:#14161b; font-weight:600;
}
.sw-btn.primary:hover { background:#ffb35c; border-color:#ffb35c; color:#14161b; }
.sw-btn.danger:hover { background:rgba(229,101,101,.12); border-color:rgba(229,101,101,.45); color:#e56565; }
.sw-btn.ghost { background:transparent; border-color:transparent; }
.sw-btn.ghost:hover { background:#252a34; }
.sw-btn.icon { width:30px; height:30px; padding:0; }
.sw-btn:disabled { opacity:.45; cursor:not-allowed; }

/* 端列表 */
.sw-ag-list { display:flex; flex-direction:column; gap:6px; }
.sw-ag {
  display:grid; grid-template-columns: 1fr auto; align-items:center; gap:12px;
  padding:11px 13px; border:1px solid #262c37; border-radius:10px; background:#1e222b;
  transition: border-color .16s, background-color .16s;
}
.sw-ag:hover { border-color:#333a47; background:#222731; }
.sw-ag.off { opacity:.55; }
.sw-ag-main { min-width:0; }
.sw-ag-name { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:600; color:#eef1f6; }
.sw-ag-name input {
  background:#14161b; border:1px solid #2b313d; border-radius:6px;
  color:#eef1f6; font:inherit; font-size:13px; font-weight:600;
  padding:4px 8px; width:220px; outline:none;
}
.sw-ag-name input:focus { border-color:#f0a34a; }
.sw-tag {
  font-size:9.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase;
  padding:2px 6px; border-radius:4px; border:1px solid #333a47; color:#6b7484;
}
.sw-tag.builtin { color:#9aa3b2; }
.sw-tag.custom { color:#f0a34a; border-color:rgba(240,163,74,.35); background:rgba(240,163,74,.1); }
.sw-tag.missing { color:#e56565; border-color:rgba(229,101,101,.35); background:rgba(229,101,101,.1); }
.sw-ag-dir {
  font-family:'JetBrains Mono',Consolas,monospace; font-size:11px; color:#6b7484;
  margin-top:3px; word-break:break-all;
}
.sw-ag-dir input {
  width:100%; background:#14161b; border:1px solid #2b313d; border-radius:6px;
  color:#9aa3b2; font-family:'JetBrains Mono',Consolas,monospace; font-size:11px;
  padding:4px 8px; outline:none;
}
.sw-ag-dir input:focus { border-color:#f0a34a; color:#eef1f6; }
.sw-ag-acts { display:flex; align-items:center; gap:5px; }
.sw-ag-mode {
  font-size:10.5px; font-family:'JetBrains Mono',Consolas,monospace;
  color:#6b7484; padding:3px 7px; border-radius:5px; background:#14161b; border:1px solid #262c37;
}
/* 机制下拉（可改） */
.sw-ag-mode-sel {
  height:30px; padding:0 6px; border-radius:6px; cursor:pointer;
  background:#14161b; border:1px solid #262c37; color:#6b7484;
  font-family:'JetBrains Mono',Consolas,monospace; font-size:10.5px; outline:none;
}
.sw-ag-mode-sel:focus { border-color:#f0a34a; color:#eef1f6; }
/* 高级：状态清单 */
.sw-ag-adv { margin-top:7px; display:flex; flex-direction:column; gap:6px; }
.sw-ag-adv-label {
  font-size:10px; letter-spacing:.05em; text-transform:uppercase;
  color:#6b7484; font-weight:600;
}
.sw-ag-adv-row { display:grid; grid-template-columns:1fr 128px 108px; gap:6px; }
.sw-ag-adv-row input {
  width:100%; height:26px; background:#14161b; border:1px solid #2b313d; border-radius:6px;
  color:#9aa3b2; font-family:'JetBrains Mono',Consolas,monospace; font-size:11px;
  padding:4px 8px; outline:none;
}
.sw-ag-adv-row input:focus { border-color:#f0a34a; color:#eef1f6; }
.sw-ag-adv-row select {
  height:26px; padding:0 6px; border-radius:6px; cursor:pointer;
  background:#14161b; border:1px solid #2b313d; color:#9aa3b2;
  font-family:'JetBrains Mono',Consolas,monospace; font-size:10.5px; outline:none;
}
.sw-ag-adv-hint { font-size:10.5px; color:#5d6575; }
.sw-sect-title {
  font-size:10.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase;
  color:#6b7484; margin:18px 0 9px;
}
.sw-sect-title:first-child { margin-top:0; }

/* 新增表单 */
.sw-form { display:flex; flex-direction:column; gap:11px; }
.sw-field { display:flex; flex-direction:column; gap:5px; }
.sw-field label { font-size:11.5px; color:#9aa3b2; font-weight:500; }
.sw-field input, .sw-field select {
  background:#14161b; border:1px solid #2b313d; border-radius:8px;
  color:#eef1f6; font:inherit; font-size:12.5px; padding:8px 11px; outline:none;
  width:100%;
}
.sw-field input:focus, .sw-field select:focus { border-color:#f0a34a; }
.sw-field .hint { font-size:10.5px; color:#6b7484; }
.sw-field-row { display:grid; grid-template-columns:1fr 1fr; gap:11px; }

/* 提示条 */
.sw-toast {
  position:fixed; left:50%; bottom:34px; transform:translateX(-50%);
  z-index:999; padding:9px 18px; border-radius:9px; font-size:12.5px; font-weight:500;
  background:#232833; border:1px solid #3a4252; color:#eef1f6;
  box-shadow:0 12px 32px rgba(0,0,0,.5);
  animation: swFade .16s ease;
}
.sw-toast.err { border-color:rgba(229,101,101,.5); color:#ff9a9a; }
.sw-toast.ok  { border-color:rgba(240,163,74,.5); color:#ffc98a; }
`;

  // ──────────────────────────────────────────── 工具

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function toast(msg, kind) {
    const old = document.querySelector('.sw-toast');
    if (old) old.remove();
    const t = el('div', 'sw-toast ' + (kind || ''), msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function api(action, agent) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, agent }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = await res.json();
    // 后端可能用 200 + {ok:false,message} 拒绝（比如命中不支持名单）
    if (r && r.ok === false) throw new Error(r.message || '操作被拒绝');
    return r;
  }

  // ──────────────────────────────────────────── 面板

  let modal = null;

  function closeModal() {
    if (modal) modal.remove();
    modal = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') closeModal();
  }

  async function openModal() {
    if (modal) return;
    modal = el('div', 'sw-modal-backdrop');
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeModal();
    });
    document.body.appendChild(modal);
    document.addEventListener('keydown', onKey);
    modal.appendChild(buildPanel());
    await refresh();
  }

  function buildPanel() {
    const panel = el('div', 'sw-modal');

    // 头
    const head = el('div', 'sw-modal-head');
    const h = el('div');
    h.appendChild(el('h2', null, '智能体管理'));
    h.appendChild(el('p', null, '管理各家 AI 工具的技能目录。开关立即生效，无需重启。'));
    head.appendChild(h);
    const closeBtn = el('button', 'sw-btn icon ghost', '✕');
    closeBtn.title = '关闭';
    closeBtn.onclick = closeModal;
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // 体
    const body = el('div', 'sw-modal-body');
    body.id = 'sw-ag-body';
    body.appendChild(el('div', null, '加载中…'));
    panel.appendChild(body);

    // 底
    const foot = el('div', 'sw-modal-foot');
    const left = el('div');
    const resetBtn = el('button', 'sw-btn ghost', '恢复默认');
    resetBtn.title = '清除所有自定义，回到内置配置';
    resetBtn.onclick = async () => {
      if (!window.confirm('确定恢复默认？\n\n所有自定义的智能体配置将被清除（内置端会回来）。\n此操作不影响已安装的技能。')) return;
      await api('reset');
      toast('已恢复默认', 'ok');
      await refresh();
    };
    left.appendChild(resetBtn);
    foot.appendChild(left);

    const right = el('div');
    right.style.display = 'flex';
    right.style.gap = '8px';
    const addBtn = el('button', 'sw-btn', '＋ 新增智能体');
    addBtn.onclick = () => showForm(body, null);
    right.appendChild(addBtn);
    const doneBtn = el('button', 'sw-btn primary', '完成');
    doneBtn.onclick = closeModal;
    right.appendChild(doneBtn);
    foot.appendChild(right);
    panel.appendChild(foot);

    return panel;
  }

  /** 重绘列表 */
  async function refresh() {
    const body = document.getElementById('sw-ag-body');
    if (!body) return;
    let data;
    try {
      const res = await fetch(API);
      data = await res.json();
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', null, '加载失败：' + e.message));
      return;
    }

    body.innerHTML = '';
    body.appendChild(el('div', 'sw-sect-title', '已配置的智能体 (' + data.agents.length + ')'));
    const list = el('div', 'sw-ag-list');
    for (const a of data.agents) list.appendChild(agentRow(a));
    body.appendChild(list);
    body.appendChild(el('div', 'sw-sect-title', '说明'));
    body.appendChild(el('div', null,
      '· 「junction」模式：目录里放指向共享真源的目录联接，摘掉即关闭（绝大多数工具）\n' +
      '· 「realdir」模式：目录里放真实副本，开关走工具自己的状态清单（如 CodeArts）\n' +
      '· 客户端没装也能先填目录：开关时软件会自动创建目录，客户端装好后直接生效\n' +
      '· 客户端装在非默认位置：改上面的路径框，⚙ 里可改状态清单位置与机制\n' +
      '· 删除内置端会写入 remove 标记，恢复默认即可撤销')).style.cssText =
      'font-size:11.5px;line-height:1.75;color:#6b7484;white-space:pre-wrap;';

    const warnBox = el('div', null,
      '不支持接入：TeleAgent\n' +
      '它的技能开关由自己的 permission.skill 白名单决定，摘目录链接对它无效，\n' +
      '硬接只会和它的云端同步打架。请直接在 TeleAgent 自己的面板里开关。');
    warnBox.style.cssText =
      'font-size:11.5px;line-height:1.75;color:#e56565;white-space:pre-wrap;'
      + 'margin-top:10px;padding:9px 11px;border:1px solid rgba(229,101,101,.3);'
      + 'border-radius:9px;background:rgba(229,101,101,.06);';
    body.appendChild(warnBox);
  }

  function agentRow(a) {
    const row = el('div', 'sw-ag' + (a.enabled === false ? ' off' : ''));

    const main = el('div', 'sw-ag-main');

    // 名称行（可直接改 = 重命名）
    const nameRow = el('div', 'sw-ag-name');
    const nameInput = el('input');
    nameInput.value = a.name;
    nameInput.spellcheck = false;
    nameRow.appendChild(nameInput);
    nameRow.appendChild(el('span', 'sw-tag ' + (a.builtin ? 'builtin' : 'custom'),
      a.builtin ? '内置' : '自定义'));
    if (!a.installed) {
      const missTag = el('span', 'sw-tag missing', '未找到');
      missTag.title = '该端默认目录下没有 skills 目录 —— 客户端可能没装，'
        + '或者装在了别处（改上面的路径框即可）';
      nameRow.appendChild(missTag);
    }
    if (a.unsupported) {
      const unTag = el('span', 'sw-tag missing', '不支持');
      unTag.title = a.unsupportedReason || '该客户端的技能开关机制与本工具不兼容';
      nameRow.appendChild(unTag);
    }
    if (a.enabled === false) nameRow.appendChild(el('span', 'sw-tag missing', '已停用'));
    main.appendChild(nameRow);

    // 路径行（可改）
    const dirRow = el('div', 'sw-ag-dir');
    const dirInput = el('input');
    dirInput.value = a.dir;
    dirInput.spellcheck = false;
    dirInput.title = a.dir;
    dirRow.appendChild(dirInput);
    main.appendChild(dirRow);

    // 高级区：状态清单文件（客户端装在非默认位置时需要改）
    const adv = el('div', 'sw-ag-adv');
    adv.style.display = a.statusFile ? '' : 'none';
    adv.appendChild(el('div', 'sw-ag-adv-label', '状态清单（该客户端自己的开关记录）'));

    const advRow = el('div', 'sw-ag-adv-row');
    const statusInput = el('input');
    statusInput.value = a.statusFile || '';
    statusInput.placeholder = '留空 = 没有状态清单';
    statusInput.spellcheck = false;
    statusInput.title = a.statusFile || '';

    const kindSel = el('select');
    const k1 = el('option', null, 'json 数组');
    k1.value = 'json_array';
    const k2 = el('option', null, 'key=value 行');
    k2.value = 'kv_lines';
    kindSel.appendChild(k1);
    kindSel.appendChild(k2);
    kindSel.value = a.statusKind || 'json_array';

    const keyInput = el('input');
    keyInput.value = a.statusKey || '';
    keyInput.placeholder = '字段名';
    keyInput.spellcheck = false;

    advRow.appendChild(statusInput);
    advRow.appendChild(kindSel);
    advRow.appendChild(keyInput);
    adv.appendChild(advRow);
    adv.appendChild(el('div', 'sw-ag-adv-hint',
      '留空 = 只靠目录联接开关。客户端装在别的盘时，技能目录与状态清单要改成对应路径。'));
    main.appendChild(adv);

    row.appendChild(main);

    // 操作
    const acts = el('div', 'sw-ag-acts');

    // 开关机制（可改 —— 不确定就 junction）
    const modeSel = el('select', 'sw-ag-mode-sel');
    const m1 = el('option', null, 'junction');
    m1.value = 'junction';
    const m2 = el('option', null, 'realdir');
    m2.value = 'realdir';
    modeSel.appendChild(m1);
    modeSel.appendChild(m2);
    modeSel.value = a.mode || 'junction';
    modeSel.title = '开关机制：junction = 目录联接；realdir = 真实副本 + 状态清单';
    acts.appendChild(modeSel);

    // 展开/收起状态清单
    const advBtn = el('button', 'sw-btn icon', '⚙');
    advBtn.title = '状态清单设置';
    advBtn.onclick = () => {
      adv.style.display = adv.style.display === 'none' ? '' : 'none';
    };
    acts.appendChild(advBtn);

    // 启停开关
    const toggle = el('button', 'sw-btn icon');
    toggle.textContent = a.enabled === false ? '○' : '●';
    toggle.title = a.enabled === false ? '启用该端' : '停用该端（不显示、不参与批量操作）';
    toggle.onclick = async () => {
      try {
        await api('save', collect(a, true));
        toast(a.enabled === false ? '已启用 ' + a.name : '已停用 ' + a.name, 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
      await refresh();
    };
    acts.appendChild(toggle);

    // 保存（改名/改路径/改机制/改状态清单）
    const save = el('button', 'sw-btn icon', '✓');
    save.title = '保存名称、路径、机制与状态清单';
    save.onclick = async () => {
      try {
        await api('save', collect(a, false));
        toast('已保存', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
      await refresh();
    };
    acts.appendChild(save);

    // 删除
    const del = el('button', 'sw-btn icon danger', '✕');
    del.title = '删除该端';
    del.onclick = async () => {
      if (!window.confirm('确定删除「' + a.name + '」？\n\n只删除面板里的这个条目，\n不会动它目录里已安装的技能。')) return;
      await api('remove', { id: a.id, name: a.name, dir: a.dir });
      toast('已删除', 'ok');
      await refresh();
    };
    acts.appendChild(del);

    row.appendChild(acts);

    // 汇总当前行里的可编辑字段。
    // 注意：启停也走同一份数据 —— 早期版本启停只带 name/dir，
    // 会把用户改过的 statusFile 悄悄覆盖回内置默认值。
    // flipEnabled：启停按钮要翻转状态，保存按钮保持原状。
    function collect(base, flipEnabled) {
      const statusFile = statusInput.value.trim();
      const kind = kindSel.value;
      const key = keyInput.value.trim();
      return {
        id: base.id,
        name: nameInput.value.trim() || base.name,
        dir: dirInput.value.trim() || base.dir,
        mode: modeSel.value,
        enabled: flipEnabled ? (base.enabled === false) : (base.enabled !== false),
        // 空串是「显式清空」—— 后端要能把它写进配置去覆盖内置默认值
        statusFile,
        statusKind: statusFile ? kind : '',
        statusKey: statusFile && kind === 'json_array' ? key : '',
      };
    }

    return row;
  }

  // ──────────────────────────────────────────── 新增表单

  function showForm(body, preset) {
    const box = el('div', 'sw-form');
    box.style.cssText =
      'margin-top:14px;padding:15px;background:#1e222b;border:1px solid #2b313d;border-radius:11px;';

    const nameField = el('div', 'sw-field');
    nameField.appendChild(el('label', null, '显示名称'));
    const nameInput = el('input');
    nameInput.placeholder = '例如：Trae 国际版';
    nameField.appendChild(nameInput);
    box.appendChild(nameField);

    const dirField = el('div', 'sw-field');
    dirField.appendChild(el('label', null, '技能目录'));
    const dirInput = el('input');
    dirInput.placeholder = '例如：C:\\Users\\你的用户名\\.trae\\skills';
    dirInput.spellcheck = false;
    dirField.appendChild(dirInput);
    dirField.appendChild(el('div', 'hint', '支持 ~ 开头，代表当前用户目录'));
    box.appendChild(dirField);

    const modeField = el('div', 'sw-field');
    modeField.appendChild(el('label', null, '开关机制'));
    const modeSel = el('select');
    const opt1 = el('option', null, 'junction —— 目录联接（绝大多数工具）');
    opt1.value = 'junction';
    const opt2 = el('option', null, 'realdir —— 真实副本 + 状态清单');
    opt2.value = 'realdir';
    modeSel.appendChild(opt1);
    modeSel.appendChild(opt2);
    modeField.appendChild(modeSel);
    modeField.appendChild(el('div', 'hint',
      '不确定就选 junction。若该工具认不到共享技能，再试 realdir。'));
    box.appendChild(modeField);

    const row = el('div', 'sw-field-row');
    const idField = el('div', 'sw-field');
    idField.appendChild(el('label', null, '标识 id'));
    const idInput = el('input');
    idInput.placeholder = '例如：trae-intl';
    idInput.spellcheck = false;
    idField.appendChild(idInput);
    idField.appendChild(el('div', 'hint', '唯一，用于内部识别；留空自动生成'));
    row.appendChild(idField);

    const stField = el('div', 'sw-field');
    stField.appendChild(el('label', null, '状态文件（可选）'));
    const stInput = el('input');
    stInput.placeholder = '例如：~/.trae/skill-config.json';
    stInput.spellcheck = false;
    stField.appendChild(stInput);
    stField.appendChild(el('div', 'hint', '填了才会写 disabledSkills 之类的清单'));
    row.appendChild(stField);
    box.appendChild(row);

    const row2 = el('div', 'sw-field-row');
    const kindField = el('div', 'sw-field');
    kindField.appendChild(el('label', null, '状态清单格式'));
    const kindSel = el('select');
    const k1 = el('option', null, 'json 数组');
    k1.value = 'json_array';
    const k2 = el('option', null, 'key=value 行');
    k2.value = 'kv_lines';
    kindSel.appendChild(k1);
    kindSel.appendChild(k2);
    kindSel.value = 'json_array';
    kindField.appendChild(kindSel);
    kindField.appendChild(el('div', 'hint', 'json 数组 = 一个字符串数组；key=value = 每行一条'));
    row2.appendChild(kindField);

    const keyField = el('div', 'sw-field');
    keyField.appendChild(el('label', null, 'json 字段名'));
    const keyInput = el('input');
    keyInput.placeholder = 'disabledSkills';
    keyInput.spellcheck = false;
    keyField.appendChild(keyInput);
    keyField.appendChild(el('div', 'hint', '仅 json 数组格式用得上'));
    row2.appendChild(keyField);
    box.appendChild(row2);

    const acts = el('div');
    acts.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = el('button', 'sw-btn', '取消');
    cancel.onclick = () => box.remove();
    const save = el('button', 'sw-btn primary', '添加');
    save.onclick = async () => {
      const name = nameInput.value.trim();
      const dir = dirInput.value.trim();
      if (!name) return toast('请填写显示名称', 'err');
      if (!dir) return toast('请填写技能目录', 'err');
      let id = idInput.value.trim();
      if (!id) {
        // 没填就按名称生成
        id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      const statusFile = stInput.value.trim();
      const kind = kindSel.value;
      const agent = {
        id, name, dir,
        mode: modeSel.value,
        statusFile,
        statusKind: statusFile ? kind : '',
        statusKey: statusFile && kind === 'json_array' ? (keyInput.value.trim() || 'disabledSkills') : '',
        enabled: true,
      };
      try {
        await api('save', agent);
        toast('已添加 ' + name, 'ok');
        box.remove();
        await refresh();
      } catch (e) {
        toast('添加失败：' + e.message, 'err');
      }
    };
    acts.appendChild(cancel);
    acts.appendChild(save);
    box.appendChild(acts);

    // 插到列表下方
    const body2 = document.getElementById('sw-ag-body');
    if (body2) body2.appendChild(box);
    nameInput.focus();
  }

  // ──────────────────────────────────────────── 入口按钮

  function injectEntry() {
    if (document.querySelector('.sw-manage-btn')) return;
    const btn = el('button', 'sw-btn sw-manage-btn');
    btn.textContent = '⚙ 管理智能体';
    btn.style.cssText = 'width:100%;margin-top:10px;';
    btn.title = '新增 / 重命名 / 删除各家 AI 智能体';
    btn.onclick = openModal;

    const nav = document.querySelector('aside nav');
    if (!nav) return;
    nav.appendChild(btn);
  }

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
      return;
    }
    if (!document.getElementById('sw-agent-style')) {
      const style = document.createElement('style');
      style.id = 'sw-agent-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        injectEntry();
      }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    injectEntry();

    // 菜单栏「智能体管理」触发
    window.addEventListener('sw:open-agent-manager', () => openModal());
  }

  start();
})();
