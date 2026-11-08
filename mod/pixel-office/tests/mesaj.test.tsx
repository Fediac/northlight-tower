import { expect, mock, test } from 'claude-code/testing'

type Fetch = { url: string; method?: string; body?: string; init?: { method?: string; body?: string } }
type SendResult = { isDelivered: true } | { isDelivered: false; reason: string }

const REFUSAL = 'The server-side auto mode classifier gave no verdict for SendMessage: the request that produced this action did not ask for one.'

type Opts = { toolCall?: 'ok' | 'deny' | 'error' | 'throw'; abortThrows?: string; toolText?: string }

function setup($: any, on: any, items: unknown[], sendResult: SendResult = { isDelivered: true }, opts: Opts = {}) {
  const fetched: Fetch[] = []
  const tools: Array<{ tool: string; task_id?: string }> = []
  const aborted: string[] = []
  const sent: Array<{ to: unknown; text: string }> = []
  const prompts: Array<{ text: string; asUser?: boolean }> = []
  // the server's outbox queue: emptied once per poll (more can be added later with enqueue)
  const queue: unknown[] = [...items]
  let current: SendResult = sendResult
  on('command.register', () => ({ value: { command: 'pixel-office' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'oturum-1' }))
  on('http.fetch', (_: unknown, e: Fetch) => {
    fetched.push({ url: e.url, method: e.init?.method ?? e.method, body: e.init?.body ?? e.body })
    if (e.url.includes('/outbox')) {
      const out = queue.splice(0)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: out }) } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.send', (_: unknown, e: { to: unknown; text: string }) => {
    sent.push({ to: e.to, text: e.text })
    return current
  })
  on('prompt.submit', (_: unknown, e: { text: string; origin?: { asUser?: boolean } }) => {
    prompts.push({ text: e.text, asUser: e.origin?.asUser })
    return { text: e.text }
  })
  // Stop: the TaskStop call (the mod's own $.tool.call) and the cutting of the main turn
  on('tool.call', (_: unknown, e: { tool: string; task_id?: string }) => {
    tools.push({ tool: e.tool, task_id: e.task_id })
    if (opts.toolCall === 'deny') return { deny: 'permission denied' }
    if (opts.toolCall === 'error') return { isError: true, result: 'No task found', text: 'No task found' }
    if (opts.toolCall === 'throw') throw new Error('tool failed')
    if (opts.toolText !== undefined) return { result: {}, text: opts.toolText }
    return { result: { message: 'stopped', task_id: e.task_id, task_type: 'agent' } }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.abort', (_: unknown, e: { turnId: string }) => {
    if (opts.abortThrows) throw new Error(opts.abortThrows)
    aborted.push(e.turnId)
    return { value: undefined }
  })
  const clock = mock.clock(on)
  return {
    fetched,
    sent,
    prompts,
    tools,
    aborted,
    clock,
    enqueue: (...more: unknown[]) => void queue.push(...more),
    setSend: (r: SendResult) => void (current = r),
  }
}

async function run($: any, t: ReturnType<typeof setup>) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await t.clock.advance(2100)
  await t.clock.settle()
  await t.clock.advance(100)
  await t.clock.settle()
}

test('alt ajana mesaj iletilir ve teslim onayı sunucuya gider', async ($, on) => {
  const t = setup($, on, [{ id: 'm1', kind: 'sub', aid: 'abc123', text: 'rengi maviye çevir' }])
  await run($, t)

  expect(t.sent.length).toBe(1)
  expect(JSON.stringify(t.sent[0]?.to)).toContain('abc123')
  expect(t.sent[0]?.text).toContain('rengi maviye çevir')
  expect(t.prompts.length).toBe(0)
  const ack = t.fetched.find(f => f.url.endsWith('/ack'))
  expect(ack?.body).toContain('"ok":true')
})

test('ana ajana mesaj, kullanıcının kendi sözleri olarak gider', async ($, on) => {
  const t = setup($, on, [{ id: 'm2', kind: 'main', aid: '', text: 'işler nasıl gidiyor?' }])
  await run($, t)

  expect(t.prompts.length).toBe(1)
  expect(t.prompts[0]?.text).toContain('işler nasıl gidiyor?')
})

test('permission check refuses direct delivery: the message goes through the manager', async ($, on) => {
  const t = setup($, on, [{ id: 'm3', kind: 'sub', aid: 'abc123', text: 'tekrar dene' }], { isDelivered: false, reason: REFUSAL })
  await run($, t)

  expect(t.sent.length).toBe(1)
  expect(t.prompts.length).toBe(1)
  const p = t.prompts[0]?.text ?? ''
  expect(p).toContain('SendMessage')
  expect(p).toContain('abc123')
  expect(p).toContain('tekrar dene')
  const ack = t.fetched.find(f => f.url.endsWith('/ack'))
  expect(ack?.body).toContain('"ok":true')
  expect(ack?.body).toContain('via the manager')
})

test('başka bir nedenle reddedilen gönderim hata olarak bildirilir, ana ajana yönlendirilmez', async ($, on) => {
  const t = setup($, on, [{ id: 'm4', kind: 'sub', aid: 'abc123', text: 'merhaba' }], { isDelivered: false, reason: 'Ajan bulunamadı' })
  await run($, t)

  expect(t.prompts.length).toBe(0)
  const ack = t.fetched.find(f => f.url.endsWith('/ack'))
  expect(ack?.body).toContain('"ok":false')
  expect(ack?.body).toContain('Ajan bulunamadı')
})

function ackOf(t: ReturnType<typeof setup>) {
  return JSON.parse(t.fetched.filter(f => f.url.endsWith('/ack')).at(-1)?.body ?? '{}')
}

test('the frame sent to a sub-agent carries a plain English reply request', async ($, on) => {
  const t = setup($, on, [{ id: 'm5', kind: 'sub', aid: 'abc123', text: 'rengi maviye çevir' }])
  await run($, t)
  expect(t.sent[0]?.text).toContain("starting with 'SUMMARY:'")
  expect(t.sent[0]?.text).toContain('avoid technical jargon')
  // the user's text is inside the frame, the request comes after it
  expect((t.sent[0]?.text ?? '').indexOf('rengi maviye çevir')).toBeLessThan((t.sent[0]?.text ?? '').indexOf('SUMMARY:'))
})

test('ana ajana giden metne yanıt isteği EKLENMEZ', async ($, on) => {
  const m = setup($, on, [{ id: 'm6', kind: 'main', aid: '', text: 'işler nasıl?' }])
  await run($, m)
  expect(m.prompts[0]?.text).toBe('[NorthLight Tower chat] işler nasıl?')
})

test('Durdur (ana ajan): çalışan ana tur turn.abort ile kesilir, ack "turn stopped"', async ($, on) => {
  const t = setup($, on, [{ id: 'x1', kind: 'stop', aid: '', text: '' }])
  await $.turn.start({ text: 'uzun iş', turnId: 'tur-1' })
  await $.turn.start({ text: 'alt ajanın turu', turnId: 'tur-alt', agentId: 'abc123' }) // sub-agent turn is ignored
  await run($, t)
  expect(t.aborted).toEqual(['tur-1'])
  expect(t.tools.length).toBe(0)
  expect(t.sent.length).toBe(0)
  const ack = ackOf(t)
  expect(ack.id).toBe('x1')
  expect(ack.ok).toBe(true)
  expect(ack.reason).toBe('turn stopped')
})

test('Durdur (ana ajan): çalışan tur yoksa ya da tur bitmişse "already stopped"', async ($, on) => {
  const t = setup($, on, [{ id: 'x2', kind: 'stop', aid: '', text: '' }])
  await run($, t)
  expect(t.aborted.length).toBe(0)
  expect(ackOf(t).ok).toBe(true)
  expect(ackOf(t).reason).toBe('already stopped')
})

test('Durdur (ana ajan): tur bu arada bitmişse "already stopped", abort çağrılmaz', async ($, on) => {
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const u = setup($, on, [{ id: 'x3', kind: 'stop', aid: '', text: '' }])
  await $.turn.start({ text: 'iş', turnId: 'tur-2' })
  await $.turn.complete({ answer: 'bitti', durationMs: 1, isAborted: false, turnId: 'tur-2', reason: 'answer' })
  await run($, u)
  expect(u.aborted.length).toBe(0)
  expect(ackOf(u).reason).toBe('already stopped')
})

test('Durdur (ana ajan): abort hata verirse ack ok:false ve neden', async ($, on) => {
  const t = setup($, on, [{ id: 'x4', kind: 'stop', aid: '', text: '' }], { isDelivered: true }, { abortThrows: 'abort kapalı' })
  await $.turn.start({ text: 'iş', turnId: 'tur-3' })
  await run($, t)
  expect(ackOf(t).ok).toBe(false)
  expect(ackOf(t).reason.length).toBeGreaterThan(0)
})

test('Durdur (alt ajan): TaskStop çağrılır, ack "TaskStop"; mesaj gönderilmez', async ($, on) => {
  const t = setup($, on, [{ id: 'x5', kind: 'stop', aid: 'abc123', text: '' }])
  await run($, t)
  expect(t.tools).toEqual([{ tool: 'TaskStop', task_id: 'abc123' }])
  expect(t.sent.length).toBe(0)
  expect(t.prompts.length).toBe(0)
  expect(ackOf(t).ok).toBe(true)
  expect(ackOf(t).reason).toBe('TaskStop')
})

for (const mode of ['deny', 'error', 'throw'] as const) {
  test(`Durdur (alt ajan): TaskStop ${mode} olursa "STOP" mesajı gönderilir, ack "by message"`, async ($, on) => {
    const t = setup($, on, [{ id: 'x6', kind: 'stop', aid: 'abc123', text: '' }], { isDelivered: true }, { toolCall: mode })
    await run($, t)
    expect(t.tools.length).toBe(1)
    expect(t.sent.length).toBe(1)
    expect(JSON.stringify(t.sent[0]?.to)).toContain('abc123')
    expect(t.sent[0]?.text).toContain('STOP: drop what you are doing')
    expect(t.sent[0]?.text).not.toContain('SUMMARY:')
    expect(ackOf(t).ok).toBe(true)
    expect(ackOf(t).reason).toBe('by message')
  })
}

test('Durdur (alt ajan): mesaj da izin denetimine takılırsa ana ajan aracılığıyla (denetim aşılmaz)', async ($, on) => {
  const t = setup($, on, [{ id: 'x7', kind: 'stop', aid: 'abc123', text: '' }], { isDelivered: false, reason: REFUSAL }, { toolCall: 'deny' })
  await run($, t)
  expect(t.sent.length).toBe(1)
  expect(t.prompts.length).toBe(1)
  expect(t.prompts[0]?.text).toContain('SendMessage')
  expect(t.prompts[0]?.text).toContain('STOP:')
  expect(ackOf(t).ok).toBe(true)
  // a worker running via the main worker is not stopped yet: the ack says this honestly
  expect(ackOf(t).reason).toBe('STOP request passed to the manager (it will see it on its next step)')
})

test('Durdur (alt ajan): TaskStop de mesaj da başarısızsa ack ok:false ve neden', async ($, on) => {
  const u = setup($, on, [{ id: 'x8', kind: 'stop', aid: 'abc123', text: '' }], { isDelivered: false, reason: 'Ajan bulunamadı' }, { toolCall: 'error' })
  await run($, u)
  expect(u.prompts.length).toBe(0)
  expect(ackOf(u).ok).toBe(false)
  expect(ackOf(u).reason).toContain('Ajan bulunamadı')
})

// ---------------------------------------------------------------------------------------------
// v0.7.1 fixes
// ---------------------------------------------------------------------------------------------

function hookBodies(t: ReturnType<typeof setup>, kind: string) {
  return t.fetched
    .filter(f => f.url.endsWith('/hook') && f.body?.includes('"kind":"' + kind + '"'))
    .map(f => JSON.parse(f.body ?? '{}') as { text?: string; aid?: string | null })
}

async function subAnswer($: any, text: string) {
  await $.turn.complete({ answer: text, durationMs: 5, isAborted: false, turnId: 't-alt', reason: 'answer', agentId: 'abc123' })
}

test('sohbete giden yanıt satır sonlarını ve liste işaretlerini korur', async ($, on) => {
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ans = 'ÖZET: tamam\n\n- bir\n- iki'
  await subAnswer($, ans)
  const reply = hookBodies(t, 'reply')
  expect(reply.length).toBe(1)
  expect(reply[0]?.aid).toBe('abc123')
  expect(reply[0]?.text).toBe(ans)
  expect(reply[0]?.text).toContain('\n')
})

test('sohbete giden yanıtta CRLF satır sonuna çevrilir, baştaki/sondaki boşluk atılır', async ($, on) => {
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await subAnswer($, '\r\n  ÖZET: tamam\r\nikinci satır  \r\n')
  expect(hookBodies(t, 'reply')[0]?.text).toBe('ÖZET: tamam\nikinci satır')
})

test('sohbete giden yanıt 4000 karakterde kırpılır (1500 değil)', async ($, on) => {
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await subAnswer($, 'x'.repeat(5000))
  expect(hookBodies(t, 'reply')[0]?.text?.length).toBe(4000)
  await subAnswer($, 'y'.repeat(3000))
  expect(hookBodies(t, 'reply')[1]?.text?.length).toBe(3000)
})

test('Durdur (alt ajan): çalışan zaten bitmişse TaskStop de "STOP" mesajı da denenmez, ack "already stopped"', async ($, on) => {
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [{ id: 'x9', kind: 'stop', aid: 'abc123', text: '' }], { isDelivered: true }, { toolCall: 'error' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await subAnswer($, 'bitti') // sub-agent turn finished -> state "done"
  await t.clock.advance(2100)
  await t.clock.settle()
  expect(t.tools.length).toBe(0)
  expect(t.sent.length).toBe(0)
  expect(t.prompts.length).toBe(0)
  expect(ackOf(t).id).toBe('x9')
  expect(ackOf(t).ok).toBe(true)
  expect(ackOf(t).reason).toBe('already stopped')
})

test('Durdur (alt ajan): çalışırken TaskStop denenir (bitmiş değilse davranış aynı)', async ($, on) => {
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [{ id: 'x10', kind: 'stop', aid: 'abc123', text: '' }], { isDelivered: true }, { toolCall: 'error' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await t.clock.advance(2100)
  await t.clock.settle()
  expect(t.tools.length).toBe(1)
  expect(t.sent.length).toBe(1)
  expect(ackOf(t).reason).toBe('by message')
})

const SEND_REFUSED: SendResult = { isDelivered: false, reason: REFUSAL }
const sub = (id: string, text = 'selam') => ({ id, kind: 'sub', aid: 'abc123', text })

async function tick($: any, t: ReturnType<typeof setup>, ms = 2100) {
  await t.clock.advance(ms)
  await t.clock.settle()
}

test('doğrudan gönderim engeli süresiz kalmaz: 5 mesaj sonra yeniden denenir', async ($, on) => {
  const t = setup($, on, [sub('d1')], SEND_REFUSED)
  await run($, t)
  expect(t.sent.length).toBe(1)
  expect(t.prompts.length).toBe(1)

  // permission fixed: the next 4 messages still go via the main worker (the block continues), the 5th is tried directly
  t.setSend({ isDelivered: true })
  for (const n of [2, 3, 4, 5]) {
    t.enqueue(sub('d' + n))
    await tick($, t)
  }
  expect(t.sent.length).toBe(1)
  expect(t.prompts.length).toBe(5)
  t.enqueue(sub('d6'))
  await tick($, t)
  expect(t.sent.length).toBe(2)
  expect(t.prompts.length).toBe(5)
  expect(ackOf(t).ok).toBe(true)
  expect(ackOf(t).reason).toBe('')
  // the direct path stayed open
  t.enqueue(sub('d7'))
  await tick($, t)
  expect(t.sent.length).toBe(3)
  expect(t.prompts.length).toBe(5)
})

test('doğrudan gönderim engeli 10 dakika sonra yeniden denenir', async ($, on) => {
  const t = setup($, on, [sub('e1')], SEND_REFUSED)
  await run($, t)
  expect(t.prompts.length).toBe(1)
  t.setSend({ isDelivered: true })

  t.enqueue(sub('e2'))
  await tick($, t)
  expect(t.sent.length).toBe(1) // the block continues
  expect(t.prompts.length).toBe(2)

  await t.clock.advance(10 * 60 * 1000)
  await t.clock.settle()
  t.enqueue(sub('e3'))
  await tick($, t)
  expect(t.sent.length).toBe(2) // time ran out: direct was tried
  expect(t.prompts.length).toBe(2)
})

test('hâlâ reddediliyorsa engel yeniden kurulur ve yeniden sayılır', async ($, on) => {
  const t = setup($, on, [sub('f1')], SEND_REFUSED)
  await run($, t)
  for (const n of [2, 3, 4, 5]) {
    t.enqueue(sub('f' + n))
    await tick($, t)
  }
  expect(t.sent.length).toBe(1)
  t.enqueue(sub('f6')) // retry, rejected again -> via the main worker
  await tick($, t)
  expect(t.sent.length).toBe(2)
  expect(t.prompts.length).toBe(6)
  t.enqueue(sub('f7')) // the block was set up again: direct is not tried
  await tick($, t)
  expect(t.sent.length).toBe(2)
  expect(t.prompts.length).toBe(7)
})

test('SessionEnd doğrudan gönderim engelini sıfırlar', async ($, on) => {
  on('classic.SessionEnd', () => ({}))
  const t = setup($, on, [sub('g1')], SEND_REFUSED)
  await run($, t)
  expect(t.prompts.length).toBe(1)
  t.setSend({ isDelivered: true })
  await $.classic.SessionEnd({ reason: 'clear' })
  t.enqueue(sub('g2'))
  await tick($, t)
  expect(t.sent.length).toBe(2)
  expect(t.prompts.length).toBe(1)
  expect(ackOf(t).ok).toBe(true)
})

test('SessionEnd ana çalışan bekleme bayrağını sıfırlar: yeni oturumda eski bayrak yanıtı sohbete düşürmez', async ($, on) => {
  on('classic.SessionEnd', () => ({}))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [{ id: 'm9', kind: 'main', aid: '', text: 'selam' }])
  await run($, t) // awaitingMain = true
  await $.classic.SessionEnd({ reason: 'clear' })
  await $.turn.complete({ answer: 'başka bir yanıt', durationMs: 1, isAborted: false, turnId: 't-ana', reason: 'answer' })
  expect(hookBodies(t, 'reply').length).toBe(0)
})

test('session.start iki kez çalışsa da yoklama zamanlayıcıları ikiye katlanmaz', async ($, on) => {
  const t = setup($, on, [])
  const outbox = () => t.fetched.filter(f => f.url.includes('/outbox')).length
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await t.clock.advance(4100)
  await t.clock.settle()
  const twice = outbox()
  // how many requests would a single setup send in the same time? (separate test below for comparison: every 2 s => 2 requests)
  expect(twice).toBe(2)
})

test('session.start bir kez çalışınca 4 sn içinde 2 outbox isteği gider (karşılaştırma)', async ($, on) => {
  const t = setup($, on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await t.clock.advance(4100)
  await t.clock.settle()
  expect(t.fetched.filter(f => f.url.includes('/outbox')).length).toBe(2)
})

// ---------------------------------------------------------------------------------------------
// v0.7.3: the polling address reports the version so that the server does not send Stop to an old plugin
// ---------------------------------------------------------------------------------------------

test('yoklama adresi eklenti sürümünü bildirir (mv=0.8.1)', async ($, on) => {
  const t = setup($, on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await t.clock.advance(2100)
  await t.clock.settle()
  const polls = t.fetched.filter(f => f.url.includes('/outbox'))
  expect(polls.length).toBeGreaterThan(0)
  expect(polls[0].url).toContain('mv=0.8.1')
  expect(polls[0].url).toContain('sid=')
})

// ---------------------------------------------------------------------------------------------
// v0.7.2 fixes
// ---------------------------------------------------------------------------------------------

// a lone surrogate (high or low) is escaped in JSON like \ud83c; the server cannot convert it to UTF-8
function hasLoneSurrogate(s: string) {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)
}
const ESC_SURROGATE = /\\ud[89ab][0-9a-f]{2}/i

test('sohbete giden yanıt 4000 sınırında emojiyi ortadan bölmez', async ($, on) => {
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await subAnswer($, 'a'.repeat(3999) + '🎮' + 'son') // emoji between 3999-4000: the cut falls in the middle
  await subAnswer($, 'a'.repeat(3998) + '🎮' + 'son') // the emoji fits exactly (3998 + 2 = 4000)
  const r = hookBodies(t, 'reply')
  expect(r.length).toBe(2)
  const a = r[0]?.text ?? ''
  expect(hasLoneSurrogate(a)).toBe(false)
  expect(JSON.stringify(a)).not.toMatch(ESC_SURROGATE)
  expect(a).toBe('a'.repeat(3999))
  const b = r[1]?.text ?? ''
  expect(hasLoneSurrogate(b)).toBe(false)
  expect(b).toBe('a'.repeat(3998) + '🎮')
  // none of the sent bodies has a lone surrogate escape
  for (const f of t.fetched.filter(f => f.url.endsWith('/hook'))) expect(f.body ?? '').not.toMatch(ESC_SURROGATE)
})

test('görev özeti (short, 160) emojiyi ortadan bölmez', async ($, on) => {
  on('classic.UserPromptSubmit', () => ({}))
  const t = setup($, on, [])
  await $.classic.UserPromptSubmit({ session_id: 'oturum-1', prompt: 'b'.repeat(158) + '🎮' + ' devamı var', session_title: 'x' })
  await t.clock.settle()
  const st = hookBodies(t, 'state') as Array<{ task?: string }>
  const task = st.find(s => s.task)?.task ?? ''
  expect(hasLoneSurrogate(task)).toBe(false)
  expect(JSON.stringify(task)).not.toMatch(ESC_SURROGATE)
  expect(task).toBe('b'.repeat(158) + '…')
})

test('görev özeti emoji sınırdan önce biterse korunur', async ($, on) => {
  on('classic.UserPromptSubmit', () => ({}))
  const t = setup($, on, [])
  await $.classic.UserPromptSubmit({ session_id: 'oturum-1', prompt: 'b'.repeat(157) + '🎮' + ' devamı var', session_title: 'x' })
  await t.clock.settle()
  const st = hookBodies(t, 'state') as Array<{ task?: string }>
  expect(st.find(s => s.task)?.task).toBe('b'.repeat(157) + '🎮…')
})

test('artifact olayı yolu "path" ile gönderir; zarfın src alanı "mod" kalır', async ($, on) => {
  const t = setup($, on, [], { isDelivered: true }, { toolText: 'bitti [Image: source: C:/proje/gorsel.png]' })
  await $.tool.call({ tool: 'mcp__pixellab__create_character' })
  await t.clock.settle()
  const art = hookBodies(t, 'artifact') as Array<{ path?: string; src?: string; v?: number; label?: string }>
  expect(art.length).toBeGreaterThan(0)
  expect(art[0]?.path).toBe('C:/proje/gorsel.png')
  expect(art[0]?.src).toBe('mod')
  expect(art[0]?.v).toBe(1)
  expect(art[0]?.label).toBe('create_character')
})

test('Write ile yazılan görsel de artifact olarak path taşır, src "mod" kalır', async ($, on) => {
  const t = setup($, on, [], { isDelivered: true }, { toolText: '' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proje/resim.png' })
  await t.clock.settle()
  const art = hookBodies(t, 'artifact') as Array<{ path?: string; src?: string }>
  expect(art[0]?.path).toBe('C:/proje/resim.png')
  expect(art[0]?.src).toBe('mod')
})

test('tool.check: next firlatırsa zamanlayıcı iptal edilir, 3,5 sn sonra yanlış "Waiting for approval" gitmez', async ($, on) => {
  const t = setup($, on, [])
  on('tool.check', () => {
    throw new Error('karar verilemedi')
  })
  let threw = false
  try {
    await $.tool.check({ tool: 'Bash', input: { command: 'dir' } })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  await t.clock.advance(4000)
  await t.clock.settle()
  const waiting = (hookBodies(t, 'state') as Array<{ state?: string }>).filter(s => s.state === 'waiting')
  expect(waiting.length).toBe(0)
})

test('tool.check: karar 3,5 sn içinde gelmezse "Waiting for approval" gider (davranış korunur)', async ($, on) => {
  const t = setup($, on, [])
  let release: () => void = () => {}
  on('tool.check', async () => {
    await new Promise<void>(r => (release = r))
    return { decision: 'allow' }
  })
  const p = $.tool.check({ tool: 'Bash', input: { command: 'dir' } })
  await t.clock.advance(4000)
  await t.clock.settle()
  const waiting = (hookBodies(t, 'state') as Array<{ state?: string; detail?: string }>).filter(s => s.state === 'waiting')
  expect(waiting.length).toBe(1)
  expect(waiting[0]?.detail).toBe('Waiting for approval')
  release()
  await p
})

test('geçersiz çalışan kimliği yedek istemin içine gömülmez: ack "Invalid worker"', async ($, on) => {
  const t = setup($, on, [{ id: 'k1', kind: 'sub', aid: 'abc" ; rm -rf', text: 'selam' }], SEND_REFUSED)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await tick($, t)
  expect(t.sent.length).toBe(1)
  expect(t.prompts.length).toBe(0)
  expect(ackOf(t).ok).toBe(false)
  expect(ackOf(t).reason).toBe('Invalid worker')
})

test('fallback prompt says "worker", not "sub-agent"', async ($, on) => {
  const t = setup($, on, [sub('k2')], SEND_REFUSED)
  await run($, t)
  expect(t.prompts.length).toBe(1)
  expect(t.prompts[0]?.text).toContain('wrote a message to a worker')
  expect(t.prompts[0]?.text).not.toContain('sub-agent')
  expect(t.prompts[0]?.text).toContain('to: "abc123"')
})

test('Durdur (ana çalışan): tur kimliği yok ama çalışan hâlâ çalışıyor görünüyorsa "already stopped" denmez', async ($, on) => {
  const t = setup($, on, [{ id: 'x20', kind: 'stop', aid: '', text: '' }])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proje/a.js', old_string: 'a', new_string: 'b' }) // the mod was loaded in the meantime: turn.start was not seen
  await run($, t)
  expect(t.aborted.length).toBe(0)
  expect(ackOf(t).id).toBe('x20')
  expect(ackOf(t).ok).toBe(false)
  expect(ackOf(t).reason).toBe('You need to stop it from the Claude window')
})

test('Durdur (ana çalışan): gerçekten bitmişse (classic.Stop) "already stopped"', async ($, on) => {
  on('classic.Stop', () => ({}))
  const t = setup($, on, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proje/a.js', old_string: 'a', new_string: 'b' })
  await $.classic.Stop({ session_id: 'oturum-1' })
  t.enqueue({ id: 'x21', kind: 'stop', aid: '', text: '' }) // a tool call triggers polling: the request comes only after the work is done
  await run($, t)
  expect(ackOf(t).ok).toBe(true)
  expect(ackOf(t).reason).toBe('already stopped')
})

test('status texts: "Waiting for approval" and "Finished" are the single wording', async ($, on) => {
  on('classic.PermissionRequest', () => ({}))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  const t = setup($, on, [])
  await $.classic.PermissionRequest({ session_id: 'oturum-1', tool_name: 'Bash', tool_input: { command: 'dir' } })
  await subAnswer($, 'tamam')
  await t.clock.settle()
  const all = t.fetched.filter(f => f.url.endsWith('/hook')).map(f => f.body ?? '').join('\n')
  expect(all).not.toContain('Waiting for approval from you')
  expect(all).not.toContain('Finished the task')
  expect(all).toContain('"detail":"Waiting for approval"')
  expect(all).toContain('"detail":"Finished"')
})

// File attachments: the server writes each attachment on its own line as '[Ek: ad="<ad>" (<tür>, <boyut>) yol="<tam yol>"]' (Turkish attachment line: name, type, size, path; server.py attach_line)
// and gives the real attachment count in the "files" field of the outbox item. The frame must not break these lines: line by line as they are, at line start;
// if files > 0 a single explanatory sentence is added (a line like "[Ek:" in the text is not looked at).
const EK_IMG = '[Ek: ad="Ekran görüntüsü (3).png" (görsel, 240 KB) yol="C:\\Users\\me\\Documents\\NorthLightTower\\_cache\\yuklemeler\\oturum-1\\0123456789ab_Ekran görüntüsü (3).png"]'
const EK_VID =
  '[Ek: ad="klip.mp4" (video, 3,2 MB) yol="C:\\Users\\me\\Documents\\NorthLightTower\\_cache\\yuklemeler\\oturum-1\\abcdefabcdef_klip.mp4"] Not: doğrudan okunamaz; içeriği ffmpeg ile kare/ses çıkararak ya da yazıya çevirerek işle.'
const linesOf = (s: string | undefined) => (s ?? '').split('\n')

test('ekli mesaj (alt ajan): ek satırları satır satır aynen gider, açıklama ve yanıt isteği sonda', async ($, on) => {
  const text = 'şu ekran görüntüsüne bak\n\n' + EK_IMG + '\n' + EK_VID
  const t = setup($, on, [{ id: 'e1', kind: 'sub', aid: 'abc123', text, files: 2 }])
  await run($, t)
  const out = t.sent[0]?.text ?? ''
  expect(linesOf(out)).toContain(EK_IMG)
  expect(linesOf(out)).toContain(EK_VID)
  expect(out).toContain(text)
  expect(out).toContain('with the Read tool')
  // the user's text and the attachments first, the requests after
  expect(out.indexOf(EK_VID)).toBeLessThan(out.indexOf('with the Read tool'))
  expect(out.indexOf('with the Read tool')).toBeLessThan(out.indexOf("'SUMMARY:'"))
  expect(ackOf(t).ok).toBe(true)
})

test('ekli mesaj (ana ajan): ek satırları bozulmaz, açıklama cümlesi sonda', async ($, on) => {
  const text = 'bunu düzelt\n\n' + EK_IMG
  const t = setup($, on, [{ id: 'e2', kind: 'main', aid: '', text, files: 1 }])
  await run($, t)
  const p = t.prompts[0]?.text ?? ''
  expect(p.startsWith('[NorthLight Tower chat] bunu düzelt\n\n' + EK_IMG)).toBe(true)
  expect(linesOf(p)).toContain(EK_IMG)
  expect(p).toContain('with the Read tool')
})

test('yalnız dosya (ana ajan): önek ayrı satırda, ek satırı satır başında kalır', async ($, on) => {
  const t = setup($, on, [{ id: 'e3', kind: 'main', aid: '', text: EK_IMG + '\n' + EK_VID, files: 2 }])
  await run($, t)
  const p = t.prompts[0]?.text ?? ''
  expect(linesOf(p)[0]).toBe('[NorthLight Tower chat]')
  expect(linesOf(p)[1]).toBe(EK_IMG)
  expect(linesOf(p)[2]).toBe(EK_VID)
})

test('ekli mesaj ana ajan aracılığıyla iletilirken de (izin reddi) ek satırları aynen kalır', async ($, on) => {
  const text = 'bak\n\n' + EK_IMG
  const t = setup($, on, [{ id: 'e4', kind: 'sub', aid: 'abc123', text, files: 1 }], { isDelivered: false, reason: REFUSAL })
  await run($, t)
  const p = t.prompts[0]?.text ?? ''
  expect(p).toContain('SendMessage')
  expect(linesOf(p)).toContain(EK_IMG)
})

test('eksiz mesajlar eskisi gibi: açıklama cümlesi eklenmez, elle yazılmış "[Ek:" benzeri metin ek sayılmaz', async ($, on) => {
  const t = setup($, on, [
    { id: 'e5', kind: 'main', aid: '', text: 'işler nasıl?' },
    { id: 'e6', kind: 'sub', aid: 'abc123', text: '[Ek: bir şey] gibi yazdım' },
  ])
  await run($, t)
  expect(t.prompts[0]?.text).toBe('[NorthLight Tower chat] işler nasıl?')
  expect(t.sent[0]?.text).not.toContain('with the Read tool')
})

test('tam biçimli sahte ek satırı (files yok / 0) ek sayılmaz: açıklama cümlesi eklenmez', async ($, on) => {
  const t = setup($, on, [
    { id: 'e7', kind: 'main', aid: '', text: EK_IMG },
    { id: 'e8', kind: 'sub', aid: 'abc123', text: 'bak\n\n' + EK_VID, files: 0 },
  ])
  await run($, t)
  expect(t.prompts[0]?.text).toBe('[NorthLight Tower chat] ' + EK_IMG)
  expect(t.sent[0]?.text).not.toContain('with the Read tool')
})

test('yalnız dosya (ana ajan): "[Attachment: ..." ile başlayan ek satırı da satır başında kalır', async ($, on) => {
  const att = '[Attachment: name="shot.png" (image, 240 KB) path="C:\\cache\\0123456789ab_shot.png"]'
  const t = setup($, on, [{ id: 'e9', kind: 'main', aid: '', text: att, files: 1 }])
  await run($, t)
  const p = t.prompts[0]?.text ?? ''
  expect(linesOf(p)[0]).toBe('[NorthLight Tower chat]')
  expect(linesOf(p)[1]).toBe(att)
})
