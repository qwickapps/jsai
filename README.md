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
- **Open requirement, not yet implemented:** which backend *actually executed* a request
  must become an observable, first-class output of `chat()` — not just which tier was
  selected. See `docs/availability-vs-capability.md`, "Design requirement" section.

## Consumers

- `raajkumars/sundai-hack138-boston311-mcp` (Sundai Hack 138 project 2)
- `raajkumars/sundai-hackathon-2026-08-30` (Sundai Hack 138 project 1) — pending
