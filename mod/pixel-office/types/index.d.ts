export type ActorState = 'thinking' | 'typing' | 'reading' | 'delegating' | 'waiting' | 'done'

export type Actor = {
  id: string
  label: string
  kind: 'main' | 'sub'
  state: ActorState
  detail: string
  target: string
  since: number
  updated: number
  tools: number
}

// the last turn reply of a sub-agent (in the panel "Son yanıt (HH:MM)", i.e. Last reply (HH:MM)): text at most 600 characters, t seconds (Date.now() / 1000)
export type Reply = { text: string; t: number }

// the status line in the panel's "Message a worker" section. id: id of the message that produced the status ('' = not tied to a message),
// kind: idle / sending / delivered / error, text: the line shown on screen
export type SendStatus = { id: string; kind: 'idle' | 'sending' | 'ok' | 'error'; text: string }

// person name and task info given by the server (GET /names): nick "Hayalet", role "Mod testi", kind "Uzman"
export type Who = { nick: string; role: string; kind: string }

declare module 'claude-code' {
  interface PluginState {
    'pixel-office': {
      // agents in the session (main agent + sub-agents), by id
      actors: Record<string, Actor>
      // last reply by sub-agent id (updated on turn.complete, at most 30 agents are kept)
      replies: Record<string, Reply>
      // id of the sub-agent selected in Select ('' = not selected yet, the first sub-agent counts)
      selected: string
      // Number of delivered messages. The message box's key depends on it: it changes when delivery succeeds, the box opens empty
      // (if it fails the text stays in the box). The typed draft is NOT KEPT in an atom: writing an atom on every key made letters get lost.
      sendSeq: number
      // person names from the server, by sub-agent id (main agent: 'main'); empty if the server is down
      names: Record<string, Who>
      // When Send is pressed: "Sending…" -> "✓ İletildi" (delivered) or "Hata: <neden>" (error: <reason>)
      sendStatus: SendStatus
    }
  }
}
