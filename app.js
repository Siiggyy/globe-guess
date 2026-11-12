'use strict';

/* Globe Guess: one person "hosts" the game (solo play is just a host with no guests).
 * The host runs all game logic and talks to guests peer-to-peer over WebRTC (PeerJS),
 * so the whole thing runs on static hosting like GitHub Pages with no backend. */

const PEER_PREFIX = 'globeguess-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const COLORS = ['#e4572e', '#2e86ab', '#f3a712', '#8ac926', '#a846a0', '#00a5cf', '#ff6f91', '#6c757d'];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const me = { id: 'host', name: '', isHost: false, solo: false };
let peer = null;
let hostConn = null;
const conns = new Map();     // host only: player id -> DataConnection
const peerToId = new Map();  // host only: PeerJS peer id -> player id (players keep their id across reconnects)

/* ---------------- storage (optional) ---------------- */
function loadName() { try { return localStorage.getItem('gg-name') || ''; } catch { return ''; } }
function saveName(n) { try { localStorage.setItem('gg-name', n); } catch { /* ignore */ } }
// Per-tab player id for a room, kept across reloads so a player can rejoin with their score.
function playerToken(code, create) {
  const key = 'gg-token-' + code;
  try {
    let t = sessionStorage.getItem(key);
    if (!t && create) { t = 'p' + Math.random().toString(36).slice(2, 12); sessionStorage.setItem(key, t); }
    return t || null;
  } catch { return create ? 'p' + Math.random().toString(36).slice(2, 12) : null; }
}
function forgetToken(code) { try { sessionStorage.removeItem('gg-token-' + code); } catch { /* ignore */ } }

/* ---------------- personal records (this browser only) ---------------- */
function loadRecords() {
  try { return JSON.parse(localStorage.getItem('gg-records') || '{}') || {}; } catch { return {}; }
}
function saveRecords(r) { try { localStorage.setItem('gg-records', JSON.stringify(r)); } catch { /* ignore */ } }
const MOVE_LABEL = { move: '', nomove: ' · no moving', nmpz: ' · no move/pan/zoom' };
function recordKey(mode, rounds, move) {
  return mode === 'streak' ? `streak|${move}` : `${mode}|${rounds}|${move}`;
}
function recordLabel(key) {
  const [mode, a, b] = key.split('|');
  if (mode === 'streak') return 'Country streak' + (MOVE_LABEL[a] || '');
  return `${mode === 'country' ? 'Country' : 'Classic'} · ${a} round${a === '1' ? '' : 's'}` + (MOVE_LABEL[b] || '');
}
// Each check runs once per round/game (rejoining replays messages), and celebrates only
// when an existing record is beaten, not the very first result.
function recordRound(msg) {
  const mine = msg.results.find((r) => r.id === me.id);
  if (!mine || !mine.guess || mine.dist == null || !msg.gameId) return false;
  const r = loadRecords();
  const tag = msg.gameId + ':' + msg.n;
  if (r.lastRound === tag) return r.closestNew === tag;
  r.lastRound = tag;
  const prev = r.closest;
  if (prev == null || mine.dist < prev) {
    r.closest = mine.dist;
    if (prev != null) r.closestNew = tag;
  }
  saveRecords(r);
  return r.closestNew === tag;
}
function recordGame(msg) {
  const mine = msg.standings.find((s) => s.id === me.id);
  if (!mine || !msg.gameId) return false;
  const r = loadRecords();
  if (r.lastGame === msg.gameId) return r.bestNew === msg.gameId;
  r.lastGame = msg.gameId;
  r.games = (r.games || 0) + 1;
  r.best = r.best || {};
  const key = recordKey(msg.mode, msg.settings ? msg.settings.rounds : 0, msg.settings ? msg.settings.move : 'move');
  const prev = r.best[key];
  if (prev == null || mine.total > prev) {
    r.best[key] = mine.total;
    if (prev != null) r.bestNew = msg.gameId;
  }
  saveRecords(r);
  return r.bestNew === msg.gameId;
}
function renderRecords() {
  const r = loadRecords();
  const best = Object.entries(r.best || {}).sort(([a], [b]) => a.localeCompare(b));
  const box = $('#records');
  if (!r.games && r.closest == null) { box.hidden = true; return; }
  box.hidden = false;
  const rows = best.map(([k, v]) => `<li><span>${esc(recordLabel(k))}</span><strong>${k.startsWith('streak') ? '🔥 ' + v : v.toLocaleString() + ' pts'}</strong></li>`);
  if (r.closest != null) rows.push(`<li><span>Closest guess ever</span><strong>${fmtDist(r.closest)}</strong></li>`);
  rows.push(`<li><span>Games played</span><strong>${r.games || 0}</strong></li>`);
  $('#records-list').innerHTML = rows.join('');
}

/* ---------------- UI helpers ---------------- */
const SCREENS = ['home', 'lobby', 'game', 'reveal', 'final'];
function show(name) {
  for (const s of SCREENS) $('#screen-' + s).hidden = s !== name;
  const inGame = name === 'game' || name === 'reveal';
  $('#hud-round').hidden = !inGame;
  $('#hud-score').hidden = !inGame;
  if (!inGame) $('#hud-timer').hidden = true;
  if (name === 'game') setTimeout(() => guessMap.invalidateSize(), 0);
  if (name === 'reveal') setTimeout(() => revealMap.invalidateSize(), 0);
  if (name === 'final') setTimeout(() => finalMap.invalidateSize(), 0);
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
const pinIcon = (color, goal) => L.divIcon({
  className: '', html: `<span class="pin${goal ? ' pin-goal' : ''}" style="--c:${color}"></span>`,
  iconSize: [22, 22], iconAnchor: [11, 26]
});
const isCountryMode = (mode) => mode === 'country' || mode === 'streak';
const roundLabel = (n, total) => (total ? `Round ${n} / ${total}` : `Round ${n}`);
function scoreLabel(total, mode) {
  return mode === 'streak' ? `🔥 ${total} in a row` : `${total.toLocaleString()} pts`;
}
function countryHtml(c) {
  return c ? `${Countries.flag(c.code)} ${esc(c.name)}` : '🌊 Open sea';
}
// counts a number up inside an element
function countUp(el, from, to, ms, fmt) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function fmtDist(km) {
  if (km == null) return '-';
  if (km < 1) return Math.round(km * 1000) + ' m';
  return Math.round(km).toLocaleString() + ' km';
}

/* ---------------- maps ---------------- */
let guessOutline = null;
function outlineLayer(c, color, fill) {
  const f = Countries.shape(c);
  return f ? L.geoJSON(f, { interactive: false, style: { color, weight: 2, fillColor: color, fillOpacity: fill } }) : null;
}
function setGuessOutline(c) {
  if (guessOutline) { guessOutline.remove(); guessOutline = null; }
  if (c) { guessOutline = outlineLayer(c, myColor(), 0.25); if (guessOutline) guessOutline.addTo(guessMap); }
}
let guessMap, guessMarker = null, revealMap, revealLayer, finalMap, finalLayer, finalBounds = [], finalAllBounds = null;
function tiles() {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
}
function initMaps() {
  guessMap = L.map('guess-map', { worldCopyJump: true, minZoom: 1 }).setView([20, 0], 1);
  tiles().addTo(guessMap);
  guessMap.on('click', (e) => {
    if (view.guessed || !view.round) return;
    view.myGuess = e.latlng.wrap();
    if (!guessMarker) guessMarker = L.marker(e.latlng, { icon: pinIcon(myColor()) }).addTo(guessMap);
    else guessMarker.setLatLng(e.latlng);
    $('#btn-guess').disabled = false;
    $('#btn-guess').textContent = 'Guess';
    if (isCountryMode(view.round.mode) && Countries.ready()) {
      const c = Countries.countryAt(view.myGuess.lat, view.myGuess.lng, true);
      $('#btn-guess').innerHTML = 'Guess: ' + countryHtml(c);
      setGuessOutline(c);
    }
  });
  revealMap = L.map('reveal-map', { worldCopyJump: true, minZoom: 1 }).setView([20, 0], 1);
  tiles().addTo(revealMap);
  revealLayer = L.layerGroup().addTo(revealMap);
  finalMap = L.map('final-map', { worldCopyJump: true, minZoom: 1 }).setView([20, 0], 1);
  tiles().addTo(finalMap);
  finalLayer = L.layerGroup().addTo(finalMap);
}

/* ---------------- geo + scoring ---------------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function scoreFor(km) {
  if (km < 0.15) return 5000;
  return Math.round(5000 * Math.exp(-km / 2000));
}

/* ---------------- Google Street View ---------------- */
let googleReady = null;
function loadGoogle() {
  if (googleReady) return googleReady;
  googleReady = new Promise((resolve, reject) => {
    const key = (window.GG_CONFIG && window.GG_CONFIG.googleMapsKey) || '';
    if (!key) { reject(new Error('No Google Maps key in config.js')); return; }
    window.__ggGoogleInit = resolve;
    window.gm_authFailure = () => toast('Google Maps rejected the API key (check key restrictions or the daily quota).');
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&v=weekly&loading=async&callback=__ggGoogleInit';
    s.async = true;
    s.onerror = () => { googleReady = null; reject(new Error('Could not load Google Maps')); };
    document.head.appendChild(s);
  });
  return googleReady;
}
let svLib = null, svService = null, svPano = null;
async function getStreetView() {
  if (svLib) return svLib;
  await loadGoogle();
  svLib = await google.maps.importLibrary('streetView');
  svService = new svLib.StreetViewService();
  return svLib;
}
// One panorama object for the whole session; each round just switches its pano id.
async function getPano() {
  const lib = await getStreetView();
  if (!svPano) {
    const { ControlPosition } = await google.maps.importLibrary('core');
    svPano = new lib.StreetViewPanorama($('#pano'), {
      // keep compass and zoom at the top right, clear of the guess map in the bottom right
      panControlOptions: { position: ControlPosition.RIGHT_TOP },
      zoomControlOptions: { position: ControlPosition.RIGHT_TOP },
      addressControl: false, showRoadLabels: false, fullscreenControl: false,
      motionTracking: false, motionTrackingControl: false, enableCloseButton: false,
      linksControl: true, panControl: true, zoomControl: true, clickToGo: true, scrollwheel: true
    });
    svPano.addListener('pano_changed', () => {
      if (view.round && view.round.move && view.round.move !== 'move' && startPano && svPano.getPano() !== startPano.pano) {
        svPano.setPano(startPano.pano);
      }
    });
    svPano.addListener('status_changed', () => {
      if (svPano.getStatus() === 'OK') $('#pano-loading').hidden = true;
    });
  }
  return svPano;
}
async function fetchLocation() {
  const lib = await getStreetView();
  for (let attempt = 0; attempt < 15; attempt++) {
    const pool = window.LOCATION_REGIONS[game.settings.region] || window.LOCATION_REGIONS.world;
    const seed = pool[Math.floor(Math.random() * pool.length)];
    const rural = seed[2] === 1; // countryside seeds are spread over a wider area
    const spread = rural ? 1.8 : 0.6;
    const lat = Math.max(-85, Math.min(85, seed[0] + (Math.random() - 0.5) * spread));
    const lng = seed[1] + (Math.random() - 0.5) * spread / Math.max(0.3, Math.cos(seed[0] * Math.PI / 180));
    const req = { location: { lat, lng }, radius: rural ? 30000 : 15000, preference: lib.StreetViewPreference.NEAREST };
    if (lib.StreetViewSource && lib.StreetViewSource.GOOGLE) req.sources = [lib.StreetViewSource.GOOGLE];
    else req.source = lib.StreetViewSource.OUTDOOR;
    try {
      const { data } = await svService.getPanorama(req);
      const loc = data && data.location;
      if (!loc || !loc.pano || game.used.has(loc.pano)) continue;
      if (!data.links || data.links.length === 0) continue; // skip dead-end single photos
      const plat = loc.latLng.lat(), plng = loc.latLng.lng();
      const country = Countries.ready() ? Countries.countryAt(plat, plng, true) : null;
      if (isCountryMode(game.settings.mode) && !country) continue;
      return {
        pageid: loc.pano, pano: loc.pano, country,
        lat: plat, lng: plng,
        title: loc.description || 'Mystery location',
        heading: Math.floor(Math.random() * 360),
        url: 'https://www.google.com/maps/@?api=1&map_action=pano&pano=' + encodeURIComponent(loc.pano)
      };
    } catch (e) {
      const code = (e && (e.code || e.message)) || '';
      if (/OVER_QUERY_LIMIT|REQUEST_DENIED/.test(code)) throw e; // quota hit or key refused: stop
      /* ZERO_RESULTS: try another spot */
    }
  }
  throw new Error('no location found');
}

/* =================================================================
 * HOST SIDE: authoritative game state
 * ================================================================= */
const game = {
  players: new Map(), // id -> {name, total, color}
  settings: { mode: 'classic', rounds: 5, time: 90, move: 'move', region: 'world', compass: 'on' },
  phase: 'lobby',     // lobby | loading | round | reveal | final
  roundNo: 0, current: null, roundStart: 0,
  guesses: new Map(), used: new Set(), timer: null, deadline: 0, next: null, lastReveal: null, lastFinal: null, history: [], code: null
};

function broadcast(msg) {
  for (const c of conns.values()) if (c.open) c.send(msg);
  onMessage(msg); // host's own view
}
function sendTo(id, msg) {
  if (typeof msg === 'function') msg = msg(id);
  if (id === 'host') return onMessage(msg);
  const c = conns.get(id);
  if (c && c.open) c.send(msg);
}
function toHost(msg) {
  if (me.isHost) hostOnMessage('host', msg);
  else if (hostConn && hostConn.open) hostConn.send(msg);
}
function playersPayload() {
  return [...game.players.entries()].map(([id, p]) => ({
    id, name: p.name, total: p.total, color: p.color, guessed: game.guesses.has(id), online: p.online !== false
  }));
}
function broadcastPlayers() {
  broadcast({ t: 'players', players: playersPayload(), settings: game.settings, phase: game.phase });
}
function addPlayer(id, name) {
  const used = new Set([...game.players.values()].map((p) => p.color));
  let color = 0;
  while (used.has(color) && color < COLORS.length - 1) color++;
  const clean = String(name || '').trim().slice(0, 20) || 'Player ' + (game.players.size + 1);
  game.players.set(id, { name: clean, total: 0, color, online: true });
}
// A guest's connection dropped. In the lobby they simply leave; during a game they stay
// in the standings as "offline" with their score, so they can rejoin.
function playerOffline(id) {
  const p = game.players.get(id);
  if (!p) return;
  if (game.phase === 'lobby') { game.players.delete(id); game.guesses.delete(id); }
  else p.online = false;
  broadcastPlayers();
  if (game.phase === 'round' && allGuessed()) hostReveal();
}
const onlineIds = () => [...game.players.entries()].filter(([, p]) => p.online !== false).map(([id]) => id);
const allGuessed = () => onlineIds().length > 0 && onlineIds().every((id) => game.guesses.has(id));

function hostOnMessage(from, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') {
    const existing = game.players.get(from);
    if (existing) {
      existing.online = true; // rejoin: same id, score kept
    } else {
      if (game.players.size >= MAX_PLAYERS) { sendTo(from, { t: 'error', msg: 'That room is full.', fatal: true }); return; }
      addPlayer(from, msg.name);
    }
    sendTo(from, { t: 'welcome', code: game.code, rejoined: !!existing });
    broadcastPlayers();
    if (game.phase === 'round') sendTo(from, roundMsg);
    else if (game.phase === 'reveal' && game.lastReveal) sendTo(from, game.lastReveal);
    else if (game.phase === 'final' && game.lastFinal) sendTo(from, game.lastFinal);
    else if (game.phase === 'loading') sendTo(from, { t: 'loading', n: game.roundNo + 1, total: totalRounds() });
  } else if (msg.t === 'guess') {
    if (game.phase !== 'round' || game.guesses.has(from) || !game.players.has(from)) return;
    const lat = Number(msg.lat), lng = Number(msg.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90) return;
    game.guesses.set(from, { lat, lng: ((lng + 540) % 360) - 180 });
    broadcastPlayers();
    if (allGuessed()) { hostReveal(); return; }
    // multiplayer: the first lock-in starts a short countdown for everyone else
    const left = game.deadline ? (game.deadline - Date.now()) / 1000 : Infinity;
    if (onlineIds().length > 1 && game.guesses.size === 1 && left > LOCK_IN_SECONDS) {
      setRoundDeadline(LOCK_IN_SECONDS);
      broadcast({ t: 'timer', remaining: LOCK_IN_SECONDS, by: game.players.get(from).name });
    }
  }
}

const SETTING_IDS = ['mode', 'rounds', 'time', 'move', 'region', 'compass'];
function readSettings() {
  const v = (id) => $('#set-' + id).value;
  let mode = ['classic', 'country', 'streak'].includes(v('mode')) ? v('mode') : 'classic';
  if (mode === 'streak' && !me.solo) mode = 'classic'; // streak is a solo mode
  game.settings = {
    mode,
    rounds: Number(v('rounds')) || 5,
    time: Number(v('time')) || 0,
    move: ['move', 'nomove', 'nmpz'].includes(v('move')) ? v('move') : 'move',
    region: window.LOCATION_REGIONS[v('region')] ? v('region') : 'world',
    compass: v('compass') === 'off' ? 'off' : 'on'
  };
}
async function hostStart() {
  readSettings();
  if (isCountryMode(game.settings.mode) || !Countries.ready()) {
    try { await Countries.load(); }
    catch {
      if (isCountryMode(game.settings.mode)) { toast('Could not load country borders. Check your connection and try again.'); return; }
    }
  }
  game.roundNo = 0;
  game.lastReveal = null;
  game.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  game.used.clear();
  game.history = [];
  game.lastFinal = null;
  for (const p of game.players.values()) p.total = 0;
  hostNextRound();
}
async function hostNextRound() {
  if (game.phase === 'loading') return;
  if (game.phase === 'reveal' && game.lastReveal && game.lastReveal.last) return hostFinal();
  game.phase = 'loading';
  broadcast({ t: 'loading', n: game.roundNo + 1, total: totalRounds() });
  let loc = null;
  try { loc = await (game.next || fetchLocation()); } catch { loc = null; }
  game.next = null;
  if (!loc || game.used.has(loc.pageid)) { try { loc = await fetchLocation(); } catch { loc = null; } }
  if (!loc) {
    game.phase = 'lobby';
    broadcast({ t: 'error', msg: 'Could not load a Street View location. The daily Google Maps limit may be reached, or check your connection.' });
    broadcastPlayers();
    return;
  }
  game.used.add(loc.pageid);
  game.roundNo++;
  game.current = loc;
  game.guesses.clear();
  game.phase = 'round';
  game.roundStart = Date.now();
  clearTimeout(game.timer);
  setRoundDeadline(game.settings.time > 0 ? game.settings.time : 0);
  for (const id of game.players.keys()) sendTo(id, roundMsg);
  broadcastPlayers();
  game.next = fetchLocation().catch(() => null); // prefetch the next round
}
const totalRounds = () => (game.settings.mode === 'streak' ? null : game.settings.rounds);
const LOCK_IN_SECONDS = 15;
// seconds = 0 means no time limit
function setRoundDeadline(seconds) {
  clearTimeout(game.timer);
  game.deadline = seconds > 0 ? Date.now() + seconds * 1000 : 0;
  if (seconds > 0) game.timer = setTimeout(hostReveal, seconds * 1000 + 1500); // grace for latency
}
// per player, so someone who rejoins mid-round gets their locked-in guess back
function roundMsg(forId) {
  const timed = game.deadline > 0;
  const remaining = timed ? Math.max(0, (game.deadline - Date.now()) / 1000) : 0;
  return { t: 'round', n: game.roundNo, total: totalRounds(), pano: game.current.pano, heading: game.current.heading, timed, remaining,
    move: game.settings.move, compass: game.settings.compass, mode: game.settings.mode, myGuess: game.guesses.get(forId) || null };
}
function hostReveal() {
  if (game.phase !== 'round') return;
  clearTimeout(game.timer);
  game.phase = 'reveal';
  const a = game.current;
  const mode = game.settings.mode;
  const results = [...game.players.entries()].map(([id, p]) => {
    const g = game.guesses.get(id) || null;
    let dist = null, score = 0, country = null, correct = false;
    if (g) {
      dist = haversine(a.lat, a.lng, g.lat, g.lng);
      country = Countries.ready() ? Countries.countryAt(g.lat, g.lng, true) : null;
      correct = !!(country && a.country && country.code === a.country.code && country.name === a.country.name);
      score = mode === 'classic' ? scoreFor(dist) : mode === 'country' ? (correct ? 5000 : 0) : (correct ? 1 : 0);
    }
    const before = p.total;
    p.total += score;
    return { id, name: p.name, color: p.color, guess: g, dist, score, before, total: p.total, country, correct };
  }).sort((x, y) => y.score - x.score || (x.dist ?? 1e9) - (y.dist ?? 1e9));
  const last = mode === 'streak' ? !results.some((r) => r.correct) : game.roundNo >= game.settings.rounds;
  game.lastReveal = {
    t: 'reveal', n: game.roundNo, total: totalRounds(), mode, gameId: game.id,
    answer: { lat: a.lat, lng: a.lng, title: a.title, url: a.url, country: a.country || null },
    results, last
  };
  game.history.push(game.lastReveal);
  broadcast(game.lastReveal);
  broadcastPlayers();
}
function hostFinal() {
  game.phase = 'final';
  const standings = [...game.players.entries()]
    .map(([id, p]) => ({ id, name: p.name, color: p.color, total: p.total }))
    .sort((a, b) => b.total - a.total);
  const rounds = game.history.map((r) => ({ n: r.n, answer: r.answer, results: r.results }));
  game.lastFinal = { t: 'final', standings, rounds, mode: game.settings.mode, gameId: game.id,
    settings: { rounds: game.settings.rounds, move: game.settings.move } };
  broadcast(game.lastFinal);
}
function hostBackToLobby() {
  game.phase = 'lobby';
  broadcast({ t: 'lobby' });
  broadcastPlayers();
}

/* =================================================================
 * CLIENT SIDE: what every player (including the host) sees
 * ================================================================= */
const view = { players: [], settings: null, round: null, guessed: false, myGuess: null, deadline: 0, timerTotal: 0, timerInt: null, code: null };

function myColor() {
  const p = view.players.find((x) => x.id === me.id);
  return COLORS[p ? p.color : 0];
}
function myTotal() {
  const p = view.players.find((x) => x.id === me.id);
  return p ? p.total : 0;
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      view.code = msg.code;
      reconnect.tries = 0;
      if (msg.rejoined) toast('Welcome back! You rejoined the game.');
      renderLobby();
      show('lobby'); // the current game state follows right after, if a game is running
      break;
    case 'players':
      view.players = msg.players;
      view.settings = msg.settings;
      renderPlayers();
      break;
    case 'lobby':
      renderLobby();
      show('lobby');
      break;
    case 'loading':
      startRoundView(null, msg);
      break;
    case 'round':
      startRoundView(msg.pano, msg);
      break;
    case 'timer':
      if (!view.round) break;
      view.round.timed = true;
      view.deadline = Date.now() + msg.remaining * 1000;
      view.timerTotal = msg.remaining * 1000;
      flashTimer();
      clearInterval(view.timerInt);
      $('#hud-timer').hidden = false;
      tickTimer();
      view.timerInt = setInterval(tickTimer, 250);
      if (!view.guessed) toast(`${msg.by} locked in. ${msg.remaining} seconds left!`);
      break;
    case 'reveal':
      renderReveal(msg);
      break;
    case 'final':
      renderFinal(msg);
      break;
    case 'error':
      toast(msg.msg);
      if (msg.fatal) goHome();
      else if (me.isHost) { renderLobby(); show('lobby'); }
      break;
  }
}

function renderPlayers() {
  const items = view.players.map((p) =>
    `<li class="${p.guessed ? 'done' : ''}${p.online ? '' : ' offline'}"><span class="dot" style="--c:${COLORS[p.color]}"></span>${esc(p.name)}${p.id === me.id ? ' (you)' : ''}${p.online ? '' : ' (offline)'}${p.guessed ? ' ✓' : ''}</li>`).join('');
  $('#lobby-players').innerHTML = items;
  $('#game-players').innerHTML = view.players.length > 1 ? items : '';
  $('#hud-score').textContent = scoreLabel(myTotal(), view.settings && view.settings.mode);
  if (!me.isHost && view.settings) {
    for (const id of SETTING_IDS) if (view.settings[id] != null) $('#set-' + id).value = String(view.settings[id]);
  }
}
function updateModeFields() {
  const streak = $('#set-mode').value === 'streak';
  $('#set-rounds').disabled = !me.isHost || streak;
  $('#mode-help').textContent = {
    classic: 'Score up to 5,000 points per round. The closer, the better.',
    country: 'Only the country counts: 5,000 points if your pin is in the right country, 0 if not.',
    streak: 'Keep naming the right country. The game ends at your first wrong guess.'
  }[$('#set-mode').value] || '';
}
function renderLobby() {
  $('#lobby-title').textContent = me.solo ? 'Solo game' : me.isHost ? 'Your room' : 'Joined room';
  $('#lobby-share').hidden = me.solo;
  $('#lobby-code').textContent = view.code || '';
  $('#btn-start').hidden = !me.isHost;
  $('#lobby-wait').hidden = me.isHost;
  for (const id of SETTING_IDS) $('#set-' + id).disabled = !me.isHost;
  // streak is solo-only
  const streakOpt = $('#set-mode option[value="streak"]');
  streakOpt.disabled = !me.solo;
  streakOpt.textContent = me.solo ? 'Country streak' : 'Country streak (solo only)';
  if (!me.solo && $('#set-mode').value === 'streak') $('#set-mode').value = 'classic';
  updateModeFields();
  renderPlayers();
}

let startPano = null;
function startRoundView(pano, msg) {
  show('game');
  $('#hud-round').textContent = roundLabel(msg.n, msg.total);
  clearInterval(view.timerInt);
  $('#hud-timer').hidden = true;
  setMinimap(false);
  $('#minimap').classList.remove('open');
  $('#btn-map-toggle').textContent = 'Open map';
  if (!pano) {
    view.round = null;
    $('#pano-loading').hidden = false;
    return;
  }
  view.round = msg;
  view.guessed = false;
  view.myGuess = null;
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  setGuessOutline(null);
  guessMap.setView([20, 0], 1);
  $('#btn-guess').disabled = true;
  $('#btn-guess').textContent = isCountryMode(msg.mode) ? 'Pin the country on the map' : 'Place a pin on the map';
  if (msg.myGuess) { // rejoined after already locking in
    view.guessed = true;
    view.myGuess = L.latLng(msg.myGuess.lat, msg.myGuess.lng);
    guessMarker = L.marker(view.myGuess, { icon: pinIcon(myColor()) }).addTo(guessMap);
    $('#btn-guess').textContent = 'Waiting for other players…';
    if (isCountryMode(msg.mode)) Countries.load().then(() => setGuessOutline(Countries.countryAt(msg.myGuess.lat, msg.myGuess.lng, true))).catch(() => {});
  }
  $('#pano-loading').hidden = false;
  if (isCountryMode(msg.mode)) Countries.load().catch(() => {});
  startPano = { pano, heading: msg.heading || 0 };
  getPano().then((p) => {
    applyRestrictions(p, msg);
    p.setPano(pano);
    p.setPov({ heading: startPano.heading, pitch: 0 });
    p.setZoom(0);
    p.setVisible(true);
    setTimeout(() => { $('#pano-loading').hidden = true; }, 4000); // never block forever
  }).catch(() => {
    $('#pano-loading').hidden = true;
    toast('Street View failed to load. Take your best guess!');
  });
  if (msg.timed) {
    view.deadline = Date.now() + msg.remaining * 1000;
    view.timerTotal = Math.max(msg.remaining, (view.settings && view.settings.time) || 0) * 1000;
    $('#hud-timer').hidden = false;
    tickTimer();
    view.timerInt = setInterval(tickTimer, 250);
  }
}
function applyRestrictions(p, msg) {
  const move = msg.move || 'move';
  const canMove = move === 'move';
  const nmpz = move === 'nmpz';
  p.setOptions({
    linksControl: canMove, clickToGo: canMove, keyboardShortcuts: !nmpz && canMove,
    panControl: msg.compass !== 'off' && !nmpz, zoomControl: !nmpz,
    scrollwheel: !nmpz, disableDoubleClickZoom: !canMove
  });
  $('#pano-block').hidden = !nmpz;
  $('#btn-return').hidden = !canMove;
}
function returnToStart() {
  if (!svPano || !startPano) return;
  svPano.setPano(startPano.pano);
  svPano.setPov({ heading: startPano.heading, pitch: 0 });
  svPano.setZoom(0);
}
let minimapTimer = null;
function setMinimap(expanded) {
  clearTimeout(minimapTimer);
  const m = $('#minimap');
  if (m.classList.contains('expanded') === expanded) return;
  m.classList.toggle('expanded', expanded);
  setTimeout(() => guessMap.invalidateSize(), 200);
}
function flashTimer() {
  const el = $('#hud-timer');
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}
function tickTimer() {
  const left = Math.max(0, Math.ceil((view.deadline - Date.now()) / 1000));
  const el = $('#hud-timer');
  $('#timer-text').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const frac = view.timerTotal > 0 ? Math.max(0, Math.min(1, (view.deadline - Date.now()) / view.timerTotal)) : 0;
  $('#timer-fill').style.width = (frac * 100).toFixed(1) + '%';
  el.classList.toggle('low', left <= 10);
  if (left === 0) {
    clearInterval(view.timerInt);
    if (!view.guessed && view.myGuess) submitGuess(); // auto-submit a placed pin
  }
}
function submitGuess() {
  if (view.guessed || !view.myGuess) return;
  view.guessed = true;
  $('#btn-guess').disabled = true;
  $('#btn-guess').textContent = view.players.length > 1 ? 'Waiting for other players…' : 'Revealing…';
  toHost({ t: 'guess', lat: view.myGuess.lat, lng: view.myGuess.lng });
}

let revealAnim = 0;
function renderReveal(msg) {
  clearInterval(view.timerInt);
  view.round = null;
  show('reveal');
  const anim = ++revealAnim;
  const countryMode = isCountryMode(msg.mode);
  $('#hud-timer').hidden = true;
  $('#hud-round').textContent = roundLabel(msg.n, msg.total);
  $('#reveal-round').textContent = msg.total ? `Round ${msg.n} of ${msg.total}` : `Round ${msg.n}`;
  const c = msg.answer.country;
  $('#reveal-country').innerHTML = c ? `${Countries.flag(c.code)} ${esc(c.name)}` : '';
  $('#reveal-title').textContent = msg.answer.title;
  $('#reveal-link').href = msg.answer.url;

  // map: answer first, then each guess line "flies" in from the guess to the answer
  revealLayer.clearLayers();
  if (countryMode && Countries.ready()) {
    const drawn = new Set();
    for (const r of msg.results) {
      if (!r.country || r.correct) continue;
      const key = r.country.code + r.country.name;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const o = outlineLayer(r.country, COLORS[r.color], 0.15);
      if (o) o.addTo(revealLayer);
    }
    const ok = c && outlineLayer(c, '#1f9d55', 0.3);
    if (ok) ok.addTo(revealLayer);
  }
  const goal = L.latLng(msg.answer.lat, msg.answer.lng);
  L.marker(goal, { icon: pinIcon('#111', true), zIndexOffset: 1000 }).addTo(revealLayer).bindTooltip(msg.answer.title);
  const pts = [goal];
  const lines = [];
  for (const r of msg.results) {
    if (!r.guess) continue;
    const g = L.latLng(r.guess.lat, nearLng(r.guess.lng, goal.lng));
    pts.push(g);
    L.marker(g, { icon: pinIcon(COLORS[r.color]) }).addTo(revealLayer).bindTooltip(r.name);
    lines.push({ g, line: L.polyline([g, g], { color: COLORS[r.color], weight: 3, dashArray: '6 6' }).addTo(revealLayer) });
  }
  setTimeout(() => {
    revealMap.invalidateSize();
    if (pts.length > 1) revealMap.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 12 });
    else revealMap.setView(goal, 5);
  }, 50);
  const t0 = performance.now() + 300;
  const LINE_MS = 900;
  const drawLines = (t) => {
    if (anim !== revealAnim) return;
    const k = Math.max(0, Math.min(1, (t - t0) / LINE_MS));
    const e = 1 - Math.pow(1 - k, 3);
    for (const { g, line } of lines) {
      line.setLatLngs([g, L.latLng(g.lat + (goal.lat - g.lat) * e, g.lng + (goal.lng - g.lng) * e)]);
    }
    if (k < 1) requestAnimationFrame(drawLines);
  };
  requestAnimationFrame(drawLines);

  // your result banner
  const mine = msg.results.find((r) => r.id === me.id);
  const you = $('#reveal-you');
  if (mine) {
    let sub;
    if (!mine.guess) sub = 'No guess this round';
    else if (countryMode) sub = (mine.correct ? '✅ Right country: ' : '❌ You picked ') + countryHtml(mine.country);
    else sub = `${fmtDist(mine.dist)} away · ${countryHtml(mine.country)}`;
    const closest = msg.mode === 'classic' && recordRound(msg);
    you.innerHTML = `<div class="you-points" id="you-points">0</div><div class="you-sub">${sub}</div>` +
      (closest ? '<div class="record-badge">🎉 Your closest guess ever!</div>' : '');
    you.className = 'reveal-you' + (countryMode ? (mine.correct ? ' good' : ' bad') : '');
    const unit = msg.mode === 'streak' ? (n) => (mine.correct ? `🔥 Streak ${n}` : `Streak over at ${n}`) : (n) => `+${n.toLocaleString()} pts`;
    const target = msg.mode === 'streak' ? mine.total : mine.score;
    const start = msg.mode === 'streak' ? mine.before : 0;
    setTimeout(() => { if (anim === revealAnim) countUp($('#you-points'), start, target, 900, unit); }, t0 - performance.now() + LINE_MS);
    $('#you-points').textContent = unit(start);
  } else you.innerHTML = '';

  // table, numbers count up after the lines land
  $('#reveal-col2').textContent = countryMode ? 'Pick' : 'Distance';
  $('#reveal-rows').innerHTML = msg.results.map((r, i) => `<tr>
      <td>${dotHtml(r.color)} ${esc(r.name)}${r.id === me.id ? ' (you)' : ''}</td>
      <td>${!r.guess ? 'no guess' : countryMode ? `${r.correct ? '✅' : '❌'} ${r.country ? Countries.flag(r.country.code) : '🌊'}` : `${r.country ? Countries.flag(r.country.code) + ' ' : ''}${fmtDist(r.dist)}`}</td>
      <td data-n="${i}" class="pts">0</td>
      <td data-t="${i}">${r.before.toLocaleString()}</td></tr>`).join('');
  setTimeout(() => {
    if (anim !== revealAnim) return;
    msg.results.forEach((r, i) => {
      countUp(document.querySelector(`[data-n="${i}"]`), 0, r.score, 900, (n) => n.toLocaleString());
      countUp(document.querySelector(`[data-t="${i}"]`), r.before, r.total, 900, (n) => n.toLocaleString());
    });
  }, t0 - performance.now() + LINE_MS);
  if (mine) $('#hud-score').textContent = scoreLabel(mine.total, msg.mode);

  $('#btn-next').hidden = !me.isHost;
  $('#btn-next').textContent = msg.last ? 'See final results' : 'Next round';
  $('#reveal-wait').hidden = me.isHost;
}

// put a guess on the copy of the world nearest the answer so lines take the short way
function nearLng(lng, ref) {
  while (lng - ref > 180) lng -= 360;
  while (lng - ref < -180) lng += 360;
  return lng;
}
const numIcon = (n) => L.divIcon({ className: '', html: `<span class="num-pin">${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
function dotHtml(color) { return `<span class="dot" style="--c:${COLORS[color]};display:inline-block"></span>`; }

function renderFinal(msg) {
  show('final');
  msg.newBest = recordGame(msg);
  const rounds = msg.rounds || [];
  const players = msg.standings;
  const countryMode = isCountryMode(msg.mode);
  $('#final-list').innerHTML = players.map((s) =>
    `<li>${dotHtml(s.color)} ${esc(s.name)}${s.id === me.id ? ' (you)' : ''}: <strong>${scoreLabel(s.total, msg.mode)}</strong></li>`).join('');

  // map: every round's location (numbered) plus every player's guess
  finalLayer.clearLayers();
  finalBounds = [];
  const all = [];
  rounds.forEach((r, i) => {
    const goal = L.latLng(r.answer.lat, r.answer.lng);
    const pts = [goal];
    for (const x of r.results) {
      if (!x.guess) continue;
      const g = L.latLng(x.guess.lat, nearLng(x.guess.lng, goal.lng));
      pts.push(g);
      L.polyline([g, goal], { color: COLORS[x.color], weight: 2, opacity: 0.85, dashArray: '4 6' }).addTo(finalLayer);
      L.circleMarker(g, { radius: 6, color: '#fff', weight: 2, fillColor: COLORS[x.color], fillOpacity: 1 })
        .addTo(finalLayer).bindTooltip(`${esc(x.name)}, round ${r.n}: ${x.country ? Countries.flag(x.country.code) + ' ' : ''}${fmtDist(x.dist)}, ${x.score.toLocaleString()} pts`);
    }
    L.marker(goal, { icon: numIcon(r.n), zIndexOffset: 1000 }).addTo(finalLayer)
      .bindTooltip(`Round ${r.n}: ${esc(r.answer.title)}`)
      .on('click', () => focusRound(i));
    finalBounds[i] = L.latLngBounds(pts);
    all.push(...pts);
  });
  finalAllBounds = all.length ? L.latLngBounds(all) : null;
  setTimeout(() => focusRound(-1), 50);

  // table: one row per round, one column per player
  const multi = players.length > 1;
  let h = `<thead><tr><th>Round</th>${players.map((p) => `<th>${dotHtml(p.color)} ${esc(p.name)}</th>`).join('')}</tr></thead><tbody>`;
  rounds.forEach((r, i) => {
    const best = Math.max(0, ...r.results.map((x) => x.score));
    const ac = r.answer.country;
    h += `<tr class="round-row" data-i="${i}"><td><strong>${r.n}</strong> ${ac ? Countries.flag(ac.code) + ' ' + esc(ac.name) : ''}<span class="muted small place" title="${esc(r.answer.title)}">${esc(r.answer.title)}</span></td>`;
    h += players.map((p) => {
      const x = r.results.find((y) => y.id === p.id);
      if (!x) return '<td class="muted">-</td>';
      const cls = multi && best > 0 && x.score === best ? ' class="best"' : '';
      const flagOf = x.country ? Countries.flag(x.country.code) : (x.guess ? '🌊' : '');
      const detail = !x.guess ? 'no guess' : countryMode ? `${x.correct ? '✅' : '❌'} ${flagOf}` : `${flagOf} ${fmtDist(x.dist)}`;
      return `<td${cls}>${x.score.toLocaleString()}<div class="muted small">${detail}</div></td>`;
    }).join('');
    h += '</tr>';
  });
  h += `</tbody><tfoot><tr><th>Total</th>${players.map((p) => `<th>${msg.mode === 'streak' ? '🔥 ' + p.total : p.total.toLocaleString()}</th>`).join('')}</tr></tfoot>`;
  $('#final-breakdown').innerHTML = h;

  $('#btn-again').hidden = !me.isHost;
  $('#final-wait').hidden = me.isHost;
  playPodium(msg);
}

/* ---------------- podium ---------------- */
let podiumRun = 0, podiumMsg = null;
function podiumTitle(msg) {
  const st = msg.standings;
  if (st.length === 1) return msg.mode === 'streak' ? `🔥 ${st[0].total} in a row!` : `${st[0].total.toLocaleString()} points!`;
  if (st[1] && st[1].total === st[0].total) return '🤝 It\'s a tie!';
  return `🏆 ${esc(st[0].name)} wins!`;
}
function playPodium(msg) {
  const run = ++podiumRun;
  podiumMsg = msg;
  const st = msg.standings;
  const solo = st.length === 1;
  const fmt = (n) => (msg.mode === 'streak' ? `🔥 ${n}` : `${n.toLocaleString()} pts`);
  $('#podium').hidden = false;
  $('.podium').classList.toggle('solo', solo);
  $('.podium').classList.toggle('duo', st.length === 2);
  $('#podium-title').textContent = solo ? 'Your final score' : 'And the winner is…';
  $('#btn-podium-skip').hidden = false;
  $('#btn-podium-done').hidden = true;
  $('#podium-rest').innerHTML = st.slice(3).map((s, i) =>
    `<li value="${i + 4}">${dotHtml(s.color)} ${esc(s.name)}${s.id === me.id ? ' (you)' : ''}: ${fmt(s.total)}</li>`).join('');
  const steps = [1, 2, 3].map((n) => document.querySelector('.step.p' + n));
  steps.forEach((el, i) => {
    const s = st[i];
    el.hidden = !s;
    el.classList.remove('shown');
    if (!s) return;
    el.querySelector('.step-name').innerHTML = `${dotHtml(s.color)} ${esc(s.name)}${s.id === me.id ? ' (you)' : ''}`;
    el.querySelector('.step-score').textContent = fmt(0);
  });
  // reveal 3rd, then 2nd, then the winner
  const order = [2, 1, 0].filter((i) => st[i]);
  let t = 700;
  order.forEach((i) => {
    setTimeout(() => {
      if (run !== podiumRun) return;
      steps[i].classList.add('shown');
      countUp(steps[i].querySelector('.step-score'), 0, st[i].total, i === 0 ? 1800 : 1100, fmt);
      if (i === 0) setTimeout(() => { if (run === podiumRun) finishPodium(true); }, 1900);
    }, t);
    t += 1900;
  });
}
function finishPodium(celebrate) {
  const msg = podiumMsg;
  if (!msg) return;
  podiumRun++; // cancel pending steps
  const fmt = (n) => (msg.mode === 'streak' ? `🔥 ${n}` : `${n.toLocaleString()} pts`);
  msg.standings.slice(0, 3).forEach((s, i) => {
    const el = document.querySelector('.step.p' + (i + 1));
    el.classList.add('shown');
    el.querySelector('.step-score').textContent = fmt(s.total);
  });
  $('#podium-title').innerHTML = podiumTitle(msg) + (msg.newBest ? '<div class="record-badge big">🎉 New personal best!</div>' : '');
  $('#btn-podium-skip').hidden = true;
  $('#btn-podium-done').hidden = false;
  if (celebrate) confetti();
}
function closePodium() {
  podiumRun++;
  $('#podium').hidden = true;
  setTimeout(() => focusRound(-1), 30);
}
function confetti() {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = $('#confetti');
  const ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) return;
  const W = (cv.width = cv.clientWidth), H = (cv.height = cv.clientHeight);
  const cols = ['#ffd23f', '#3fb68a', '#e4572e', '#2e86ab', '#ff6f91', '#ffffff'];
  const ps = Array.from({ length: 160 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 120, y: H * 0.45, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4, c: cols[Math.floor(Math.random() * cols.length)]
  }));
  const t0 = performance.now();
  const frame = (t) => {
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (t - t0 < 4000 && !$('#podium').hidden) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(frame);
}
function focusRound(i) {
  finalMap.invalidateSize();
  document.querySelectorAll('#final-breakdown .round-row').forEach((tr) => tr.classList.toggle('active', Number(tr.dataset.i) === i));
  $('#btn-show-all').hidden = i < 0;
  const b = i >= 0 ? finalBounds[i] : finalAllBounds;
  if (!b) return;
  if (b.getNorthEast().equals(b.getSouthWest())) finalMap.setView(b.getCenter(), 6);
  else finalMap.fitBounds(b, { padding: [40, 40], maxZoom: 12 });
}

/* ---------------- networking ---------------- */
function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
const reconnect = { code: null, tries: 0, timer: null };
function resetAll() {
  clearTimeout(reconnect.timer);
  reconnect.code = null;
  reconnect.tries = 0;
  clearTimeout(game.timer);
  clearInterval(view.timerInt);
  for (const c of conns.values()) { try { c.close(); } catch { /* ignore */ } }
  conns.clear();
  if (hostConn) { const c = hostConn; hostConn = null; try { c.close(); } catch { /* ignore */ } }
  peerToId.clear();
  if (peer) { try { peer.destroy(); } catch { /* ignore */ } peer = null; }
  game.players.clear(); game.guesses.clear(); game.used.clear();
  game.phase = 'lobby'; game.roundNo = 0; game.next = null; game.code = null; game.lastReveal = null; game.lastFinal = null; game.history = [];
  view.players = []; view.round = null; view.code = null;
  me.isHost = false; me.solo = false; me.id = 'host';
}
function goHome() {
  resetAll();
  renderRecords();
  show('home');
}
function readName() {
  const n = $('#in-name').value.trim().slice(0, 20) || 'Explorer';
  saveName(n);
  me.name = n;
}
function requirePeerJs() {
  if (typeof window.Peer === 'function') return true;
  toast('Multiplayer library failed to load. Check your connection or ad blocker.');
  return false;
}

function startSolo() {
  resetAll();
  readName();
  me.isHost = true; me.solo = true; me.id = 'host';
  hostOnMessage('host', { t: 'join', name: me.name });
}

function startHosting(attempt = 0) {
  if (!requirePeerJs()) return;
  if (attempt === 0) { resetAll(); readName(); }
  const code = randomCode();
  me.isHost = true; me.id = 'host';
  peer = new Peer(PEER_PREFIX + code);
  toast('Creating room…');
  peer.on('open', () => {
    game.code = code;
    hostOnMessage('host', { t: 'join', name: me.name });
    history.replaceState(null, '', '?room=' + code);
    toast('Room ready. Share the code with friends!');
  });
  peer.on('connection', (conn) => {
    conn.on('data', (d) => {
      if (d && d.t === 'join') {
        // the player id is the guest's per-tab token, so a reconnecting guest maps back to their old entry
        const id = (typeof d.token === 'string' && /^[a-z0-9]{4,24}$/i.test(d.token) && d.token !== 'host') ? d.token : conn.peer;
        const old = conns.get(id);
        if (old && old !== conn) { try { old.close(); } catch { /* ignore */ } }
        peerToId.set(conn.peer, id);
        conns.set(id, conn);
        hostOnMessage(id, d);
        return;
      }
      const id = peerToId.get(conn.peer);
      if (id) hostOnMessage(id, d);
    });
    const dropped = () => {
      const id = peerToId.get(conn.peer);
      peerToId.delete(conn.peer);
      if (id && conns.get(id) === conn) { conns.delete(id); playerOffline(id); }
    };
    conn.on('close', dropped);
    conn.on('error', dropped);
  });
  peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && attempt < 5) { peer.destroy(); peer = null; startHosting(attempt + 1); return; }
    if (err.type === 'peer-unavailable') return; // a guest vanished; harmless
    toast('Connection problem: ' + (err.type || err.message));
    if (!game.code) goHome();
  });
}

function joinRoom() {
  if (!requirePeerJs()) return;
  const code = $('#in-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) { toast('Enter the 5-character room code.'); return; }
  resetAll();
  readName();
  toast('Connecting…');
  connectToRoom(code);
}
// (Re)connect to a room. The token makes the host treat us as the same player as before.
function connectToRoom(code) {
  reconnect.code = code;
  me.id = playerToken(code, true);
  if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
  peer = new Peer();
  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    hostConn = conn;
    conn.on('open', () => conn.send({ t: 'join', name: me.name, token: me.id }));
    conn.on('data', (msg) => { if (msg && msg.t === 'welcome') history.replaceState(null, '', '?room=' + code); onMessage(msg); });
    conn.on('close', () => { if (hostConn === conn) connectionLost(); });
  });
  peer.on('error', (err) => {
    if (reconnect.tries > 0) { connectionLost(); return; } // still trying to get back in
    toast(err.type === 'peer-unavailable' ? 'Room not found. Check the code.' : 'Connection problem: ' + (err.type || err.message));
    forgetToken(code);
    goHome();
  });
}
function connectionLost() {
  const code = reconnect.code;
  if (!code) return;
  hostConn = null;
  if (reconnect.tries >= 6) {
    toast('Could not reconnect. The host may have left the game.');
    forgetToken(code);
    history.replaceState(null, '', location.pathname);
    goHome();
    return;
  }
  reconnect.tries++;
  toast(`Connection lost. Reconnecting… (${reconnect.tries}/6)`);
  clearTimeout(reconnect.timer);
  reconnect.timer = setTimeout(() => connectToRoom(code), 1500 * reconnect.tries);
}

/* ---------------- wire up ---------------- */
function init() {
  initMaps();
  $('#in-name').value = loadName();
  const room = new URLSearchParams(location.search).get('room');
  if (room) $('#in-code').value = room.toUpperCase().slice(0, 5);
  Countries.load().catch(() => {}); // country borders for flags and country modes

  $('#btn-solo').onclick = startSolo;
  $('#btn-host').onclick = () => startHosting(0);
  $('#btn-join').onclick = joinRoom;
  $('#in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#btn-start').onclick = () => { if (me.isHost) hostStart(); };
  const leave = () => { if (reconnect.code) forgetToken(reconnect.code); history.replaceState(null, '', location.pathname); goHome(); };
  $('#btn-leave').onclick = leave;
  $('#btn-guess').onclick = submitGuess;
  $('#final-breakdown').addEventListener('click', (e) => {
    const tr = e.target.closest('.round-row');
    if (tr) focusRound(Number(tr.dataset.i));
  });
  $('#btn-show-all').onclick = () => focusRound(-1);
  $('#btn-podium-skip').onclick = () => finishPodium(false);
  $('#btn-podium-done').onclick = closePodium;
  $('#btn-return').onclick = returnToStart;
  const mm = $('#minimap');
  mm.addEventListener('mouseenter', () => setMinimap(true));
  mm.addEventListener('mouseleave', () => { minimapTimer = setTimeout(() => setMinimap(false), 400); });
  $('#btn-map-toggle').onclick = () => {
    const open = !mm.classList.contains('open');
    mm.classList.toggle('open', open);
    $('#btn-map-toggle').textContent = open ? 'Back to street' : 'Open map';
    setTimeout(() => guessMap.invalidateSize(), 50);
  };
  $('#btn-next').onclick = () => { if (me.isHost) hostNextRound(); };
  $('#btn-again').onclick = () => { if (me.isHost) hostBackToLobby(); };
  $('#btn-home').onclick = leave;
  $('#btn-copy').onclick = async () => {
    const link = location.origin + location.pathname + '?room=' + view.code;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied!'); }
    catch { toast(link); }
  };
  const syncSettings = () => {
    if (!me.isHost) return;
    readSettings();
    broadcastPlayers();
  };
  for (const id of SETTING_IDS) $('#set-' + id).onchange = syncSettings;
  $('#set-mode').addEventListener('change', updateModeFields);
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !$('#screen-game').hidden && !$('#btn-guess').disabled) { e.preventDefault(); submitGuess(); }
  });
  renderRecords();
  $('#btn-reset-records').onclick = () => {
    if (confirm('Delete all your personal records in this browser?')) { saveRecords({}); renderRecords(); }
  };
  show('home');
  loadGoogle().catch((e) => toast(e.message)); // load the script early; no panorama is created yet
  // came back to a room this tab was playing in (e.g. after a reload): rejoin automatically
  const code = room && room.toUpperCase().slice(0, 5);
  if (code && playerToken(code, false) && typeof window.Peer === 'function') {
    readName();
    toast('Rejoining your game…');
    reconnect.tries = 1; // treat failures as reconnect attempts
    connectToRoom(code);
  }
}

if (typeof L === 'undefined') {
  document.body.innerHTML = '<p style="padding:24px">Could not load the map library. Check your internet connection and reload.</p>';
} else {
  init();
}
