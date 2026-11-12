// Carte du trajet : itinéraire prévu, position GPS, tracé parcouru et signalements.
// Fonds OpenStreetMap, itinéraire OSRM, lieux géocodés par Nominatim (mis en cache sur l'appareil).
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";

const MAYOTTE = [-12.82, 45.15];
const CACHE = "trajet.geo";
const cache = (() => { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch (e) { return {}; } })();
const keep = () => { try { localStorage.setItem(CACHE, JSON.stringify(cache)); } catch (e) {} };

let map = null, el = null, info = null, followBtn = null;
let plan = null, done = null, me = null, meAcc = null, sigLayer = null, ends = null;
let follow = true, lastKey = "", fitted = "", pending = {};

const R = 6371000, rad = Math.PI / 180;
const dist = (a, b) => { const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)); };
const km = m => (m / 1000).toFixed(m < 10000 ? 1 : 0).replace(".", ",") + " km";

async function geocode(q) {
  const k = "g:" + q.toLowerCase().trim();
  if (cache[k]) return cache[k];
  let c = null;
  // Photon (OpenStreetMap), limité à Mayotte ; Nominatim en secours
  try {
    const j = await (await fetch("https://photon.komoot.io/api/?limit=1&lang=fr&bbox=44.9,-13.1,45.35,-12.6&q=" + encodeURIComponent(q))).json();
    const f = j.features?.[0]; if (f) c = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
  } catch (e) {}
  if (!c) try {
    const j = await (await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=yt&q=" + encodeURIComponent(q + ", Mayotte"))).json();
    if (j[0]) c = [+j[0].lat, +j[0].lon];
  } catch (e) {}
  if (!c) return null;
  cache[k] = [+c[0].toFixed(5), +c[1].toFixed(5)]; keep();
  return cache[k];
}
// Itinéraire routier entre les deux lieux (la barge est un bac dans OpenStreetMap : OSRM sait la prendre)
async function route(dep, arr) {
  const k = "r:" + dep.toLowerCase().trim() + "|" + arr.toLowerCase().trim();
  if (cache[k] && Date.now() - cache[k].at < 30 * 86400000) return cache[k];
  const a = await geocode(dep), b = await geocode(arr);
  if (!a || !b) return null;
  const u = `https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`;
  const j = await (await fetch(u)).json();
  const g = j.routes?.[0];
  const line = g ? g.geometry.coordinates.map(c => [+c[1].toFixed(5), +c[0].toFixed(5)]) : [a, b];
  cache[k] = { at: Date.now(), a, b, line, m: g ? g.distance : dist(a, b), straight: !g }; keep();
  return cache[k];
}

// Position projetée sur l'itinéraire : distance parcourue, restante, et écart à la route
function progress(line, p) {
  let best = { d: Infinity, along: 0 }, cum = 0;
  const cosLat = Math.cos(p[0] * rad);
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1], seg = dist(a, b);
    const ax = (a[1] - p[1]) * cosLat, ay = a[0] - p[0], bx = (b[1] - p[1]) * cosLat, by = b[0] - p[0];
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d = dist(q, p);
    if (d < best.d) best = { d, along: cum + seg * t };
    cum += seg;
  }
  return { off: best.d, done: best.along, total: cum };
}

function init(container) {
  el = container;
  el.innerHTML = '<div class="carte" id="carteMap" role="img" aria-label="Carte du trajet"></div><div class="carte-bas"><p class="carte-info" id="carteInfo"></p><button class="carte-suivre" id="carteSuivre" type="button" hidden>Me suivre</button></div>';
  info = el.querySelector("#carteInfo"); followBtn = el.querySelector("#carteSuivre");
  map = L.map(el.querySelector("#carteMap"), { zoomControl: true, attributionControl: true }).setView(MAYOTTE, 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  plan = L.polyline([], { color: "#0B7A75", weight: 5, opacity: .45 }).addTo(map);
  done = L.polyline([], { color: "#0B7A75", weight: 6, opacity: .95 }).addTo(map);
  ends = L.layerGroup().addTo(map);
  sigLayer = L.layerGroup().addTo(map);
  meAcc = L.circle(MAYOTTE, { radius: 1, color: "#2F80ED", weight: 1, fillOpacity: .12 });
  me = L.circleMarker(MAYOTTE, { radius: 8, color: "#fff", weight: 3, fillColor: "#2F80ED", fillOpacity: 1 });
  map.on("dragstart", () => { follow = false; followBtn.hidden = false; });
  followBtn.onclick = () => { follow = true; followBtn.hidden = true; lastKey = ""; carteMaj(window.__carteEtat); };
}

// etat = {dir, dep, arr, active, pos, sigs, expectedMs}
export async function carteMaj(etat) {
  window.__carteEtat = etat;
  const box = document.getElementById("carteBox");
  if (!box || !etat) return;
  if (!etat.dep || !etat.arr) { box.hidden = true; return; }
  box.hidden = false;
  if (!map) init(box);
  const key = etat.dep + "|" + etat.arr;
  let r = cache["r:" + etat.dep.toLowerCase().trim() + "|" + etat.arr.toLowerCase().trim()];
  if (!r && !pending[key]) {
    pending[key] = true; info.textContent = "Chargement de l'itinéraire…";
    route(etat.dep, etat.arr).then(() => { delete pending[key]; carteMaj(window.__carteEtat); })
      .catch(() => { delete pending[key]; info.textContent = "Itinéraire indisponible pour l'instant (connexion ?)."; });
  }
  if (r) {
    plan.setLatLngs(r.line);
    ends.clearLayers();
    L.circleMarker(r.a, { radius: 6, color: "#13242B", weight: 2, fillColor: "#fff", fillOpacity: 1 }).bindTooltip(etat.dep).addTo(ends);
    L.circleMarker(r.b, { radius: 6, color: "#13242B", weight: 2, fillColor: "#F2C14E", fillOpacity: 1 }).bindTooltip(etat.arr).addTo(ends);
  }
  // Tracé parcouru pendant le trajet en cours, prolongé jusqu'à la position actuelle
  const tr = (etat.active?.track || []).map(x => [x[1], x[2]]);
  const p = etat.pos ? [etat.pos.lat, etat.pos.lng] : null;
  if (p && etat.active) tr.push(p);
  done.setLatLngs(etat.active ? tr : []);
  if (p) {
    me.setLatLng(p).addTo(map); meAcc.setLatLng(p).setRadius(Math.max(5, etat.pos.acc || 0)).addTo(map);
  }
  sigLayer.clearLayers();
  (etat.sigs || []).forEach(x => { if (!x.pos) return;
    L.circleMarker([x.pos.lat, x.pos.lng], { radius: 7, color: "#fff", weight: 2, fillColor: "#D64545", fillOpacity: 1 })
      .bindTooltip(x.type + (x.lieu ? " · " + x.lieu : "")).addTo(sigLayer); });
  // Cadrage : tout l'itinéraire au départ, puis la position pendant le trajet
  setTimeout(() => map.invalidateSize(), 0);
  if (r && fitted !== key) { fitted = key; map.fitBounds(L.latLngBounds(r.line).pad(.08)); }
  if (p && etat.active && follow) map.setView(p, Math.max(map.getZoom(), 14), { animate: true });
  // Avancement
  if (!r) return;
  if (r.straight) { info.textContent = `Itinéraire routier introuvable : ligne droite ${km(r.m)}.`; return; }
  if (!p) { info.textContent = `Itinéraire ${km(r.m)} · active la localisation pour suivre ton avancement.`; return; }
  const g = progress(r.line, p);
  if (!etat.active) {
    info.textContent = `Itinéraire ${km(g.total)}` + (g.off > 500 ? ` · tu es à ${km(g.off)} de la route` : ` · tu es sur le parcours, ${km(g.total - g.done)} avant l'arrivée`);
    return;
  }
  const pct = Math.round(100 * g.done / g.total), reste = g.total - g.done;
  let t = `Parcouru ${km(g.done)} sur ${km(g.total)} (${pct} %) · reste ${km(reste)}`;
  if (etat.expectedMs && etat.active.stamps?.[0]) {
    const elapsed = Date.now() - etat.active.stamps[0], frac = g.done / g.total;
    // Rythme actuel et durée prévue, moyennés une fois un sixième du trajet fait
    const prevu = etat.expectedMs * (1 - frac), left = frac > .15 ? (elapsed / frac - elapsed + prevu) / 2 : etat.expectedMs - elapsed;
    if (left > 0) t += ` · arrivée vers ${new Date(Date.now() + left).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (g.off > 400) t += ` · hors de l'itinéraire prévu (${km(g.off)})`;
  info.textContent = t;
}
export const carteInvalide = () => { if (map) map.invalidateSize(); };
