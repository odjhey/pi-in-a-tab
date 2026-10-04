# Pi in a tab

A whole AI agent that lives in your browser tab. The agent loop, its conversations, files, subagents, timers and approvals all run in a SharedWorker and are saved in IndexedDB. A tiny Node server only serves the page and forwards model calls with **your own** model credentials, or you can pick an on-device WebGPU model and skip the server's models entirely. The server never stores your conversations.

It is built on [Pi Durable](https://earendil.com/posts/pi-durable/), Earendil's durable runtime for Pi agents. Pi Durable saves an agent's conversations, tasks and documents to storage as they change, so an agent can stop at any point (reload, crash, closed tab) and continue from where it was. This repo shows what that makes possible when the runtime sits in the browser.

**Experimental demo — not safe for production or untrusted users.** This is a just-for-fun exploration of what Pi Durable unlocks, not a hardened agent service. Only use it with people you trust and credentials you are comfortable spending. Local WebGPU downloads third-party model/WASM artifacts and can exhaust GPU memory or browser storage; it does not make agent tools safer. **God mode (`page_js`) is especially dangerous:** after approval it runs code with the main app's privileges. Prompt injection can manipulate the UI, read or erase browser-origin data, and make authenticated model-proxy calls on your budget. Code approval is not a security sandbox.
Generated custom tools are also untrusted code. They run in the network-blocked eval worker and are replay-unsafe, but can consume CPU/memory and produce misleading results. The eval worker is same-origin, so it is not a security boundary for browser-local IndexedDB storage. Downloaded generated HTML is not a sandbox: inspect it before opening outside this demo.

## What this demo is trying to show

Agent frameworks such as LangGraph already have persistence, human-in-the-loop interrupts and time travel. The point here is where the agent lives and what that changes:

- **No backend state.** Everything the agent knows is in your browser. Stop the Node server mid-task and nothing is lost; restart it and the next model call continues. Open DevTools, then Application, then IndexedDB to see the whole history.
- **Branching is cheap.** Fork any message into up to four branches, each with its own model, files and notes as they were at that message, and watch them run side by side.
- **Agents that wait and resume.** Approvals, forms and reminders are durable records, not in-memory promises. Reload while the agent is waiting and the same card is still there.
- **The agent can reach the UI.** Named frontend actions, generated forms, a sandboxed stage for its own mini apps, and, if you allow it, JavaScript in the page.
- **The model can be local too.** Run Qwen2.5 1.5B on your GPU and nothing leaves the device.

## Explore it

Sign in, then paste these into the message box of the Root pane. Each one shows a different part of the runtime. The Explore panel in the app has the same examples as one-click buttons.

### Branches

1. **Fork and compare.** Send: `Write plan.txt containing "v1: launch in March" and save notes saying "root plan". Then reply PLAN READY.` On that reply, click **Fork ×N**, pick ×2, and give one branch "Rewrite plan.txt as an aggressive plan" and the other "Rewrite plan.txt as a cautious plan". Pick a different model for each if you have two. Compare **Branch files** in the three panes, then reload. All three versions remain.
2. **Time travel.** Send: `Write a.txt containing "one". Then change a.txt to "two". Then change it to "three". Reply after each step.` Drag the **Live files and notes** slider under the pane to see `a.txt` at each message. Click **Fork from here** at "two" to start a branch from that version.

### Agents

3. **Subagents.** Send: `Use delegate to run three subagents in parallel: an optimist, a skeptic and a lawyer, each giving two sentences on "AI agents that live in your browser". Then combine their answers into a verdict.` Click the children in the Branch explorer to watch them stream. Reload while they run; they resume without duplicates.
4. **Background subagent.** Send: `Use delegate_background to research the pros and cons of browser-local agents in detail. Reply immediately that you'll report back.` The parent answers first and the child's report arrives later as a follow-up.
5. **Reminders.** Send: `Use schedule_reminder to remind yourself in 60 seconds to write reminder.txt saying "I came back". Reply scheduled.` Close every tab for this site, wait two minutes and reopen. The reminder fires late, says how late, and writes the file.
6. **The agent writes its own tool.** Send: `Use define_tool to create csv_stats(csv) that returns the count, sum and mean of comma-separated numbers. Then call it on "3,4,5".` Open **Custom tools** to read the code. Fork from a message before the definition and ask `list_tools`; that branch has no such tool.

### UI

7. **Forms on demand.** Send: `Use ask_form to plan a trip: destination (choice of Lisbon, Kyoto, Mexico City), start date, budget as a slider from 500 to 5000, and travellers as a list of {name, email}.` Fill half of it, reload, finish and submit. Try an invalid email to see validation.
8. **Approval that survives reload.** Send: `Use ask_user to ask whether I approve publishing the plan, then tell me what I chose.` Reload while the card waits, then Approve or Reject.
9. **Frontend actions.** Send: `Show a bar chart of five programming languages by popularity, switch the theme to light, and show a toast saying "done".`
10. **Sandbox stage.** Send: `Use stage_run to build a tic-tac-toe board, play three moves in code, and return the board state.` The board runs in an isolated iframe with no network access.
11. **God mode.** Send: `Use page_js to change the page header to "Hacked by Pi".` With **God mode** off the agent is refused. Turn it on, ask again, read the code on the approval card, and approve. Read the warning above first.
12. **Deck studio.** Click **Deck studio**. Fill in the brief, flip through the slides, approve, and download `deck.html`. Fork the draft with "make it bold" and "make it playful" to compare two decks.

### Models

13. **A model in your browser.** In a pane's model picker choose **webgpu-local · Qwen2.5 1.5B**, then send `Tell me one fun fact about cats. Do not use tools.` The first load downloads about 880 MB; later loads take a few seconds. DevTools Network shows no `/api/model` calls. The model is small, so expect weak answers and failed tool calls.

If you start the server yourself, set `PI_TAB_RATE_LIMIT=120` before trying forks and subagents. The default of 20 model requests per minute per user runs out quickly.

## This is one side of Pi Durable

Putting the whole runtime in a browser tab is one way to use Pi Durable. The same conversations, tasks, documents and timers run on a server too, and that opens different products. In separate local experiments we also ran:

- **A shared server agent.** Several browser tabs, or several people, watch and steer the same live conversation. The conversation survived the server being killed and restarted.
- **Per-user coding sandboxes.** Each user's agent edits and tests code in its own Docker container, and a read-only reviewer agent checks the work.
- **Approve, then dispatch.** An agent proposes a change, a different person approves it, and a server task publishes it even after the requester closes the browser. It survived three forced kills and produced one published file. Exactly-once delivery came from an idempotent destination, not from Pi alone.

Ideas we have not built yet include one durable agent per project or tenant (for example on Cloudflare Durable Objects), private drafts in the tab that are later published into a shared server room, and agents in Slack or Discord threads where each thread is a fork. If one of these fits your product, the primitives in this repo (forks, child agents, durable waits, timers, rewindable documents) are the same ones you would use.

## Feature reference

- A nested conversation tree and one to four live panes, each with its own model, transcript, notes, files, and composer. Click a branch to watch it.
- Fork any transcript entry once or into two to four branches. Give each branch an optional instruction and model; instructed branches start in parallel. Forks of forks work.
- Files and notes are rewindable conversation documents: forks inherit them **as of the selected entry**, then change independently. Files are capped at 32 KiB UTF-8 each and the serialized workspace at 128 KiB; notes at 32 KiB. Existing small `/workspace` files are imported into the root once, best effort. The IndexedDB filesystem now only backs the durable JSONL log.
- `delegate` runs one to three child conversations in parallel and returns their answers to the parent's tool call. `delegate_background` lets the parent answer immediately and delivers a durable follow-up when each child finishes. Both appear under their parent in the tree. Runaway protection: two subagent levels, twelve children per parent, three per call.
- A focused-tab handler registry lets agents open panes, highlight turns, show toasts, change theme, and render durable inline SVG charts. Pure UI rendering is replay-safe. The most recently focused attached tab executes actions; no attached tab produces a clear tool error.
- `ask_user` blocks on an Approve/Reject card with an optional reason. Cards and answers are conversation documents keyed by durable tool task IDs, so reloading reacquires the same pending decision rather than losing an in-memory promise.
- On-demand ask_form(title, schema, uiHints?) waits for a validated answer or cancellation; show_form stays open and turns each submission into a follow-up user message. Vanilla controls cover nested objects, primitive/object arrays with add/remove, required/default/title/description, enum and oneOf/const choices, email/date/url, numeric bounds and slider/multiline hints (JSON pointer paths). Drafts and cards survive reload; worker-side @cfworker/json-schema validation does not use eval. This is a useful subset, not a renderer for arbitrary JSON Schema.
  Empty scalar forms can be cancelled without a draft; URL format is checked as an absolute URI. Draft saves are debounced by 150 ms, and submission flushes the latest draft.
  Pending form controls stay mounted across draft echoes and same-account sign-ins in other tabs, preserving keyboard focus, caret, and unsaved values. Logout and account switches still detach immediately.
- schedule_reminder(delaySeconds OR atISO, message) creates a conversation-owned background Pi Durable task with a persisted absolute deadline and runtime.sleep. Its follow-up includes lateness, and a pane countdown has a cancel button. Timers cannot execute with every browser tab closed; overdue work resumes on reopen. Forks start with no inherited reminders.
  Reminder deadlines are memoized once per durable tool task, so recovery does not restart the delay.
- A per-pane time-travel slider highlights a transcript entry and reads files/notes with snapshotAsOf. History is read-only: dragging never changes a document. Fork from here creates a new branch at the selected position; Back to live restores current resources.
- define_tool(name, description, parametersSchema, code), list_tools, and remove_tool let the agent extend its own toolbox. Definitions live in a rewindable asOf conversation document. Registry extensions hot-load per conversation at phase boundaries; a fork before the definition lacks it and one after inherits it. Generated function bodies get args and read-only fs in the eval worker, never the page/owner; tools are replay-unsafe. Inspect code under Custom tools.
  Multiple definitions can be added in one parallel tool round; registry updates read the committed document, not a stale per-call copy.
- Deck studio is a one-click guided demo: ask_form collects a brief, the agent drafts deck.slides.json, and a safe in-pane viewer provides Previous/Next navigation. ask_user gates publication; after approval the agent writes a self-contained deck.html branch file and download_file adds a durable browser download link. Nothing uploads anywhere. Fork the draft with tone variants to compare decks side by side.
- `stage_run` builds and drives interactive DOM widgets inside a `sandbox="allow-scripts"` opaque-origin iframe. It returns the value, console messages, and runtime errors. The stage has its own CSP: `unsafe-eval` is allowed there, but network, nested workers, frames, and forms are blocked. `stage_reset` replaces the iframe.
- `page_js(code, reason)` is refused unless the visible **God mode** toggle is on (off initially). Every call then requires a separate approval card showing the code and reason. Reject is reported back to the model. Pending approvals can resume; page JS already dispatched before a crash is not automatically run again.
- `webgpu-local` runs Qwen2.5 1.5B q4 on your GPU in a dedicated worker spawned by the focused tab, with streaming text and native Qwen tool-call parsing bridged to the durable owner. No model credentials or `/api/model` requests; weights and WASM are cached in Cache Storage. Download/compile progress, load time, and generation speed appear above the panes.

## Quickstart

Install **Node 22.19.0 or newer** (Pi-ai's minimum; this app also uses Node's built-in `.env` loader). Download this repo, then run these three commands:

```sh
cd pi-in-a-tab
npm install
npm start
```

Open **http://localhost:4474**. With no model credentials, the picker still offers the local WebGPU model. `npm start` builds the browser bundles in ignored `dist/` and starts the server. No global Pi installation, build step, database server, or remote inference service is needed for local chat.

## Local WebGPU inference

Choose **webgpu-local · Qwen2.5 1.5B** in any branch's model picker. Or start new roots locally with `PI_MODEL=webgpu-local/Qwen2.5-1.5B-Instruct-q4f16_1-MLC npm start`. Server model credentials are optional. Initial setup downloads approximately 881 MB of public model artifacts; WebLLM expects about 1.6 GB GPU memory. Use current Chrome on HTTPS or localhost with WebGPU and `shader-f16`; an unavailable adapter produces an explicit model error, never a silent server fallback.

Qwen2.5 1.5B instruct q4 is small enough for a browser demo and understands its native `<tool_call>` protocol. WebLLM's built-in `tools` parameter only supports larger Hermes models, so this provider supplies Qwen's tool schema prompt and parses tagged JSON itself. Pi-ai's `getCurrentSystemPrompt` and `getCurrentTools` project the normalized transcript, including dynamic tool changes. Tools still execute through Pi Durable's existing tool registry and approval policy. The 1.5B model is weak at tool selection, paths, arithmetic, and following corrections; it may invent answers or emit invalid calls. Verify results in the files/transcript, not the model's claims. Text-only, 4096-token context including tool schemas, at most 512 generated tokens; oversized contexts fail rather than being silently truncated. Local forks/subagents queue on one engine per inference tab.

Weights, tokenizer/config, and WASM use WebLLM's origin-wide Cache Storage. Reload keeps conversations in IndexedDB and avoids re-downloading cached weights; the new dedicated worker still loads weights and compiles GPU programs. Browser storage eviction or clearing site data forces a new download. Model cache contains public weights, not prompts; model choice and conversation data remain per-account. The most recently focused attached tab owns inference for that request. Closing/reloading it mid-generation aborts that request; no attached tab produces an error. Closing all tabs stops the durable owner.

Only the inference worker's CSP permits model origins in addition to `self`: `https://huggingface.co`, its observed weight redirect `https://us.aws.cdn.hf.co`, and `https://raw.githubusercontent.com` for WebLLM's prebuilt WASM. Only `/webgpu-worker.js` gains `wasm-unsafe-eval`; the durable owner, sandbox stage, and JS evaluator retain their existing network restrictions. CDN changes can require updating this explicit allowlist. **Experimental risk:** downloaded third-party model/WASM artifacts execute in a same-origin worker, consume significant GPU/storage resources, and are not integrity-pinned. Local inference does not make agent tools or God mode safe.

On this Apple GPU Mac, Chrome exposed working WebGPU adapters in Window, DedicatedWorker, and SharedWorker. The shipped engine uses the focused tab's dedicated worker for portability and to keep GPU/WASM code out of the durable owner. A worker-CDP-instrumented prototype became unresponsive during reload proof; native reload without that instrumentation succeeded.

## Your model credentials

Credentials are discovered in this order:

1. **OpenCode Go:** put `OPENCODE_API_KEY=your-key` in `.env`, or export that variable before starting. This enables both `opencode-go` and `opencode` catalogs.
2. **Other API keys:** use Pi-ai's provider environment mapping, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, etc. All Pi-ai built-in chat providers use their own auth handlers. An existing shell variable wins over `.env`; configured environment credentials win over stored credentials.
   - **Azure OpenAI:** set `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_BASE_URL` (e.g. `https://<resource>.services.ai.azure.com/openai/v1`, or set `AZURE_OPENAI_RESOURCE_NAME` instead). pi-ai uses the model id as the deployment name; if your deployment is named differently, set `AZURE_OPENAI_DEPLOYMENT_NAME_MAP='gpt-5.6-luna=my-deployment'`. Pick the matching model in the picker or set `PI_MODEL=azure-openai-responses/<model-id>`. The picker lists every Azure catalog model, but only the ones you have deployed will answer.
3. **Subscription OAuth:** run `npm run login` and choose a provider, or `npm run login -- openai-codex` (also Anthropic, GitHub Copilot, and the other OAuth providers offered by Pi-ai). This wraps Pi-ai's own interactive OAuth CLI. Logins go to ignored, owner-only `auth.json` in this repo, deliberately keeping new logins separate from an existing Pi installation.
4. **Already use Pi? It just works:** existing credentials in `~/.pi/agent/auth.json` are read automatically, before the repo-local login file. Pi-ai resolves credentials and refreshes OAuth tokens; refreshed tokens are written back to their original store under a Pi-compatible file lock. No credential values are logged or sent to the browser.

Restart the server and reload after changing configuration. `/api/models` lists credentialed providers' chat models plus the credential-free local WebGPU model; a configured credential is not a guarantee that your account can access every server model. Pi-ai refreshes dynamic provider catalogs at startup when credentials are available. Each conversation's model selection is persisted in its durable agent document. Set `PI_MODEL=provider/modelId` for a new root's initial default (for example `openai-codex/gpt-6.1-sol`); unavailable defaults fall back to an available model. Existing conversations keep their own model.

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
