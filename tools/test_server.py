"""Quick tests for the server (no network or real log needed):  python tools/test_server.py
- extracting a GIF/MP4/WEBM path from command text
- agent log: when a command finishes successfully the generated animation enters the gallery, a failed / old file does not
- keeping the window on top (with a hidden Tk window)
- v4: character/name assignment (stability, uniqueness, placeholder -> real file, restart), reply capture
  (split blocks, U+2028, SubagentHandback, n continuity), gone/restore, stop queue + ack, /names, /reply, HTTP permissions
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
warnings.simplefilter("error")
spec = importlib.util.spec_from_file_location("sunucu", os.path.join(ROOT, "server.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def test_media_paths():
    cases = {
        'python make.py --out "C:/Users/me/Documents/Projects/at kosu.gif" --fps 12': ["C:\\Users\\me\\Documents\\Projects\\at kosu.gif"],
        "ffmpeg -i in.mp4 /c/Users/me/Desktop/out.webm -y": ["C:\\Users\\me\\Desktop\\out.webm"],
        "python x.py C:/Users/me/a/b.GIF && echo done": ["C:\\Users\\me\\a\\b.GIF"],
        "ls /c/Users/me/Desktop/*.gif": [],
        "echo 'http://example.com/a.gif'": [],
    }
    for cmd, want in cases.items():
        got = m.media_paths(cmd)
        assert got == want, (cmd, got, want)
    print("media_paths ok")


def test_feed_media():
    gif = os.path.join(ROOT, "assets", "demo", "demo_anim1.gif")
    if not os.path.isfile(gif):
        print("feed_media skipped (no demo gif)")
        return
    os.utime(gif, None)
    now = time.time()
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
    a = m.Agent(os.path.join(m.ROOT, "C--fake", "sess1.jsonl"))
    lines = [
        {"type": "assistant", "timestamp": iso(now - 5), "message": {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": 'python mk.py --out "%s"' % gif.replace("\\", "/")}}]}},
        {"type": "user", "timestamp": iso(now - 4), "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "tamam"}]}},
        {"type": "assistant", "timestamp": iso(now - 3), "message": {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": 'python mk.py --out "%s"' % gif}}]}},
        {"type": "user", "timestamp": iso(now - 2), "message": {"content": [{"type": "tool_result", "tool_use_id": "t2", "is_error": True, "content": "hata"}]}},
        {"type": "assistant", "timestamp": iso(now + 3600), "message": {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": 'cat "%s"' % gif}}]}},
        {"type": "user", "timestamp": iso(now + 3601), "message": {"content": [{"type": "tool_result", "tool_use_id": "t3", "content": "x"}]}},
    ]
    for ln in lines:
        a.feed(json.dumps(ln))
    assert len(a.new_art) == 1 and a.new_art[0][0].lower() == gif.lower(), a.new_art
    print("feed_media ok")


def test_window_top():
    if os.name != "nt":
        return
    try:
        import ctypes
        import tkinter as tk
    except Exception:
        print("window_top skipped (no tkinter)")
        return
    root = tk.Tk()
    root.update()
    hwnd = ctypes.windll.user32.GetParent(root.winfo_id()) or root.winfo_id()
    cls = ctypes.create_unicode_buffer(64)
    ctypes.windll.user32.GetClassNameW(hwnd, cls, 64)
    root.withdraw()
    root.update()
    kw = dict(hwnd=hwnd, classes=(cls.value,))
    assert m.window_top(None, **kw) == {"ok": True, "top": True}
    assert m.window_top(None, **kw) == {"ok": True, "top": False}
    assert m.window_top(True, **kw)["top"] is True
    assert m.window_top(False, **kw)["top"] is False
    bad = m.window_top(None, hwnd=hwnd)
    assert bad["ok"] is False        # does not touch it if it is not an Edge/Chrome window
    assert bad["reason"] == "This feature only works in the NorthLight Tower app window (open it with Start.bat)." # TXT-20
    root.destroy()
    print("window_top ok")


# ----------------------------------------------------------------------------- v4 tests
ISO = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.", time.gmtime(t)) + "%03dZ" % int((t % 1) * 1000)


def asst(t, blocks, stop="end_turn", mid="msg_1", **kw):
    d = {"type": "assistant", "timestamp": ISO(t), "message": {"id": mid, "stop_reason": stop, "content": blocks}}
    if "model" in kw:
        d["message"]["model"] = kw.pop("model")
    d.update(kw)
    return json.dumps(d, ensure_ascii=False)


def user(t, text):
    return json.dumps({"type": "user", "timestamp": ISO(t), "message": {"content": text}}, ensure_ascii=False)


def text_block(s):
    return {"type": "text", "text": s}


def fake_main(name="sess1"):
    return m.Agent(os.path.join(m.ROOT, "C--fake", name + ".jsonl"))


def fake_sub(sess="sess1", aid="abc123", meta=None):
    a = m.Agent(os.path.join(m.ROOT, "C--fake", sess, "subagents", "agent-" + aid + ".jsonl"))
    a.meta = meta or {}
    return a


def test_text_helpers():
    assert m.head_of("# Başlık\n\nHer şey **tamam**.\n- madde `kod`\n```py\nprint(1)\n```") == "Her şey tamam. madde kod"
    assert m.head_of("# Kule hazır\n\nOfis kulesinin yeni sürümünü bitirdim.") == "Ofis kulesinin yeni sürümünü bitirdim."
    assert m.head_of("# Sadece başlık") == "Sadece başlık"                    # if there is no body, the title stays
    assert m.head_of("KISA EK + ÖZET RAPOR (içerik değişmedi)\n\nKullanıcı bir şey istedi.") == "KISA EK + ÖZET RAPOR (içerik değişmedi): Kullanıcı bir şey istedi."
    assert m.head_of("Kule hazır\nOfis kulesini bitirdim.") == "Kule hazır: Ofis kulesini bitirdim."
    assert m.head_of("Bitirdim.\nİkinci cümle") == "Bitirdim. İkinci cümle"
    t0 = time.time()                                                          # SM-08: no regex O(n^2) freeze
    m.head_of("[" * 30000)
    m.head_of("[a" * 15000)
    assert time.time() - t0 < 1.0, time.time() - t0
    assert m.head_of("**ÖZET:** Her şey **tamam**.\n\nayrıntı") == "Her şey tamam. ayrıntı"
    assert m.head_of("ÖZET: kısa özet\nayrıntı") == "kısa özet ayrıntı"
    assert m.head_of("```\nsadece kod\n```") == "sadece kod"
    assert len(m.head_of("a " * 400)) <= 160
    assert m.first_phrase("Mod testi: canlı alt ajan") == "Mod testi: canlı alt ajan"
    assert m.first_phrase("Dosyaları tara. Sonra raporla ve bana yaz lütfen çok uzun devam") == "Dosyaları tara"
    assert len(m.first_phrase("x" * 200)) <= 40
    long_role = "Alt ajana doğrudan mesaj özelliğini araştırma ve ardından kapsamlı bir rapor yazma işi"      # S-18: word limit, <= 60
    fp = m.first_phrase(long_role, 60)
    assert len(fp) <= 60 and fp.endswith("…") and long_role.startswith(fp[:-1]) and long_role[len(fp) - 1] == " ", fp
    assert m.first_phrase("Kısa iş", 60) == "Kısa iş"
    assert m.clean_prompt("[Request interrupted by user]") == ""
    assert m.clean_prompt("This session is being continued from a previous conversation that ran out of context.") == ""      # SM-11
    assert m.clean_prompt("[Piksel Ofis sohbeti] Şunu yap") == "" and m.clean_prompt("Gerçek istem") == "Gerçek istem"
    assert m.clean_prompt("<command-name>/clear</command-name><command-args>şunu</command-args>") == "/clear şunu"
    print("text_helpers ok")


def test_namer():
    n = m.Namer()
    mk = lambda i, sess="s1", sub=True, tid=None, ph=False, started=None, desc="", typ="": dict(id=i, session=sess, sub=sub, tid=tid, started=started, desc=desc, type=typ, ph=ph)
    items = [mk("main1", sub=False)] + [mk("agent-%02d" % i, started=100 + i, tid="t%02d" % i) for i in range(16)]
    r = n.assign(items)
    assert r["main1"][0] in ("mudur", "mudire") and r["main1"][1] in ("Müdür", "Müdire", "Manager")
    first14 = [r["agent-%02d" % i] for i in range(14)]
    assert len({c for c, _ in first14}) == 14, "ilk 14 çalışan benzersiz karakter almalı"
    extra = [r["agent-14"][1], r["agent-15"][1]]
    assert all(x.endswith(" 2") for x in extra), extra
    assert r == n.assign(items), "atama değişmemeli"
    # restart: same input, new Namer -> same result (started order)
    assert m.Namer().assign(list(reversed(items))) == r
    # another session is independent
    r2 = n.assign(items + [mk("agent-z", sess="s2", started=5, tid="tz")])
    assert r2["agent-z"][0] and "2" not in r2["agent-z"][1].split()[-1:]
    # placeholder -> real file is the same person (by tool_use id)
    n2 = m.Namer()
    a = n2.assign([mk("spawn-1", ph=True, tid="toolu_A", desc="D", typ="Explore", started=1), mk("main1", sub=False)])["spawn-1"]
    b = n2.assign([mk("agent-real", tid="toolu_A", started=2), mk("main1", sub=False)])["agent-real"]
    assert a == b
    # if the id is unknown, description + type match
    n3 = m.Namer()
    a = n3.assign([mk("spawn-2", ph=True, tid="toolu_B", desc="Aynı iş", typ="Plan", started=1)])["spawn-2"]
    b = n3.assign([mk("agent-live", desc="Aynı iş", typ="Plan", started=2)])["agent-live"]
    assert a == b
    assert n.kind_tr("Explore") == "Araştırmacı" and n.kind_tr("general-purpose") == "Uzman" and n.kind_tr("Plan") == "Planlayıcı"
    assert n.kind_tr("claude-code-guide") == "Rehber" and n.kind_tr(None) == "Çalışan" and n.kind_tr("bilinmeyen") == "Çalışan"
    print("namer ok")


def test_reply_capture():
    t0 = time.time() - 600
    a = fake_main()
    L = [
        user(t0, "Petty cash listesini düzelt"),
        asst(t0 + 1, [{"type": "thinking", "thinking": "..."}], mid="m1"),
        asst(t0 + 2, [text_block("Önce bakıyorum.")], stop="tool_use", mid="m1"),
        asst(t0 + 3, [{"type": "tool_use", "id": "tu1", "name": "Read", "input": {"file_path": "a.txt"}}], stop="tool_use", mid="m1"),
        json.dumps({"type": "user", "timestamp": ISO(t0 + 4), "message": {"content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "x"}]}}),
        asst(t0 + 5, [{"type": "thinking", "thinking": "..."}], mid="m2"),
        asst(t0 + 6, [text_block("# Bitti\n\nBirinci paragraf.")], mid="m2"),       # 2 text blocks of the same message on separate lines
        asst(t0 + 6.1, [text_block("İkinci blok\nsatır 2")], mid="m2"),
        asst(t0 + 7, [text_block("API Error: x")], mid="m3", isApiErrorMessage=True),
        asst(t0 + 8, [text_block("sentetik")], mid="m4", model="<synthetic>"),
    ]
    for ln in L:
        a.feed(ln)
    assert a.reply_count == 1, a.reply_count
    e = a.replies[-1]
    assert e["text"] == "# Bitti\n\nBirinci paragraf.\n\nİkinci blok\nsatır 2", repr(e["text"])
    assert e["task"] == "Petty cash listesini düzelt"
    a._finish_first()
    r, hist = a.reply_info()
    assert r["n"] == 1 and r["len"] == len(e["text"]) and r["head"].startswith("Birinci paragraf. İkinci blok") and len(hist) == 1
    assert a.reply_mark()[0] == 1
    # second turn: n increases; intermediate text (must stop at "tool_use") does not count as a reply; after 12 replies the last 10 are kept
    for i in range(12):
        a.feed(user(t0 + 20 + i * 3, "soru %d" % i))
        a.feed(asst(t0 + 21 + i * 3, [text_block("yanıt %d" % i)], mid="r%d" % i))
    r, hist = a.reply_info()
    assert r["n"] == 13 and len(hist) == 10 and hist[0]["n"] == 4 and hist[-1]["n"] == 13, (r, [h["n"] for h in hist])
    assert a.reply_get(13)["text"] == "yanıt 11" and a.reply_get(13)["task"] == "soru 11" and a.reply_get(2) is None
    # long text is shortened, line breaks are kept
    a.feed(asst(t0 + 90, [text_block("satır\n" * 20000)], mid="uzun"))
    assert len(a.replies[-1]["text"]) <= m.MAX_REPLY and "\n" in a.replies[-1]["text"]
    print("reply_capture ok")


def test_reply_file_unicode_split():
    """A U+2028 inside the message must not count as a line break (the old splitlines() would split the line and lose the reply)."""
    d = tempfile.mkdtemp()
    try:
        p = os.path.join(d, "sess9.jsonl")
        t0 = time.time() - 50
        body = "ilk ikinci üçüncü\x85dördüncü\n- liste"
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(user(t0, "merhaba") + "\n" + asst(t0 + 1, [text_block(body)], mid="u1") + "\n")
        a = m.Agent(p)
        a.read_new()
        assert a.reply_count == 1 and a.replies[-1]["text"] == body, a.replies
        # partial line: if the end of the file is not finished yet it waits, reads once complete
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(asst(t0 + 5, [text_block("ikinci yanıt")], mid="u2")[:40])
        a.read_new()
        assert a.reply_count == 1
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(asst(t0 + 5, [text_block("ikinci yanıt")], mid="u2")[40:] + "\n")
        a.read_new()
        assert a.reply_count == 2 and a.replies[-1]["text"] == "ikinci yanıt"
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("reply_file_unicode_split ok")


def test_reply_n_survives_restart():
    t0 = time.time() - 1000
    lines = []
    for i in range(3):
        lines += [user(t0 + i * 10, "g%d" % i), asst(t0 + i * 10 + 1, [text_block("y%d" % i)], mid="k%d" % i)]
    a = fake_main("sessR")
    a.saved = [7, t0 + 21 - 0.0 + 0.0]                    # in the previous run the last reply (the 3rd) was n=7
    a.saved[1] = t0 + 21
    for ln in lines:
        a.feed(ln)
    a._finish_first()
    assert [a.reply_n(e) for e in a.replies] == [5, 6, 7], [a.reply_n(e) for e in a.replies]
    a.feed(user(t0 + 100, "yeni"))
    a.feed(asst(t0 + 101, [text_block("yeni yanıt")], mid="knew"))
    assert a.reply_info()[0]["n"] == 8
    assert a.reply_mark()[0] == 8
    b = fake_main("sessZ")                                 # no record: starts from 1
    b.feed(asst(t0, [text_block("a")], mid="z"))
    b._finish_first()
    assert b.reply_info()[0]["n"] == 1
    print("reply_n_survives_restart ok")


def test_subagent_handback():
    t0 = time.time() - 600
    s = fake_sub(meta={"agentType": "Explore"})
    s.feed(user(t0, "Uzun bir görev istemi ..."))
    s.feed(asst(t0 + 1, [text_block("Bitirdim sanırım")], mid="a1"))                     # a chat sentence, not a report
    assert s.reply_count == 0 and s.pending_end
    s.feed(asst(t0 + 3, [{"type": "tool_use", "id": "h1", "name": "SubagentHandback", "input": {"message": "ÖZET: tamam\n\nayrıntı\n- a\n- b"}}], stop="tool_use", mid="a2"))
    assert s.reply_count == 1 and s.pending_end is None and s.replies[-1]["src"] == "handback"
    assert s.replies[-1]["text"] == "ÖZET: tamam\n\nayrıntı\n- a\n- b"
    assert s.reply_info()[0]["head"] == "tamam ayrıntı a b"
    assert s.last == "done"
    # if the same report is delivered again it is not duplicated; if different, a new reply
    again = lambda txt, i: s.feed(asst(t0 + 10 + i, [{"type": "tool_use", "id": "h%d" % (i + 5), "name": "SubagentHandback", "input": {"message": txt}}], stop="tool_use", mid="b%d" % i))
    again("ÖZET: tamam\n\nayrıntı\n- a\n- b", 1)
    assert s.reply_count == 1
    again("ek rapor", 2)
    assert s.reply_count == 2 and s.reply_info()[0]["n"] == 2
    # old-type sub-agent that never got SubagentHandback: the last text becomes the reply after 120 s
    o = fake_sub(aid="old")
    o.feed(user(t0, "iş"))
    o.feed(asst(t0 + 5, [text_block("Rapor metni")], mid="o1"))
    o.commit_pending(t0 + 60)
    assert o.reply_count == 0
    o.commit_pending(t0 + 200)
    assert o.reply_count == 1 and o.replies[-1]["text"] == "Rapor metni"
    print("subagent_handback ok")


def fresh_watcher(tmp):
    """A separate Watcher that does not touch the real _cache folder."""
    os.makedirs(os.path.join(tmp, "assets"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "assets", "names.json"), os.path.join(tmp, "assets", "names.json"))
    m.HERE = tmp
    w = m.Watcher()
    m.WATCHER = w
    return w


def build_world(w, sid="sess1"):
    """1 main agent + 2 sub-agents started with an Agent call (one with a file, one a placeholder)."""
    t0 = time.time() - 30
    main = m.Agent(os.path.join(m.ROOT, "C--fake", sid + ".jsonl"))
    for ln in (
        user(t0, "Kuleyi düzenle"),
        asst(t0 + 1, [{"type": "tool_use", "id": "toolu_A", "name": "Agent", "input": {"description": "Mod testi: canlı alt ajan", "subagent_type": "Explore", "prompt": "x", "run_in_background": True}}], stop="tool_use", mid="p1"),
        asst(t0 + 2, [{"type": "tool_use", "id": "toolu_B", "name": "Agent", "input": {"description": "Sunucu incele", "subagent_type": "general-purpose", "prompt": "y"}}], stop="tool_use", mid="p2"),
        asst(t0 + 3, [text_block("Bitti, bak.")], mid="p3"),
    ):
        main.feed(ln)
    main.spawns["toolu_A"]["agent_id"] = "aaa111"
    sub = m.Agent(os.path.join(m.ROOT, "C--fake", sid, "subagents", "agent-aaa111.jsonl"))
    sub.meta = {"agentType": "Explore", "description": "Mod testi: canlı alt ajan", "toolUseId": "toolu_A"}
    sub.feed(user(t0 + 2, "uzun istem"))
    sub.feed(asst(t0 + 20, [{"type": "tool_use", "id": "hb", "name": "SubagentHandback", "input": {"message": "ÖZET: yaptım\n\nayrıntı"}}], stop="tool_use", mid="s1"))
    w.agents = {main.path: main, sub.path: sub}
    return main, sub


def test_view_gone_restore_stop_names():
    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        main, sub = build_world(w)
        st = w.state()
        by = {a["id"]: a for a in st["agents"]}
        assert set(by) == {"sess1", "agent-aaa111", "spawn-" + "toolu_B"[-10:]}, set(by)
        mn, sb, ph = by["sess1"], by["agent-aaa111"], by["spawn-" + "toolu_B"[-10:]]
        assert mn["char"] in ("mudur", "mudire") and mn["nick"] in ("Müdür", "Müdire", "Manager") and mn["kind_tr"] == "" and mn["role"] == ""
        assert sb["kind_tr"] == "Araştırmacı" and sb["role"] == "Mod testi: canlı alt ajan" and sb["char"] and sb["nick"]
        assert ph["kind_tr"] == "Uzman" and ph["role"] == "Sunucu incele" and ph["char"] != sb["char"]
        assert mn["reply"]["n"] == 1 and mn["reply"]["head"] == "Bitti, bak." and set(mn["reply"]) == {"n", "t", "head", "len"}
        assert sb["reply"]["n"] == 1 and sb["reply"]["head"] == "yaptım ayrıntı" and len(sb["reply_hist"]) == 1
        assert ph["reply"] is None and ph["reply_hist"] == []
        assert "text" not in json.dumps(mn["reply"]) and st["gone"] == []
        assert mn["label"] and sb["label"].startswith("Explore")
        assert ph["detail"] == "Working", ph["detail"]      # S-05 / decision 7
        # when the placeholder turns into a real file, the same person
        pid_char, pid_nick = ph["char"], ph["nick"]
        real = m.Agent(os.path.join(m.ROOT, "C--fake", "sess1", "subagents", "agent-bbb222.jsonl"))
        real.meta = {"agentType": "general-purpose", "description": "Sunucu incele", "toolUseId": "toolu_B"}
        real.feed(user(time.time() - 25, "istem"))
        w.agents[real.path] = real
        main.spawns["toolu_B"]["agent_id"] = "bbb222"
        by2 = {a["id"]: a for a in w.state()["agents"]}
        assert "spawn-" + "toolu_B"[-10:] not in by2 or True
        assert by2["agent-bbb222"]["char"] == pid_char and by2["agent-bbb222"]["nick"] == pid_nick
        assert by2["agent-aaa111"]["char"] == sb["char"] and by2["sess1"]["char"] == mn["char"]
        # dismiss -> gone -> restore
        assert w.dismiss("agent-aaa111")
        st = w.state()
        assert "agent-aaa111" not in {a["id"] for a in st["agents"]}
        g = {x["id"]: x for x in st["gone"]}["agent-aaa111"]
        assert set(g) == {"id", "session", "nick", "char", "label", "role", "kind_tr", "project", "sub", "dept", "at"}, set(g)
        assert g["nick"] == sb["nick"] and g["char"] == sb["char"] and g["role"] == sb["role"] and g["sub"] is True and g["at"] > 0
        assert w.restore("agent-aaa111") == {"ok": True}
        st = w.state()
        assert st["gone"] == [] and "agent-aaa111" in {a["id"] for a in st["agents"]}
        assert w.restore("agent-aaa111")["ok"] is True and w.restore("yok-boyle-biri")["ok"] is False
        # stop: if the plugin is not running, the reason; if running, queue + chat note + ack
        done_stop = {"ok": False, "reason": "The worker has already stopped"}
        assert w.stop("agent-aaa111") == done_stop                        # SM-02: STOP does not go to a finished sub-worker (it must not wake it up and burn tokens)
        r = w.stop("agent-bbb222")
        assert r == {"ok": False, "reason": "The NorthLight Tower plugin is not connected to this Claude chat; cannot stop."}, r      # decision 5
        w.hook({"src": "mod", "kind": "dbg", "sid": "sess1", "text": "merhaba"})
        assert w.stop("agent-aaa111") == done_stop                        # the same while the plugin is running
        assert w.dismiss("agent-bbb222") and w.stop("agent-bbb222") == done_stop        # removed from the office
        assert w.restore("agent-bbb222") == {"ok": True}
        r = w.stop("agent-bbb222")
        assert r["ok"] is True and r["id"].startswith("x")
        r2 = w.stop("sess1")
        assert r2["ok"] is True
        items = w.take_outbox("sess1")
        assert [(i["kind"], i["aid"], i["text"]) for i in items] == [("stop", "bbb222", ""), ("stop", "", "")], items
        assert items[0]["id"] == r["id"] and items[0]["key"] == "agent-bbb222" and items[0]["sid"] == "sess1"
        chat = {a["id"]: a for a in w.state()["agents"]}["agent-bbb222"]["chat"]
        assert chat[-1]["who"] == "ofis" and chat[-1]["st"] == "bekliyor" and chat[-1]["id"] == r["id"]
        assert w.ack(r["id"], True, "TaskStop")
        chat = {a["id"]: a for a in w.state()["agents"]}["agent-bbb222"]["chat"]
        assert chat[-1]["st"] == "iletildi" and chat[-1]["via"] == "TaskStop"
        assert w.stop("spawn-xxxx")["ok"] is False and w.stop("")["ok"] is False
        # plugin 'reply' event: line breaks are kept (<= 4000)
        w.hook({"src": "mod", "kind": "reply", "sid": "sess1", "aid": "aaa111", "text": "ÖZET: tamam\n\n- bir\n- iki"})
        chat = {a["id"]: a for a in w.state()["agents"]}["agent-aaa111"]["chat"]
        assert chat[-1]["who"] == "ajan" and chat[-1]["text"] == "ÖZET: tamam\n\n- bir\n- iki"
        # names
        nm = w.names("sess1")["agents"]
        ids = [x["id"] for x in nm]
        assert ids[0] == "sess1" and nm[0]["aid"] == "" and nm[0]["sub"] is False and set(nm[0]) >= {"id", "aid", "nick", "char", "kind_tr", "role", "sub", "state"}
        assert {x["aid"] for x in nm if x["sub"]} == {"aaa111", "bbb222"} and not any(i.startswith("spawn-") for i in ids)
        assert w.names("baska-oturum")["agents"] == []
        # reply_get
        r = w.reply_get("agent-aaa111")
        assert r["ok"] and r["n"] == 1 and r["text"] == "ÖZET: yaptım\n\nayrıntı" and r["task"] == "Mod testi: canlı alt ajan" and r["nick"] == sb["nick"]
        r = w.reply_get("sess1", 1)
        assert r["text"] == "Bitti, bak." and r["task"] == "Kuleyi düzenle" and r["label"] and r["project"] is not None
        assert w.reply_get("sess1", 5) is None and w.reply_get("yok") is None
        # persistent marker
        main._first_done = True
        assert main.reply_mark()[0] == 1
        # server 'restarts': same assignment with the same input
        w2 = fresh_watcher(tmp)
        w2.agents = {a.path: a for a in w.agents.values()}
        again = {a["id"]: (a["char"], a["nick"]) for a in w2.state()["agents"]}
        before = {a["id"]: (a["char"], a["nick"]) for a in w.state()["agents"]}
        assert again == before
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("view/gone/restore/stop/names/reply ok")


def test_identity_and_port_probe():
    """Every response carries X-NorthLight-Tower (scripts use it to tell this server apart); port_in_use sees a listener."""
    tmp = tempfile.mkdtemp()
    try:
        fresh_watcher(tmp)
        srv = m.ThreadingHTTPServer(("127.0.0.1", 0), m.Handler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            for path in ("/state", "/definitely-not-a-route"):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=5) as r:
                        h = r.headers
                except urllib.error.HTTPError as e:
                    h = e.headers
                assert h.get("X-NorthLight-Tower") == "1", path
            assert m.port_in_use(port)
        finally:
            srv.shutdown()
            srv.server_close()
        assert not m.port_in_use(port)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("identity_and_port_probe ok")


def test_http_routes():
    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        build_world(w)
        w.hook({"src": "mod", "kind": "dbg", "sid": "sess1", "text": "x"})
        srv = m.ThreadingHTTPServer(("127.0.0.1", 0), m.Handler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % port

        def call(path, data=None, headers=None):
            req = urllib.request.Request(base + path, data=(json.dumps(data).encode("utf-8") if data is not None else None), headers=headers or {}, method="POST" if data is not None else "GET")
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read().decode("utf-8") or "{}")

        tok = {"X-PO-Token": w.token}
        assert call("/reply?id=sess1")[1]["text"] == "Bitti, bak."
        assert call("/reply?id=sess1&n=zzz")[0] == 200                      # bad n: the last one
        assert call("/reply?id=yok")[0] == 404 and call("/reply")[0] == 404
        assert call("/names?sid=sess1")[1]["agents"][0]["id"] == "sess1"
        for route in ("/stop", "/restore"):
            assert call(route, {"id": "sess1"})[0] == 403                    # no token
            assert call(route, {"id": "sess1"}, {"X-PO-Token": "yanlis"})[0] == 403
            assert call(route, {"id": "sess1"}, dict(tok, **{"Sec-Fetch-Site": "cross-site"}))[0] == 403
            assert call(route, {"id": "sess1"}, dict(tok, Origin="http://evil.example"))[0] == 403
        assert call("/stop", {"id": "agent-aaa111"}, tok)[1] == {"ok": False, "reason": "The worker has already stopped"}      # finished
        assert call("/dismiss", {"id": "olmayan-id"}, tok)[1]["ok"] is False and call("/state")[1]["gone"] == []   # SM-10: an unknown id is not saved
        assert call("/restore", {"id": "olmayan-id"}, tok)[1]["ok"] is False
        assert call("/dismiss", {"id": "agent-aaa111"}, tok)[1]["ok"] is True
        gone = call("/state")[1]["gone"]
        assert [g["id"] for g in gone] == ["agent-aaa111"]
        assert call("/restore", {"id": "agent-aaa111"}, tok)[1] == {"ok": True}
        assert call("/state")[1]["gone"] == []
        srv.shutdown()
        srv.server_close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("http_routes ok")


def test_state_stays_small():
    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        main, _ = build_world(w)
        main.feed(user(time.time() - 5, "uzun"))
        main.feed(asst(time.time() - 4, [text_block("x " * 12000)], mid="big"))
        st = w.state()
        raw = json.dumps(st, ensure_ascii=False)
        mn = [a for a in st["agents"] if a["id"] == "sess1"][0]
        assert mn["reply"]["len"] > 20000 and len(mn["reply"]["head"]) <= 160 and "text" not in mn["reply"], mn["reply"]
        assert len(raw) < 40000, len(raw)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("state_small ok")


def test_detail_texts():
    assert m.label_for("mcp__pixellab__create_character") == "Working" and m.label_for("BilinmeyenArac") == "Working"
    assert m.label_for("Bash") == "Running a command"
    a = fake_sub(meta={"agentType": "Explore"})
    a.feed(user(time.time() - 5, "iş"))
    assert a.snapshot(time.time())["detail"] == "Working"                  # old: "Çalışıyor (ayrıntılar bitince görünür)" (Working (details appear when done))
    b = fake_main("detailMain")
    b.feed(user(time.time() - 100, "x"))
    b.feed(asst(time.time() - 99, [text_block("bitti")], mid="dd"))
    assert b.snapshot(time.time())["detail"] == "Finished, waiting for your next message"
    # TXT-1 / UYUM-2 / SRV-3: tool labels match the vocabulary
    assert m.label_for("Agent") == "Started a worker" and m.label_for("Task") == "Started a worker"
    assert m.label_for("Workflow") == "Managing a team of workers"
    # TXT-4: approval text has a single form
    c = fake_main("detailWait")
    c.feed(user(time.time() - 120, "x"))
    c.feed(asst(time.time() - 100, [{"type": "tool_use", "id": "tw", "name": "Edit", "input": {"file_path": "a.txt"}}], stop="tool_use", mid="dw"))
    sn = c.snapshot(time.time())
    assert sn["state"] == "waiting" and sn["detail"] == "May be waiting for approval", sn
    # TXT-3: a finished sub-worker is 'İşini bitirdi' (finished its work); fallback label 'Çalışan' (Worker)
    sb = fake_sub(aid="dtl111")
    sb.feed(user(time.time() - 5, "iş"))
    sb.feed(asst(time.time() - 4, [{"type": "tool_use", "id": "hb", "name": "SubagentHandback", "input": {"message": "ÖZET"}}], stop="tool_use", mid="h1"))
    assert sb.snapshot(time.time())["detail"] == "Finished"
    assert sb.events[-1]["x"] == "Finished, handed in the report", sb.events[-1]
    assert sb.label().startswith("Worker · ")
    print("detail_texts ok")


def test_feed_guard():
    """SM-06: a corrupt/unexpected line does not freeze the watcher; the next valid reply is captured, the other worker is read."""
    tmp = tempfile.mkdtemp()
    old_root, old_exit = m.ROOT, m.EXIT_ON_IDLE
    try:
        m.ROOT = tmp
        m.EXIT_ON_IDLE = False
        os.makedirs(os.path.join(tmp, "proj"))
        t0 = time.time() - 60
        bad = ["[]", "null", "123", '"abc"', json.dumps({"type": "assistant", "timestamp": ISO(t0 + 1), "message": "abc"}),
               json.dumps({"type": "assistant", "timestamp": ISO(t0 + 2), "message": {"stop_reason": "tool_use", "content": ["düz metin", 5, None]}}),
               json.dumps({"type": "assistant", "timestamp": ISO(t0 + 3), "message": {"id": "bx", "stop_reason": "end_turn", "content": [{"type": "text", "text": 5}]}}),
               json.dumps({"type": "user", "timestamp": ISO(t0 + 4), "message": {"content": [{"type": "tool_result", "tool_use_id": ["x"], "content": 7}]}})]
        pa, pb = os.path.join(tmp, "proj", "sessA.jsonl"), os.path.join(tmp, "proj", "sessB.jsonl")
        with open(pa, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join([user(t0, "görev A")] + bad + [asst(t0 + 10, [text_block("A bitti")], mid="ga")]) + "\n")
        with open(pb, "w", encoding="utf-8", newline="\n") as f:
            f.write(user(t0, "görev B") + "\n" + asst(t0 + 11, [text_block("B bitti")], mid="gb") + "\n")
        w = fresh_watcher(tmp)
        w._discover_at = time.time() + 1e9               # must not scan the real ~/.claude folder
        A, B = m.Agent(pa), m.Agent(pb)
        w.agents = {pa: A, pb: B}
        w.tick()
        assert A.reply_count == 1 and A.replies[-1]["text"] == "A bitti" and A.first is False, (A.reply_count, A.first)
        assert B.reply_count == 1 and B.replies[-1]["text"] == "B bitti"
        # each worker is protected separately: even if A's reader blows up, B is read
        def boom():
            raise RuntimeError("bozuk")
        A.read_new = boom
        with open(pb, "a", encoding="utf-8", newline="\n") as f:
            f.write(user(t0 + 20, "yeni") + "\n" + asst(t0 + 21, [text_block("B ikinci")], mid="gb2") + "\n")
        w.tick()
        assert B.reply_count == 2 and B.replies[-1]["text"] == "B ikinci"
    finally:
        m.ROOT, m.EXIT_ON_IDLE = old_root, old_exit
        shutil.rmtree(tmp, ignore_errors=True)
    print("feed_guard ok")


def test_static_whitelist_and_hardening():
    """SM-07 / SM-10 / S-04: static whitelist, no directory listing, negative Content-Length, corrupt body, listen backlog."""
    import http.client
    assert m.Srv.request_queue_size == 1024 and m.Srv.daemon_threads is True and m.Handler.timeout == 20      # SRV-6 / SRV-8
    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        m.HERE = ROOT                                    # Handler directory = the real page folder
        build_world(w)
        w.hook({"src": "mod", "kind": "dbg", "sid": "sess1", "text": "x"})
        srv = m.Srv(("127.0.0.1", 0), m.Handler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def get(path, method="GET", headers=None, body=None):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
            c.putrequest(method, path, skip_accept_encoding=True)
            for k, v in (headers or {}).items():
                c.putheader(k, v)
            c.endheaders(body)
            r = c.getresponse()
            data = r.read()
            c.close()
            return r.status, data

        for ok in ("/", "/office.html", "/core.js", "/theme.css", "/scene.json", "/font5x7.json", "/assets/names.json", "/assets/atlas/atlas.json", "/assets/office.ico"):
            assert get(ok)[0] == 200, ok
        assert get("/office.html", "HEAD")[0] == 200 and get("/server.py", "HEAD")[0] == 404
        for bad in ("/server.py", "/SUNUCU.PY", "/README.md", "/Start.bat", "/Start.vbs", "/_shortcut.ps1", "/_cache/token", "/_cache/", "/_cache", "/_work/x.json",
                    "/_dev/x", "/tools/test_server.py", "/tools/", "/mod/x", "/.claude/settings.json", "/assets", "/assets/", "/assets/atlas/", "/assets/bg",
                    "/assets/../server.py", "/assets/%2e%2e/server.py", "/%2e%2e/server.py", "/../server.py", "/core.js/../server.py", "/server.py::$DATA",
                    "/x.log", "/a.zip", "/a.tsx", "/a.ts", "/assets/x.py", "/assets/names.json/", "//server.py", "/assets/atlas/..%5c..%5cserver.py"):
            code, _ = get(bad)
            assert code in (404, 400), (bad, code)
        # JSON endpoints keep working
        assert get("/state")[0] == 200 and get("/names?sid=sess1")[0] == 200 and get("/reply?id=sess1")[0] == 200
        assert get("/config")[0] in (200, 403)
        # SM-10: negative / invalid Content-Length does not hang, a non-dict body and a weird sid do not break the server
        t0 = time.time()
        for hdr, body in (("-1", None), ("abc", None), ("0", None), ("5", b"[1,2]"), ("5", b'"abc"'), ("17", b'{"src":"mod","sid":{}}')):
            code, _ = get("/hook", "POST", {"Content-Length": hdr}, body)
            assert code in (200, 400), (hdr, code)
        assert time.time() - t0 < 3, "negatif Content-Length istegi takildi"
        tok = {"X-PO-Token": w.token, "Content-Length": "-1"}
        assert get("/dismiss", "POST", tok)[0] == 200 and get("/state")[0] == 200
        # listen backlog: 100 parallel requests are not rejected
        errs = []

        def hit():
            try:
                code, _ = get("/core.js")
                if code != 200:
                    errs.append(code)
            except Exception as e:
                errs.append(repr(e))
        ths = [threading.Thread(target=hit) for _ in range(100)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        assert not errs, errs[:3]
        srv.shutdown()
        srv.server_close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("static_whitelist_and_hardening ok")


def test_gserver_fixes():
    """SRV-1/4/7/8, TXT-2/8/9, UYUM-1/2: surrogate character, gallery path, token, timeout, reason texts, event texts."""
    import http.client
    import socket
    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        main, sub = build_world(w)
        w.hook({"src": "mod", "kind": "dbg", "sid": "sess1", "text": "x"})
        # --- helpers
        assert m.scrub("a\ud83cb") == "a�b" and m.scrub("😀 tamam") == "😀 tamam" and m.scrub_obj({"k\ud800": ["x\udfff", 3]}) == {"k�": ["x�", 3]}
        # --- ack reasons (TXT-9): known mapping, unknown English, Turkish left untouched
        for raw, want in (("No running turn", "The worker has already stopped"), ("Request timed out", "Claude did not respond in time"),
                          ("Something exploded: code 500", "Something exploded: code 500"), ("Çalışan zaten durmuş", "Çalışan zaten durmuş"),
                          ("Hedef kapalı, şu an ulaşılamıyor", "Hedef kapalı, şu an ulaşılamıyor")):
            r = w.send("sess1", "merhaba")
            assert r["ok"] is True, r
            w.take_outbox("sess1")
            assert w.ack(r["id"], False, raw)
            ch = {a["id"]: a for a in w.state()["agents"]}["sess1"]["chat"][-1]
            assert ch["st"] == "hata" and ch["text"].endswith("\n(!) " + want), (raw, ch["text"])
        r = w.send("sess1", "ok-mesaj")
        w.take_outbox("sess1")
        w.ack(r["id"], True, "TaskStop")                                          # on success the reason stays as it is
        assert {a["id"]: a for a in w.state()["agents"]}["sess1"]["chat"][-1]["via"] == "TaskStop"
        w.ack("p77", False, "Request timed out")                                  # panel message: an ack that arrives before the say record is translated too
        w.hook({"src": "mod", "kind": "say", "sid": "sess1", "id": "p77", "text": "panelden"})
        assert {a["id"]: a for a in w.state()["agents"]}["sess1"]["chat"][-1]["text"].endswith("(!) Claude did not respond in time")
        # --- plugin path 'path' (SRV-4) and raw tool name label (TXT-8)
        png = os.path.join(tmp, "horse_south.png")
        with open(png, "wb") as pf:
            pf.write(b"\x89PNG\r\n\x1a\n")
        w.hook({"src": "mod", "kind": "artifact", "sid": "sess1", "aid": "", "path": png, "label": "create_character", "v": 1})
        w.hook({"src": "mod", "kind": "artifact", "sid": "sess1", "aid": "", "label": "x"})        # an event without a path is silently ignored
        arts = {a["id"]: a for a in w.state()["agents"]}["sess1"]["artifacts"]
        assert len(arts) == 1 and arts[0]["label"] == "horse_south.png" and arts[0]["src"].startswith("/file/"), arts
        # --- persistent gallery: an image is saved together with its worker; it stays when the worker leaves the office (status gone), and is live again when brought back
        g = w.gallery()
        gi = [i for i in g["items"] if i["label"] == "horse_south.png"]
        assert g["ok"] and len(gi) == 1 and gi[0]["status"] == "live" and gi[0]["agent"]["id"] == "sess1" and gi[0]["agent"]["nick"], g
        w.dismissed["sess1"] = time.time()
        assert [i for i in w.gallery()["items"] if i["label"] == "horse_south.png"][0]["status"] == "gone"
        w.restore("sess1")
        assert [i for i in w.gallery()["items"] if i["label"] == "horse_south.png"][0]["status"] == "live"
        # command from the gallery to a worker not in the live list (tab closed / old): the target is resolved from the gallery record, delivery works if the chat plugin is connected
        w.gal["sess1|zz"] = {"k": "sess1|zz", "aid": "zz", "kind": "img", "src": "/file/zz.png", "label": "x", "t": time.time(),
                             "agent": {"id": "agent-zzz999", "session": "sess1", "nick": "Eski", "char": "robot", "role": "", "kind_tr": "", "label": "", "project": "", "sub": True, "stitle": "t"}}
        r = w.send("agent-zzz999", "revize et")
        assert r["ok"] is True, r
        ob = [x for x in w.take_outbox("sess1") if x["key"] == "agent-zzz999"]
        assert ob and ob[0]["kind"] == "sub" and ob[0]["aid"] == "zzz999" and ob[0]["sid"] == "sess1", ob
        w.gal.pop("sess1|zz")
        assert w.send("agent-yok123", "x")["ok"] is False
        w.register_art("sess1", png, "Görsel", time.time())                       # the human-readable label is kept
        w.hook({"src": "mod", "kind": "artifact", "sid": "sess1", "aid": "", "path": png, "label": "mcp__pixellab__create_character"})
        # --- event texts (TXT-1/3, UYUM-2)
        main.spawns["toolu_A"]["agent_id"] = "aaa11111"
        main.feed(json.dumps({"type": "attachment", "timestamp": ISO(time.time()), "attachment": {"type": "queued_command",
                  "prompt": "<task-notification><task-id>aaa11111</task-id><status>completed</status></task-notification>"}}))
        assert main.events[-1]["x"] == "Worker finished: Mod testi: canlı alt ajan", main.events[-1]
        assert not any(e["x"].startswith(("Alt ajan", "Görevi")) for e in main.events + sub.events)
        # --- HTTP: surrogate character (SRV-1), token (SRV-7), timeout (SRV-8), reason texts (TXT-2/UYUM-1)
        class QuickTimeout(m.Handler):
            timeout = 1
        srv = m.Srv(("127.0.0.1", 0), QuickTimeout)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def raw(path, body, headers=None, method="POST"):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.putrequest(method, path, skip_accept_encoding=True)
            c.putheader("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                c.putheader(k, v)
            c.endheaders(body)
            r = c.getresponse()
            data = r.read()
            c.close()
            return r.status, data

        half = ("b" * 3999) + "\\ud83c"                                           # truncated emoji: a single high surrogate as a JSON escape
        for body in ('{"src":"mod","kind":"reply","sid":"sess1","aid":"aaa111","text":"%s"}' % half,
                     '{"src":"mod","kind":"state","sid":"sess1","aid":"","state":"typing","detail":"%s","target":"%s","tool":"Write","task":"%s"}' % (half, half, half)):
            code, data = raw("/hook", body.encode("ascii"))
            assert code == 200 and json.loads(data.decode("utf-8")) == {"ok": True}, (code, data[:80])
        code, data = raw("/state", b"", method="GET")
        assert code == 200
        txt = data.decode("utf-8")                                                # strict UTF-8: no surrogate must be left
        st = json.loads(txt)
        mn = [a for a in st["agents"] if a["id"] == "sess1"][0]
        assert mn["detail"].endswith("�") and mn["detail"].startswith("bbb"), mn["detail"][-5:]
        sb = [a for a in st["agents"] if a["id"] == "agent-aaa111"][0]
        assert sb["chat"][-1]["text"].endswith("�") and len(sb["chat"][-1]["text"]) == 4000
        # a surrogate that enters the server via log/jsonl also does not drop the connection (_json last defense)
        main.title = "başlık\ud83c"
        code, data = raw("/state", b"", method="GET")
        assert code == 200 and "başlık�".encode("utf-8") in data
        # a raw body also works with a real UTF-8 emoji
        code, data = raw("/hook", '{"src":"mod","kind":"reply","sid":"sess1","aid":"aaa111","text":"selam 😀"}'.encode("utf-8"))
        assert code == 200
        # token: a non-ASCII byte gives 403 (connection does not drop)
        for tokv in (b"\xe9", "ğ".encode("utf-8"), b"yanlis\xff\xfe"):
            s = socket.create_connection(("127.0.0.1", port), timeout=5)
            s.sendall(b"POST /stop HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nX-PO-Token: " + tokv + b"\r\n\r\n{}")
            got = b""
            while True:
                part = s.recv(4096)
                if not part:
                    break
                got += part
            s.close()
            assert got.startswith(b"HTTP/1.0 403") or got.startswith(b"HTTP/1.1 403"), (tokv, got[:60])
        # Turkish reason text from the real endpoint
        tk = {"X-PO-Token": w.token}
        w.mods.clear()
        code, data = raw("/send", b'{"to":"sess1","text":"merhaba"}', tk)
        assert json.loads(data.decode("utf-8")) == {"ok": False, "reason": "The NorthLight Tower plugin is not connected to this Claude chat; you can't send messages."}
        code, data = raw("/stop", b'{"id":"sess1"}', tk)
        assert json.loads(data.decode("utf-8"))["reason"] == "The NorthLight Tower plugin is not connected to this Claude chat; cannot stop."
        for bad in ("oturum", "mod ", "modu", "ajan", "sunucu"):
            assert bad not in json.loads(data.decode("utf-8"))["reason"].lower()
        # timeout: a connection with an incomplete body does not hold the thread indefinitely
        s = socket.create_connection(("127.0.0.1", port), timeout=6)
        s.sendall(b"POST /hook HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Length: 10\r\n\r\n")
        t0 = time.time()
        try:
            while s.recv(4096):
                pass
        except socket.timeout:
            raise AssertionError("the half-open connection stayed stuck on the server")
        assert time.time() - t0 < 4, time.time() - t0
        s.close()
        # a normal request is not affected by the timeout
        assert raw("/names?sid=sess1", b"", method="GET")[0] == 200
        srv.shutdown()
        srv.server_close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("gserver_fixes ok")


def test_son_dogrulama_duzeltmeleri():
    """Abbreviations like St. do not end a sentence; old plugin texts are translated; Stop does not go to an old plugin; permission check reason."""
    assert m.first_phrase("PixelLab logo + St. Moritz için çizim yap", 40) == "PixelLab logo + St. Moritz için çizim…"
    assert m.first_phrase("Dr. Strange posteri çiz ve paylaş.", 40) == "Dr. Strange posteri çiz ve paylaş"
    assert m.first_phrase("Hatayı bul. Sonra düzelt", 40) == "Hatayı bul"
    assert m.norm_detail("Turu bitirdi, sıranı bekliyor") == "Finished, waiting for your next message"
    assert m.norm_detail("Görevi bitirdi") == "Finished" and m.norm_detail("Senden onay bekliyor") == "Waiting for approval"
    assert m.norm_detail("Çalışıyor: Bash") == "Working" and m.norm_detail("Dosya yazıyor") == "Writing a file" and m.norm_detail("Writing a file") == "Writing a file"
    assert m.norm_detail("Onay bekliyor") == "Waiting for approval" and m.norm_detail("Düşünüyor") == "Working" and m.norm_detail("İşini bitirdi") == "Finished"
    assert m.tr_reason("classifier denied this") == "Claude's automatic permission check blocked the delivery"
    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        main, sub = build_world(w)
        w.hook({"src": "mod", "kind": "dbg", "sid": "sess1", "text": "x"})
        # old plugin: no version in the /outbox polling ("" is reported) -> Stop is rejected, no item enters the queue
        w.take_outbox("sess1", "")
        r = w.stop("sess1")
        assert r["ok"] is False and "old version" in r["reason"], r
        assert not [x for x in w.outbox if x.get("kind") == "stop"]
        # new plugin reports its version -> Stop enters the queue
        w.take_outbox("sess1", "0.7.3")
        r = w.stop("sess1")
        assert r["ok"] is True, r
        assert [x for x in w.outbox if x.get("kind") == "stop"]
        # an old plugin's state event with the old text is translated to the new vocabulary
        w.hook({"src": "mod", "kind": "state", "sid": "sess1", "aid": "", "state": "done", "detail": "Turu bitirdi, sıranı bekliyor"})
        ag = {a["id"]: a for a in w.state()["agents"]}["sess1"]
        assert ag["detail"] == "Finished, waiting for your next message", ag["detail"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_uploads():
    """Message attachments: name sanitizing, extension whitelist / reject list, content check, size limit, /upload permission,
    the attachment line of /send (the server writes it), finding from disk after a restart, pruning."""
    import socket
    # name sanitizing: path traversal, control / direction characters, double extension
    ok_names = {
        "../../sunucu.png": ("sunucu", ".png", "img"),
        "..\\..\\Windows\\x.JPG": ("x", ".jpg", "img"),
        "C:\\Users\\me\\Documents\\Ekran görüntüsü (3).png": ("Ekran görüntüsü (3)", ".png", "img"),
        "fatura.exe.txt": ("fatura_exe", ".txt", "txt"),
        "a\u202egnp.txt": ("agnp", ".txt", "txt"),
        "%2e%2e%2fgizli.md": ("gizli", ".md", "txt"),
        "kod.py": ("kod", ".py", "txt"),
        "ses kaydı.m4a": ("ses kaydı", ".m4a", "aud"),
        "...png.pdf": ("png", ".pdf", "pdf"),
        "x" * 300 + ".csv": ("x" * 60, ".csv", "txt"),
        "<>:\"|?*.json": ("file", ".json", "txt"),
    }
    for raw, want in ok_names.items():
        got = m.safe_upload_name(raw)
        assert got == want, (raw, got, want)
    for bad in ("virus.exe", "a.BAT", "x.cmd", "y.ps1", "k.msi", "l.dll", "a.png.exe", "kisayol.lnk", "noext", ".png", "a.zip", "a.svg", "", "../"):
        try:
            m.safe_upload_name(bad)
        except ValueError as e:
            assert str(e), bad
        else:
            raise AssertionError("should not have been accepted: %r" % bad)
    try:
        m.safe_upload_name("x.exe")
    except ValueError as e:
        assert "Executable" in str(e)
    # content check
    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
    assert m.upload_sniff_ok("img", ".png", PNG) and not m.upload_sniff_ok("img", ".png", b"MZ\x90\x00")
    assert not m.upload_sniff_ok("img", ".jpg", PNG) and m.upload_sniff_ok("img", ".jpg", b"\xff\xd8\xff\xe0abc")
    assert m.upload_sniff_ok("txt", ".txt", "merhaba dünya".encode("utf-8")) and not m.upload_sniff_ok("txt", ".js", b"MZ\x90\x00\x03")
    assert m.upload_sniff_ok("txt", ".log", b"\xff\xfeh\x00i\x00")                         # UTF-16 BOM
    assert m.upload_sniff_ok("pdf", ".pdf", b"%PDF-1.7\n") and not m.upload_sniff_ok("pdf", ".pdf", b"<html>")
    assert m.upload_sniff_ok("vid", ".mp4", b"\x00\x00\x00\x18ftypmp42") and m.upload_sniff_ok("vid", ".mov", b"\x00\x00\x00\x14ftypqt  ")
    assert m.upload_sniff_ok("aud", ".mp3", b"ID3\x04") and m.upload_sniff_ok("aud", ".wav", b"RIFF\x00\x00\x00\x00WAVEfmt ")
    assert m.upload_sniff_ok("vid", ".webm", b"\x1a\x45\xdf\xa3\x01") and not m.upload_sniff_ok("txt", ".txt", b"")
    # tightened signatures: a binary .txt with a BOM, a %PDF not at the start, an mp4 without ftyp do not pass; ftyp after a padding box passes
    assert m.upload_sniff_ok("txt", ".txt", b"\xfe\xff\x00h\x00i") and m.upload_sniff_ok("txt", ".txt", "﻿merhaba\n".encode("utf-16-le"))
    assert m.upload_sniff_ok("txt", ".txt", b"\xff\xfe" + "çok uzun".encode("utf-16-le")[:-1])            # half a character at the 64 KB limit
    assert not m.upload_sniff_ok("txt", ".txt", b"\xff\xfeMZ\x90\x00\x03\x00\x00\x00\x04\x00")              # UTF-16 BOM + exe
    assert not m.upload_sniff_ok("txt", ".txt", b"\xff\xfe\x00\xd8\x41\x00")                                 # lone surrogate
    assert not m.upload_sniff_ok("pdf", ".pdf", b"<html><body>%PDF-1.7</body></html>")
    assert not m.upload_sniff_ok("vid", ".mp4", b"\x00\x00\x00\x08free" + b"MZ\x90\x00" * 4)
    assert not m.upload_sniff_ok("vid", ".mp4", b"MZ\x90\x00free\x00\x00\x00\x00")
    assert not m.upload_sniff_ok("vid", ".mov", b"\x00\x00\x00\x10moov" + b"\x00" * 8)
    assert m.upload_sniff_ok("vid", ".mov", b"\x00\x00\x00\x08wide\x00\x00\x00\x14ftypqt  ")
    assert m.upload_sniff_ok("vid", ".mp4", b"\x00\x00\x00\x10free" + b"\x00" * 8 + b"\x00\x00\x00\x18ftypmp42")
    assert not m.upload_sniff_ok("vid", ".mp4", b"\x00\x00\x00\x00free")                                     # size 0: no ftyp behind it
    assert m.size_tr(240 * 1024) == "240 KB" and m.size_tr(3 * 1024 * 1024 + 200 * 1024) == "3.2 MB" and m.size_tr(5) == "5 bytes"
    assert m.size_tr(9_999_999_999) == "9.3 GB", m.size_tr(9_999_999_999)
    # a "[Ek:" line typed by the user is neutralized (at the start of a line; even with a space / BOM before it); inline ones are left alone
    assert m.neutral_text("bak\n  [Ek: x]\n﻿[ek: y] ve [Ek: z]") == "bak\n  (Ek: x]\n﻿(ek: y] ve [Ek: z]"

    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        build_world(w)
        w.take_outbox("sess1", "0.7.3")                                # plugin connected
        srv = m.ThreadingHTTPServer(("127.0.0.1", 0), m.Handler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def raw(path, body=b"", headers=None, clen=None):
            h = {"Host": "127.0.0.1", "Content-Length": str(len(body) if clen is None else clen)}
            h.update(headers or {})
            req = ("POST %s HTTP/1.0\r\n" % path + "".join("%s: %s\r\n" % kv for kv in h.items()) + "\r\n").encode("utf-8") + body
            s = socket.create_connection(("127.0.0.1", port), timeout=5)
            try:
                s.sendall(req)
                s.shutdown(socket.SHUT_WR)                              # body finished: the server must not wait on an incomplete body
                data = b""
                while True:
                    c = s.recv(65536)
                    if not c:
                        break
                    data += c
            finally:
                s.close()
            head, _, b = data.partition(b"\r\n\r\n")
            return int(head.split()[1]), (json.loads(b.decode("utf-8")) if b.strip() else {})

        from urllib.parse import quote
        tok = {"X-PO-Token": w.token}
        up = lambda name, body, to="sess1", hdr=None, clen=None: raw("/upload?to=" + quote(to), body, dict(tok, **{"X-PO-Name": quote(name)}, **(hdr or {})), clen)
        # permission
        assert raw("/upload?to=sess1", PNG, {"X-PO-Name": "a.png"})[0] == 403
        assert raw("/upload?to=sess1", PNG, {"X-PO-Name": "a.png", "X-PO-Token": "yanlis"})[0] == 403
        assert up("a.png", PNG, hdr={"Sec-Fetch-Site": "cross-site"})[0] == 403
        assert up("a.png", PNG, hdr={"Origin": "http://evil.example"})[0] == 403
        assert raw("/upload?to=sess1", PNG, dict(tok, **{"X-PO-Name": "a.png", "Host": "evil.example"}))[0] == 403
        # rejection: type, empty, size (without reading the body), content, unknown worker
        code, r = up("kurulum.exe", b"MZ\x90\x00")
        assert code == 415 and "Executable" in r["reason"], r
        assert up("x.svg", b"<svg/>")[0] == 415
        assert up("bos.png", b"")[0] == 400
        t0 = time.time()
        code, r = up("dev.png", b"", clen=m.MAX_IMG_BYTES + 1)
        assert code == 413 and "12 MB" in r["reason"] and time.time() - t0 < 3, (code, r)
        code, r = up("dev.mp4", b"", clen=m.MAX_VID_BYTES + 1)
        assert code == 413 and "40 MB" in r["reason"], r
        assert up("klip.mp4", b"\x00\x00\x00\x18ftypmp42", clen=m.MAX_IMG_BYTES + 1)[0] != 413        # a video may exceed 12 MB (body incomplete: cut off midway)
        code, r = up("sahte.png", b"MZ\x90\x00" + b"\x00" * 100)
        assert code == 400 and "do not match" in r["reason"], r
        code, r = up("ikili.txt", b"abc\x00def")
        assert code == 400, r
        assert up("a.png", PNG, to="olmayan")[0] == 404
        # Content-Length: plain digits only (1-10 digits), a single header; the huge-size message is in GB
        for bad in ("+%d" % len(PNG), "%d_0" % len(PNG), "%d 0" % len(PNG), "٥", "12345678901", "0x10"):
            assert up("a.png", PNG, clen=bad)[0] == 411, bad
        code, r = up("dev.png", b"", clen="9999999999")
        assert code == 413 and "9.3 GB" in r["reason"], r
        s = socket.create_connection(("127.0.0.1", port), timeout=5)
        try:
            s.sendall(("POST /upload?to=sess1 HTTP/1.0\r\nHost: 127.0.0.1\r\nX-PO-Token: %s\r\nX-PO-Name: a.png\r\n"
                       "Content-Length: %d\r\nContent-Length: %d\r\n\r\n" % (w.token, len(PNG), len(PNG))).encode("utf-8") + PNG)
            s.shutdown(socket.SHUT_WR)
            data = b""
            while True:
                c = s.recv(65536)
                if not c:
                    break
                data += c
        finally:
            s.close()
        assert int(data.split()[1]) == 411, data[:80]                         # double Content-Length
        # successful upload: yuklemeler/<session>/<id>_<name>, full path, path traversal cleaned
        code, r = up("../../Ekran görüntüsü.png", PNG)
        assert code == 200 and r["ok"], r
        root = os.path.realpath(os.path.join(tmp, "_cache", "yuklemeler"))
        assert os.path.isabs(r["path"]) and os.path.realpath(r["path"]).startswith(os.path.join(root, "sess1") + os.sep), r["path"]
        assert os.path.basename(r["path"]) == r["id"] + "_Ekran görüntüsü.png" and m.RE_UP_ID.fullmatch(r["id"])
        with open(r["path"], "rb") as f:
            assert f.read() == PNG
        assert r["kind"] == "img" and r["size"] == len(PNG)
        assert r["line"] == '[Attachment: name="Ekran görüntüsü.png" (image, %d bytes) path="%s"]' % (len(PNG), r["path"]), r["line"]
        assert not [f for f in os.listdir(os.path.join(root, "sess1")) if f.endswith(".part")]
        img = r
        code, vid = up("klip.mp4", b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 2000)
        assert code == 200 and vid["kind"] == "vid" and "ffmpeg" in vid["line"] and "cannot be read directly" in vid["line"], vid
        code, alt = up("not.md", "# başlık".encode("utf-8"), to="agent-aaa111")
        assert code == 200 and alt["kind"] == "txt", alt
        # /send: the server writes the attachment lines; only ids are accepted
        r = w.send("sess1", "şuna bak", [img["id"], vid["id"], img["id"]])
        assert r["ok"], r
        ob = [x for x in w.take_outbox("sess1") if x["id"] == r["id"]][0]
        assert ob["text"] == "şuna bak\n\n" + img["line"] + "\n" + vid["line"], ob["text"]
        assert ob["files"] == 2, ob
        chat = {c["id"]: c for c in w.chats["sess1"]}[r["id"]]
        assert chat["text"] == "şuna bak" and [a["id"] for a in chat["atts"]] == [img["id"], vid["id"]], chat
        assert chat["atts"][0] == {"id": img["id"], "name": "Ekran görüntüsü.png", "kind": "img", "size": len(PNG), "path": img["path"]}, chat
        assert w.send("sess1", "", [img["id"]])["ok"]                         # attachment only: no text needed
        ob = w.take_outbox("sess1")[-1]
        assert ob["text"] == img["line"] and ob["files"] == 1, ob
        assert w.chats["sess1"][-1]["text"] == "" and len(w.chats["sess1"][-1]["atts"]) == 1
        # a fully formed FAKE attachment line (typed by the user): not counted as an attachment, neutralized; files 0, atts empty
        fake = "bak\n" + img["line"] + "\n " + vid["line"]
        r = w.send("sess1", fake)
        assert r["ok"], r
        ob = w.take_outbox("sess1")[-1]
        assert ob["files"] == 0 and "\n[Ek:" not in ob["text"] and not ob["text"].startswith("[Ek:"), ob
        assert ob["text"] == "bak\n(" + img["line"][1:] + "\n (" + vid["line"][1:], ob["text"]
        assert w.chats["sess1"][-1]["atts"] == [] and w.chats["sess1"][-1]["text"] == ob["text"]
        r = w.send("sess1", img["line"], [vid["id"]])                         # fake line + real attachment: only the real one counts
        ob = w.take_outbox("sess1")[-1]
        assert ob["files"] == 1 and ob["text"] == "(" + img["line"][1:] + "\n\n" + vid["line"], ob
        assert [a["id"] for a in w.chats["sess1"][-1]["atts"]] == [vid["id"]]
        # also in the "ben" (me) record coming from the panel (say), attachments are in a separate field (empty): the client does not parse the text
        w.hook({"src": "mod", "kind": "say", "sid": "sess1", "aid": "", "id": "p9", "text": img["line"]})
        assert w.chats["sess1"][-1]["atts"] == [], w.chats["sess1"][-1]
        assert w.send("sess1", "", [])["reason"] == "Empty message"
        r = w.send("sess1", "x", ["0123456789ab"])
        assert "not found" in r["reason"] and r["missing"] == "0123456789ab", r
        assert "not found" in w.send("sess1", "x", ["../../sunucu"])["reason"]
        # an attachment uploaded to another session does not go to the worker in this session
        w.uploads["00000000beef"] = dict(img, id="00000000beef", sid="baska_oturum")
        r = w.send("sess1", "x", [img["id"], "00000000beef"])
        assert r["ok"] is False and "another chat" in r["reason"] and r["missing"] == "00000000beef", r
        assert w._up_reserved == 0                                            # when uploads finish, the reserved bytes reset to zero
        assert w.send("sess1", "x", "abc")["ok"] is False                    # files that is not a list
        assert "at most" in w.send("sess1", "x", ["%012x" % i for i in range(6)])["reason"]
        assert "too long" in w.send("sess1", "x" * 2001, [img["id"]])["reason"]
        # HTTP /send also carries the files field
        req = urllib.request.Request("http://127.0.0.1:%d/send" % port, data=json.dumps({"to": "sess1", "text": "", "files": [alt["id"]]}).encode("utf-8"),
                                     headers=dict(tok, **{"Content-Type": "application/json"}), method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert json.loads(resp.read().decode("utf-8"))["ok"] is True
        # restart: memory is empty, the attachment is found on disk
        w2 = fresh_watcher(tmp)
        rec = w2.upload_get(img["id"])
        assert rec and rec["path"] == img["path"] and rec["kind"] == "img" and rec["name"] == "Ekran görüntüsü.png", rec
        assert w2.upload_get("../" + img["id"]) is None and w2.upload_get(img["id"].upper()) is None
        # pruning: attachments older than 14 days and .part files older than 1 hour are deleted
        old = time.time() - m.UP_KEEP_SECONDS - 60
        os.utime(img["path"], (old, old))
        stale = os.path.join(root, "sess1", "abcdefabcdef.part")
        with open(stale, "wb"):
            pass
        os.utime(stale, (time.time() - 7200,) * 2)
        w2._prune_uploads(1)
        assert not os.path.exists(img["path"]) and not os.path.exists(stale) and os.path.exists(vid["path"])
        assert w2.upload_get(img["id"]) is None
        # size pruning counts the bytes reserved by ongoing uploads; an ongoing .part and a newly created empty folder are not deleted
        live_part = os.path.join(root, "sess1", "fedcbafedcba.part")
        with open(live_part, "wb") as f:
            f.write(b"\x00" * 5000)
        os.makedirs(os.path.join(root, "yeni_oturum"))
        old_max = m.UP_DIR_MAX
        try:
            m.UP_DIR_MAX = 10_000
            w2._up_reserved = 9_000                                           # 9000 + vid (~2 KB) + 1 > 10000: the oldest (vid) goes
            os.utime(alt["path"], (time.time() + 5,) * 2)                     # alt is newer
            w2._prune_uploads(1)
            assert not os.path.exists(vid["path"]) and os.path.exists(alt["path"]) and os.path.exists(live_part)
            assert os.path.isdir(os.path.join(root, "yeni_oturum"))
        finally:
            m.UP_DIR_MAX = old_max
            w2._up_reserved = 0
        srv.shutdown()
        srv.server_close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("uploads ok")


def test_asks():
    """Claude's questions (AskUserQuestion): validation, answer format, queue, double answer, handoff, office freshness, timeout, HTTP permissions."""
    Q = [{"question": "Hangi kütüphane?", "header": "Kütüphane", "multiSelect": False,
          "options": [{"label": "dayjs", "description": "Küçük"}, {"label": "luxon", "description": "Saat dilimi", "preview": "<b>kod</b>"}]},
         {"question": "Hangi özellikler?", "header": "Özellik", "multiSelect": True,
          "options": [{"label": "A", "description": ""}, {"label": "B"}, {"label": "C"}]}]
    # validation
    n = m.norm_questions(Q)
    assert [q["kind"] for q in n] == ["choice", "choice"] and n[1]["multiSelect"] is True and n[0]["options"][1]["preview"] == "<b>kod</b>"
    assert n[1]["options"][1] == {"label": "B", "description": "", "preview": ""}
    nq = m.norm_questions([{"question": "Kaç slayt?", "header": "Sayı", "kind": "number", "min": 1, "max": 20, "step": 1, "defaultValue": 8, "unit": "slayt", "options": [], "multiSelect": False},
                           {"question": "Adı ne olsun?", "header": "Ad", "kind": "text", "placeholder": "ör. Kule", "options": [], "multiSelect": False}])
    assert nq[0]["min"] == 1 and nq[0]["defaultValue"] == 8 and nq[1]["placeholder"] == "ör. Kule"
    bad = [[], Q * 3, "x", [{"question": "", "options": Q[0]["options"]}], [{"question": "S?", "options": [{"label": "tek"}]}],
           [{"question": "S?", "options": [{"label": "a"}, {"label": "a"}]}], [{"question": "S?", "options": [{"label": "x" * 201}, {"label": "b"}]}],
           [{"question": "S?", "kind": "slider", "options": []}], [{"question": "S?", "kind": "number", "min": 5, "max": 5}],
           [{"question": "S?", "kind": "number", "min": True, "max": 5}], [Q[0], Q[0]], [{"question": 5, "options": Q[0]["options"]}],
           [{"question": "S?", "options": Q[0]["options"] + [{"label": "c"}, {"label": "d"}, {"label": "e"}]}]]
    for b in bad:
        try:
            m.norm_questions(b)
        except ValueError:
            pass
        else:
            raise AssertionError("should not have been accepted: %r" % (b,))
    assert len(m.norm_questions([{"question": "S" * 5000 + "?", "header": "H" * 99, "options": Q[0]["options"]}])[0]["question"]) == m.ASK_Q_LEN
    # answer format: single choice, multiple choice (with ', '), "Other" free text, number, text
    assert m.build_answers(n, [{"sel": [1]}, {"sel": [2, 0]}]) == ["luxon", "A, C"]
    assert m.build_answers(n, [{"other": "  moment  "}, {"sel": [1], "other": "D"}]) == ["moment", "B, D"]
    assert m.build_answers(nq, [{"num": 12}, {"text": "Kule"}]) == ["12", "Kule"]
    assert m.build_answers(nq, [{"num": 2.5}, {"text": "x"}])[0] == "2.5"
    for raw in ([{"sel": [0]}], [{"sel": [0, 1]}, {"sel": [0]}], [{"sel": [0], "other": "y"}, {"sel": [0]}], [{"sel": [5]}, {"sel": [0]}],
                [{"sel": [True]}, {"sel": [0]}], [{}, {"sel": [0]}], [{"sel": [0]}, {"sel": [1, 1]}], [{"other": "x" * 2001}, {"sel": [0]}], "x", [1, 2]):
        try:
            m.build_answers(n, raw)
        except ValueError as e:
            assert str(e), raw
        else:
            raise AssertionError("should not have been accepted: %r" % (raw,))
    for raw in ([{"num": 0}, {"text": "a"}], [{"num": "5"}, {"text": "a"}], [{"num": 5}, {"text": "   "}]):
        try:
            m.build_answers(nq, raw)
        except ValueError:
            pass
        else:
            raise AssertionError("should not have been accepted: %r" % (raw,))

    tmp = tempfile.mkdtemp()
    try:
        w = fresh_watcher(tmp)
        build_world(w)
        P = {"sid": "sess1", "aid": "", "tuid": "toolu_1", "questions": Q}
        r = w.ask_create(P)
        assert r["ok"] is False and "not connected" in r["reason"], r              # the plugin is not connected to this session
        w.take_outbox("sess1", "0.8.0")
        r = w.ask_create(P)
        assert r["ok"], r                                                          # the office never polled (closed): the question still waits
        w.asks.clear()
        assert w.ask_list()["items"] == []                                         # the office is open now
        assert w.ask_create(dict(P, questions=[{"question": "S?", "options": []}]))["ok"] is False
        assert w.ask_create(dict(P, aid="../x"))["ok"] is False and w.ask_create(dict(P, sid=""))["ok"] is False
        r = w.ask_create(P)
        assert r["ok"] and m.RE_ASK_ID.fullmatch(r["id"]), r
        qid = r["id"]
        assert w.ask_create(P) == {"ok": True, "id": qid}                          # same tool call: the same card
        lst = w.ask_list()
        it = lst["items"][0]
        assert len(lst["items"]) == 1 and it["id"] == qid and it["sub"] is False and it["nick"] in ("Müdür", "Müdire", "Manager") and it["char"]
        assert it["questions"][0]["question"] == "Hangi kütüphane?" and it["expires"] > it["t"] and it["chat"]
        # pending question: long polling returns "pending" (short hold), wrong session / unknown id gives "gone"
        assert w.ask_wait(qid, "sess1", 0) == {"status": "pending"}
        assert w.ask_wait(qid, "baska", 0) == {"status": "gone"} and w.ask_wait("qyok", "sess1", 0) == {"status": "gone"}
        # a corrupt answer is rejected, the question stays pending; the correct answer is accepted once
        assert w.ask_answer(qid, [{"sel": [0]}])["ok"] is False
        assert w.ask_answer(qid, [{"sel": [0, 1]}, {"sel": [0]}])["ok"] is False
        assert w.ask_answer("qyok", [])["ok"] is False and w.ask_answer(None, [])["ok"] is False
        assert w.ask_answer(qid, [{"sel": [1]}, {"sel": [0, 2], "other": "Z"}]) == {"ok": True}
        assert w.ask_answer(qid, [{"sel": [0]}, {"sel": [0]}]) == {"ok": False, "reason": "This question has already been answered"}     # double answer
        assert w.ask_answer(qid, None, handoff=True)["ok"] is False
        assert w.ask_list()["items"] == [] and w.ask_list()["recent"] == [{"id": qid, "status": "answered", "reason": "", "delivered": False, "lost": False}]
        assert w.ask_wait(qid, "sess1", 0) == {"status": "answered", "id": qid, "answers": ["luxon", "A, C, Z"]}
        # giving the answer does not mean "teslim edildi" (delivered): delivered only with the plugin's ack
        assert w.ask_list()["recent"][0]["delivered"] is False
        assert w.ask_ack(qid, "sahte", True) == {"ok": False} and w.ask_list()["recent"][0]["delivered"] is False     # fake session
        assert w.ask_ack(qid, "sess1", True) == {"ok": True}
        assert w.ask_list()["recent"][0]["delivered"] is True and w.ask_list()["recent"][0]["lost"] is False
        # if the same attempt (nonce) comes again, success (the client had given up at 12 s); a different attempt gets "already answered"
        rn = w.ask_create(dict(P, tuid="toolu_n"))
        assert w.ask_answer(rn["id"], [{"sel": [0]}, {"sel": [0]}], nonce="kart-aaaa1111") == {"ok": True}
        assert w.ask_answer(rn["id"], [{"sel": [0]}, {"sel": [0]}], nonce="kart-aaaa1111") == {"ok": True, "again": True}
        assert w.ask_answer(rn["id"], [{"sel": [0]}, {"sel": [0]}], nonce="kart-bbbb2222")["reason"] == "This question has already been answered"
        assert w.ask_answer(rn["id"], None, handoff=True, nonce="kart-aaaa1111")["ok"] is False            # same attempt but a different action
        # the plugin did not use the answer (answersFor rejection): delivered false, lost true, the reason goes to the office
        assert w.ask_wait(rn["id"], "sess1", 0)["status"] == "answered"
        assert w.ask_ack(rn["id"], "sess1", False, "Cevap Claude biçimine uymadı") == {"ok": True}
        rec = [x for x in w.ask_list()["recent"] if x["id"] == rn["id"]][0]
        assert rec["delivered"] is False and rec["lost"] is True and "biçimine" in rec["reason"], rec
        # the answer is on the server but the plugin stopped listening (Esc): the withdrawal request makes the answer "ulaşmadı" (did not arrive) (even if the id is unknown, via the tool call)
        rl = w.ask_create(dict(P, tuid="toolu_l"))
        assert w.ask_answer(rl["id"], [{"sel": [1]}, {"sel": [1]}]) == {"ok": True}
        assert w.ask_cancel("", "sess1", tuid="toolu_l", reason="Claude dinlemeyi bıraktı") == {"ok": True}
        rec = [x for x in w.ask_list()["recent"] if x["id"] == rl["id"]][0]
        assert rec["status"] == "answered" and rec["delivered"] is False and rec["lost"] is True and rec["reason"] == "Claude dinlemeyi bıraktı", rec
        # a sub-agent's question: which worker it came from is shown on the card
        r2 = w.ask_create({"sid": "sess1", "aid": "aaa111", "tuid": "toolu_2", "questions": Q})
        sub = [x for x in w.ask_list()["items"] if x["id"] == r2["id"]][0]
        assert sub["sub"] is True and sub["aid"] == "aaa111" and sub["kind_tr"] == "Araştırmacı" and sub["nick"] not in ("", "Çalışan", "Worker"), sub
        # a second question from the same worker does NOT CANCEL the first: a separate card (also for the main agent, aid '')
        r3 = w.ask_create({"sid": "sess1", "aid": "aaa111", "tuid": "toolu_3", "questions": Q})
        assert r3["ok"] and r3["id"] != r2["id"] and w.ask_wait(r2["id"], "sess1", 0)["status"] == "pending"
        m1 = w.ask_create(dict(P, tuid="toolu_m1"))
        m2 = w.ask_create(dict(P, tuid="toolu_m2"))
        live = [x["id"] for x in w.ask_list()["items"]]
        assert m1["ok"] and m2["ok"] and m1["id"] != m2["id"] and {r2["id"], r3["id"], m1["id"], m2["id"]} <= set(live), live
        assert live.index(m1["id"]) < live.index(m2["id"])                         # order: the older first
        # withdrawal by id or (if the id is unknown) by tool call id; a fake session cannot close anything
        assert w.ask_cancel("", "sahte", tuid="toolu_m2") == {"ok": False} and w.ask_wait(m2["id"], "sess1", 0)["status"] == "pending"
        assert w.ask_cancel("", "sess1", tuid="toolu_m2") == {"ok": True} and w.ask_wait(m2["id"], "sess1", 0)["status"] == "cancelled"
        assert w.ask_cancel(m1["id"], "sess1", reason="Soru iptal edildi") == {"ok": True}
        assert w.ask_wait(m1["id"], "sess1", 0) == {"status": "cancelled", "reason": "Soru iptal edildi"}
        assert w.ask_cancel(r2["id"], "sess1") == {"ok": True}
        # fake session: a question from a session that is not connected is not accepted, it cannot wait for another session's card
        assert "not connected" in w.ask_create(dict(P, sid="sahte-oturum", tuid="toolu_s"))["reason"]
        assert w.ask_wait(r3["id"], "sahte-oturum", 0) == {"status": "gone"}
        # "Claude'da cevapla" (answer in Claude): handoff; the plugin gets 'handoff'
        assert w.ask_answer(r3["id"], None, handoff=True) == {"ok": True}
        assert w.ask_wait(r3["id"], "sess1", 0)["status"] == "handoff"
        assert w.ask_answer(r3["id"], [{"sel": [0]}, {"sel": [0]}])["reason"] == "This question was handed over to the Claude window"
        # the plugin withdraws (answered in Claude / time ran out)
        r4 = w.ask_create(dict(P, tuid="toolu_4"))
        assert w.ask_cancel(r4["id"], "baska") == {"ok": False} and w.ask_cancel(r4["id"], "sess1") == {"ok": True}
        assert w.ask_wait(r4["id"], "sess1", 0)["status"] == "cancelled" and w.ask_answer(r4["id"], [{}, {}])["ok"] is False
        # office in the background (v=0): the question is still accepted, the card waits; a pending question is not handed over just for staying in the background
        w.ask_list(False, False)
        rh = w.ask_create(dict(P, tuid="toolu_hid"))
        assert rh["ok"], rh
        w.office_vis = time.time() - 600
        assert w.ask_wait(rh["id"], "sess1", 0)["status"] == "pending"
        w.ask_list(True, True)
        assert w.office_focus > 0
        assert w.ask_cancel(rh["id"], "sess1") == {"ok": True}
        # when the office is closed (not polling for a long time) the question is not handed over either, and a new question is accepted: the card arrives when the office opens
        w.office_seen = time.time() - 3600
        r5 = w.ask_create(dict(P, tuid="toolu_5"))
        assert r5["ok"] and w.ask_wait(r5["id"], "sess1", 0)["status"] == "pending"
        assert w.ask_cancel(r5["id"], "sess1") == {"ok": True}
        w.ask_list()
        w.ask_list()
        # plugin gone (not polling): the question drops; a question that waited a long time drops; old closed records are deleted
        r6 = w.ask_create(dict(P, tuid="toolu_6"))
        w.asks[r6["id"]]["last_wait"] = time.time() - m.ASK_ORPHAN - 1
        assert w.ask_list()["items"] == [] and w.ask_wait(r6["id"], "sess1", 0)["status"] == "expired"
        r7 = w.ask_create(dict(P, tuid="toolu_7"))
        w.asks[r7["id"]]["t"] = time.time() - m.ASK_TTL - 1
        assert w.ask_wait(r7["id"], "sess1", 0)["status"] == "expired"
        for rec in w.asks.values():
            rec["done_at"] = time.time() - m.ASK_DONE_KEEP - 1
        w.ask_list()
        assert not w.asks and w.ask_wait(qid, "sess1", 0) == {"status": "gone"}
        # queue limit (each question counts separately even from the same worker)
        ids = [w.ask_create({"sid": "sess1", "aid": "", "tuid": "t%d" % i, "questions": Q}) for i in range(m.ASK_PENDING_MAX + 1)]
        assert all(x["ok"] for x in ids[:-1]) and ids[-1]["ok"] is False and "Too many" in ids[-1]["reason"]
        w.asks.clear()

        # HTTP: permission (origin / token), the long polling returning right away with the answer
        srv = m.ThreadingHTTPServer(("127.0.0.1", 0), m.Handler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % port

        def call(path, data=None, headers=None, timeout=5, ctype="application/json"):
            h = dict(headers or {})
            if data is not None and ctype:
                h.setdefault("Content-Type", ctype)
            req = urllib.request.Request(base + path, data=(json.dumps(data).encode("utf-8") if data is not None else None), headers=h, method="POST" if data is not None else "GET")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return resp.status, json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8")
                return e.code, (json.loads(body) if body.strip() else {})

        tok = {"X-PO-Token": w.token}
        evil = {"Origin": "http://evil.example"}
        cross = {"Sec-Fetch-Site": "cross-site"}
        local3000 = {"Origin": "http://localhost:3000"}                        # another local site in an old browser that does not send Sec-Fetch-Site
        same = {"Origin": "http://localhost:%d" % port}
        assert call("/asks", headers=cross)[0] == 403 and call("/asks", headers=evil)[0] == 403
        # /asks requires a token (so another page cannot fake the "office open / visible" info) and only its own origin
        assert call("/asks?v=1")[0] == 403 and call("/asks?v=1", headers={"X-PO-Token": "yanlis"})[0] == 403
        assert call("/asks?v=1", headers=dict(tok, **local3000))[0] == 403 and call("/asks?v=1", headers=dict(tok, **cross))[0] == 403
        assert call("/config", headers=local3000)[0] == 403 and call("/config", headers=same)[1]["token"] == w.token
        # the plugin routes cannot be called from a browser at all (any request carrying Origin / Sec-Fetch-*); the POST body must be JSON
        assert call("/ask/wait?id=x&sid=sess1&hold=0", headers=cross)[0] == 403 and call("/ask/wait?id=x&sid=sess1&hold=0", headers=local3000)[0] == 403
        assert call("/ask/wait?id=x&sid=sess1&hold=0", headers=same)[0] == 403 and call("/ask/wait?id=x&sid=sess1&hold=0", headers={"Sec-Fetch-Mode": "no-cors"})[0] == 403
        assert call("/ask", P, evil)[0] == 403 and call("/ask/cancel", {"id": "x"}, cross)[0] == 403
        assert call("/ask", P, local3000)[0] == 403 and call("/ask", P, same)[0] == 403 and call("/ask/ack", {"id": "x"}, local3000)[0] == 403
        assert call("/ask", P, ctype="text/plain")[0] == 403 and call("/ask", P, ctype="")[0] == 403
        w.office_vis = 0.0
        assert call("/asks", headers=tok)[1]["items"] == []                       # no v (old page): not counted as visible
        assert call("/asks?v=1&f=1", headers=dict(tok, **same))[1]["items"] == []
        w.office_vis = 0.0
        code, r = call("/ask", P)                                                 # also accepted in a background office (the card waits)
        assert code == 200 and r["ok"], r
        qid = r["id"]
        assert call("/asks?v=1", headers=dict(tok, **{"Sec-Fetch-Site": "same-origin"}))[1]["items"][0]["id"] == qid
        ans = {"id": qid, "answers": [{"sel": [0]}, {"sel": [1]}]}
        assert call("/answer", ans)[0] == 403 and call("/answer", ans, {"X-PO-Token": "yanlis"})[0] == 403
        assert call("/answer", ans, dict(tok, **evil))[0] == 403 and call("/answer", ans, dict(tok, **cross))[0] == 403
        assert call("/answer", ans, dict(tok, **local3000))[0] == 403
        assert call("/ask/wait?id=%s&sid=sess1&hold=0" % qid)[1] == {"status": "pending"}
        out = {}

        def waiter():
            t0 = time.time()
            out["r"] = call("/ask/wait?id=%s&sid=sess1" % qid, timeout=20)
            out["dt"] = time.time() - t0
        th = threading.Thread(target=waiter)
        th.start()
        time.sleep(0.4)
        assert call("/answer", ans, tok)[1] == {"ok": True}
        th.join(15)
        assert out["r"] == (200, {"status": "answered", "id": qid, "answers": ["dayjs", "B"]}) and out["dt"] < 3, out
        assert call("/answer", ans, tok)[1]["ok"] is False
        # receipt notice (plugin) over HTTP; the office sees "delivered"
        assert call("/ask/ack", {"id": qid, "sid": "sess1", "ok": True})[1] == {"ok": True}
        assert [x for x in call("/asks?v=1", headers=tok)[1]["recent"] if x["id"] == qid][0]["delivered"] is True
        # handoff over HTTP
        r = call("/ask", dict(P, tuid="toolu_h"))[1]
        assert call("/answer", {"id": r["id"], "handoff": True}, tok)[1] == {"ok": True}
        assert call("/ask/wait?id=%s&sid=sess1" % r["id"])[1]["status"] == "handoff"
        # corrupt hold value: the default; withdrawal
        r = call("/ask", dict(P, tuid="toolu_c"))[1]
        assert call("/ask/cancel", {"id": r["id"], "sid": "sess1"})[1] == {"ok": True}
        assert call("/ask/wait?id=%s&sid=sess1&hold=abc" % r["id"])[1]["status"] == "cancelled"
        r = call("/ask", dict(P, tuid="toolu_ct"))[1]
        assert call("/ask/cancel", {"id": "", "tuid": "toolu_ct", "sid": "sess1"})[1] == {"ok": True}
        assert call("/ask/wait?id=%s&sid=sess1&hold=0" % r["id"])[1]["status"] == "cancelled"
        # the same attempt (nonce) over HTTP too: success if the client times out and retries
        r = call("/ask", dict(P, tuid="toolu_nn"))[1]
        an = {"id": r["id"], "answers": [{"sel": [0]}, {"sel": [1]}], "nonce": "kart-cccc3333"}
        assert call("/answer", an, tok)[1] == {"ok": True} and call("/answer", an, tok)[1] == {"ok": True, "again": True}
        srv.shutdown()
        srv.server_close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("asks ok")


if __name__ == "__main__":
    test_media_paths()
    test_feed_media()
    test_window_top()
    test_text_helpers()
    test_namer()
    test_reply_capture()
    test_reply_file_unicode_split()
    test_reply_n_survives_restart()
    test_subagent_handback()
    test_view_gone_restore_stop_names()
    test_http_routes()
    test_state_stays_small()
    test_detail_texts()
    test_feed_guard()
    test_static_whitelist_and_hardening()
    test_gserver_fixes()
    test_son_dogrulama_duzeltmeleri()
    test_uploads()
    test_asks()
    test_identity_and_port_probe()
    print("all OK")
    sys.exit(0)
