// The viewer's own Linear account (CS-2524), as the server tells it: whether changes in Linear can
// be made from this page, and as whom. The token never reaches the page.
import type { LinearAccount } from '../../../shared/protocol'
import { cmd, emit, state, toast, useChannel } from '../live'

export type AccountState = LinearAccount | { unsupported: true } | null

/** null: not asked yet. `unsupported`: a server from before Linear accounts. */
let account: AccountState = null
let askedIn = -1

/** The viewer's account, asked once per connection; re-renders the caller when it changes. */
export function useLinearAccount(): AccountState {
  useChannel('linear-account')
  useChannel('conn')
  if (state.conn === 'open' && askedIn !== state.epoch) {
    askedIn = state.epoch
    void refreshAccount()
  }
  return account
}

export async function refreshAccount() {
  try {
    account = await cmd<LinearAccount>('linear.account')
  } catch (e) {
    // An older server doesn't know the command: the page offers nothing it can't do. Anything
    // else (the database, for a moment) is asked again in a few seconds.
    if (!/unknown op/.test((e as Error).message)) {
      setTimeout(() => (askedIn = -1, emit('linear-account')), 5000)
      return
    }
    account = { unsupported: true }
  }
  emit('linear-account')
}

/** Off to Linear to say yes; Linear sends this tab back to the canvas, which says how it went. */
export async function connectLinear() {
  try {
    const { url } = await cmd<{ url: string }>('linear.connect')
    location.assign(url)
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

export async function disconnectLinear() {
  try {
    const r = await cmd<{ revoked?: boolean }>('linear.disconnect')
    if (r.revoked === false) toast("Disconnected your Linear account here, but Linear couldn't be asked to revoke its access: revoke Dyson Sphere in Linear's settings.", 'error')
    else toast('Disconnected your Linear account.')
  } catch (e) {
    toast((e as Error).message, 'error')
  }
  await refreshAccount()
}

// Back from Linear: take it off the address, and once the canvas is up, say how it went.
{
  const q = new URLSearchParams(location.search)
  const result = q.get('linear')
  if (result) {
    const why = q.get('why') ?? 'unknown error'
    q.delete('linear')
    q.delete('why')
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`)
    const say = () => {
      if (!state.loaded) return void setTimeout(say, 250)
      if (result === 'connected') toast('Connected your Linear account. Ticket changes you make here are made as you.')
      else toast(`Couldn't connect Linear: ${why}`, 'error')
    }
    say()
  }
}
