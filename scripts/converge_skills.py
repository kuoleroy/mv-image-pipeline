# -*- coding: utf-8 -*-
"""多端 skill 收敛：各端先自建，再汇总到单一真源，最后全端软链。

流程
----
    1. collect  扫描各 agent 的 skills 目录，把散落各端的 skill 收拢到规范真源
                 （同名冲突按 mtime 取新，其余备份为 .conflict-<agent>）
    2. link    把真源里的每个 skill 软链到所有已装 agent 的 skills 目录
    3. status  查看收敛与分发状态

为什么用「先各自建，再收敛」而不是「一开始就软链」
--------------------------------------------------
真实场景里 skill 往往是在某个 agent 会话里现场写出来的（Claude Code 写了个
review skill、CodeBuddy 写了个 deploy skill）。这时它还只存在于那一个端。
如果一开始就要求软链，这些新写的 skill 会自动落到真源；但如果当时真源
还没建好、或该端不支持链接，就会散落各处。本脚本支持两种起点：

    起点 A（推荐）  先建好真源 + 各端软链 -> 各端写的 skill 自动落到真源
    起点 B（事后）  各端已散落 -> collect 收拢 -> link 全端分发

安全约束
--------
- skillhub 托管的 skill（含 _skillhub_meta.json）不参与收敛，
  它们由 marketplace 更新机制管理，搬动会破坏其元数据里的绝对路径。
- 收敛前一律备份，冲突项保留双份，不静默丢弃用户内容。
- 默认 dry-run，加 --apply 才真正动手。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

# 各 agent 的 skills 目录候选（相对 home）
AGENT_DIRS = [
    ("WorkBuddy", "~/.workbuddy/skills"),
    ("Claude Code", "~/.claude/skills"),
    ("Codex/Cursor/Copilot 等", "~/.agents/skills"),
    ("CodeBuddy", "~/.codebuddy/skills"),
    ("Codex(旧)", "~/.codex/skills"),
    ("Gemini CLI", "~/.gemini/skills"),
    ("OpenCode", "~/.config/opencode/skills"),
    ("Windsurf", "~/.codeium/windsurf/skills"),
    ("Trae", "~/.trae/skills"),
    ("Qwen Code", "~/.qwen/skills"),
    ("Kiro", "~/.kiro/skills"),
    ("Cline/Roo", "~/.cline/skills"),
    ("Amp/Replit/Universal", "~/.config/agents/skills"),
]

CANON_ROOT = os.path.expanduser("~/.agents/skills")
META = "_skillhub_meta.json"


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
    try:
        import stat as _stat
        st = os.lstat(path)
        attrs = getattr(st, "st_file_attributes", 0)
        reparse = getattr(_stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return bool(attrs & reparse) and bool(attrs & _stat.FILE_ATTRIBUTE_DIRECTORY)
    except (OSError, AttributeError):
        return False


def is_link(path):
    if is_junction(path):
        return True
    try:
        return os.path.islink(path)
    except OSError:
        return False


def is_managed(path):
    """skillhub 托管的 skill —— 不参与收敛。"""
    return os.path.isfile(os.path.join(path, META))


def has_skill_md(path):
    return os.path.isfile(os.path.join(path, "SKILL.md"))


def newest_mtime(path):
    m = 0.0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in files:
            try:
                m = max(m, os.path.getmtime(os.path.join(root, f)))
            except OSError:
                pass
    return m


def _make_link(src, dst):
    """创建软链；Windows 用 junction，POSIX 用 symlink。"""
    if os.name == "nt":
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


def installed_agents():
    """返回本机已装 agent 的 (name, dir) 列表。"""
    out = []
    for agent, rel in AGENT_DIRS:
        d = os.path.expanduser(rel)
        if os.path.isdir(d):
            out.append((agent, d))
    return out


def cmd_collect(apply=False, canon=None):
    """把散在各端的 skill 收拢到规范真源。"""
    canon_root = os.path.abspath(canon) if canon else CANON_ROOT
    os.makedirs(canon_root, exist_ok=True)
    print("规范真源: %s\n" % canon_root)

    # 1. 扫描各端，发现 skill
    found = {}          # skill_name -> [(agent, path)]
    managed = []        # skillhub 托管，跳过
    for agent, d in installed_agents():
        try:
            entries = sorted(os.listdir(d))
        except OSError:
            continue
        for name in entries:
            if name.startswith('.'):
                continue
            p = os.path.join(d, name)
            if not os.path.isdir(p):
                continue
            if is_link(p):
                continue                        # 已是软链，天然在真源
            if is_managed(p):
                managed.append((agent, name, p))
                continue
            if not has_skill_md(p):
                continue
            found.setdefault(name, []).append((agent, p))

    if managed:
        print("跳过 %d 个 skillhub 托管 skill（由 marketplace 管理，搬动会破坏元数据）：" % len(managed))
        for agent, name, _ in managed:
            print("    %-26s %s" % (agent, name))
        print()

    if not found:
        print("各端没有需要收敛的 skill。")
        return 0

    # 2. 逐个收敛
    moved = conflicts = 0
    for name, srcs in sorted(found.items()):
        canon_path = os.path.join(canon_root, name)
        if len(srcs) == 1:
            agent, src = srcs[0]
            if os.path.realpath(src) == os.path.realpath(canon_path):
                continue
            if os.path.exists(canon_path):
                # 真源已有同名 -> 比较新旧
                if newest_mtime(src) > newest_mtime(canon_path):
                    bak = canon_path + ".conflict-%s" % agent
                    if os.path.exists(bak):
                        shutil.rmtree(bak, ignore_errors=True)
                    shutil.move(canon_path, bak)
                    shutil.move(src, canon_path)
                    print("  [替换] %-22s 新版来自 %s，旧版备份为 %s" % (name, agent, os.path.basename(bak)))
                    conflicts += 1
                else:
                    bak = src + ".conflict-canon"
                    if os.path.exists(bak):
                        shutil.rmtree(bak, ignore_errors=True)
                    shutil.move(src, bak)
                    print("  [保留] %-22s 真源更新，散落副本备份为 %s" % (name, os.path.basename(bak)))
                    conflicts += 1
            else:
                if apply:
                    shutil.move(src, canon_path)
                print("  [收拢] %-22s 来自 %s" % (name, agent))
                moved += 1
        else:
            # 多端同名 -> 取 mtime 最新的做真源，其余备份
            srcs.sort(key=lambda x: newest_mtime(x[1]), reverse=True)
            win_agent, win_src = srcs[0]
            if apply:
                shutil.move(win_src, canon_path)
            print("  [合并] %-22s %d 端同名，取 %s 的版本" % (name, len(srcs), win_agent))
            for agent, src in srcs[1:]:
                bak = src + ".conflict-%s" % win_agent
                if os.path.exists(bak):
                    shutil.rmtree(bak, ignore_errors=True)
                if apply:
                    shutil.move(src, bak)
                print("         其余备份: %s -> %s" % (agent, os.path.basename(bak)))
                conflicts += 1
            moved += 1

    print("\n%s：收拢 %d 个，处理冲突 %d 个%s"
          % ("已执行" if apply else "试运行", moved, conflicts,
             "" if apply else "（加 --apply 生效）"))
    if not apply:
        print("提示：确认无误后加 --apply 真正执行。")
    return 0


def cmd_link(apply=False, canon=None, only=None):
    """把真源里的每个 skill 软链到所有已装 agent。

    支持全量同步：真源新增的 skill 会在各端补建链接；各端指向真源但真源
    已删除的孤儿链接会被清理。junction 只映射「已存在的那一个目录」，
    不会自动枚举，所以真源新增 skill 后必须重跑一次本命令。
    """
    canon_root = os.path.abspath(canon) if canon else CANON_ROOT
    if not os.path.isdir(canon_root):
        print("真源不存在: %s" % canon_root)
        return 1

    skills = [x for x in sorted(os.listdir(canon_root))
              if not x.startswith('.') and os.path.isdir(os.path.join(canon_root, x))]
    if only:
        skills = [s for s in skills if s in only]
    if not skills:
        print("真源里没有 skill。")
        return 0

    canon_real = os.path.realpath(canon_root)
    agents = installed_agents()
    ok = skip = fail = 0
    cleaned = 0
    for agent, d in agents:
        for name in skills:
            src = os.path.join(canon_root, name)
            dst = os.path.join(d, name)
            if os.path.exists(dst):
                if os.path.realpath(dst) == os.path.realpath(src):
                    skip += 1
                    continue
                if is_managed(dst):
                    skip += 1          # skillhub 托管，不动
                    continue
                bak = dst + ".bak"
                if os.path.exists(bak):
                    shutil.rmtree(bak, ignore_errors=True)
                if apply:
                    os.rename(dst, bak)
                else:
                    skip += 1
                    continue
            try:
                if apply:
                    _make_link(src, dst)
                print("  [链接] %-26s %-24s -> %s" % (agent, name, os.path.basename(src)))
                ok += 1
            except Exception as e:
                print("  [失败] %-26s %-24s —— %s" % (agent, name, e), file=sys.stderr)
                fail += 1

        # 清理孤儿链接（指向真源但真源已无该 skill）
        try:
            entries = os.listdir(d)
        except OSError:
            continue
        for name in entries:
            if name.startswith('.'):
                continue
            p = os.path.join(d, name)
            if not is_link(p):
                continue
            if os.path.realpath(p).startswith(canon_real) and not os.path.exists(os.path.join(canon_root, name)):
                if apply:
                    try:
                        os.unlink(p)
                        print("  [清理] %-26s %-24s （真源已删除）" % (agent, name))
                        cleaned += 1
                    except OSError as e:
                        print("  [失败] 清理 %s —— %s" % (p, e), file=sys.stderr)
                else:
                    print("  [清理] %-26s %-24s （真源已删除，将移除）" % (agent, name))
                    cleaned += 1

    print("\n%s：%d 个链接%s%s%s"
          % ("已执行" if apply else "试运行", ok,
             "，%d 个已就位" % skip if skip else "",
             "，%d 个失败" % fail if fail else "",
             "，清理孤儿 %d 个" % cleaned if cleaned else ""))
    if not apply:
        print("提示：加 --apply 真正执行。")
    return 0 if fail == 0 else 1


def cmd_status(canon=None):
    canon_root = os.path.abspath(canon) if canon else CANON_ROOT
    print("规范真源: %s\n" % canon_root)
    for agent, d in installed_agents():
        try:
            names = sorted(x for x in os.listdir(d) if not x.startswith('.'))
        except OSError:
            continue
        if not names:
            print("  %-26s %s  (空)" % (agent, d))
            continue
        linked = sum(1 for n in names if is_link(os.path.join(d, n)))
        managed = sum(1 for n in names if is_managed(os.path.join(d, n)))
        print("  %-26s %s  %d 个（软链 %d / skillhub托管 %d / 独立 %d）"
              % (agent, d, len(names), linked, managed, len(names) - linked - managed))
    return 0


def cmd_list():
    print("本机 Agent skills 目录：\n")
    for agent, d in installed_agents():
        n = len([x for x in os.listdir(d) if not x.startswith('.')])
        print("  [有] %-26s %s   (%d 个 skill)" % (agent, d, n))
    return 0


def main():
    ap = argparse.ArgumentParser(description="多端 skill 收敛与分发")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="扫描本机 agent 的 skills 目录")

    p = sub.add_parser("collect", help="把散在各端的 skill 收拢到真源")
    p.add_argument("--apply", action="store_true", help="真正执行（默认试运行）")
    p.add_argument("--canon", help="自定义真源目录")

    p = sub.add_parser("link", help="把真源的 skill 软链到所有已装 agent")
    p.add_argument("--apply", action="store_true", help="真正执行（默认试运行）")
    p.add_argument("--canon", help="自定义真源目录")
    p.add_argument("--only", nargs="*", help="只处理指定 skill")

    p = sub.add_parser("status", help="查看收敛与分发状态")
    p.add_argument("--canon", help="自定义真源目录")

    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list()
    if args.cmd == "collect":
        return cmd_collect(args.apply, args.canon)
    if args.cmd == "link":
        return cmd_link(args.apply, args.canon, args.only)
    if args.cmd == "status":
        return cmd_status(args.canon)
    return 0


if __name__ == "__main__":
    sys.exit(main())
