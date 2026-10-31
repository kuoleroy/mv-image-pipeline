/**
 * 桌面版增强：向顶部条注入批量操作工具栏
 * ============================================================================
 *
 *  为什么需要注入而不是改 React：
 *  上游 skills-switch 的 React 组件没有批量操作入口（只有单卡开关与删除）。
 *  但本机后端已经有 /api/bulk（on / off / lean 三档），
 *  而且「普通对话默认关掉 skills、用时再开」正是这个工具的核心价值 ——
 *  没有批量开关，这个价值就打了对折。
 *
 *  改 React 源码需要重新构建上游项目，成本高且会与上游产生分叉。
 *  改成运行时注入：观察顶部条出现后，往里插一个 DOM 节点。
 *  注入的按钮走同一条 /api/bulk 接口，与后端逻辑完全一致。
 *
 *  浏览器版没有这个脚本 —— 只有桌面版 index.html 才引入它。
 * ============================================================================
 */

(function () {
  'use strict';

  const BTN = {
    off: { text: '全部关闭', cls: 'sw-danger', title: '关闭所有技能，省 token。普通对话推荐' },
    lean: { text: '精简模式', cls: '', title: '只保留常用技能，其余关闭' },
    on: { text: '全部开启', cls: 'sw-accent', title: '开启所有技能' },
  };

  function makeButton(key, spec) {
    const b = document.createElement('button');
    b.textContent = spec.text;
    b.className = spec.cls;
    b.title = spec.title;
    b.addEventListener('click', async () => {
      // 全部禁用是破坏性稍强的操作，给一次确认
      if (key === 'off' && !window.confirm('确定关闭全部技能？\n\n普通对话推荐这样，能显著减少 token 消耗。\n随时可以在面板里重新打开单个技能。')) {
        return;
      }
      const buttons = document.querySelectorAll('.sw-toolbar button');
      buttons.forEach((x) => (x.disabled = true));
      try {
        await fetch('/api/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: key }),
        });
        // 触发 React 重新拉数据：模拟点击当前选中的 agent 标签。
        // 上游在切换 agent 时会重新 fetch /api/agents 并 setState。
        const active = document.querySelector('main > .sw-tabbar button.bg-surface-card')
          || document.querySelector('main > .sw-tabbar button');
        if (active) active.click();
        else location.reload();
      } catch (e) {
        alert('操作失败：' + e.message);
      } finally {
        buttons.forEach((x) => (x.disabled = false));
      }
    });
    return b;
  }

  /**
   * 工具栏插进侧边栏的 nav 里。
   *
   * 为什么放侧边栏而不是内容区：
   *  · 侧边栏不滚动 —— 工具条不会被卡片盖住，也不会跟着内容跑
   *  · 「批量开关」本质是全局操作，和旁边的「全局」作用域按钮同属一类，
   *    放一起语义自洽
   *  · 内容区顶部要留给标签栏换行后的空间，塞工具条会打架
   *
   * 为什么用 order 而非依赖 DOM 顺序：
   *  nav 是 React 渲染的，重渲染时子节点可能被重排。order 是 flex 的
   *  视觉顺序，与 DOM 顺序无关，所以无论 React 怎么动，工具条都排在最后。
   */
  function inject() {
    if (document.querySelector('.sw-toolbar')) return;

    const nav = document.querySelector('aside nav');
    if (!nav) return false;   // React 还没渲染出侧边栏

    const toolbar = document.createElement('div');
    toolbar.className = 'sw-toolbar';

    for (const key of ['off', 'lean', 'on']) {
      toolbar.appendChild(makeButton(key, BTN[key]));
    }

    nav.appendChild(toolbar);
    return true;
  }

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
      return;
    }
    if (inject()) return;

    // React 是异步渲染的：DOMContentLoaded 时侧边栏可能还不存在。
    // 用 MutationObserver 等它出现，注入一次后就停止观察。
    // 加节流：React 重渲染频繁，不节流会持续空转。
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        if (inject()) obs.disconnect();
      }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  start();
})();
