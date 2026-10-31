# -*- coding: utf-8 -*-
"""跨 Agent 共享 Skills 的按需开关：默认少装，用时再开。

为什么需要
----------
Skills 的 name + description 会被注入每一轮对话的 system prompt。
本机 12 个共享 skill 常驻约 1700 tokens —— 日常闲聊纯属浪费。
正常用户逻辑是「不用就别占位，要用再打开」。

三种加载机制（已逐端实测/反编译确认）
----------------------------------
1. **扫描型 + 认 junction**：目录里有 `*/SKILL.md` 即可，且用 `fs.stat()`
   或先 stat 再判断。摘掉 junction 即可关闭。
   → WorkBuddy / WorkBuddy 国际版 / Qoder（实测 skill_listing 含本仓库技能）

2. **扫描型 + 只认真实目录**：过滤条件含 `!isSymbolicLink() && isDirectory()`，
   Windows Junction 会被 Node/Bun 判为 symlink → **整个目录被跳过**。
   → 华为 CodeArts（实测：11 个 junction 全部被跳过，真实目录探针可过）
   这类端「开启」必须用**真实目录副本**，「关闭」用官方禁用清单。

3. **注册表型**：目录只是第 1 层，面板数据源另有三张表。
   → TeleAgent（目录 / skills-metadata.json / .usage.json / permission.skill）

各端关闭通道
------------
| 端                    | 关闭手段                                    | 依据                        |
|-----------------------|---------------------------------------------|-----------------------------|
| WorkBuddy 系          | 摘 junction                                  | 走 fs.stat()，跟随链接      |
| Claude Code           | 摘 junction                                  | 扫描型                      |
| CodeBuddy             | 摘 junction                                  | 扫描型                      |
| Codex(旧) / OpenCode  | 摘 junction                                  | 扫描型                      |
| 阿里 Qoder            | 摘 junction                                  | 实测 skill_listing 已加载   |
| Trae CN               | 摘 junction + skill-config.json disabledSkills | 官方清单，双保险         |
| 华为 CodeArts         | 删真实目录 + UserSkillStatus.txt 写 name=false | 官方清单，disabled=true 生效 |
| TeleAgent             | 摘 junction + 撤三张表登记                   | 注册表型                    |

CodeArts 禁用清单语义（反编译自 agentkernelServer-win32-x64.exe）
----------------------------------------------------------------
读取： `readDisableSkillConfig` -> Map[key] = (文件里的值 === "false")
判定： `loadSkillFromFile`   -> disabled = Map.get(frontmatter.name)
注入： `getActivatedSkills`  -> filter(s => !s.disabled)  ← disabled 不进 prompt

写入： `persistSkillStatusSync` -> 文件里写 `name=true` 表示「启用」，
       `name=false` 表示「禁用」。所以**关一个技能 = 写 `name=false`**。

注意 key 取的是 **SKILL.md frontmatter 的 name**，不是目录名，且存入会 toLowerCase。
因此 frontmatter 的 name 必须与目录名一致（否则 location 拼错、lazy-load 失败）。

用法
----
    python skills_onoff.py list                    # 看所有共享 skill 当前开关状态
    python skills_onoff.py status <skill>          # 单个技能的详细状态
    python skills_onoff.py on  <skill> [<skill>...]   # 开启
    python skills_onoff.py off <skill> [<skill>...]   # 关闭
    python skills_onoff.py off --all               # 全关（日常模式）
    python skills_onoff.py on  --all               # 全开
    python skills_onoff.py profile lean|full       # 一键切换
    python skills_onoff.py doctor                  # 诊断各端加载机制

安全
----
- 真源 ~/.agents/skills/ 永远不动，只操作各端的副本/junction。
- 删 junction 走 .NET Directory.Delete(path, false)，
  绝不用 shutil.rmtree（会顺着 junction 删掉真源！）。
- 删真实目录前先确认它不是 junction。
- 改任何 JSON / 状态文件前自动备份。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

CANON_ROOT = os.path.expanduser("~/.agents/skills")

# ---------------------------------------------------------------------------
# 端配置
#   mode:
#     junction —— 装/不装 = 建/删 junction（端认 junction）
#     realdir  —— 装 = 真实目录副本；不装 = 删副本（端只认真实目录）
#     registry —— 装 = 建 junction + 补三张表；不装 = 摘 junction + 撤三张表
#   status_file / status_key: 该端官方禁用清单
#     CodeArts: 文本，key=value 一行一个，value=false 表示禁用
#     Trae    : JSON 数组，元素是 skill 名
# ---------------------------------------------------------------------------
AGENTS = {
    "WorkBuddy": {
        "dir": "~/.workbuddy/skills", "mode": "junction",
    },
    "WorkBuddy 国际版": {
        "dir": "~/.workbuddy-ai/skills", "mode": "junction",
    },
    "Claude Code": {
        "dir": "~/.claude/skills", "mode": "junction",
    },
    "CodeBuddy": {
        "dir": "~/.codebuddy/skills", "mode": "junction",
    },
    "Codex(旧)": {
        "dir": "~/.codex/skills", "mode": "junction",
    },
    "OpenCode": {
        "dir": "~/.config/opencode/skills", "mode": "junction",
    },
    "Trae CN": {
        "dir": "~/.trae-cn/skills", "mode": "junction",
        "status_file": "~/.trae-cn/skill-config.json",
        "status_kind": "json_array", "status_key": "disabledSkills",
    },
    "华为 CodeArts": {
        "dir": "~/.codeartsdoer/skills", "mode": "realdir",
        "status_file": "~/.codeartsdoer/skills/UserSkillStatus.txt",
        "status_kind": "kv_lines",
    },
    "阿里 Qoder": {
        "dir": "~/.qoder/skills", "mode": "junction",
    },
    "TeleAgent": {
        "dir": None, "mode": "registry",   # 目录动态发现
    },
}

# 端归属：正向白名单（未列出的 = 全端）+ 反向排除
AGENT_ONLY = {
    "codebase-crossrepo-pipeline": {"华为 CodeArts"},
}
AGENT_EXCLUDE = {
    "browser-cli-skill": {"华为 CodeArts"},
}

# 日常模式保留的技能（其余全关）
LEAN_KEEP = {"comfyui", "mv-image-pipeline", "tencent-docs-cli"}

TELEAGENT_CFG = os.path.expanduser("~/.config/TeleAgent")
TELEAGENT_LOCAL = os.path.expanduser("~/.local/share/TeleAgent")


# ---------------------------------------------------------------- 基础工具

def is_junction(path):
    """Windows junction / symlink 检测（os.path.islink 对 junction 返回 False）。"""
    if not os.path.exists(path) and not os.path.islink(path):
        return False
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


def links_to_canon(path, canon_root=None):
    """该路径是否为指向真源目录的直接 junction/symlink。"""
    if not is_junction(path):
        return False
    root = os.path.realpath(canon_root or CANON_ROOT)
    try:
        return os.path.dirname(os.path.realpath(path)).lower() == root.lower()
    except OSError:
        return False


def is_real_dir(path):
    """真实目录（不是 junction / symlink）。"""
    return os.path.isdir(path) and not is_junction(path)


def agent_dirs():
    """返回 [(名称, 配置, 路径)]，跳过不存在的目录。"""
    out = []
    for name, cfg in AGENTS.items():
        if name == "TeleAgent":
            continue
        d = os.path.expanduser(cfg["dir"])
        if os.path.isdir(d):
            out.append((name, cfg, d))
    root = os.path.join(TELEAGENT_CFG, "users")
    if os.path.isdir(root):
        for uid in sorted(os.listdir(root)):
            d = os.path.join(root, uid, "skills")
            if os.path.isdir(d):
                cfg = dict(AGENTS["TeleAgent"])
                cfg["dir"] = d
                out.append(("TeleAgent", cfg, d))
    return out


def teleagent_local(user_skills_dir):
    """从 TeleAgent 的 skills 目录反推同 id 的 local 目录。"""
    users = os.path.dirname(user_skills_dir)
    uid = os.path.basename(users)
    return os.path.join(TELEAGENT_LOCAL, "users", uid)


def make_junction(src, dst):
    """建 junction；Windows 用 New-Item，POSIX 用 symlink。"""
    if os.name == "nt":
        ps = ('New-Item -ItemType Junction -Path "%s" -Target "%s" | Out-Null'
              % (dst.replace('"', '""'), src.replace('"', '""')))
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip())
    else:
        os.symlink(src, dst)


def remove_junction(path):
    """摘掉 junction，不动目标内容。

    Windows：os.unlink 对 junction 会失败（被当成目录），
    shutil.rmtree 更危险 —— 会顺着 junction 删掉真源。必须用 .NET API。
    """
    if os.name == "nt" and is_junction(path):
        ps = '[System.IO.Directory]::Delete("%s", $false)' % path.replace('"', '""')
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip())
        return
    os.unlink(path)


def remove_real_dir(path):
    """删真实目录（真源不受影响）。带 junction 保护。"""
    if is_junction(path):
        remove_junction(path)
        return
    shutil.rmtree(path)


def copy_real_dir(src, dst):
    """真源 -> 真实目录副本。"""
    if os.path.exists(dst):
        if is_junction(dst):
            remove_junction(dst)
        else:
            shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=False)


def backup(path, tag="bak"):
    """备份文件，返回备份路径；源不存在返回 None。"""
    if not os.path.exists(path):
        return None
    dst = "%s.%s" % (path, tag)
    shutil.copy2(path, dst)
    return dst


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_json(path, data):
    tmp = path + ".tmp-onoff"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def skill_fm_name(dir_name):
    """取 SKILL.md frontmatter 的 name（CodeArts 状态文件用这个做 key）。"""
    p = os.path.join(CANON_ROOT, dir_name, "SKILL.md")
    if not os.path.isfile(p):
        return dir_name
    try:
        raw = open(p, "rb").read()
    except OSError:
        return dir_name
    m = re.match(rb"^(?:\xef\xbb\xbf)?---[^\S\r\n]*\r?\n(.*?)\r?\n---", raw, re.S)
    if not m:
        return dir_name
    mm = re.search(r"^name\s*:\s*(.+?)\s*$", m.group(1).decode("utf-8", "replace"),
                   re.M)
    if not mm:
        return dir_name
    v = mm.group(1).strip().strip('"').strip("'")
    return v or dir_name


# ------------------------------------------------- 官方禁用清单（两种格式）

def read_kv_lines(path):
    """读 key=value 文本，返回 {key: value_bool}（value=='false' -> True）。"""
    out = {}
    if not os.path.isfile(path):
        return out
    try:
        raw = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return out
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if not k or not v:
            continue
        out[k.lower()] = (v.lower() == "false")
    return out


def write_kv_lines(path, mapping):
    """写 key=value 文本。mapping: {key: bool}，True=禁用。"""
    backup(path, "bak-onoff")
    lines = ["%s=%s" % (k, "false" if v else "true") for k, v in sorted(mapping.items())]
    tmp = path + ".tmp-onoff"
    with open(tmp, "w", encoding="utf-8", newline="\r\n") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    os.replace(tmp, path)


def read_json_array(path, key):
    """读 JSON 里的数组字段。"""
    data = read_json(path)
    v = data.get(key) if isinstance(data, dict) else None
    return list(v) if isinstance(v, list) else []


def write_json_array(path, key, items):
    """写 JSON 里的数组字段（保留其他字段）。"""
    data = read_json(path)
    if not isinstance(data, dict):
        data = {}
    data[key] = list(items)
    backup(path, "bak-onoff")
    tmp = path + ".tmp-onoff"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def status_path(cfg):
    p = cfg.get("status_file")
    return os.path.expanduser(p) if p else None


def set_status(cfg, name, disabled):
    """写该端的禁用清单。返回 True 表示有变更。"""
    sp = status_path(cfg)
    if not sp:
        return False
    kind = cfg.get("status_kind")
    key = name.lower()
    if kind == "kv_lines":
        m = read_kv_lines(sp)
        old = m.get(key)
        # 文件里 name=false 表示禁用；map 里 True=禁用
        if old == disabled:
            return False
        m[key] = disabled
        write_kv_lines(sp, m)
        return True
    if kind == "json_array":
        items = read_json_array(sp, cfg["status_key"])
        low = {str(x).lower() for x in items}
        changed = False
        if disabled and key not in low:
            items.append(name)
            changed = True
        elif not disabled and key in low:
            items = [x for x in items if str(x).lower() != key]
            changed = True
        if changed:
            write_json_array(sp, cfg["status_key"], items)
        return changed
    return False


def status_disabled(cfg, name):
    """该端清单里，这个技能是否被禁用。"""
    sp = status_path(cfg)
    if not sp:
        return False
    key = name.lower()
    kind = cfg.get("status_kind")
    if kind == "kv_lines":
        return read_kv_lines(sp).get(key, False)
    if kind == "json_array":
        return key in {str(x).lower() for x in read_json_array(sp, cfg["status_key"])}
    return False


# ------------------------------------------------------------ TeleAgent 表

def ta_paths(skills_dir):
    """返回 TeleAgent 三张表的路径。"""
    local = teleagent_local(skills_dir)
    return (
        os.path.join(local, "skills-metadata.json"),   # 元数据（面板数据源）
        os.path.join(skills_dir, ".usage.json"),        # 使用统计
        os.path.join(os.path.dirname(skills_dir), "TeleAgent.jsonc"),  # 权限
    )


def _ta_perm_block(raw):
    """定位 TeleAgent.jsonc 里 permission.skill 的花括号区间。"""
    m = re.search(r'"skill"\s*:\s*\{', raw)
    if not m:
        return None
    close = raw.find("}", m.end())
    if close < 0:
        return None
    return m.end(), close


def ta_unregister(skills_dir, name):
    """TeleAgent 端关闭：从三张表移除该 skill，条目存到 .disabled.json 备份。"""
    meta_p, usage_p, perm_p = ta_paths(skills_dir)
    store = os.path.join(skills_dir, ".disabled.json")
    store_data = read_json(store)

    meta = read_json(meta_p)
    usage = read_json(usage_p)

    entry = {}
    if name in meta:
        entry["meta"] = meta.pop(name)
    if name in usage:
        entry["usage"] = usage.pop(name)

    if os.path.exists(perm_p):
        with open(perm_p, encoding="utf-8") as f:
            raw = f.read()
        rng = _ta_perm_block(raw)
        if rng:
            start, close = rng
            block = raw[start:close]
            new_block = re.sub(r'\n\s*"%s"\s*:\s*"allow"\s*,?' % re.escape(name),
                               "", block)
            if new_block != block:
                entry["perm_removed"] = True
                backup(perm_p, "bak-onoff")
                with open(perm_p, "w", encoding="utf-8") as f:
                    f.write(raw[:start] + new_block + raw[close:])

    if entry:
        store_data[name] = entry
        write_json(store, store_data)
        backup(meta_p, "bak-onoff")
        backup(usage_p, "bak-onoff")
        write_json(meta_p, meta)
        write_json(usage_p, usage)
    return bool(entry)


def ta_register(skills_dir, name):
    """TeleAgent 端开启：恢复元数据/统计/权限（从 .disabled.json 或新建）。"""
    meta_p, usage_p, perm_p = ta_paths(skills_dir)
    store = os.path.join(skills_dir, ".disabled.json")
    store_data = read_json(store)
    saved = store_data.get(name, {})

    meta = read_json(meta_p)
    usage = read_json(usage_p)
    changed = False

    if "meta" in saved:
        meta[name] = saved["meta"]
        changed = True
    elif name not in meta:
        meta[name] = {
            "source": "import",
            "reviewStatus": "clean",
            "version": "v1.0.0",
            "versionId": "",
            "icon": "",
            "serverId": "",
            "skillAuthorType": "personal",
            "location": os.path.join(skills_dir, name, "SKILL.md"),
            "deleted": False,
        }
        changed = True

    if "usage" in saved:
        usage[name] = saved["usage"]
        changed = True
    elif name not in usage:
        usage[name] = {
            "evolvable": True, "created_by": None,
            "created_at": "2026-01-01T00:00:00.0000000Z",
            "use_count": 0, "view_count": 0, "patch_count": 0,
            "last_used_at": "", "last_viewed_at": "", "last_patched_at": "",
            "state": "active", "archived_at": None, "pinned": False,
        }
        changed = True

    if changed:
        backup(meta_p, "bak-onoff")
        backup(usage_p, "bak-onoff")
        write_json(meta_p, meta)
        write_json(usage_p, usage)

    if os.path.exists(perm_p):
        with open(perm_p, encoding="utf-8") as f:
            raw = f.read()
        rng = _ta_perm_block(raw)
        if rng:
            start, close = rng
            block = raw[start:close]
            if not re.search(r'"%s"\s*:' % re.escape(name), block):
                indent = re.search(r'\n(\s*)"', block)
                ind = indent.group(1) if indent else "      "
                nb = block.rstrip()
                if nb and not nb.endswith(","):
                    nb += ","
                nb += '\n%s"%s": "allow"' % (ind, name)
                backup(perm_p, "bak-onoff")
                with open(perm_p, "w", encoding="utf-8") as f:
                    f.write(raw[:start] + nb + raw[close:])

    store_data.pop(name, None)
    write_json(store, store_data)
    return changed


# ------------------------------------------------------------------ 开关

def targets_for(name, only_agent=None):
    """这个 skill 应该装到哪些端。only_agent: 只操作指定端。"""
    only = AGENT_ONLY.get(name)
    excl = AGENT_EXCLUDE.get(name, set())
    out = []
    for agent, cfg, d in agent_dirs():
        if only_agent and agent != only_agent:
            continue
        if only and agent not in only:
            continue
        if agent in excl:
            continue
        out.append((agent, cfg, d))
    return out


def enable(name, dry=False, only_agent=None):
    """开启 skill。"""
    canon = os.path.join(CANON_ROOT, name)
    if not os.path.isdir(canon):
        print("  [跳过] %s：真源不存在" % name)
        return 0
    n = 0
    for agent, cfg, d in targets_for(name, only_agent):
        p = os.path.join(d, name)
        mode = cfg["mode"]

        if mode == "realdir":
            # 该端只认真实目录
            if is_real_dir(p):
                print("  [已开] %-28s @ %s（真实目录已存在）" % (name, agent))
            elif dry:
                print("  [dry] 将复制真实目录 -> %s" % p)
                n += 1
                continue
            else:
                try:
                    copy_real_dir(canon, p)
                    print("  [开启] %-28s @ %s（真实目录副本）" % (name, agent))
                    n += 1
                except Exception as e:
                    print("  [失败] %s @ %s：%s" % (name, agent, e))
                    continue
            # 同步官方清单：写入 name=true（启用）
            try:
                if set_status(cfg, skill_fm_name(name), disabled=False):
                    print("         [清单] %s：已标记为启用" % agent)
            except Exception as e:
                print("         [清单失败] %s：%s" % (agent, e))
            continue

        # junction / registry
        if links_to_canon(p):
            print("  [已开] %-28s @ %s" % (name, agent))
            continue
        if os.path.exists(p):
            if is_junction(p):
                try:
                    remove_junction(p)
                except Exception as e:
                    print("  [失败] %s @ %s：摘旧 junction 出错 %s" % (name, agent, e))
                    continue
            else:
                print("  [跳过] %s @ %s：存在真实副本，未覆盖" % (name, agent))
                continue
        if dry:
            print("  [dry] 将建立 %s -> %s" % (p, name))
            n += 1
            continue
        try:
            make_junction(canon, p)
            print("  [开启] %-28s @ %s" % (name, agent))
            n += 1
        except Exception as e:
            print("  [失败] %s @ %s：%s" % (name, agent, e))
            continue

        if mode == "registry":
            try:
                ta_register(d, name)
                print("         [登记] %s：元数据/统计/权限已就位" % agent)
            except Exception as e:
                print("         [登记失败] %s：%s" % (agent, e))
        else:
            try:
                if set_status(cfg, skill_fm_name(name), disabled=False):
                    print("         [清单] %s：已标记为启用" % agent)
            except Exception as e:
                print("         [清单失败] %s：%s" % (agent, e))
    return n


def disable(name, dry=False, only_agent=None, purge=False):
    """关闭 skill。"""
    n = 0
    for agent, cfg, d in targets_for(name, only_agent):
        p = os.path.join(d, name)
        mode = cfg["mode"]

        if mode == "realdir":
            if is_real_dir(p):
                if purge:
                    if dry:
                        print("  [dry] 将删除真实目录 %s" % p)
                        n += 1
                    else:
                        try:
                            remove_real_dir(p)
                            print("  [关闭] %-28s @ %s（真实目录已删除）" % (name, agent))
                            n += 1
                        except Exception as e:
                            print("  [失败] %s @ %s：%s" % (name, agent, e))
                else:
                    # 真实目录保留：只用清单关，秒级开关、可逆、无 I/O
                    print("  [关闭] %-28s @ %s（清单禁用，目录保留）" % (name, agent))
            elif is_junction(p):
                # 该端不认 junction，但它占着位置，仍清掉
                if dry:
                    print("  [dry] 将摘除 junction %s" % p)
                    n += 1
                else:
                    try:
                        remove_junction(p)
                        print("  [关闭] %-28s @ %s（摘除无效 junction）" % (name, agent))
                        n += 1
                    except Exception as e:
                        print("  [失败] %s @ %s：%s" % (name, agent, e))
            try:
                if set_status(cfg, skill_fm_name(name), disabled=True):
                    print("         [清单] %s：已标记为禁用（name=false）" % agent)
            except Exception as e:
                print("         [清单失败] %s：%s" % (agent, e))
            continue

        if not os.path.exists(p):
            # 目录本来就没有，也要确保清单里是禁用状态
            try:
                if set_status(cfg, skill_fm_name(name), disabled=True):
                    print("         [清单] %s：已标记为禁用" % agent)
            except Exception as e:
                print("         [清单失败] %s：%s" % (agent, e))
            continue

        if not is_junction(p):
            print("  [跳过] %s @ %s：真实副本，未动" % (name, agent))
        elif dry:
            print("  [dry] 将摘除 %s" % p)
            n += 1
        else:
            try:
                remove_junction(p)
                print("  [关闭] %-28s @ %s" % (name, agent))
                n += 1
            except Exception as e:
                print("  [失败] %s @ %s：%s" % (name, agent, e))

        if mode == "registry":
            try:
                ta_unregister(d, name)
                print("         [撤登记] %s：元数据/统计/权限已清" % agent)
            except Exception as e:
                print("         [撤登记失败] %s：%s" % (agent, e))
        else:
            try:
                if set_status(cfg, skill_fm_name(name), disabled=True):
                    print("         [清单] %s：已标记为禁用" % agent)
            except Exception as e:
                print("         [清单失败] %s：%s" % (agent, e))
    return n


# ------------------------------------------------------------------ 展示

def all_skill_names():
    if not os.path.isdir(CANON_ROOT):
        return []
    return sorted(d for d in os.listdir(CANON_ROOT)
                  if os.path.isdir(os.path.join(CANON_ROOT, d)))


def agent_on(agent, cfg, d, name):
    """该端这个技能是否处于「开启」状态。"""
    p = os.path.join(d, name)
    if cfg["mode"] == "realdir":
        installed = is_real_dir(p)
    else:
        installed = links_to_canon(p)
    if not installed:
        return False
    if status_disabled(cfg, skill_fm_name(name)):
        return False
    if cfg["mode"] == "registry":
        meta_p, _, _ = ta_paths(d)
        meta = read_json(meta_p)
        if name not in meta:
            return False
    return True


def state_of(name, only_agent=None):
    """返回 (开启端数, 总端数, 已开启端列表)。"""
    tg = targets_for(name, only_agent)
    on = [a for a, cfg, d in tg if agent_on(a, cfg, d, name)]
    return len(on), len(tg), on


def cmd_list(args):
    names = args.skills or all_skill_names()
    print("共享 skills 开关状态（真源 %s）\n" % CANON_ROOT)
    print("%-30s %-8s %s" % ("skill", "状态", "已开启的端"))
    print("-" * 78)
    for name in names:
        n_on, n_all, on = state_of(name)
        st = "全关" if n_on == 0 else ("全开" if n_on == n_all else "部分")
        print("%-30s %-8s %s" % (name, st, ", ".join(on) if on else "—"))
    tot = sum(state_of(x)[0] for x in names)
    print("\n共 %d 个 skill，%d 个端处于开启状态" % (len(names), tot))
    return 0


def cmd_status(args):
    name = args.name
    only_agent = getattr(args, "agent", None)
    canon = os.path.join(CANON_ROOT, name)
    print("Skill: %s" % name)
    print("  真源: %s" % (canon if os.path.isdir(canon) else "（不存在）"))
    print("  frontmatter name: %s" % skill_fm_name(name))
    print("\n  各端：")
    for agent, cfg, d in targets_for(name, only_agent):
        p = os.path.join(d, name)
        on = agent_on(agent, cfg, d, name)
        kind = "junction" if cfg["mode"] == "junction" else (
            "真实目录" if cfg["mode"] == "realdir" else "注册表")
        print("    %-22s [%-6s] %-58s %s"
              % (agent, "开" if on else "关", d, kind))
    n_on, n_all, on = state_of(name, only_agent)
    print("\n  状态: %d/%d 端开启" % (n_on, n_all))
    return 0


def cmd_doctor(args):
    """诊断各端加载机制与当前安装形态。"""
    print("各 Agent Skills 加载机制诊断\n")
    print("%-22s %-9s %-9s %-9s %s" % ("端", "junction", "真实目录", "清单禁用", "模式"))
    print("-" * 92)
    for agent, cfg, d in agent_dirs():
        nj = nr = nd = 0
        for name in all_skill_names():
            p = os.path.join(d, name)
            if links_to_canon(p):
                nj += 1
            elif is_real_dir(p):
                nr += 1
            if status_disabled(cfg, skill_fm_name(name)):
                nd += 1
        print("%-22s %-9d %-9d %-9d %s"
              % (agent, nj, nr, nd, cfg["mode"]))
    print("\n说明：")
    print("  junction  = 指向真源的链接（CodeArts 会跳过，仅 WorkBuddy/Qoder 类端有效）")
    print("  真实目录  = 实体副本（CodeArts 唯一认的形式）")
    print("  清单禁用  = 官方禁用清单里标记为禁用的技能数")
    return 0


def cmd_on(args):
    names = all_skill_names() if args.all else args.skills
    for n in names:
        print("开启 %s" % n)
        enable(n, args.dry_run, getattr(args, 'agent', None))
    return 0


def cmd_off(args):
    names = all_skill_names() if args.all else args.skills
    for n in names:
        print("关闭 %s" % n)
        disable(n, args.dry_run, getattr(args, 'agent', None), getattr(args, 'purge', False))
    return 0


def cmd_profile(args):
    """lean 模式：只留常用技能；full 模式：全开。"""
    if args.name == "lean":
        keep = LEAN_KEEP
        for n in sorted(keep):
            enable(n, args.dry_run, getattr(args, 'agent', None))
        for n in all_skill_names():
            if n not in keep:
                disable(n, args.dry_run, getattr(args, 'agent', None), getattr(args, 'purge', False))
        print("\nlean 模式：保留 %s" % ", ".join(sorted(keep)))
    else:
        for n in all_skill_names():
            enable(n, args.dry_run, getattr(args, 'agent', None))
        print("\nfull 模式：全部开启")
    return 0


def main():
    ap = argparse.ArgumentParser(description="共享 skills 按需开关")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="看所有 skill 的开关状态")
    p.add_argument("skills", nargs="*")

    p = sub.add_parser("status", help="单个 skill 详情")
    p.add_argument("name")
    p.add_argument("--agent", help="只看指定端")

    p = sub.add_parser("doctor", help="诊断各端加载机制")

    p = sub.add_parser("on", help="开启 skill")
    p.add_argument("skills", nargs="*")
    p.add_argument("--all", action="store_true", help="全部开启")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--agent", help="只操作指定端")

    p = sub.add_parser("off", help="关闭 skill")
    p.add_argument("skills", nargs="*")
    p.add_argument("--all", action="store_true", help="全部关闭")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--agent", help="只操作指定端")
    p.add_argument("--purge", action="store_true", help="连真实目录副本一起删掉")

    p = sub.add_parser("profile", help="一键切换 lean / full")
    p.add_argument("name", choices=["lean", "full"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--agent", help="只操作指定端")
    p.add_argument("--purge", action="store_true", help="连真实目录副本一起删掉")

    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "doctor":
        return cmd_doctor(args)
    if args.cmd == "on":
        if not args.skills and not args.all:
            print("请指定 skill 名，或用 --all")
            return 1
        return cmd_on(args)
    if args.cmd == "off":
        if not args.skills and not args.all:
            print("请指定 skill 名，或用 --all")
            return 1
        return cmd_off(args)
    if args.cmd == "profile":
        return cmd_profile(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
