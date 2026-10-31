/**
 * 桌面版增强（四）：应用菜单栏
 * ============================================================================
 *
 *  位置：面包屑行右侧。形如普通桌面软件的菜单栏：
 *
 *    📁 共享技能 › C:\Users\...\skills › 12 个技能   [设置] [窗口] [帮助] [关于]
 *
 *  为什么自绘而不用 Electron 原生菜单：
 *    无边框窗口（titleBarStyle: 'hidden'）下原生菜单栏不显示，
 *    而窗口控件叠加（titleBarOverlay）已经在右上角占了位置。
 *    自绘能保证和面包屑在同一行、视觉统一。
 *
 *  菜单项：
 *    设置 ▾  共享技能真源地址… / 重新绑定所有端… / 智能体管理… / 恢复默认地址
 *    窗口 ▾  最小化 / 最大化|还原 / 重新加载 / 开发者工具 / 关闭
 *    帮助 ▾  使用说明 / 配置文件位置 / 关于
 *    关于    版本与许可
 *
 * ============================================================================
 */

(function () {
  'use strict';

  const CSS = `
/* 侧边栏顶部的菜单容器 —— 与主区面包屑同高，两者在同一条水平线上 */
.sw-side-menu {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-bottom: 1px solid var(--sw-line-soft, #232833);
  background: var(--sw-canvas-deep, #0f1115);
  -webkit-app-region: drag;   /* 空白处也能拖动窗口 */
}

/* 菜单栏容器 */
.sw-menubar {
  display: flex;
  align-items: center;
  gap: 0;
  -webkit-app-region: no-drag;   /* 菜单区本身不当拖拽把手 */
  flex-shrink: 0;
}
.sw-menubar > .sw-menu-root {
  position: relative;
}

/* 顶级菜单按钮 —— 侧栏只有 224px，用紧凑排版 */
.sw-menu-btn {
  display: inline-flex; align-items: center;
  height: 26px; padding: 0 8px;
  border: none; background: transparent;
  border-radius: 6px; cursor: pointer;
  color: var(--sw-muted, #9aa3b2);
  font-family: inherit; font-size: 12px; font-weight: 500;
  transition: background-color .13s, color .13s;
  -webkit-app-region: no-drag;
}
.sw-menu-btn:hover { background: var(--sw-card-hover, #232833); color: var(--sw-ink, #eef1f6); }
.sw-menu-btn.open {
  background: var(--sw-accent-soft, rgba(240,163,74,.14));
  color: var(--sw-accent, #f0a34a);
}

/* 下拉面板 —— 从菜单按钮下方展开 */
.sw-dropdown {
  position: absolute; top: calc(100% + 6px); left: 0;
  min-width: 232px; z-index: 800;
  background: #1b1f27;
  border: 1px solid #2b313d;
  border-radius: 10px;
  box-shadow: 0 16px 44px rgba(0,0,0,.55);
  padding: 5px;
  animation: swMenuIn .13s cubic-bezier(.32,.72,0,1);
}
@keyframes swMenuIn { from { opacity:0; transform: translateY(-5px) } to { opacity:1; transform:none } }

.sw-menu-item {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  width: 100%; padding: 7px 11px; border-radius: 7px;
  border: none; background: transparent; cursor: pointer;
  color: #d5dae3; font-family: inherit; font-size: 12.5px;
  text-align: left;
  transition: background-color .12s, color .12s;
}
.sw-menu-item:hover { background: var(--sw-accent-soft, rgba(240,163,74,.14)); color: #fff; }
.sw-menu-item.disabled { color: #5c6474; cursor: default; }
.sw-menu-item.disabled:hover { background: transparent; color: #5c6474; }
.sw-menu-item .sc { color: #6b7484; font-size: 11px; font-family: 'JetBrains Mono',Consolas,monospace; }
.sw-menu-item:hover .sc { color: rgba(255,255,255,.6); }

.sw-menu-sep { height: 1px; background: #262c37; margin: 5px 8px; }

.sw-menu-label {
  padding: 7px 11px 4px; font-size: 10px; font-weight: 700;
  letter-spacing: .07em; text-transform: uppercase; color: #6b7484;
}

/* 关于弹窗 */
.sw-about {
  width: min(460px, calc(100vw - 64px));
  background: #1b1f27; border: 1px solid #2b313d; border-radius: 14px;
  box-shadow: 0 28px 70px rgba(0,0,0,.6);
  padding: 26px 26px 22px;
  text-align: center;
  animation: swMenuIn .16s cubic-bezier(.32,.72,0,1);
}
.sw-about-logo {
  width: 56px; height: 56px; margin: 0 auto 14px;
  border-radius: 15px; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(160deg, #2a2f3a, #1c1f27);
  border: 1px solid #333a47;
}
.sw-about h3 { margin: 0 0 4px; font-size: 17px; font-weight: 600; color: #eef1f6; letter-spacing: -.01em; }
.sw-about .ver { font-size: 12px; color: #6b7484; margin-bottom: 16px; }
.sw-about .desc { font-size: 12.5px; line-height: 1.75; color: #9aa3b2; margin-bottom: 18px; text-align: left; }
.sw-about dl {
  display: grid; grid-template-columns: auto 1fr; gap: 7px 14px;
  margin: 0 0 18px; padding: 13px 15px;
  background: #14161b; border: 1px solid #262c37; border-radius: 10px;
  font-size: 11.5px; text-align: left;
}
.sw-about dt { color: #6b7484; }
.sw-about dd {
  margin: 0; color: #d5dae3;
  font-family: 'JetBrains Mono',Consolas,monospace; font-size: 11px;
  word-break: break-all;
}
.sw-about .foot { font-size: 11px; color: #6b7484; line-height: 1.6; }
.sw-about .foot a { color: var(--sw-accent, #f0a34a); text-decoration: none; }
`;

  // ──────────────────────────────────────────── 工具

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  let openMenu = null;

  function closeMenus() {
    if (openMenu) {
      openMenu.btn.classList.remove('open');
      openMenu.panel.remove();
      openMenu = null;
    }
  }

  function buildDropdown(items) {
    const panel = el('div', 'sw-dropdown');
    for (const it of items) {
      if (it === '-' || it.sep) {
        panel.appendChild(el('div', 'sw-menu-sep'));
        continue;
      }
      if (it.label && it.header) {
        panel.appendChild(el('div', 'sw-menu-label', it.label));
        continue;
      }
      const btn = el('button', 'sw-menu-item' + (it.disabled ? ' disabled' : ''));
      btn.appendChild(el('span', null, it.label));
      if (it.shortcut) btn.appendChild(el('span', 'sc', it.shortcut));
      if (!it.disabled) {
        btn.onclick = () => {
          closeMenus();
          if (it.action) it.action();
        };
      }
      panel.appendChild(btn);
    }
    return panel;
  }

  function attachMenu(root, items) {
    const btn = el('button', 'sw-menu-btn', root);
    btn.type = 'button';
    const holder = el('div', 'sw-menu-root');
    holder.appendChild(btn);

    btn.onclick = (e) => {
      e.stopPropagation();
      if (openMenu && openMenu.btn === btn) { closeMenus(); return; }
      closeMenus();
      const panel = buildDropdown(items);
      holder.appendChild(panel);
      btn.classList.add('open');
      openMenu = { btn, panel };
    };

    return holder;
  }

  // ──────────────────────────────────────────── 菜单定义

  function settingsItems() {
    return [
      { label: '共享技能真源地址…', action: () => window.dispatchEvent(new CustomEvent('sw:open-settings')) },
      { label: '重新绑定所有端…', action: () => window.dispatchEvent(new CustomEvent('sw:open-settings', { detail: 'rebind' })) },
      '-',
      { label: '智能体管理…', action: () => window.dispatchEvent(new CustomEvent('sw:open-agent-manager')) },
      '-',
      { label: '恢复默认真源地址', action: restoreDefault },
    ];
  }

  function windowItems() {
    const d = window.skillsDesktop;
    return [
      { label: '最小化', shortcut: 'Win+↓', action: () => d && d.minimize() },
      { label: '最大化 / 还原', shortcut: 'Win+↑', action: () => d && d.toggleMaximize() },
      '-',
      { label: '重新加载', shortcut: 'Ctrl+R', action: () => location.reload() },
      { label: '开发者工具', shortcut: 'Ctrl+Shift+I', action: toggleDevTools },
      '-',
      { label: '关闭', shortcut: 'Alt+F4', action: () => d && d.closeWindow() },
    ];
  }

  function helpItems() {
    const d = window.skillsDesktop;
    return [
      {
        label: '使用说明（README）',
        action: async () => {
          try {
            const info = await d.appInfo();
            d.openPath(info.readme);
          } catch (e) { /* ignore */ }
        },
      },
      {
        label: '打开配置目录',
        action: async () => {
          try {
            const info = await d.appInfo();
            d.openPath(info.configFile);
          } catch (e) { /* ignore */ }
        },
      },
      '-',
      { label: '关于本应用', action: showAbout },
    ];
  }

  function toggleDevTools() {
    // 渲染进程不能直接开 devtools，走主进程
    const d = window.skillsDesktop;
    if (d && d.toggleDevTools) d.toggleDevTools();
  }

  async function restoreDefault() {
    const d = window.skillsDesktop;
    if (!d) return;
    try {
      const info = await d.appInfo();
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-canon-root', canonRoot: info.defaultCanonRoot || '' }),
      });
      const r = await res.json();
      window.dispatchEvent(new CustomEvent('sw:toast', {
        detail: { msg: r.message || '已恢复默认地址', kind: 'ok' },
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('sw:toast', {
        detail: { msg: '操作失败：' + e.message, kind: 'err' },
      }));
    }
  }

  // ──────────────────────────────────────────── 关于

  async function showAbout() {
    const d = window.skillsDesktop;
    let info = {};
    try { info = await d.appInfo(); } catch (e) { /* ignore */ }

    const back = el('div', 'sw-set-backdrop');
    back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });

    const box = el('div', 'sw-about');

    const logo = el('div', 'sw-about-logo');
    logo.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#f0a34a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
    box.appendChild(logo);

    box.appendChild(el('h3', null, info.name || 'Skillsmith'));
    if (info.subtitle) {
      box.appendChild(el('p', 'sw-about-sub', info.subtitle));
    }
    box.appendChild(el('div', 'ver', '版本 ' + (info.version || '1.0.0')));

    box.appendChild(el('div', 'desc',
      '控制各家 AI 工具共享技能的开关状态。' +
      '共享技能真源只读，任何操作都不会删除真源内容 —— ' +
      '「关闭」只是让某个工具看不见该技能。'));

    const dl = el('dl');
    const add = (k, v) => {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, v));
    };
    add('Electron', info.electron || '-');
    add('Chromium', info.chrome || '-');
    add('Node.js', info.node || '-');
    add('平台', info.platform || '-');
    add('真源', info.canonRoot || '-');
    box.appendChild(dl);

    const foot = el('div', 'foot');
    foot.innerHTML =
      '界面复用开源项目 <a href="https://github.com/whale2002/skills-switch">whale2002/skills-switch</a>（MIT）。' +
      '<br>各端适配与真源保护逻辑为本机自有实现。';
    box.appendChild(foot);

    const btn = el('button', 'sw-set-btn primary', '关闭');
    btn.style.marginTop = '18px';
    btn.onclick = () => back.remove();
    box.appendChild(btn);

    back.appendChild(box);
    document.body.appendChild(back);
  }

  // ──────────────────────────────────────────── 挂载

  /**
   * 挂载菜单栏。
   *
   * 位置：侧边栏顶部 —— 也就是原来「🌙 Skillsmith」logo 的位置。
   * 那块标题已经不要了（窗口标题栏的位置交给了路径面包屑），
   * 换成菜单栏正好，和普通 Windows 软件一致：
   *   左上角 = 菜单（设置/窗口/帮助/关于），右边 = 路径信息。
   *
   * 侧边栏只有 224px 宽，菜单项用紧凑排版（12px 字、7px 内边距）才放得下。
   */
  function mount() {
    if (document.querySelector('.sw-menubar')) return true;

    const aside = document.querySelector('aside');
    if (!aside) return false;

    // 侧栏顶部容器（与面包屑同高 44px）
    let holder = aside.querySelector('.sw-side-menu');
    if (!holder) {
      // 隐藏原标题块（logo + 应用名）
      const brand = aside.children[0];
      if (brand && brand.tagName === 'DIV' && !brand.classList.contains('sw-side-menu')) {
        brand.classList.add('sw-brand');
      }
      holder = el('div', 'sw-side-menu');
      holder.title = '按住空白处可拖动窗口';
      aside.insertBefore(holder, aside.firstChild);
    }

    const bar = el('div', 'sw-menubar');
    bar.appendChild(attachMenu('设置', settingsItems()));
    bar.appendChild(attachMenu('窗口', windowItems()));
    bar.appendChild(attachMenu('帮助', helpItems()));

    const aboutBtn = el('button', 'sw-menu-btn', '关于');
    aboutBtn.type = 'button';
    aboutBtn.onclick = (e) => { e.stopPropagation(); closeMenus(); showAbout(); };
    bar.appendChild(aboutBtn);

    holder.appendChild(bar);
    return true;
  }

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
      return;
    }
    if (!document.getElementById('sw-menubar-style')) {
      const style = document.createElement('style');
      style.id = 'sw-menubar-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    if (mount()) return;
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        if (mount()) obs.disconnect();
      }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // 点击别处关闭菜单
  document.addEventListener('mousedown', (e) => {
    if (openMenu && !e.target.closest('.sw-menu-root')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });

  start();
})();
