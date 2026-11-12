'use strict';
/* Base map for all Leaflet maps.
 * Vector tiles from OpenFreeMap (free, no key) rendered with MapLibre, so labels can be shown in the
 * player's language (falling back to English), with the local name underneath for places and waters,
 * like on Google Maps. Falls back to the classic OpenStreetMap raster tiles (local names only) if
 * WebGL or the vector tiles are not available. */
(function () {
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
  const LANG = String((navigator.languages && navigator.languages[0]) || navigator.language || 'en').split('-')[0].toLowerCase();

  // label expressions (MapLibre style spec)
  const LOCAL = ['to-string', ['coalesce', ['get', 'name'], '']];
  const TRANSLATED = ['to-string', ['coalesce', ['get', 'name:' + LANG], ['get', 'name:en'], ['get', 'name_en'], ['get', 'name'], '']];
  const BILINGUAL = ['case',
    ['all', ['!=', LOCAL, ''], ['!=', LOCAL, TRANSLATED]],
    ['format', TRANSLATED, {}, '\n', {}, LOCAL, { 'font-scale': 0.8 }],
    ['format', TRANSLATED, {}]
  ];

  function relabel(m) {
    const style = m.getStyle();
    if (!style || !style.layers) return;
    for (const layer of style.layers) {
      if (layer.type !== 'symbol') continue;
      const tf = m.getLayoutProperty(layer.id, 'text-field');
      if (!tf || !JSON.stringify(tf).includes('name')) continue; // keep road numbers, house numbers etc.
      const src = layer['source-layer'] || '';
      const bilingual = src === 'place' || src === 'water_name' || /^(place|water_name)/.test(layer.id);
      try { m.setLayoutProperty(layer.id, 'text-field', bilingual ? BILINGUAL : TRANSLATED); } catch { /* leave layer as is */ }
    }
  }

  function webglOk() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { return false; }
  }

  function rasterLayer() {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
  }

  // remember a failure so later maps go straight to the fallback
  let vectorFailed = false;

  /** Adds the base map to a Leaflet map. */
  function addBaseMap(map) {
    if (vectorFailed || !L.maplibreGL || !window.maplibregl || !webglOk()) { rasterLayer().addTo(map); return; }
    const layer = L.maplibreGL({ style: STYLE_URL, attribution: ATTRIBUTION });
    layer.addTo(map);
    let ok = false, fellBack = false;
    const fallback = () => {
      if (ok || fellBack) return;
      fellBack = true;
      vectorFailed = true;
      try { map.removeLayer(layer); } catch { /* ignore */ }
      rasterLayer().addTo(map);
    };
    const m = layer.getMaplibreMap && layer.getMaplibreMap();
    if (!m) { fallback(); return; }
    m.on('style.load', () => { ok = true; relabel(m); });
    m.on('error', (e) => { if (!ok && e && e.error && /style|fetch|Failed/i.test(String(e.error.message || e.error))) fallback(); });
    setTimeout(fallback, 12000); // style never arrived
  }

  window.BaseMap = { addBaseMap, LANG, _expr: { TRANSLATED, BILINGUAL } };
})();
