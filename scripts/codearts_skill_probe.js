// 复刻 CodeArts agentkernel 的 skill 发现与注入逻辑，验证 UserSkillStatus.txt 的实际效果。
// 源码出处：C:/Program Files/CodeArts Agent/resources/app/extensions/vscode-codebot/agentkernelServer-win32-x64.exe
//   x_  = readDisableSkillConfig
//   K_  = 发现（readdir + !isSymbolicLink && isDirectory）
//   B0  = loadSkillFromFile（disabled = map.get(frontmatter.name)）
//   T_  = getActivatedSkills（filter !disabled）  <- prompt 注入用的就是这个
const fs = require("fs");
const path = require("path");
const os = require("os");

// 默认路径从用户主目录推导，不写死用户名 —— 这样仓库可以公开，
// 别人 clone 下来改都不用改。
const SKILLS_DIR =
  process.argv[2] || path.join(os.homedir(), ".codeartsdoer", "skills");
const STATUS_FILE = path.join(SKILLS_DIR, "UserSkillStatus.txt");

// --- x_: readDisableSkillConfig ---
function readDisableSkillConfig(file) {
  const z = new Map();
  if (!fs.existsSync(file)) return z;
  const raw = fs.readFileSync(file, "utf-8");
  if (!raw) return z;
  for (const line of raw.split(/\r?\n/)) {
    const j = line.trim();
    if (!j || j.startsWith("#")) continue;
    const parts = j.split("=").map((w) => w.trim());
    const [Y, q] = parts;
    if (Y && q) {
      if (Y.includes("~") || Y.includes("/") || Y.includes("\\")) continue;
      const W = q.toLowerCase() === "false";
      z.set(Y.toLowerCase(), W);
    }
  }
  return z;
}

// --- B_ : 解析 frontmatter ---
function parseHeader(text) {
  const m = text.match(/^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// --- K_ : 发现 ---
const statusMap = readDisableSkillConfig(STATUS_FILE);
console.log("状态清单解析结果 (key -> disabled):");
for (const [k, v] of statusMap) console.log("   ", k, "->", v);

const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
const passed = entries.filter(
  (q) => !q.name.startsWith(".") && !q.isSymbolicLink() && q.isDirectory()
);
const skipped = entries.filter(
  (q) => !q.name.startsWith(".") && q.isSymbolicLink()
);

console.log("\n扫描结果:");
console.log("  目录内条目:", entries.filter((e) => !e.name.startsWith(".")).length);
console.log("  通过过滤(真实目录):", passed.map((e) => e.name).join(", ") || "（无）");
console.log("  被跳过(junction):  ", skipped.map((e) => e.name).join(", ") || "（无）");

// --- B0 + T_ ---
const all = [];
for (const dirent of passed) {
  const skillMd = path.join(SKILLS_DIR, dirent.name, "SKILL.md");
  if (!fs.existsSync(skillMd)) continue;
  const header = parseHeader(fs.readFileSync(skillMd, "utf-8"));
  if (!header) continue;
  const disabled = statusMap.get(header.name) ?? false;
  all.push({ name: header.name, dir: dirent.name, description: header.description || "", disabled });
}

const activated = all.filter((q) => !q.disabled); // T_ : getActivatedSkills

console.log("\n加载到的技能 (含 disabled 标记):");
for (const s of all) console.log("   ", s.name, "disabled=" + s.disabled);

console.log("\n>>> getActivatedSkills (真正注入 prompt 的):", activated.length, "个");
for (const s of activated) {
  console.log(`   - ${s.name}: ${s.description.slice(0, 60)}...`);
}
const tokens = activated.reduce((a, s) => a + (s.name.length + s.description.length), 0);
console.log("\n注入字符数:", tokens, "≈ tokens:", Math.round(tokens / 2));
