/**
 * skillswitcher 适配层服务
 *
 * ─────────────────────────────────────────────────────────────
 *  前端复用开源项目 skills-switch（MIT, whale2002/skills-switch）
 *  的 React 界面（vendor/assets/），本文件只实现它需要的 API 契约。
 *  这样做的原因：界面的布局、卡片、开关交互、响应式都是现成的，
 *  不必重写；而它的后端机制层不适用于本机的架构，故替换。
 *
 *  与上游后端的差异（这就是必须替换的原因）：
 *   1. 上游扫描用 readdirSync(withFileTypes) + entry.isDirectory()，
 *      Windows 上 Junction 被判为 symlink → 全部技能扫不到（实测 0 个）。
 *      本机 core.js 用 fs.stat 语义，只认真源 + 直接 junction。
 *   2. 上游开关用「目录改名加 .disabled 后缀」。本机 CodeArts 只认
 *      UserSkillStatus.txt 清单（name=false=禁用），改名无效。
 *   3. 上游删除用 fs.rmSync 直删。本机真源是共享的，绝不能删。
 *
 *  API 契约（照抄上游，前端零改动即可工作）：
 *    GET    /api/agents?scope=global&cwd=
 *      → [{ agent, displayName, installed, skills: [{name, displayName, description, enabled}] }]
 *    POST   /api/skills/:name/toggle   body: {agent, scope, cwd}
 *      → 同上单个 skill 对象
 *    DELETE /api/skills/:name           body: {agent, scope, cwd, thorough}
 *    GET    /api/projects  → [path]
 *    POST   /api/projects  body: {path}
 *
 *  额外提供（上游没有，但本机需要）：
 *    GET  /api/state   → 完整矩阵 + token 估算 + 操作日志
 *    POST /api/bulk    body: {action: on|off|lean, agent}
 *    GET  /api/health
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const core = require('./core');
const agentConfig = require('./agent-config.js');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SKILLSWITCH_PORT || 17888);

// 静态资源目录（前端界面）。
// 开发态：server.js 在 skillswitcher/ 上一级被 require，vendor 在同级
// 打包态：server.js 与 vendor 一起平铺进 app.asar，同级
// 两处都成立，取存在的那个即可。
const VENDOR_DIR = [
  path.join(__dirname, 'vendor'),
  path.join(__dirname, '..', 'vendor'),
].find((p) => fs.existsSync(p)) || path.join(__dirname, 'vendor');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/** 操作日志（内存，重启即失） */
const opLog = [];
function logOp(entry) {
  opLog.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  if (opLog.length > 200) opLog.length = 200;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 上游契约转换

/**
 * 把内部快照转成上游前端要的 skill 对象。
 * 前端只用 name / displayName / description / enabled 四个字段。
 */
function toUpstreamSkill(row, agentName) {
  const cell = row.cells[agentName];
  return {
    name: row.name,
    displayName: row.title || row.name,
    description: row.description || '',
    enabled: !!cell.on,
  };
}

/** 单个 agent 的上游视图 */
function agentView(agentName, cfg, rows) {
  return {
    agent: agentName,
    displayName: agentName,
    installed: fs.existsSync(cfg.dir),
    // 只列出「归属」这一端的技能。
    // 归属规则见 core.AGENT_ONLY / AGENT_EXCLUDE —— 例如 codebase-crossrepo-pipeline
    // 只属于 CodeArts，browser-cli-skill 不属于 CodeArts。
    // 若不过滤，前端会把「不归属」误显示成「未安装」。
    skills: rows
      .filter((r) => core.applicableTo(r.name, agentName))
      .map((r) => toUpstreamSkill(r, agentName)),
  };
}

/** 全量快照 + token 估算 */
function fullState() {
  const snap = core.snapshot();
  for (const a of snap.agents) {
    a.tokens = core.estimateTokens(a.name);
  }
  let maxChars = 0;
  for (const r of snap.rows) maxChars += r.name.length + r.description.length + 4;
  snap.maxTokens = Math.round(maxChars / 3.6);
  snap.log = opLog.slice(0, 40);
  return snap;
}

// ---------------------------------------------------------------- 路由

/**
 * 创建 HTTP 服务（不监听）。
 * 抽出来是为了让 Electron 主进程能内嵌同一个服务 —— 桌面版与浏览器版
 * 共用一套 API 实现，避免两套逻辑漂移。
 *
 * @param {boolean} desktop 是否为桌面版形态（影响注入的工具栏与窗口控件）
 */
function createServer(desktop = false) {
  const isDesktop = desktop;
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    // ============ 上游契约：GET /api/agents ============
    if (p === '/api/agents' && req.method === 'GET') {
      const scope = url.searchParams.get('scope') || 'global';
      const snap = core.snapshot();
      // 项目作用域上游是扫描 cwd 下的目录，本机只做全局（项目级技能未接入）
      const view = scope === 'global'
        ? Object.entries(core.AGENTS).map(([name, cfg]) => agentView(name, cfg, snap.rows))
        : [];
      return sendJson(res, 200, view);
    }

    // ============ 上游契约：POST /api/skills/:name/toggle ============
    const toggleMatch = p.match(/^\/api\/skills\/([^/]+)\/toggle$/);
    if (toggleMatch && req.method === 'POST') {
      const name = decodeURIComponent(toggleMatch[1]);
      const body = await readBody(req);
      const agent = body.agent;
      if (!agent) {
        return sendJson(res, 400, { error: 'agent is required' });
      }
      const snap = core.snapshot();
      const row = snap.rows.find((r) => r.name === name);
      if (!row) {
        return sendJson(res, 404, { error: `Skill not found: ${name}` });
      }

      // agent = 'all' 时对所有相关端生效。
      // 上游前端在 All 视图只传 agents[0].agent，但它的设计是「一个技能一处开关」；
      // 本机是多端共享同一真源，开关一个技能应当对所有端一致，
      // 否则会出现「面板显示开、实际只有一端开」的错觉。
      const onlyAgent = agent === 'all' || agent === 'ALL' ? null : agent;
      if (onlyAgent && !core.AGENTS[onlyAgent]) {
        return sendJson(res, 404, { error: `Unknown agent: ${onlyAgent}` });
      }

      // 该技能在目标端上当前是否开启（多端时看是否有任一端开着）
      const relevant = onlyAgent
        ? [onlyAgent]
        : Object.keys(core.AGENTS).filter((a) => core.targetsFor(name, a).length > 0);
      const currentlyOn = relevant.some((a) => row.cells[a] && row.cells[a].on);

      const results = currentlyOn
        ? core.disable(name, onlyAgent)
        : core.enable(name, onlyAgent);
      logOp({
        action: currentlyOn ? 'disable' : 'enable',
        skill: name,
        agent: onlyAgent || 'ALL',
        results,
      });

      const after = core.snapshot();
      const afterRow = after.rows.find((r) => r.name === name);
      const targetAgent = onlyAgent || relevant[0] || Object.keys(core.AGENTS)[0];
      return sendJson(res, 200, toUpstreamSkill(afterRow, targetAgent));
    }

    // ============ 上游契约：DELETE /api/skills/:name ============
    const delMatch = p.match(/^\/api\/skills\/([^/]+)$/);
    if (delMatch && req.method === 'DELETE') {
      const name = decodeURIComponent(delMatch[1]);
      const body = await readBody(req);
      const agent = body.agent;
      if (!agent) {
        return sendJson(res, 400, { error: 'agent is required' });
      }
      const onlyAgent = agent === 'all' || agent === 'ALL' ? null : agent;
      // 真源绝不能删。这里只做「从各端摘除」，等价于关闭。
      // 真源本身保留 —— 它是所有端的唯一来源。
      const results = core.disable(name, onlyAgent, body.thorough === true);
      logOp({ action: 'delete-as-disable', skill: name, agent: onlyAgent || 'ALL', results });
      return sendJson(res, 200, { success: true, results });
    }

    // ============ 上游契约：projects ============
    if (p === '/api/projects' && req.method === 'GET') {
      // 会话内存储即可，上游也是 Set
      return sendJson(res, 200, []);
    }
    if (p === '/api/projects' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path) {
        return sendJson(res, 400, { error: 'path is required' });
      }
      return sendJson(res, 200, { success: true });
    }

    // ============ 扩展：智能体（Agent 端）管理 ============
    // 列出全部端（含未安装的、自定义的），供「智能体管理」面板使用
    if (p === '/api/agent-config' && req.method === 'GET') {
      return sendJson(res, 200, {
        agents: agentConfig.listAgents(),
        configFile: agentConfig.CONFIG_FILE,
      });
    }

    // 新增 / 更新 / 删除一个端
    if (p === '/api/agent-config' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action || 'save';
      const remove = action === 'remove';

      if (action === 'reset') {
        const r = agentConfig.resetAgents();
        logOp({ action: 'agent-config-reset' });
        return sendJson(res, 200, { ...r, agents: agentConfig.listAgents() });
      }

      const data = body.agent || body;
      if (!data || !data.id) {
        return sendJson(res, 400, { ok: false, message: 'id is required' });
      }
      if (!remove && (!data.name || !data.dir)) {
        return sendJson(res, 400, { ok: false, message: 'name and dir are required' });
      }

      let r;
      try {
        r = agentConfig.saveAgent(data, action === 'remove');
      } catch (e) {
        return sendJson(res, 500, { ok: false, message: e.message });
      }
      logOp({ action: 'agent-config-' + action, id: data.id, name: data.name });

      // 只返回端列表，不返回完整状态矩阵 ——
      // snapshot() 要做上百次文件系统探测，放在写配置这个同步路径上会
      // 让 POST 卡住近一秒。前端拿到列表后自行重新拉 /api/state 即可。
      return sendJson(res, 200, {
        ...r,
        agents: agentConfig.listAgents(),
      });
    }

    // ============ 扩展：设置（共享技能真源地址） ============
    if (p === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, core.settings.all());
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action || 'set';

      if (action === 'set-canon-root') {
        const r = core.settings.setCanonRoot(body.canonRoot);
        logOp({ action: 'set-canon-root', canonRoot: r.canonRoot });
        if (!r.ok) return sendJson(res, 400, r);
        // 真源变了，清掉按旧路径缓存的 realpath 结果
        core.clearCanonCache();
        // 顺便把当前状态带回去，前端可以立即刷新
        return sendJson(res, 200, { ...r, settings: core.settings.all() });
      }

      if (action === 'rebind') {
        const r = core.rebindAll({
          onlyAgent: body.agent && body.agent !== 'all' ? body.agent : null,
          dryRun: body.dryRun === true,
          missing: body.missing,
        });
        logOp({ action: 'rebind', changed: r.changed, dryRun: !!body.dryRun });
        return sendJson(res, 200, r);
      }

      return sendJson(res, 400, { ok: false, message: '未知 action' });
    }

    // ============ 扩展：完整矩阵 ============
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, fullState());
    }

    // ============ 扩展：批量开关 ============
    if (p === '/api/bulk' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action;
      if (!['on', 'off', 'lean'].includes(action)) {
        return sendJson(res, 400, { ok: false, message: 'action 需为 on/off/lean' });
      }
      const onlyAgent = body.agent && body.agent !== 'ALL' && body.agent !== 'all'
        ? body.agent : null;
      const report = core.bulk(action, onlyAgent);
      logOp({ action: 'bulk-' + action, agent: onlyAgent || 'ALL', count: report.length });
      return sendJson(res, 200, { ok: true, report, state: fullState() });
    }

    // ============ 扩展：健康检查 ============
    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        canonRoot: core.CANON_ROOT,
        agents: Object.keys(core.AGENTS),
        skills: core.listSkills().length,
      });
    }

    // ============ 静态资源（上游 React 界面） ============
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    // path.normalize 在 Windows 上会把 '/' 转成 '\'，
    // 所以判断是不是根页面要用归一化后的路径再比一次。
    const isIndex = file.replace(/\\/g, '/') === '/index.html';
    const full = path.join(VENDOR_DIR, file);
    if (!full.startsWith(VENDOR_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();

    // index.html 需要按运行形态微调：
    //  · 桌面版：注入批量操作工具栏 + 用原生窗口控件替代浏览器控件
    //  · 浏览器版：保持纯上游界面，不注入
    if (ext === '.html' && isIndex) {
      let html = fs.readFileSync(full, 'utf8');
      if (isDesktop) {
        // 桌面版注入：批量工具栏 + 智能体管理 + 面包屑/设置 + 菜单栏
        html = html.replace(
          '</body>',
          '  <script src="/desktop-enhance.js"></script>\n' +
          '  <script src="/agent-manager.js"></script>\n' +
          '  <script src="/settings-panel.js"></script>\n' +
          '  <script src="/app-menu.js"></script>\n  </body>'
        );
      }
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    const data = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    return res.end(data);
  } catch (e) {
    return sendJson(res, 500, { ok: false, message: e.message });
  }
  });
}

/**
 * 监听并可选地打开浏览器（浏览器版入口）。
 * @param {number} port 0 表示随机端口（Electron 内嵌时用，避免端口冲突）
 */
function start(port = PORT, openBrowser = true) {
  return new Promise((resolve, reject) => {
    const s = createServer(process.env.SKILLSWITCH_DESKTOP === '1');
    s.once('error', reject);
    s.listen(port, HOST, () => {
      const actual = s.address().port;
      const url = `http://${HOST}:${actual}/`;
      console.log('Skillsmith（智能体技能管理软件）已启动：' + url);
      console.log('真源（只读）：' + core.CANON_ROOT);
      console.log('前端：复用开源 skills-switch（MIT）');
      if (openBrowser && process.env.SKILLSWITCH_NO_OPEN !== '1') {
        const opener = process.platform === 'win32' ? 'start ""' : 'open';
        exec(`${opener} "${url}"`);
      }
      resolve({ server: s, port: actual, url });
    });
  });
}

// 直接执行时 = 浏览器版；被 require 时只导出，由调用方决定何时监听。
if (require.main === module) {
  start(PORT).catch((e) => {
    console.error('启动失败：' + e.message);
    process.exit(1);
  });
}

module.exports = { createServer, start, HOST, PORT };
