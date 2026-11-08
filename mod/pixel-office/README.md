# pixel-office (Claude plugin)

The plugin name `pixel-office` is just an identifier (it is the folder, command and pane id); the product it connects to is **NorthLight Tower** (subtitle: Pixel Office).

It shows the agents in a session (the main agent + sub-agents) **in a side panel inside Claude** and forwards the same events
to the NorthLight Tower server on this computer (`127.0.0.1:8765`). Permission requests, tool calls and sub-agents
starting and finishing are taken directly from events, not guessed.

## What it does

- When a session starts, the "NorthLight Tower" panel opens by itself. You can close it; the `/pixel-office` command opens it again.
- For every worker: the state (Working / Waiting for approval / Done), what it is doing, and when it started. A state whose count is zero is hidden in the summary line at the top.
- The box of a worker that is waiting for approval turns red.
- If the NorthLight Tower server is running, the same information also goes to the office scene (an exact "waiting for approval", details of running sub-agents).
- **Messaging (v0.3+):** it fetches the message you write in the tower's chat box from the server every two seconds; it delivers it to a sub-agent
  with `$.session.send` (this wakes a finished sub-agent) and sends it to the main agent as if it were your own words.
  The agent's reply (line breaks are kept, at most 4000 characters) and the images produced by tools (e.g. PixelLab) go back to the tower.
  While Claude is in "auto mode", a direct send cannot pass the permission check; the user added a `SendMessage` permission rule to the settings (`AddPlugin.bat`, the Windows installer script, exactly as it is called today),
  so the message goes directly. Without the rule, the plugin hands the message to the main agent as "forward this" (`via the manager`); it does not try to bypass the check. This temporary refusal
  does not last for the whole session: direct sending is retried after 10 minutes or after every 5 messages, and it is also reset when the session ends.
- **Message from the panel:** in the "Message a worker" section at the bottom of the panel, pick a worker (finished ones are marked "(done)"),
  type your message and press **Enter** or use the box's own "send" hint (at most 2000 characters; there is no separate Send button).
  The message is first recorded on the server as `say` (it appears in the chat in the tower), then delivered the way described above (directly,
  or through the main agent if that fails). The status line reads "Sending…" → "Delivered to Ghost ✓" or "Error: …".
  The selected sub-agent's last reply appears in the same section as "Last reply (HH:MM): …". The phone surface has no text box.
  The text you type is not kept in an atom (writing an atom on every keystroke used to lose letters) and no `value` is given to the Input; the panel
  may also be redrawn while you type because of agent events, but redrawing must not damage what you typed (this behaviour of the host
  has not been verified live). The box is emptied only when delivery succeeds; if delivery fails your text stays in the box ("Your message is still in the box").
  While one delivery is in progress, a second send is ignored.
- **Names (v0.7):** if the NorthLight Tower server is running (`/names`, about every 5 s), the list and the picker show a person name + task title
  such as "Ghost · Mod test"; if the server is down, the old label ("Explore") is used. There is no id code ("#48ec").
- **Frame of the message sent to a sub-agent (v0.7):** below the user's text, this is appended: "Give your reply as a single sentence starting with 'SUMMARY:',
  then add the details briefly below it; avoid technical jargon." (the text sent to the main agent does not change).
- **Stop (v0.7):** the "Stop" button in the tower is queued on the server as a `stop` request. For the main agent the running turn
  is cut with `$.turn.abort` (if there is no running turn: "already stopped"); for a sub-agent the `TaskStop` tool is called. If TaskStop is refused or
  fails, the message "STOP: drop what you are doing right now and briefly say what you have done." is sent to the sub-agent (directly, or through the main agent
  if that fails). The result is reported to the server with `ack` (`TaskStop`, `by message`, `turn stopped`, `already stopped`, or the error reason).
  No permission check is bypassed; TaskStop goes through the normal permission flow. For a sub-agent that has already finished, neither TaskStop nor the "STOP" message
  is sent (the message would wake it up again): the ack is "already stopped". If "STOP" went through the main agent, the ack honestly says
  "STOP request passed to the manager (it will see it on its next step)".
- **v0.7.3:** the delivery-queue poll reports the plugin version (`mv=0.7.3`): the tower does not send "Stop" to an older plugin (the old version would take it for an
  empty message and write it to Claude). Error reasons are shown in the panel in plain English; the "Could not stop:" prefix is not doubled.
- **v0.7.2:** truncated texts (task summary, reply sent to the chat) no longer cut an emoji in half; images are sent to the server with the `path` field
  (the envelope's `src: 'mod'` field is no longer overwritten); if an error happens while a permission check is running, a "Waiting for approval" notification is no longer sent by mistake;
  the worker id is validated on the fallback path ("Invalid worker"); for a main worker whose turn id is unknown but that still looks like it is running,
  Stop says "You need to stop it from the Claude window"; the status texts are "Waiting for approval" / "Finished".
- It does not call a model on its own and adds nothing to the context; an agent's turn only runs if you write it a message.

## Privacy and safety

- It never changes the session: on every event it continues with `next(e)`, and if an error occurs it silently moves on.
- It sends data only to `http://127.0.0.1:8765/hook`; it reads person names from `http://127.0.0.1:8765/names` (same computer). If the server is down, nothing happens.
- What is sent: the tool name, a file name/command summary, the agent type; the agent's end-of-turn reply (only if you wrote a message from the tower,
  to show it in the chat), the text of the message you typed in the panel (to show it in the chat in the tower) and the image addresses found in tool results. File contents are not sent
  (the user's latest prompt is shown as the "task" with its first 160 characters). All of it goes to 127.0.0.1 only.

## Installation

It is enough to tell Claude "enable the mod". Claude puts the mod in the session folder and Claude asks "Enable mods?"; if you approve, it is loaded.
For a permanent installation, you can add this folder from Claude's own menu (+ > Plugins > Add marketplace).

## Development

```
claude plugin validate .
claude plugin test .
```
