"""NorthLight Tower server (v4).

Watches the Claude Code / Claude Desktop (Code tab) session logs (~/.claude/projects/**/*.jsonl),
treats every session and sub-agent as a "worker" and serves them as JSON at /state.

- Never writes to the logs (read-only). Binds to 127.0.0.1 only.
- Never calls a model, spends no tokens.
- Lightweight: new-file scans are shallow and infrequent (2 s), running sessions are polled cheaply.
- Shuts itself down when unused (no browser tab and no Claude activity for 30 min).

Per worker: state, what it is doing, recent activity, task, department (floor), output images,
office chat. Sending messages does not work without the plugin (reliable events).
"""
import base64
import codecs
import hashlib
import ipaddress
import json
import mimetypes
import ntpath
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import unicodedata
import urllib.error
import fnmatch
import urllib.request
from collections import Counter, OrderedDict, deque
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urljoin, urlparse

def _env(name, default=None):
    """Environment setting NORTHLIGHT_<name>; the earlier PIXELOFIS_<name> spelling is still accepted."""
    return os.environ.get("NORTHLIGHT_" + name, os.environ.get("PIXELOFIS_" + name, default))


PORT = int(_env("PORT", "8765"))
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.path.expanduser("~"), ".claude", "projects")
ACTIVE_SECONDS = int(_env("ACTIVE_SECONDS", str(2 * 3600)))      # if the main session (chat) moved within this time, it becomes a building/tab in the tower
SUB_KEEP_SECONDS = int(_env("SUB_KEEP", str(8 * 3600)))         # how long a finished sub-agent stays in the office (while the main session is open)
IDLE_LEAVE_SECONDS = int(_env("IDLE_LEAVE", str(2 * 3600)))      # an idle main session goes home (its tab closes)
IDLE_EXIT_SECONDS = int(_env("IDLE_EXIT", str(30 * 60)))        # an unused server shuts down
EXIT_ON_IDLE = _env("NO_EXIT") != "1"
RE_SESSION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")   # Claude session id (the name of the log file)
RECENT_PAGE = 50         # default page size of /sessions/recent (if no limit is given)
RECENT_LIMIT_MAX = 200   # most chats on one page (a large limit is clipped to this value); the whole list is walked page by page (offset)
RECENT_Q_MAX = 100       # longest length of the search text
RECENT_TTL = 5.0         # cache time of the list result (s)
RECENT_TAIL = 256 * 1024 # bytes read from the end of the log for the title / working directory (the file is not read from start to end)
RECENT_HEAD = 64 * 1024  # bytes read from the start if not found at the end
PIN_MAX = 30             # most chats that can be pinned at the same time
FIRST_READ_BYTES = 3 * 1024 * 1024   # conversation history for the Messages window (256 KB was not enough for large logs)
TICK = 0.6              # polling interval of the worker files
DISCOVER_EVERY = 2.0    # discovery of new files
MAX_EVENTS = 40
MAX_ART = 60
GAL_MAX = 800                  # persistent gallery: most images kept (old ones are deleted)
DEBUG = bool(_env("DEBUG"))
DUR_KEEP = 20                  # task duration estimate: number of last finished tasks kept per type
DUR_MIN_N = 3                  # no estimate if there are not this many samples
DUR_MIN_S = 5.0                # tasks shorter than this are not counted
DUR_MAX_S = 3 * 3600.0         # tasks longer than this (probably abandoned) are not counted
DUR_NEAR_START = 60.0          # if a worker was first seen at most this long after its start, its duration is measured reliably (not measured if the server caught up later)
DUR_RESUME = 600.0             # if a worker counted as "bitti" (done) because of log silence returns within this time, it counts as the same job
DUR_BUCKETS = 60               # at most this many different types are kept


def cache_dir():
    """Folder of the persistent local files (HERE is read at call time). Can be redirected to a separate folder with NORTHLIGHT_CACHE_DIR (so that a trial server does not spoil the live one)."""
    return _env("CACHE_DIR") or os.path.join(HERE, "_cache")

WRITE_TOOLS = {"Edit", "Write", "NotebookEdit", "Bash", "PowerShell"}
READ_TOOLS = {"Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch", "Skill", "SearchPlugins"}
DELEGATE_TOOLS = {"Agent", "Task", "Workflow"}
PERM_TOOLS = {"Edit": 10, "Write": 10, "NotebookEdit": 10, "Bash": 75, "PowerShell": 75}
LONG_TOOLS = {"Agent", "Task", "Workflow", "Monitor", "ScheduleWakeup"}

TOOL_LABEL = {
    "Edit": "Editing a file", "Write": "Writing a file", "NotebookEdit": "Writing a notebook",
    "Bash": "Running a command", "PowerShell": "Running a command",
    "Read": "Reading a file", "Grep": "Searching file contents", "Glob": "Searching for files",
    "WebFetch": "Reading a web page", "WebSearch": "Searching the web", "ToolSearch": "Searching for a tool",
    "Skill": "Using a skill", "Agent": "Started a worker", "Task": "Started a worker",
    "Workflow": "Managing a team of workers",
}

DESIGN_RE = re.compile(r"görsel|gorsel|piksel|pixel|çiz|ciz|tasar|design|sprite|karakter|animasyon|logo|ikon|icon|image|resim|\bart\b|sanat|palet|tile|asset|arayüz|illüstr|render|pixellab", re.I)
IMG_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp")
VID_EXT = (".mp4", ".webm")
MEDIA_EXT = IMG_EXT + VID_EXT
ANIM_EXT = (".gif", ".webp")
MAX_IMG_BYTES = 12 * 1024 * 1024
MAX_VID_BYTES = 40 * 1024 * 1024
RE_IMG_URL = re.compile(r"https?://[^\s\"'<>(){}\]]+?\.(?:png|jpe?g|gif|webp|mp4|webm)(?:\?[^\s\"'<>)\]]*)?", re.I)
RE_IMG_SRC = re.compile(r"\[Image: source: ([^\]]+?\.(?:png|jpe?g|gif|webp))\]", re.I)
RE_AGENT_ID = re.compile(r"agentId:\s*([0-9a-f]{8,})")
RE_TASK_ID = re.compile(r"<task-id>([0-9a-f]{8,})</task-id>")
RE_STATUS = re.compile(r"<status>(\w+)</status>")

# ---- message attachments (/upload): extension ALLOW list; the type and size limit are enforced here (attachments.js carries the same list only for a quick warning)
UP_EXT = {}
for _k, _exts in (
    ("img", "png jpg jpeg gif webp"),
    ("pdf", "pdf"),
    # code / text: accepted only as text TO BE READ (the content cannot contain a NUL byte)
    ("txt", "txt md markdown json jsonl csv tsv log ini cfg conf toml yaml yml xml html htm css scss less "
            "js mjs cjs ts tsx jsx py gd gdshader tscn tres cs c h cpp hpp cc java kt go rs rb php lua sql sh "
            "glsl hlsl shader vert frag srt vtt diff patch"),
    ("aud", "mp3 wav ogg m4a"),
    ("vid", "mp4 webm mov"),
):
    for _e in _exts.split():
        UP_EXT["." + _e] = _k
# executable / shortcut / registry files: they are not on the allow list anyway; the separate list is only for an explicit rejection reason
UP_DENY_EXT = {"." + e for e in ("exe bat cmd ps1 psm1 psd1 msi msp dll sys scr com cpl msc vbs vbe wsf wsh hta jar lnk url reg pif "
                                 "appx msix appinstaller application gadget inf").split()}
UP_LIMIT = {"img": MAX_IMG_BYTES, "pdf": MAX_IMG_BYTES, "txt": MAX_IMG_BYTES, "aud": MAX_VID_BYTES, "vid": MAX_VID_BYTES}
UP_KIND_TR = {"img": "image", "pdf": "PDF", "txt": "text", "aud": "audio", "vid": "video"}
UP_MEDIA_NOTE = " Note: cannot be read directly; process it by extracting frames/audio with ffmpeg or by transcribing it."
UP_MAX_FILES = 5                       # most attachments in one message
UP_KEEP_SECONDS = 14 * 86400           # uploaded files are deleted after this many days (only our own copies)
UP_DIR_MAX = 1024 * 1024 * 1024        # total upper limit of the upload folder: if exceeded the oldest are deleted
RE_UP_ID = re.compile(r"[0-9a-f]{12}")

# Claude's questions (AskUserQuestion): the mod drops the question with /ask, the office shows a card, the answer comes with /answer, the mod fetches it with /ask/wait.
ASK_MAX_Q = 4                  # most questions on one card (the tool's own limit)
ASK_MAX_OPT = 4                # most options in one question
ASK_Q_LEN = 1000               # question text (clipped for display; the mod matches the answer by its own text)
ASK_HDR_LEN = 24               # header chip
ASK_LABEL_LEN = 200            # option label (not clipped because an exact match is needed: if long, the question is rejected and the mod leaves it to Claude)
ASK_DESC_LEN = 600             # option / question description
ASK_PREVIEW_LEN = 4000         # option preview (shown as plain text)
ASK_ANS_LEN = 2000             # longest form of a single answer
ASK_PENDING_MAX = 8            # most question cards waiting at the same time
ASK_HOLD = 12                  # longest wait of the /ask/wait long polling (s)
ASK_ORPHAN = 45                # if the mod has not polled /ask/wait for this long the question is dropped (the mod / session is gone)
ASK_TTL = 15 * 60              # a question waits at most this long (the mod hands over to Claude earlier, at 10 min)
ASK_DONE_KEEP = 120            # the record of an answered / handed-over question is kept this long (double-answer protection, notification to the office)
RE_ASK_ID = re.compile(r"q[0-9a-f]{16}")


def _ask_str(v, n, field, required=False):
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise ValueError("%s is not text" % field)
    v = scrub(v).strip()
    if required and not v:
        raise ValueError("%s is empty" % field)
    return v[:n]


def _ask_num(v, field):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        raise ValueError("%s is not a number" % field)
    return v


def norm_questions(qs):
    """Validates the questions in the AskUserQuestion input and brings them to the form the office will show. ValueError if broken (the mod leaves it to Claude).
    Option labels are NOT CLIPPED (the answer is the label itself): a question that exceeds the limit is rejected."""
    if not isinstance(qs, list) or not 1 <= len(qs) <= ASK_MAX_Q:
        raise ValueError("There must be 1-%d questions" % ASK_MAX_Q)
    out, seen = [], set()
    for i, q in enumerate(qs):
        if not isinstance(q, dict):
            raise ValueError("Question %d is malformed" % (i + 1))
        text = _ask_str(q.get("question"), ASK_Q_LEN, "question", True)
        if text in seen:
            raise ValueError("The same question appears twice")
        seen.add(text)
        kind = q.get("kind") or "choice"
        if kind not in ("choice", "text", "number"):
            raise ValueError("Unknown question type")
        item = {"question": text, "header": _ask_str(q.get("header"), ASK_HDR_LEN, "header"), "kind": kind,
                "description": _ask_str(q.get("description"), ASK_DESC_LEN, "description"), "multiSelect": q.get("multiSelect") is True, "options": []}
        opts = q.get("options")
        if kind == "choice":
            if not isinstance(opts, list) or not 2 <= len(opts) <= ASK_MAX_OPT:
                raise ValueError("There must be 2-%d options" % ASK_MAX_OPT)
            labels = set()
            for o in opts:
                if not isinstance(o, dict):
                    raise ValueError("Option is malformed")
                lab = o.get("label")
                if not isinstance(lab, str) or not lab.strip() or len(lab) > ASK_LABEL_LEN or lab in labels:
                    raise ValueError("Invalid option label")
                labels.add(lab)
                item["options"].append({"label": scrub(lab), "description": _ask_str(o.get("description"), ASK_DESC_LEN, "description"),
                                        "preview": _ask_str(o.get("preview"), ASK_PREVIEW_LEN, "preview")})
        elif kind == "text":
            item["placeholder"] = _ask_str(q.get("placeholder"), 120, "placeholder")
        else:
            lo, hi = _ask_num(q.get("min"), "min"), _ask_num(q.get("max"), "max")
            if lo is None or hi is None or lo >= hi:
                raise ValueError("A number question needs min < max")
            step = _ask_num(q.get("step"), "step")
            dv = _ask_num(q.get("defaultValue"), "defaultValue")
            item.update(min=lo, max=hi, step=step if step and step > 0 else None,
                        defaultValue=dv if dv is not None and lo <= dv <= hi else None, unit=_ask_str(q.get("unit"), 12, "unit"))
        out.append(item)
    return out


def fmt_num(v):
    return str(int(v)) if float(v).is_integer() else ("%.6f" % v).rstrip("0").rstrip(".")


def build_answers(questions, raw):
    """Converts the structured answers from the office ([{sel:[i..], other}, {text}, {num}] in question order) to Claude's format:
    one text per question; multiple choice is joined with ', ', the 'Diğer' (Other) box is free text. Every question must be answered. ValueError if broken."""
    if not isinstance(raw, list) or len(raw) != len(questions):
        raise ValueError("Every question needs an answer")
    out = []
    for q, a in zip(questions, raw):
        if not isinstance(a, dict):
            raise ValueError("Malformed answer")
        if q["kind"] == "number":
            v = a.get("num")
            if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not q["min"] <= v <= q["max"]:
                raise ValueError("The number must be between %s and %s" % (fmt_num(q["min"]), fmt_num(q["max"])))
            out.append(fmt_num(v))
            continue
        if q["kind"] == "text":
            t = a.get("text")
            t = scrub(t).strip() if isinstance(t, str) else ""
            if not t:
                raise ValueError("Empty answer: \"%s\"" % short(q["question"], 60))
            if len(t) > ASK_ANS_LEN:
                raise ValueError("Answer is too long (max %d characters)" % ASK_ANS_LEN)
            out.append(t)
            continue
        sel = a.get("sel") or []
        other = a.get("other")
        other = scrub(other).strip() if isinstance(other, str) else ""
        if not isinstance(sel, list) or any(isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < len(q["options"]) for i in sel) or len(set(sel)) != len(sel):
            raise ValueError("Invalid selection")
        if len(other) > ASK_ANS_LEN:
            raise ValueError("Answer is too long (max %d characters)" % ASK_ANS_LEN)
        if not q["multiSelect"] and (len(sel) > 1 or (sel and other)):
            raise ValueError("Only one choice is allowed for this question")
        parts = [q["options"][i]["label"] for i in sorted(sel)] + ([other] if other else [])
        if not parts:
            raise ValueError("Unanswered question: \"%s\"" % short(q["question"], 60))
        out.append(", ".join(parts))
    return out


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return time.time()


def classify(tool):
    if tool in WRITE_TOOLS:
        return "typing"
    if tool in READ_TOOLS or "Browser" in tool or "chrome" in tool or "computer-use" in tool:
        return "reading"
    if tool in DELEGATE_TOOLS:
        return "delegating"
    return "typing"


def label_for(tool):
    if tool in TOOL_LABEL:
        return TOOL_LABEL[tool]
    return "Working"


def short(s, n=90):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


_LONE_SURR = re.compile("[\ud800-\udfff]")


def scrub(s):
    """Turns lone surrogate characters (the half of a clipped emoji) into U+FFFD; no text that cannot be converted to UTF-8 remains."""
    return _LONE_SURR.sub("\ufffd", s) if isinstance(s, str) else s


def scrub_obj(o, depth=0):
    """Passes all texts in the incoming JSON body (keys included) through scrub."""
    if isinstance(o, str):
        return scrub(o)
    if depth > 30:
        return o
    if isinstance(o, dict):
        return {scrub(k): scrub_obj(v, depth + 1) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub_obj(v, depth + 1) for v in o]
    return o


# Keys: status texts that older plugin versions / the current Turkish plugin send (input matching, must stay Turkish);
# values: the English texts the UI receives (tr_server.js holds the Turkish originals).
LEGACY_DETAIL = {
    "Turu bitirdi, sıranı bekliyor": "Finished, waiting for your next message",
    "Turu bitirdi": "Finished",
    "Görevi bitirdi": "Finished",
    "İşini bitirdi, yeni mesajını bekliyor": "Finished, waiting for your next message",
    "İşini bitirdi": "Finished",
    "Sıranı bekliyor": "Finished, waiting for your next message",
    "Senden onay bekliyor": "Waiting for approval",
    "Onay bekliyor": "Waiting for approval",
    "Alt ajan başlattı": "Started a worker",
    "Çalışan başlattı": "Started a worker",
    "Ajan sürüsü yönetiyor": "Managing a team of workers",
    "Çalışan ekibini yönetiyor": "Managing a team of workers",
    "Göreve başladı": "Started working",
    "İşe başladı": "Started working",
    "Düşünüyor": "Working",
    "Çalışıyor": "Working",
    "Dosya düzenliyor": "Editing a file",
    "Dosya yazıyor": "Writing a file",
    "Not defteri yazıyor": "Writing a notebook",
    "Komut çalıştırıyor": "Running a command",
    "Dosya okuyor": "Reading a file",
    "İçerik arıyor": "Searching file contents",
    "Dosya arıyor": "Searching for files",
    "Web sayfası okuyor": "Reading a web page",
    "Web'de arıyor": "Searching the web",
    "Araç arıyor": "Searching for a tool",
    "Beceri kullanıyor": "Using a skill",
}


def norm_detail(d):
    """Maps the status texts of old plugins ('Turu bitirdi', 'Çalışıyor: Bash', ...) and of the Turkish plugin to the plain English vocabulary."""
    d = str(d or "")
    if d in LEGACY_DETAIL:
        return LEGACY_DETAIL[d]
    if d.startswith(("Çalışıyor: ", "Araç kullanıyor", "Working: ")):
        return "Working"
    return d


def tr_reason(reason):
    """Shows the failure reason from the mod/Claude to the user in plain English; known patterns are mapped, an unmapped reason passes as it is."""
    r = " ".join(scrub(str(reason or "")).split())
    if not r:
        return ""
    low = r.lower()
    if "no running turn" in low:
        out = "The worker has already stopped"
    elif "classifier" in low or "auto mode" in low or "auto-mode" in low or "verdict" in low:
        out = "Claude's automatic permission check blocked the delivery"
    elif "timed out" in low or "timeout" in low:
        out = "Claude did not respond in time"
    else:
        return r                                   # an unmapped reason (including the plugin's own English/Turkish text) is shown as it is
    if DEBUG:
        try:
            os.makedirs(os.path.join(HERE, "_work"), exist_ok=True)
            with open(os.path.join(HERE, "_work", "ack_reasons.log"), "a", encoding="utf-8") as f:
                f.write(json.dumps({"original": r[:300], "shown": out}, ensure_ascii=False) + "\n")
        except Exception:
            pass
    return out


def base(p):
    p = str(p).replace("\\", "/")
    return p.rsplit("/", 1)[-1] or p


def summarize(name, inp):
    if not isinstance(inp, dict):
        return ""
    try:
        if name in ("Bash", "PowerShell"):
            return short(inp.get("description") or inp.get("command", ""), 100)
        if name in ("Read", "Edit", "Write"):
            return base(inp.get("file_path", ""))
        if name == "NotebookEdit":
            return base(inp.get("notebook_path", ""))
        if name in ("Grep", "Glob"):
            return short(inp.get("pattern", ""), 60)
        if name == "WebFetch":
            return short(inp.get("url", ""), 80)
        if name == "WebSearch":
            return short(inp.get("query", ""), 80)
        if name in ("Agent", "Task"):
            return short(inp.get("description") or inp.get("subagent_type", ""), 80)
        if name == "ToolSearch":
            return short(inp.get("query", ""), 60)
        if name == "Skill":
            return short(inp.get("skill", ""), 60)
        for k in ("description", "name", "query", "prompt", "title", "url", "path", "command", "text"):
            if isinstance(inp.get(k), str) and inp[k].strip():
                return short(inp[k], 80)
        for v in inp.values():
            if isinstance(v, str) and v.strip():
                return short(v, 70)
    except Exception:
        pass
    return ""


def text_of(content):
    if isinstance(content, str):
        parts = [content]
    elif isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    else:
        return ""
    out = []
    for p in parts:
        p = p.strip()
        if not p or p.startswith("<system-reminder"):
            continue
        out.append(p)
    return " ".join(out)


def result_text(block):
    c = block.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(x.get("text", "") for x in c if isinstance(x, dict))
    return ""


MAX_REPLY = 30000       # the longest stored text of a reply
KEEP_REPLIES = 10       # number of last replies stored per agent
RE_FENCE = re.compile(r"```.*?```", re.S)
RE_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
RE_LEAD = re.compile(r"^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)")
RE_OZET = re.compile(r"^\s*(?:\*\*)?(?:ÖZET|SUMMARY)(?:\*\*)?\s*[:：\-–—]\s*(?:\*\*)?", re.I)
RE_SYSREM = re.compile(r"<system-reminder>.*?</system-reminder>|<pasted_content[^>]*>|</pasted_content[^>]*>", re.S)
RE_CMD = re.compile(r"<command-name>\s*(/?[^<\s]+)\s*</command-name>(?:.*?<command-args>(.*?)</command-args>)?", re.S)


RE_HEADING = re.compile(r"^\s*#{1,6}\s+")
HEAD_END = ".!?…:;\"'”’»"


def head_of(text, n=160):
    """Single-line plain preview of the reply (at most n characters): code blocks, heading/list markers and the 'ÖZET:' (SUMMARY:) prefix are dropped.
    A leading markdown heading (if there is a body) is dropped; a short first line without punctuation is joined to the body with ': '."""
    src = str(text or "")[:3000]          # more than enough for a preview; so that the regex does not freeze on long input
    body = RE_FENCE.sub(" ", src)
    if not body.strip():
        body = src.replace("```", " ")
    lines, heads, plain = [], [], []
    for raw in body.splitlines():
        heading = bool(RE_HEADING.match(raw))
        lead = bool(RE_LEAD.match(raw))
        ln = RE_LEAD.sub("", raw.strip())
        ln = RE_LINK.sub(r"\1", ln).replace("**", "").replace("__", "").replace("`", "")
        ln = ln.strip(" |")
        if ln and not re.fullmatch(r"[-=_*|: ]+", ln):
            lines.append(ln)
            heads.append(heading)
            plain.append(not lead)
    while len(lines) > 1 and heads[0]:
        lines.pop(0)
        heads.pop(0)
        plain.pop(0)
    if len(lines) > 1 and plain[0] and len(lines[0]) <= 80 and lines[0][-1] not in HEAD_END and not RE_OZET.match(lines[0]):
        lines[0] += ":"
    flat = " ".join(lines)
    flat = RE_OZET.sub("", flat, count=1).strip()
    return short(flat, n)


def clean_prompt(tx):
    """Visible task text from the user prompt; system/command leftovers return empty (the previous task is kept)."""
    tx = (tx or "").strip()
    if not tx or tx.startswith(("[Request interrupted", "<local-command", "<task-notification",
                                "This session is being continued", "[Piksel Ofis sohbeti] ", "[NorthLight Tower")):
        return ""
    m = RE_CMD.match(tx)
    if m:
        return ("%s %s" % (m.group(1), (m.group(2) or "").strip())).strip()
    return tx


ABBREV = {"st", "dr", "mr", "mrs", "ms", "no", "vs", "vb", "vd", "sn", "prof", "doç", "yrd", "ör", "bkz", "yy", "tel", "adr", "cad", "sok", "mah", "inc", "ltd", "co", "etc", "fig", "ca"}


def first_phrase(s, n=40):
    """Task title: the first line/sentence of the text, at most n characters (if long it is cut at a word boundary and … is appended)."""
    s = str(s or "").strip()
    if not s:
        return ""
    s = s.splitlines()[0].strip()
    for m in re.finditer(r"[.!?]\s", s + " "):
        head = s[: m.end() - 1]
        word = re.search(r"(\w+)[.!?]$", head)
        if len(head) < 8 or (word and word.group(1).lower() in ABBREV):      # "St. Moritz", "vb. ..." (vb. = Turkish abbreviation for etc.) do not count as a sentence end
            continue
        if len(head) <= n:
            s = head.rstrip(".")
        break
    if len(s) <= n:
        return s
    cut = s[: n - 1]
    sp = cut.rfind(" ")
    if sp >= n // 2:
        cut = cut[:sp]
    return cut.rstrip(" ,;:-–—.") + "…"


def stable_hash(s):
    return int(hashlib.md5(str(s).encode("utf-8")).hexdigest()[:8], 16)


def load_names():
    """assets/names.json (the page loads the same file too). If broken/missing a small fallback is used."""
    d = {}
    try:
        with open(os.path.join(HERE, "assets", "names.json"), "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        pass
    pick = lambda key: [(x["char"], x["nick"]) for x in d.get(key, []) if isinstance(x, dict) and x.get("char") and x.get("nick")]
    staff = pick("staff") or [("robot", "Robi")]
    bosses = pick("bosses") or [("mudur", "Müdür"), ("mudire", "Müdire")]
    types = d.get("types_tr") if isinstance(d.get("types_tr"), dict) else {}
    return staff, bosses, types, str(d.get("type_default_tr") or "Çalışan")      # Turkish names: the client (PO.localizeInfo) translates them to English with nick_en / types_en


class Namer:
    """Character / name assignment. Once assigned it does not change (in memory). Sub-agent: starting from hash(key) % N, the first character
    not used in the session; if all are taken, the least used one ("Hayalet 2"). Main agent: hash(session) % 2.
    Key: the tool_use id of the Agent call (if any), so that the same person stays when the "spawn-…" placeholder turns into the real file.
    On restart new agents are assigned in 'started' order, so the result comes out the same."""

    def __init__(self):
        self.by_key = {}        # key -> {"char","nick","session"}
        self.alias = {}         # agent/placeholder id -> key
        self.use = {}           # session -> Counter(character)
        self.orphans = {}       # key born from a placeholder whose real agent has not been found yet -> (session, type, description)
        self.mtime = None
        self.checked = 0.0
        self.staff, self.bosses, self.types, self.default = load_names()

    def refresh(self, now):
        if now - self.checked < 5:
            return
        self.checked = now
        try:
            m = os.path.getmtime(os.path.join(HERE, "assets", "names.json"))
        except OSError:
            return
        if m != self.mtime:
            self.mtime = m
            self.staff, self.bosses, self.types, self.default = load_names()

    def kind_tr(self, atype):
        return (self.types.get(atype) or self.default) if atype else self.default

    def _pick(self, session, key):
        n = len(self.staff)
        h = stable_hash(key) % n
        order = [(h + i) % n for i in range(n)]
        cnt = self.use.setdefault(session, Counter())
        idx = next((i for i in order if cnt[self.staff[i][0]] == 0), None)
        if idx is None:
            low = min(cnt[self.staff[i][0]] for i in order)
            idx = next(i for i in order if cnt[self.staff[i][0]] == low)
        char, nick = self.staff[idx]
        c = cnt[char]
        cnt[char] += 1
        return {"char": char, "nick": nick if c == 0 else "%s %d" % (nick, c + 1), "session": session}

    def assign(self, items, now=None):
        """items: [{id, session, sub, tid, started, desc, type, ph}] -> {id: (char, nick)}"""
        self.refresh(now or time.time())
        sessions = {it["session"] for it in items}
        ids = {it["id"] for it in items}
        for k in [k for k, v in self.by_key.items() if v["session"] not in sessions]:
            del self.by_key[k]
            self.orphans.pop(k, None)
        for s in [s for s in self.use if s not in sessions]:
            del self.use[s]
        for i in [i for i in self.alias if i not in ids or self.alias[i] not in self.by_key]:
            del self.alias[i]
        todo = [it for it in items if it["id"] not in self.alias]
        todo.sort(key=lambda it: (it.get("started") or float("inf"), it["id"]))
        for it in todo:
            iid, session = it["id"], it["session"]
            key = it.get("tid") or None
            if key and key in self.by_key:
                self.alias[iid] = key
                if not it.get("ph"):
                    self.orphans.pop(key, None)
                continue
            if not key and it["sub"] and not it.get("ph"):
                for ok, (osess, otype, odesc) in list(self.orphans.items()):
                    if osess == session and odesc == (it.get("desc") or "") and otype == (it.get("type") or ""):
                        key = ok
                        break
                if key:
                    self.alias[iid] = key
                    self.orphans.pop(key, None)
                    continue
            key = key or iid
            if key in self.by_key:
                self.alias[iid] = key
                continue
            if it["sub"]:
                self.by_key[key] = self._pick(session, key)
            else:
                ch, nk = self.bosses[stable_hash(session) % len(self.bosses)]
                self.by_key[key] = {"char": ch, "nick": nk, "session": session}
            self.alias[iid] = key
            if it.get("ph"):
                self.orphans[key] = (session, it.get("type") or "", it.get("desc") or "")
        return {i: (self.by_key[k]["char"], self.by_key[k]["nick"]) for i, k in self.alias.items() if k in self.by_key}


RE_MEDIA_Q = re.compile(r"[\"']([A-Za-z]:[\\/][^\"'\r\n]+?\.(?:gif|mp4|webm))[\"']", re.I)
RE_MEDIA_U = re.compile(r"(?<![\w:/\\.])((?:[A-Za-z]:[\\/]|/[a-zA-Z]/)[^\s\"'<>|*?]+?\.(?:gif|mp4|webm))(?![\w])", re.I)


def media_paths(cmd):
    """Absolute GIF/MP4/WEBM paths in the command text (the agent may have produced the animation with a command). Converts Git Bash paths (/c/...)."""
    out = []
    for rx in (RE_MEDIA_Q, RE_MEDIA_U):
        for m in rx.finditer(cmd or ""):
            q = m.group(1).strip()
            mm = re.match(r"^/([a-zA-Z])/(.*)$", q)
            if mm:
                q = mm.group(1).upper() + ":/" + mm.group(2)
            q = q.replace("/", "\\")
            if q not in out:
                out.append(q)
    return out[:6]


def img_candidates(text):
    """Finds the image addresses in the text (URL and [Image: source: path])."""
    out = []
    for m in RE_IMG_SRC.finditer(text or ""):
        out.append(m.group(1).strip())
    for m in RE_IMG_URL.finditer(text or ""):
        out.append(m.group(0))
    return out


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _public_host(host):
    """True only if the host name resolves to public IPs only (local network / loopback / link-local are rejected)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            if not ipaddress.ip_address(info[4][0]).is_global:
                return False
        except ValueError:
            return False
    return True


def fetch_public_image(url, limit=MAX_VID_BYTES):
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(4):
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname or not _public_host(u.hostname):
            raise ValueError("invalid address")
        req = urllib.request.Request(url, headers={"User-Agent": "NorthLightTower/4"})
        try:
            resp = opener.open(req, timeout=12)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urljoin(url, e.headers["Location"])
                continue
            raise
        with resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not ctype.startswith(("image/", "video/")) and not urlparse(url).path.lower().endswith(MEDIA_EXT):
                raise ValueError("not an image")
            lim = MAX_VID_BYTES if (ctype.startswith("video/") or urlparse(url).path.lower().endswith(VID_EXT)) else MAX_IMG_BYTES
            data = resp.read(min(limit, lim) + 1)
            if len(data) > min(limit, lim):
                raise ValueError("too large")
            return data, ctype
    raise ValueError("too many redirects")


# ------------------------------------------------------------- message attachments
def upload_root():
    """Root of the uploaded attachments (HERE is read at call time: tests give a temporary folder). Not in static serving (_cache is not on the allow list)."""
    return os.path.join(cache_dir(), "yuklemeler")


def safe_upload_name(raw):
    """The name given by the client -> (stem, extension, kind). Path parts, control / direction characters and dots are dropped; if the extension is not on the allow
    list, ValueError (Turkish reason). The saved name is always "<id>_<stem><extension>" (<kimlik>_<gövde><uzantı>): a single dot, no path traversal."""
    try:
        s = unquote(str(raw or ""), errors="strict")
    except Exception:
        s = ""
    s = unicodedata.normalize("NFC", s)
    s = re.split(r"[\\/]", s)[-1]                                  # "../../x.png", "C:\\a\\b.png" -> only the last name
    s = "".join(ch for ch in s if ch.isprintable()).strip().rstrip(". ")   # control / invisible direction characters, trailing dot-space
    stem, ext = os.path.splitext(s)
    ext = ext.lower()
    if not stem or not ext:
        raise ValueError("Could not determine the file type (no extension)")
    if ext in UP_DENY_EXT:
        raise ValueError("Executable files cannot be attached (%s)" % ext)
    kind = UP_EXT.get(ext)
    if not kind:
        raise ValueError("This file type cannot be attached (%s)" % ext[:12])
    stem = re.sub(r"[^\w\-()+ ]", "_", stem)                      # everything including the dot becomes "_": the stem of "fatura.exe" becomes "fatura_exe"
    stem = re.sub(r"\s+", " ", re.sub(r"_{2,}", "_", stem)).strip(" _-")[:60].strip(" _-")
    return (stem or "file"), ext, kind


def upload_sniff_ok(kind, ext, head):
    """Does the content match the extension (the first 64 KB is looked at). The image really being an image is also needed for Claude's Read tool."""
    if not head:
        return False
    if kind == "txt":
        if head.startswith((b"\xff\xfe", b"\xfe\xff")):              # UTF-16 text (with BOM): NUL bytes are natural; it must really decode
            enc = "utf-16-le" if head[:2] == b"\xff\xfe" else "utf-16-be"
            try:
                s = codecs.getincrementaldecoder(enc)("strict").decode(head[2:], final=False)   # half a character at the 64 KB limit is no problem
            except UnicodeDecodeError:
                return False
            return not any((ord(c) < 32 and c not in "\t\n\r\f\v\x1b") or 0x7F <= ord(c) <= 0x9F for c in s)
        return b"\x00" not in head                                  # a binary file (exe, zip...) cannot come with a text extension
    if ext == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in (".jpg", ".jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == ".gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if ext == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if ext == ".pdf":
        return head.startswith(b"%PDF-")
    if ext == ".mp3":
        return head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    if ext == ".wav":
        return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    if ext == ".ogg":
        return head.startswith(b"OggS")
    if ext == ".webm":
        return head.startswith(b"\x1a\x45\xdf\xa3")
    if ext in (".mp4", ".m4a", ".mov"):
        # ISO/QuickTime boxes: the first box must be ftyp; only padding boxes (free/skip/wide/mdat) can precede it
        pos = 0
        for _ in range(8):
            if pos + 8 > len(head):
                return False
            size, typ = int.from_bytes(head[pos:pos + 4], "big"), head[pos + 4:pos + 8]
            if typ == b"ftyp":
                return True
            if typ not in (b"free", b"skip", b"wide", b"mdat"):
                return False
            if size == 1:                                           # 64-bit size
                if pos + 16 > len(head):
                    return False
                size = int.from_bytes(head[pos + 8:pos + 16], "big")
            if size < 8:                                            # 0 = to the end of the file: ftyp cannot come after it
                return False
            pos += size
        return False
    return False


def size_tr(n):
    if n < 1024:
        return "%d bytes" % n
    if n < 1024 * 1024:
        return "%d KB" % max(1, round(n / 1024))
    if n < 1024 ** 3:
        return "%.1f MB" % (n / (1024 * 1024))
    return "%.1f GB" % (n / 1024 ** 3)


def attach_line(path, kind, size):
    """The attachment line in the text going to the worker: full absolute path (can be opened with the Read tool); a note on how to process audio/video.
    Name and path are quoted and labeled: so that a file name is not read as an instruction (the name is already limited to letters/digits/spaces/()+-)."""
    s = '[Attachment: name="%s" (%s, %s) path="%s"]' % (os.path.basename(path).split("_", 1)[-1], UP_KIND_TR[kind], size_tr(size), path)
    return s + UP_MEDIA_NOTE if kind in ("aud", "vid") else s


# a "[Attachment: ..." (old: "[Ek: ...") line that the user typed by hand must not be mistaken for a real attachment: "[Attachment:" at line start -> "(Attachment:" (attachments.js neutral() does the same)
RE_FAKE_ATTACH = re.compile(r"^((?:[^\S\n]|﻿)*)\[(Ek:|Attachment:)", re.M | re.I)


def neutral_text(text):
    return RE_FAKE_ATTACH.sub(r"\1(\2", text)


def up_sid(sid):
    """Upload folder name (the safe form of the session id); which session an attachment belongs to is checked against this."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(sid or ""))[:64].strip("_") or "genel"


def dept_of(is_sub, label_text, agent_type, tool_names):
    if not is_sub:
        return "mudur"
    if any(n.startswith("mcp__pixellab") or n in ("Artifact", "DesignSync") for n in tool_names):
        return "tasarim"
    if DESIGN_RE.search(label_text or ""):
        return "tasarim"
    if agent_type in ("Explore", "Plan", "claude-code-guide"):
        return "arastirma"
    return "kod"


class Agent:
    def __init__(self, path):
        self.path = path
        self.pos = 0
        self.first = True
        norm = path.replace("\\", "/")
        self.sub = "/subagents/" in norm
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        parts = rel.split("/")
        self.project_dir = parts[0]
        stem = os.path.splitext(os.path.basename(path))[0]
        self.id = stem
        if self.sub:
            self.parent = parts[1] if len(parts) > 2 else None
            self.session = self.parent or stem
        else:
            self.parent = None
            self.session = stem
        self.title = None
        self.cwd = None
        self.pending = {}
        self.last = "idle"
        self.last_ts = 0.0
        self.first_ts = 0.0
        self.events = deque(maxlen=MAX_EVENTS)
        self.task = ""
        self.tool_count = 0
        self.tool_names = Counter()
        self.meta = {}
        self.meta_mtime = 0
        self.sidechain = False
        self._state = None
        self._since = time.time()
        self.hook_waiting = None
        self.perm_mode = None
        self.spawns = {}
        self.new_art = []            # (src, label, ts) - the watcher records it
        self.pending_media = {}      # tool call id -> (time, [GIF/MP4/WEBM paths in the command])
        self.file_mtime = 0.0
        self.prompt = ""             # last user prompt (the reply's "görev" (task) field)
        self.replies = deque(maxlen=KEEP_REPLIES)   # final replies: {c,t,text,task,mid,src}
        self.reply_count = 0         # number of replies captured for this agent (c)
        self.reply_offset = 0        # n = c + offset (so that n does not go backwards on restart)
        self.saved = None            # [n, t] from the previous run (persistent mark)
        self._replayed = 0           # replies older than the saved mark (already counted before)
        self._first_done = False
        self.pending_end = None      # sub-agent: the last text that will count as the reply if SubagentHandback does not come
        self.convo = deque(maxlen=40)  # the manager's conversation in the session log: {t,who,text} (for the Messages window)

    def add_convo(self, ts, who, text, mid=None):
        text = RE_SYSREM.sub("", str(text or "").replace("\r\n", "\n")).strip()
        if not text:
            return
        last = self.convo[-1] if self.convo else None
        if who == "ajan" and last and mid and last.get("mid") == mid:        # the log writes each text block on a separate line
            last["text"] = (last["text"] + "\n\n" + text)[:4000]
            return
        self.convo.append({"t": ts, "who": who, "text": text[:4000], "mid": mid})

    # ------------------------------------------------------------- replies
    def add_reply(self, ts, text, mid=None, src="end"):
        """Records the final text of a turn. Merges extra text blocks that come with the same message id (the log writes each block on a separate line);
        does not count again a report that the sub-agent re-delivered unchanged. Line breaks are kept."""
        text = str(text or "").replace("\r\n", "\n").strip()
        if not text:
            return
        last = self.replies[-1] if self.replies else None
        if last and mid and last["mid"] == mid:
            last["text"] = (last["text"] + "\n\n" + text)[:MAX_REPLY]
            last.pop("head", None)
            return
        if last and src == "handback" and last["src"] == "handback" and last["text"] == text[:MAX_REPLY]:
            return
        if len(text) > MAX_REPLY:
            text = text[: MAX_REPLY - 1] + "…"
        self.reply_count += 1
        if self.saved and ts <= self.saved[1] + 0.5:
            self._replayed += 1
        self.replies.append({"c": self.reply_count, "t": ts, "text": text, "task": self.prompt, "mid": mid, "src": src})

    def commit_pending(self, now):
        """If a sub-agent finished without calling SubagentHandback (old versions), counts the last text as the reply."""
        pe = self.pending_end
        if pe and now - pe["t"] > 120:
            self.pending_end = None
            self.add_reply(pe["t"], pe["text"], pe["mid"], "end")

    def _finish_first(self):
        if self._first_done:
            return
        self._first_done = True
        if self.saved:                                   # the last reply is aligned with the saved n
            self.reply_offset = max(0, int(self.saved[0]) - self._replayed)

    def reply_n(self, e):
        return e["c"] + self.reply_offset

    def reply_mark(self):
        if not self.replies or not self._first_done:
            return None
        e = self.replies[-1]
        return [self.reply_n(e), round(e["t"], 3)]

    def reply_info(self):
        """(reply, reply_hist): the light summary that goes into /state (no full text)."""
        if not self.replies:
            return None, []
        hist = [{"n": self.reply_n(e), "t": e["t"], "head": e.get("head") or e.setdefault("head", head_of(e["text"]))} for e in self.replies]
        e = self.replies[-1]
        return {"n": hist[-1]["n"], "t": e["t"], "head": hist[-1]["head"], "len": len(e["text"])}, hist

    def reply_get(self, n=None):
        if not self.replies:
            return None
        if n is None:
            return self.replies[-1]
        for e in self.replies:
            if self.reply_n(e) == n:
                return e
        return None

    def read_meta(self):
        if not self.sub:
            return
        mp = os.path.splitext(self.path)[0] + ".meta.json"
        try:
            m = os.path.getmtime(mp)
            if m != self.meta_mtime:
                with open(mp, "r", encoding="utf-8", errors="ignore") as f:
                    self.meta = json.load(f)
                self.meta_mtime = m
        except Exception:
            pass

    def project_label(self):
        """Project name: the folder where the session started. Claude names the session folder with the encoded form of the starting directory
        (every character other than letter/digit becomes "-"); we go up from the seen working directory and find the folder that matches this code.
        So the project name stays fixed even if the shell moves to another folder."""
        if self.cwd:
            cur = self.cwd.rstrip("\\/")
            for _ in range(16):
                if re.sub(r"[^A-Za-z0-9]", "-", cur) == self.project_dir:
                    return base(cur) or cur
                nxt = ntpath.dirname(cur)
                if not nxt or nxt == cur:
                    break
                cur = nxt
            return base(self.cwd.rstrip("\\/")) or self.cwd
        proj = self.project_dir
        for marker in ("Desktop-", "Desktop"):
            if marker in proj:
                proj = proj.split(marker, 1)[1] or proj
                break
        return proj

    def label(self):
        if self.sub or self.sidechain:
            t = self.meta.get("agentType") or "Worker"
            d = self.meta.get("description")
            return "%s · %s" % (t, short(d, 28)) if d else "%s · %s" % (t, self.id[-6:])
        return self.title or self.project_label() or self.session[:8]

    def add_event(self, ts, kind, text):
        if text:
            self.events.append({"t": ts, "k": kind, "x": text})

    def add_art(self, text, label, ts):
        for c in img_candidates(text):
            self.new_art.append((c, label, ts))

    def feed(self, line):
        try:
            d = json.loads(line)
        except Exception:
            return
        t = d.get("type")
        if t == "custom-title":
            v = d.get("customTitle") or d.get("title")
            if isinstance(v, str) and v:
                self.title = v
            return
        if t == "agent-name" and not self.title and not self.sub:
            v = d.get("agentName")
            if isinstance(v, str) and v:
                self.title = v
            return
        if t == "attachment":
            att = d.get("attachment") or {}
            if att.get("type") == "queued_command" and "<task-notification>" in str(att.get("prompt", "")):
                pr = str(att.get("prompt", ""))
                m1, m2 = RE_TASK_ID.search(pr), RE_STATUS.search(pr)
                if m1 and (not m2 or m2.group(1) != "running"):
                    for sp in self.spawns.values():
                        if sp["agent_id"] == m1.group(1):
                            sp["done"] = True
                            self.add_event(parse_ts(d.get("timestamp", "")), "done", "Worker finished: " + short(sp["desc"], 60))
            return
        if d.get("isSidechain"):
            self.sidechain = True
        if t not in ("assistant", "user"):
            return
        if d.get("cwd") and isinstance(d["cwd"], str):          # so that /state does not crash if a list/number comes in a broken log
            self.cwd = d["cwd"]
        if d.get("permissionMode"):
            self.perm_mode = d["permissionMode"]
        ts = parse_ts(d.get("timestamp", ""))
        if not self.first_ts:
            self.first_ts = ts
        msg = d.get("message") or {}
        content = msg.get("content")
        if t == "assistant":
            self.last_ts = max(self.last_ts, ts)
            blocks = content if isinstance(content, list) else []
            has_tool = False
            for b in blocks:
                bt = b.get("type")
                if bt == "tool_use":
                    name = b.get("name", "")
                    if name == "SubagentHandback":
                        self.last = "done"
                        self.add_event(ts, "done", "Finished, handed in the report")
                        hb = b.get("input") if isinstance(b.get("input"), dict) else {}
                        self.pending_end = None
                        self.add_reply(ts, hb.get("message") if isinstance(hb.get("message"), str) else "", msg.get("id"), "handback")
                        continue
                    has_tool = True
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    summ = summarize(name, inp)
                    self.pending[b.get("id")] = (name, ts, summ)
                    self.last = "tool"
                    self.tool_count += 1
                    self.tool_names[name] += 1
                    self.add_event(ts, "tool", "%s%s" % (name, " · " + summ if summ else ""))
                    fp = inp.get("file_path") if isinstance(inp.get("file_path"), str) else ""
                    if name in ("Write", "Edit") and fp.lower().endswith(IMG_EXT):
                        self.new_art.append((fp, base(fp), ts))
                    if name in ("Bash", "PowerShell") and isinstance(inp.get("command"), str):
                        mp = media_paths(inp["command"])
                        if mp:
                            self.pending_media[b.get("id")] = (ts, mp)
                    if name in ("Agent", "Task"):
                        self.spawns[b.get("id")] = {
                            "desc": inp.get("description") or short(inp.get("prompt", ""), 40) or "New worker",
                            "type": inp.get("subagent_type") or "general-purpose",
                            "ts": ts, "bg": bool(inp.get("run_in_background")), "agent_id": None, "done": False,
                        }
                elif bt == "text":
                    tx = (b.get("text") or "").strip()
                    if tx:
                        self.add_event(ts, "say", short(tx, 110))
            if (not has_tool and msg.get("stop_reason") == "end_turn" and not d.get("isApiErrorMessage")
                    and msg.get("model") != "<synthetic>"):
                # final text of the turn (the log writes each content block on a separate line; those with the same message id are merged)
                tx = "\n\n".join((b.get("text") or "").strip() for b in blocks if b.get("type") == "text" and (b.get("text") or "").strip())
                if tx:
                    if self.sub or self.sidechain:       # a sub-agent report comes with SubagentHandback; if it does not, commit_pending counts it
                        pe = self.pending_end
                        if pe and msg.get("id") and pe["mid"] == msg.get("id"):
                            pe["text"] += "\n\n" + tx
                        else:
                            self.pending_end = {"t": ts, "text": tx, "mid": msg.get("id")}
                    else:
                        self.add_reply(ts, tx, msg.get("id"), "end")
                        self.add_convo(ts, "ajan", tx, msg.get("id"))
            if not has_tool and self.last != "done":
                if msg.get("stop_reason") == "end_turn" and any(b.get("type") == "text" for b in blocks):
                    self.last = "done"
                elif self.last != "tool":
                    self.last = "thinking"
            elif not has_tool and msg.get("stop_reason") == "end_turn" and any(b.get("type") == "text" for b in blocks):
                self.last = "done"
        else:
            if d.get("isMeta"):
                return
            self.last_ts = max(self.last_ts, ts)
            if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        tid = b.get("tool_use_id")
                        name = self.pending.get(tid, ("", 0, ""))[0]
                        rt = result_text(b)
                        if rt and ("http" in rt or "[Image" in rt):
                            self.add_art(rt, "", ts)
                        pm = self.pending_media.pop(tid, None)
                        if pm and not b.get("is_error"):
                            for mpth in pm[1]:                      # animation files produced by the command (written after the command) go to the gallery
                                try:
                                    if os.path.isfile(mpth) and os.path.getmtime(mpth) >= pm[0] - 3:
                                        self.new_art.append((mpth, base(mpth), ts))
                                except OSError:
                                    pass
                        self.pending.pop(tid, None)
                        sp = self.spawns.get(tid)
                        if sp:
                            if sp["bg"]:
                                m = RE_AGENT_ID.search(rt)
                                if m:
                                    sp["agent_id"] = m.group(1)
                                else:
                                    sp["done"] = True
                            else:
                                sp["done"] = True
                if self.last != "done":
                    self.last = "tool" if self.pending else "thinking"
            else:
                tx = text_of(content)
                self.last = "thinking"
                self.hook_waiting = None
                if tx:
                    self.task = short(tx, 160)
                    pr = clean_prompt(tx)
                    if pr:
                        self.prompt = short(pr, 300)
                        if not self.sub and not self.sidechain:
                            self.add_convo(ts, "ben", pr)
                    self.add_event(ts, "task", short(tx, 110))

    def read_new(self):
        try:
            size = os.path.getsize(self.path)
            self.file_mtime = os.path.getmtime(self.path)
        except OSError:
            return
        if self.first:
            self.pos = max(0, size - FIRST_READ_BYTES)
        if size < self.pos:
            self.pos = 0
        if size == self.pos and not self.first:
            return
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            data = f.read()
        end = data.rfind(b"\n")
        if end == -1:
            self.first = False
            self._finish_first()
            return
        chunk = data[: end + 1]
        self.pos += len(chunk)
        # split ONLY on "\n": splitlines() also splits at U+2028/U+2029/\x1c-\x1e/\x85 characters inside the text and would break a message into pieces
        lines = chunk.decode("utf-8", errors="ignore").split("\n")
        if self.first and self.pos - len(chunk) > 0 and lines:
            lines = lines[1:]
        for ln in lines:
            if ln.strip():
                try:
                    self.feed(ln)
                except Exception as e:      # a broken/unexpected line must not freeze the whole watcher
                    if DEBUG:
                        print("feed skipped:", repr(e))
        self.first = False
        self._finish_first()

    def snapshot(self, now):
        state, tool, detail, target = "thinking", "", "", ""
        bypass = self.perm_mode == "bypassPermissions"
        if self.hook_waiting and now - self.hook_waiting < 3600:
            state, detail = "waiting", "Waiting for approval"
        elif self.pending:
            name, ts, summ = max(self.pending.values(), key=lambda v: v[1])
            age = now - ts
            tool, target = name, summ
            lim = PERM_TOOLS.get(name)
            if not bypass and name not in LONG_TOOLS and lim and age > lim:
                state, detail = "waiting", "May be waiting for approval"
            else:
                state, detail = classify(name), label_for(name)
        elif self.last == "done" or (self.last_ts and now - self.last_ts > 90):
            state, detail = "done", "Finished, waiting for your next message"
        else:
            state, detail = "thinking", "Working"
        if state != self._state:
            self._state, self._since = state, now
        finished = bool(self.meta.get("finished")) if self.sub else False
        if self.sub:
            if finished or self.last == "done":
                state, detail = "done", "Finished"
            elif state == "thinking" and not self.pending:
                state, detail = "typing", "Working"
        return {
            "id": self.id,
            "session": self.session,
            "parent": self.parent,
            "label": self.label(),
            "project": self.project_label(),
            "sub": bool(self.sub or self.sidechain),
            "agent_type": self.meta.get("agentType") if self.sub else None,
            "state": state,
            "tool": tool,
            "detail": detail,
            "target": target,
            "since": self._since,
            "started": self.first_ts or None,
            "idle_for": round(now - self.last_ts, 1) if self.last_ts else None,
            "task": self.task,
            "tools": self.tool_count,
            "events": list(self.events)[-14:],
            "finished": finished,
        }


_FOLD_TR = str.maketrans("İIıŞşĞğÜüÖöÇç", "iiissgguuoocc")


def fold_tr(s):
    """Folding for search: lower case, Turkish letters are simplified (İ/I/ı → i, ş → s, ğ → g, ü → u, ö → o, ç → c): typing "isik" finds "Işık"."""
    return s.translate(_FOLD_TR).lower()


def _scan_meta(chunk, drop_first):
    """Title, agent name, working directory and sub-agent (sidechain) flag from a log chunk (head or tail). Message content is not read:
    only lines that carry the relevant key are decoded. drop_first: the chunk starts in the middle of the file (the first line is partial)."""
    title = name = cwd = None
    side = False
    lines = chunk.split(b"\n")
    if drop_first:
        lines = lines[1:]
    for ln in lines:
        if not (b'"custom-title"' in ln or b'"agent-name"' in ln or b'"cwd"' in ln):
            continue
        try:
            d = json.loads(ln.decode("utf-8", errors="ignore"))
        except Exception:
            continue                               # partial last line (being written) or a broken line
        if not isinstance(d, dict):
            continue
        t = d.get("type")
        if t == "custom-title":
            v = d.get("customTitle") or d.get("title")
            if isinstance(v, str) and v.strip():
                title = v
        elif t == "agent-name":
            v = d.get("agentName")
            if isinstance(v, str) and v.strip():
                name = v
        elif t in ("user", "assistant"):
            if d.get("isSidechain"):
                side = True
            if isinstance(d.get("cwd"), str) and d["cwd"]:
                cwd = d["cwd"]
    return title, name, cwd, side


def session_meta(path, size):
    """List info of a main session log: {title, project, side}. Only the last RECENT_TAIL and, if needed, the first RECENT_HEAD bytes are read.
    The title / project label is produced with the same rule as Agent (custom title > agent name > project name)."""
    title = name = cwd = None
    side = False
    try:
        with open(path, "rb") as f:
            start = max(0, size - RECENT_TAIL)
            f.seek(start)
            title, name, cwd, side = _scan_meta(f.read(RECENT_TAIL), start > 0)
            if start > 0 and (not title or not cwd):
                f.seek(0)
                t2, n2, c2, s2 = _scan_meta(f.read(min(RECENT_HEAD, start)), False)
                title, name, cwd, side = title or t2, name or n2, cwd or c2, side or s2
    except OSError:
        return None
    ag = Agent(path)
    ag.cwd, ag.title = cwd, title or name
    return {"title": scrub(short(ag.label(), 80)), "project": scrub(short(ag.project_label(), 60)), "side": side}


_BUILD = {"t": 0.0, "v": ""}


def build_id():
    """Last change time of the page files (js/css/html): so that an open page notices the new version and refreshes itself."""
    now = time.time()
    if now - _BUILD["t"] > 2:
        _BUILD["t"] = now
        m = 0
        try:
            for n in os.listdir(HERE):
                if n.endswith((".js", ".css", ".html")):
                    m = max(m, int(os.path.getmtime(os.path.join(HERE, n))))
        except OSError:
            pass
        _BUILD["v"] = str(m)
    return _BUILD["v"]


# ------------------------------------------------------------- task duration estimate (only the durations of jobs finished in the past)
RE_DUR_KEY = re.compile(r"[\w.:\- ]{1,40}")


def dur_bucket(sub, agent_type):
    """Duration bucket: main agent "ana" (main); sub-agent its own agent type ("alt" (sub) if it has no type). Only the type name is stored, not the content."""
    if not sub:
        return "ana"
    t = str(agent_type or "").strip()
    return t if t != "ana" and RE_DUR_KEY.fullmatch(t) else "alt"


def dur_stats(vals):
    """From the duration list {est: median s, hi: ~75th percentile s, n: sample count} or None (below DUR_MIN_N)."""
    v = sorted(x for x in vals if isinstance(x, (int, float)) and not isinstance(x, bool) and DUR_MIN_S <= x <= DUR_MAX_S)
    n = len(v)
    if n < DUR_MIN_N:
        return None
    med = v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2
    pos = 0.75 * (n - 1)
    lo = int(pos)
    hi = max(med, v[lo] + (v[min(lo + 1, n - 1)] - v[lo]) * (pos - lo))      # ~75th percentile (linear interpolation)
    return {"est": round(med, 1), "hi": round(hi, 1), "n": n}


def dur_count(vals):
    """Number of valid samples that pass the same filter as dur_stats (for the "n/3 jobs" hint in the UI)."""
    return sum(1 for x in vals if isinstance(x, (int, float)) and not isinstance(x, bool) and DUR_MIN_S <= x <= DUR_MAX_S)


class Watcher(threading.Thread):
    daemon = True

    def __init__(self):
        super().__init__()
        self.agents = {}
        self.lock = threading.Lock()
        self.error = None
        self.live = {}                 # (session, agent) -> CERTAIN state that comes via mod/hook
        self.mods = {}                 # session -> time the mod was last seen
        self.mod_ver = {}              # session -> version the mod reported in its /outbox poll ("" = old plugin, does not report a version)
        self.chats = {}                # agent key -> chat
        self.outbox = deque()          # messages waiting to be delivered
        self.art = {}                  # agent key -> OrderedDict(id -> image)
        self.files = {}                # image id -> local file path
        self.dismissed = self._load_dismissed()   # agent id -> time it was hidden (remembered across restarts too)
        self.pins = self._load_pins()             # pinned chat (session id) -> time it was pinned: stays in the tower even if inactive
        self.pin_paths = {}                       # session id -> log file (resolved at discovery)
        self._dur_lock = threading.Lock()         # duration record (lock order: self.lock -> _dur_lock; file writing only under _dur_lock)
        self.durs = self._load_durs()             # type -> durations (s) of the last finished tasks: only numbers, no content
        self._eta_trk = {}                        # worker id -> {run, t0, ok, soft}: duration trace of workers SEEN while running (in memory; under self.lock)
        self._view_at = 0.0                       # time of the last _view: so that the loop observes by itself if nobody is polling
        self._recent = None                       # cache of the "+" list: (time, items)
        self._recent_meta = {}                    # log path -> (mtime, size, list info): an unchanged file is not read again
        self._recent_lock = threading.Lock()
        self.gal = self._load_gal()               # persistent gallery: "agent|image" -> record (stays even if the agent leaves the office / the chat closes)
        self._gal_dirty = False
        self._gal_at = 0.0
        self.token = self._load_token()           # does not change on restart: so that open pages do not go stale
        self.started = time.time()
        self.last_client = time.time()
        self.last_mod = 0.0
        self._discover_at = 0.0
        self._msg_seq = 0
        self.early_acks = {}           # acks that arrive before the say record: message id -> (ok, reason, time)
        self.polls = {}                # session -> (counter, time of last poll): is the mod's delivery loop running
        self.moddbg = deque(maxlen=12)  # development traces sent by the mod
        self.namer = Namer()           # character / name assignment (in memory, does not change)
        self.reply_marks = self._load_marks()   # agent id -> [last reply n, t] (so that n does not go backwards on restart)
        self._marks_dirty = False
        self._stop_seq = 0
        self.uploads = OrderedDict()   # attachment id -> {path, name, size, kind, sid, t} (found from disk on restart)
        self._up_lock = threading.Lock()   # so that pruning and saving do not walk the folder at the same time
        self._up_pruned = 0.0
        self._up_reserved = 0                  # bytes reserved by ongoing uploads (under _up_lock): so that concurrent uploads do not exceed the limit
        self.asks = OrderedDict()      # question id -> record of Claude's question (AskUserQuestion); in memory only
        self.ask_cv = threading.Condition(self.lock)   # the /ask/wait long polling waits for the answer / handover with this
        self.office_seen = 0.0         # last /asks poll from the office page (is the office open?)
        self.office_vis = 0.0          # ...last poll that came while the tab was VISIBLE (document.visibilityState === 'visible')
        self.office_focus = 0.0        # ...last poll that came while the page was focused (informational; the rule looks at visibility)

    @staticmethod
    def _load_token():
        """Persistent local key. Protects browser pages from requests coming from other sites (programs on the same computer
        can read it from /config anyway); keeping it in a file does not weaken this protection, and it does not break the page across restarts."""
        p = os.path.join(cache_dir(), "token")
        try:
            with open(p, "r", encoding="utf-8") as f:
                t = f.read().strip()
            if re.fullmatch(r"[0-9a-f]{32}", t):
                return t
        except OSError:
            pass
        t = secrets.token_hex(16)
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(t)
        except OSError:
            pass
        return t

    @staticmethod
    def _dismiss_path():
        return os.path.join(cache_dir(), "dismissed.json")

    def _load_dismissed(self):
        try:
            with open(self._dismiss_path(), "r", encoding="utf-8") as f:
                d = json.load(f)
            cut = time.time() - 3 * 86400
            return {k: v for k, v in d.items() if isinstance(v, (int, float)) and v > cut}
        except Exception:
            return {}

    def _save_dismissed(self):
        try:
            os.makedirs(os.path.dirname(self._dismiss_path()), exist_ok=True)
            with open(self._dismiss_path(), "w", encoding="utf-8") as f:
                json.dump(self.dismissed, f)
        except OSError:
            pass

    # ------------------------------------------------------------- pinned chats (those brought back with "+")
    @staticmethod
    def _pins_path():
        return os.path.join(cache_dir(), "pinned.json")

    def _load_pins(self):
        try:
            with open(self._pins_path(), "r", encoding="utf-8") as f:
                d = json.load(f)
            return {k: v for k, v in d.items() if isinstance(k, str) and RE_SESSION_ID.fullmatch(k) and isinstance(v, (int, float))}
        except Exception:
            return {}

    def _save_pins(self):
        try:
            os.makedirs(os.path.dirname(self._pins_path()), exist_ok=True)
            tmp = self._pins_path() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.pins, f)
            os.replace(tmp, self._pins_path())
        except OSError:
            pass

    @staticmethod
    def session_file(sid):
        """Main log file of a session id (ROOT/<project>/<id>.jsonl) or None. The id is accepted only in the RE_SESSION_ID format
        (it cannot carry a path part); symlinks and sub-agent logs do not count."""
        if not isinstance(sid, str) or not RE_SESSION_ID.fullmatch(sid):
            return None
        try:
            with os.scandir(ROOT) as it:
                for pe in it:
                    if not pe.is_dir(follow_symlinks=False):
                        continue
                    p = os.path.join(pe.path, sid + ".jsonl")
                    if os.path.isfile(p) and not os.path.islink(p):
                        return p
        except OSError:
            pass
        return None

    def pin(self, sid):
        """Adds the chat to the tower and pins it: its tab does not close even when the inactivity time runs out (only with ×). (reply, HTTP code)"""
        sid = str(sid or "")
        if not RE_SESSION_ID.fullmatch(sid):
            return {"ok": False, "reason": "Invalid chat ID"}, 400
        p = self.session_file(sid)
        if not p:
            return {"ok": False, "reason": "Chat not found"}, 404
        with self.lock:
            if sid not in self.pins and len(self.pins) >= PIN_MAX:
                return {"ok": False, "reason": "You can pin at most %d chats; close one with × first" % PIN_MAX}, 409
            self.pins[sid] = time.time()
            self.pin_paths[sid] = p
            if self.dismissed.pop(sid, None) is not None:      # let a manager that was removed from the office come back too
                self._save_dismissed()
            self._save_pins()
            self._discover_at = 0.0                             # so that it is discovered right away on the next round
        return {"ok": True}, 200

    def unpin(self, sid):
        """Removes the pin (× on the tab). The chat returns to the normal rule: if inactive it leaves the tower. (reply, HTTP code)"""
        sid = str(sid or "")
        if not RE_SESSION_ID.fullmatch(sid):
            return {"ok": False, "reason": "Invalid chat ID"}, 400
        with self.lock:
            had = self.pins.pop(sid, None) is not None
            self.pin_paths.pop(sid, None)
            if had:
                self._save_pins()
                self._discover_at = 0.0                         # so that the old chat is filtered out right away on the next round (so there is no 2 s flicker of "onay bekliyor" (waiting for approval))
        if not had and not self.session_file(sid):
            return {"ok": False, "reason": "Chat not found"}, 404
        return {"ok": True}, 200

    # ------------------------------------------------------------- task duration record (_cache/durations.json: {type: [s…]})
    @staticmethod
    def _durs_path():
        return os.path.join(cache_dir(), "durations.json")

    def _load_durs(self):
        try:
            with open(self._durs_path(), "r", encoding="utf-8") as f:
                d = json.load(f)
            out = {}
            for k, v in d.items():
                if isinstance(k, str) and RE_DUR_KEY.fullmatch(k) and isinstance(v, list) and len(out) < DUR_BUCKETS:
                    good = [round(float(x), 1) for x in v if isinstance(x, (int, float)) and not isinstance(x, bool) and DUR_MIN_S <= x <= DUR_MAX_S][-DUR_KEEP:]
                    if good:
                        out[k] = good
            return out
        except Exception:
            return {}

    def _save_durs(self):
        """Called under _dur_lock. Atomic write; an error is swallowed silently (the estimate is only a convenience)."""
        try:
            os.makedirs(os.path.dirname(self._durs_path()), exist_ok=True)
            tmp = self._durs_path() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.durs, f)
            os.replace(tmp, self._durs_path())
        except OSError:
            pass

    def _dur_add(self, recs):
        """recs: [(bucket, s)]. Durations outside the range (too short / too long) are dropped; the last DUR_KEEP per type are kept."""
        changed = False
        with self._dur_lock:
            for b, sec in recs:
                if not (DUR_MIN_S <= sec <= DUR_MAX_S):
                    continue
                if b not in self.durs and len(self.durs) >= DUR_BUCKETS:
                    continue
                self.durs.setdefault(b, []).append(round(sec, 1))
                del self.durs[b][:-DUR_KEEP]
                changed = True
            if changed:
                self._save_durs()
        return changed

    def _eta_for(self, bucket):
        with self._dur_lock:
            return dur_stats(self.durs.get(bucket, ()))

    def _eta_n_of(self, s):
        """Under self.lock. While there is no estimate yet (n < DUR_MIN_N) the number of finished jobs of that type; None if there is an estimate / finished / waiting for approval."""
        if s["state"] in ("done", "waiting") or s["id"].startswith("spawn-"):
            return None
        with self._dur_lock:
            n = dur_count(self.durs.get(dur_bucket(s["sub"], s.get("agent_type")), ()))
        return n if n < DUR_MIN_N else None

    def _eta_observe(self, out, items, by_id, now):
        """Under self.lock. Catches the "working -> done" transition of a worker SEEN while running; returns [(bucket, s)].
        Reliable measurement: if a sub-agent was seen at most DUR_NEAR_START s after its start; for the main agent only if the done -> working transition was seen
        (that turn start). If the server caught up later / the end was inferred from log silence, the duration is NOT COUNTED."""
        recs = []
        seen = set()
        for s, it in zip(out, items):
            if s["id"].startswith("spawn-"):
                continue
            sid = s["id"]
            seen.add(sid)
            rec = self._eta_trk.get(sid)
            ag = by_id.get(sid)
            if s["state"] != "done":
                if rec is None:
                    st0 = it.get("started") if s["sub"] else None
                    ok = bool(st0) and -5 <= now - st0 <= DUR_NEAR_START
                    self._eta_trk[sid] = {"run": True, "t0": st0 if ok else None, "ok": ok, "soft": None}
                elif not rec["run"]:
                    if rec["soft"] and now - rec["soft"] <= DUR_RESUME:
                        rec.update(run=True, soft=None)                                  # silence break: the same job continues
                    else:
                        t0 = s.get("since") or now
                        rec.update(run=True, t0=min(t0, now), ok=True, soft=None)       # the done -> working transition was seen in this process
            else:
                if rec is None:
                    self._eta_trk[sid] = {"run": False, "t0": None, "ok": False, "soft": None}
                elif rec["run"]:
                    genuine = bool(s.get("live")) or bool(ag and (ag.last == "done" or (s["sub"] and s.get("finished"))))
                    if genuine:
                        if rec["ok"] and rec["t0"]:
                            recs.append((dur_bucket(s["sub"], s.get("agent_type")), now - rec["t0"]))
                        rec.update(run=False, soft=None)
                    else:
                        rec.update(run=False, soft=now)                                  # "bitti" (done) only from silence: do not count the job, continue if it returns
        for k in [k for k in self._eta_trk if k not in seen]:
            del self._eta_trk[k]
        return recs

    def _eta_of(self, s):
        """Under self.lock. {est, hi, n, t0} for a worker list item, or None. Only while running (absent for finished / waiting for approval);
        start: the trace record for a sub-agent or "started", for the main agent only the turn start seen in this process."""
        if s["state"] in ("done", "waiting") or s["id"].startswith("spawn-"):
            return None
        st = self._eta_for(dur_bucket(s["sub"], s.get("agent_type")))
        if not st:
            return None
        rec = self._eta_trk.get(s["id"])
        t0 = rec["t0"] if rec and rec["t0"] else (s.get("started") if s["sub"] else None)
        if not t0:
            return None
        return dict(st, t0=round(t0, 1))

    def recent_sessions(self, offset=0, limit=RECENT_PAGE, q=""):
        """Read-only: Claude's recorded main chats (last activity descending), page by page: starting from offset at most limit items
        (limit is clipped to RECENT_LIMIT_MAX) and the total count matching the filter (total). q: search in the title / project label (every word
        separated by spaces must appear; no difference of upper/lower case or İ/ı/I/i). Only id, title, project label, last activity time and pin;
        message content / path is not exposed. The full list is cached for RECENT_TTL s; file info is not re-read as long as mtime/size do not change."""
        now = time.time()
        offset = max(0, int(offset))
        limit = max(1, min(RECENT_LIMIT_MAX, int(limit)))
        with self._recent_lock:
            if self._recent and now - self._recent[0] < RECENT_TTL:
                items = self._recent[1]
            else:
                items = self._scan_recent()
                self._recent = (now, items)
        words = fold_tr(str(q or "")[:RECENT_Q_MAX]).split()
        if words:
            items = [it for it in items if all(w in it["_k"] for w in words)]
        with self.lock:
            pins = set(self.pins)
        page = items[offset:offset + limit]
        return {"ok": True, "time": now, "total": len(items), "offset": offset, "limit": limit,
                "items": [{"id": it["id"], "title": it["title"], "project": it["project"], "last": it["last"], "pinned": it["id"] in pins} for it in page]}

    def _scan_recent(self):
        files = []
        try:
            with os.scandir(ROOT) as pit:
                for pe in pit:
                    if not pe.is_dir(follow_symlinks=False):
                        continue
                    try:
                        with os.scandir(pe.path) as it:
                            for e in it:
                                stem = e.name[:-6]
                                if e.name.endswith(".jsonl") and RE_SESSION_ID.fullmatch(stem) and e.is_file(follow_symlinks=False):
                                    st = e.stat(follow_symlinks=False)
                                    if st.st_size > 0:
                                        files.append((st.st_mtime, st.st_size, e.path, stem))
                    except OSError:
                        continue
        except OSError:
            return []
        files.sort(key=lambda x: -x[0])
        out, seen, keep = [], set(), {}
        for mtime, size, path, sid in files:                  # no limit: all records (unchanged ones from the cache, no reading)
            if sid in seen:                                   # same id in two project folders: the newest one
                continue
            c = self._recent_meta.get(path)
            if c and c[0] == mtime and c[1] == size:
                meta = c[2]
            else:
                meta = session_meta(path, size)
            if meta is None:
                continue
            keep[path] = (mtime, size, meta)
            if meta["side"]:                                  # sub-agent (sidechain) records are not listed
                continue
            seen.add(sid)
            out.append({"id": sid, "title": meta["title"], "project": meta["project"], "last": round(mtime, 1),
                        "_k": fold_tr(meta["title"] + " " + meta["project"])})      # _k: search key (not exposed)
        self._recent_meta = keep
        return out

    @staticmethod
    def _gal_path():
        return os.path.join(cache_dir(), "gallery.json")

    def _load_gal(self):
        """Persistent gallery record: images whose file still exists are served again (self.files)."""
        try:
            with open(self._gal_path(), "r", encoding="utf-8") as f:
                items = json.load(f)
        except Exception:
            return {}
        out = {}
        for e in items if isinstance(items, list) else []:
            try:
                if not (isinstance(e, dict) and e.get("k") and e.get("aid") and isinstance(e.get("agent"), dict)):
                    continue
                if e.get("path") and os.path.isfile(e["path"]):
                    self.files[e["aid"]] = e["path"]
                out[e["k"]] = e
            except Exception:
                continue
        return out

    def _gal_capture(self, s, title=""):
        """Writes this worker's images to the persistent gallery (under the lock, fast: memory only). File copy/record are in _gal_sync."""
        bucket = self.art.get(s["id"])
        if not bucket:
            return
        snap = {"id": s["id"], "session": s["session"], "nick": s.get("nick", ""), "char": s.get("char", "robot"), "role": s.get("role", ""),
                "kind_tr": s.get("kind_tr", ""), "label": short(s.get("label", ""), 60), "project": s.get("project", ""), "sub": bool(s.get("sub")),
                "stitle": short(title or s.get("label", ""), 80)}
        for a in list(bucket.values()):
            gk = s["id"] + "|" + a["id"]
            e = self.gal.get(gk)
            if e is None:
                self.gal[gk] = {"k": gk, "aid": a["id"], "kind": a.get("kind", "img"), "anim": bool(a.get("anim")), "src": a["src"],
                                "label": a.get("label", ""), "t": a["t"], "agent": snap}
                self._gal_dirty = True
                continue
            for fld, v in (("src", a["src"]), ("kind", a.get("kind", "img")), ("anim", bool(a.get("anim"))), ("label", a.get("label", ""))):
                if e.get(fld) != v:
                    e[fld] = v
                    self._gal_dirty = True
            if e["agent"] != snap:
                e["agent"] = snap
                self._gal_dirty = True

    def _gal_sync(self):
        """Copies local image files to _cache/gal (so they stay even if the original is deleted), prunes old ones, writes the record. I/O outside the lock."""
        cache = os.path.abspath(cache_dir())
        gdir = os.path.join(cache, "gal")
        with self.lock:
            todo = [(e["aid"], self.files.get(e["aid"])) for e in self.gal.values() if str(e.get("src", "")).startswith("/file/") and not e.get("path")]
        done = {}
        for aid, path in todo:
            if not path or not os.path.isfile(path):
                continue
            if os.path.abspath(path).startswith(cache + os.sep):           # remotely downloaded image is already in the cache
                done[aid] = os.path.abspath(path)
                continue
            try:
                os.makedirs(gdir, exist_ok=True)
                dst = os.path.join(gdir, aid + os.path.splitext(path)[1].lower())
                if not os.path.exists(dst):
                    shutil.copyfile(path, dst)
                done[aid] = dst
            except OSError:
                pass
        drop = []
        with self.lock:
            for e in self.gal.values():
                if not e.get("path") and e["aid"] in done:
                    e["path"] = done[e["aid"]]
                    self.files[e["aid"]] = e["path"]
                    self._gal_dirty = True
            if len(self.gal) > GAL_MAX:
                for e in sorted(self.gal.values(), key=lambda x: x["t"])[:len(self.gal) - GAL_MAX]:
                    self.gal.pop(e["k"], None)
                    drop.append(e)
                self._gal_dirty = True
            use = {e.get("path") for e in self.gal.values()}
            snapshot = json.dumps(list(self.gal.values()), ensure_ascii=False) if self._gal_dirty else None
            self._gal_dirty = False
        for e in drop:                                                     # the pruned image's file is deleted if no other record uses it
            p = e.get("path")
            if p and p not in use and os.path.abspath(p).startswith(cache + os.sep):
                try:
                    os.remove(p)
                except OSError:
                    pass
        if snapshot:
            try:
                os.makedirs(cache, exist_ok=True)
                tmp = self._gal_path() + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(snapshot)
                os.replace(tmp, self._gal_path())
            except OSError:
                pass

    def gallery(self):
        """Read-only: persistent gallery (newest first) + each image's worker and status (live: in the office · gone: removed from the office · away: not in the log)."""
        now = time.time()
        res, gone = self._view(now)
        live = {s["id"]: s for s in res}
        gids = {g["id"] for g in gone}
        out = []
        with self.lock:
            for e in sorted(self.gal.values(), key=lambda x: -x["t"]):
                if str(e["src"]).startswith("/file/"):
                    fp = self.files.get(e["aid"])
                    if not fp or not os.path.isfile(fp):
                        continue
                a = dict(e["agent"])
                sid = a.get("session", "")
                modok = (now - self.mods.get(sid, 0)) < 20
                if a["id"] in live:
                    st, s = "live", live[a["id"]]
                    a.update({"nick": s.get("nick") or a["nick"], "role": s.get("role", a["role"]), "state": s.get("state", "")})
                    can = bool(s.get("can_message"))
                else:
                    st = "gone" if a["id"] in gids else "away"
                    can = modok and self.find_target(a["id"]) is not None
                can_main = modok and a["id"] != sid and self.find_target(sid) is not None
                out.append({"k": e["k"], "id": e["aid"], "kind": e["kind"], "anim": bool(e.get("anim")), "src": e["src"], "label": e["label"], "t": e["t"],
                            "status": st, "can": can, "can_main": can_main, "agent": a})
        return {"ok": True, "time": now, "n": len(out), "items": out}

    @staticmethod
    def _marks_path():
        return os.path.join(cache_dir(), "replies.json")

    def _load_marks(self):
        try:
            with open(self._marks_path(), "r", encoding="utf-8") as f:
                d = json.load(f)
            cut = time.time() - 3 * 86400
            return {k: v for k, v in d.items() if isinstance(v, list) and len(v) == 2 and isinstance(v[1], (int, float)) and v[1] > cut}
        except Exception:
            return {}

    def _save_marks(self):
        try:
            os.makedirs(os.path.dirname(self._marks_path()), exist_ok=True)
            with open(self._marks_path(), "w", encoding="utf-8") as f:
                json.dump(self.reply_marks, f)
        except OSError:
            pass

    # ------------------------------------------------------------- loop
    def run(self):
        while True:
            try:
                self.tick()
            except Exception as e:  # the server must never crash
                self.error = repr(e)
            try:
                if time.time() - self._view_at > 2.5:         # observe worker transitions (duration records) even if the office page is not polling
                    self._view(time.time(), bg=True)
            except Exception:
                pass
            try:
                if time.time() - self._gal_at > 4:
                    self._gal_at = time.time()
                    self._gal_sync()
            except Exception:
                pass
            time.sleep(TICK)

    def tick(self):
        now = time.time()
        with self.lock:
            if now - self._discover_at >= DISCOVER_EVERY:
                self._discover_at = now
                self.discover(now)
            for ag in list(self.agents.values()):
                try:                                # one worker's read error must not stop the others
                    ag.read_new()
                    ag.read_meta()
                    if ag.sub:
                        ag.commit_pending(now)
                    mk = ag.reply_mark()
                    if mk and self.reply_marks.get(ag.id) != mk:
                        self.reply_marks[ag.id] = mk
                        self._marks_dirty = True
                    if ag.new_art:
                        key = ag.id
                        for src, label, ts in ag.new_art:
                            self.register_art(key, src, label, ts)
                        ag.new_art = []
                except Exception as e:
                    if DEBUG:
                        print("tick skipped:", ag.id, repr(e))
            if self._marks_dirty:
                self._marks_dirty = False
                self._save_marks()
        if EXIT_ON_IDLE and now - max(self.last_client, self.last_mod, self.started) > IDLE_EXIT_SECONDS:
            with self.lock:
                busy = any(a.last_ts and now - a.last_ts < 180 for a in self.agents.values())
            if not busy:
                _remove_pidfile()
                os._exit(0)

    def discover(self, now):
        """Cheap discovery: looks inside the project folders, takes only recently changed files."""
        found = {}
        try:
            with os.scandir(ROOT) as pit:
                for pe in pit:
                    if not pe.is_dir(follow_symlinks=False):
                        continue
                    try:
                        with os.scandir(pe.path) as it:
                            for e in it:
                                if e.is_file(follow_symlinks=False) and e.name.endswith(".jsonl"):
                                    if now - e.stat().st_mtime <= ACTIVE_SECONDS:
                                        found[e.path] = None
                    except OSError:
                        continue
        except OSError:
            return
        # pinned chats (added with "+"): watched even when inactive
        for sid in list(self.pins):
            p = self.pin_paths.get(sid)
            if not p or not os.path.isfile(p):
                p = self.session_file(sid)                 # folders are polled only if the path is unknown / the file was moved
                if p:
                    self.pin_paths[sid] = p
            if p:
                found[p] = None
        # sub-agents of active main sessions (they stay for a while even when finished)
        for mp in list(found):
            sdir = os.path.join(mp[:-6], "subagents")
            if not os.path.isdir(sdir):
                continue
            try:
                with os.scandir(sdir) as it:
                    for e in it:
                        if e.name.startswith("agent-") and e.name.endswith(".jsonl") and e.is_file(follow_symlinks=False):
                            if now - e.stat().st_mtime <= SUB_KEEP_SECONDS:
                                found[e.path] = None
            except OSError:
                continue
        for p in found:
            if p not in self.agents:
                ag = Agent(p)
                ag.saved = self.reply_marks.get(ag.id)
                self.agents[p] = ag
        for p in list(self.agents):
            if p not in found:
                del self.agents[p]

    # ------------------------------------------------------------- images
    def _fetch_art(self, aid, url, entry):
        """Downloads a remote image into the local cache (public addresses, at most 12 MB, checks redirects one by one).
        On success the image is served from the same origin via /file/<id> (canvas is not tainted, visible offline too)."""
        try:
            data, ctype = fetch_public_image(url)
        except Exception:
            return
        ext = os.path.splitext(urlparse(url).path)[1].lower()
        if ext not in MEDIA_EXT:
            ext = mimetypes.guess_extension(ctype or "") or ".png"
            if ext == ".jpe":
                ext = ".jpg"
        if ext in VID_EXT:
            entry["kind"] = "vid"
        if ext in ANIM_EXT or ext in VID_EXT:
            entry["anim"] = True
        cache = cache_dir()
        try:
            os.makedirs(cache, exist_ok=True)
            path = os.path.join(cache, aid + ext)
            with open(path, "wb") as f:
                f.write(data)
        except OSError:
            return
        with self.lock:
            self.files[aid] = path
            entry["src"] = "/file/" + aid + ext
            entry["cached"] = True

    def register_art(self, key, src, label, ts):
        src = scrub(str(src or "")).strip()
        if not src:
            return
        label = scrub(str(label or "")).strip()
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+", label):
            label = ""                                      # raw tool name (create_character) is not shown to the user; the file name is enough
        if src.lower().startswith("http"):
            plain = src.split("?")[0]                      # suffixes like ?t=timestamp must not duplicate the same image
            host = (urlparse(plain).hostname or "").lower()
            if host in ("localhost", "127.0.0.1", "::1", "example.com", "example.org", "example.net") or host.endswith((".localhost", ".local", ".test", ".invalid", ".example.com", ".example.org", ".example.net")):
                return                                      # local / example addresses do not enter the gallery (example links in the text)
            aid = hashlib.sha1(plain.encode("utf-8")).hexdigest()[:12]
            nm = base(plain)
            pext = os.path.splitext(plain)[1].lower()
            entry = {"id": aid, "kind": "vid" if pext in VID_EXT else "img", "src": src, "label": short(("%s · %s" % (label, nm)) if label else nm, 40), "t": ts}
            if pext in ANIM_EXT or pext in VID_EXT:
                entry["anim"] = True
            bucket = self.art.setdefault(key, OrderedDict())
            if aid in bucket:
                return
            bucket[aid] = entry
            while len(bucket) > MAX_ART:
                bucket.popitem(last=False)
            threading.Thread(target=self._fetch_art, args=(aid, src, entry), daemon=True).start()
            return
        else:
            path = src.replace("/", os.sep)
            if not path.lower().endswith(MEDIA_EXT) or not os.path.isfile(path):
                return
            if os.path.basename(path).lower().startswith(("mcp-claude_browser-", "mcp-claude-in-chrome-", "mcp-computer-use-")):
                return                                      # browser / computer-control screenshots are not designs, they do not enter the gallery
            ext = os.path.splitext(path)[1].lower()
            try:
                if os.path.getsize(path) > (MAX_VID_BYTES if ext in VID_EXT else MAX_IMG_BYTES):
                    return
            except OSError:
                return
            aid = hashlib.sha1(path.lower().encode("utf-8")).hexdigest()[:12]
            self.files[aid] = path
            entry = {"id": aid, "kind": "vid" if ext in VID_EXT else "img", "src": "/file/" + aid + ext, "label": short(label or os.path.basename(path), 40), "t": ts}
            if ext in ANIM_EXT or ext in VID_EXT:
                entry["anim"] = True
        bucket = self.art.setdefault(key, OrderedDict())
        if aid in bucket:
            return
        bucket[aid] = entry
        while len(bucket) > MAX_ART:
            bucket.popitem(last=False)

    # ------------------------------------------------------------- plugin events
    def mod_event(self, p):
        p = scrub_obj(p)
        sid = p.get("sid") or ""
        aid = p.get("aid") or ""
        kind = p.get("kind")
        now = time.time()
        self.last_mod = now
        if DEBUG:
            try:
                os.makedirs(os.path.join(HERE, "_work"), exist_ok=True)
                with open(os.path.join(HERE, "_work", "mod_events.log"), "a", encoding="utf-8") as f:
                    f.write(json.dumps({k: p.get(k) for k in ("kind", "aid", "atype", "state", "tool", "target", "text")}, ensure_ascii=False) + "\n")
            except Exception:
                pass
        with self.lock:
            if sid:
                self.mods[sid] = now
            if kind == "end":
                for k in [k for k in self.live if k[0] == sid]:
                    del self.live[k]
                return
            key = ("agent-" + aid) if aid else sid
            if kind == "dbg":
                self.moddbg.append([round(now), sid[:8], str(p.get("text") or "")[:160]])
                return
            if kind == "artifact":
                # the plugin sends the path as 'path' (src:'mod' in the envelope must not override it); src is also accepted for the old format
                self.register_art(key, p.get("path") or ("" if p.get("src") == "mod" else p.get("src")) or "", p.get("label") or "", now)
                return
            if kind == "reply":
                self.add_chat(key, "ajan", p.get("text") or "", "yanit")
                return
            if kind == "say":                              # message typed in the box of the Claude side panel (the plugin itself delivers it)
                mid = str(p.get("id") or "")[:40] or None
                item = self.add_chat(key, "ben", p.get("text") or "", "bekliyor", mid=mid)
                early = self.early_acks.pop(mid, None) if mid else None
                if item and early:
                    item["st"] = "iletildi" if early[0] else "hata"
                    if early[1]:
                        if early[0]:
                            item["via"] = early[1][:80]
                        else:
                            item["text"] = item["text"] + "\n(!) " + early[1][:200]
                return
            lk = (sid, aid)
            rec = self.live.get(lk) or {"since": now, "state": "thinking", "detail": "", "target": "", "tool": "", "task": "", "atype": None, "tools": Counter()}
            if kind == "state":
                new = p.get("state") or rec["state"]
                if new != rec["state"]:
                    rec["since"] = now
                rec.update(state=new, detail=norm_detail(p.get("detail", "")), target=p.get("target", ""), tool=p.get("tool", ""))
                if p.get("tool"):
                    rec["tools"][p["tool"]] += 1
                if p.get("task"):
                    rec["task"] = p["task"]
            elif kind == "sub_start":
                rec.update(state="thinking", detail="Started working", since=now, desc=p.get("desc") or "")
            elif kind == "sub_stop":
                rec.update(state="done", detail="Finished", since=now)
            if p.get("atype"):
                rec["atype"] = p["atype"]
            rec["updated"] = now
            self.live[lk] = rec

    def hook(self, payload):
        if payload.get("src") == "mod":
            return self.mod_event(payload)
        sid = payload.get("session_id")
        ev = payload.get("hook_event_name") or payload.get("event")
        now = time.time()
        with self.lock:
            for ag in self.agents.values():
                if ag.session == sid and not ag.sub:
                    if ev in ("Notification", "PermissionRequest"):
                        ag.hook_waiting = now
                    elif ev in ("PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop"):
                        ag.hook_waiting = None

    # ------------------------------------------------------------- chat
    def add_chat(self, key, who, text, st, mid=None, atts=None):
        text = scrub(str(text)).strip()
        if not text and not atts:
            return None
        self._msg_seq += 1
        item = {"id": mid or ("m%d" % self._msg_seq), "t": time.time(), "who": who, "text": text[:4000], "st": st}
        if who == "ben":                              # attachments are in a separate field: the client does not parse the chips in the bubble out of the text
            item["atts"] = list(atts or [])
        self.chats.setdefault(key, deque(maxlen=80)).append(item)
        return item

    def find_target(self, key):
        """Resolve the message target: (kind, session, agent id) or None."""
        for ag in self.agents.values():
            if ag.id == key:
                if ag.sub:
                    return ("sub", ag.session, ag.id[6:] if ag.id.startswith("agent-") else ag.id)
                return ("main", ag.session, "")
        for (sid, aid) in self.live:
            if aid and ("agent-" + aid) == key:
                return ("sub", sid, aid)
        for e in self.gal.values():                       # persistent gallery: old worker / one removed from the office
            a = e.get("agent") or {}
            if a.get("id") == key and a.get("session"):
                if a.get("sub"):
                    return ("sub", a["session"], key[6:] if key.startswith("agent-") else key)
                return ("main", a["session"], "")
        return None

    # ------------------------------------------------------------- attachments
    def _prune_uploads(self, need=0):
        """Deletes old attachments (UP_KEEP_SECONDS) and unfinished .part files; if total + bytes reserved by ongoing uploads +
        need exceeds UP_DIR_MAX, starts from the oldest. Called under _up_lock. Only our own files in the upload root;
        links (symlinks) are not followed. The .part of ongoing uploads and newly created folders are not deleted. Full scan at most every 10 minutes."""
        root = upload_root()
        now = time.time()
        if need <= 0 and now - self._up_pruned < 600:
            return
        self._up_pruned = now
        files = []
        try:
            for sd in os.scandir(root):
                if not sd.is_dir(follow_symlinks=False):
                    continue
                for fe in os.scandir(sd.path):
                    if not fe.is_file(follow_symlinks=False):
                        continue
                    st = fe.stat(follow_symlinks=False)
                    part = fe.name.endswith(".part")
                    old = now - st.st_mtime > (3600 if part else UP_KEEP_SECONDS)
                    if old:
                        try:
                            os.remove(fe.path)
                        except OSError:
                            pass
                    elif not part:                                   # the .part of an ongoing upload: its size is in _up_reserved, not deleted
                        files.append((st.st_mtime, st.st_size, fe.path))
                try:
                    if now - sd.stat(follow_symlinks=False).st_mtime > 60:
                        os.rmdir(sd.path)                            # if it became empty (if not empty, OSError: left alone); do not touch a newly created one
                except OSError:
                    pass
        except OSError:
            return
        total = sum(f[1] for f in files)
        for _, size, path in sorted(files):
            if total + self._up_reserved + need <= UP_DIR_MAX:
                break
            try:
                os.remove(path)
                total -= size
            except OSError:
                pass

    def save_upload(self, key, stem, ext, kind, n, stream):
        """Saves the body (exactly n bytes) as yuklemeler/<session>/<id>_<name>. Returns (reply, HTTP code).
        Written to .part first, moved to the final name if it passes the content check: a partial / fake file never stays under a valid name."""
        with self.lock:
            tgt = self.find_target(key) if key else None
        if not tgt:
            return {"ok": False, "reason": "Worker not found"}, 404
        sid = up_sid(tgt[1])
        root = os.path.realpath(upload_root())
        d = os.path.join(root, sid)
        uid = secrets.token_hex(6)
        final = os.path.join(d, uid + "_" + stem + ext)
        part = os.path.join(d, uid + ".part")
        if not os.path.realpath(final).startswith(root + os.sep) or os.path.dirname(os.path.realpath(final)) != os.path.realpath(d):
            return {"ok": False, "reason": "Invalid file name"}, 400          # defense: even after name sanitizing, it cannot escape the root
        # pruning, reserving space, opening the folder and .part all under a single lock: pruning cannot delete the empty folder in between,
        # concurrent uploads see each other's reserved bytes (total does not exceed UP_DIR_MAX)
        with self._up_lock:
            self._prune_uploads(n)
            try:
                os.makedirs(d, exist_ok=True)
                f = open(part, "xb")
            except OSError:
                return {"ok": False, "reason": "Could not save the file"}, 500
            self._up_reserved += n
        head, got = b"", 0
        try:
            with f:
                while got < n:
                    chunk = stream.read(min(65536, n - got))
                    if not chunk:
                        break
                    if len(head) < 65536:
                        head += chunk[: 65536 - len(head)]
                    f.write(chunk)
                    got += len(chunk)
            if got != n:
                raise ValueError("The upload was interrupted; try again")
            if not upload_sniff_ok(kind, ext, head):
                raise ValueError("The file contents do not match its extension (%s)" % ext)
            os.replace(part, final)
        except (ValueError, OSError) as e:
            try:
                os.remove(part)
            except OSError:
                pass
            if isinstance(e, ValueError):
                return {"ok": False, "reason": str(e)}, 400
            if isinstance(e, (TimeoutError, ConnectionError)):
                return {"ok": False, "reason": "The upload was interrupted; try again"}, 400
            return {"ok": False, "reason": "Could not save the file"}, 500
        finally:
            with self._up_lock:
                self._up_reserved -= n
        path = os.path.abspath(final)
        rec = {"id": uid, "path": path, "name": stem + ext, "size": n, "kind": kind, "sid": sid, "t": time.time()}
        with self.lock:
            self.uploads[uid] = rec
            while len(self.uploads) > 500:
                self.uploads.popitem(last=False)
        return {"ok": True, "id": uid, "name": rec["name"], "path": path, "size": n, "kind": kind,
                "line": attach_line(path, kind, n)}, 200

    def upload_get(self, uid):
        """Attachment record (if the file still exists). If not in memory (server restarted), looks for "<kimlik>_*" (<id>_*) in the upload root."""
        uid = str(uid or "")
        if not RE_UP_ID.fullmatch(uid):
            return None
        with self.lock:
            rec = self.uploads.get(uid)
        if rec and os.path.isfile(rec["path"]):
            return rec
        root = os.path.realpath(upload_root())
        try:
            for sd in os.scandir(root):
                if not sd.is_dir(follow_symlinks=False):
                    continue
                for fe in os.scandir(sd.path):
                    if not (fe.name.startswith(uid + "_") and fe.is_file(follow_symlinks=False)):
                        continue
                    ext = os.path.splitext(fe.name)[1].lower()
                    if ext not in UP_EXT:
                        continue
                    rec = {"id": uid, "path": os.path.abspath(fe.path), "name": fe.name[len(uid) + 1:], "size": fe.stat().st_size,
                           "kind": UP_EXT[ext], "sid": sd.name, "t": fe.stat().st_mtime}
                    with self.lock:
                        self.uploads[uid] = rec
                    return rec
        except OSError:
            pass
        return None

    def send(self, key, text, files=None):
        text = str(text or "").strip()
        if files is not None and not isinstance(files, list):
            return {"ok": False, "reason": "Invalid attachment list"}
        ids = list(dict.fromkeys(str(x) for x in (files or [])))     # drop duplicates, keeping the order
        if len(ids) > UP_MAX_FILES:
            return {"ok": False, "reason": "You can attach at most %d files" % UP_MAX_FILES}
        if not text and not ids:
            return {"ok": False, "reason": "Empty message"}
        if len(text) > 2000:
            return {"ok": False, "reason": "Message is too long (max 2000 characters)"}
        text = neutral_text(text)                                   # a "[Ek: ..." line typed by the user must not be mistaken for an attachment
        recs, lines = [], []
        for uid in ids:                                             # the SERVER writes the attachment lines, not the client: the path comes only from our own record
            rec = self.upload_get(uid)
            if not rec:                                             # missing: so the client knows which chip is broken
                return {"ok": False, "reason": "Attachment not found (it may have been deleted); attach the file again", "missing": uid[:40]}
            recs.append(rec)
            lines.append(attach_line(rec["path"], rec["kind"], rec["size"]))
        full = text
        if lines:
            full = text + ("\n\n" if text else "") + "\n".join(lines)
            if len(full) > 4000:                                    # the chat record (add_chat) truncates at 4000: the attachment line must not be cut in half
                return {"ok": False, "reason": "The message and attachments together are too long; shorten the text or attach fewer files"}
        with self.lock:
            tgt = self.find_target(key)
            if not tgt:
                return {"ok": False, "reason": "Worker not found"}
            kind, sid, aid = tgt
            for rec in recs:                                        # the attachment must be in this session's folder: a file uploaded to another chat is not sent
                if rec["sid"] != up_sid(sid):
                    return {"ok": False, "reason": "This attachment belongs to another chat; attach the file to this worker again", "missing": rec["id"]}
            if time.time() - self.mods.get(sid, 0) > 20:
                return {"ok": False, "reason": "The NorthLight Tower plugin is not connected to this Claude chat; you can't send messages."}
            atts = [{"id": r["id"], "name": r["name"], "kind": r["kind"], "size": r["size"], "path": r["path"]} for r in recs]
            item = self.add_chat(key, "ben", text, "bekliyor", atts=atts)
            # files: the real number of attachments (the plugin adds the description sentence based on this, not by looking at the text)
            self.outbox.append({"id": item["id"], "key": key, "kind": kind, "sid": sid, "aid": aid, "text": full, "files": len(recs)})
            return {"ok": True, "id": item["id"]}

    def take_outbox(self, sid, mv=None):
        now = time.time()
        with self.lock:
            self.mods[sid] = now
            if mv is not None:
                self.mod_ver[sid] = mv
            self.last_mod = now
            n = self.polls.get(sid, (0, 0))[0]
            self.polls[sid] = (n + 1, now)
            mine = [m for m in self.outbox if m["sid"] == sid]
            for m in mine:
                self.outbox.remove(m)
            return mine

    def ack(self, mid, ok, reason):
        reason = scrub(str(reason)) if reason is not None else reason
        if not ok and reason:
            reason = tr_reason(reason)
        with self.lock:
            for dq in self.chats.values():
                for it in dq:
                    if it["id"] == mid:
                        it["st"] = "iletildi" if ok else "hata"
                        if ok and reason:
                            it["via"] = str(reason)[:80]
                        if not ok and reason:
                            it["text"] = it["text"] + "\n(!) " + str(reason)[:200]
                        return True
        with self.lock:
            if mid and str(mid).startswith("p"):           # panel message: the say record may not have arrived yet, hold the ack
                now = time.time()
                self.early_acks = {k: v for k, v in self.early_acks.items() if now - v[2] < 60}
                self.early_acks[str(mid)] = (bool(ok), str(reason or ""), now)
        return False

    def dismiss(self, key):
        """Removes the worker from the office; only known ids (visible or already removed) are saved."""
        res, gone = self._view(time.time())
        if not any(s["id"] == key for s in res) and not any(g["id"] == key for g in gone):
            return False
        with self.lock:
            self.dismissed[key] = time.time()
            self._save_dismissed()
        return True

    def restore(self, key):
        """Brings back a worker removed from the office (idempotent: also succeeds if it is already in the office)."""
        with self.lock:
            known = key in self.dismissed or any(a.id == key for a in self.agents.values())
            if not known:
                return {"ok": False, "reason": "Worker not found"}
            if self.dismissed.pop(key, None) is not None:
                self._save_dismissed()
            return {"ok": True}

    def stop(self, key):
        """Request to stop the worker's current job: puts a 'stop' item in the plugin's delivery queue (status is updated with the ack)."""
        res, gone = self._view(time.time())              # outside the lock (the status summary takes the lock itself)
        snap = next((s for s in res if s["id"] == key), None)
        was_gone = any(g["id"] == key for g in gone)
        with self.lock:
            tgt = self.find_target(key)
            if not tgt:
                if str(key).startswith("spawn-"):
                    return {"ok": False, "reason": "The worker isn't ready yet; try again in a moment"}
                return {"ok": False, "reason": "Worker not found"}
            kind, sid, aid = tgt
            if kind == "sub" and (was_gone or snap is None or snap["state"] == "done"):
                return {"ok": False, "reason": "The worker has already stopped"}      # sending STOP to a finished worker would wake it again and burn tokens
            if time.time() - self.mods.get(sid, 0) > 20:
                return {"ok": False, "reason": "The NorthLight Tower plugin is not connected to this Claude chat; cannot stop."}
            if self.mod_ver.get(sid) == "":
                # an old plugin does not recognize the 'stop' item, sends Claude an empty prompt (uses up a turn) and nothing stops
                return {"ok": False, "reason": "The NorthLight Tower plugin in this chat is an old version. Stop will work after you reopen Claude."}
            self._stop_seq += 1
            mid = "x%d" % self._stop_seq
            self.add_chat(key, "ofis", "Stop request sent.", "bekliyor", mid=mid)
            self.outbox.append({"id": mid, "key": key, "kind": "stop", "sid": sid, "aid": aid, "text": ""})
            return {"ok": True, "id": mid}

    def names(self, sid):
        """For the plugin's side panel: names of the workers (main + sub) in the session. aid='' for the main agent."""
        res, _ = self._view(time.time())
        items = []
        for s in res:
            if s["session"] != sid or s["id"].startswith("spawn-"):      # a message / stop cannot be sent to a placeholder
                continue
            items.append({"id": s["id"], "aid": s["id"][6:] if (s["sub"] and s["id"].startswith("agent-")) else "",
                          "nick": s["nick"], "char": s["char"], "kind_tr": s["kind_tr"], "role": s["role"],
                          "sub": s["sub"], "state": s["state"], "label": s["label"]})
        items.sort(key=lambda x: x["sub"])               # main agent first (the sort is stable)
        return {"agents": items}

    def reply_get(self, key, n=None):
        """An agent's final reply (the last one if n is not given). None for 404."""
        res, gone = self._view(time.time())
        info = next((s for s in res + gone if s["id"] == key), None)
        with self.lock:
            ag = next((a for a in self.agents.values() if a.id == key), None)
            e = ag.reply_get(n) if ag else None
            if not e or not info:
                return None
            task = e.get("task") or ""
            if ag.sub or ag.sidechain:                          # a sub-agent has no user prompt: the description of the Agent call
                task = info.get("role") or task
            return {"ok": True, "id": key, "n": ag.reply_n(e), "t": e["t"], "text": e["text"], "task": task,
                    "nick": info.get("nick", ""), "label": info.get("label", ""), "project": info.get("project", "")}

    # ------------------------------------------------------------- Claude's questions (AskUserQuestion)
    # Flow: plugin POST /ask (gets a question id) -> office GET /asks (shows the card) -> office POST /answer (answer or "Claude'da cevapla", answer in Claude)
    # -> plugin GET /ask/wait (long polling) gets the answer -> plugin POST /ask/ack (did it really use the answer: "delivered").
    # If the office is not open / visible, the time runs out, or the plugin goes away, the question stays in the Claude window.
    def _ask_close(self, r, status, reason, now):
        r.update(status=status, reason=reason, done_at=now)
        self.ask_cv.notify_all()

    def _ask_prune(self, now):
        """Called while holding the lock: closes orphaned / expired questions, deletes old closed records."""
        for qid, r in list(self.asks.items()):
            if r["status"] == "pending":
                if now - r["last_wait"] > ASK_ORPHAN or now - r["t"] > ASK_TTL:
                    self._ask_close(r, "expired", "Time expired", now)
            elif now - r["done_at"] > ASK_DONE_KEEP:
                del self.asks[qid]

    def _ask_find(self, qid, sid, tuid=""):
        """Question record: by its id or (if the id is unknown) by session + tool call id; None if the session does not match."""
        r = self.asks.get(qid) if qid else None
        if r is None and tuid:
            r = next((x for x in reversed(self.asks.values()) if x["sid"] == sid and x["tuid"] == tuid), None)
        return r if r is not None and r["sid"] == sid else None

    def ask_create(self, p):
        """The plugin leaves a question: {sid, aid, tuid, questions}. Reply {ok, id} or {ok:false, reason} (the plugin then leaves it to Claude).
        Accepted even when the office is in the background or closed: the question waits, the card arrives when the office opens (the plugin hands the question over to Claude after 10 min)."""
        sid = str(p.get("sid") or "")[:200]
        aid = str(p.get("aid") or "")
        tuid = str(p.get("tuid") or "")[:200]
        if not sid:
            return {"ok": False, "reason": "No session ID"}
        if aid and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", aid):
            return {"ok": False, "reason": "Invalid worker"}
        try:
            qs = norm_questions(p.get("questions"))
        except ValueError as e:
            return {"ok": False, "reason": "Unsupported question format: %s" % e}
        now = time.time()
        with self.ask_cv:
            self.last_mod = now
            self._ask_prune(now)
            if now - self.mods.get(sid, 0) > 20:
                return {"ok": False, "reason": "This Claude chat is not connected to the tower"}
            for r in self.asks.values():                   # the same tool call came again (plugin reloaded): the same card
                if r["status"] == "pending" and r["sid"] == sid and tuid and r["tuid"] == tuid:
                    r["last_wait"] = now
                    return {"ok": True, "id": r["id"]}
            # if another question of the same worker (main agent: aid '') is pending, IT STAYS TOO: each tool call is a separate card, the office shows them in order
            if sum(1 for r in self.asks.values() if r["status"] == "pending") >= ASK_PENDING_MAX:
                return {"ok": False, "reason": "Too many pending questions"}
            qid = "q" + secrets.token_hex(8)
            self.asks[qid] = {"id": qid, "sid": sid, "aid": aid, "tuid": tuid, "t": now, "last_wait": now, "questions": qs,
                              "status": "pending", "reason": "", "answers": None, "done_at": 0.0, "delivered": False, "lost": False,
                              "nonce": ""}
            self.ask_cv.notify_all()
            return {"ok": True, "id": qid}

    def ask_wait(self, qid, sid, hold=ASK_HOLD):
        """The plugin's long polling: waits until an answer arrives, the question is handed over / closed, or 'hold' seconds run out.
        {status: 'answered', id, answers:[text...]} | 'pending' | 'handoff' | 'cancelled' | 'expired' | 'gone' (+ reason).
        Giving the answer does NOT MEAN "teslim edildi" (delivered): delivered is marked only by the plugin's /ask/ack."""
        end = time.time() + max(0.0, min(float(hold), ASK_HOLD))
        with self.ask_cv:
            while True:
                now = time.time()
                self.last_mod = now
                self._ask_prune(now)
                r = self.asks.get(qid)
                if not r or r["sid"] != sid:
                    return {"status": "gone"}
                if r["status"] == "pending":
                    r["last_wait"] = now
                    if now >= end:
                        return {"status": "pending"}
                    self.ask_cv.wait(min(end - now, 1.0))                  # wakes up every second: so the office freshness is checked too
                    continue
                if r["status"] == "answered":
                    return {"status": "answered", "id": qid, "answers": list(r["answers"])}
                return {"status": r["status"], "reason": r["reason"]}

    def ask_ack(self, qid, sid, ok, reason="", tuid=""):
        """Did the plugin receive the answer: ok=True -> answer was given to Claude (delivered); ok=False -> not used (the office warns the user)."""
        with self.ask_cv:
            r = self._ask_find(qid, sid, tuid)
            if not r or r["status"] != "answered":
                return {"ok": False}
            r["delivered"] = bool(ok)
            r["lost"] = not ok
            if not ok:
                r["reason"] = short(str(reason or "") or "Claude did not use the answer", 120)
            self.ask_cv.notify_all()
            return {"ok": True}

    def ask_cancel(self, qid, sid, tuid="", reason=""):
        """The plugin withdraws the question (answered in Claude, turn cut off, time ran out): the card disappears from the office. If the id is not known yet
        (Esc before the POST /ask reply arrives) it is found by session + tool call id. If answered but the plugin did not use it, it is marked "ulaşmadı" (did not arrive)."""
        now = time.time()
        with self.ask_cv:
            r = self._ask_find(qid, sid, tuid)
            if not r:
                return {"ok": False}
            why = short(str(reason or ""), 120)
            if r["status"] == "pending":
                self._ask_close(r, "cancelled", why or "Moved to the Claude window", now)
            elif r["status"] == "answered" and not r["delivered"]:
                r["lost"] = True
                r["reason"] = why or "Claude stopped listening"
                self.ask_cv.notify_all()
            return {"ok": True}

    def ask_list(self, vis=True, focus=False):
        """The office page's polling: pending question cards and the most recently closed ones. Also reports that the office is open (and visible / focused)."""
        now = time.time()
        with self.ask_cv:
            self.office_seen = now
            if vis:
                self.office_vis = now
            if focus:
                self.office_focus = now
            self.last_client = now
            self._ask_prune(now)
            pend = [dict(r) for r in self.asks.values() if r["status"] == "pending"]
            recent = [{"id": r["id"], "status": r["status"], "reason": r["reason"], "delivered": r["delivered"], "lost": r["lost"]}
                      for r in self.asks.values() if r["status"] != "pending"]
        who = {}
        if pend:                                            # name / face / chat title: only while there is a pending question (to keep it cheap)
            res, gone = self._view(now)
            for s in res + gone:
                who[s["id"]] = s
        items = []
        for r in pend:
            main = next((s for s in who.values() if not s.get("sub") and s.get("session") == r["sid"]), None)
            ag = who.get("agent-" + r["aid"]) if r["aid"] else main
            items.append({"id": r["id"], "sid": r["sid"], "aid": r["aid"], "t": r["t"], "expires": r["t"] + ASK_TTL,
                          "nick": (ag or {}).get("nick") or "", "char": (ag or {}).get("char") or "",
                          "kind_tr": (ag or {}).get("kind_tr") or "", "role": (ag or {}).get("role") or "", "sub": bool(r["aid"]),
                          "chat": (main or {}).get("label") or "", "project": (main or {}).get("project") or "", "questions": r["questions"]})
        return {"now": now, "items": items, "recent": recent}

    def ask_answer(self, qid, raw, handoff=False, nonce=""):
        """Answer from the office ({id, answers}) or handoff ({id, handoff:true}). Accepted only for a pending question, once.
        nonce: the card's own attempt id. A retry of the request whose reply timed out (same nonce, same action)
        gets success instead of "already answered"."""
        now = time.time()
        nonce = nonce if isinstance(nonce, str) and re.fullmatch(r"[0-9A-Za-z_-]{8,64}", nonce) else ""
        with self.ask_cv:
            self._ask_prune(now)
            r = self.asks.get(qid) if isinstance(qid, str) else None
            if not r:
                return {"ok": False, "reason": "This question is no longer valid (it may have moved to the Claude window)"}
            if r["status"] != "pending":
                if nonce and r["nonce"] == nonce and r["status"] == ("handoff" if handoff else "answered"):
                    return {"ok": True, "again": True}
                return {"ok": False, "reason": {"answered": "This question has already been answered", "handoff": "This question was handed over to the Claude window"}.get(
                    r["status"], "This question is no longer valid (it may have moved to the Claude window)")}
            if handoff:
                r["nonce"] = nonce
                self._ask_close(r, "handoff", "Will be answered in the Claude window", now)
                return {"ok": True}
            try:
                ans = build_answers(r["questions"], raw)
            except ValueError as e:
                return {"ok": False, "reason": str(e)}
            r["answers"] = ans
            r["nonce"] = nonce
            self._ask_close(r, "answered", "", now)
            return {"ok": True}

    # ------------------------------------------------------------- view
    def state(self):
        now = time.time()
        res, gone = self._view(now)
        with self.lock:
            return {"time": now, "build": build_id(), "root": ROOT, "root_exists": os.path.isdir(ROOT), "error": self.error,
                    "mods": len([1 for t in self.mods.values() if now - t < 20]),
                    "polls": {k[:8]: [v[0], round(now - v[1], 1)] for k, v in self.polls.items()}, "moddbg": list(self.moddbg),
                    "agents": res, "gone": gone, "pinned": sorted(self.pins)}

    def _view(self, now, bg=False):
        """(visible workers, workers removed from the office). /state, /names and /reply use this. bg: quiet observation by the loop (does not touch the gallery)."""
        gone = []
        recs = []
        self._view_at = now
        with self.lock:
            agents = list(self.agents.values())
            snaps = {a.id: a.snapshot(now) for a in agents}
            by_id = {a.id: a for a in agents}
            mains = [a for a in agents if not a.sub]
            subs = [a for a in agents if a.sub]
            extra = []
            tidmap, descmap, tsmap = {}, {}, {}          # worker id -> Agent call id / description / time
            for m in mains:
                running = [(tid, sp) for tid, sp in m.spawns.items() if not sp["done"]]
                files = sorted([s for s in subs if s.parent == m.session], key=lambda s: s.first_ts or 0)
                used = set()
                for tid, sp in running:
                    if sp["agent_id"]:
                        for f in files:
                            if f.id == "agent-" + sp["agent_id"]:
                                sp["file"] = f.id
                                used.add(f.id)
                loose_files = [f for f in files if f.id not in used and not f.meta.get("finished")]
                loose_spawns = [(tid, sp) for tid, sp in running if not sp.get("file")]
                for (tid, sp), f in zip(loose_spawns, loose_files):
                    sp["file"] = f.id
                    used.add(f.id)
                # label/task: from the description in the main session (also for finished ones)
                for tid, sp in m.spawns.items():
                    fid = sp.get("file") or (("agent-" + sp["agent_id"]) if sp.get("agent_id") else None)
                    if fid and fid in snaps:
                        s = snaps[fid]
                        s["label"] = "%s · %s" % (sp["type"], short(sp["desc"], 28))
                        s["agent_type"] = sp["type"]
                        if not s["task"]:
                            s["task"] = sp["desc"]
                        tidmap[fid], descmap[fid], tsmap[fid] = tid, sp["desc"], sp["ts"]
                for tid, sp in running:
                    if sp.get("file"):
                        continue
                    since = sp["ts"]
                    pid = "spawn-" + tid[-10:]
                    tidmap[pid], descmap[pid], tsmap[pid] = tid, sp["desc"], since
                    extra.append({
                        "id": "spawn-" + tid[-10:], "session": m.session, "parent": m.session,
                        "label": "%s · %s" % (sp["type"], short(sp["desc"], 28)), "project": m.project_label(),
                        "sub": True, "agent_type": sp["type"], "state": "typing", "tool": "Agent",
                        "detail": "Working", "target": short(sp["desc"], 60),
                        "since": since, "started": since, "idle_for": round(now - since, 1),
                        "task": sp["desc"], "tools": 0, "events": [], "finished": False,
                    })
            out = list(snaps.values()) + extra
            live_sessions = {k[0] for k in self.live if k[1]}
            for s in out:
                aid = s["id"][6:] if (s["sub"] and s["id"].startswith("agent-")) else ("" if not s["sub"] else None)
                if aid is None:
                    continue
                rec = self.live.get((s["session"], aid))
                if not rec:
                    continue
                resumed = now - rec["updated"] < 20 and rec["state"] != "done"      # finished sub-agent was woken up with a message
                if s["sub"] and (s["finished"] or s["state"] == "done") and not resumed:
                    continue
                fresh = (now - rec["updated"] < 900) or (rec["state"] == "waiting" and now - rec["updated"] < 3600)
                if not fresh:
                    continue
                s.update(state=rec["state"], detail=rec["detail"] or s["detail"], target=rec["target"], tool=rec["tool"] or s["tool"], since=rec["since"], live=True)
                if s["sub"] and rec.get("desc") and " · " not in s["label"]:
                    s["label"] = "%s · %s" % (rec.get("atype") or "Worker", short(rec["desc"], 28))
                if rec.get("task") and not s["task"]:
                    s["task"] = rec["task"]
            have = {s["id"] for s in out}
            for (sid, aid), rec in self.live.items():
                if not aid or ("agent-" + aid) in have or now - rec["updated"] > 900:
                    continue
                label = rec.get("atype") or "Worker"
                if rec.get("desc"):
                    label = "%s · %s" % (label, short(rec["desc"], 28))
                out.append({
                    "id": "agent-" + aid, "session": sid, "parent": sid, "label": label, "project": "",
                    "sub": True, "agent_type": rec.get("atype"), "state": rec["state"], "tool": rec["tool"],
                    "detail": rec["detail"], "target": rec["target"], "since": rec["since"], "started": rec["since"],
                    "idle_for": round(now - rec["updated"], 1), "task": "", "tools": 0, "events": [],
                    "finished": rec["state"] == "done", "live": True,
                })
            out = [s for s in out if not (s["id"].startswith("spawn-") and s["session"] in live_sessions)]
            # if a pinned chat exceeded the inactivity time: a tool / worker left half-finished in the log must not look "çalışıyor" (running), all become "done"
            if self.pins:
                stale = {s["session"] for s in out if not s["sub"] and s["session"] in self.pins and not s.get("live")
                         and (s["idle_for"] is None or s["idle_for"] > IDLE_LEAVE_SECONDS)}
                for s in out:
                    if s["session"] in stale and s["state"] != "done" and not s.get("live"):
                        s.update(state="done", tool="", target="", detail="Finished" if s["sub"] else "Finished, waiting for your next message")
            # --- identity: char / nick / kind_tr / role (for everyone, including hidden and filtered-out ones; the assignment does not change)
            items = []
            for s in out:
                ag = by_id.get(s["id"])
                rec = self.live.get((s["session"], s["id"][6:])) if (s["sub"] and s["id"].startswith("agent-")) else None
                tid = tidmap.get(s["id"]) or ((ag.meta.get("toolUseId") or None) if (ag and ag.sub) else None)
                desc = descmap.get(s["id"]) or (ag.meta.get("description") if ag and ag.sub else "") or (rec.get("desc") if rec else "") or ""
                s["_desc"] = desc
                items.append({"id": s["id"], "session": s["session"], "sub": s["sub"], "tid": tid, "type": s.get("agent_type") or "",
                              "started": tsmap.get(s["id"]) or s.get("started"), "desc": desc, "ph": s["id"].startswith("spawn-")})
            recs = self._eta_observe(out, items, by_id, now)
            who = self.namer.assign(items, now)
            for s in out:
                s["char"], s["nick"] = who.get(s["id"], ("robot", ""))
                if s["sub"]:
                    s["kind_tr"] = self.namer.kind_tr(s.get("agent_type"))
                    s["role"] = first_phrase(s.pop("_desc", "") or s.get("task"), 60)
                else:
                    s["kind_tr"], s["role"] = "", ""
                    s.pop("_desc", None)
            # --- filtering: orphaned sub-agents, main sessions idle for a long time, hidden ones (go into gone)
            main_ids = {s["session"] for s in out if not s["sub"]}
            res = []
            for s in out:
                if s["sub"] and s["session"] not in main_ids:
                    continue
                if not s["sub"] and s["state"] == "done" and (s["idle_for"] or 0) > IDLE_LEAVE_SECONDS and s["session"] not in self.pins:
                    continue                                    # a pinned chat (added with "+") is closed only with ×
                # extra fields
                ag = by_id.get(s["id"])
                names = set(ag.tool_names) if ag else set()
                rec = self.live.get((s["session"], s["id"][6:] if s["id"].startswith("agent-") else ""))
                if rec:
                    names |= set(rec["tools"])
                s["dept"] = dept_of(s["sub"], "%s %s" % (s["label"], s["task"]), s.get("agent_type"), names)
                if not bg:
                    self._gal_capture(s, s.get("label", "") if not s["sub"] else (snaps.get(s["session"]) or {}).get("label", ""))
                dis = self.dismissed.get(s["id"])
                if dis and not (s["idle_for"] is not None and s["idle_for"] < now - dis - 3):
                    gone.append({"id": s["id"], "session": s["session"], "nick": s["nick"], "char": s["char"], "label": s["label"],
                                 "role": s["role"], "kind_tr": s["kind_tr"], "project": s["project"], "sub": s["sub"],
                                 "dept": s["dept"], "at": dis})
                    continue
                s["reply"], s["reply_hist"] = ag.reply_info() if ag else (None, [])
                s["tool_names"] = sorted(names)[:12]
                live_chat = list(self.chats.get(s["id"], []))
                if ag and not s["sub"] and ag.convo:
                    def _dup(c):                          # the same message may come both from the log and from the plugin/tower path
                        return any(m["who"] == c["who"] and abs(m["t"] - c["t"]) < 180 and
                                   (m["text"][:60] == c["text"][:60] or c["text"].startswith(m["text"][:40]))
                                   for m in live_chat)
                    live_chat += [{"id": "L%d" % int(c["t"] * 1000), "t": c["t"], "who": c["who"], "text": c["text"],
                                   "st": "yanit" if c["who"] == "ajan" else "iletildi", **({"atts": []} if c["who"] == "ben" else {})}
                                  for c in ag.convo if not _dup(c)]
                    live_chat.sort(key=lambda m: m["t"])
                s["chat"] = live_chat[-30:]
                s["artifacts"] = list(self.art.get(s["id"], {}).values())[-30:]
                s["can_message"] = (now - self.mods.get(s["session"], 0)) < 20 and not s["id"].startswith("spawn-")
                s["eta"] = self._eta_of(s)
                s["eta_n"] = self._eta_n_of(s)
                res.append(s)
        if recs:
            self._dur_add(recs)                      # file writing outside self.lock
        gone.sort(key=lambda g: -g["at"])
        return res, gone


WATCHER = Watcher()


def window_top(want=None, hwnd=None, classes=("Chrome_WidgetWin_1",)):
    """Windows: keeps the foreground window (the Pixel Office app window whose button you clicked) on top of other windows / releases it.
    Touches only the Edge/Chrome app window (class name check). hwnd/classes are for testing only."""
    if os.name != "nt":
        return {"ok": False, "reason": "This feature only works on Windows."}
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        u.GetForegroundWindow.restype = wintypes.HWND
        u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
        u.GetWindowLongW.restype = ctypes.c_long
        u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        if hwnd is None:
            hwnd = u.GetForegroundWindow()
        if not hwnd:
            return {"ok": False, "reason": "Window not found"}
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, cls, 256)
        if cls.value not in classes:
            return {"ok": False, "reason": "This feature only works in the NorthLight Tower app window (open it with Start.bat)."}
        top = bool(u.GetWindowLongW(hwnd, -20) & 0x8)         # GWL_EXSTYLE & WS_EX_TOPMOST
        if want is None:
            want = not top
        u.SetWindowPos(hwnd, wintypes.HWND(-1 if want else -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)   # NOSIZE | NOMOVE | NOACTIVATE
        return {"ok": True, "top": bool(want)}
    except Exception as e:
        return {"ok": False, "reason": "Could not set the window."}


class Srv(ThreadingHTTPServer):
    """Large listen backlog (default 5): dozens of parallel requests while the page loads must not get connection refused."""
    request_queue_size = 1024            # Windows accepts at most SOMAXCONN (about 200), trims the rest
    daemon_threads = True


STATIC_ROOT = ("office.html", "*.js", "*.css", "scene.json", "font5x7.json", "screenshot_*.png")
DENY_EXT = (".py", ".md", ".bat", ".vbs", ".ps1", ".zip", ".log", ".tsx", ".ts", ".pyc", ".cmd", ".sh")


class Handler(SimpleHTTPRequestHandler):
    timeout = 20                # a half-open connection with an incomplete body must not hold the thread forever

    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    # ---- helpers
    def _json(self, obj, code=200):
        text = json.dumps(obj, ensure_ascii=False)
        try:
            body = text.encode("utf-8")
        except UnicodeEncodeError:                          # lone surrogate: U+FFFD instead of dropping the connection
            body = scrub(text).encode("utf-8", "replace")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ("localhost", "127.0.0.1", "::1")

    def _origin_ok(self):
        o = self.headers.get("Origin")
        if not o:
            return True
        h = (urlparse(o).hostname or "").lower()
        return h in ("localhost", "127.0.0.1", "::1")

    def _trusted(self):
        """Does the request come from this page (or from a local client without a browser: plugin, curl)? Pages of other sites
        (cross-site / same-site different port) are marked by the browser with Sec-Fetch-Site and rejected here."""
        sfs = self.headers.get("Sec-Fetch-Site")
        if sfs and sfs not in ("same-origin", "none"):
            return False
        return self._origin_ok()

    def _same_origin_ok(self):
        """Browser routes (/config, /asks, /answer): if Origin is present, only THIS server itself (local name + same port).
        Old browsers that do not send Sec-Fetch-Site: a request from another local site (e.g. localhost:3000) is rejected this way too."""
        o = self.headers.get("Origin")
        if not o:
            return True
        try:
            u = urlparse(o)
            port = u.port or (443 if u.scheme == "https" else 80)
        except ValueError:
            return False
        return (u.hostname or "").lower() in ("localhost", "127.0.0.1", "::1") and port == self.server.server_address[1]

    def _mod_ok(self, post=False):
        """Plugin routes (/ask, /ask/wait, /ask/cancel, /ask/ack): the plugin is not a browser (Bun; sends no Origin or Sec-Fetch-*).
        Any request carrying Origin / Sec-Fetch-Site (whichever browser, whichever site) is rejected; the POST body must be JSON
        (an old browser's text/plain / form submission without a preflight cannot pass either)."""
        if self.headers.get("Origin") or self.headers.get("Sec-Fetch-Site") or self.headers.get("Sec-Fetch-Mode"):
            return False
        if post and (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            return False
        return True

    def _token_ok(self):
        tok = self.headers.get("X-PO-Token", "") or ""
        return secrets.compare_digest(tok.encode("utf-8", "replace"), WATCHER.token.encode("utf-8", "replace"))

    def _body(self):
        """JSON body (always a dict). If Content-Length is invalid/negative/zero, nothing is read."""
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0:
                return {}
            b = json.loads(self.rfile.read(min(n, 1_000_000)).decode("utf-8", errors="ignore") or "{}")
            return scrub_obj(b) if isinstance(b, dict) else {}
        except Exception:
            return {}

    def _upload(self):
        """POST /upload?to=<worker>  headers: X-PO-Token, X-PO-Name (file name with encodeURIComponent), Content-Length.
        The body is the raw bytes of the file. Type / size are rejected without reading the body (connection closes). Reply:
        {ok, id, name, path, size, kind, line} or {ok:false, reason}."""
        self.close_connection = True                               # on early rejections the unread body must not mix into the next request
        if not self._token_ok():
            return self._json({"ok": False, "reason": "unauthorized"}, 403)
        to = (parse_qs(urlparse(self.path).query).get("to") or [""])[0][:200]
        cl = self.headers.get_all("Content-Length") or []
        # only a single header with plain digits (forms int() accepts such as "+5", " 5", "5_0", "٥" and a duplicate header are rejected)
        n = int(cl[0]) if len(cl) == 1 and re.fullmatch(r"[0-9]{1,10}", cl[0]) else -1
        if n < 0 or self.headers.get("Transfer-Encoding"):
            return self._json({"ok": False, "reason": "File size was not provided"}, 411)
        try:
            stem, ext, kind = safe_upload_name((self.headers.get("X-PO-Name") or "")[:1024])
        except ValueError as e:
            return self._json({"ok": False, "reason": str(e)}, 415)
        if n == 0:
            return self._json({"ok": False, "reason": "The file is empty"}, 400)
        lim = UP_LIMIT[kind]
        if n > lim:
            return self._json({"ok": False, "reason": "File is too large (%s; max %d MB)" % (size_tr(n), lim // (1024 * 1024))}, 413)
        res, code = WATCHER.save_upload(to, stem, ext, kind, n, self.rfile)
        return self._json(res, code)

    def _static_ok(self, path):
        """Static serving whitelist: page files and assets/**; code, log, cache, tools and directory listings give 404."""
        try:
            rel = unquote(path).lstrip("/")
        except Exception:
            return False
        if not rel or any(c in rel for c in ("\\", ":", "\x00")):
            return False
        parts = rel.split("/")
        if any(p in ("", ".", "..") or p.startswith(".") or p.endswith((".", " ")) for p in parts):
            return False
        low = rel.lower()
        if low.endswith(DENY_EXT):
            return False
        if len(parts) == 1:
            return any(fnmatch.fnmatch(low, pat) for pat in STATIC_ROOT)
        if parts[0].lower() != "assets":
            return False
        fp = os.path.join(self.directory, *parts)
        return os.path.isfile(fp)           # no directory listing

    def do_HEAD(self):
        if not self._host_ok():
            self.send_response(403)
            self.end_headers()
            return
        if self.path.split("?")[0] in ("/", ""):
            self.path = "/office.html"
        if not self._static_ok(urlparse(self.path).path):
            self.send_response(404)
            self.end_headers()
            return
        return super().do_HEAD()

    def list_directory(self, path):
        self.send_error(404)
        return None

    # ---- GET
    def do_GET(self):
        if not self._host_ok():
            self.send_response(403)
            self.end_headers()
            return
        u = urlparse(self.path)
        path = u.path
        q = parse_qs(u.query)
        if path == "/state":
            WATCHER.last_client = time.time()
            return self._json(WATCHER.state())
        if path == "/config":
            if not self._trusted() or not self._same_origin_ok():
                self.send_response(403)
                self.end_headers()
                return
            return self._json({"token": WATCHER.token, "version": 4})
        if path == "/reply":                       # read-only: full text of an agent's final reply
            aid = (q.get("id") or [""])[0]
            try:
                n = int((q.get("n") or [""])[0])
            except ValueError:
                n = None
            got = WATCHER.reply_get(aid, n) if aid else None
            if not got:
                return self._json({"ok": False, "reason": "Reply not found"}, 404)
            return self._json(got)
        if path == "/gallery":                     # read-only: persistent gallery (past images, GIFs and videos + worker info)
            WATCHER.last_client = time.time()
            return self._json(WATCHER.gallery())
        if path == "/names":                       # read-only: names of the workers in the session (plugin's side panel)
            return self._json(WATCHER.names((q.get("sid") or [""])[0]))
        if path == "/outbox":
            if not self._trusted():
                self.send_response(403)
                self.end_headers()
                return
            sid = (q.get("sid") or [""])[0]
            mv = (q.get("mv") or [""])[0][:16]          # reports the new plugin version; the old one does not
            return self._json({"items": WATCHER.take_outbox(sid, mv) if sid else []})
        if path == "/asks":                         # Claude's questions: office cards. Token + origin: the polling says "office open / visible",
            if not self._trusted() or not self._same_origin_ok() or not self._token_ok():   # so that another page cannot fake it
                return self._json({"ok": False, "reason": "unauthorized"}, 403)
            # v=1: tab visible (document.visibilityState), f=1: page focused (document.hasFocus); if an old page does not send them, "not visible"
            return self._json(WATCHER.ask_list((q.get("v") or [""])[0] == "1", (q.get("f") or [""])[0] == "1"))
        if path == "/sessions/recent":              # sidebar / "+" list: titles of the recorded chats. The strictest rule (like /asks): origin + token
            if not self._trusted() or not self._same_origin_ok() or not self._token_ok():
                return self._json({"ok": False, "reason": "unauthorized"}, 403)
            try:                                    # ?offset=&limit=&q= : paging + search. A negative / non-numeric value gives 400; limit > 200 is trimmed
                off = int((q.get("offset") or ["0"])[0])
                lim = int((q.get("limit") or [str(RECENT_PAGE)])[0])
            except ValueError:
                return self._json({"ok": False, "reason": "invalid page value"}, 400)
            if off < 0 or lim < 1 or off > 10 ** 7:
                return self._json({"ok": False, "reason": "invalid page value"}, 400)
            WATCHER.last_client = time.time()
            return self._json(WATCHER.recent_sessions(off, lim, (q.get("q") or [""])[0]))
        if path == "/ask/wait":                     # the plugin's long polling (only a local non-browser client)
            if not self._mod_ok():
                self.send_response(403)
                self.end_headers()
                return
            try:
                hold = float((q.get("hold") or [str(ASK_HOLD)])[0])
            except ValueError:
                hold = ASK_HOLD
            return self._json(WATCHER.ask_wait((q.get("id") or [""])[0][:40], (q.get("sid") or [""])[0][:200], hold))
        if path.startswith("/file/"):
            fid = unquote(path[6:]).split(".")[0]
            fp = WATCHER.files.get(fid)
            if not fp or not os.path.isfile(fp):
                self.send_response(404)
                self.end_headers()
                return
            try:
                with open(fp, "rb") as f:
                    data = f.read()
            except OSError:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(fp)[0] or "application/octet-stream")
            self.send_header("Cache-Control", "max-age=3600")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path in ("/", ""):
            self.path = "/office.html"
            path = "/office.html"
        if not self._static_ok(path):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        WATCHER.last_client = time.time()
        return super().do_GET()

    # ---- POST
    def do_POST(self):
        if not self._host_ok():
            self.send_response(403)
            self.end_headers()
            return
        route = self.path.split("?")[0]
        if DEBUG and route in ("/hook", "/ack"):
            try:
                with open(os.path.join(HERE, "_work", "hook_headers.log"), "a", encoding="utf-8") as f:
                    f.write(json.dumps({k: self.headers.get(k) for k in ("Sec-Fetch-Site", "Sec-Fetch-Mode", "Origin", "User-Agent", "Host", "Content-Type")}) + chr(10))
            except Exception:
                pass
        if route in ("/hook", "/ack", "/send", "/dismiss", "/window", "/restore", "/stop", "/upload", "/ask", "/ask/cancel", "/ask/ack", "/answer",
                     "/sessions/pin", "/sessions/unpin") and not self._trusted():
            self.close_connection = True                           # an unread body (e.g. an upload) must not stay on the connection
            return self._json({"ok": False, "reason": "unauthorized"}, 403)
        if route == "/upload":                     # message attachment: token + origin check, raw body (not JSON)
            return self._upload()
        if route in ("/ask", "/ask/cancel", "/ask/ack"):   # plugin: leaves a question / withdraws it / reports that it received the answer (not a browser, JSON)
            if not self._mod_ok(post=True):
                self.close_connection = True
                return self._json({"ok": False, "reason": "unauthorized"}, 403)
            b = self._body()
            if route == "/ask":
                return self._json(WATCHER.ask_create(b))
            qid, sid, tuid = str(b.get("id") or "")[:40], str(b.get("sid") or "")[:200], str(b.get("tuid") or "")[:200]
            if route == "/ask/ack":
                return self._json(WATCHER.ask_ack(qid, sid, b.get("ok") is True, b.get("reason"), tuid))
            return self._json(WATCHER.ask_cancel(qid, sid, tuid, b.get("reason")))
        if route == "/answer":                     # office: answer to a question or "Claude'da cevapla" (answer in Claude) (token + origin check)
            if not self._token_ok() or not self._same_origin_ok():
                return self._json({"ok": False, "reason": "unauthorized"}, 403)
            b = self._body()
            return self._json(WATCHER.ask_answer(b.get("id"), b.get("answers"), b.get("handoff") is True, b.get("nonce") or ""))
        if route in ("/sessions/pin", "/sessions/unpin"):   # add a chat with "+" (pin) / close with ×: token + origin check
            if not self._token_ok() or not self._same_origin_ok():
                return self._json({"ok": False, "reason": "unauthorized"}, 403)
            b = self._body()
            res, code = (WATCHER.pin if route == "/sessions/pin" else WATCHER.unpin)(b.get("id"))
            return self._json(res, code)
        if route == "/hook":                       # plugin / hook events (local only)
            try:
                WATCHER.hook(self._body())
            except Exception:
                return self._json({"ok": False, "reason": "malformed event"}, 400)
            return self._json({"ok": True})
        if route in ("/send", "/dismiss", "/window", "/restore", "/stop"):   # user actions: token + origin check
            if not self._token_ok():
                return self._json({"ok": False, "reason": "unauthorized"}, 403)
            b = self._body()
            if route == "/window":
                act = str(b.get("action") or "")
                return self._json(window_top({"top": True, "untop": False}.get(act)) if act in ("top", "untop", "toggle") else {"ok": False, "reason": "unknown action"})
            if route == "/send":
                return self._json(WATCHER.send(str(b.get("to") or ""), b.get("text"), b.get("files")))
            if route == "/restore":
                return self._json(WATCHER.restore(str(b.get("id") or "")))
            if route == "/stop":
                return self._json(WATCHER.stop(str(b.get("id") or "")))
            done = WATCHER.dismiss(str(b.get("id") or ""))
            return self._json({"ok": True} if done else {"ok": False, "reason": "Worker not found"})
        if route == "/ack":
            b = self._body()
            return self._json({"ok": WATCHER.ack(str(b.get("id") or ""), bool(b.get("ok")), b.get("reason"))})
        if route == "/_snap" and DEBUG:            # development: save the canvas image to the _work folder
            try:
                n = max(0, min(int(self.headers.get("Content-Length", "0")), 20_000_000))
                data = self.rfile.read(n).decode("ascii", errors="ignore").split(",", 1)[-1]
                os.makedirs(os.path.join(HERE, "_work", "frames"), exist_ok=True)
                name = "snap.png"
                qs = self.path.split("?", 1)[1] if "?" in self.path else ""
                if qs.startswith("name="):
                    name = "frames/" + re.sub(r"[^0-9A-Za-z_-]", "", qs[5:]) + ".png"
                with open(os.path.join(HERE, "_work", name), "wb") as f:
                    f.write(base64.b64decode(data))
            except Exception:
                pass
            return self._json({"ok": True})
        self.send_response(404)
        self.end_headers()

    def end_headers(self):
        self.send_header("X-NorthLight-Tower", "1")        # identity: Start.bat / Stop.bat tell this server apart from other programs on the port
        if not self.path.startswith("/state"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass


def port_in_use(port, host="127.0.0.1"):
    """True if something already accepts connections on host:port.
    Windows lets two programs listen on the same port (SO_REUSEADDR) and then the OLDER listener receives the connections,
    so a second copy of this server, or another program's dev server, would silently never be reached."""
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


PIDFILE = os.path.join(HERE, ".tower.pid")      # process id of the running server (Stop.bat stops exactly this process)


def _write_pidfile():
    try:
        with open(PIDFILE, "w", encoding="ascii") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


def _remove_pidfile():
    try:
        with open(PIDFILE, "r", encoding="ascii") as f:
            if f.read().strip() != str(os.getpid()):
                return
        os.remove(PIDFILE)
    except OSError:
        pass


if __name__ == "__main__":
    if port_in_use(PORT):
        print("Port %d is already in use: NorthLight Tower may already be running, or another program is using it." % PORT)
        sys.exit(3)
    WATCHER.start()
    try:
        srv = Srv(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print("Could not open port %d (it may already be running): %s" % (PORT, e))
        sys.exit(1)
    _write_pidfile()
    print("NorthLight Tower ready:  http://127.0.0.1:%d   (close this window to stop it)" % PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _remove_pidfile()
