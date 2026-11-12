# Globe Guess

An original browser game. Each round drops you onto a random street somewhere on Earth. Look around, walk the roads, then pin where you think you are on the map. The closer your guess, the more points you get (up to 5,000 per round).

**Play:** https://siiggyy.github.io/globe-guess/

## Features
- **Solo** or **multiplayer** (up to 8 players) with a 5-letter room code and an invite link
- 1, 3, 5 or 10 rounds, with an optional per-round timer; in multiplayer, the first player to lock in starts a 15-second countdown for everyone else
- Game modes: moving allowed, no moving, or no move/pan/zoom; region filter (world, Europe, Americas, Asia & Middle East, Africa, Oceania); compass on or off
- Final summary with a map of every round and every guess, plus a round-by-round score breakdown
- Modes: **Classic** (points by distance), **Country** (5,000 points for the right country) and **Country streak** (solo: keep going until your first wrong country)
- Country and flag of the answer and every guess on the results, worked out offline from Natural Earth borders
- Animated results: guess lines fly to the answer and points count up
- Rejoin: if a guest reloads or loses connection, they reconnect automatically and keep their score
- Reveal map showing every player's guess, distances and a scoreboard

## How it works
- **Street View:** Google Maps JavaScript API. A random seed point from `locations.js` is jittered and the nearest official panorama is used. The key lives in `config.js`.
- **Guess and results maps:** [Leaflet](https://leafletjs.com) with OpenStreetMap tiles, so they cost nothing.

### Keeping Google Maps free
Each round loads one Street View panorama per player. Google gives a free monthly allowance, and to make sure nothing is ever billed:
1. In Google Cloud Console, open **APIs & Services > Maps JavaScript API > Quotas & System Limits** and set a low per-day limit (e.g. 150).
2. Under **Credentials**, restrict the key to `https://siiggyy.github.io/*` and to the Maps JavaScript API only.
- **Multiplayer:** peer-to-peer over WebRTC using [PeerJS](https://peerjs.com) and its free public signaling server. The host's browser runs the game, so no backend is needed and it works on GitHub Pages. Players on very strict networks (some corporate or mobile networks) may not be able to connect without a TURN server.

## Deployment
`.github/workflows/deploy.yml` publishes the site on every push to `main`. It reads the key from the repository secret `GOOGLE_MAPS_KEY` and writes it into `config.js`, so the key never appears in the repo. Pages must be set to **Settings → Pages → Source: GitHub Actions**.

## Credits
- Country borders: [Natural Earth](https://www.naturalearthdata.com/) via [world-atlas](https://github.com/topojson/world-atlas) (`data/`), read with [d3-geo](https://github.com/d3/d3-geo) and [topojson-client](https://github.com/topojson/topojson-client) (`vendor/`)
- Flags: [flag-icons](https://github.com/lipis/flag-icons) (MIT, `flags/`)

## Run locally
Paste your key into your local copy of `config.js` (don't commit it), then start any static server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Hard spending cap (optional)
`tools/billing-cap/` turns off billing for the Google Cloud project once a small budget (default 1 in your billing currency) is exceeded, so nothing can ever be charged. In [Google Cloud Shell](https://shell.cloud.google.com):

```bash
git clone https://github.com/Siiggyy/globe-guess && bash globe-guess/tools/billing-cap/setup.sh YOUR_PROJECT_ID
```
