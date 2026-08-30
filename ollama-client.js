export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

export class OllamaClientError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'OllamaClientError'
    this.details = details
  }
}

function endpoint(baseUrl, path) {
  return `${String(baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '')}${path}`
}

async function fetchJson(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error.name === 'AbortError') throw new OllamaClientError(`Ollama request timed out after ${timeoutMs}ms`, { url })
    throw new OllamaClientError(`Cannot reach local Ollama at ${new URL(url).origin}: ${error.message}`, { url, cause: error })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new OllamaClientError(`Ollama ${new URL(url).pathname} -> HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`, { url, status: response.status })
  }
  return response.json()
}

export async function listOllamaModels(baseUrl = DEFAULT_OLLAMA_URL, fetchImpl = fetch) {
  const result = await fetchJson(endpoint(baseUrl, '/api/tags'), { method: 'GET' }, fetchImpl, 5000)
  if (!Array.isArray(result.models)) throw new OllamaClientError('Ollama /api/tags did not return a models array')
  return result.models
}

export async function preloadOllamaModel(baseUrl, model, fetchImpl = fetch) {
  if (!model) throw new OllamaClientError('An Ollama model name is required')
  const result = await fetchJson(
    endpoint(baseUrl, '/api/chat'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, keep_alive: '10m' }),
    },
    fetchImpl,
    300000
  )
  return {
    model: result.model || model,
    loadDurationMs: Math.round((result.load_duration || 0) / 1e6),
    totalDurationMs: Math.round((result.total_duration || 0) / 1e6),
  }
}

export function ollamaModelLabel(model) {
  const details = [model.details?.parameter_size, model.details?.quantization_level].filter(Boolean).join(' · ')
  return details ? `${model.name} — ${details}` : model.name
}

export async function chatOllama(baseUrl, request, fetchImpl = fetch) {
  if (!request?.model) throw new OllamaClientError('An Ollama model name is required')
  if (!Array.isArray(request.messages) || !request.messages.length) throw new OllamaClientError('Ollama chat requires at least one message')

  const body = {
    model: request.model,
    messages: request.messages,
    stream: false,
    options: { temperature: 0, ...(request.options || {}) },
  }
  if (request.tools?.length) body.tools = request.tools
  if (request.format) body.format = request.format
  if (request.keepAlive !== undefined) body.keep_alive = request.keepAlive

  const result = await fetchJson(
    endpoint(baseUrl, '/api/chat'),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    fetchImpl,
    request.timeoutMs || 300000
  )

  return {
    model: result.model || request.model,
    content: result.message?.content || '',
    thinking: result.message?.thinking || '',
    toolCalls: result.message?.tool_calls || [],
    totalDurationMs: Math.round((result.total_duration || 0) / 1e6),
    loadDurationMs: Math.round((result.load_duration || 0) / 1e6),
    promptTokens: result.prompt_eval_count || 0,
    outputTokens: result.eval_count || 0,
    raw: result,
  }
}

export function ollamaTools(mcpTools) {
  return mcpTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }))
}

export function directDecisionFormat(mcpTools) {
  return {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: mcpTools.map((tool) => tool.name) },
      arguments: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['category'],
        additionalProperties: false,
      },
    },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  }
}

export function structuredDirectDecision(response, mcpTools) {
  let parsed
  try { parsed = JSON.parse(response?.content || '') }
  catch (_) { throw new OllamaClientError('Ollama structured direct decision was not valid JSON') }

  const available = new Set(mcpTools.map((tool) => tool.name))
  if (!available.has(parsed.tool)) throw new OllamaClientError(`Ollama selected an unavailable tool: ${parsed.tool || '(missing)'}`)
  const category = parsed.arguments?.category?.trim()
  if (!category) throw new OllamaClientError('Ollama structured direct decision omitted category')

  const args = { category }
  const location = parsed.arguments?.location?.trim()
  if (parsed.tool === 'query_recent' && location && !/^none$/i.test(location)) args.location = location
  return { tool: parsed.tool, arguments: args }
}

export function toolCallDecision(response) {
  const fn = response?.toolCalls?.[0]?.function
  if (!fn?.name) return null
  let args = fn.arguments || {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch (_) { args = {} }
  }
  return { tool: fn.name, arguments: args }
}
