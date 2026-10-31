# -*- coding: utf-8 -*-
"""跨 Agent 共享 Skills：单一真源 + 多端软链分发。

问题
----
每个 Agent 有自己的 skills 目录（Claude Code -> ~/.claude/skills，
Codex/Cursor/Copilot -> ~/.agents/skills，CodeBuddy -> ~/.codebuddy/skills，
WorkBuddy -> ~/.workbuddy/skills ...）。同一份 Skill 复制到多处必然不同步。

解法
----
1. 选一个规范真源（canonical），默认 ~/.agents/skills/<name>
2. 其他 Agent 目录里放软链（Linux/macOS symlink / Windows junction）指向它
3. 改真源一次，所有 Agent 同时生效

Windows 注意
------------
- `.workbuddy` 目录不允许创建 symlink（ln -s 报 Operation not permitted），
  必须用 junction（New-Item -ItemType Junction），不需要管理员权限。
- 建 junction 前目标路径必须不存在，且不能是空目录。

用法
----
    python share_skills.py list                    # 扫描本机各 agent 的 skills 目录
    python share_skills.py link <name>             # 把 <name> 软链到所有已装 agent
    python share_skills.py link <name> --from <dir> # 指定真源
    python share_skills.py unlink <name>           # 解除软链（保留真源）
    python share_skills.py status <name>           # 查看某 skill 的分发状态
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

# 各 agent 的 skills 目录候选（相对 home）。第一个存在的即为已安装。
AGENT_DIRS = [
    ("WorkBuddy", "~/.workbuddy/skills"),
    ("WorkBuddy 国际版", "~/.workbuddy-ai/skills"),
    ("Claude Code", "~/.claude/skills"),
    ("Codex/Cursor/Copilot 等", "~/.agents/skills"),
    ("CodeBuddy", "~/.codebuddy/skills"),
    ("Codex(旧)", "~/.codex/skills"),
    ("Gemini CLI", "~/.gemini/skills"),
    ("OpenCode", "~/.config/opencode/skills"),
    ("Windsurf", "~/.codeium/windsurf/skills"),
    ("Trae 国际版", "~/.trae/skills"),
    ("Trae 国内版 (CN)", "~/.trae-cn/skills"),
    ("Qwen Code", "~/.qwen/skills"),
    ("Kiro", "~/.kiro/skills"),
    ("Cline/Roo", "~/.cline/skills"),
    ("Amp/Replit/Universal", "~/.config/agents/skills"),
    ("华为 CodeArts Doer", "~/.codeartsdoer/skills"),
    ("阿里 Qoder", "~/.qoder/skills"),
]

CANON_ROOT = os.path.expanduser("~/.agents/skills")

# 这些 Agent 的 skill 扫描会硬过滤掉 junction/symlink
# （过滤条件含 `!isSymbolicLink() && isDirectory()`，Windows Junction 被判为 symlink），
# 所以只能给它们装**真实目录副本**，软链会被整个跳过。
# 实测：华为 CodeArts 的 11 个 junction 全部未被加载，真实目录探针可通过。
REAL_DIR_ONLY_AGENTS = {"华为 CodeArts Doer"}

# 天翼 TeleAgent：用户 ID 随账号变化，用 glob 动态发现。
TELEAGENT_ROOT = "~/.config/TeleAgent"


def discover_teleagent_dirs():
    """发现 TeleAgent 的用户级 skills 目录（路径含 user_id，不能硬编码）。"""
    import glob
    pat = os.path.expanduser(os.path.join(TELEAGENT_ROOT, "users", "*", "skills"))
    return [p for p in sorted(glob.glob(pat)) if os.path.isdir(p)]


def agent_targets(agents=None):
    """返回本机已装 agent 的 (name, dir) 列表，可按名称过滤。"""
    out = []
    for agent, rel in AGENT_DIRS:
        d = os.path.expanduser(rel)
        if os.path.isdir(d):
            out.append((agent, d))
    for d in discover_teleagent_dirs():
        out.append(("TeleAgent(天翼)", d))
    if agents:
        out = [(a, d) for a, d in out if a in agents]
    return out


def is_junction(path):
    """Windows junction 检测。Python 3.12+ 有 os.path.isjunction；
    更早版本可用 stat 的 FILE_ATTRIBUTE_REPARSE_POINT + DIRECTORY 组合判断。"""
    if os.name != "nt":
        return False
    try:
        if hasattr(os.path, "isjunction"):
            return os.path.isjunction(path)
    except OSError:
        return False
    # 兜底：reparse point 且是目录 → 视为 junction
    try:
        import stat as _stat
        st = os.lstat(path)
        attrs = getattr(st, "st_file_attributes", 0)
        reparse = getattr(_stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return bool(attrs & reparse) and bool(attrs & _stat.FILE_ATTRIBUTE_DIRECTORY)
    except (OSError, AttributeError):
        return False


def is_link(path):
    """junction 或 symlink 都算「链接」。"""
    if is_junction(path):
        return True
    try:
        return os.path.islink(path)
    except OSError:
        return False


def link_target(path):
    try:
        return os.path.realpath(path)
    except OSError:
        return None


def cmd_list():
    print("扫描本机 Agent skills 目录：\n")
    found = 0
    for name, d in agent_targets():
        n = len([x for x in os.listdir(d) if not x.startswith('.')])
        print("  [有] %-26s %s   (%d 个 skill)" % (name, d, n))
        found += 1
    if not found:
        print("  未发现任何 Agent skills 目录")
    return 0


def cmd_status(name):
    canon = os.path.join(CANON_ROOT, name)
    print("Skill: %s\n" % name)
    print("  规范真源: %s" % (canon if os.path.exists(canon) else "（不存在）"))
    print("\n  各 Agent 端：")
    for agent, d in agent_targets():
        p = os.path.join(d, name)
        if not os.path.exists(p) and not is_link(p):
            continue
        if is_link(p):
            tgt = link_target(p)
            same = " ← 指向真源" if tgt and os.path.normcase(tgt) == os.path.normcase(os.path.realpath(canon)) else " ← 指向别处"
            print("    %-26s %s  [软链]%s" % (agent, d, same))
        else:
            print("    %-26s %s  [真实副本，独立]" % (agent, d))
    return 0


def _make_link(src, dst):
    """创建软链；Windows 用 junction，POSIX 用 symlink。"""
    if os.name == "nt":
        # junction 要求目标路径不存在
        if os.path.exists(dst) and not os.path.isdir(dst):
            raise RuntimeError("目标已存在且非目录: %s" % dst)
        ps = ('New-Item -ItemType Junction -Path "%s" -Target "%s" | Out-Null'
              % (dst.replace('"', '""'), src.replace('"', '""')))
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("junction 创建失败: %s" % (r.stderr or r.stdout).strip())
    else:
        os.symlink(src, dst)


def _realdir_matches(dst, src):
    """真实目录副本是否已与真源一致（比文件数 + SKILL.md 的 md5）。"""
    import hashlib
    if not os.path.isdir(dst) or is_link(dst):
        return False
    for rel in ("SKILL.md",):
        a, b = os.path.join(src, rel), os.path.join(dst, rel)
        if not (os.path.isfile(a) and os.path.isfile(b)):
            return False
        if hashlib.md5(open(a, "rb").read()).hexdigest() != \
           hashlib.md5(open(b, "rb").read()).hexdigest():
            return False

    def count(root):
        n = 0
        for _, _, files in os.walk(root):
            n += len(files)
        return n

    return count(src) == count(dst)


def cmd_link(name, src=None, agents=None):
    canon = os.path.abspath(src) if src else os.path.join(CANON_ROOT, name)
    if not os.path.isdir(canon):
        print("找不到真源: %s" % canon, file=sys.stderr)
        return 1
    src_real = os.path.realpath(canon)

    targets = []
    for agent, d in agent_targets(agents):
        p = os.path.join(d, name)
        if agent in REAL_DIR_ONLY_AGENTS:
            # 真实目录副本：内容已一致就跳过，避免每次都重拷一遍
            if _realdir_matches(p, src_real):
                continue
        elif os.path.realpath(p) == src_real if os.path.exists(p) else False:
            continue                                    # 已经指向真源
        targets.append((agent, d, p))

    if not targets:
        print("无需处理：所有已装 Agent 都已指向 %s" % src_real)
        return 0

    ok, fail = 0, 0
    for agent, d, p in targets:
        try:
            if agent in REAL_DIR_ONLY_AGENTS:
                # 该端只认真实目录：复制副本，而不是建 junction
                if os.path.exists(p) or is_link(p):
                    if is_link(p):
                        _remove_link(p)
                    else:
                        bak = p + ".bak"
                        if os.path.exists(bak):
                            shutil.rmtree(bak, ignore_errors=True)
                        os.rename(p, bak)
                shutil.copytree(src_real, p, symlinks=False)
                print("  [副本] %-26s %s" % (agent, p))
                ok += 1
                continue
            if os.path.exists(p) or is_link(p):
                # 已有真实副本 -> 备份后替换为软链
                bak = p + ".bak"
                if os.path.exists(bak):
                    shutil.rmtree(bak, ignore_errors=True)
                os.rename(p, bak)
            _make_link(src_real, p)
            print("  [链接] %-26s %s" % (agent, p))
            ok += 1
        except Exception as e:
            print("  [失败] %-26s %s —— %s" % (agent, p, e), file=sys.stderr)
            fail += 1

    print("\n完成：%d 个链接成功，%d 个失败" % (ok, fail))
    print("真源: %s" % src_real)
    print("提示：改真源一次，所有 Agent 同时生效。")
    print("（%s 只认真实目录，用的是副本而非软链）"
          % "、".join(sorted(REAL_DIR_ONLY_AGENTS)))
    return 0 if fail == 0 else 1


def _remove_link(path):
    """移除目录链接（junction/symlink），不碰目标内容。

    Windows 上 os.unlink 对 junction 会失败（被当成目录），
    shutil.rmtree 更危险 —— 会顺着 junction 删掉真源。走 .NET API
    只摘 reparse point。
    """
    if os.name == "nt" and is_junction(path):
        ps = ('[System.IO.Directory]::Delete("%s", $false)'
              % path.replace('"', '""'))
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("junction 移除失败: %s" % (r.stderr or r.stdout).strip())
        return
    os.unlink(path)


def cmd_unlink(name, keep_source=True):
    n = 0
    for agent, d in agent_targets():
        p = os.path.join(d, name)
        if is_link(p):
            try:
                _remove_link(p)
                print("  [解除] %s" % p)
                n += 1
            except (OSError, RuntimeError) as e:
                print("  [失败] %s —— %s" % (p, e), file=sys.stderr)
    print("解除 %d 处软链" % n)
    return 0


def main():
    ap = argparse.ArgumentParser(description="跨 Agent 共享 Skills")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="扫描本机各 agent 的 skills 目录")

    p = sub.add_parser("status", help="查看某 skill 的分发状态")
    p.add_argument("name")

    p = sub.add_parser("link", help="把 skill 软链到所有已装 agent")
    p.add_argument("name")
    p.add_argument("--from", dest="src", help="指定真源目录")
    p.add_argument("--agents", nargs="*", help="只处理指定 agent")

    p = sub.add_parser("unlink", help="解除软链")
    p.add_argument("name")

    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list()
    if args.cmd == "status":
        return cmd_status(args.name)
    if args.cmd == "link":
        return cmd_link(args.name, args.src, args.agents)
    if args.cmd == "unlink":
        return cmd_unlink(args.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
