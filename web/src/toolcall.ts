// Tool calls as text: the main argument and description of a call, from its input or from a
// row's "<Name> <json>" text. Pure, so the transcript and its tests can use it without the canvas.

export type ParsedCall = { name: string; main: string | null; mainKey: string | null; desc: string | null; input: Record<string, unknown> | null; raw: string | null }

/** Splits a tool-call summary ("Bash {json}") into the tool, its main argument and its description. */
export function parseToolCall(text: string): ParsedCall {
  const m = text.match(/^(\S+)\s+(\{[\s\S]*)$/)
  if (!m) return { name: text.split(/\s/, 1)[0] ?? '', main: null, mainKey: null, desc: null, input: null, raw: null }
  let input: Record<string, unknown> | null = null
  try {
    input = JSON.parse(m[2]!)
  } catch {
    // Summaries are cut short, so the JSON may not close: pull the main argument out directly.
    const arg = m[2]!.match(/"(command|file_path|pattern|url|query|path|prompt|skill)"\s*:\s*"((?:[^"\\]|\\.)*)/)
    if (arg) return { name: m[1]!, main: arg[2]!.replace(/\\"/g, '"'), mainKey: arg[1]!, desc: null, input: null, raw: m[2]! }
  }
  return describeCall(m[1]!, input, input ? null : m[2]!)
}

/** A tool call's main argument and description, from its input. */
export function describeCall(name: string, input: Record<string, unknown> | null, raw: string | null = null): ParsedCall {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (input && typeof input[k] === 'string' && input[k]) return k
    return null
  }
  const mainKey = pick('command', 'file_path', 'pattern', 'url', 'query', 'path', 'prompt', 'skill', 'to')
  const descKey = pick('description')
  return {
    name,
    main: mainKey ? (input![mainKey] as string) : null,
    mainKey,
    desc: descKey ? (input![descKey] as string) : null,
    input,
    raw,
  }
}
