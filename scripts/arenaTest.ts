import { ArenaWorld, arenaClass, RESPAWN_SECONDS, type ArenaEvent } from '../src/sim/arena'
import { SAIL_FIGHTING } from '../src/sim/ship'
import { angleDiff, clamp } from '../src/core/math'

/**
 * The open sea, headless: two scripted captains are put within sight of each
 * other and left to fight. Checks that the shared world does what the server
 * promises the browsers — shot is announced and retired, a sinking is
 * credited to whoever fired the ball, the wreck spills plunder, and her
 * captain is raised again somewhere else.
 *
 *   npm run arena
 */
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failures.push(what)
}

const sea = new ArenaWorld(0x5ea)
sea.join(1, 'Anne', arenaClass('sloop'))
sea.join(2, 'Mary', arenaClass('sloop'))
const a = sea.captains.get(1)!
const b = sea.captains.get(2)!
check(!!a.ship && !!b.ship, 'both captains are raised on joining')
const raisedApart = Math.hypot(a.ship!.pos.x - b.ship!.pos.x, a.ship!.pos.y - b.ship!.pos.y)
check(raisedApart > 600, `raised well apart (${raisedApart.toFixed(0)} px)`)

// Bring them together in open water: the fight is the thing under test, not
// the search for one.
for (const ship of [a.ship!, b.ship!]) {
  const near = { ...a.ship!.pos }
  if (ship === b.ship) near.x += 300
  ship.pos = { ...near }
  ship.prevPos = { ...near }
}

/** Steer to bring the other ship onto the beam once in range, otherwise close her. */
const pilot = (me: typeof a, them: typeof a) => {
  const ship = me.ship
  const target = them.ship
  if (!ship || ship.sunk || !target || target.sunk) return
  const bearing = Math.atan2(target.pos.y - ship.pos.y, target.pos.x - ship.pos.x)
  const range = Math.hypot(target.pos.x - ship.pos.x, target.pos.y - ship.pos.y)
  const desired = range > 260 ? bearing : bearing + Math.PI / 2
  sea.setInput(me.id, clamp(angleDiff(desired, ship.heading) * 2, -1, 1), SAIL_FIGHTING)
}

const events: ArenaEvent[] = []
const firstShips = new Set([a.ship!.id, b.ship!.id])
const dt = 1 / 120
let sunkAt = -1
for (let i = 0; i < 120 * 600; i++) {
  pilot(a, b)
  pilot(b, a)
  sea.step(dt)
  events.push(...sea.drainEvents())
  if (sunkAt < 0 && events.some((e) => e.k === 'sunk')) sunkAt = sea.time
  // Long enough after the first sinking to be raised and see it.
  if (sunkAt >= 0 && sea.time > sunkAt + RESPAWN_SECONDS + 1) break
}

const fired = events.filter((e) => e.k === 'fire')
const gone = events.filter((e) => e.k === 'gone')
const sunk = events.filter((e) => e.k === 'sunk')
check(fired.length > 0, `guns fire (${fired.length} balls)`)
check(gone.length > 0 && gone.length <= fired.length, `shot is retired (${gone.length})`)
check(events.some((e) => e.k === 'splash' && e.hit && e.victim > 0), 'hits name the captain struck')
check(sunk.length > 0, `someone sinks (after ${sunkAt.toFixed(1)} s)`)
if (sunk.length > 0) {
  const s = sunk[0] as Extract<ArenaEvent, { k: 'sunk' }>
  const victim = s.captain === 1 ? a : b
  const victor = s.captain === 1 ? b : a
  check(s.by === victor.id, 'the sinking is credited to the captain who fired the ball')
  check(victor.sinkings === 1 && victim.deaths === 1, 'sinkings and deaths are counted')
  check(!!victim.ship && !victim.ship.sunk && !firstShips.has(victim.ship.id), 'the victim is raised in a new hull')
  const gap = victim.ship && victor.ship
    ? Math.hypot(victim.ship.pos.x - victor.ship.pos.x, victim.ship.pos.y - victor.ship.pos.y)
    : 0
  check(gap > 600, `and raised away from her killer (${gap.toFixed(0)} px)`)
  check(sea.plunder.length > 0 || events.some((e) => e.k === 'pickup'), 'the wreck spills plunder')
}

// Leaving takes the hull off the sea.
sea.leave(2)
check(!sea.captains.has(2) && sea.ships.every((s) => sea.captainOf(s)?.id !== 2), 'leaving clears her ship')

if (failures.length) {
  console.log(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nall passed')
