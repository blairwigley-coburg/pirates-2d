# The open sea (multiplayer)

Captains sign in with a name and a four-digit PIN, put to sea in a shared world, and fight
each other. There's one chat channel for everyone who is signed in, in port or at sea.

The voyage (the single-player career) is untouched. The open sea is a second mode, reached
from the port's **Open sea** tab.

## Shape

```
Browser ──HTTPS /api/*──▶ Worker (server/worker.ts) ──▶ D1 (accounts, sessions, chat, stats)
   │                            │
   └──── WebSocket /ws ───▶ Durable Object "Sea" (server/sea.ts)
                                 runs ArenaWorld (src/sim/arena.ts) at 120 Hz
```

One Cloudflare Worker serves the built game as static assets, the `/api` routes and the
`/ws` socket, all from one origin.

- **`src/sim/arena.ts`, `ArenaWorld`.** The shared sea: N human ships, every one an enemy of
  every other. It is built from the voyage's own parts:
  - `Ship.step`, `updateGunnery`, `stepProjectiles` and `dropPlunder`/`stepPlunder`;
  - grounding, separation, lee wind and the spawn search, in `src/sim/physics.ts`, which
    `World` uses too.

  So a fight is decided by exactly the physics that decide one in a voyage. It knows nothing of
  the network, and `npm run arena` runs it headless.
- **`server/sea.ts`.** The authoritative server.
  - Browsers send only their helm (−1..1) and sail order. Guns, shot, hits and sinkings
    happen here.
  - It steps the sim in 1/120 s slices and sends a JSON snapshot 20 times a second.
  - The sea runs only while someone is connected, and starts fresh if the object is evicted.
    What lasts lives in D1.
- **`src/net/seaMirror.ts`.** The browser's copy of the sea.
  - Hulls are real `Ship` objects written in from snapshots and played back 100 ms behind,
    interpolated. Every existing view (hulls, wakes, smoke, shot, plunder, sound) draws them
    unchanged.
  - Terrain and wind come from a local `ArenaWorld` built on the server's seed, so they match
    by construction. Only the wind's drift, which depends on its history, is sent.
  - Shot is sent once, as a `fire` event, and flown locally until its `gone` event.
- **`src/net/protocol.ts`.** Every message, typed and shared by both sides.

## Rules of the open sea

- Every hull in the yard is free, as she comes from the yard: no refits, no draft cards. Drafts
  stop time, which a shared sea can't do.
- Sinking a ship puts a bounty plus half her hold in the water. She's raised again 5 s later,
  away from everyone.
- The chart (Windward Cays) has edges, and the sea holds 16 ships.
- Squalls are off: they form around *the* player, which has no meaning here.

## Accounts

- **Names** are 3–16 characters of `[A-Za-z0-9_]`, unique regardless of case.
- **PINs** are four digits, stored as PBKDF2-SHA256 hashes (100k iterations, per-user salt).
- **Lockout:** 10,000 PINs is nothing to a script, so five wrong PINs in a row locks the name
  for 15 minutes.
- **No reset:** a forgotten PIN means a new captain.
- **Sessions** are random 32-byte tokens in D1, kept in `localStorage`.

## Running it locally

```sh
npm install
npm run db:local          # create the local D1 tables (once)
npm run build:sea         # wrangler serves dist/, so build once
npm run sea               # wrangler dev on :8787: the Worker, the Sea and local D1
npm run dev               # vite on :5173, proxying /api and /ws to :8787
```

Open two browser profiles (or one normal window and one private window) at
http://localhost:5173. In each, open the port's **Open sea** tab and make a captain.

## Deploying

The first time, from a terminal where `npx wrangler login` has been run:

```sh
npx wrangler d1 create pirates-2d     # paste the database_id it prints into wrangler.toml
npm run deploy                        # build, apply migrations to the real D1, deploy
```

After that, `.github/workflows/cloudflare.yml` deploys on every push to `main`. It needs two
repository secrets: `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts, D1 and Durable
Objects edit rights) and `CLOUDFLARE_ACCOUNT_ID`.

The GitHub Pages build is unchanged and still single-player only: it has no server, so it
doesn't offer the Open sea tab.
