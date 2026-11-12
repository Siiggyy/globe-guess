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
const conns = new Map(); // host only: guest peer id -> DataConnection

/* ---------------- storage (optional) ---------------- */
function loadName() { try { return localStorage.getItem('gg-name') || ''; } catch { return ''; } }
function saveName(n) { try { localStorage.setItem('gg-name', n); } catch { /* ignore */ } }

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
function fmtDist(km) {
  if (km == null) return '-';
  if (km < 1) return Math.round(km * 1000) + ' m';
  return Math.round(km).toLocaleString() + ' km';
}

/* ---------------- maps ---------------- */
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
    const lat = seed[0] + (Math.random() - 0.5) * 0.6;
    const lng = seed[1] + (Math.random() - 0.5) * 0.6;
    const req = { location: { lat, lng }, radius: 15000, preference: lib.StreetViewPreference.NEAREST };
    if (lib.StreetViewSource && lib.StreetViewSource.GOOGLE) req.sources = [lib.StreetViewSource.GOOGLE];
    else req.source = lib.StreetViewSource.OUTDOOR;
    try {
      const { data } = await svService.getPanorama(req);
      const loc = data && data.location;
      if (!loc || !loc.pano || game.used.has(loc.pano)) continue;
      if (!data.links || data.links.length === 0) continue; // skip dead-end single photos
      return {
        pageid: loc.pano, pano: loc.pano,
        lat: loc.latLng.lat(), lng: loc.latLng.lng(),
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
  settings: { rounds: 5, time: 90, move: 'move', region: 'world', compass: 'on' },
  phase: 'lobby',     // lobby | loading | round | reveal | final
  roundNo: 0, current: null, roundStart: 0,
  guesses: new Map(), used: new Set(), timer: null, deadline: 0, next: null, lastReveal: null, lastFinal: null, history: [], code: null
};

function broadcast(msg) {
  for (const c of conns.values()) if (c.open) c.send(msg);
  onMessage(msg); // host's own view
}
function sendTo(id, msg) {
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
    id, name: p.name, total: p.total, color: p.color, guessed: game.guesses.has(id)
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
  game.players.set(id, { name: clean, total: 0, color });
}
function removePlayer(id) {
  conns.delete(id);
  if (!game.players.delete(id)) return;
  game.guesses.delete(id);
  broadcastPlayers();
  if (game.phase === 'round' && allGuessed()) hostReveal();
}
const allGuessed = () => game.players.size > 0 && [...game.players.keys()].every((id) => game.guesses.has(id));

function hostOnMessage(from, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') {
    if (game.players.has(from)) return;
    if (game.players.size >= MAX_PLAYERS) { sendTo(from, { t: 'error', msg: 'That room is full.', fatal: true }); return; }
    addPlayer(from, msg.name);
    sendTo(from, { t: 'welcome', code: game.code });
    broadcastPlayers();
    if (game.phase === 'round') sendTo(from, roundMsg());
    else if (game.phase === 'reveal' && game.lastReveal) sendTo(from, game.lastReveal);
    else if (game.phase === 'final' && game.lastFinal) sendTo(from, game.lastFinal);
    else if (game.phase === 'loading') sendTo(from, { t: 'loading', n: game.roundNo + 1, total: game.settings.rounds });
  } else if (msg.t === 'guess') {
    if (game.phase !== 'round' || game.guesses.has(from) || !game.players.has(from)) return;
    const lat = Number(msg.lat), lng = Number(msg.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90) return;
    game.guesses.set(from, { lat, lng: ((lng + 540) % 360) - 180 });
    broadcastPlayers();
    if (allGuessed()) { hostReveal(); return; }
    // multiplayer: the first lock-in starts a short countdown for everyone else
    const left = game.deadline ? (game.deadline - Date.now()) / 1000 : Infinity;
    if (game.players.size > 1 && game.guesses.size === 1 && left > LOCK_IN_SECONDS) {
      setRoundDeadline(LOCK_IN_SECONDS);
      broadcast({ t: 'timer', remaining: LOCK_IN_SECONDS, by: game.players.get(from).name });
    }
  }
}

const SETTING_IDS = ['rounds', 'time', 'move', 'region', 'compass'];
function readSettings() {
  const v = (id) => $('#set-' + id).value;
  game.settings = {
    rounds: Number(v('rounds')) || 5,
    time: Number(v('time')) || 0,
    move: ['move', 'nomove', 'nmpz'].includes(v('move')) ? v('move') : 'move',
    region: window.LOCATION_REGIONS[v('region')] ? v('region') : 'world',
    compass: v('compass') === 'off' ? 'off' : 'on'
  };
}
function hostStart() {
  readSettings();
  game.roundNo = 0;
  game.used.clear();
  game.history = [];
  game.lastFinal = null;
  for (const p of game.players.values()) p.total = 0;
  hostNextRound();
}
async function hostNextRound() {
  if (game.phase === 'loading') return;
  if (game.roundNo >= game.settings.rounds) return hostFinal();
  game.phase = 'loading';
  broadcast({ t: 'loading', n: game.roundNo + 1, total: game.settings.rounds });
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
  broadcast(roundMsg());
  broadcastPlayers();
  game.next = fetchLocation().catch(() => null); // prefetch the next round
}
const LOCK_IN_SECONDS = 15;
// seconds = 0 means no time limit
function setRoundDeadline(seconds) {
  clearTimeout(game.timer);
  game.deadline = seconds > 0 ? Date.now() + seconds * 1000 : 0;
  if (seconds > 0) game.timer = setTimeout(hostReveal, seconds * 1000 + 1500); // grace for latency
}
function roundMsg() {
  const timed = game.deadline > 0;
  const remaining = timed ? Math.max(0, (game.deadline - Date.now()) / 1000) : 0;
  return { t: 'round', n: game.roundNo, total: game.settings.rounds, pano: game.current.pano, heading: game.current.heading, timed, remaining,
    move: game.settings.move, compass: game.settings.compass };
}
function hostReveal() {
  if (game.phase !== 'round') return;
  clearTimeout(game.timer);
  game.phase = 'reveal';
  const a = game.current;
  const results = [...game.players.entries()].map(([id, p]) => {
    const g = game.guesses.get(id) || null;
    let dist = null, score = 0;
    if (g) { dist = haversine(a.lat, a.lng, g.lat, g.lng); score = scoreFor(dist); }
    p.total += score;
    return { id, name: p.name, color: p.color, guess: g, dist, score, total: p.total };
  }).sort((x, y) => y.score - x.score);
  game.lastReveal = {
    t: 'reveal', n: game.roundNo, total: game.settings.rounds,
    answer: { lat: a.lat, lng: a.lng, title: a.title, url: a.url },
    results, last: game.roundNo >= game.settings.rounds
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
  game.lastFinal = { t: 'final', standings, rounds };
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
      renderLobby();
      show('lobby');
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
    `<li class="${p.guessed ? 'done' : ''}"><span class="dot" style="--c:${COLORS[p.color]}"></span>${esc(p.name)}${p.id === me.id ? ' (you)' : ''}${p.guessed ? ' ✓' : ''}</li>`).join('');
  $('#lobby-players').innerHTML = items;
  $('#game-players').innerHTML = view.players.length > 1 ? items : '';
  $('#hud-score').textContent = myTotal().toLocaleString() + ' pts';
  if (!me.isHost && view.settings) {
    for (const id of SETTING_IDS) if (view.settings[id] != null) $('#set-' + id).value = String(view.settings[id]);
  }
}
function renderLobby() {
  $('#lobby-title').textContent = me.solo ? 'Solo game' : me.isHost ? 'Your room' : 'Joined room';
  $('#lobby-share').hidden = me.solo;
  $('#lobby-code').textContent = view.code || '';
  $('#btn-start').hidden = !me.isHost;
  $('#lobby-wait').hidden = me.isHost;
  for (const id of SETTING_IDS) $('#set-' + id).disabled = !me.isHost;
  renderPlayers();
}

let startPano = null;
function startRoundView(pano, msg) {
  show('game');
  $('#hud-round').textContent = `Round ${msg.n} / ${msg.total}`;
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
  guessMap.setView([20, 0], 1);
  $('#btn-guess').disabled = true;
  $('#btn-guess').textContent = 'Place a pin on the map';
  $('#pano-loading').hidden = false;
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

function renderReveal(msg) {
  clearInterval(view.timerInt);
  view.round = null;
  show('reveal');
  $('#hud-timer').hidden = true;
  $('#hud-round').textContent = `Round ${msg.n} / ${msg.total}`;
  $('#reveal-round').textContent = `Round ${msg.n} of ${msg.total}`;
  $('#reveal-title').textContent = msg.answer.title;
  $('#reveal-link').href = msg.answer.url;

  revealLayer.clearLayers();
  const goal = L.latLng(msg.answer.lat, msg.answer.lng);
  L.marker(goal, { icon: pinIcon('#111', true), zIndexOffset: 1000 }).addTo(revealLayer).bindTooltip(msg.answer.title);
  const pts = [goal];
  for (const r of msg.results) {
    if (!r.guess) continue;
    // draw the guess on the copy of the world nearest the answer so lines don't wrap the long way
    let lng = r.guess.lng;
    while (lng - goal.lng > 180) lng -= 360;
    while (lng - goal.lng < -180) lng += 360;
    const g = L.latLng(r.guess.lat, lng);
    pts.push(g);
    L.polyline([g, goal], { color: COLORS[r.color], weight: 3, dashArray: '6 6' }).addTo(revealLayer);
    L.marker(g, { icon: pinIcon(COLORS[r.color]) }).addTo(revealLayer).bindTooltip(r.name);
  }
  setTimeout(() => {
    revealMap.invalidateSize();
    if (pts.length > 1) revealMap.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 12 });
    else revealMap.setView(goal, 5);
  }, 50);

  $('#reveal-rows').innerHTML = msg.results.map((r) => `<tr>
      <td><span class="dot" style="--c:${COLORS[r.color]};display:inline-block"></span> ${esc(r.name)}${r.id === me.id ? ' (you)' : ''}</td>
      <td>${r.guess ? fmtDist(r.dist) : 'no guess'}</td>
      <td>${r.score.toLocaleString()}</td>
      <td>${r.total.toLocaleString()}</td></tr>`).join('');
  const mine = msg.results.find((r) => r.id === me.id);
  if (mine) $('#hud-score').textContent = mine.total.toLocaleString() + ' pts';

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
const dotHtml = (color) => `<span class="dot" style="--c:${COLORS[color]};display:inline-block"></span>`;

function renderFinal(msg) {
  show('final');
  const rounds = msg.rounds || [];
  const players = msg.standings;
  $('#final-list').innerHTML = players.map((s) =>
    `<li>${dotHtml(s.color)} ${esc(s.name)}${s.id === me.id ? ' (you)' : ''}: <strong>${s.total.toLocaleString()}</strong> pts</li>`).join('');

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
        .addTo(finalLayer).bindTooltip(`${esc(x.name)}, round ${r.n}: ${fmtDist(x.dist)}, ${x.score.toLocaleString()} pts`);
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
    h += `<tr class="round-row" data-i="${i}"><td><strong>${r.n}</strong><span class="muted small place" title="${esc(r.answer.title)}">${esc(r.answer.title)}</span></td>`;
    h += players.map((p) => {
      const x = r.results.find((y) => y.id === p.id);
      if (!x) return '<td class="muted">-</td>';
      const cls = multi && best > 0 && x.score === best ? ' class="best"' : '';
      return `<td${cls}>${x.score.toLocaleString()}<div class="muted small">${x.guess ? fmtDist(x.dist) : 'no guess'}</div></td>`;
    }).join('');
    h += '</tr>';
  });
  h += `</tbody><tfoot><tr><th>Total</th>${players.map((p) => `<th>${p.total.toLocaleString()}</th>`).join('')}</tr></tfoot>`;
  $('#final-breakdown').innerHTML = h;

  $('#btn-again').hidden = !me.isHost;
  $('#final-wait').hidden = me.isHost;
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
function resetAll() {
  clearTimeout(game.timer);
  clearInterval(view.timerInt);
  for (const c of conns.values()) { try { c.close(); } catch { /* ignore */ } }
  conns.clear();
  if (hostConn) { try { hostConn.close(); } catch { /* ignore */ } hostConn = null; }
  if (peer) { try { peer.destroy(); } catch { /* ignore */ } peer = null; }
  game.players.clear(); game.guesses.clear(); game.used.clear();
  game.phase = 'lobby'; game.roundNo = 0; game.next = null; game.code = null; game.lastReveal = null; game.lastFinal = null; game.history = [];
  view.players = []; view.round = null; view.code = null;
  me.isHost = false; me.solo = false; me.id = 'host';
}
function goHome() {
  resetAll();
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
    conn.on('open', () => conns.set(conn.peer, conn));
    conn.on('data', (d) => hostOnMessage(conn.peer, d));
    conn.on('close', () => removePlayer(conn.peer));
    conn.on('error', () => removePlayer(conn.peer));
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
  peer = new Peer();
  peer.on('open', (id) => {
    me.id = id;
    hostConn = peer.connect(PEER_PREFIX + code, { reliable: true });
    hostConn.on('open', () => hostConn.send({ t: 'join', name: me.name }));
    hostConn.on('data', (msg) => { if (msg && msg.t === 'welcome') history.replaceState(null, '', '?room=' + code); onMessage(msg); });
    hostConn.on('close', () => { if (hostConn) { toast('The host left the game.'); goHome(); } });
  });
  peer.on('error', (err) => {
    toast(err.type === 'peer-unavailable' ? 'Room not found. Check the code.' : 'Connection problem: ' + (err.type || err.message));
    goHome();
  });
}

/* ---------------- wire up ---------------- */
function init() {
  initMaps();
  $('#in-name').value = loadName();
  const room = new URLSearchParams(location.search).get('room');
  if (room) $('#in-code').value = room.toUpperCase().slice(0, 5);

  $('#btn-solo').onclick = startSolo;
  $('#btn-host').onclick = () => startHosting(0);
  $('#btn-join').onclick = joinRoom;
  $('#in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#btn-start').onclick = () => { if (me.isHost) hostStart(); };
  $('#btn-leave').onclick = () => { history.replaceState(null, '', location.pathname); goHome(); };
  $('#btn-guess').onclick = submitGuess;
  $('#final-breakdown').addEventListener('click', (e) => {
    const tr = e.target.closest('.round-row');
    if (tr) focusRound(Number(tr.dataset.i));
  });
  $('#btn-show-all').onclick = () => focusRound(-1);
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
  $('#btn-home').onclick = () => { history.replaceState(null, '', location.pathname); goHome(); };
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
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !$('#screen-game').hidden && !$('#btn-guess').disabled) { e.preventDefault(); submitGuess(); }
  });
  show('home');
  loadGoogle().catch((e) => toast(e.message)); // load the script early; no panorama is created yet
}

if (typeof L === 'undefined') {
  document.body.innerHTML = '<p style="padding:24px">Could not load the map library. Check your internet connection and reload.</p>';
} else {
  init();
}
