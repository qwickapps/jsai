// @qwickapps/jsai — a narrow, separable in-browser inference resolver.
// The calling app's orchestration code calls chat(tier, ...) and never
// touches a specific backend directly, so orchestration logic is fully
// portable across whichever backend actually ends up running.
//
// Cascade, in order: in-browser WebGPU (no network, no setup) -> local
// Ollama (detected, offered) -> user-supplied API key (Groq/OpenRouter,
// stored in the browser only). There is deliberately no "our hosted LLM"
// tier — a public static page cannot hold a server credential without
// exposing it to everyone who loads the page. A host app that wants a
// server-proxied tier must add it itself, server-side, with its own
// budget/rate-limit controls; this library will not ship one by default.
//
// Every detection result carries WHY, not just whether — capability
// detection failing silently (the same app worked on an 8GB MacBook Air
// and failed on a strictly-better 12GB Lenovo Legion) is the actual
// problem this exists to diagnose, not just work around. See
// docs/availability-vs-capability.md for why capability detection is
// expensive and must not be probed at runtime the way availability is.

import { chatOllama, listOllamaModels, ollamaTools as toOpenAiTools, DEFAULT_OLLAMA_URL } from './ollama-client.js'

// Call configure() once, before any other export, to namespace localStorage
// per host app and/or pick a different default WebGPU model. Optional —
// sensible defaults work out of the box for a single-app page whose own
// origin hosts vendor/transformers.min.js and models/ at those paths.
//
// transformersUrl/modelPath are resolved against the HOST PAGE's URL
// (window.location.href), not against this module's own URL — this
// module is commonly loaded cross-origin (e.g. from a CDN), and a plain
// relative import/path here would otherwise resolve against the CDN's
// origin instead of the app's, 404ing on vendor/model assets that only
// exist on the app's own origin.
let SETTINGS_KEY = 'jsai-backend-settings-v1'
let WEBGPU_MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX'
let TRANSFORMERS_URL = './vendor/transformers.min.js'
let MODEL_PATH = './models/'
export function configure({ namespace, webgpuModel, transformersUrl, modelPath } = {}) {
  if (namespace) SETTINGS_KEY = `jsai-backend-settings-${namespace}-v1`
  if (webgpuModel) WEBGPU_MODEL = webgpuModel
  if (transformersUrl) TRANSFORMERS_URL = transformersUrl
  if (modelPath) MODEL_PATH = modelPath
}

let webgpuGenerator = null // lazily loaded transformers.js pipeline

// ---- settings (tier choice + BYO key) -------------------------------
// localStorage only. A BYO key never leaves the browser except to the
// provider the user chose it for — never logged, never sent to our infra,
// never included in run-metrics payloads (see index.html's metrics.record
// call sites: they pass structured numeric/text fields only, never the
// settings object).

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
  } catch (_) {
    return {}
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export const BYOK_PROVIDERS = {
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.1-8b-instruct' },
}

// ---- detection --------------------------------------------------------
// Each result: { available, reason }. reason is always populated, even
// when available is true (e.g. "adapter granted"), so a caller can log why
// a tier was or was not usable on this specific machine.

export async function detectWebgpu() {
  if (!('gpu' in navigator)) return { available: false, reason: 'navigator.gpu is undefined (no WebGPU support in this browser)' }
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return { available: false, reason: 'navigator.gpu.requestAdapter() returned null (no compatible GPU adapter)' }
    return { available: true, reason: 'GPU adapter granted' }
  } catch (error) {
    return { available: false, reason: `requestAdapter() threw: ${error.message}` }
  }
}

// If the calling page is not served from localhost/a private-network address,
// this will always fail with a generic "unreachable" reason — Chrome's
// Private Network Access policy blocks the request before Ollama is ever
// asked, and Ollama's server does not implement the preflight response that
// would allow it. No OLLAMA_ORIGINS setting fixes this. See README "Known
// limitation: the Ollama tier cannot work from a hosted (non-local) page".
export async function detectOllama(baseUrl = DEFAULT_OLLAMA_URL) {
  try {
    const models = await listOllamaModels(baseUrl)
    if (!models.length) return { available: false, reason: 'Ollama reachable but has no installed models', models: [] }
    return { available: true, reason: `Ollama reachable, ${models.length} model(s) installed`, models }
  } catch (error) {
    return { available: false, reason: `Ollama unreachable at ${baseUrl}: ${error.message}`, models: [] }
  }
}

export async function detectBackends(ollamaUrl) {
  const [webgpu, ollama] = await Promise.all([detectWebgpu(), detectOllama(ollamaUrl)])
  return { webgpu, ollama }
}

// Auto-pick the best available tier per the cascade order. BYO key is
// never auto-picked — it requires the user to have already entered one.
export function pickTier(detection, settings) {
  if (detection.webgpu.available) return 'webgpu'
  if (detection.ollama.available) return 'ollama'
  if (settings?.byok?.apiKey) return 'byok'
  return null
}

// ---- WebGPU adapter -----------------------------------------------------

let webgpuActualDevice = null // 'webgpu' or 'wasm' — which one actually initialized, not which was requested

async function loadWebgpuGenerator(onProgress) {
  if (webgpuGenerator) return webgpuGenerator
  const { pipeline, env } = await import(new URL(TRANSFORMERS_URL, window.location.href).href)
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = new URL(MODEL_PATH, window.location.href).href
  try {
    webgpuGenerator = await pipeline('text-generation', WEBGPU_MODEL, { dtype: 'q4', device: 'webgpu', progress_callback: onProgress })
    webgpuActualDevice = 'webgpu'
  } catch (_) {
    // Adapter probed available but device init still failed (driver-level) — fall back once, same as before.
    webgpuGenerator = await pipeline('text-generation', WEBGPU_MODEL, { dtype: 'q4', device: 'wasm', progress_callback: onProgress })
    webgpuActualDevice = 'wasm'
  }
  return webgpuGenerator
}

async function chatWebgpu({ messages, maxTokens = 60, onProgress }) {
  const generator = await loadWebgpuGenerator(onProgress)
  const started = performance.now()
  const out = await generator(messages, { max_new_tokens: maxTokens, do_sample: false })
  return {
    content: out[0].generated_text.at(-1).content,
    thinking: '',
    toolCalls: [],
    totalDurationMs: Math.round(performance.now() - started),
    loadDurationMs: 0,
    promptTokens: 0,
    outputTokens: 0,
    // Design requirement from docs/availability-vs-capability.md: which
    // backend actually executed must be observable, not just which tier
    // was selected. 'webgpu' requested but genuinely got 'wasm' (~100x
    // slower) is a real, silent-until-now failure mode this surfaces.
    device: webgpuActualDevice,
  }
}

// ---- Ollama adapter -----------------------------------------------------
// Thin pass-through to the existing, already-tested ollama-client.js.

async function chatOllamaAdapter({ messages, tools, format, maxTokens = 60, model, ollamaUrl }) {
  if (!model) throw new Error('No Ollama model selected')
  return chatOllama(ollamaUrl || DEFAULT_OLLAMA_URL, {
    model,
    messages,
    tools: tools?.length ? toOpenAiTools(tools) : undefined,
    format,
    options: { num_predict: maxTokens },
    keepAlive: '10m',
  })
}

// ---- BYO-key adapter (Groq / OpenRouter, OpenAI-compatible) -------------
// format (JSON-schema constrained decoding) is Ollama-specific and not
// honored here — same graceful-degrade-to-plain-text the app already
// relies on for direct-agent failures, and it's a real, measured data
// point per the project's own methodology, not a hidden gap.

async function chatByok({ messages, tools, maxTokens = 60, byok }) {
  if (!byok?.apiKey) throw new Error('No API key configured for the selected provider')
  const provider = BYOK_PROVIDERS[byok.provider] || { baseUrl: byok.baseUrl }
  const baseUrl = byok.baseUrl || provider.baseUrl
  const model = byok.model || provider.defaultModel
  const started = performance.now()
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${byok.apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
      tools: tools?.length ? toOpenAiTools(tools) : undefined,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${provider.label || byok.provider} chat/completions -> HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const data = await res.json()
  const choice = data.choices?.[0]?.message
  return {
    content: choice?.content || '',
    thinking: '',
    toolCalls: (choice?.tool_calls || []).map((tc) => ({ function: { name: tc.function?.name, arguments: tc.function?.arguments } })),
    totalDurationMs: Math.round(performance.now() - started),
    loadDurationMs: 0,
    promptTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  }
}

// ---- unified dispatch -----------------------------------------------------

export async function chat(tier, args) {
  if (tier === 'webgpu') return chatWebgpu(args)
  if (tier === 'ollama') return chatOllamaAdapter(args)
  if (tier === 'byok') return chatByok(args)
  throw new Error(`Unknown or unavailable backend tier: ${tier}`)
}
