// Changes in Linear from Dyson Sphere (CS-2523): a ticket's status, assignee and title, and new
// tickets. Each goes to Linear as one person (`Ask`, from LinearAccounts.request), and Linear's
// answer, checked by `toTicket`, is what canvases are told.
//
// People pick statuses and assignees from lists; the CLI names them (`--status "In Review"`,
// `--assignee me`), which are looked up in the ticket's team here.
import type { Ticket } from '../../shared/protocol'
import { LinearError, TICKET_FIELDS, toTicket } from './linear'

/** One query or mutation as a given person. */
export type Ask = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>

export type TeamRef = { id: string; key: string; name: string }
export type Status = { id: string; name: string; type: string; color: string }
export type Member = { id: string; name: string; displayName: string | null }
/** What a ticket can be changed to: its team's statuses and people, and who is asking. */
export type TeamOptions = { team: TeamRef; statuses: Status[]; members: Member[]; viewer: string; ticket?: Ticket | null }

/** A user error: what was asked for isn't something Linear has. */
export class ChangeError extends Error {}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : null)

const TEAM_FIELDS = `id key name
  states(first: 100) { nodes { id name type color position } }
  members(first: 250) { nodes { id name displayName active } }`

function teamOptions(team: any, viewer: string): TeamOptions {
  if (typeof team?.id !== 'string') throw new LinearError("Linear's answer had no team", 'rejected')
  const statuses = ((team.states?.nodes ?? []) as any[])
    .filter(s => typeof s?.id === 'string')
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map(s => ({ id: s.id, name: text(s.name, 60) ?? 'Unknown', type: text(s.type, 20) ?? 'unknown', color: typeof s.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#95a2b3' }))
  const members = ((team.members?.nodes ?? []) as any[])
    .filter(m => typeof m?.id === 'string' && m.active !== false)
    .map(m => ({ id: m.id, name: text(m.name, 80) ?? text(m.displayName, 80) ?? 'Someone', displayName: text(m.displayName, 80) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { team: { id: team.id, key: text(team.key, 10) ?? '', name: text(team.name, 80) ?? '' }, statuses, members, viewer }
}

/** A ticket's team's statuses and people, or a team's by key or id. */
export async function optionsFor(ask: Ask, of: { ticket: string } | { team: string }): Promise<TeamOptions> {
  if ('ticket' in of) {
    // The ticket as it is now too, read as the person: a form starts from it, server key or not.
    const d = await ask<{ viewer: { id: string }; issue: { team: unknown } | null }>(
      `query TicketOptions($id: String!) { viewer { id } issue(id: $id) { ${TICKET_FIELDS} team { ${TEAM_FIELDS} } } }`,
      { id: of.ticket },
    )
    if (!d.issue) throw new ChangeError(`Linear has no ticket ${of.ticket}`)
    return { ...teamOptions(d.issue.team, d.viewer.id), ticket: toTicket(d.issue) }
  }
  const team = (await teams(ask)).find(t => t.key.toUpperCase() === of.team.toUpperCase() || t.id === of.team)
  if (!team) throw new ChangeError(`no team ${of.team} in your Linear workspace`)
  const d = await ask<{ viewer: { id: string }; team: unknown }>(`query TeamOptions($id: String!) { viewer { id } team(id: $id) { ${TEAM_FIELDS} } }`, { id: team.id })
  return teamOptions(d.team, d.viewer.id)
}

/** The teams the person can see in Linear. */
export async function teams(ask: Ask): Promise<TeamRef[]> {
  const d = await ask<{ teams?: { nodes?: any[] } }>('query Teams { teams(first: 250) { nodes { id key name } } }')
  return (d.teams?.nodes ?? [])
    .filter(t => typeof t?.id === 'string')
    .map(t => ({ id: t.id, key: text(t.key, 10) ?? '', name: text(t.name, 80) ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** A status by id, or by name in the team (any case). */
export function statusId(o: TeamOptions, want: string): string {
  const hit = o.statuses.find(s => s.id === want) ?? o.statuses.find(s => s.name.toLowerCase() === want.trim().toLowerCase())
  if (!hit) throw new ChangeError(`${o.team.key} has no status "${want}"; it has ${o.statuses.map(s => s.name).join(', ')}`)
  return hit.id
}

/** A person by id, or by name, display name or "me"; "none" (or null) unassigns. */
export function assigneeId(o: TeamOptions, want: string | null): string | null {
  if (want === null || want.trim().toLowerCase() === 'none') return null
  const w = want.trim().toLowerCase()
  if (w === 'me') return o.viewer
  const byId = o.members.find(m => m.id === want)
  if (byId) return byId.id
  const hits = o.members.filter(m => m.name.toLowerCase() === w || m.displayName?.toLowerCase() === w)
  const loose = hits.length ? hits : o.members.filter(m => m.name.toLowerCase().split(/\s+/).includes(w))
  if (loose.length === 1) return loose[0]!.id
  if (!loose.length) throw new ChangeError(`nobody called "${want}" in ${o.team.key}`)
  throw new ChangeError(`"${want}" could be ${loose.map(m => m.name).join(' or ')}`)
}

/** What a change can set. Only what's given changes; `assigneeId: null` unassigns. */
export type TicketChange = { title?: string; stateId?: string; assigneeId?: string | null }

/** Changes a ticket. Linear's answer is the ticket as it is now. */
export async function updateTicket(ask: Ask, id: string, change: TicketChange): Promise<Ticket> {
  const input: Record<string, unknown> = {}
  if (change.title !== undefined) {
    const title = text(change.title, 255)
    if (!title) throw new ChangeError('a ticket needs a title')
    input.title = title
  }
  if (change.stateId !== undefined) input.stateId = change.stateId
  if (change.assigneeId !== undefined) input.assigneeId = change.assigneeId
  if (!Object.keys(input).length) throw new ChangeError('nothing to change: give a status, assignee or title')
  const d = await ask<{ issueUpdate?: { success?: boolean; issue?: unknown } }>(
    `mutation TicketUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${TICKET_FIELDS} } } }`,
    { id, input },
  )
  return answered(d.issueUpdate, `change ${id}`)
}

/** Makes a ticket in a team. */
export async function createTicket(ask: Ask, t: { teamId: string; title: string; description?: string | null }): Promise<Ticket> {
  const title = text(t.title, 255)
  if (!title) throw new ChangeError('a ticket needs a title')
  // The description keeps its lines: it's Markdown.
  const description = typeof t.description === 'string' && t.description.trim() ? t.description.replaceAll('\0', '').slice(0, 50_000) : undefined
  const d = await ask<{ issueCreate?: { success?: boolean; issue?: unknown } }>(
    `mutation TicketCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${TICKET_FIELDS} } } }`,
    { input: { teamId: t.teamId, title, ...(description && { description }) } },
  )
  return answered(d.issueCreate, 'make the ticket')
}

/** A comment on a ticket, in Markdown. Returns its link. */
export async function commentOn(ask: Ask, id: string, body: string): Promise<{ id: string; url: string | null }> {
  const text = typeof body === 'string' ? body.replaceAll('\0', '').trim().slice(0, 50_000) : ''
  if (!text) throw new ChangeError('a comment needs some text')
  const d = await ask<{ commentCreate?: { success?: boolean; comment?: { id?: unknown; url?: unknown } } }>(
    'mutation TicketComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }',
    { input: { issueId: id, body: text } },
  )
  const c = d.commentCreate?.success ? d.commentCreate.comment : null
  if (typeof c?.id !== 'string') throw new LinearError(`Linear didn't add the comment to ${id}`, 'rejected')
  return { id: c.id, url: typeof c.url === 'string' && c.url.startsWith('https://linear.app/') ? c.url : null }
}

/** A ticket as Linear has it now, read as this person. */
export async function readTicket(ask: Ask, id: string): Promise<Ticket | null> {
  const d = await ask<{ issues?: { nodes?: unknown[] } }>(
    `query Ticket($filter: IssueFilter!) { issues(filter: $filter, first: 1, includeArchived: true) { nodes { ${TICKET_FIELDS} } } }`,
    { filter: { team: { key: { eq: id.split('-')[0] } }, number: { eq: Number(id.split('-')[1]) } } },
  )
  const n = d.issues?.nodes?.[0]
  return n ? toTicket(n) : null
}

function answered(payload: { success?: boolean; issue?: unknown } | undefined, what: string): Ticket {
  const ticket = payload?.success ? toTicket(payload.issue) : null
  if (!ticket) throw new LinearError(`Linear didn't ${what}`, 'rejected')
  return ticket
}
