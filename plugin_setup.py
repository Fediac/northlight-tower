"""Adds / removes the NorthLight Tower plugin in Claude's global settings.

  python plugin_setup.py add                 -> the plugin loads automatically in every new Claude session
                                                + adds a SendMessage permission rule (so messages go straight to the sub-agent)
  python plugin_setup.py remove              -> undoes both (the rule is only removed if we added it)
  python plugin_setup.py permission-add      -> only adds the SendMessage permission rule
  python plugin_setup.py permission-remove   -> only removes the SendMessage permission rule (the plugin stays; messages go through the main worker)

Only env.CLAUDE_CODE_PLUGIN_DIRS and permissions.allow ("SendMessage") change inside ~/.claude/settings.json.
No other setting is touched. A backup is made before the first change; if we added the rule, a marker file records it.

Why the SendMessage permission? When Claude is in "auto mode", a message you type in the tower is not treated as the model's own
request, so a direct send is refused. The permission rule does not bypass this check, it only approves the tool: the model's own
SendMessage calls become approved too.
Without the rule the plugin hands the message to the main worker ("pass this on") - that works, but costs the main worker one turn.

Upgrading from an earlier version: the plugin folder used to be called mod/piksel-ofis. `add` replaces such an entry with the
current folder, and `remove` cleans up both. The old backup / marker file names are still recognized.
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, "mod", "pixel-office")
LEGACY_MODS = [os.path.join(HERE, "mod", "piksel-ofis")]      # folder name used by earlier versions
SETTINGS = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
BACKUP = SETTINGS + ".pixel-office-backup"
TRACE = SETTINGS + ".pixel-office-permission"                 # written here if we added the rule ourselves
LEGACY_TRACE = SETTINGS + ".piksel-ofis-izin"                  # marker file name used by earlier versions
KEY = "CLAUDE_CODE_PLUGIN_DIRS"
RULE = "SendMessage"

COMMANDS = {"add": "add", "remove": "remove", "permission-add": "permission-add", "permission-remove": "permission-remove",
            "perm-add": "permission-add", "perm-remove": "permission-remove"}


def load():
    if not os.path.exists(SETTINGS):
        return {}
    with open(SETTINGS, "r", encoding="utf-8") as f:
        txt = f.read().strip()
    return json.loads(txt) if txt else {}


def save(d):
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")


def parts(v):
    return [p for p in str(v or "").split(os.pathsep) if p.strip()]


def traced():
    for path in (TRACE, LEGACY_TRACE):
        try:
            with open(path, "r", encoding="utf-8") as f:
                if json.load(f).get(RULE):
                    return True
        except Exception:
            pass
    return False


def set_trace(on):
    if on:
        with open(TRACE, "w", encoding="utf-8") as f:
            json.dump({RULE: True}, f)
        if os.path.exists(LEGACY_TRACE):
            os.remove(LEGACY_TRACE)
    else:
        for path in (TRACE, LEGACY_TRACE):
            if os.path.exists(path):
                os.remove(path)


def add_rule(d):
    perms = d.setdefault("permissions", {})
    allow = perms.setdefault("allow", [])
    if RULE in allow:
        return "already present"
    allow.append(RULE)
    set_trace(True)
    return "added"


def remove_rule(d):
    perms = d.get("permissions")
    allow = perms.get("allow") if isinstance(perms, dict) else None
    if not allow or RULE not in allow:
        set_trace(False)
        return "not present"
    if not traced():
        return "kept (you added this rule yourself, so I'm not touching it; you can remove it by hand)"
    allow.remove(RULE)
    if not allow:
        perms.pop("allow", None)
    if not perms:
        d.pop("permissions", None)
    set_trace(False)
    return "removed"


def main():
    cmd = COMMANDS.get((sys.argv[1] if len(sys.argv) > 1 else "").lower())
    if cmd is None:
        print("Usage: python plugin_setup.py add | remove | permission-add | permission-remove")
        return 2
    if cmd in ("add", "remove") and not os.path.isdir(MOD):
        print("NorthLight Tower plugin folder not found:", MOD)
        return 1
    d = load()
    if os.path.exists(SETTINGS) and not os.path.exists(BACKUP):
        shutil.copy2(SETTINGS, BACKUP)
    norm = lambda p: os.path.normcase(os.path.normpath(p))
    legacy = {norm(p) for p in LEGACY_MODS}
    if cmd == "add":
        env = d.setdefault("env", {})
        old = parts(env.get(KEY))
        cur = [p for p in old if norm(p) not in legacy]
        migrated = len(cur) != len(old)
        if not any(norm(p) == norm(MOD) for p in cur):
            cur.append(MOD)
        env[KEY] = os.pathsep.join(cur)
        r = add_rule(d)
        save(d)
        print("NorthLight Tower plugin added. It will load in every newly opened Claude chat.")
        if migrated:
            print("(An entry for the old plugin folder name was replaced with the current one.)")
        print("Plugin folder:", MOD)
        print("Permission to message workers:", r)
    elif cmd == "remove":
        env = d.get("env", {})
        cur = [p for p in parts(env.get(KEY)) if norm(p) != norm(MOD) and norm(p) not in legacy]
        if cur:
            env[KEY] = os.pathsep.join(cur)
        else:
            env.pop(KEY, None)
        if not env:
            d.pop("env", None)
        r = remove_rule(d)
        save(d)
        print("Plugin removed. It will not load in newly opened Claude chats (chats that are already open are not affected).")
        print("Permission to message workers:", r)
    elif cmd == "permission-add":
        r = add_rule(d)
        save(d)
        print("Permission to message workers:", r)
    else:
        r = remove_rule(d)
        save(d)
        print("Permission to message workers:", r)
        print("Messages are now delivered through the main worker.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
