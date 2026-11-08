The first public release of **NorthLight Tower**: a local pixel-art cyberpunk tower that shows your live Claude Code / Claude Desktop sessions as an office full of workers.

## Highlights
- **One office per Claude chat**, with tabs. The main agent sits in the manager's room; every sub-agent walks in and takes a desk.
- **Live status** for every worker: Working, Waiting for approval, Done, plus "TASK DONE" and "APPROVAL NEEDED" holograms.
- **Gallery** of the images, GIFs and videos your workers produce.
- **Talk to workers** (message, stop, revise, retry, attach files) through the optional Claude plugin.
- **9 world themes**. English interface by default; Turkish is built in (Settings > Language).
- **100% local**: binds to `127.0.0.1`, read-only access to Claude's logs, no telemetry, uses no tokens by itself.

## Install
1. Download `NorthLight-Tower-v1.0.0.zip`, unpack it and make sure Python 3 is installed.
2. Windows: run `CreateShortcut.bat` and use the desktop icon. Mac / Linux: run `python server.py` and open http://127.0.0.1:8765.
3. Optional: run `AddPlugin.bat` (or `python plugin_setup.py add`) to message and stop workers from the tower.

## Notes
- Tested on Windows. macOS and Linux should work but are untested.
- Also available on itch.io (pay what you want, $0 is fine): https://fediac.itch.io/northlight-tower
- MIT licensed. Contact: northlightstudios25@gmail.com
