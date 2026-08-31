# @qwickapps/jsai

In-browser AI backend resolver. A calling app writes its inference/orchestration logic
once, against one `chat(tier, ...)` interface, and this library resolves which backend
actually runs it: in-browser WebGPU, a local Ollama install, or a user-supplied API key
(Groq/OpenRouter) — whichever is available, in that order.

Extracted from a working demo (Sundai Hack 138, Boston 311 MCP project) rather than
designed on a whiteboard first — see `docs/availability-vs-capability.md` for the founding
finding that shapes how this library must behave.

## Status

Early extraction, not yet a stable API. Consumed today via direct GitHub file references
(jsDelivr's GitHub-CDN serving) from two demo apps; not yet published to a package registry.

## Usage

```js
import * as backend from 'https://cdn.jsdelivr.net/gh/qwickapps/jsai@main/backend-selector.js'

backend.configure({ namespace: 'my-app' }) // optional: namespaces localStorage, picks model

const detection = await backend.detectBackends()
const settings = backend.loadSettings()
const tier = backend.pickTier(detection, settings) // 'webgpu' | 'ollama' | 'byok' | null

const response = await backend.chat(tier, {
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 60,
})
```

See `backend-selector.js` for the full API: `detectWebgpu`, `detectOllama`,
`detectBackends`, `pickTier`, `chat`, `loadSettings`/`saveSettings`, `BYOK_PROVIDERS`.

## Design principles (see docs/ for the reasoning)

- **Availability detection is cheap and safe to run on every page load.**
  Capability detection is expensive (can require multiple real generations to establish) and
  must never be probed at runtime as part of resolving which tier to use — see
  `docs/availability-vs-capability.md`.
- **No server-credentialed tier by default.** A public static page cannot hold a server
  API key without exposing it to every visitor. Adding one is the host app's job, done
  server-side with its own budget controls.
- **BYO keys never leave the browser** except to the provider they're for. Never logged,
  never sent to any of this library's own infrastructure (it has none).
- **Which backend actually executed is observable**, per `docs/availability-vs-capability.md`'s
  "Design requirement" section — not just which tier was selected. Implemented so far for
  the `webgpu` tier only: `chat('webgpu', ...)`'s response includes `device: 'webgpu' |
  'wasm'`, so a silent driver-level fallback to WASM (~100x slower) is no longer invisible
  to the calling app. `ollama` and `byok` tiers have no such ambiguity (there's exactly one
  backend behind each), so they don't need this field.

## Known limitation: the Ollama tier cannot work from a hosted (non-local) page

**If your app is served from anywhere other than `localhost`/a private-network address,
`detectOllama()` will always fail — this is a hard Chrome security boundary, not a config
problem, and no `OLLAMA_ORIGINS` setting fixes it.** Verified directly, not assumed:

- Chrome's **Private Network Access (PNA)** policy blocks a page loaded from a public
  origin (any real HTTPS domain) from reaching a private/loopback address like
  `127.0.0.1` at all, *before* the target server or CORS is even consulted. The browser
  requires the target to answer the preflight with `Access-Control-Allow-Private-Network:
  true`.
- Ollama's server does not send that header — confirmed by reading
  [`server/routes.go`](https://github.com/ollama/ollama/blob/main/server/routes.go)'s CORS
  middleware directly. There is no Ollama setting that adds it.
- Reproduced live: loading a real hosted page and pointing it at a real local server gives
  `...has been blocked by CORS policy: Permission was denied for this request to access the
  \`loopback\` address space` — a PNA block, distinguishable from an ordinary CORS failure
  (`No 'Access-Control-Allow-Origin' header is present`, which is what the *same* request
  gets instead when the calling page itself is served from `localhost`).

**Consequence:** the Ollama tier only works when the host app itself is served locally
(`localhost`/LAN), where the request is loopback-to-loopback and PNA does not apply —
`OLLAMA_ORIGINS` is then the correct and sufficient fix, same as it always was. A hosted
public deployment of an app using this library should present the WebGPU or BYOK tier as
the real options and either hide the Ollama tier or clearly label it "local dev only."

This library does not currently detect PNA-vs-plain-CORS as a distinct failure reason in
`detectOllama()`'s `reason` string (both surface as a generic "unreachable" message) —
worth doing, since it would let a host app explain the *right* fix to a user instead of a
generic "check Ollama is running."

## Consumers

- `raajkumars/sundai-hack138-boston311-mcp` (Sundai Hack 138 project 2)
- `raajkumars/sundai-hackathon-2026-08-30` (Sundai Hack 138 project 1)
