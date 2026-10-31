/**
 * 桌面版增强（三）：面包屑 + 设置面板
 * ============================================================================
 *
 *  面包屑位置：main 内、Agent 标签栏上方，独立一行。
 *
 *  显示内容：
 *    共享技能  ›  C:\Users\admin\.agents\skills  ›  [⚙ 设置]
 *
 *  为什么要有设置：
 *    真源地址原本硬编码 ~/.agents/skills。换了机器 / 换了用户名 /
 *    想用外置盘 / 要同时维护多套技能，都需要改。
 *
 *  改地址的连带影响（必须一并处理，否则改了一半）：
 *    各端目录里的 junction 还指着旧真源。改完地址后要「重新绑定」，
 *    把所有端的链接重新指向新真源。设置面板里提供了这个动作，
 *    并且有 dry-run 预演。
 *
 *  API：
 *    GET  /api/settings                          → 当前设置
 *    POST /api/settings {action:'set-canon-root', canonRoot}
 *    POST /api/settings {action:'rebind', dryRun, missing}
 *
 * ============================================================================
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────── 样式

  const CSS = `
/* 面包屑行 */
.sw-crumb {
  display: flex; align-items: center; gap: 9px;
  /* 高度对齐 Electron 的 titleBarOverlay(44px)，让原生窗口控件
     和这行在同一条水平线上，也给用户一个明确的拖拽把手。 */
  height: 44px;
  /* 右侧留出原生窗口控件（最小化/最大化/关闭）的位置。
     菜单栏要排在控件左边，否则会被挤出可视区（实测踩过）。 */
  padding: 0 156px 0 24px;
  background: var(--sw-canvas-deep, #0f1115);
  border-bottom: 1px solid var(--sw-line-soft, #232833);
  font-size: 12px;
  color: var(--sw-muted, #9aa3b2);
  flex-shrink: 0;
}
.sw-crumb-icon { color: var(--sw-accent, #f0a34a); display: flex; align-items: center; }
.sw-crumb-sep  { color: var(--sw-muted-soft, #6b7484); opacity: .6; }
.sw-crumb-label { color: var(--sw-muted, #9aa3b2); white-space: nowrap; }
.sw-crumb-path {
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
  color: var(--sw-ink, #eef1f6);
  background: var(--sw-card, #1e222b);
  border: 1px solid var(--sw-line-soft, #232833);
  padding: 3px 9px;
  border-radius: 6px;
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color .16s, color .16s;
}
.sw-crumb-path:hover { border-color: var(--sw-accent, #f0a34a); color: var(--sw-accent, #f0a34a); }
.sw-crumb-path.missing { color: var(--sw-error, #e56565); border-color: rgba(229,101,101,.4); }
.sw-crumb-count {
  font-size: 11px; color: var(--sw-muted-soft, #6b7484);
  font-family: 'JetBrains Mono', Consolas, monospace;
}
.sw-crumb-spacer { flex: 1; }
.sw-crumb-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 11px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--sw-line, #2b313d);
  background: var(--sw-card, #1e222b);
  color: var(--sw-muted, #9aa3b2);
  font-size: 12px; font-weight: 500; font-family: inherit;
  transition: background-color .16s, color .16s, border-color .16s;
}
.sw-crumb-btn:hover {
  background: var(--sw-card-hover, #232833);
  color: var(--sw-ink, #eef1f6);
  border-color: #3a4252;
}
.sw-crumb-btn.ghost { background: transparent; border-color: transparent; }
.sw-crumb-btn.ghost:hover { background: var(--sw-card-hover, #232833); }

/* 设置弹窗 */
.sw-set-backdrop {
  position: fixed; inset: 0; z-index: 950;
  background: rgba(6,8,12,.74); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  animation: swSetFade .16s ease;
}
@keyframes swSetFade { from { opacity: 0 } to { opacity: 1 } }

.sw-set {
  width: min(620px, calc(100vw - 64px));
  max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  background: #1b1f27; border: 1px solid #2b313d; border-radius: 14px;
  box-shadow: 0 28px 70px rgba(0,0,0,.6); overflow: hidden;
  animation: swSetPop .18s cubic-bezier(.32,.72,0,1);
}
@keyframes swSetPop { from { opacity:0; transform: translateY(8px) scale(.985) } to { opacity:1; transform:none } }

.sw-set-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid #262c37; flex-shrink: 0;
}
.sw-set-head h2 { margin:0; font-size:15px; font-weight:600; color:#eef1f6; letter-spacing:-.01em; }
.sw-set-head p  { margin:4px 0 0; font-size:11.5px; color:#6b7484; }

.sw-set-body { padding: 18px 20px; overflow-y: auto; flex: 1; }

.sw-set-foot {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 13px 20px; border-top: 1px solid #262c37; flex-shrink: 0;
}

.sw-set-field { display:flex; flex-direction:column; gap:6px; margin-bottom:16px; }
.sw-set-field label { font-size:11.5px; color:#9aa3b2; font-weight:500; }
.sw-set-field input {
  background:#14161b; border:1px solid #2b313d; border-radius:8px;
  color:#eef1f6; font-family:'JetBrains Mono',Consolas,monospace; font-size:12px;
  padding:9px 12px; outline:none; width:100%;
}
.sw-set-field input:focus { border-color:#f0a34a; }
.sw-set-hint { font-size:10.5px; color:#6b7484; line-height:1.6; }
.sw-set-hint code {
  font-family:'JetBrains Mono',Consolas,monospace; font-size:10.5px;
  background:#14161b; padding:1px 5px; border-radius:4px; border:1px solid #262c37;
}

.sw-set-row {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:11px 13px; border:1px solid #262c37; border-radius:10px;
  background:#1e222b; margin-bottom:10px;
}
.sw-set-row-main { min-width:0; }
.sw-set-row-title { font-size:12.5px; font-weight:600; color:#eef1f6; margin-bottom:3px; }
.sw-set-row-sub { font-size:11px; color:#6b7484; line-height:1.55; }

.sw-set-warn {
  padding:11px 13px; border-radius:9px; margin-bottom:14px;
  background: rgba(240,163,74,.09); border:1px solid rgba(240,163,74,.3);
  color:#ffc98a; font-size:11.5px; line-height:1.65;
}
.sw-set-warn.danger { background:rgba(229,101,101,.09); border-color:rgba(229,101,101,.32); color:#ff9a9a; }
.sw-set-warn code {
  font-family:'JetBrains Mono',Consolas,monospace;
  background:rgba(0,0,0,.28); padding:1px 5px; border-radius:4px;
}

.sw-set-log {
  margin-top:12px; max-height:200px; overflow-y:auto;
  border:1px solid #262c37; border-radius:9px; background:#14161b;
}
.sw-set-log-row {
  display:flex; gap:9px; align-items:baseline;
  padding:6px 11px; font-size:11px;
  font-family:'JetBrains Mono',Consolas,monospace;
  border-bottom:1px solid rgba(38,44,55,.55);
}
.sw-set-log-row:last-child { border-bottom:none; }
.sw-set-log-row .ag { color:#6b7484; min-width:110px; }
.sw-set-log-row .sk { color:#eef1f6; min-width:150px; }
.sw-set-log-row .dt { color:#6b7484; }
.sw-set-log-row.ok .dt { color:#7fd18f; }
.sw-set-log-row.err .dt { color:#e56565; }

.sw-set-btn {
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:32px; padding:0 14px; border-radius:8px; cursor:pointer;
  border:1px solid #2b313d; background:#1e222b; color:#9aa3b2;
  font-size:12.5px; font-weight:500; font-family:inherit;
  transition: background-color .16s, color .16s, border-color .16s;
  white-space: nowrap;
}
.sw-set-btn:hover { background:#252a34; color:#eef1f6; border-color:#3a4252; }
.sw-set-btn.primary { background:#f0a34a; border-color:#f0a34a; color:#14161b; font-weight:600; }
.sw-set-btn.primary:hover { background:#ffb35c; border-color:#ffb35c; color:#14161b; }
.sw-set-btn.danger:hover { background:rgba(229,101,101,.12); border-color:rgba(229,101,101,.45); color:#e56565; }
.sw-set-btn.ghost { background:transparent; border-color:transparent; }
.sw-set-btn.ghost:hover { background:#252a34; }
.sw-set-btn:disabled { opacity:.45; cursor:not-allowed; }

.sw-set-toast {
  position:fixed; left:50%; bottom:34px; transform:translateX(-50%); z-index:999;
  padding:9px 18px; border-radius:9px; font-size:12.5px; font-weight:500;
  background:#232833; border:1px solid #3a4252; color:#eef1f6;
  box-shadow:0 12px 32px rgba(0,0,0,.5); animation:swSetFade .16s ease;
}
.sw-set-toast.err { border-color:rgba(229,101,101,.5); color:#ff9a9a; }
.sw-set-toast.ok  { border-color:rgba(240,163,74,.5); color:#ffc98a; }
`;

  // ──────────────────────────────────────────── 工具

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function toast(msg, kind) {
    const old = document.querySelector('.sw-set-toast');
    if (old) old.remove();
    const t = el('div', 'sw-set-toast ' + (kind || ''), msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  async function getSettings() {
    const res = await fetch('/api/settings');
    return res.json();
  }

  async function postSettings(payload) {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 200));
    }
    return res.json();
  }

  /** 让上游 React 重新拉数据：点当前选中的 Agent 标签 */
  function refreshReact() {
    const active = document.querySelector('main > .sw-tabbar button.bg-surface-card')
      || document.querySelector('main > .sw-tabbar button');
    if (active) active.click();
    else location.reload();
  }

  // ──────────────────────────────────────────── 面包屑

  let crumb = null;

  async function buildCrumb() {
    if (crumb) return crumb;

    const bar = el('div', 'sw-crumb');

    const icon = el('span', 'sw-crumb-icon');
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
    bar.appendChild(icon);

    bar.appendChild(el('span', 'sw-crumb-label', '共享技能'));

    bar.appendChild(el('span', 'sw-crumb-sep', '›'));

    const pathEl = el('span', 'sw-crumb-path');
    pathEl.title = '点击打开设置';
    pathEl.onclick = openSettings;
    bar.appendChild(pathEl);

    const countEl = el('span', 'sw-crumb-count');
    bar.appendChild(countEl);

    bar.appendChild(el('span', 'sw-crumb-spacer'));

    // 「重新绑定」「设置」已移入右侧的菜单栏（设置 ▾），
    // 这里只保留菜单栏要插入的位置。

    crumb = bar;
    return bar;
  }

  /**
   * 刷新面包屑内容。
   *
   * 注意节流：MutationObserver 监听的是整个 body 的 subtree，
   * 任何 DOM 变化都会触发这里。如果每次都发请求 + 改 DOM，
   * 就会形成「改 DOM → 触发 observer → 再改 DOM」的自激循环，
   * 把渲染进程 CPU 打满、页面卡死（实测踩过：CDP 直接超时）。
   * 所以：请求节流 + 值没变就不动 DOM。
   */
  let _crumbBusy = false;
  let _crumbPending = false;

  async function refreshCrumb() {
    if (_crumbBusy) { _crumbPending = true; return; }
    _crumbBusy = true;
    try {
      const s = await getSettings();
      const pathEl = crumb.querySelector('.sw-crumb-path');
      if (pathEl) {
        if (pathEl.textContent !== s.canonRoot) pathEl.textContent = s.canonRoot;
        pathEl.classList.toggle('missing', !s.canonRootExists);
        pathEl.title = s.canonRootExists
          ? s.canonRoot + '\n点击打开设置'
          : s.canonRoot + '\n⚠ 目录不存在 —— 点击打开设置';
      }

      const countEl = crumb.querySelector('.sw-crumb-count');
      if (countEl) {
        try {
          const st = await (await fetch('/api/health')).json();
          const txt = st.skills + ' 个技能';
          if (countEl.textContent !== txt) countEl.textContent = txt;
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ } finally {
      _crumbBusy = false;
      if (_crumbPending) { _crumbPending = false; setTimeout(refreshCrumb, 300); }
    }
  }

  /**
   * 侧栏处理：把顶部标题块（图标 + 「Skillsmith」）打上 .sw-brand 由 CSS 隐藏。
   *
   * 那块位置现在让给菜单栏了（app-menu.js 会插一个 .sw-side-menu 进去），
   * 所以这里只负责标记隐藏，不自己插拖拽带 —— 菜单栏所在的那条
   * 区域本身就是 drag，空白处照样能拖窗口。
   *
   * 为什么用 class 而不是直接 remove 元素：
   *   那个块是 React 渲染的，直接删掉会被下次重渲染重新插回来；
   *   加 class 则是稳定且可逆的。
   */
  function setupSidebar() {
    const aside = document.querySelector('aside');
    if (!aside) return;

    const brand = aside.children[0];
    if (brand && brand.tagName === 'DIV'
        && !brand.classList.contains('sw-brand')
        && !brand.classList.contains('sw-side-menu')) {
      brand.classList.add('sw-brand');
    }
  }

  /**
   * 把面包屑插到 main 内、Agent 标签栏上方，
   * 并给标签栏 / 内容区打上语义 class。
   *
   * 为什么要打 class：
   *   原来主题 CSS 用 `main > div:first-child`（标签栏）和
   *   `main > div:last-child`（内容区）定位。插进面包屑后
   *   first-child 变成面包屑、last-child 变成标签栏，全错位。
   *   位置选择器在这里太脆弱 —— 改成 .sw-tabbar / .sw-content 后，
   *   无论 main 里塞几个东西都不会乱。
   */
  function mountCrumb() {
    if (!crumb) return;
    const main = document.querySelector('main');
    if (!main) return;

    setupSidebar();

    // 给标签栏和内容区打语义 class（只在变化时才写，避免触发 observer）
    const kids = [...main.children].filter((c) => c !== crumb && c.tagName === 'DIV');
    if (kids.length >= 2) {
      if (!kids[0].classList.contains('sw-tabbar')) kids[0].classList.add('sw-tabbar');
      if (!kids[1].classList.contains('sw-content')) kids[1].classList.add('sw-content');
    }

    if (main.contains(crumb)) return;
    const tagBar = main.querySelector('.sw-tabbar') || kids[0];
    if (tagBar) main.insertBefore(crumb, tagBar);
    else main.insertBefore(crumb, main.firstChild);
  }

  // ──────────────────────────────────────────── 设置弹窗

  let modal = null;

  function closeSettings() {
    if (modal) modal.remove();
    modal = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') closeSettings();
  }

  async function openSettings(focusTab) {
    if (modal) return;
    modal = el('div', 'sw-set-backdrop');
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeSettings();
    });
    document.body.appendChild(modal);
    document.addEventListener('keydown', onKey);

    const panel = el('div', 'sw-set');

    const head = el('div', 'sw-set-head');
    const h = el('div');
    h.appendChild(el('h2', null, '设置'));
    h.appendChild(el('p', null, '共享技能真源地址与各端绑定'));
    head.appendChild(h);
    const x = el('button', 'sw-set-btn icon ghost', '✕');
    x.onclick = closeSettings;
    head.appendChild(x);
    panel.appendChild(head);

    const body = el('div', 'sw-set-body');
    body.appendChild(el('div', null, '加载中…'));
    panel.appendChild(body);

    const foot = el('div', 'sw-set-foot');
    const done = el('button', 'sw-set-btn primary', '完成');
    done.onclick = closeSettings;
    foot.appendChild(done);
    panel.appendChild(foot);

    modal.appendChild(panel);

    const s = await getSettings();
    renderSettings(body, s, focusTab);
  }

  function renderSettings(body, s, focusTab) {
    body.innerHTML = '';

    // ── 真源路径
    const field = el('div', 'sw-set-field');
    field.appendChild(el('label', null, '共享技能真源地址'));

    const input = el('input');
    input.value = s.canonRoot;
    input.spellcheck = false;
    input.placeholder = 'C:\\Users\\你的用户名\\.agents\\skills';
    field.appendChild(input);

    const hint = el('div', 'sw-set-hint');
    hint.innerHTML =
      '这个目录存放所有技能的<b>唯一副本</b>，各 AI 工具目录里放的是指向它的链接。' +
      '支持 <code>~</code> 开头。' +
      '默认：<code>' + s.defaultCanonRoot + '</code><br>' +
      '配置文件：<code>' + s.configFile + '</code>';
    field.appendChild(hint);
    body.appendChild(field);

    if (!s.canonRootExists) {
      const warn = el('div', 'sw-set-warn danger');
      warn.innerHTML = '⚠ 当前地址的目录不存在，技能列表会是空的。可以先创建目录再保存。';
      body.appendChild(warn);
    }

    const saveRow = el('div');
    saveRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-bottom:18px;';
    const resetBtn = el('button', 'sw-set-btn ghost', '恢复默认');
    resetBtn.onclick = () => { input.value = s.defaultCanonRoot; };
    const saveBtn = el('button', 'sw-set-btn primary', '保存地址');
    saveBtn.onclick = async () => {
      const v = input.value.trim();
      if (!v) return toast('路径不能为空', 'err');
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        const r = await postSettings({ action: 'set-canon-root', canonRoot: v });
        toast(r.message || '已保存', 'ok');
        await refreshCrumb();
        refreshReact();
        const ns = await getSettings();
        renderSettings(body, ns, focusTab);
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存地址';
      }
    };
    saveRow.appendChild(resetBtn);
    saveRow.appendChild(saveBtn);
    body.appendChild(saveRow);

    // ── 重新绑定
    const sect = el('div', 'sw-sect-title');
    sect.textContent = '各端绑定';
    sect.style.cssText =
      'font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b7484;margin:4px 0 10px;';
    body.appendChild(sect);

    const rebindWarn = el('div', 'sw-set-warn');
    rebindWarn.innerHTML =
      '改了真源地址后，各 AI 工具目录里的链接<b>仍然指向旧地址</b>。' +
      '必须执行一次「重新绑定」，把链接重新指向新真源，否则各工具加载的还是旧内容。';
    body.appendChild(rebindWarn);

    const row = el('div', 'sw-set-row');
    const rowMain = el('div', 'sw-set-row-main');
    rowMain.appendChild(el('div', 'sw-set-row-title', '重新绑定所有端'));
    rowMain.appendChild(el('div', 'sw-set-row-sub',
      '逐个检查各端的技能链接，指向错的重新指向当前真源。真源本身不动。'));
    row.appendChild(rowMain);
    body.appendChild(row);

    const acts = el('div');
    acts.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-bottom:16px;';
    const dryBtn = el('button', 'sw-set-btn', '预演');
    dryBtn.title = '只报告不执行，看看会改哪些';
    const doBtn = el('button', 'sw-set-btn primary', '执行重新绑定');
    acts.appendChild(dryBtn);
    acts.appendChild(doBtn);
    body.appendChild(acts);

    const logBox = el('div', 'sw-set-log');
    logBox.style.display = 'none';
    body.appendChild(logBox);

    const runRebind = async (dryRun) => {
      dryBtn.disabled = true;
      doBtn.disabled = true;
      (dryRun ? dryBtn : doBtn).textContent = '处理中…';
      try {
        const r = await postSettings({ action: 'rebind', dryRun });
        logBox.style.display = '';
        logBox.innerHTML = '';
        const head = el('div', 'sw-set-log-row');
        head.innerHTML = '<span class="ag">' + (dryRun ? '预演结果' : '执行结果') + '</span>' +
          '<span class="sk">共 ' + r.total + ' 项，' + r.changed + ' 项需改动</span>';
        logBox.appendChild(head);
        for (const item of r.report) {
          if (item.action === 'noop') continue;
          const line = el('div', 'sw-set-log-row ' + (item.ok ? 'ok' : 'err'));
          line.innerHTML =
            '<span class="ag">' + item.agent + '</span>' +
            '<span class="sk">' + item.skill + '</span>' +
            '<span class="dt">' + item.action + ' · ' + item.detail + '</span>';
          logBox.appendChild(line);
        }
        if (!r.report.some((x) => x.action !== 'noop')) {
          const line = el('div', 'sw-set-log-row ok');
          line.innerHTML = '<span class="ag"></span><span class="sk"></span><span class="dt">全部已正确指向当前真源，无需改动</span>';
          logBox.appendChild(line);
        }
        toast(dryRun ? '预演完成' : '重新绑定完成', 'ok');
        if (!dryRun) { await refreshCrumb(); refreshReact(); }
      } catch (e) {
        toast('操作失败：' + e.message, 'err');
      } finally {
        dryBtn.disabled = false;
        doBtn.disabled = false;
        dryBtn.textContent = '预演';
        doBtn.textContent = '执行重新绑定';
      }
    };

    dryBtn.onclick = () => runRebind(true);
    doBtn.onclick = () => runRebind(false);

    if (focusTab === 'rebind') {
      dryBtn.focus();
    }
  }

  // ──────────────────────────────────────────── 入口

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
      return;
    }
    if (!document.getElementById('sw-crumb-style')) {
      const style = document.createElement('style');
      style.id = 'sw-crumb-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // 菜单栏「设置」触发
    window.addEventListener('sw:open-settings', (e) => {
      openSettings(e.detail || null);
    });
    // 菜单栏的 toast 提示
    window.addEventListener('sw:toast', (e) => {
      const d = e.detail || {};
      toast(d.msg || '', d.kind);
    });

    buildCrumb();
    mountCrumb();
    refreshCrumb();

    // React 重渲染后要把面包屑挂回去（React 会重排 main 的子节点）。
    //
    // 只观察 main 的直接子节点（childList，不带 subtree）：
    // 卡片列表内部的任何变化都跟我们无关，全 subtree 观察会
    // 造成高频触发。
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        mountCrumb();
        refreshCrumb();
      }, 200);
    });
    const mainEl = document.querySelector('main');
    if (mainEl) obs.observe(mainEl, { childList: true });
    else obs.observe(document.body, { childList: true, subtree: true });

    // 侧栏内容变化（切换作用域/项目）时也要重新处理品牌块与拖拽带
    const asideEl = document.querySelector('aside');
    if (asideEl) {
      new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          setupSidebar();
        }, 200);
      }).observe(asideEl, { childList: true });
    }
  }

  start();
})();
