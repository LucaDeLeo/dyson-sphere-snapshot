# Product

## Register

product

## Users

A small engineering team (five developers at most, in London and Boston) and the agents
working for them. Each developer runs several Claude Code sessions at once, on their
laptop or on a shared server. They open Dyson Sphere in a browser, usually beside their
editor or terminal, to see what every agent on the team is doing, answer the ones waiting
on them, and steer or suggest. External agents (a commander agent, scripts, other
models) use the same system through the `sphere` CLI.

The primary task on the canvas is to answer "what is happening right now, and does
anything need me?" in a glance, then act on it without leaving the page: approve a tool
call, send a message, read a transcript, leave a note for a teammate.

## Product Purpose

Dyson Sphere shows every Claude Code session across the team, live, on one shared
infinite canvas. People drag sessions into an arrangement that makes sense to them, add
notes, see each other's cursors, and follow each other's view. Every session is
steerable from the canvas: owners send, interrupt and approve permissions; others
suggest and the owner approves.

Success means nobody asks "what is your agent doing?" anymore, no agent sits idle
waiting on a human who didn't notice, and handing work between people and between
laptop and server is routine.

## Brand Personality

Calm, precise, alive. The interface itself is quiet: neutral chrome, small type, no
decoration. The motion and color come from the agents: work arriving, tools running,
messages travelling, requests waiting. When nothing is happening, the canvas is still.

References, and what each gets right:
- **Figma**: an infinite canvas people arrange together, live cursors, follow mode.
- **Linear**: density and status at a glance, crisp typography, everything reachable
  by keyboard.
- **tldraw / FigJam**: smooth canvas feel, sticky notes, named cursors.
- **Vercel / Grafana**: live activity and logs that update in place.

## Anti-references

- Generic SaaS dashboards: KPI tiles, hero metrics, gradient accents, identical card
  grids.
- Decorative motion: anything that moves without an event behind it (idle shimmer,
  looping spinners on finished work, ambient particles).
- The game-like 3D world we started from: pretty, but harder to read and click.

## Design Principles

1. **Motion is data.** Every animation corresponds to a real event, and stops when the
   events stop (estra's accuracy contract: no invented motion, unknown is not zero).
2. **Red means you.** The strongest signal is reserved for things waiting on the person
   looking; everything else stays quiet.
3. **Zoom changes detail, not just size.** Far out: who is working and where. Close
   in: the transcript, the diff, the pending request.
4. **Act where you look.** Approve, steer and suggest in place on the canvas, not in a
   separate admin screen.
5. **The arrangement belongs to the team.** Positions and notes persist and are shared,
   like a Figma file.

## Accessibility & Inclusion

WCAG 2.2 AA: text contrast at least 4.5:1, full keyboard access to every action,
visible focus, and a reduced-motion mode in which every animation becomes a crossfade
or an instant change.
