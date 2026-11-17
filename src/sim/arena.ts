import { Ship, STOCK_MODS, SAIL_FIGHTING, SAIL_STATES } from './ship'
import { PLAYER_CLASSES, SLOOP, type ShipClass } from './shipClasses'
import { dropPlunder, stepPlunder, type Plunder } from './plunder'
import { Terrain } from './terrain'
import { Wind } from './wind'
import { PolarCurve } from './polar'
import { LEVELS, type Level } from './levels'
import { makeRng } from '../core/rng'
import { clamp, type Vec2 } from '../core/math'
import { T } from './tuning'
import {
  updateGunnery, releasePending, stepProjectiles, stepSplashes,
  type Projectile, type PendingShot, type Splash, type CombatEvents,
} from './combat'
import { groundShips, placeClearOfLand, separateShips, windWithLee } from './physics'

/**
 * The open sea: one chart, many captains, nobody else.
 *
 * The voyage's `World` is built around a single player — the director, the
 * weather and the spoils all centre on her — so rather than bend it, the
 * shared sea is its own small world assembled from the same parts. Every
 * hull here is a human's, every captain is everyone else's enemy, and what
 * decides a fight is exactly the hull physics, gunnery and terrain that
 * decide one in a voyage.
 *
 * Like `World`, this knows nothing of rendering or of the network. It is
 * stepped by the server and its events are drained by whoever is sending
 * them on.
 */

/** Seconds a captain waits on the bottom before being raised again. */
export const RESPAWN_SECONDS = 5
/** How long a wreck stays afloat after sinking: the renderer's plunge. */
const WRECK_LINGER = 3.2
/** What every sinking puts in the water before the victim's own hold. */
const BOUNTY = 6
/** The share of her hold a sinking ship spills. */
const SPILL = 0.5
/** A newly raised hull is placed at least this far from anyone afloat, when it can be. */
const SPAWN_CLEARANCE = 1400

export const ARENA_CLASSES: ShipClass[] = PLAYER_CLASSES
const CLASS_BY_ID = new Map(ARENA_CLASSES.map((c) => [c.id, c]))
export const arenaClass = (id: string): ShipClass => CLASS_BY_ID.get(id) ?? SLOOP

/** Something that happened, at a sim time, for the browsers to play back. */
export type ArenaEvent =
  | { k: 'fire'; at: number; id: number; x: number; y: number; vx: number; vy: number; life: number; owner: number }
  | { k: 'gone'; at: number; id: number }
  | { k: 'splash'; at: number; x: number; y: number; hit: boolean; victim: number }
  | { k: 'sunk'; at: number; ship: number; captain: number; by: number }
  | { k: 'pickup'; at: number; captain: number; x: number; y: number; value: number }

export interface Captain {
  readonly id: number
  readonly name: string
  /** The hull she will be raised in next. */
  cls: ShipClass
  /** Afloat, sinking, or null while waiting to be raised. */
  ship: Ship | null
  steer: number
  sail: number
  /** Seconds left on the bottom; counts only while `ship` is null or sunk. */
  respawn: number
  /** Coin aboard right now. Half of it goes over the side when she sinks. */
  plunder: number
  sinkings: number
  deaths: number
}

export class ArenaWorld {
  readonly polar = new PolarCurve()
  readonly wind = new Wind()
  readonly terrain = new Terrain()
  readonly level: Level
  readonly captains = new Map<number, Captain>()
  /** Every hull afloat or still going down, in no particular order. */
  ships: Ship[] = []
  projectiles: Projectile[] = []
  pendingShots: PendingShot[] = []
  splashes: Splash[] = []
  plunder: Plunder[] = []
  /** Sim seconds since the sea opened. */
  time = 0

  private rand: () => number
  private gunRand: () => number
  private events: ArenaEvent[] = []
  /** Shot are plain objects that persist from step to step, so an identity map names them. */
  private shotIds = new Map<Projectile, number>()
  private nextShotId = 1
  private shipCaptain = new Map<number, Captain>()

  constructor(readonly seed: number, level: Level = LEVELS[0]) {
    this.level = level
    this.rand = makeRng(seed)
    this.gunRand = makeRng(seed ^ 0x9e3779b9)
    this.terrain.load(level.map, level.size)
    this.terrain.reseed(seed ^ 0x5eed)
    this.wind.reseed(seed ^ 0x1234567)
    this.wind.reset()
    this.wind.squalls = false
  }

  windAt(p: Vec2) {
    return windWithLee(this.wind, this.terrain, p)
  }

  /** The chart's half-width. A fixed map repeats; the open sea is one copy of it. */
  get bound() { return this.level.size > 0 ? this.level.size / 2 : 5000 }

  captainOf(ship: Ship): Captain | undefined {
    return this.shipCaptain.get(ship.id)
  }

  /** Bring a captain to sea, or change the hull she will next be raised in. */
  join(id: number, name: string, cls: ShipClass) {
    let captain = this.captains.get(id)
    if (!captain) {
      captain = {
        id, name, cls, ship: null, steer: 0, sail: SAIL_FIGHTING,
        respawn: 0, plunder: 0, sinkings: 0, deaths: 0,
      }
      this.captains.set(id, captain)
    }
    const changed = captain.cls !== cls
    captain.cls = cls
    // A hull afloat is swapped at once only if she is unhurt and new to the
    // water: changing ship is not a way out of a losing fight.
    const ship = captain.ship
    if (!ship) { if (captain.respawn <= 0) this.raise(captain) }
    else if (changed && !ship.sunk && ship.hull >= 0.999 && ship.sinceHit > 30) {
      this.removeShip(ship)
      this.raise(captain)
    }
  }

  /** Back to port: her ship leaves the sea, and with her whatever she had aboard. */
  leave(id: number) {
    const captain = this.captains.get(id)
    if (!captain) return
    if (captain.ship) this.removeShip(captain.ship)
    this.captains.delete(id)
  }

  setInput(id: number, steer: number, sail: number) {
    const captain = this.captains.get(id)
    if (!captain) return
    captain.steer = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0
    captain.sail = Number.isFinite(sail) ? clamp(Math.round(sail), 0, SAIL_STATES.length - 1) : captain.sail
  }

  /** Everything that has happened since the last call. */
  drainEvents(): ArenaEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  private removeShip(ship: Ship) {
    const i = this.ships.indexOf(ship)
    if (i >= 0) this.ships.splice(i, 1)
    const captain = this.shipCaptain.get(ship.id)
    if (captain && captain.ship === ship) captain.ship = null
    this.shipCaptain.delete(ship.id)
  }

  /**
   * A fresh hull for this captain, somewhere quiet. Several places are tried
   * and the one furthest from anyone already afloat is taken, so a captain is
   * never raised under someone else's guns.
   */
  private raise(captain: Captain) {
    const ship = new Ship(this.polar)
    ship.faction = `p${captain.id}`
    ship.cls = captain.cls
    const mods = { ...STOCK_MODS }
    mods.hullRepair = T.playerHullRepair
    mods.sailRepair = T.playerSailRepair
    mods.crewRepair = T.playerCrewRepair
    if (captain.cls.playerMods) Object.assign(mods, captain.cls.playerMods)
    ship.mods = mods
    ship.sailOrder = SAIL_FIGHTING
    captain.sail = SAIL_FIGHTING
    captain.steer = 0

    const span = this.bound * 1.6
    let best: Vec2 = { x: 0, y: 0 }
    let bestGap = -1
    for (let i = 0; i < 8; i++) {
      const at = { x: (this.rand() - 0.5) * span, y: (this.rand() - 0.5) * span }
      let gap = Infinity
      for (const other of this.ships) {
        if (other.sunk) continue
        gap = Math.min(gap, Math.hypot(other.pos.x - at.x, other.pos.y - at.y))
      }
      if (gap > bestGap) { best = at; bestGap = gap }
      if (gap >= SPAWN_CLEARANCE) break
    }
    placeClearOfLand(ship, best, this.terrain, (p) => this.windAt(p))

    captain.ship = ship
    captain.respawn = 0
    this.ships.push(ship)
    this.shipCaptain.set(ship.id, captain)
  }

  step(dt: number) {
    this.time += dt
    this.wind.step(dt)

    // --- Captains waiting on the bottom ---------------------------------------
    for (const captain of this.captains.values()) {
      if (captain.ship && !captain.ship.sunk) continue
      captain.respawn = Math.max(0, captain.respawn - dt)
      if (captain.respawn <= 0 && !captain.ship) this.raise(captain)
    }

    // --- Sailing ----------------------------------------------------------------
    for (const ship of this.ships) {
      if (ship.sunk) continue
      const captain = this.shipCaptain.get(ship.id)
      ship.sailOrder = captain?.sail ?? ship.sailOrder
      ship.step(dt, this.windAt(ship.pos), captain?.steer ?? 0)
    }

    // --- Gunnery: every hull is every other hull's enemy -------------------------
    const afloat = this.ships.filter((s) => !s.sunk)
    const gunRand = () => this.gunRand()
    for (const ship of afloat) {
      updateGunnery(ship, afloat.filter((s) => s !== ship), this.terrain, this.pendingShots, gunRand)
    }
    const before = this.projectiles.length
    this.pendingShots = releasePending(this.pendingShots, this.projectiles, dt)
    for (let i = before; i < this.projectiles.length; i++) {
      const p = this.projectiles[i]
      const id = this.nextShotId++
      this.shotIds.set(p, id)
      const owner = this.shipCaptain.get(p.ownerId)?.id ?? 0
      this.events.push({
        k: 'fire', at: this.time, id, x: p.pos.x, y: p.pos.y, vx: p.vel.x, vy: p.vel.y, life: p.life, owner,
      })
    }

    separateShips(this.ships)
    const sunkThisStep: Ship[] = []
    groundShips(this.ships, this.terrain, dt, (ship) => sunkThisStep.push(ship))
    this.keepOnChart()

    // --- Shot -------------------------------------------------------------------
    const kills: { victim: Ship; by: number }[] = []
    const splashesBefore = this.splashes.length
    const events: CombatEvents = { splashes: this.splashes, sunk: sunkThisStep, kills }
    const flying = this.projectiles
    this.projectiles = stepProjectiles(flying, this.ships, this.terrain, dt, events)
    if (this.projectiles.length !== flying.length) {
      const alive = new Set(this.projectiles)
      for (const p of flying) {
        if (alive.has(p)) continue
        const id = this.shotIds.get(p)
        this.shotIds.delete(p)
        if (id !== undefined) this.events.push({ k: 'gone', at: this.time, id })
      }
    }
    for (let i = splashesBefore; i < this.splashes.length; i++) {
      const s = this.splashes[i]
      const victim = s.victimFaction?.startsWith('p') ? Number(s.victimFaction.slice(1)) : 0
      this.events.push({ k: 'splash', at: this.time, x: s.pos.x, y: s.pos.y, hit: s.hit, victim })
    }
    this.splashes = stepSplashes(this.splashes, dt)

    // --- Sinkings -----------------------------------------------------------------
    const killer = new Map(kills.map((k) => [k.victim, k.by]))
    for (const ship of new Set(sunkThisStep)) {
      const captain = this.shipCaptain.get(ship.id)
      const byShip = killer.get(ship)
      const by = byShip !== undefined ? this.shipCaptain.get(byShip) : undefined
      if (by && by !== captain) by.sinkings++
      if (captain) {
        captain.deaths++
        captain.respawn = RESPAWN_SECONDS
      }
      const hold = captain ? captain.plunder * SPILL : 0
      if (captain) captain.plunder -= hold
      dropPlunder(this.plunder, ship.pos, BOUNTY + hold, () => this.rand())
      this.events.push({
        k: 'sunk', at: this.time, ship: ship.id, captain: captain?.id ?? 0, by: by?.id ?? 0,
      })
    }

    this.stepSpoils(dt)

    // --- Wrecks go under, and their captains wait to be raised ----------------------
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const ship = this.ships[i]
      if (!ship.sunk) continue
      ship.sinceSunk += dt
      if (ship.sinceSunk >= WRECK_LINGER) this.removeShip(ship)
    }
  }

  /**
   * Plunder goes to whoever is nearest. Each piece is handed to its nearest
   * hull's ordinary sweep, so magnets, pick-up radii and drift are exactly a
   * voyage's — and a piece nobody is near simply drifts, as it does there.
   */
  private stepSpoils(dt: number) {
    if (this.plunder.length === 0) return
    const afloat = this.ships.filter((s) => !s.sunk)
    const groups = new Map<Ship | null, Plunder[]>()
    for (const piece of this.plunder) {
      let nearest: Ship | null = null
      let best = Infinity
      for (const ship of afloat) {
        const d = Math.hypot(ship.pos.x - piece.pos.x, ship.pos.y - piece.pos.y)
        if (d < best) { best = d; nearest = ship }
      }
      // Beyond any magnet, nobody's: it drifts on its own.
      if (best > T.plunderMagnetRadius * 3) nearest = null
      const group = groups.get(nearest)
      if (group) group.push(piece)
      else groups.set(nearest, [piece])
    }

    const remaining: Plunder[] = []
    const windAt = (p: Vec2) => this.windAt(p)
    for (const [ship, pieces] of groups) {
      // A drifting piece still needs a hull to measure from; a sunk dummy
      // collects nothing and leaves it to the wind.
      const sweeper = ship ?? DRIFT
      const swept = stepPlunder(pieces, sweeper, windAt, dt)
      remaining.push(...swept.remaining)
      if (!ship || swept.collected <= 0) continue
      const captain = this.shipCaptain.get(ship.id)
      if (!captain) continue
      captain.plunder += swept.collected
      for (const piece of swept.taken) {
        this.events.push({
          k: 'pickup', at: this.time, captain: captain.id, x: piece.pos.x, y: piece.pos.y, value: piece.value,
        })
      }
    }
    this.plunder = remaining
  }

  /**
   * The chart has edges. A fixed map repeats forever, and captains who sailed
   * off it in opposite directions would never meet again, so the open sea is
   * one copy of it and the edge holds a hull like a lee shore.
   */
  private keepOnChart() {
    const b = this.bound
    for (const ship of this.ships) {
      if (ship.sunk) continue
      if (ship.pos.x > b) { ship.pos.x = b; ship.vel.x = Math.min(0, ship.vel.x) }
      if (ship.pos.x < -b) { ship.pos.x = -b; ship.vel.x = Math.max(0, ship.vel.x) }
      if (ship.pos.y > b) { ship.pos.y = b; ship.vel.y = Math.min(0, ship.vel.y) }
      if (ship.pos.y < -b) { ship.pos.y = -b; ship.vel.y = Math.max(0, ship.vel.y) }
    }
  }
}

/** A hull that is never afloat, for plunder no captain is near. */
const DRIFT = (() => {
  const ship = new Ship(new PolarCurve())
  ship.sunk = true
  return ship
})()
