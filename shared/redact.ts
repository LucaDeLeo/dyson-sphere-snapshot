// Secret redaction and one-line summaries for transcript rows the bridge builds itself (Codex
// sessions). The Claude Code mod keeps its own copy in mod/hooks/register.ts, since a mod can't
// import from outside its folder: change both together.

const SECRETS: [RegExp, string][] = [
  // To its end marker, or to the end of the text when it was cut short.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[redacted]'],
  [/((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi, '$1[redacted]'],
]

export const redact = (s: string) => SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), s)

export const firstLine = (s: string) => {
  const line = s.split('\n').find(l => l.trim()) ?? ''
  return line.length > 140 ? line.slice(0, 139) + '…' : line
}
