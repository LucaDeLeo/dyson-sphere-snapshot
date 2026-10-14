#!/usr/bin/env bun
// Who can use Dyson Sphere: the file the server reads from SPHERE_PEOPLE_FILE.
//
//   bun deploy/people.ts add <login> [--as <identity>]   a person; prints a token for their laptop
//   bun deploy/people.ts add <identity> --agent          an agent: tokens, no login
//   bun deploy/people.ts token <identity>                another token (a second machine)
//   bun deploy/people.ts remove <identity>
//   bun deploy/people.ts list
//
// The file is SPHERE_PEOPLE_FILE, else /etc/sphere/people.json. Restart sphere-server after
// a change; bridges reconnect on their own.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync, chownSync } from 'node:fs'

type Person = { identity: string; logins: string[]; tokens: string[] }

const FILE = process.env.SPHERE_PEOPLE_FILE ?? '/etc/sphere/people.json'
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? '') : null
}
const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

function load(): Person[] {
  if (!existsSync(FILE)) return []
  return (JSON.parse(readFileSync(FILE, 'utf8')) as { people: Person[] }).people.map(p => ({ identity: p.identity, logins: p.logins ?? [], tokens: p.tokens ?? [] }))
}

function save(people: Person[]) {
  // Atomic, and keeping the owner and mode: the file holds every token.
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify({ people }, null, 2) + '\n', { mode: 0o640 })
  if (existsSync(FILE)) {
    const st = statSync(FILE)
    chmodSync(tmp, st.mode & 0o777)
    try {
      chownSync(tmp, st.uid, st.gid)
    } catch {} // not root: the file stays ours
  }
  renameSync(tmp, FILE)
}

/** The name Dyson Sphere shows for a login: luca.deleo@example.org → luca. */
function identityFor(login: string): string {
  return login.toLowerCase().split('@')[0]!.split(/[.+]/)[0]!.replace(/[^a-z0-9-]/g, '')
}

const token = () => `sph_${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')}`
const valid = (id: string) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(id)

const [command, target] = args
const people = load()

switch (command) {
  case 'add': {
    if (!target) fail('usage: people.ts add <login> [--as <identity>] | add <identity> --agent')
    const agent = args.includes('--agent')
    if (!agent && !target!.includes('@')) fail(`${target} isn't a login (an email address). For an agent, add --agent.`)
    const identity = flag('as') ?? (agent ? target! : identityFor(target!))
    if (!valid(identity)) fail(`"${identity}" can't be an identity: use lowercase letters, digits and dashes. Choose one with --as.`)
    const login = agent ? null : target!.toLowerCase()
    if (login && people.some(p => p.logins.includes(login))) fail(`${login} is already set up`)
    const existing = people.find(p => p.identity === identity)
    if (existing && !flag('as')) fail(`${identity} already exists. To give this login that identity, pass --as ${identity}; to use another name, pass --as <name>.`)
    const t = token()
    if (existing) {
      if (login) existing.logins.push(login)
      existing.tokens.push(t)
    } else people.push({ identity, logins: login ? [login] : [], tokens: [t] })
    save(people)
    console.log(JSON.stringify({ identity, login, token: t }))
    break
  }
  case 'token': {
    const p = people.find(x => x.identity === target) ?? fail(`no one called ${target}`)
    const t = token()
    p.tokens.push(t)
    save(people)
    console.log(JSON.stringify({ identity: p.identity, token: t }))
    break
  }
  case 'remove': {
    if (!people.some(p => p.identity === target)) fail(`no one called ${target}`)
    save(people.filter(p => p.identity !== target))
    console.log(JSON.stringify({ removed: target }))
    break
  }
  case 'list':
    for (const p of people) console.log(`${p.identity.padEnd(16)} ${p.logins.join(', ') || '(agent)'}  ${p.tokens.length} token${p.tokens.length === 1 ? '' : 's'}`)
    break
  default:
    fail('usage: people.ts add | token | remove | list (see the top of this file)')
}
