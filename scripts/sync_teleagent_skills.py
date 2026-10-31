# -*- coding: utf-8 -*-
"""为 TeleAgent（天翼）补齐技能注册表。

背景
----
TeleAgent 的技能面板不是「扫描目录就显示」，它有三层登记，缺一不可：

1. ``~/.config/TeleAgent/users/<id>/skills/``           —— 技能实体目录
2. ``~/.local/share/TeleAgent/users/<id>/skills-metadata.json``
   —— 元数据注册表（面板列表的数据源，记录 source/location/version/fingerprint）
3. ``~/.config/TeleAgent/users/<id>/skills/.usage.json``
   —— 使用统计注册表（面板按它过滤 state=active 的技能）
4. ``~/.config/TeleAgent/users/<id>/TeleAgent.jsonc``
   -> ``permission.skill.<name> = "allow"``             —— 调用白名单

只放 junction（层 1）的话，文件确实在磁盘上、agent 也能读到内容，
但面板列表读的是层 2/3，所以看不到。已验证的证据：
comfyui 等 6 个 junction 在层 2 里有记录（source=hub），面板正常显示；
另 5 个只在层 1，面板不显示。

用法
----
    python sync_teleagent_skills.py            # 补齐缺失登记（dry-run 打印计划）
    python sync_teleagent_skills.py --apply    # 实际写入
"""
import argparse
import json
import os
import re
import shutil
import sys
import time

CANON_ROOT = os.path.expanduser("~/.agents/skills")

# TeleAgent 用户目录：路径含 user_id，动态发现
TELEAGENT_CFG = os.path.expanduser("~/.config/TeleAgent")
TELEAGENT_LOCAL = os.path.expanduser("~/.local/share/TeleAgent")


def find_user_dirs():
    """返回 (config_user_dir, local_user_dir) 列表。"""
    out = []
    cfg_root = os.path.join(TELEAGENT_CFG, "users")
    loc_root = os.path.join(TELEAGENT_LOCAL, "users")
    if not os.path.isdir(cfg_root):
        return out
    for uid in sorted(os.listdir(cfg_root)):
        c = os.path.join(cfg_root, uid)
        if not os.path.isdir(os.path.join(c, "skills")):
            continue
        out.append((c, os.path.join(loc_root, uid)))
    return out


def is_junction(path):
    """Windows junction / symlink 检测（os.path.islink 对 junction 返回 False）。"""
    if os.name != "nt":
        return os.path.islink(path)
    try:
        import stat as _stat
        st = os.lstat(path)
        attrs = getattr(st, "st_file_attributes", 0)
        reparse = getattr(_stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return bool(attrs & reparse)
    except (OSError, AttributeError):
        return False


def links_to_canon(path, canon_root):
    """该路径是否为指向真源目录的直接 junction/symlink。"""
    if not is_junction(path):
        return False
    try:
        rp = os.path.realpath(path)
        return os.path.dirname(rp).lower() == os.path.realpath(canon_root).lower()
    except OSError:
        return False


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_json(path, data):
    tmp = path + ".tmp-sync"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def parse_frontmatter(skill_md):
    """极简 YAML front matter 解析：只取 name / name_cn / description / description_cn。"""
    try:
        with open(skill_md, encoding="utf-8-sig") as f:
            text = f.read()
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    block = text[3:end]
    out = {}
    for key in ("name", "name_cn", "description", "description_cn"):
        m = re.search(r"^%s:\s*(.*)$" % key, block, re.M)
        if not m:
            continue
        val = m.group(1).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        out[key] = val
    return out


def fingerprint(skill_dir):
    """对齐 TeleAgent 的 fingerprint 格式: 文件数|总字节|SKILL.md 的 md5。"""
    import hashlib
    files = []
    total = 0
    md5 = ""
    for root, dirs, names in os.walk(skill_dir):
        dirs[:] = [d for d in dirs if d not in (".git", "__MACOSX", "node_modules")]
        for n in names:
            p = os.path.join(root, n)
            try:
                sz = os.path.getsize(p)
            except OSError:
                continue
            files.append(p)
            total += sz
    skill_md = os.path.join(skill_dir, "SKILL.md")
    if os.path.exists(skill_md):
        with open(skill_md, "rb") as f:
            md5 = hashlib.md5(f.read()).hexdigest()
    return "%d|%d|%s" % (len(files), total, md5)


def sync_user(cfg_dir, loc_dir, apply_changes=False):
    skills_dir = os.path.join(cfg_dir, "skills")
    meta_path = os.path.join(loc_dir, "skills-metadata.json")
    usage_path = os.path.join(skills_dir, ".usage.json")
    cfg_path = os.path.join(cfg_dir, "TeleAgent.jsonc")

    meta = read_json(meta_path)
    usage = read_json(usage_path)
    if not os.path.isdir(skills_dir):
        print("跳过（无 skills 目录）: %s" % cfg_dir)
        return 0

    canon_names = set(os.listdir(CANON_ROOT)) if os.path.isdir(CANON_ROOT) else set()
    entries = [e for e in sorted(os.listdir(skills_dir)) if not e.startswith(".")]

    added_meta, added_usage, added_perm = [], [], []

    for name in entries:
        p = os.path.join(skills_dir, name)
        if not links_to_canon(p, CANON_ROOT):
            continue                      # 只处理指向共享真源的 junction
        if name not in canon_names:
            continue                      # 不是共享真源的技能，跳过
        skill_dir = os.path.realpath(p)
        skill_md = os.path.join(skill_dir, "SKILL.md")
        if not os.path.exists(skill_md):
            continue

        fm = parse_frontmatter(skill_md)

        # --- 层 2: skills-metadata.json ---
        if name not in meta:
            meta[name] = {
                "source": "import",
                "reviewStatus": "clean",
                "addedAt": int(time.time() * 1000),
                "version": "v1.0.0",
                "versionId": "",
                "icon": "",
                "serverId": "",
                "skillAuthorType": "personal",
                "location": os.path.join(skills_dir, name, "SKILL.md"),
                "deleted": False,
            }
            if fm.get("name_cn"):
                meta[name]["name_cn"] = fm["name_cn"]
            if fm.get("description_cn"):
                meta[name]["description_cn"] = fm["description_cn"]
            added_meta.append(name)

        # --- 层 3: .usage.json ---
        if name not in usage:
            usage[name] = {
                "evolvable": True,
                "created_by": None,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.0000000Z", time.gmtime()),
                "use_count": 0,
                "view_count": 0,
                "patch_count": 0,
                "last_used_at": "",
                "last_viewed_at": "",
                "last_patched_at": "",
                "state": "active",
                "archived_at": None,
                "pinned": False,
            }
            added_usage.append(name)

    # --- 层 4: TeleAgent.jsonc 的 permission.skill ---
    perm_added = []
    if os.path.exists(cfg_path):
        with open(cfg_path, encoding="utf-8") as f:
            raw = f.read()
        m = re.search(r'"skill"\s*:\s*\{', raw)
        if m:
            close = raw.find("}", m.end())
            block = raw[m.end():close]
            existing = set(re.findall(r'"([^"]+)"\s*:', block))
            targets = sorted(set(added_meta) | set(added_usage))
            for n in targets:
                if n in existing:
                    continue
                indent = re.search(r'\n(\s*)"', block)
                ind = indent.group(1) if indent else "      "
                block = block.rstrip()
                if block and not block.endswith(","):
                    block += ","
                block += '\n%s"%s": "allow"' % (ind, n)
                perm_added.append(n)
            if perm_added:
                new_raw = raw[:m.end()] + block + raw[close:]
                if apply_changes:
                    shutil.copy2(cfg_path, cfg_path + ".bak-sync")
                    with open(cfg_path, "w", encoding="utf-8") as f:
                        f.write(new_raw)

    # fingerprint 需要在写入前算好（避免 junction 路径差异）
    if apply_changes:
        for n in added_meta:
            d = os.path.realpath(os.path.join(skills_dir, n))
            try:
                meta[n]["fingerprint"] = fingerprint(d)
            except OSError:
                pass
        write_json(meta_path, meta)
        write_json(usage_path, usage)

    print("用户目录: %s" % cfg_dir)
    print("  补 skills-metadata.json : %s" % (", ".join(added_meta) or "（无）"))
    print("  补 .usage.json           : %s" % (", ".join(added_usage) or "（无）"))
    print("  补 permission.skill      : %s" % (", ".join(perm_added) or "（无）"))
    if not apply_changes:
        print("  [dry-run] 加 --apply 实际写入")
    return len(set(added_meta) | set(added_usage))


def main():
    ap = argparse.ArgumentParser(description="补齐 TeleAgent 技能注册表")
    ap.add_argument("--apply", action="store_true", help="实际写入（默认 dry-run）")
    args = ap.parse_args()

    users = find_user_dirs()
    if not users:
        print("未找到 TeleAgent 用户目录")
        return 1
    n = 0
    for cfg, loc in users:
        n += sync_user(cfg, loc, args.apply)
    print("\n共需补登 %d 个技能%s" % (n, "（已写入）" if args.apply else "（dry-run）"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
