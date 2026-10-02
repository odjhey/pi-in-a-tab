# Pi in a tab

A small, local-first way to run Pi Durable in a browser without installing the Pi coding agent. The whole agent harness runs in a SharedWorker, with conversation history, notes, and virtual files persisted in IndexedDB. A tiny Node server serves the app and forwards model calls using **your own** model credentials; it never saves your conversations. Reload or open another tab and pick up where you left off.

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

Restart the server and reload after changing configuration. `/api/models` lists only credentialed providers' chat models; a configured credential is not a guarantee that your account can access every model. Pi-ai refreshes dynamic provider catalogs at startup when credentials are available. Use the model picker; its selection is remembered separately for each app user in browser storage. Set `PI_MODEL=provider/modelId` for the initial default (for example `openai-codex/gpt-6.1-sol`); unavailable defaults fall back to an available model. Browser choices take precedence.

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

Usernames use letters, digits, `_` or `-`; passwords may contain colons but not commas. Passwords are scrypt-hashed in memory at startup. A signed, HttpOnly, SameSite cookie identifies the account; HTTPS origins get Secure cookies. App-account mode allows 20 model requests/minute per user. Logout revokes that session on the server and detaches tabs; revocations are kept in memory, so a server restart re-admits logged-out cookies until their 12-hour expiry (delete `.session-secret` and restart to invalidate every session). Erase-device closes the owner and removes that account's IndexedDB history and model preference. Close other tabs if the browser reports that deletion is blocked. Put configuration in ignored `.env` rather than committing it.

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

The same account's tabs share one worker. Each account has separate worker, IndexedDB, Web Lock, and model-preference names. Tools read/write a browser-only virtual workspace, update durable notes, or run JavaScript in a disposable worker. Safe reads can replay after recovery; writes and arbitrary JavaScript are marked unsafe and are not automatically replayed. CSP locks the app to its own origin; the JavaScript evaluator has `connect-src 'none'` and cannot create nested workers.

## Limits and trust

- State lives in **that browser profile and origin**, not on the Node server. Different devices, profiles, or URLs do not share history.
- Closing all tabs pauses the agent. Reopening restores persisted work; a reload while another tab/worker survives can keep a stream running. The browser may terminate background workers, and interrupted generations may be restarted rather than retain the exact token stream.
- Browser storage can be evicted or cleared. This is not a backup system.
- Your model provider sees prompts and tool results. The server keeps credentials locally but forwards requests to that provider.
- The JavaScript tool can read the user's own browser-origin data, including IndexedDB. It cannot fetch out under its CSP. App-account namespacing is not a security sandbox against hostile JavaScript on the same origin: only share with people you trust.
- Sharing a personal subscription with other people may breach the provider's terms. Check your plan before enabling multiple app accounts.
- Use a current browser supporting SharedWorker, IndexedDB, and Web Locks. Keep the server running while using the app.

## Credits

Built on [Pi / Earendil](https://earendil.com/posts/pi-durable/), whose Pi libraries are MIT-licensed. This app is MIT-licensed; see `LICENSE`.
