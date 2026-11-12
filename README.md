# Globe Guess

An original browser game. Each round shows a real photo from somewhere on Earth, and you drop a pin where you think it was taken. The closer your guess, the more points you get (up to 5,000 per round).

**Play:** https://siiggyy.github.io/globe-guess/

## Features
- **Solo** or **multiplayer** (up to 8 players) with a 5-letter room code and an invite link
- 3, 5 or 10 rounds, with an optional per-round timer
- Reveal map showing every player's guess, distances and a scoreboard

## How it works
- **Photos:** a random seed point from `locations.js`, then nearby geotagged Wikipedia articles with photos (Wikipedia API, no key needed). The article is revealed after each round.
- **Map:** [Leaflet](https://leafletjs.com) with OpenStreetMap tiles.
- **Multiplayer:** peer-to-peer over WebRTC using [PeerJS](https://peerjs.com) and its free public signaling server. The host's browser runs the game, so no backend is needed and it works on GitHub Pages. Players on very strict networks (some corporate or mobile networks) may not be able to connect without a TURN server.

## Run locally
Any static server works:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
