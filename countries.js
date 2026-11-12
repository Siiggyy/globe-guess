'use strict';
/* Offline country lookup: which country contains a lat/lng?
 * Uses Natural Earth 1:50m boundaries (data/countries-50m.json, via world-atlas)
 * and d3-geo's spherical point-in-polygon test. No network calls besides loading the file. */
(function () {
  let features = null;
  let loading = null;

  function load() {
    if (features) return Promise.resolve(features);
    if (!loading) {
      loading = fetch('data/countries-50m.json')
        .then((r) => { if (!r.ok) throw new Error('countries ' + r.status); return r.json(); })
        .then((topo) => {
          features = topojson.feature(topo, topo.objects.countries).features
            .map((f) => ({ f, code: f.properties.c, name: f.properties.n, bounds: d3.geoBounds(f) }));
          return features;
        })
        .catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  function inBox(b, lng, lat) {
    const [[w, s], [e, n]] = b;
    if (lat < s - 0.01 || lat > n + 0.01) return false;
    return w <= e ? lng >= w - 0.01 && lng <= e + 0.01 : lng >= w - 0.01 || lng <= e + 0.01; // box may cross the antimeridian
  }
  function exact(lat, lng) {
    for (const c of features) {
      if (inBox(c.bounds, lng, lat) && d3.geoContains(c.f, [lng, lat])) return c;
    }
    return null;
  }

  /** Country at lat/lng, or null (open sea). `nearby` also tries points up to ~25 km around,
   *  which catches spots on coasts, bridges and piers that the 1:50m outlines miss. */
  function countryAt(lat, lng, nearby) {
    if (!features) return null;
    let c = exact(lat, lng);
    if (!c && nearby) {
      outer: for (const r of [0.05, 0.1, 0.2]) {
        for (let a = 0; a < 360; a += 30) {
          const rad = a * Math.PI / 180;
          c = exact(lat + r * Math.sin(rad), lng + r * Math.cos(rad) / Math.max(0.2, Math.cos(lat * Math.PI / 180)));
          if (c) break outer;
        }
      }
    }
    return c ? { code: c.code, name: c.name } : null;
  }

  /** Flag image (HTML) for an ISO 3166-1 alpha-2 code. Images rather than emoji, because
   *  Windows does not draw flag emoji. SVGs from flag-icons (MIT), in /flags. */
  function flag(code) {
    if (!code || !/^[A-Z]{2}$/.test(code)) return '<span class="flag-img flag-none" aria-hidden="true"></span>';
    return `<img class="flag-img" src="flags/${code.toLowerCase()}.svg" alt="${code}" loading="lazy">`;
  }

  window.Countries = { load, countryAt, flag, ready: () => !!features };
})();
