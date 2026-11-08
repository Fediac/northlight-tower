import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Actor, ActorState, Reply, SendStatus, Who } from '../types'

/*
 * Pixel Office plugin (v0.8.0).
 *  - Tracks the workers in the session (main agent "Manager" + sub-agents) from CERTAIN events: tool call,
 *    permission decision, sub-agent spawn, end of turn. No log guessing.
 *  - Shows them in a side panel inside Claude (opened with /pixel-office, opens by itself when the session
 *    starts, you can close it).
 *  - Passes messages written from the Pixel Office page (only from the server at 127.0.0.1:8765 on this computer,
 *    token protected) to the relevant sub-agent, or sends them to the main agent as the user's
 *    own words. Gives the agent's reply and the images it produced back to the office.
 *  - You can also write to a sub-agent the same way from the "Message a worker" box under the panel:
 *    it is sent to the selected sub-agent (deliver() has the same delivery logic), the selected agent's last reply shows in the panel.
 *  - v0.7: names (the server's /names reply), message box (the only send path: Input),
 *    "Stop" (stop request from the server: main agent turn.abort, sub-agent TaskStop, otherwise by message).
 *  - v0.7.1: the reply sent to the chat keeps line breaks (4000 characters), no "STOP" is sent to a finished worker,
 *    the direct-send block does not last forever, timers are not doubled, the box is not emptied without delivery.
 *  - File attachments: the server saves files attached from the message box in the tower and writes each one on its own line in the text as
 *    "[Ek: <tam yol> (<tür>, <boyut>)]" (Turkish attachment line: full path, type, size). The frame does not break these lines (they stay at line start, not trimmed);
 *    if there is an attachment, one sentence is added that says how to open it (ATTACH_HINT).
 *  - v0.8: Claude's questions (AskUserQuestion) go to the QUESTION CARD in the tower; if the answer comes from there, Claude's own dialog
 *    is never opened (the hook gives the tool's answer itself). If the office is not open, there is no server, time runs out, or the user
 *    says "Answer in Claude", next(e): Claude's own dialog opens, the question is not lost (askOffice).
 *  - v0.8.1: the question goes to the tower only WHILE the office tab is VISIBLE (if it is in the background, Claude's dialog right away); while waiting, the status line in Claude
 *    shows "Question waiting in NorthLight Tower"; on Esc / cancel the card is withdrawn at once; when the answer is used, an ack goes to the server
 *    (the office says "Your answer was delivered to Claude" only then); every request has a timeout; the result is normalized to the tool's output schema.
 *  - Does not call the model, adds nothing to the context: spends no tokens on its own.
 *    Does not touch the session: next(e) on every event (only exception: a question answered from the tower).
 */

const PANE = 'pixel-office'
const OFFICE_URL = 'http://127.0.0.1:8765'
const HOOK_URL = 'http://127.0.0.1:8765/hook'
const ACK_URL = 'http://127.0.0.1:8765/ack'
// mv: let the server know the plugin version (an old version does not know 'stop'; the server does not send Stop to an old plugin)
const OUTBOX_URL = 'http://127.0.0.1:8765/outbox?mv=0.8.1&sid='
const STATE_URL = 'http://127.0.0.1:8765/state'
const NAMES_URL = 'http://127.0.0.1:8765/names?sid='
// Claude's questions: POST /ask (question id) -> GET /ask/wait (long polling, hold s) -> answer -> POST /ask/ack (answer used);
// withdrawal: POST /ask/cancel (by id or by tool call id)
const ASK_URL = 'http://127.0.0.1:8765/ask'
const ASK_HOLD_S = 8 // the longest the server waits in long polling (s); the server allows at most 12 s
const ASK_WAIT_URL = 'http://127.0.0.1:8765/ask/wait?hold=' + ASK_HOLD_S + '&id='
const ASK_CANCEL_URL = 'http://127.0.0.1:8765/ask/cancel'
const ASK_ACK_URL = 'http://127.0.0.1:8765/ask/ack'

const actors = atom({ plugin: 'pixel-office', key: 'actors' } as const, {} as Record<string, Actor>)
// message section of the panel: last reply per sub-agent, selected sub-agent, typed draft, send status
const replies = atom({ plugin: 'pixel-office', key: 'replies' } as const, {} as Record<string, Reply>)
const selected = atom({ plugin: 'pixel-office', key: 'selected' } as const, '')
// The draft of the message box is NOT KEPT IN AN ATOM: writing an atom on every key and redrawing the panel made letters get lost.
// The box is uncontrolled (no value is given); when delivery succeeds sendSeq increases, the box's key changes and the field reopens empty.
// (The panel may also be redrawn on agent events while typing; since typed letters are not written to an atom, a redraw must not spoil the text.
// This behavior was not verified live on the host.)
const sendSeq = atom({ plugin: 'pixel-office', key: 'sendSeq' } as const, 0)
// person names given by the server, by sub-agent id (main agent: 'main')
const names = atom({ plugin: 'pixel-office', key: 'names' } as const, {} as Record<string, Who>)
const IDLE: SendStatus = { id: '', kind: 'idle', text: '' }
const sendStatus = atom({ plugin: 'pixel-office', key: 'sendStatus' } as const, IDLE)

const MAX_SAY = 2000 // the longest message that can be sent from the panel in one go
const CHAT_MAX = 4000 // the longest form of the reply sent to the chat (the tower); same as the add_chat limit on the server
const DIRECT_RETRY_MS = 10 * 60 * 1000 // how many ms after a direct send is rejected it is retried
const DIRECT_RETRY_EVERY = 5 // ...or every how many messages (whichever comes first)
const REPLY_KEEP = 600 // length of the last reply kept in the atom
const REPLY_SHOW = 300 // the part shown in the panel
const REPLY_AGENTS = 30 // the maximum number of sub-agents whose last reply is kept
const MSG_KEY = 'msg' // key prefix of the message box; the send counter is appended
const ASK_TOTAL_MS = 10 * 60 * 1000 // the question card in the tower waits at most this long; then the question moves to Claude's own dialog
const ASK_MAX_POLLS = 150 // safety: so that the loop is not endless even if the server returns "pending" without waiting (normally ~50 polls)
const ASK_ANS_MAX = 4000 // the longest single answer that is accepted (the server limits it at 2000)
// $.http.fetch has no timeout of its own: every question request is raced against a $.clock timer (so that a hanging request does not lock the hook)
const ASK_FETCH_MS = 5000 // request that drops the question
const ASK_WAIT_MS = (ASK_HOLD_S + 7) * 1000 // long polling: the server's wait + margin
// status line shown in Claude while waiting (the question is in the tower; Claude's own dialog was not opened)
const ASK_STATUS = 'Question waiting in NorthLight Tower: answer on its card (or choose "Answer in Claude" on the card)'

const WRITE = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])
const READ = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill'])
const DELEGATE = new Set(['Agent', 'Task', 'Workflow'])

const LABEL: Record<string, string> = {
  Edit: 'Editing a file',
  Write: 'Writing a file',
  NotebookEdit: 'Writing a notebook',
  Bash: 'Running a command',
  PowerShell: 'Running a command',
  Read: 'Reading a file',
  Grep: 'Searching file contents',
  Glob: 'Searching for files',
  WebFetch: 'Reading a web page',
  WebSearch: 'Searching the web',
  ToolSearch: 'Searching for a tool',
  Skill: 'Using a skill',
  Agent: 'Started a worker',
  Task: 'Started a worker',
  Workflow: 'Managing a team of workers',
  AskUserQuestion: 'Asking you a question',
}

// State names are the same everywhere: Working / Waiting for approval / Done (what it did is on the second line of the card)
const STATE_TR: Record<ActorState, string> = {
  typing: 'Working',
  reading: 'Working',
  thinking: 'Working',
  delegating: 'Working',
  waiting: 'Waiting for approval',
  done: 'Done',
}
const STATE_COLOR: Record<ActorState, string> = {
  typing: '#46e0a0',
  reading: '#5cc8ff',
  thinking: '#c9b8ff',
  delegating: '#ffcf5c',
  waiting: '#ff4d6a',
  done: '#8c86b8',
}

function stateFor(tool: string): ActorState {
  // a worker that asks a question waits for the user: "Waiting for approval" (red) is shown
  if (tool === 'AskUserQuestion') return 'waiting'
  if (WRITE.has(tool)) return 'typing'
  if (READ.has(tool) || /Browser|chrome|computer-use/.test(tool)) return 'reading'
  if (DELEGATE.has(tool)) return 'delegating'
  return 'typing'
}

// the first k code units; if the cut falls in the middle of a surrogate pair (the last unit is a high surrogate) that unit is dropped too:
// a lone surrogate is escaped as \ud83c in JSON and the server cannot convert it to UTF-8
function cut(s: string, k: number): string {
  const t = s.slice(0, Math.max(0, k))
  const last = t.charCodeAt(t.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t
}

// show an English/foreign error reason from Claude in Turkish (same logic as tr_reason on the server); a Turkish reason is left untouched
function trWhy(reason: unknown): string {
  const r = String(reason ?? '').replace(/\s+/g, ' ').trim()
  const low = r.toLowerCase()
  if (!r) return ''
  if (low.includes('no running turn')) return 'The worker has already stopped'
  if (low.includes('classifier') || low.includes('auto mode') || low.includes('verdict')) return "Claude's automatic permission check blocked the send"
  if (low.includes('timed out') || low.includes('timeout')) return 'Claude did not respond in time'
  // the mod's own reason is shown as it is; bare ASCII (English technical) reasons from Claude are turned into a generic phrase
  if (r === INVALID_WORKER) return r
  if (/^[ -~]+$/.test(r) && /[A-Za-z]{3}/.test(r)) return 'Claude reported a problem'
  return r
}

function short(text: unknown, n = 80): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? cut(s, n - 1) + '…' : s
}

// Reply sent to the chat (the tower): line breaks and list markers are KEPT (short() would turn them all into spaces); at most CHAT_MAX characters.
// short() is used only for the panel preview.
function chatText(raw: unknown): string {
  const s = (typeof raw === 'string' ? raw : '').replace(/\r\n?/g, '\n').trim()
  return s.length > CHAT_MAX ? cut(s, CHAT_MAX) : s
}

function base(path: unknown): string {
  const s = String(path ?? '').replace(/\\/g, '/')
  return s.slice(s.lastIndexOf('/') + 1)
}

function summarize(tool: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (tool === 'Bash' || tool === 'PowerShell') return short(i.description || i.command, 100)
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return base(i.file_path)
  if (tool === 'NotebookEdit') return base(i.notebook_path)
  if (tool === 'Grep' || tool === 'Glob') return short(i.pattern, 60)
  if (tool === 'WebFetch') return short(i.url, 80)
  if (tool === 'WebSearch') return short(i.query, 80)
  if (tool === 'Agent' || tool === 'Task') return short(i.description || i.subagent_type, 80)
  for (const k of ['description', 'name', 'query', 'prompt', 'title', 'url', 'path', 'command']) {
    if (typeof i[k] === 'string' && (i[k] as string).trim()) return short(i[k], 80)
  }
  return ''
}

function argsOf(e: object): Record<string, unknown> {
  const o = { ...(e as Record<string, unknown>) }
  for (const k of ['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta']) delete o[k]
  return o
}

function clock(sec: number): string {
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function hhmm(sec: number): string {
  return clock(sec).slice(0, 5)
}

function toolLabel(tool: string): string {
  if (LABEL[tool]) return LABEL[tool]
  return 'Working'
}

// image addresses in a tool result: [Image: source: path] and http(s) ... .png/.jpg/.gif/.webp
const RE_SRC = /\[Image: source: ([^\]]+?\.(?:png|jpe?g|gif|webp))\]/gi
const RE_URL = /https?:\/\/[^\s"'<>(){}\]]+?\.(?:png|jpe?g|gif|webp|mp4|webm)(?:\?[^\s"'<>)\]]*)?/gi

function imagesIn(text: unknown): string[] {
  const s = String(text ?? '').slice(0, 30000)
  const out: string[] = []
  for (const m of s.matchAll(RE_SRC)) out.push((m[1] ?? '').trim())
  for (const m of s.matchAll(RE_URL)) out.push(m[0])
  return Array.from(new Set(out)).slice(0, 12)
}

let sessionId = ''
let busy = false
let busyAt = 0
let lastPump = 0
let awaitingMain = false
// the last running MAIN turn (captured from turn.start, deleted on turn.complete): "Stop" calls turn.abort with it
let mainTurn = ''
// >0 while the mod's own TaskStop call is in progress: so that the tool.call observer does not count it as the agent's work
let ownStop = 0
let serverTried = 0

// forward the event to the server (this computer only); pass silently on error.
// The returned promise is never rejected; most callers do not wait for it (fire and forget), only the event whose order matters (say) waits.
function post($: EngineInterface, body: Record<string, unknown>): Promise<void> {
  try {
    return $.http
      .fetch(HOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // the envelope AFTER the body: no body can overwrite the src/sid/ts fields (the server tells the mod apart by src:'mod')
        body: JSON.stringify({ ...body, v: 1, src: 'mod', sid: sessionId, ts: Date.now() / 1000 }),
      })
      .then(
        () => {},
        () => {},
      )
  } catch {
    /* not important if there is no server */
    return Promise.resolve()
  }
}

// waits (at most 2 s) for the say record to reach the server: so that the ack sent at the end of deliver() does not arrive before say.
// If the server does not answer, the message itself is not held up (post() is never rejected; if the timer cannot be set up, only the reply is awaited).
async function postAndWait($: EngineInterface, body: Record<string, unknown>) {
  let timer: { cancel: () => void } | undefined
  const limit = new Promise<void>(resolve => {
    try {
      timer = $.clock.after(2000, resolve)
    } catch {
      /* if there is no timer, only the reply is awaited */
    }
  })
  try {
    await Promise.race([post($, body), limit])
  } finally {
    timer?.cancel()
  }
}

function ack($: EngineInterface, id: string, ok: boolean, reason?: string) {
  try {
    void $.http
      .fetch(ACK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ok, reason: reason ?? '' }) })
      .catch(() => {})
  } catch {
    /* */
  }
}

// session id (the name of the log file): the server matches events with it
async function sid($: EngineInterface) {
  if (!sessionId) {
    try {
      sessionId = await $.session.id()
    } catch {
      /* */
    }
  }
  return sessionId
}

// if the server is down, tries to start it once (passes silently in a non-CLI environment)
async function ensureServer($: EngineInterface) {
  try {
    const r = await $.http.fetch(STATE_URL)
    if (r.ok) return
  } catch {
    /* down */
  }
  if (serverTried >= 2) return
  serverTried += 1
  try {
    const root = String($.plugin.root || '').replace(/[\\/]+$/, '')
    const guess = root.replace(/[\\/]mod[\\/]pixel-office$/i, '')
    if (!guess || guess === root) return // plugin is not inside the project folder: server.py cannot be located, use Start.bat
    const dir = guess
    const script = dir + '\\server.py'
    await $.process.run(
      ['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -WindowStyle Hidden -FilePath pythonw -ArgumentList '"${script}"'`],
      { timeoutMs: 10000 },
    )
  } catch {
    /* no process start: Start.bat is used */
  }
}

// A direct send to a sub-agent ($.session.send) may not pass the permission check while Claude is in "auto mode": the message the user
// wrote from the tower is not counted as the model's own request, the classifier does not decide, and the send is rejected. We do NOT bypass this check.
// If it is rejected, we give the message to the main agent as the user's request: the model calls SendMessage and it passes the normal check.
// This block does not last forever: after DIRECT_RETRY_MS or at every DIRECT_RETRY_EVERY-th message the direct send is retried
// (the user may have added a SendMessage permission rule in the meantime); it is also reset when the session ends.
let directBlocked = false
let directBlockedAt = 0
let blockedSends = 0

function isPermissionRefusal(reason: unknown) {
  return /classifier|verdict|auto mode|permission|approval|denied|izin/i.test(String(reason ?? ''))
}

const VIA_MAIN = 'via the manager'
const STOP_VIA_MAIN = 'STOP request passed to the manager (it will see it on its next step)'
const INVALID_WORKER = 'Invalid worker'

// Plain reply request added to the end of the frame sent to a sub-agent (NOT added to the text sent to the main agent)
const REPLY_STYLE = "Give your reply as a single sentence starting with 'SUMMARY:', then add the details briefly below it; avoid technical jargon."
// last resort of "Stop": a plain message to the sub-agent
const STOP_TEXT = 'STOP: drop what you are doing right now and briefly say what you have done.'

// The attachment line the server adds to the message (server.py attach_line): '[Ek: ad="ad.png" (görsel, 240 KB) yol="C:\...\<kimlik>_ad.png"]'
// (Turkish attachment line: name, type, size, path; + audio/video note). Whether there is an attachment is decided NOT by looking at the text but by the real attachment count the server wrote (outbox "files"):
// the server already turns a "[Ek: ..." line that the user typed by hand into "(Ek: ...".
const ATTACH_HINT = 'The attached files are given with their full paths: open images, PDFs and text files with the Read tool; handle audio and video according to the note on the line.'

// Text sent to the main agent: the "[Piksel Ofis sohbeti] " (Pixel Office chat) prefix. If the text starts directly with an attachment line (only a file was sent)
// the prefix is written on a separate line: the "[Ek: ...]" line stays whole at line start. If there is no attachment the text is as before (no reply request is added).
function mainText(text: string, files: number): string {
  if (!(files > 0)) return '[NorthLight Tower chat] ' + text
  return '[NorthLight Tower chat]' + (/^\[(?:Ek|Attachment): /.test(text) ? '\n' : ' ') + text + '\n\n' + ATTACH_HINT
}

// Frame sent to a sub-agent: the user's text (attachment lines included) as it is in the middle, the requests at the end
function subFrame(text: string, files: number): string {
  return (
    'The user wrote you the following from the NorthLight Tower interface. Please continue accordingly and reply briefly:\n\n' +
    text +
    '\n\n' +
    (files > 0 ? ATTACH_HINT + ' ' : '') +
    REPLY_STYLE
  )
}

// Sends the ready text to the sub-agent: first directly, if the permission check rejects it via the main agent (the check is NOT bypassed).
async function sendToSub($: EngineInterface, id: string, aid: string, framed: string): Promise<{ ok: boolean; reason: string }> {
  if (directBlocked) {
    blockedSends += 1
    if (blockedSends >= DIRECT_RETRY_EVERY || (await $.clock.now()) - directBlockedAt >= DIRECT_RETRY_MS) directBlocked = false
  }
  if (!directBlocked) {
    const res = await $.session.send({ to: { agentId: aid }, text: framed })
    dbg($, 'direct delivery ' + id + ' -> ' + (res.isDelivered ? 'ok' : short(res.reason, 120)))
    if (res.isDelivered) return { ok: true, reason: '' }
    if (!isPermissionRefusal(res.reason)) return { ok: false, reason: res.reason }
    directBlocked = true
    blockedSends = 0
    directBlockedAt = await $.clock.now()
  }
  // give it to the main agent as a request the user wrote from the tower; the model's own SendMessage call does the forwarding.
  // aid comes from the server and is embedded in the text: it is not given to the model without validating its format
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(aid)) return { ok: false, reason: INVALID_WORKER }
  void $.prompt.submit({
    text:
      '[NorthLight Tower chat] The user wrote a message to a worker from the NorthLight Tower Messages window and wants it forwarded to that worker. ' +
      'Use the SendMessage tool with to: "' + aid + '" to forward the text below EXACTLY (do not summarize it, add comments or do any other work); ' +
      'once forwarded, reply with the single word "forwarded".\n\nText to forward:\n' + framed,
    asUser: true,
  })
  return { ok: true, reason: VIA_MAIN }
}

// "Stop": cuts the running turn on the main agent; on a sub-agent tries TaskStop, otherwise sends a "STOP" message.
// The result goes to the ack: reason = 'TaskStop' | 'by message' | STOP_VIA_MAIN | 'turn stopped' | 'already stopped' | error reason.
async function stopActor($: EngineInterface, id: string, aid: string): Promise<{ ok: boolean; reason: string }> {
  if (!aid) {
    const turnId = mainTurn
    if (!turnId) {
      // no turn id: the mod may have been reloaded in the middle of a turn. If the main worker still appears to be running, "already stopped" is not said.
      const st = (await read($, actors)).main?.state
      if (st && st !== 'done') return { ok: false, reason: 'You need to stop it from the Claude window' }
      return { ok: true, reason: 'already stopped' }
    }
    try {
      await $.turn.abort({ turnId })
      if (mainTurn === turnId) mainTurn = ''
      return { ok: true, reason: 'turn stopped' }
    } catch (err) {
      // if the turn has ended in the meantime or the running turn is not this one: count it as already stopped
      if (mainTurn !== turnId || /running turn|not the running|no (running )?turn/i.test(String(err))) {
        if (mainTurn === turnId) mainTurn = ''
        return { ok: true, reason: 'already stopped' }
      }
      return { ok: false, reason: short(err, 120) }
    }
  }
  // neither TaskStop nor a "STOP" message is tried on an already finished worker: a message would wake a finished sub-agent again and make it spend a turn
  if ((await read($, actors))[aid]?.state === 'done') return { ok: true, reason: 'already stopped' }
  let why = ''
  ownStop += 1
  try {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: aid })
    if (r.deny === undefined && !r.isError) return { ok: true, reason: 'TaskStop' }
    why = String(r.deny ?? r.text ?? '')
  } catch (err) {
    why = String(err)
  } finally {
    ownStop -= 1
  }
  // the worker may have finished by itself while TaskStop was awaited: the "by message" ("mesajla") fallback is only for a running worker
  if ((await read($, actors))[aid]?.state === 'done') return { ok: true, reason: 'already stopped' }
  dbg($, 'TaskStop ' + aid + ' failed (' + short(why, 100) + '), trying by message')
  const res = await sendToSub($, id, aid, STOP_TEXT)
  if (!res.ok) return { ok: false, reason: res.reason }
  // on the way via the main worker the sub-agent is not stopped yet: honest ack
  return { ok: true, reason: res.reason ? STOP_VIA_MAIN : 'by message' }
}

// deliver the messages that come from the office page (and from the panel). Sends an ack to the server; also returns the same result (ok / reason) to the caller
// (pump does not use the result, the panel uses it for the status line).
async function deliver($: EngineInterface, it: { id: string; kind: string; aid: string; text: string; files?: number }): Promise<{ ok: boolean; reason: string }> {
  const files = typeof it.files === 'number' ? it.files : 0
  const finish = (ok: boolean, reason?: string) => {
    ack($, it.id, ok, reason)
    return { ok, reason: reason ?? '' }
  }
  try {
    if (it.kind === 'stop') {
      const res = await stopActor($, it.id, it.aid)
      return finish(res.ok, res.reason)
    }
    if (it.kind === 'sub') {
      const res = await sendToSub($, it.id, it.aid, subFrame(it.text, files))
      return finish(res.ok, res.reason)
    }
    awaitingMain = true
    void $.prompt.submit({ text: mainText(it.text, files), asUser: true })
    return finish(true)
  } catch (err) {
    return finish(false, short(err, 160))
  }
}

// delivery loop: so that a request left half-done while the server restarts does not lock the loop forever,
// it can be re-entered after 6 s; if it gets stuck, every tool call / end of turn tries the loop again
async function pump($: EngineInterface) {
  const t = Date.now()
  if (busy && t - busyAt < 6000) return
  busy = true
  busyAt = t
  lastPump = t
  try {
    const id = await sid($)
    if (!id) {
      dbg($, 'pump: no session id')
      return
    }
    const r = await $.http.fetch(OUTBOX_URL + encodeURIComponent(id))
    if (!r.ok) return
    const data = JSON.parse(r.text) as { items?: Array<{ id: string; kind: string; aid: string; text: string; files?: number }> }
    const items = data.items ?? []
    // "Stop" is brought forward and not awaited: so that if TaskStop opens an approval window it does not hold up the messages in the queue
    for (const it of items) if (it.kind === 'stop') void deliver($, it)
    for (const it of items) if (it.kind !== 'stop') await deliver($, it)
  } catch {
    /* the server may be down */
  } finally {
    busy = false
  }
}

function wake($: EngineInterface) {
  if (Date.now() - lastPump > 8000) void pump($)
}

// development trace: appears under "moddbg" in the server's /state output
function dbg($: EngineInterface, text: string) {
  post($, { kind: 'dbg', text })
}

function applyPatch(map: Record<string, Actor>, id: string, patch: Partial<Actor>, fallback: Partial<Actor> = {}): Record<string, Actor> {
  const now = Date.now() / 1000
  const prev = map[id]
  const base0: Actor = prev ?? {
    id,
    label: id === 'main' ? 'Manager' : 'Worker',
    kind: id === 'main' ? 'main' : 'sub',
    state: 'thinking',
    detail: '',
    target: '',
    since: now,
    updated: now,
    tools: 0,
    ...fallback,
  }
  const next: Actor = { ...base0, ...patch, updated: now }
  if (patch.state && patch.state !== base0.state) next.since = now
  return { ...map, [id]: next }
}

function ident(e: { agent_id?: string }) {
  return e.agent_id ? e.agent_id : 'main'
}

// ---- message to a sub-agent from the panel ----

// sub-agents, in order of first sighting (keep the order fixed: so that the Select options do not swap places when the state changes)
function subsOf(map: Record<string, Actor>): Actor[] {
  return Object.values(map).filter(a => a.kind === 'sub')
}

// the sub-agent the message will go to: the selected agent if it is still listed, otherwise (or if none was ever selected) the first sub-agent; if none, ''
function targetOf(map: Record<string, Actor>, chosen: string): string {
  const subs = subsOf(map)
  const hit = subs.find(a => a.id === chosen)
  return hit ? hit.id : (subs[0]?.id ?? '')
}

// The agent's visible name: if the server gave a name "Hayalet · Mod testi" (if there is no role, the type: "Hayalet · Uzman"); otherwise the old label.
// The id code ("#48ec") and "↳" are not shown.
function titleOf(a: Actor, who?: Who): string {
  if (who) {
    if (a.kind === 'main') return who.nick + (a.label && a.label !== 'Manager' ? ' · ' + a.label : '')
    return who.nick + (who.role ? ' · ' + who.role : who.kind ? ' · ' + who.kind : '')
  }
  return a.label || (a.kind === 'main' ? 'Manager' : 'Worker')
}

// Select options: label = visible name (+ " (bitirdi)" if finished); value = agent id.
// If the same name appears twice, a sequence number is added to the second one ("Explore 2").
function optionsOf(subs: Actor[], who: Record<string, Who>): Array<{ value: string; label: string }> {
  const seen: Record<string, number> = {}
  return subs.map(a => {
    let name = titleOf(a, who[a.id])
    seen[name] = (seen[name] ?? 0) + 1
    if ((seen[name] ?? 0) > 1) name += ' ' + seen[name]
    return { value: a.id, label: name + (a.state === 'done' ? ' (done)' : '') }
  })
}

// fetch the person names from the server (this computer only). If the server is down / the reply is broken the old names stay, the label fallback is used.
async function refreshNames($: EngineInterface) {
  try {
    const id = await sid($)
    if (!id) return
    const r = await $.http.fetch(NAMES_URL + encodeURIComponent(id))
    if (!r.ok) return
    const data = JSON.parse(r.text) as { agents?: Array<{ aid?: string; nick?: string; role?: string; kind_tr?: string }> }
    const next: Record<string, Who> = {}
    for (const a of data.agents ?? []) {
      const nick = short(a.nick, 24)
      if (nick) next[a.aid ? a.aid : 'main'] = { nick, role: short(a.role, 40), kind: short(a.kind_tr, 20) }
    }
    if (JSON.stringify(await read($, names)) !== JSON.stringify(next)) await update($, names, () => next)
  } catch {
    /* the server may be down */
  }
}

// writes the last reply of a sub-agent; at most REPLY_AGENTS agents are kept (the newest stay, if the time is equal the one added later counts as newer)
function withReply(map: Record<string, Reply>, aid: string, one: Reply): Record<string, Reply> {
  const all: Record<string, Reply> = { ...map }
  delete all[aid]
  all[aid] = one
  const keys = Object.keys(all)
  if (keys.length <= REPLY_AGENTS) return all
  const newest = keys
    .map((k, i) => ({ k, i, t: all[k]?.t ?? 0 }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .slice(0, REPLY_AGENTS)
  const out: Record<string, Reply> = {}
  for (const { k } of newest.sort((a, b) => a.i - b.i)) {
    const v = all[k]
    if (v) out[k] = v
  }
  return out
}

// added to the status line when delivery fails: the typed message was not deleted from the box
const KEPT = ' · Your message is still in the box'

function mkStatus(id: string, kind: SendStatus['kind'], text: string): SendStatus {
  return { id, kind, text }
}

// warnings before sending starts (empty / too long / no sub-agent); does not overwrite the status of a send in progress
async function hint($: EngineInterface, why: string) {
  await update($, sendStatus, cur => (cur.kind === 'sending' ? cur : mkStatus('', 'error', 'Error: ' + why)))
}

// send finished: written only if the status is still this message's (so that a newer message's "Sending…" line is not overwritten)
async function finishStatus($: EngineInterface, id: string, who: string, ok: boolean, reason: string) {
  const done = ok
    ? mkStatus(id, 'ok', 'Delivered to ' + (who || 'the worker') + ' ✓' + (reason ? ' (' + short(reason, 60) + ')' : ''))
    : mkStatus(id, 'error', 'Error: ' + short(trWhy(reason) || 'unknown reason', 100) + KEPT)
  await update($, sendStatus, cur => (cur.id === id ? done : cur))
}

// while one delivery is in progress a second send is ignored (so that the same text does not go twice because the box is not empty yet)
let paneSending = false

// Enter (or Input's own "send" button): sends the message in the box to the selected sub-agent. First records it on the server as "say" (in the chat in the tower
// "me / waiting" appears), then delivers it with deliver() (directly with $.session.send; if the permission check rejects it, via the main agent:
// that logic is in deliver(), here it is only reused). deliver() sends the ack to the server itself.
// The box is emptied ONLY when delivery succeeds (sendSeq increases); if it fails the text stays in the box.
async function sendFromPane($: EngineInterface, raw: string) {
  if (paneSending) return
  const text = raw.trim()
  try {
    if (!text) {
      await hint($, 'message is empty')
      return
    }
    if (text.length > MAX_SAY) {
      await hint($, 'message is too long (' + text.length + ' characters, max ' + MAX_SAY + ')')
      return
    }
    const aid = targetOf(await read($, actors), await read($, selected))
    if (!aid) {
      await hint($, 'no workers yet')
      return
    }
    const id = 'p' + Date.now()
    const nick = (await read($, names))[aid]?.nick ?? ''
    paneSending = true
    try {
      await update($, sendStatus, () => mkStatus(id, 'sending', 'Sending…'))
      await sid($)
      await postAndWait($, { kind: 'say', aid, id, text })
      const res = await deliver($, { id, kind: 'sub', aid, text })
      // if delivery succeeded, empty the box: the key changes, the field reopens from scratch (since the text is not kept in an atom nothing else is reset)
      if (res.ok) await update($, sendSeq, n => n + 1)
      await finishStatus($, id, nick, res.ok, res.reason)
    } finally {
      paneSending = false
    }
  } catch (err) {
    await update($, sendStatus, () => mkStatus('', 'error', 'Error: ' + short(trWhy(err instanceof Error ? err.message : err), 100) + KEPT)).catch(() => {})
  }
}

// ---- Claude's questions (AskUserQuestion) on the question card in the tower ----

// The question in the tool's output schema (claude-code.d.ts, BuiltinToolResults['AskUserQuestion'].questions): header, options and multiSelect are
// REQUIRED; kind / description / placeholder / min / max / step / defaultValue / unit are optional. In an option label is required, the rest is optional.
type AskOption = { label: string; description?: string; preview?: string }
type AskQuestion = {
  question: string
  header: string
  options: AskOption[]
  multiSelect: boolean
  kind?: 'choice' | 'text' | 'number'
  description?: string
  placeholder?: string
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  unit?: string
}
type AskOutcome =
  | { kind: 'answered'; questions: AskQuestion[]; answers: Record<string, string> }
  | { kind: 'fallback'; why: string }
  | { kind: 'aborted' }
type AskEvent = { questions?: unknown; tool_use_id?: string; agentId?: string }

// Brings the questions in the input to the tool's OUTPUT schema: a missing header becomes '' , missing options [] , multiSelect is true only if it is true;
// fields not in the schema are dropped, optional fields stay only if they have the right type. null if the question text is missing / a type is broken.
function normQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw)) return null
  const out: AskQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') return null
    const o = q as Record<string, unknown>
    if (typeof o.question !== 'string') return null
    const item: AskQuestion = { question: o.question, header: typeof o.header === 'string' ? o.header : '', options: [], multiSelect: o.multiSelect === true }
    if (Array.isArray(o.options)) {
      for (const op of o.options) {
        const p = (op && typeof op === 'object' ? op : {}) as Record<string, unknown>
        if (typeof p.label !== 'string') return null
        const one: AskOption = { label: p.label }
        if (typeof p.description === 'string') one.description = p.description
        if (typeof p.preview === 'string') one.preview = p.preview
        item.options.push(one)
      }
    } else if (o.options != null) return null
    if (o.kind === 'choice' || o.kind === 'text' || o.kind === 'number') item.kind = o.kind
    else if (o.kind != null) return null
    for (const k of ['description', 'placeholder', 'unit'] as const) if (typeof o[k] === 'string') item[k] = o[k] as string
    for (const k of ['min', 'max', 'step', 'defaultValue'] as const) {
      const v = o[k]
      if (typeof v === 'number' && Number.isFinite(v)) item[k] = v
    }
    out.push(item)
  }
  return out
}

// fire-and-forget requests (the result is not awaited; if there is no server, there is no card either)
function askPost($: EngineInterface, url: string, body: Record<string, unknown>) {
  try {
    void $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
  } catch {
    /* not important if there is no server */
  }
}

// withdraws the card: by id, if the id is not known yet (Esc before the POST /ask reply arrived) by session + tool call id.
// If the answer reached the server but the mod did not use it, the server marks it as "did not reach Claude" (the office warns).
function cancelAsk($: EngineInterface, to: { id: string; tuid: string; sid: string }, reason?: string) {
  if (!to.id && !to.tuid) return
  askPost($, ASK_CANCEL_URL, { id: to.id, tuid: to.tuid, sid: to.sid, ...(reason ? { reason } : {}) })
}

// the mod received the answer and used it (ok) or did not use it: the office's "delivered to Claude / did not reach" depends only on this
function ackAsk($: EngineInterface, qid: string, sessionKey: string, ok: boolean, reason?: string) {
  askPost($, ASK_ACK_URL, { id: qid, sid: sessionKey, ok, ...(reason ? { reason } : {}) })
}

// Number of pending questions and the status line in Claude ($.ui.status is one line per plugin: several questions are written as a count)
let asking = 0
function askStatus($: EngineInterface, delta: number) {
  asking = Math.max(0, asking + delta)
  try {
    $.ui.status(asking === 0 ? undefined : asking === 1 ? ASK_STATUS : asking + ' questions waiting in NorthLight Tower: answer on their cards')
  } catch {
    /* not important if there is no status line (phone / test) */
  }
}

const TIMEOUT = 'timeout'
const ABORTED = 'aborted'

// $.http.fetch has no timeout or cancellation of its own: the request is raced against a $.clock.after timer and a signal.
// If the time runs out it throws Error(TIMEOUT), if the signal is aborted Error(ABORTED). (A request left in the background is ignored when it settles.)
async function within<T>($: EngineInterface, work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: { cancel?: () => void } | undefined
  let onAbort: (() => void) | undefined
  const guard = new Promise<never>((_, reject) => {
    try {
      timer = $.clock.after(ms, () => reject(new Error(TIMEOUT))) as unknown as { cancel?: () => void }
    } catch {
      /* if there is no timer, only the request and the cancellation are awaited */
    }
    if (signal) {
      if (signal.aborted) reject(new Error(ABORTED))
      onAbort = () => reject(new Error(ABORTED))
      signal.addEventListener?.('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([work, guard])
  } finally {
    try {
      timer?.cancel?.()
    } catch {
      /* */
    }
    if (signal && onAbort) signal.removeEventListener?.('abort', onAbort)
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Converts the server's answer list (texts in question order) to the tool's format: QUESTION TEXT (the mod's own, not the server's) -> answer.
// null if the count, type or length does not match: the answer is not accepted and the question is left to Claude's dialog.
function answersFor(texts: string[], raw: unknown): Record<string, string> | null {
  if (!Array.isArray(raw) || raw.length !== texts.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < texts.length; i++) {
    const a = raw[i]
    const q = texts[i]
    if (typeof a !== 'string' || !a.trim() || a.length > ASK_ANS_MAX || q === undefined) return null
    out[q] = a
  }
  return out
}

// Drops the question in the tower and waits for the answer (long polling: while a $.http call is in progress the hook's time budget does not run, $.clock.sleep is not used).
// For every result other than 'answered' the caller opens Claude's own dialog with next(e): server missing / not responding / office not open or visible /
// question format not supported / user said "Answer in Claude" / office closed or left in the background / time ran out / answer broken.
// If the signal is aborted (Esc, a hook above answered first, the mod was reloaded) the card is withdrawn AT ONCE and 'aborted' is returned.
async function askOffice($: EngineInterface, e: AskEvent, signal?: AbortSignal): Promise<AskOutcome> {
  const fallback = (why: unknown): AskOutcome => ({ kind: 'fallback', why: short(why, 120) })
  const qs = normQuestions(e.questions)
  if (!qs) return fallback('question format')
  const texts = qs.map(q => q.question)
  if (!texts.length || texts.some(t => !t) || new Set(texts).size !== texts.length) return fallback('question format')
  if (signal?.aborted) return { kind: 'aborted' }
  const key = await sid($)
  if (!key) return fallback('no session id')
  const tuid = e.tool_use_id ?? ''
  let qid = ''
  let done = false // answer used / question closed: a cancel event after this does not withdraw the card
  let pulled = false // the withdrawal request is sent once
  const pull = (reason: string) => {
    if (pulled) return
    pulled = true
    cancelAsk($, { id: qid, tuid, sid: key }, reason)
  }
  const onAbort = () => {
    if (!done) pull('Question cancelled in Claude')
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  let shown = false
  try {
    let r: { ok: boolean; status: number; text: string }
    try {
      r = await within(
        $,
        $.http.fetch(ASK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sid: key, aid: e.agentId ?? '', tuid, questions: e.questions }),
        }),
        ASK_FETCH_MS,
        signal,
      )
    } catch (err) {
      if (signal?.aborted || errText(err) === ABORTED) {
        pull('Question cancelled in Claude')
        return { kind: 'aborted' }
      }
      // no reply came: the server may have received the question anyway; withdraw it by tool call id (so that the card does not hang in the tower)
      pull('Switched to the Claude window')
      return fallback(errText(err) === TIMEOUT ? 'server did not respond' : 'server is down')
    }
    let d: { ok?: boolean; id?: unknown; reason?: unknown } = {}
    try {
      d = JSON.parse(r.text)
    } catch {
      /* broken reply: it is rejected below */
    }
    if (!r.ok || d.ok !== true || typeof d.id !== 'string' || !d.id) return fallback(d.reason ?? 'server did not accept the question')
    qid = d.id
    shown = true
    askStatus($, +1)
    const start = await $.clock.now()
    let errors = 0
    for (let i = 0; i < ASK_MAX_POLLS; i++) {
      if (signal?.aborted) {
        pull('Question cancelled in Claude')
        return { kind: 'aborted' }
      }
      if ((await $.clock.now()) - start > ASK_TOTAL_MS) {
        pull('Time ran out; the question is in the Claude window')
        return fallback('time ran out')
      }
      let w: { status?: unknown; id?: unknown; answers?: unknown; reason?: unknown }
      try {
        const res = await within($, $.http.fetch(ASK_WAIT_URL + encodeURIComponent(qid) + '&sid=' + encodeURIComponent(key)), ASK_WAIT_MS, signal)
        if (!res.ok) throw new Error('HTTP ' + res.status)
        w = JSON.parse(res.text)
      } catch (err) {
        if (signal?.aborted || errText(err) === ABORTED) {
          pull('Question cancelled in Claude')
          return { kind: 'aborted' }
        }
        // the server may be restarting / not responding: tries once more, otherwise the question goes to Claude
        errors += 1
        if (errors >= 2) {
          pull('Could not reach the tower; the question is in the Claude window')
          return fallback(errText(err) === TIMEOUT ? 'server did not respond' : 'server unreachable')
        }
        continue
      }
      errors = 0
      if (w.status === 'pending') continue
      // the answer is accepted ONLY if it comes with this question's id
      if (w.status === 'answered' && w.id === qid) {
        const answers = answersFor(texts, w.answers)
        done = true
        if (signal?.aborted) {
          // the answer came but Claude is no longer listening: the server marks this as "ulaşmadı" (did not reach), the office warns the user
          pull('Claude stopped listening')
          return { kind: 'aborted' }
        }
        if (!answers) {
          ackAsk($, qid, key, false, "The answer did not match Claude's format; the question is in the Claude window")
          return fallback('bad answer')
        }
        ackAsk($, qid, key, true)
        return { kind: 'answered', questions: qs, answers }
      }
      done = true
      return fallback(w.reason || w.status)
    }
    pull('The question is in the Claude window')
    return fallback('poll limit')
  } finally {
    done = true
    signal?.removeEventListener?.('abort', onAbort)
    if (shown) askStatus($, -1)
  }
}

// Permission question (when Claude asks "do you allow this?") on the question card in the tower: two options, only an EXACT label counts
// (free text / "Answer in Claude" / time running out / error: null -> Claude's own dialog opens). There is deliberately no "Always allow":
// writing a persistent permission rule is not done from the tower, only this single request.
const PERM_ALLOW = 'Allow'
const PERM_DENY = 'Deny'
async function askPermission($: EngineInterface, e: { tool_name?: string; tool_input?: unknown; tool_use_id?: string; agent_id?: string }, signal?: AbortSignal): Promise<'allow' | 'deny' | null> {
  const what = toolLabel(String(e.tool_name ?? '')) + (summarize(String(e.tool_name ?? ''), e.tool_input) ? ': ' + summarize(String(e.tool_name ?? ''), e.tool_input) : '')
  const question = 'Allow this action? ' + short(what, 400)
  const got = await askOffice(
    $,
    {
      questions: [{ question, header: 'Permission', multiSelect: false, options: [{ label: PERM_ALLOW, description: 'For this request only' }, { label: PERM_DENY, description: 'Claude will not run this action' }] }],
      tool_use_id: e.tool_use_id,
      agentId: e.agent_id,
    },
    signal,
  )
  if (got.kind !== 'answered') return null
  const a = got.answers[question]
  return a === PERM_ALLOW ? 'allow' : a === PERM_DENY ? 'deny' : null
}

// for tests (not an engine hook): to test the cancel / timeout paths directly
export const __test = { askOffice, normQuestions, askPermission }

// handles of the polling timers (at module level: so that only one pair remains even if session.start runs again)
type Handle = { cancel?: () => void } | undefined
let pumpTimer: Handle
let namesTimer: Handle

// cancels the installed timers; true = a new one can now be installed (false if there is a handle that cannot be cancelled)
function stopTimers(): boolean {
  for (const h of [pumpTimer, namesTimer]) {
    if (!h) continue
    if (typeof h.cancel !== 'function') return false
    try {
      h.cancel()
    } catch {
      return false
    }
  }
  pumpTimer = undefined
  namesTimer = undefined
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pixel-office', description: 'Open the NorthLight Tower side panel (what the workers are doing)' })
    void $.ui.open({ id: PANE, title: 'NorthLight Tower' })
    void ensureServer($)
    // if session.start runs again (e.g. a new session) so that timers are not doubled: cancel the old ones and install a new one
    // (if they cannot be cancelled the old ones keep running, the new one is not installed)
    if (!stopTimers()) return next(e)
    // if no handle is returned an empty object is put in: stopTimers() counts it as non-cancellable and prevents installing again
    pumpTimer =
      ($.clock.every(2000, () => {
        void pump($)
      }) as unknown as Handle) ?? {}
    namesTimer =
      ($.clock.every(5000, () => {
        void refreshNames($)
      }) as unknown as Handle) ?? {}
    dbg($, 'v0.8.1 session.start: delivery loop and name polling set up')
    return next(e)
  })

  on('command.run', { command: 'pixel-office' }, async $ => {
    await $.ui.open({ id: PANE, title: 'NorthLight Tower' })
    return { text: 'The NorthLight Tower panel is open. For the full office scene, open ' + OFFICE_URL + ' (Start.bat).' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      sessionId = e.session_id
      await update($, actors, map => applyPatch(map, 'main', { state: 'thinking', detail: 'Thinking', target: short(e.prompt, 60), label: short(e.session_title || 'Manager', 28) }))
      post($, { kind: 'state', aid: null, state: 'thinking', detail: 'Thinking', task: short(e.prompt, 160) })
    } catch {
      /* observer: never break the session */
    }
    return next(e)
  })

  // id of the main turn: needed for "Stop" turn.abort (sub-agent turns are ignored)
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainTurn = e.turnId
    return next(e)
  })

  // tool call: engine event (always fires). For a sub-agent's calls e.agentId is filled.
  on('tool.call', async ($, e, next) => {
    // the mod's own "Stop" call (TaskStop) does not count as the agent's work
    if (ownStop > 0 && String(e.tool) === 'TaskStop') return next(e)
    wake($)
    const tool = String(e.tool)
    const aid = (e as { agentId?: string }).agentId
    const id = aid ? aid : 'main'
    const state = stateFor(tool)
    const target = summarize(tool, argsOf(e))
    try {
      await sid($)
      await update($, actors, map =>
        applyPatch(map, id, { state, detail: toolLabel(tool), target, tools: (map[id]?.tools ?? 0) + 1 }, { label: id === 'main' ? 'Manager' : 'Worker' }),
      )
      post($, { kind: 'state', aid: aid ?? null, state, tool, detail: toolLabel(tool), target })
    } catch {
      /* */
    }
    const ran = await next(e)
    try {
      await update($, actors, map => applyPatch(map, id, { state: 'thinking', detail: 'Thinking', target: '' }))
      post($, { kind: 'state', aid: aid ?? null, state: 'thinking', detail: 'Thinking', target: '' })
      // images produced by the tool (e.g. PixelLab) land in the gallery in the office
      const text = (ran as { text?: unknown }).text
      if (text) {
        for (const src of imagesIn(text)) post($, { kind: 'artifact', aid: aid ?? null, path: src, label: tool.split('__').pop() })
      }
      const fp = argsOf(e).file_path
      if ((tool === 'Write' || tool === 'Edit') && typeof fp === 'string' && /\.(png|jpe?g|gif|webp)$/i.test(fp)) {
        post($, { kind: 'artifact', aid: aid ?? null, path: fp, label: base(fp) })
      }
    } catch {
      /* */
    }
    return ran
  })

  // Claude's question (AskUserQuestion): if this hook returns { result } without calling next the engine counts it as the tool's answer and does not open its own
  // dialog (the dialog is drawn in the "core" below next). If no answer comes from the tower, next(e): Claude's dialog opens.
  // Questions of the main agent and of sub-agents go (the server only takes the question of the session this mod is connected to); e.agentId becomes the worker's name on the card.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const got = await askOffice($, e, next.signal)
    if (got.kind === 'answered') {
      dbg($, 'question answered from the tower (' + Object.keys(got.answers).length + ' questions)')
      // result according to the tool's output schema: questions normalized (header / options / multiSelect always present), answers: question text -> answer
      return { result: { questions: got.questions, answers: got.answers } }
    }
    // the user cut the turn / a hook above answered first: this answer is not used, the dialog should not open
    if (got.kind === 'aborted') return { deny: 'Question cancelled' }
    dbg($, "question handed to Claude's dialog: " + got.why)
    return next(e)
  }).catch(($, e, next) => {
    // if the hook fails unexpectedly the card is removed from the tower (the server finds the question by session + tool call id), the question is asked in Claude's
    // own dialog (it is not lost)
    const tuid = e.tool_use_id ?? ''
    if (tuid && sessionId) cancelAsk($, { id: '', tuid, sid: sessionId }, 'Switched to the Claude window')
    return next(e)
  })

  // permission decision: if it takes longer than a few seconds it means a human is being asked -> "onay bekliyor" (waiting for approval)
  on('tool.check', async ($, e, next) => {
    const aid = (e as { agentId?: string }).agentId
    const tool = String(e.tool)
    const target = summarize(tool, e.input)
    let fired = false
    await sid($)
    const timer = $.clock.after(3500, () => {
      fired = true
      post($, { kind: 'state', aid: aid ?? null, state: 'waiting', tool, detail: 'Waiting for approval', target })
    })
    let verdict: Awaited<ReturnType<typeof next>>
    try {
      verdict = await next(e)
    } finally {
      // so that no timer is left even if next throws: a wrong "Waiting for approval" should not go out after 3.5 s
      timer.cancel()
    }
    if (fired) post($, { kind: 'state', aid: aid ?? null, state: 'thinking', detail: 'Thinking', target: '' })
    return verdict
  })

  // sub-agent spawn: its type and description are known here
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      const agentId = (r as { agentId?: string }).agentId
      if (agentId) {
        await sid($)
        await update($, actors, map =>
          applyPatch(map, agentId, { state: 'thinking', detail: 'Started working', label: short(e.subagentType || 'Worker', 24), kind: 'sub', target: short(e.description, 70) }),
        )
        post($, { kind: 'sub_start', aid: agentId, atype: e.subagentType, desc: short(e.description, 80) })
        // fetch the name as soon as the server gives it to the new agent (without waiting for the 5 s polling)
        $.clock.after(1500, () => {
          void refreshNames($)
        })
      }
    } catch {
      /* */
    }
    return r
  })

  // turn over: the agent goes to rest; the sub-agent's reply lands in the chat
  on('turn.complete', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined && e.turnId === mainTurn) mainTurn = ''
    wake($)
    try {
      await sid($)
      const aid = (e as { agentId?: string }).agentId
      const rawAnswer = (e as { answer?: string }).answer
      const answer = chatText(rawAnswer)
      const id = aid ? aid : 'main'
      await update($, actors, map => applyPatch(map, id, { state: 'done', detail: 'Finished', target: '' }))
      post($, { kind: 'state', aid: aid ?? null, state: 'done', detail: aid ? 'Finished' : 'Finished, waiting for your next message' })
      if (answer && (aid || awaitingMain)) {
        post($, { kind: 'reply', aid: aid ?? null, text: answer })
        if (!aid) awaitingMain = false
      }
    } catch {
      /* */
    }
    // panel: the sub-agent's last reply ("Son yanıt (HH:MM)", i.e. Last reply (HH:MM)); the main agent's is not kept
    try {
      const aid = (e as { agentId?: string }).agentId
      const text = short((e as { answer?: string }).answer, REPLY_KEEP)
      if (aid && text) {
        const t = Date.now() / 1000
        await update($, replies, map => withReply(map, aid, { text, t }))
      }
    } catch {
      /* */
    }
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      sessionId = e.session_id
      const id = ident(e)
      const target = summarize(e.tool_name, e.tool_input)
      await update($, actors, map => applyPatch(map, id, { state: 'waiting', detail: 'Waiting for approval: ' + toolLabel(e.tool_name), target }))
      post($, { kind: 'state', aid: e.agent_id ?? null, state: 'waiting', tool: e.tool_name, detail: 'Waiting for approval', target })
    } catch {
      /* */
    }
    // approval from the tower: if an answer comes Claude's dialog does not open; if not (or on any error) it is asked in Claude with next(e)
    try {
      const verdict = await askPermission($, e as never, (next as { signal?: AbortSignal }).signal)
      if (verdict === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } as never
      if (verdict === 'deny') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from the tower' } } } as never
    } catch {
      /* */
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    try {
      sessionId = e.session_id
      if (e.notification_type === 'permission_prompt') {
        await update($, actors, map => applyPatch(map, 'main', { state: 'waiting', detail: 'Waiting for approval', target: short(e.message, 80) }))
        post($, { kind: 'state', aid: null, state: 'waiting', detail: 'Waiting for approval', target: short(e.message, 80) })
      } else if (e.notification_type === 'idle_prompt') {
        await update($, actors, map => applyPatch(map, 'main', { state: 'done', detail: 'Waiting for your turn', target: '' }))
        post($, { kind: 'state', aid: null, state: 'done', detail: 'Finished, waiting for your next message' })
      }
    } catch {
      /* */
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    try {
      sessionId = e.session_id
      await update($, actors, map => applyPatch(map, 'main', { state: 'done', detail: 'Finished', target: '' }))
      post($, { kind: 'state', aid: null, state: 'done', detail: 'Finished, waiting for your next message' })
    } catch {
      /* */
    }
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    try {
      sessionId = e.session_id
      await update($, actors, map => applyPatch(map, e.agent_id, { state: 'thinking', detail: 'Started working', label: short(e.agent_type, 24), kind: 'sub' }))
      post($, { kind: 'sub_start', aid: e.agent_id, atype: e.agent_type })
      $.clock.after(1500, () => {
        void refreshNames($)
      })
    } catch {
      /* */
    }
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    try {
      sessionId = e.session_id
      await update($, actors, map => applyPatch(map, e.agent_id, { state: 'done', detail: 'Finished', target: short(e.last_assistant_message, 70) }))
      post($, { kind: 'sub_stop', aid: e.agent_id, atype: e.agent_type })
    } catch {
      /* */
    }
    return next(e)
  })

  on('classic.SessionEnd', async ($, e, next) => {
    try {
      await update($, actors, () => ({}))
      post($, { kind: 'end' })
    } catch {
      /* */
    }
    // panel: with the session, the last replies, the selection, the draft and the status line are reset too
    try {
      await update($, replies, () => ({}))
      await update($, selected, () => '')
      await update($, names, () => ({}))
      await update($, sendSeq, n => n + 1)
      await update($, sendStatus, () => IDLE)
      mainTurn = ''
    } catch {
      /* */
    }
    // let the new session start clean: the direct-send block, the main worker's waiting flag and the session id are reset
    directBlocked = false
    directBlockedAt = 0
    blockedSends = 0
    awaitingMain = false
    sessionId = ''
    paneSending = false
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    // The panel may also be redrawn on agent events (tool call, end of turn...) while typing. Since typed letters are not written to an atom and
    // no value is given to Input, a redraw must not spoil the text (this behavior was not verified live on the host).
    const [map, replyMap, chosen, who, seq, status, nowMs] = await Promise.all([
      read($, actors),
      read($, replies),
      read($, selected),
      read($, names),
      read($, sendSeq),
      read($, sendStatus),
      $.clock.now(),
    ])
    const now = nowMs / 1000
    const list = Object.values(map)
      .filter(a => !(a.kind === 'sub' && a.state === 'done' && now - a.updated > 3600))
      .sort((a, b) => (a.kind === b.kind ? a.since - b.since : a.kind === 'main' ? -1 : 1))

    const count = (f: (a: Actor) => boolean) => list.filter(f).length
    const working = count(a => a.state !== 'done' && a.state !== 'waiting')
    const waiting = count(a => a.state === 'waiting')
    const resting = count(a => a.state === 'done')

    // "Message a worker": Input and Select do not exist on the phone surface, only a note is shown there
    const subs = subsOf(map)
    const target = targetOf(map, chosen)
    const reply = target ? replyMap[target] : undefined
    const statusColor = status.kind === 'ok' ? '#46e0a0' : status.kind === 'error' ? '#ff4d6a' : '#8c86b8'
    let compose: RenderElement
    if (e.surface === 'mobile') {
      compose = <Text dimColor>The message box is not available on this screen; use it in the desktop app or in the terminal.</Text>
    } else if (subs.length === 0) {
      compose = <Text dimColor>No workers yet</Text>
    } else {
      const { Input, Select } = $.ui.resolve(e)
      compose = (
        <Box flexDirection="column" gap={1}>
          <Select
            key="agent"
            label="Worker"
            options={optionsOf(subs, who)}
            value={target}
            onSelect={picked => {
              void update($, selected, () => picked)
            }}
          />
          {/* no value is given (the box keeps its own text); the only send path is Enter / Input's own "gönder" (send) button.
              When delivery succeeds seq increases, the key changes, the box opens empty; if it fails the text stays in the box. */}
          <Input
            key={MSG_KEY + seq}
            placeholder="Write your message…"
            submitLabel="send"
            onSubmit={text => {
              void sendFromPane($, text)
            }}
          />
          {status.kind !== 'idle' && <Text color={statusColor}>{status.text}</Text>}
          {reply && <Text dimColor>{`Last reply (${hhmm(reply.t)}): ${short(reply.text, REPLY_SHOW)}`}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Box gap={2}>
          <Text bold color="#3df2ff">NORTHLIGHT TOWER</Text>
          {working > 0 && <Text color="#46e0a0">● {working} working</Text>}
          {waiting > 0 && <Text color="#ff4d6a">● {waiting} waiting for approval</Text>}
          {resting > 0 && <Text color="#8c86b8">● {resting} done</Text>}
        </Box>
        {list.length === 0 && <Text dimColor>Nothing is happening right now. Workers will appear here when you give a task.</Text>}
        {list.map(a => (
          <Box key={a.id} flexDirection="column" borderStyle="round" borderColor={STATE_COLOR[a.state]} paddingX={1}>
            <Box gap={1} justifyContent="space-between">
              <Text bold wrap="truncate-end">{(a.kind === 'sub' ? '• ' : '') + titleOf(a, who[a.id])}</Text>
              <Text color={STATE_COLOR[a.state]}>
                {STATE_TR[a.state]} · {clock(a.since)}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">{a.detail}{a.target ? ' · ' + a.target : ''}</Text>
          </Box>
        ))}
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="#8c86b8" paddingX={1}>
          <Text bold color="#3df2ff">Message a worker</Text>
          {compose}
        </Box>
        <Link href={OFFICE_URL} label="Open the Pixel Office scene ↗" />
      </Box>
    )
  })
}
