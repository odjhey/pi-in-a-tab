# Pi in a tab

A small, local-first way to run Pi Durable in a browser without installing the Pi coding agent. The whole agent harness runs in a SharedWorker, with conversation history, notes, and virtual files persisted in IndexedDB. A tiny Node server serves the app and forwards model calls using **your own** model credentials; it never saves your conversations. Reload or open another tab and pick up where you left off.

**Experimental demo — not safe for production or untrusted users.** This is a just-for-fun exploration of what Pi Durable unlocks, not a hardened agent service. Only use it with people you trust and credentials you are comfortable spending. **God mode (`page_js`) is especially dangerous:** after approval it runs code with the main app's privileges. Prompt injection can manipulate the UI, read or erase browser-origin data, and make authenticated model-proxy calls on your budget. Code approval is not a security sandbox.
Generated custom tools are also untrusted code. They run in the network-blocked eval worker and are replay-unsafe, but can consume CPU/memory and produce misleading results. Downloaded generated HTML is not a sandbox: inspect it before opening outside this demo.

## Branch workspace

- A nested conversation tree and one to four live panes, each with its own model, transcript, notes, files, and composer. Click a branch to watch it.
- Fork any transcript entry once or into two to four branches. Give each branch an optional instruction and model; instructed branches start in parallel. Forks of forks work.
- Files and notes are rewindable conversation documents: forks inherit them **as of the selected entry**, then change independently. Files are capped at 32 KiB UTF-8 each and the serialized workspace at 128 KiB; notes at 32 KiB. Existing small `/workspace` files are imported into the root once, best effort. The IndexedDB filesystem now only backs the durable JSONL log.
- `delegate` runs one to three child conversations in parallel and returns their answers to the parent's tool call. `delegate_background` lets the parent answer immediately and delivers a durable follow-up when each child finishes. Both appear under their parent in the tree. Runaway protection: two subagent levels, twelve children per parent, three per call.
- A focused-tab handler registry lets agents open panes, highlight turns, show toasts, change theme, and render durable inline SVG charts. Pure UI rendering is replay-safe. The most recently focused attached tab executes actions; no attached tab produces a clear tool error.
- `ask_user` blocks on an Approve/Reject card with an optional reason. Cards and answers are conversation documents keyed by durable tool task IDs, so reloading reacquires the same pending decision rather than losing an in-memory promise.
- On-demand ask_form(title, schema, uiHints?) waits for a validated answer or cancellation; show_form stays open and turns each submission into a follow-up user message. Vanilla controls cover nested objects, primitive/object arrays with add/remove, required/default/title/description, enum and oneOf/const choices, email/date/url, numeric bounds and slider/multiline hints (JSON pointer paths). Drafts and cards survive reload; worker-side @cfworker/json-schema validation does not use eval. This is a useful subset, not a renderer for arbitrary JSON Schema.
- schedule_reminder(delaySeconds OR atISO, message) creates a conversation-owned background Pi Durable task with a persisted absolute deadline and runtime.sleep. Its follow-up includes lateness, and a pane countdown has a cancel button. Timers cannot execute with every browser tab closed; overdue work resumes on reopen. Forks start with no inherited reminders.
- A per-pane time-travel slider highlights a transcript entry and reads files/notes with snapshotAsOf. History is read-only: dragging never changes a document. Fork from here creates a new branch at the selected position; Back to live restores current resources.
- define_tool(name, description, parametersSchema, code), list_tools, and remove_tool let the agent extend its own toolbox. Definitions live in a rewindable asOf conversation document. Registry extensions hot-load per conversation at phase boundaries; a fork before the definition lacks it and one after inherits it. Generated function bodies get args and read-only fs in the eval worker, never the page/owner; tools are replay-unsafe. Inspect code under Custom tools.
- `stage_run` builds and drives interactive DOM widgets inside a `sandbox="allow-scripts"` opaque-origin iframe. It returns the value, console messages, and runtime errors. The stage has its own CSP: `unsafe-eval` is allowed there, but network, nested workers, frames, and forms are blocked. `stage_reset` replaces the iframe.
- `page_js(code, reason)` is refused unless the visible **God mode** toggle is on (off initially). Every call then requires a separate approval card showing the code and reason. Reject is reported back to the model. Pending approvals can resume; page JS already dispatched before a crash is not automatically run again.

### Five-minute demo

1. Set `PI_TAB_RATE_LIMIT=120` before starting if comparing several tool-using agents (the default remains 20 model requests/minute per signed-in user).
2. Ask the root: “Write `comparison.txt` containing ROOT, save notes saying ROOT NOTES, then reply ready.” Wait for the final reply.
3. On that final reply, choose **Fork ×N**, select two branches, and give each an instruction to read then change `comparison.txt` differently. Pick Azure for one and Codex for the other if both are configured. Watch them beside the root; expand each pane's files to compare. Reload: the branches, files, and notes remain.
4. Ask the parent: “Use delegate with three tasks in one call: a product pitch, a skeptic's objection, and a technical explanation of browser-local agents. Compose their answers.” Open the three children from the tree while they stream.
5. Ask: “Use delegate_background for a detailed comparison of browser-local versus server-side agents; immediately say you'll report back.” The parent replies first; the child's answer arrives later as a follow-up. Reload mid-run to observe recovery.
6. Ask: “Open conversation 1 in a pane, show a chart of three options with values 3, 5, 8, and highlight this turn.” Try a theme change or toast too; focus another attached tab to show action routing.
7. Ask: “Use ask_user to ask whether I approve the next step, then tell me the answer.” Reload while the card is pending, optionally add a reason, and approve or reject. The waiting run continues.
8. Ask: “Use stage_run to build a counter with a button, click the button twice, and return its visible count.” Interact with the widget yourself; reset it or reload to show the difference between durable conversations and a transient sandbox DOM.
9. With God mode off, ask the agent to use `page_js` to retitle the page header: the tool refuses. Enable God mode, repeat, inspect the code card, and approve. Try again and reject: the page stays unchanged and the model sees the rejection.
10. Ask: “Plan a trip using ask_form: nested traveler name/email, destination choices, bounded days, travelers array of objects, interests array of strings, and multiline notes.” Enter a partial brief, reload, try an invalid email, then submit. Ask for a non-blocking show_form to send several structured follow-ups.
11. Ask: “Schedule a reminder in 15 seconds to write reminder.txt saying I RETURNED; reply scheduled now.” Close all tabs, reopen after the deadline, and watch the overdue reminder drive the agent. Schedule another and cancel it from the pane.
12. Ask the agent to change a file and notes twice. Drag the time-travel slider between the final replies to compare historical resources, then Fork from here and verify the fork inherits the older version.
13. Ask: “Define csv_stats with a csv string parameter; return numeric row count, sum, and mean.” Next turn ask it to call csv_stats on 2,4,6. Fork before the definition and ask list_tools; then fork after it and compare inherited definitions.

This demonstrates a native conversation/task/document runtime in the user's browser, not a claim that LangGraph lacks persistence or time travel. No custom orchestration graph or server-side transcript database is involved.

## Quickstart

Install **Node 22.19.0 or newer** (Pi-ai's minimum; this app also uses Node's built-in `.env` loader). Download this repo, then run these three commands:

```sh
cd pi-in-a-tab
npm install
npm start
```

Open **http://localhost:4474**. With no credentials, the page explains how to set them up. `npm start` builds the browser bundles in ignored `dist/` and starts the server. No global Pi installation, build step, database server, or remote service is needed beyond your chosen model provider.

## Your model credentials

Credentials are discovered in this order:

1. **OpenCode Go:** put `OPENCODE_API_KEY=your-key` in `.env`, or export that variable before starting. This enables both `opencode-go` and `opencode` catalogs.
2. **Other API keys:** use Pi-ai's provider environment mapping, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, etc. All Pi-ai built-in chat providers use their own auth handlers. An existing shell variable wins over `.env`; configured environment credentials win over stored credentials.
   - **Azure OpenAI:** set `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_BASE_URL` (e.g. `https://<resource>.services.ai.azure.com/openai/v1`, or set `AZURE_OPENAI_RESOURCE_NAME` instead). pi-ai uses the model id as the deployment name; if your deployment is named differently, set `AZURE_OPENAI_DEPLOYMENT_NAME_MAP='gpt-5.6-luna=my-deployment'`. Pick the matching model in the picker or set `PI_MODEL=azure-openai-responses/<model-id>`. The picker lists every Azure catalog model, but only the ones you have deployed will answer.
3. **Subscription OAuth:** run `npm run login` and choose a provider, or `npm run login -- openai-codex` (also Anthropic, GitHub Copilot, and the other OAuth providers offered by Pi-ai). This wraps Pi-ai's own interactive OAuth CLI. Logins go to ignored, owner-only `auth.json` in this repo, deliberately keeping new logins separate from an existing Pi installation.
4. **Already use Pi? It just works:** existing credentials in `~/.pi/agent/auth.json` are read automatically, before the repo-local login file. Pi-ai resolves credentials and refreshes OAuth tokens; refreshed tokens are written back to their original store under a Pi-compatible file lock. No credential values are logged or sent to the browser.

Restart the server and reload after changing configuration. `/api/models` lists only credentialed providers' chat models; a configured credential is not a guarantee that your account can access every model. Pi-ai refreshes dynamic provider catalogs at startup when credentials are available. Each conversation's model selection is persisted in its durable agent document. Set `PI_MODEL=provider/modelId` for a new root's initial default (for example `openai-codex/gpt-6.1-sol`); unavailable defaults fall back to an available model. Existing conversations keep their own model.

After an app update, an older open tab can still own the browser-local agent. If you see “This app was updated” or “Waiting for an older tab to close”, close the other tabs for this site and reload. Your conversation is kept; old `minimal` thinking settings are upgraded to `low` when reopened. Provider failures appear as model errors in the transcript.

## Share over Tailscale

Default binding is `127.0.0.1`, with one local user and no app login. Before exposing it through a reverse proxy, enable app accounts. These accounts isolate browser state, **not provider billing or credentials**: all accounts use the server owner's configured models. Each friend should normally run their own copy with their own model login.

```sh
# Replace the origin with your machine's actual Tailscale HTTPS origin.
PI_TAB_USERS='alice:choose-a-strong-password,bob:choose-another-password' \
PI_ALLOWED_ORIGINS='https://your-machine.your-tailnet.ts.net' npm start
# In another terminal:
tailscale serve --bg http://127.0.0.1:4474
```

Only devices permitted by your tailnet policy can reach that URL. `PI_ALLOWED_ORIGINS` is a comma-separated list of exact origins, without paths or trailing slashes. Use HTTPS so SharedWorker and Web Locks are available away from localhost. `tailscale serve off` stops sharing. For LAN use, `HOST=0.0.0.0` binds all interfaces, but the server refuses non-loopback binding without `PI_TAB_USERS`. `PORT` changes the port (default 4474). A localhost reverse proxy still needs accounts even though its upstream is loopback: without `PI_TAB_USERS` the server refuses to start with a non-loopback `PI_ALLOWED_ORIGINS` and rejects requests carrying common proxy headers (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, Tailscale, Cloudflare). A proxy that strips those headers and rewrites `Host` to localhost defeats that check, so never expose a no-accounts instance.

Usernames use letters, digits, `_` or `-`; passwords may contain colons but not commas. Passwords are scrypt-hashed in memory at startup. A signed, HttpOnly, SameSite cookie identifies the account; HTTPS origins get Secure cookies. App-account mode allows 20 model requests/minute per user by default; `PI_TAB_RATE_LIMIT` sets a positive integer requests/minute allowance (e.g. `120` for parallel demos). Sign-in attempts retain their separate 20/minute limit. Logout revokes that session on the server and detaches tabs; revocations are kept in memory, so a server restart re-admits logged-out cookies until their 12-hour expiry (delete `.session-secret` and restart to invalidate every session). Erase-device closes the owner and removes that account's IndexedDB history and pane preferences. Close other tabs if the browser reports that deletion is blocked. Put configuration in ignored `.env` rather than committing it.

## How it works

```text
Browser tabs ── SharedWorker (Pi Durable harness + Web Lock)
                     │                      │
                IndexedDB / JSONL       same-origin model stream
                                            │
                                      local Node server
                                            │
                                      model provider
```

The same account's tabs share one worker and every conversation's live stream. Each account has separate worker, IndexedDB, Web Lock, and pane-preference names. Workspace files and notes are conversation documents; `js_eval` runs in a disposable worker against that conversation's frozen file snapshot.

Forks use native `Conversation.fork()` and rewindable `fork: 'asOf'` documents. Foreground delegates own children through their tool task; background delegates use native anchor and reporter tasks with idempotent submission IDs.

Safe reads, UI rendering, approval waits, and foreground delegation can replay after recovery. File writes, `js_eval`, and sandbox execution are unsafe and are not automatically replayed. The guarded `page_js` task can reacquire its approval or cached result, but records an execution boundary so already-dispatched page code is not run again after a crash.

CSP restricts the main app to its own origin. The evaluation worker and opaque-origin stage cannot fetch or create nested workers; approved main-page JavaScript can call the authenticated same-origin model proxy.

## Limits and trust

- State lives in **that browser profile and origin**, not on the Node server. Different devices, profiles, or URLs do not share history.
- Closing all tabs pauses the agent. Reopening restores persisted work; a reload while another tab/worker survives can keep a stream running. The browser may terminate background workers. In the Chromium demo, reloading mid-delegation created a new owner, restored the same three child IDs and parent tool call, restarted interrupted model generations from their saved request phase, and completed the parent's composed answer without duplicate children. It does not retain the exact in-flight token stream.
- Browser storage can be evicted or cleared. This is not a backup system.
- Stage DOM/window state is transient: reload, reset, or closing its pane discards it. A stage timeout stops waiting, not arbitrary JavaScript; reset replaces the iframe to stop asynchronous work. Synchronous infinite loops can freeze the renderer because an iframe is not a worker.
- The main document now allows CSP `unsafe-eval` solely for approved `page_js`; the SharedWorker keeps its stricter policy. The default-off toggle and per-call card are demonstration controls, not a defense against hostile code once approved.
- Your model provider sees prompts and tool results. The server keeps credentials locally but forwards requests to that provider.
- `js_eval` can read the user's own browser-origin data, including IndexedDB, but cannot fetch under its worker CSP. Approved `page_js` can access origin data and authenticated same-origin endpoints. App-account namespacing is not a security sandbox against hostile JavaScript on the same origin: only share with people you trust.
- Sharing a personal subscription with other people may breach the provider's terms. Check your plan before enabling multiple app accounts.
- Use a current browser supporting SharedWorker, IndexedDB, and Web Locks. Keep the server running while using the app.

## Credits

Built on [Pi / Earendil](https://earendil.com/posts/pi-durable/), whose Pi libraries are MIT-licensed. This app is MIT-licensed; see `LICENSE`.
