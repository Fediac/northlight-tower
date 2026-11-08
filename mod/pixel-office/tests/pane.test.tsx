import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pixel-office',
  component: 'Pane',
  requestId: 'pixel-office',
  props: {
    title: 'NorthLight Tower',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

test('panel ana ajanı, alt ajanı ve izin isteğini gösterir', async ($, on) => {
  on('command.register', () => ({ value: { command: 'pixel-office' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '' } }))
  on('tool.call', () => ({ result: {} }))
  for (const ev of ['UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd'] as const) {
    on(`classic.${ev}`, () => ({}))
  }
  mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.UserPromptSubmit({ prompt: 'Ofisi yap', source: 'user', session_title: 'Deneme' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proje/office.js', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'dir', agentId: 'abc123' })
  await $.classic.SubagentStart({ agent_id: 'abc123', agent_type: 'Explore' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'dir' } })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /NORTHLIGHT TOWER/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Waiting for approval/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Running a command/ })).toBeDefined()
    await ui.unmount()
  }
})

test('boş panel sakin bir yazı gösterir', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>motor</Text>
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Nothing is happening right now/ })).toBeDefined()
  await ui.unmount()
})

// ---------------------------------------------------------------------------------------------
// "Message a worker" section: rendering, send flow, the selected agent's last reply, names
// ---------------------------------------------------------------------------------------------

type Fetch = { url: string; method?: string; body?: string; init?: { method?: string; body?: string } }
type SendResult = { isDelivered: true } | { isDelivered: false; reason: string }
type NameRow = { aid: string; nick: string; kind_tr?: string; role?: string }

const REFUSAL = 'The server-side auto mode classifier gave no verdict for SendMessage: the request that produced this action did not ask for one.'

// the server's /names reply (only if given in the test; otherwise the server returns empty, as if "yanıtsız" (without a reply))
function namesBody(rows: NameRow[]) {
  return JSON.stringify({ agents: rows.map((r, i) => ({ id: 's' + i, char: 'hacker', sub: !!r.aid, state: 'working', kind_tr: '', role: '', ...r })) })
}

// below the engine: records the calls that go to the server, session.send and prompt.submit
function setup($: any, on: any, sendResult: SendResult = { isDelivered: true }, opts: { slowSay?: boolean; serverDown?: boolean; names?: NameRow[] } = {}) {
  const fetched: Array<{ url: string; body?: string }> = []
  const sent: Array<{ to: unknown; text: string }> = []
  const prompts: Array<{ text: string; asUser?: boolean }> = []
  const writes: Array<{ key: string; value: any }> = []
  let current: SendResult = sendResult
  on('command.register', () => ({ value: { command: 'pixel-office' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'oturum-1' }))
  // records the mod's $.state writes (the kit still gives its own reply)
  on('state.set', (_: unknown, e: { key: string; value: unknown }, next: (e: unknown) => unknown) => {
    writes.push({ key: e.key, value: e.value })
    return next(e)
  })
  const clock = mock.clock(on)
  on('http.fetch', async (_: unknown, e: Fetch) => {
    const body = e.init?.body ?? e.body
    fetched.push({ url: e.url, body })
    if (opts.serverDown) return { deny: 'ECONNREFUSED' }
    // stuck server: no reply comes to the say record (unless the fake clock advances)
    if (opts.slowSay && body?.includes('"kind":"say"')) await clock.sleep(60_000)
    if (e.url.includes('/names')) return { value: { status: 200, ok: true, headers: {}, text: opts.names ? namesBody(opts.names) : '{}' } }
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
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  for (const ev of ['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'SessionEnd']) on(`classic.${ev}`, () => ({}))
  return { fetched, sent, prompts, writes, clock, setSend: (r: SendResult) => void (current = r) }
}

async function begin($: any, ...subs: Array<[id: string, type: string]>) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [id, type] of subs) await $.classic.SubagentStart({ agent_id: id, agent_type: type, session_id: 'oturum-1' })
}

async function finish($: any, id: string, type: string) {
  await $.classic.SubagentStop({ agent_id: id, agent_type: type, stop_hook_active: false, agent_transcript_path: '', session_id: 'oturum-1' })
}

async function answer($: any, agentId: string | undefined, text: string) {
  await $.turn.complete({ answer: text, durationMs: 5, isAborted: false, turnId: 't-' + (agentId ?? 'main'), reason: 'answer', agentId })
}

// advance the 5 s name polling (/names is fetched from the server, the panel is redrawn)
async function pollNames(t: ReturnType<typeof setup>) {
  await t.clock.advance(5100)
  await t.clock.settle()
}

// /hook bodies sent to the server (by kind) and /ack bodies
function hooks(t: ReturnType<typeof setup>, kind: string) {
  return t.fetched.filter(f => f.url.endsWith('/hook') && f.body?.includes('"kind":"' + kind + '"'))
}
function acks(t: ReturnType<typeof setup>) {
  return t.fetched.filter(f => f.url.endsWith('/ack'))
}

// message box: the key is not fixed ("msg" + send counter); the tests find the current one
async function box(ui: any) {
  return (await ui.find({ type: 'Input' })) as { key: string; props: Record<string, unknown> } | undefined
}
async function typeIn(ui: any, text: string, kind: 'change' | 'submit' = 'change') {
  const el = await box(ui)
  expect(el).toBeDefined()
  await ui.input({ key: el!.key, text, kind })
}
// Enter: sends the text
async function submit(ui: any, text: string) {
  await typeIn(ui, text, 'submit')
}

test('alt ajan varken mesaj kutusu çizilir: Select ve Input; AYRI Gönder düğmesi yok', async ($, on) => {
  setup($, on)
  await begin($, ['abc123', 'Explore'])

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Message a worker/ })).toBeDefined()
    const pick = await ui.find({ type: 'Select', key: 'agent' })
    expect(pick?.props.options).toEqual([{ value: 'abc123', label: 'Explore' }])
    expect(pick?.props.value).toBe('abc123')
    const el = await box(ui)
    expect(el?.key).toBe('msg0')
    expect(el?.props.placeholder).toBe('Write your message…')
    expect(el?.props.submitLabel).toBe('send')
    // no value is given: the box keeps its own text (giving a value made letters get lost while typing)
    expect(el?.props.value).toBeUndefined()
    // double button problem: there is only Input's own "gönder" (send) hint, no separate Button
    expect((await ui.findAll({ type: 'Button' })).length).toBe(0)
    expect(await ui.find({ type: 'Text', text: /No workers yet/ })).toBeUndefined()
    await ui.unmount()
  }

  // no Input and Select on the phone: only a note
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ type: 'Text', text: /The message box is not available/ })).toBeDefined()
  expect(await phone.find({ type: 'Input' })).toBeUndefined()
  await phone.unmount()
})

test('alt ajan yokken "Henüz çalışan yok" gösterilir, kutu çizilmez', async ($, on) => {
  setup($, on)
  await begin($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Message a worker/ })).toBeDefined()
    if (surface === 'mobile') {
      expect(await ui.find({ type: 'Text', text: /The message box is not available/ })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Text', text: /No workers yet/ })).toBeDefined()
      expect(await ui.find({ type: 'Select' })).toBeUndefined()
      expect(await ui.find({ type: 'Input' })).toBeUndefined()
      expect((await ui.findAll({ type: 'Button' })).length).toBe(0)
    }
    await ui.unmount()
  }
})

test('sunucu adı yokken eski etiket kullanılır: kimlik eki ("#f456") ve "↳" yok, aynı etiket numaralanır', async ($, on) => {
  setup($, on)
  await begin($, ['abc123', 'Explore'], ['def456', 'general-purpose'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  let pick = await ui.find({ type: 'Select', key: 'agent' })
  expect(pick?.props.options).toEqual([
    { value: 'abc123', label: 'Explore' },
    { value: 'def456', label: 'general-purpose' },
  ])

  await finish($, 'abc123', 'Explore')
  pick = await ui.find({ type: 'Select', key: 'agent' })
  expect(pick?.props.options).toEqual([
    { value: 'abc123', label: 'Explore (done)' },
    { value: 'def456', label: 'general-purpose' },
  ])

  await $.classic.SubagentStart({ agent_id: 'zzz456', agent_type: 'general-purpose', session_id: 'oturum-1' })
  pick = await ui.find({ type: 'Select', key: 'agent' })
  expect(pick?.props.options).toEqual([
    { value: 'abc123', label: 'Explore (done)' },
    { value: 'def456', label: 'general-purpose' },
    { value: 'zzz456', label: 'general-purpose 2' },
  ])
  // on the cards the sub-agent icon is a plain "•"; no "↳" (it looked like "I," on Desktop) and no "#code"
  expect(await ui.find({ type: 'Text', text: /↳|#[0-9a-z]{4}/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^• Explore$/ })).toBeDefined()
  await ui.unmount()
})

test('sunucunun adları: liste ve Select "Hayalet · Mod testi" biçiminde; ana ajan "Müdür · başlık"', async ($, on) => {
  const t = setup($, on, { isDelivered: true }, {
    names: [
      { aid: '', nick: 'Müdür' },
      { aid: 'abc123', nick: 'Hayalet', kind_tr: 'Uzman', role: 'Mod testi' },
      { aid: 'def456', nick: 'Kurt', kind_tr: 'Araştırmacı', role: '' },
    ],
  })
  await begin($, ['abc123', 'Explore'], ['def456', 'Plan'])
  await $.classic.UserPromptSubmit({ prompt: 'iş', source: 'user', session_title: 'Deneme', session_id: 'oturum-1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // no polling yet: the old labels
  expect((await ui.find({ type: 'Select', key: 'agent' }))?.props.options).toEqual([
    { value: 'abc123', label: 'Explore' },
    { value: 'def456', label: 'Plan' },
  ])

  await pollNames(t)
  expect(t.fetched.some(f => f.url === 'http://127.0.0.1:8765/names?sid=oturum-1')).toBe(true)
  expect((await ui.find({ type: 'Select', key: 'agent' }))?.props.options).toEqual([
    { value: 'abc123', label: 'Hayalet · Mod testi' },
    { value: 'def456', label: 'Kurt · Araştırmacı' },
  ])
  expect(await ui.find({ type: 'Text', text: /^• Hayalet · Mod testi$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Müdür · Deneme$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Explore|↳|#[0-9a-z]{4}/ })).toBeUndefined()

  await finish($, 'abc123', 'Explore')
  expect((await ui.find({ type: 'Select', key: 'agent' }))?.props.options).toEqual([
    { value: 'abc123', label: 'Hayalet · Mod testi (done)' },
    { value: 'def456', label: 'Kurt · Araştırmacı' },
  ])
  await ui.unmount()
})

test('sunucu kapalıysa adlar gelmez, eski etiket yedeği çalışır', async ($, on) => {
  const t = setup($, on, { isDelivered: true }, { serverDown: true })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pollNames(t)
  expect((await ui.find({ type: 'Select', key: 'agent' }))?.props.options).toEqual([{ value: 'abc123', label: 'Explore' }])
  await ui.unmount()
})

test('Enter gönderir: say kaydı, çerçeveli session.send ve ack; kutu yeni key ile boş açılır, durum "Delivered to Hayalet ✓"', async ($, on) => {
  const t = setup($, on, { isDelivered: true }, { names: [{ aid: 'abc123', nick: 'Hayalet', role: 'Mod testi' }] })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pollNames(t)

  await typeIn(ui, 'rengi maviye çevir')
  expect(t.sent.length).toBe(0)
  expect((await box(ui))?.key).toBe('msg0')

  await submit(ui, 'rengi maviye çevir')

  // "say" record to the server (with the session id, raw text without a frame), then direct delivery to the sub-agent, then ack
  const say = hooks(t, 'say')
  expect(say.length).toBe(1)
  const body = JSON.parse(say[0]?.body ?? '{}')
  expect(body.kind).toBe('say')
  expect(body.aid).toBe('abc123')
  expect(body.text).toBe('rengi maviye çevir')
  expect(body.sid).toBe('oturum-1')
  expect(body.id).toMatch(/^p\d+$/)

  expect(t.sent.length).toBe(1)
  expect(JSON.stringify(t.sent[0]?.to)).toContain('abc123')
  expect(t.sent[0]?.text).toContain('rengi maviye çevir')
  // message frame: plain English reply request
  expect(t.sent[0]?.text).toContain("starting with 'SUMMARY:'")
  expect(t.prompts.length).toBe(0)

  expect(acks(t).length).toBe(1)
  const ack = JSON.parse(acks(t)[0]?.body ?? '{}')
  expect(ack.id).toBe(body.id)
  expect(ack.ok).toBe(true)
  expect(t.fetched.indexOf(say[0]!)).toBeLessThan(t.fetched.indexOf(acks(t)[0]!))

  // the box opened with a new key (empty), the status line uses the name
  expect((await box(ui))?.key).toBe('msg1')
  expect((await box(ui))?.props.value).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Delivered to Hayalet ✓$/ })).toBeDefined()
  await ui.unmount()
})

test("status line names the recipient: Kurt, Ali, Hayalet 2; 'the worker' when there is no name", async ($, on) => {
  const t = setup($, on, { isDelivered: true }, {
    names: [
      { aid: 'a1', nick: 'Kurt' },
      { aid: 'a2', nick: 'Ali' },
      { aid: 'a3', nick: 'Hayalet 2' },
    ],
  })
  await begin($, ['a1', 'Explore'], ['a2', 'Explore'], ['a3', 'Explore'], ['a4', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pollNames(t)

  const want: Array<[string, RegExp]> = [
    ['a1', /^Delivered to Kurt ✓$/],
    ['a2', /^Delivered to Ali ✓$/],
    ['a3', /^Delivered to Hayalet 2 ✓$/],
    ['a4', /^Delivered to the worker ✓$/],
  ]
  for (const [aid, re] of want) {
    await ui.select({ key: 'agent', value: aid })
    await submit(ui, 'selam ' + aid)
    expect(await ui.find({ type: 'Text', text: re })).toBeDefined()
  }
  await ui.unmount()
})

test('yazarken atoma yazılmaz; ajanlar değişip panel yeniden çizilse de kutu aynı key ile kalır, value verilmez', async ($, on) => {
  const t = setup($, on)
  await begin($, ['abc123', 'Explore'], ['def456', 'Plan'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.select({ key: 'agent', value: 'def456' })
  const before = t.writes.length
  for (const part of ['y', 'ya', 'yar', 'yarı', 'yarım kalan mesa']) await typeIn(ui, part)
  // the source of the letter loss: an atom write on every key. Now there is no write at all.
  expect(t.writes.length).toBe(before)
  expect((await box(ui))?.key).toBe('msg0')

  // the panel can be redrawn while agents work; the box stays with the same key (no value is given, typed letters are not written to an atom), and so does the selection
  // (the host's real behavior is not imitated in this kit; not verified live)
  await $.classic.UserPromptSubmit({ prompt: 'başka iş', source: 'user', session_title: 'Deneme', session_id: 'oturum-1' })
  await finish($, 'abc123', 'Explore')
  expect((await ui.find({ type: 'Select', key: 'agent' }))?.props.value).toBe('def456')
  const el = await box(ui)
  expect(el?.key).toBe('msg0')
  expect(el?.props.value).toBeUndefined()

  // when delivery succeeds the box is reset
  await submit(ui, 'yarım kalan mesaj')
  expect((await box(ui))?.key).toBe('msg1')
  await ui.unmount()
})

test('sunucu kapalıysa mesaj yine alt ajana iletilir', async ($, on) => {
  const t = setup($, on, { isDelivered: true }, { serverDown: true })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await submit(ui, 'sunucu yokken de çalışsın')

  expect(t.sent.length).toBe(1)
  expect(t.sent[0]?.text).toContain('sunucu yokken de çalışsın')
  expect(await ui.find({ type: 'Text', text: /Delivered to/ })).toBeDefined()
  await ui.unmount()
})

test('sunucu say kaydına yanıt vermezse mesaj en çok 2 sn sonra yine iletilir', async ($, on) => {
  const t = setup($, on, { isDelivered: true }, { slowSay: true })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const pressed = submit(ui, 'geç kalan sunucu')
  await t.clock.advance(1500)
  // the say record is still unanswered: the message is waiting, status "Gönderiliyor…" (Sending…)
  expect(t.sent.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Sending…/ })).toBeDefined()

  await t.clock.advance(600)
  await pressed
  expect(t.sent.length).toBe(1)
  expect(acks(t).length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Delivered to/ })).toBeDefined()
  await ui.unmount()
})

test('Enter seçilen alt ajana gönderir', async ($, on) => {
  const t = setup($, on)
  await begin($, ['abc123', 'Explore'], ['def456', 'Plan'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.select({ key: 'agent', value: 'def456' })
  expect((await ui.find({ type: 'Select', key: 'agent' }))?.props.value).toBe('def456')
  await submit(ui, 'merhaba')

  expect(t.sent.length).toBe(1)
  expect(JSON.stringify(t.sent[0]?.to)).toContain('def456')
  expect(JSON.parse(hooks(t, 'say')[0]?.body ?? '{}').aid).toBe('def456')
  expect(await ui.find({ type: 'Text', text: /Delivered to/ })).toBeDefined()
  await ui.unmount()
})

test('teslim hatası durum satırında kısa nedenle görünür, ana ajana yönlendirilmez', async ($, on) => {
  const t = setup($, on, { isDelivered: false, reason: 'Ajan bulunamadı' })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await submit(ui, 'tekrar dene')

  expect(t.prompts.length).toBe(0)
  const ack = JSON.parse(acks(t)[0]?.body ?? '{}')
  expect(ack.ok).toBe(false)
  expect(ack.reason).toContain('Ajan bulunamadı')
  expect(await ui.find({ type: 'Text', text: /Error: Ajan bulunamadı/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Delivered to/ })).toBeUndefined()
  // not delivered: the box was not emptied (same key), the status line says so
  expect((await box(ui))?.key).toBe('msg0')
  expect(await ui.find({ type: 'Text', text: /Your message is still in the box/ })).toBeDefined()
  await ui.unmount()
})

test('Claude\'dan gelen İngilizce teknik neden genel bir ifadeyle gösterilir; bilinen nedenler çevrilir', async ($, on) => {
  const t = setup($, on, { isDelivered: false, reason: 'Agent not found: code 404' })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await submit(ui, 'merhaba')
  expect(await ui.find({ type: 'Text', text: /^Error: Claude reported a problem · Your message is still in the box$/ })).toBeDefined()

  t.setSend({ isDelivered: false, reason: 'Request timed out' })
  await submit(ui, 'merhaba')
  expect(await ui.find({ type: 'Text', text: /^Error: Claude did not respond in time · Your message is still in the box$/ })).toBeDefined()
  await ui.unmount()
})

test('izin denetimi reddederse mesaj ana ajan (manager) aracılığıyla gider ve durum bunu söyler', async ($, on) => {
  const t = setup($, on, { isDelivered: false, reason: REFUSAL })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await submit(ui, 'bunu ilet')

  expect(t.sent.length).toBe(1)
  expect(t.prompts.length).toBe(1)
  expect(t.prompts[0]?.text).toContain('SendMessage')
  expect(t.prompts[0]?.text).toContain('abc123')
  expect(t.prompts[0]?.text).toContain('bunu ilet')
  const ack = JSON.parse(acks(t)[0]?.body ?? '{}')
  expect(ack.ok).toBe(true)
  expect(ack.reason).toContain('via the manager')
  expect(await ui.find({ type: 'Text', text: /Delivered to the worker ✓ \(via the manager\)/ })).toBeDefined()
  await ui.unmount()
})

test('boş ya da 2000 karakterden uzun mesaj gönderilmez (kutu sıfırlanmaz); tam 2000 karakter gönderilir', async ($, on) => {
  const t = setup($, on)
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await submit(ui, '')
  expect(await ui.find({ type: 'Text', text: /Error: message is empty/ })).toBeDefined()

  await submit(ui, '   ')
  expect(await ui.find({ type: 'Text', text: /Error: message is empty/ })).toBeDefined()

  await submit(ui, 'a'.repeat(2001))
  expect(await ui.find({ type: 'Text', text: /Error: message is too long/ })).toBeDefined()
  // nothing went out, the box is the same (the text stays in place)
  expect(hooks(t, 'say').length).toBe(0)
  expect(t.sent.length).toBe(0)
  expect(acks(t).length).toBe(0)
  expect((await box(ui))?.key).toBe('msg0')

  await submit(ui, 'b'.repeat(2000))
  expect(hooks(t, 'say').length).toBe(1)
  expect(t.sent.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Delivered to/ })).toBeDefined()
  expect((await box(ui))?.key).toBe('msg1')
  await ui.unmount()
})

test('seçili alt ajanın son yanıtı "Son yanıt (HH:MM)" olarak görünür, 300 karakterde kırpılır', async ($, on) => {
  const t = setup($, on)
  await begin($, ['abc123', 'Explore'], ['def456', 'Plan'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Last reply/ })).toBeUndefined()

  await answer($, 'abc123', 'Birinci ajan   bitirdi.\nSonuç tamam.')
  await answer($, 'def456', 'x'.repeat(1000))
  await answer($, undefined, 'Ana ajan yanıtı panelde görünmez')

  // no selection: the first sub-agent
  const first = await ui.find({ type: 'Text', text: /Last reply/ })
  expect(first?.text).toMatch(/^Last reply \(\d\d:\d\d\): Birinci ajan bitirdi\. Sonuç tamam\.$/)

  await ui.select({ key: 'agent', value: 'def456' })
  const second = await ui.find({ type: 'Text', text: /Last reply/ })
  expect(second?.text).toMatch(/^Last reply \(\d\d:\d\d\): x{299}…$/)
  expect(await ui.find({ type: 'Text', text: /Ana ajan yanıtı/ })).toBeUndefined()

  // at most 600 characters in the atom, only sub-agents
  const kept = t.writes.filter(w => w.key === 'replies').at(-1)?.value
  expect(Object.keys(kept).sort()).toEqual(['abc123', 'def456'])
  expect(kept.def456.text.length).toBe(600)
  expect(kept.abc123.t).toBeGreaterThan(1_700_000_000)
  await ui.unmount()
})

test('oturum bitince son yanıtlar, seçim, adlar ve durum sıfırlanır; kutu yeni key ile boş açılır', async ($, on) => {
  const t = setup($, on, { isDelivered: true }, { names: [{ aid: 'def456', nick: 'Kurt', role: 'Plan' }] })
  await begin($, ['abc123', 'Explore'], ['def456', 'Plan'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pollNames(t)

  await answer($, 'def456', 'bitti')
  await ui.select({ key: 'agent', value: 'def456' })
  await submit(ui, 'selam')
  await typeIn(ui, 'taslak')
  expect(t.sent.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Last reply/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Delivered to/ })).toBeDefined()
  const oldKey = (await box(ui))?.key

  await $.classic.SessionEnd({ reason: 'clear' })
  expect(await ui.find({ type: 'Text', text: /No workers yet/ })).toBeDefined()

  // a new sub-agent in a new session: the old reply, selection, name and status line are gone; the box has a new key
  await $.classic.SubagentStart({ agent_id: 'ghi789', agent_type: 'Explore', session_id: 'oturum-2' })
  const pick = await ui.find({ type: 'Select', key: 'agent' })
  expect(pick?.props.options).toEqual([{ value: 'ghi789', label: 'Explore' }])
  expect(pick?.props.value).toBe('ghi789')
  const el = await box(ui)
  expect(el?.key).toBeDefined()
  expect(el?.key).not.toBe(oldKey)
  expect(await ui.find({ type: 'Text', text: /Last reply/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Delivered to|Error:|Sending/ })).toBeUndefined()
  await ui.unmount()
})

test('teslim başarısız olunca kutu boşalmaz; sonraki başarılı gönderimde boşalır', async ($, on) => {
  const t = setup($, on, { isDelivered: false, reason: 'Ajan bulunamadı' })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await submit(ui, 'uzun bir mesaj')
  expect((await box(ui))?.key).toBe('msg0')
  expect(await ui.find({ type: 'Text', text: /^Error: Ajan bulunamadı · Your message is still in the box$/ })).toBeDefined()

  // second attempt (same box, same text) succeeds this time: the box is emptied
  t.sent.length = 0
  t.setSend({ isDelivered: true })
  await submit(ui, 'uzun bir mesaj')
  expect(t.sent.length).toBe(1)
  expect((await box(ui))?.key).toBe('msg1')
  expect(await ui.find({ type: 'Text', text: /Delivered to/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Your message is still in the box/ })).toBeUndefined()
  await ui.unmount()
})

test('teslim sürerken ikinci gönderim yok sayılır ("Gönderiliyor…"), kutu teslimden sonra boşalır', async ($, on) => {
  const t = setup($, on, { isDelivered: true }, { slowSay: true })
  await begin($, ['abc123', 'Explore'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const first = submit(ui, 'bir kez gitsin')
  await t.clock.advance(500)
  expect(await ui.find({ type: 'Text', text: /Sending…/ })).toBeDefined()
  // while delivery is in progress the box is not empty yet; the second Enter is ignored
  expect((await box(ui))?.key).toBe('msg0')
  await submit(ui, 'bir kez gitsin')
  expect(hooks(t, 'say').length).toBe(1)

  await t.clock.advance(2000)
  await first
  expect(hooks(t, 'say').length).toBe(1)
  expect(t.sent.length).toBe(1)
  expect((await box(ui))?.key).toBe('msg1')
  await ui.unmount()
})

test('panel summary: a zero counter is hidden; states are "working / waiting for approval / done"', async ($, on) => {
  setup($, on)
  await begin($, ['abc123', 'Explore'], ['def456', 'Plan'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /● 2 working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for approval|done/ })).toBeUndefined()
  await finish($, 'abc123', 'Explore')
  expect(await ui.find({ type: 'Text', text: /● 1 working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● 1 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /resting|waiting$/ })).toBeUndefined()
  await ui.unmount()
})
