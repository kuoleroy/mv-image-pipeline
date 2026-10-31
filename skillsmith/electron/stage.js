/**
 * 打包前准备：把应用需要的文件平铺到一个独立目录。
 *
 * 为什么要 staging 而不是直接用 ../ 路径：
 *   electron-builder 的 files 模式虽然支持 ../，但跨目录 glob 的行为
 *   在不同版本上不一致，且会把上级目录的无关文件也卷进来。
 *   稳妥做法是把真正需要的文件复制到一个干净的 app/ 目录，
 *   让打包器只处理这个目录 —— 打包产物结构清晰，也不怕误伤。
 *
 * 复制清单：
 *   main.js / preload.js     —— Electron 入口
 *   core.js / server.js      —— 与浏览器版共用的业务逻辑
 *   vendor/                  —— 前端界面（上游 React + 本地主题层 + 离线字体）
 *   assets/                  —— 应用图标
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(__dirname, 'app');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function main() {
  rmrf(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });

  // 入口文件
  for (const f of ['main.js', 'preload.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(STAGE, f));
  }
  // 业务逻辑（与浏览器版共用同一份，避免两套实现漂移）
  for (const f of ['core.js', 'server.js', 'agent-config.js', 'settings.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
  }
  // 前端资源与图标
  copyDir(path.join(ROOT, 'vendor'), path.join(STAGE, 'vendor'));
  copyDir(path.join(ROOT, 'assets'), path.join(STAGE, 'assets'));

  // 打包用的 package.json：去掉 devDependencies（运行时不需要）
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const slim = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: 'main.js',
    author: pkg.author,
    license: pkg.license,
  };
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(slim, null, 2));

  const count = (dir) => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      n += e.isDirectory() ? count(path.join(dir, e.name)) : 1;
    }
    return n;
  };
  console.log(`staging 完成: ${STAGE} (${count(STAGE)} 个文件)`);
}

main();
