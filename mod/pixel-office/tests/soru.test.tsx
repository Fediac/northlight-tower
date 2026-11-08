import { expect, mock, test } from 'claude-code/testing'
import { __test } from '../hooks/register'

/*
 * Claude's questions (AskUserQuestion) on the question card in the tower:
 *  - if an answer comes from the tower the hook gives the tool's answer itself, Claude's dialog (the test's tool.call hook = "core") is NOT CALLED;
 *    the answer conforms to the tool's OUTPUT schema (checkResult) and "alındı" (ack: received) goes to the server
 *  - server missing / not responding / office closed or in the background / handover / id does not match / answer broken / time ran out: next(e),
 *    Claude's dialog opens
 *  - Esc (signal aborted): the card is withdrawn at once; even if an answer had come it is not used (no ack)
 */

type Fetch = { url: string; method?: string; body?: string; init?: { method?: string; body?: string } }
type Wait = { status: string; id?: string; answers?: unknown; reason?: string } | 'throw' | 'http500' | 'hang'

const QS = [
  {
    question: 'Hangi kütüphaneyi kullanalım?',
    header: 'Kütüphane',
    multiSelect: false,
    options: [
      { label: 'dayjs', description: 'Küçük ve hızlı' },
      { label: 'luxon', description: 'Saat dilimi desteği' },
    ],
  },
  {
    question: 'Hangi özellikler açılsın?',
    header: 'Özellik',
    multiSelect: true,
    options: [
      { label: 'Önbellek', description: 'Daha hızlı' },
      { label: 'Günlük', description: 'Hata ayıklama' },
    ],
  },
]

const DIALOG = { questions: QS, answers: { 'Hangi kütüphaneyi kullanalım?': 'dayjs', 'Hangi özellikler açılsın?': 'Günlük' } }

// ---- the tool's output schema (claude-code.d.ts, BuiltinToolResults['AskUserQuestion']) — strict check: a field not in the schema is also an error ----
const RESULT_KEYS = new Set(['questions', 'answers', 'response', 'annotations', 'afkTimeoutMs', 'followUp'])
const Q_KEYS = new Set(['question', 'header', 'kind', 'description', 'options', 'multiSelect', 'placeholder', 'min', 'max', 'step', 'defaultValue', 'unit'])
const OPT_KEYS = new Set(['label', 'description', 'preview'])

function schemaErrors(result: unknown): string[] {
  const errs: string[] = []
  const r = result as Record<string, unknown>
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['sonuç nesne değil']
  for (const k of Object.keys(r)) if (!RESULT_KEYS.has(k)) errs.push('sonuçta şemada olmayan alan: ' + k)
  if (!Array.isArray(r.questions)) errs.push('questions dizi değil')
  const texts: string[] = []
  for (const [i, q0] of (Array.isArray(r.questions) ? r.questions : []).entries()) {
    const q = q0 as Record<string, unknown>
    const at = 'questions[' + i + ']'
    if (!q || typeof q !== 'object') {
      errs.push(at + ' nesne değil')
      continue
    }
    for (const k of Object.keys(q)) if (!Q_KEYS.has(k)) errs.push(at + ' şemada olmayan alan: ' + k)
    if (typeof q.question !== 'string') errs.push(at + '.question metin değil')
    else texts.push(q.question)
    if (typeof q.header !== 'string') errs.push(at + '.header zorunlu metin')
    if (typeof q.multiSelect !== 'boolean') errs.push(at + '.multiSelect zorunlu boolean')
    if (!Array.isArray(q.options)) errs.push(at + '.options zorunlu dizi')
    for (const o0 of Array.isArray(q.options) ? q.options : []) {
      const o = o0 as Record<string, unknown>
      if (!o || typeof o !== 'object' || typeof o.label !== 'string') errs.push(at + ' seçenek etiketi yok')
      else for (const k of Object.keys(o)) if (!OPT_KEYS.has(k) || typeof o[k] !== 'string') errs.push(at + ' seçenek alanı bozuk: ' + k)
    }
    if (q.kind !== undefined && !['choice', 'text', 'number'].includes(q.kind as string)) errs.push(at + '.kind bozuk')
    for (const k of ['description', 'placeholder', 'unit']) if (q[k] !== undefined && typeof q[k] !== 'string') errs.push(at + '.' + k + ' metin değil')
    for (const k of ['min', 'max', 'step', 'defaultValue']) if (q[k] !== undefined && typeof q[k] !== 'number') errs.push(at + '.' + k + ' sayı değil')
  }
  const a = r.answers as Record<string, unknown>
  if (!a || typeof a !== 'object' || Array.isArray(a)) errs.push('answers nesne değil')
  else for (const [k, v] of Object.entries(a)) {
    if (typeof v !== 'string') errs.push('cevap metin değil: ' + k)
    if (!texts.includes(k)) errs.push('cevap bir soru metnine bağlı değil: ' + k)
  }
  return errs
}

function checkResult(result: unknown) {
  expect(schemaErrors(result)).toEqual([])
}

type Opts = {
  ask?: { ok: boolean; id?: string; reason?: string } | 'throw' | 'hang'
  waits?: Wait[]
  waitDelayMs?: number
  onWait?: () => void
}

function setup($: any, on: any, opts: Opts = {}) {
  const fetched: Fetch[] = []
  const dialogs: unknown[] = []
  const statuses: Array<string | undefined> = []
  const waits = [...(opts.waits ?? [])]
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 'oturum-1' }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', async (_: unknown, e: Fetch) => {
    const body = e.init?.body ?? e.body
    fetched.push({ url: e.url, method: e.init?.method ?? e.method, body })
    const ok = (o: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(o) } })
    if (e.url.endsWith('/ask')) {
      const a = opts.ask ?? { ok: true, id: 'q0123456789abcdef' }
      if (a === 'throw') throw new Error('ECONNREFUSED')
      if (a === 'hang') await clock.sleep(3_600_000)
      return ok(a)
    }
    if (e.url.includes('/ask/wait')) {
      const w = waits.length > 1 ? waits.shift() : waits[0]
      if (w === 'hang') await clock.sleep(3_600_000)
      if (opts.waitDelayMs) await clock.sleep(opts.waitDelayMs)
      opts.onWait?.()
      if (!w || w === 'throw') throw new Error('ECONNRESET')
      if (w === 'http500') return { value: { status: 500, ok: false, headers: {}, text: '' } }
      return ok(w)
    }
    if (e.url.includes('/outbox')) return ok({ items: [] })
    return ok({ ok: true })
  })
  // the test's tool.call hook is BELOW all plugins: it represents Claude's own dialog (core); the result it gives conforms to the schema too
  on('tool.call', (_: unknown, e: { tool: string; questions?: unknown }) => {
    dialogs.push(e)
    expect(schemaErrors(DIALOG)).toEqual([])
    return { result: DIALOG }
  })
  // if the address path ends with this suffix (query string excluded): '/ask' is only the request that drops the question, '/ask/wait' the polls
  const posts = (suffix: string) => fetched.filter(f => (f.url.split('?')[0] ?? '').endsWith(suffix))
  const bodies = (suffix: string) => posts(suffix).map(f => JSON.parse(f.body ?? '{}'))
  return { fetched, dialogs, clock, posts, bodies, statuses }
}

const ANSWERED = { status: 'answered', id: 'q0123456789abcdef', answers: ['luxon', 'Önbellek, Günlük'] }

test('kuleden gelen cevap aracın cevabı olur; Claude diyaloğu açılmaz; sonuç çıktı şemasına uyar; alındı bildirilir', async ($, on) => {
  const t = setup($, on, { waits: [{ status: 'pending' }, { status: 'pending' }, ANSWERED] })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
  expect(t.dialogs.length).toBe(0)
  expect(r.deny).toBeUndefined()
  checkResult(r.result)
  const res = r.result as { questions: unknown; answers: Record<string, string> }
  expect(res.answers).toEqual({ 'Hangi kütüphaneyi kullanalım?': 'luxon', 'Hangi özellikler açılsın?': 'Önbellek, Günlük' })
  expect(res.questions).toEqual(QS)
  // the question went to the server with the session id and tool call id; main agent: aid empty
  const sent = t.bodies('/ask')[0]
  expect(sent.sid).toBe('oturum-1')
  expect(sent.aid).toBe('')
  expect(typeof sent.tuid).toBe('string')
  expect(sent.questions).toEqual(QS)
  expect(t.posts('/ask/wait').length).toBe(3)
  // long polling goes with the open wait time (hold=8)
  expect(t.posts('/ask/wait')[0]?.url).toContain('hold=8&id=q0123456789abcdef&sid=oturum-1')
  expect(t.posts('/ask/cancel').length).toBe(0)
  // delivered: only when the mod used the answer
  expect(t.bodies('/ask/ack')).toEqual([{ id: 'q0123456789abcdef', sid: 'oturum-1', ok: true }])
  // a visible marker in Claude while waiting, cleared when done
  expect(t.statuses[0]).toContain('Question waiting in NorthLight Tower')
  expect(t.statuses[t.statuses.length - 1]).toBeUndefined()
})

test('şema: eksik header / options / multiSelect tamamlanır, şemada olmayan alan atılır, isteğe bağlı alanlar kalır', async ($, on) => {
  const raw = [
    { question: 'Adı ne olsun?', kind: 'text', placeholder: 'ör. Kule', fazla: 'x' },
    { question: 'Kaç slayt?', header: 'Sayı', kind: 'number', min: 1, max: 20, step: 1, defaultValue: 8, unit: 'slayt', multiSelect: 'evet' },
    { question: 'Hangisi?', header: 'Seç', multiSelect: true, options: [{ label: 'A', ekstra: 1 }, { label: 'B', description: 'b', preview: 'p' }] },
  ]
  const t = setup($, on, { waits: [{ status: 'answered', id: 'q0123456789abcdef', answers: ['Kule', '12', 'A, B'] }] })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: raw as any })
  expect(t.dialogs.length).toBe(0)
  checkResult(r.result)
  const res = r.result as { questions: Array<Record<string, unknown>>; answers: Record<string, string> }
  expect(res.questions[0]).toEqual({ question: 'Adı ne olsun?', header: '', options: [], multiSelect: false, kind: 'text', placeholder: 'ör. Kule' })
  expect(res.questions[1]).toEqual({ question: 'Kaç slayt?', header: 'Sayı', options: [], multiSelect: false, kind: 'number', min: 1, max: 20, step: 1, defaultValue: 8, unit: 'slayt' })
  expect(res.questions[2]?.options).toEqual([{ label: 'A' }, { label: 'B', description: 'b', preview: 'p' }])
  expect(res.answers).toEqual({ 'Adı ne olsun?': 'Kule', 'Kaç slayt?': '12', 'Hangisi?': 'A, B' })
  // the input itself goes to the server (the server does its own validation)
  expect(t.bodies('/ask')[0].questions).toEqual(raw)
})

test('normQuestions: bozuk biçim reddedilir', async () => {
  const { normQuestions } = __test
  expect(normQuestions('x')).toBeNull()
  expect(normQuestions([null])).toBeNull()
  expect(normQuestions([{ header: 'yok' }])).toBeNull()
  expect(normQuestions([{ question: 'S?', options: 'x' }])).toBeNull()
  expect(normQuestions([{ question: 'S?', options: [{ description: 'etiketsiz' }] }])).toBeNull()
  expect(normQuestions([{ question: 'S?', kind: 'slider' }])).toBeNull()
  expect(normQuestions([{ question: 'S?', min: Infinity }])).toEqual([{ question: 'S?', header: '', options: [], multiSelect: false }])
})

test('alt ajanın sorusu: çalışan kimliği sunucuya gider', async ($, on) => {
  const t = setup($, on, { waits: [ANSWERED] })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS, agentId: 'abc123' })
  expect(t.dialogs.length).toBe(0)
  expect(t.bodies('/ask')[0].aid).toBe('abc123')
  expect((r.result as { answers: Record<string, string> }).answers['Hangi kütüphaneyi kullanalım?']).toBe('luxon')
})

test('sunucu kapalı: Claude diyaloğu açılır', async ($, on) => {
  const t = setup($, on, { ask: 'throw' })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
  expect(t.dialogs.length).toBe(1)
  expect(r.result).toEqual(DIALOG)
  expect(t.statuses.length).toBe(0)
})

for (const reason of ['Ofis açık değil', 'Ofis sekmesi arka planda']) {
  test(`sunucu soruyu almadı (${reason}): Claude diyaloğu HEMEN açılır, bekleme yok, durum satırı yok`, async ($, on) => {
    const t = setup($, on, { ask: { ok: false, reason } })
    const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
    expect(t.dialogs.length).toBe(1)
    expect(t.posts('/ask/wait').length).toBe(0)
    expect(t.statuses.length).toBe(0)
    expect(r.result).toEqual(DIALOG)
  })
}

test('POST /ask yanıt vermezse (zaman aşımı 5 sn) soru araç çağrısı kimliğiyle geri çekilir, Claude diyaloğu açılır', async ($, on) => {
  const t = setup($, on, { ask: 'hang' })
  let done = false
  const p = $.tool.call({ tool: 'AskUserQuestion', questions: QS }).then((r: unknown) => {
    done = true
    return r
  })
  await t.clock.advance(4_000)
  expect(done).toBe(false)
  await t.clock.advance(1_500)
  const r = (await p) as { result: unknown }
  expect(t.dialogs.length).toBe(1)
  expect(r.result).toEqual(DIALOG)
  const c = t.bodies('/ask/cancel')[0]
  expect(c.id).toBe('')
  expect(c.sid).toBe('oturum-1')
  expect(c.tuid).toBe(t.bodies('/ask')[0].tuid)
})

test('uzun yoklama asılı kalırsa (her biri 15 sn zaman aşımı) iki denemeden sonra soru geri çekilir, Claude diyaloğu açılır', async ($, on) => {
  const t = setup($, on, { waits: ['hang'] })
  let done = false
  const p = $.tool.call({ tool: 'AskUserQuestion', questions: QS }).then((r: unknown) => {
    done = true
    return r
  })
  await t.clock.advance(15_500)
  expect(done).toBe(false)
  expect(t.posts('/ask/wait').length).toBe(2)
  await t.clock.advance(15_500)
  const r = (await p) as { result: unknown }
  expect(t.dialogs.length).toBe(1)
  expect(r.result).toEqual(DIALOG)
  expect(t.bodies('/ask/cancel')[0]).toMatchObject({ id: 'q0123456789abcdef', sid: 'oturum-1' })
  expect(t.statuses[t.statuses.length - 1]).toBeUndefined()
})

for (const status of ['handoff', 'cancelled', 'expired', 'gone'] as const) {
  test(`"${status}" gelirse soru Claude diyaloğuna geçer`, async ($, on) => {
    const t = setup($, on, { waits: [{ status: 'pending' }, { status, reason: 'Claude penceresinde cevaplanacak' }] })
    const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
    expect(t.dialogs.length).toBe(1)
    expect(r.result).toEqual(DIALOG)
    expect(t.posts('/ask/ack').length).toBe(0)
  })
}

test('başka bir sorunun kimliğiyle gelen cevap kabul edilmez', async ($, on) => {
  const t = setup($, on, { waits: [{ ...ANSWERED, id: 'qffffffffffffffff' }] })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
  expect(t.dialogs.length).toBe(1)
  expect(r.result).toEqual(DIALOG)
})

for (const answers of [['tek'], ['a', 5], 'metin', ['a', ''], ['a', 'x'.repeat(4001)]]) {
  test(`bozuk cevap listesi (${JSON.stringify(answers).slice(0, 20)}) kabul edilmez; "ulaşmadı" bildirilir`, async ($, on) => {
    const t = setup($, on, { waits: [{ ...ANSWERED, answers }] })
    await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
    expect(t.dialogs.length).toBe(1)
    const acks = t.bodies('/ask/ack')
    expect(acks.length).toBe(1)
    expect(acks[0]).toMatchObject({ id: 'q0123456789abcdef', sid: 'oturum-1', ok: false })
  })
}

test('desteklenmeyen girdi (aynı soru iki kez) sunucuya hiç gitmez', async ($, on) => {
  const t = setup($, on, { waits: [ANSWERED] })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [QS[0], QS[0]] as any })
  expect(t.posts('/ask').length).toBe(0)
  expect(t.dialogs.length).toBe(1)
})

test('sunucu yoklamada iki kez yanıt vermezse soru geri çekilir, Claude diyaloğu açılır', async ($, on) => {
  const t = setup($, on, { waits: ['http500', 'throw'] })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
  expect(t.dialogs.length).toBe(1)
  expect(r.result).toEqual(DIALOG)
  const c = t.bodies('/ask/cancel')
  expect(c.length).toBe(1)
  expect(c[0]).toMatchObject({ id: 'q0123456789abcdef', sid: 'oturum-1', tuid: t.bodies('/ask')[0].tuid })
})

test('tek bir yoklama hatası sonrası cevap gelirse yine kabul edilir', async ($, on) => {
  const t = setup($, on, { waits: ['throw', ANSWERED] })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
  expect(t.dialogs.length).toBe(0)
  expect((r.result as { answers: Record<string, string> }).answers['Hangi özellikler açılsın?']).toBe('Önbellek, Günlük')
})

test('süre aşımı (10 dk): soru geri çekilir, Claude diyaloğu açılır, oturum asılı kalmaz', async ($, on) => {
  // each long poll lasts as long as the server's wait (8 s) and returns "pending"
  const t = setup($, on, { waits: [{ status: 'pending' }], waitDelayMs: 8_000 })
  let done = false
  const p = $.tool.call({ tool: 'AskUserQuestion', questions: QS }).then((r: unknown) => {
    done = true
    return r
  })
  for (let i = 0; i < 70; i++) await t.clock.advance(8_000)
  expect(done).toBe(false)
  expect(t.dialogs.length).toBe(0)
  for (let i = 0; i < 10 && !done; i++) await t.clock.advance(8_000)
  const r = (await p) as { result: unknown }
  expect(t.dialogs.length).toBe(1)
  expect(r.result).toEqual(DIALOG)
  expect(t.posts('/ask/cancel').length).toBe(1)
  expect(t.posts('/ask/wait').length).toBeLessThan(80)
})

test('başka araçlar soru yoluna girmez; soru soran çalışan "Waiting for approval" (waiting) görünür', async ($, on) => {
  const t = setup($, on, { waits: [ANSWERED] })
  await $.tool.call({ tool: 'Read', file_path: 'C:/x.txt' })
  expect(t.posts('/ask').length).toBe(0)
  expect(t.dialogs.length).toBe(1)
  await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
  const states = t.bodies('/hook').filter(b => b.kind === 'state' && b.tool === 'AskUserQuestion')
  expect(states[0]?.state).toBe('waiting')
})

test('.catch: hook beklenmedik biçimde düşerse kart araç çağrısı kimliğiyle geri çekilir, Claude diyaloğu açılır', async ($, on) => {
  const fetched: Fetch[] = []
  const dialogs: unknown[] = []
  on('session.id', () => ({ value: 'oturum-1' }))
  on('ui.status', () => ({ value: undefined }))
  // /ask succeeded, then the clock cannot be read: askOffice throws. The timeout timers never fire.
  on('clock.now', () => {
    throw new Error('saat yok')
  })
  on('clock.after', () => new Promise(() => {}))
  on('http.fetch', (_: unknown, e: Fetch) => {
    fetched.push({ url: e.url, body: e.init?.body ?? e.body })
    const text = e.url.endsWith('/ask') ? JSON.stringify({ ok: true, id: 'q0123456789abcdef' }) : '{}'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('tool.call', (_: unknown, e: unknown) => {
    dialogs.push(e)
    return { result: DIALOG }
  })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QS })
  expect(dialogs.length).toBe(1)
  expect(r.result).toEqual(DIALOG)
  const ask = JSON.parse(fetched.find(f => f.url.endsWith('/ask'))?.body ?? '{}')
  const cancel = JSON.parse(fetched.find(f => f.url.endsWith('/ask/cancel'))?.body ?? '{}')
  expect(cancel).toMatchObject({ id: '', sid: 'oturum-1', tuid: ask.tuid })
  expect(ask.tuid).toBeTruthy()
})

// ---- Esc / cancel: askOffice directly, with its own AbortController and a fake $ (a hook in the test cannot cut the dispatch) ----

type Reply = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const NEVER = () => new Promise<Reply>(() => {})
const JSONR = (o: unknown): Reply => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(o) })

function fake(handler: (url: string) => Promise<Reply> | Reply) {
  const fetched: Array<{ url: string; body: any }> = []
  const statuses: Array<string | undefined> = []
  const $f: any = {
    session: { id: async () => 'oturum-1' },
    clock: { now: async () => 1_000_000, after: () => ({ cancel() {} }) }, // the timers never fire: only the cancel is tested
    ui: { status: (t: string | undefined) => statuses.push(t) },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        fetched.push({ url, body: init?.body ? JSON.parse(init.body) : null })
        return handler(url)
      },
    },
  }
  const path = (suffix: string) => fetched.filter(f => (f.url.split('?')[0] ?? '').endsWith(suffix))
  return { $f, fetched, statuses, path }
}
const tick = () => new Promise(r => setTimeout(r, 0))

test('Esc: yoklama sürerken iptal edilirse hemen döner, kart kimlik + araç çağrısı kimliğiyle geri çekilir', async () => {
  const t = fake(url => (url.endsWith('/ask') ? JSONR({ ok: true, id: 'q0123456789abcdef' }) : url.includes('/ask/wait') ? NEVER() : JSONR({ ok: true })))
  const ac = new AbortController()
  let out: unknown = null
  const p = __test.askOffice(t.$f, { questions: QS, tool_use_id: 'toolu_esc1' }, ac.signal).then(r => (out = r))
  for (let i = 0; i < 5; i++) await tick()
  expect(t.path('/ask/wait').length).toBe(1)
  expect(out).toBeNull()
  expect(t.statuses[0]).toContain('Question waiting in NorthLight Tower')
  ac.abort()
  await p
  expect(out).toEqual({ kind: 'aborted' })
  const c = t.path('/ask/cancel').map(f => f.body)
  expect(c.length).toBe(1)
  expect(c[0]).toMatchObject({ id: 'q0123456789abcdef', tuid: 'toolu_esc1', sid: 'oturum-1' })
  expect(t.path('/ask/ack').length).toBe(0)
  expect(t.statuses[t.statuses.length - 1]).toBeUndefined()
})

test('Esc: soru bırakılırken (kimlik henüz yok) iptal edilirse araç çağrısı kimliğiyle geri çekilir', async () => {
  const t = fake(url => (url.endsWith('/ask') ? NEVER() : JSONR({ ok: true })))
  const ac = new AbortController()
  const p = __test.askOffice(t.$f, { questions: QS, tool_use_id: 'toolu_esc2' }, ac.signal)
  for (let i = 0; i < 5; i++) await tick()
  ac.abort()
  expect(await p).toEqual({ kind: 'aborted' })
  const c = t.path('/ask/cancel').map(f => f.body)
  expect(c.length).toBe(1)
  expect(c[0]).toMatchObject({ id: '', tuid: 'toolu_esc2', sid: 'oturum-1' })
  expect(t.statuses.length).toBe(0)
})

test('Esc: cevap geldiği anda iptal edilirse cevap kullanılmaz, ack gitmez, geri çekme ("ulaşmadı") gider', async () => {
  const ac = new AbortController()
  const t = fake(url => {
    if (url.endsWith('/ask')) return JSONR({ ok: true, id: 'q0123456789abcdef' })
    if (url.includes('/ask/wait')) {
      ac.abort()
      return JSONR(ANSWERED)
    }
    return JSONR({ ok: true })
  })
  const r = await __test.askOffice(t.$f, { questions: QS, tool_use_id: 'toolu_esc3' }, ac.signal)
  expect(r).toEqual({ kind: 'aborted' })
  expect(t.path('/ask/ack').length).toBe(0)
  expect(t.path('/ask/cancel')[0]?.body).toMatchObject({ id: 'q0123456789abcdef', tuid: 'toolu_esc3' })
})

test('zaten iptal edilmiş signal: sunucuya hiç gidilmez', async () => {
  const t = fake(() => JSONR({ ok: true, id: 'q0123456789abcdef' }))
  const ac = new AbortController()
  ac.abort()
  expect(await __test.askOffice(t.$f, { questions: QS, tool_use_id: 'toolu_esc4' }, ac.signal)).toEqual({ kind: 'aborted' })
  expect(t.path('/ask').length).toBe(0)
})

// ---- permission question (askPermission): two options, only an exact label counts ----
for (const [given, want] of [['Allow', 'allow'], ['Deny', 'deny'], ['Allow forever', null], ['evet', null]] as const) {
  test(`askPermission: "${given}" -> ${want}`, async () => {
    const t = fake(url => (url.endsWith('/ask') ? JSONR({ ok: true, id: 'q0123456789abcdef' }) : url.includes('/ask/wait') ? JSONR({ status: 'answered', id: 'q0123456789abcdef', answers: [given] }) : JSONR({ ok: true })))
    const verdict = await __test.askPermission(t.$f, { tool_name: 'Bash', tool_input: { command: 'dir' }, tool_use_id: 'toolu_p1' })
    expect(verdict).toBe(want)
    const q = t.path('/ask')[0]?.body.questions[0]
    expect(q.question).toBe('Allow this action? Running a command: dir')
    expect(q.header).toBe('Permission')
    expect(q.options.map((o: { label: string }) => o.label)).toEqual(['Allow', 'Deny'])
  })
}
