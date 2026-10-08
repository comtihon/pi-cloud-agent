// pi → ACP `session/update` payloads. Pure functions.

import { matchToolsFromCommand } from '../tools.js'

export const RAW_OUTPUT_MAX_CHARS = 8000

const BUILTIN_KIND = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  bash: 'execute',
  grep: 'search',
  find: 'search',
  ls: 'search',
}

const FETCHY = /(^|[_.\-])(get|fetch|search|list|read|query|find|lookup|describe|show|view|download)/i

export function truncate(text, max = RAW_OUTPUT_MAX_CHARS) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text))
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s
}

/**
 * Which MCP server a tool call goes to, or null for a built-in.
 * pi-mcp-adapter exposes either one proxy tool `mcp({tool, server?, ...})` or
 * direct tools named `<server>_<tool>`; `serverNames` are the mcp.json keys.
 */
export function mcpTarget(toolName, args, serverNames = []) {
  const byPrefix = (name) => {
    if (typeof name !== 'string') return null
    let best = null
    let bestPrefix = ''
    for (const s of serverNames) {
      // pi-mcp-adapter prefixes tools with the server name, '-' → '_'.
      for (const p of new Set([s, s.replace(/-/g, '_')])) {
        if ((name === p || name.startsWith(`${p}_`)) && p.length > bestPrefix.length) {
          best = s
          bestPrefix = p
        }
      }
    }
    return best ? { server: best, tool: name.slice(bestPrefix.length + 1) || name } : null
  }
  if (BUILTIN_KIND[toolName]) return null
  if (toolName === 'mcp') {
    const tool = typeof args?.tool === 'string' ? args.tool : null
    const hit = byPrefix(tool)
    const server = (typeof args?.server === 'string' && args.server) || hit?.server || null
    return { server, tool: hit?.tool || tool || (args?.search ? 'search' : args?.describe ? 'describe' : null) }
  }
  return byPrefix(toolName)
}

export function toolKind(toolName, args, serverNames) {
  if (BUILTIN_KIND[toolName]) return BUILTIN_KIND[toolName]
  const target = mcpTarget(toolName, args, serverNames)
  if (target) return FETCHY.test(target.tool || '') ? 'fetch' : 'other'
  return 'other'
}

function oneLine(s, max = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export function toolTitle(toolName, args = {}, serverNames) {
  switch (toolName) {
    case 'bash': return `bash: ${oneLine(args.command ?? args.cmd)}`
    case 'read': return `read ${args.path ?? args.file_path ?? ''}`.trim()
    case 'write': return `write ${args.path ?? args.file_path ?? ''}`.trim()
    case 'edit': return `edit ${args.path ?? args.file_path ?? ''}`.trim()
    case 'grep': return `grep ${oneLine(args.pattern)}`.trim()
    case 'find': return `find ${oneLine(args.pattern ?? args.path)}`.trim()
    case 'ls': return `ls ${args.path ?? ''}`.trim()
    default: break
  }
  const target = mcpTarget(toolName, args, serverNames)
  if (target) return `${target.server || 'mcp'} → ${target.tool || toolName}`
  return toolName
}

/** Text of a pi tool result (`{content: [...]}`), or a JSON rendering. */
export function toolResultText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const content = Array.isArray(result) ? result : result.content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? `[image ${c.mimeType || ''}]` : JSON.stringify(c)))
      .join('\n')
  }
  try { return JSON.stringify(result) } catch { return String(result) }
}

export function toolCallUpdate({ toolCallId, toolName, args }, { serverNames = [], registeredTools = [] } = {}) {
  const update = {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: toolTitle(toolName, args, serverNames),
    kind: toolKind(toolName, args, serverNames),
    status: 'in_progress',
    rawInput: args ?? {},
  }
  const carrier = { tool_name: toolName }
  const target = mcpTarget(toolName, args, serverNames)
  if (target) {
    carrier.mcp_server = target.server
    carrier.mcp_tool = target.tool
  }
  if (toolName === 'bash') {
    const tools = matchToolsFromCommand(args?.command ?? '', registeredTools)
    if (tools.length) carrier.tools = tools
  }
  update._meta = { carrier }
  return update
}

export function toolResultUpdate({ toolCallId, result, isError }) {
  const text = truncate(toolResultText(result))
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: isError ? 'failed' : 'completed',
    rawOutput: text,
    content: text ? [{ type: 'content', content: { type: 'text', text } }] : [],
  }
}

export function textChunk(kind, text) {
  return { sessionUpdate: kind, content: { type: 'text', text } }
}

/**
 * Replay a pi message history as ACP updates (session/load): user text,
 * assistant text/thinking, tool calls and their results.
 */
export function historyUpdates(messages, opts = {}) {
  const out = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'user') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || [])
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) out.push(textChunk('user_message_chunk', b.text))
        else if (b?.type === 'image') out.push({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: b.data, mimeType: b.mimeType } })
      }
    } else if (m.role === 'assistant') {
      for (const b of m.content || []) {
        if (b?.type === 'text' && b.text) out.push(textChunk('agent_message_chunk', b.text))
        else if (b?.type === 'thinking' && b.thinking) out.push(textChunk('agent_thought_chunk', b.thinking))
        else if (b?.type === 'toolCall') {
          out.push({ ...toolCallUpdate({ toolCallId: b.id, toolName: b.name, args: b.arguments }, opts), status: 'completed' })
        }
      }
    } else if (m.role === 'toolResult') {
      out.push(toolResultUpdate({ toolCallId: m.toolCallId, result: m, isError: m.isError }))
    }
  }
  return out
}

/** ACP ContentBlock[] → pi prompt text + images. */
export function promptFromBlocks(blocks) {
  const parts = []
  const images = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue
    switch (b.type) {
      case 'text':
        if (b.text) parts.push(b.text)
        break
      case 'image':
        if (b.data) images.push({ type: 'image', data: b.data, mimeType: b.mimeType || 'image/png' })
        else if (b.uri) parts.push(`[image: ${b.uri}]`)
        break
      case 'resource_link':
        parts.push(`[resource: ${b.name || ''} ${b.uri}]`.replace(/\s+\]/, ']'))
        break
      case 'resource':
        if (typeof b.resource?.text === 'string') parts.push(`<resource uri="${b.resource.uri || ''}">\n${b.resource.text}\n</resource>`)
        else if (b.resource?.uri) parts.push(`[resource: ${b.resource.uri}]`)
        break
      default:
        break
    }
  }
  return { text: parts.join('\n\n'), images }
}
