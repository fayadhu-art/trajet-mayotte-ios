import { initFirebase, deleteAccount, callFn, getVeille } from "./store.js";
import { getPosition, watchPosition, clearPositionWatch, initPush, enablePush } from "./native.js";
import { PRIVACY_URL } from "./firebase-config.js";
import { carteMaj } from "./carte.js";

const $ = id => document.getElementById(id);
let pushState = "unknown", myPos = null, watchId = null;
const DEF = {
  stepsA: ["Départ maison", "Arrivée à Mamoudzou", "Départ de la barge Mamoudzou", "Arrivée barge Dzaoudzi", "Montée dans le taxi", "Descente du taxi", "Arrivée au travail"],
  stepsR: ["Fin de service, sortie du travail", "Montée dans le taxi", "Descente du taxi", "Départ de la barge Dzaoudzi", "Arrivée barge Mamoudzou", "Départ de Mamoudzou", "Arrivée maison"],
  estA: 75, estR: 75, margin: 10, avantBarge: 90, plusScolaire: 10, apresBarge: 45, tA: "", tR: "", fixed: false, day: null
};
const BARGES = ["Amphidrome", "Barge normale"];
const MODES = ["Taxi", "Voiture", "Bus"];
// Départs de Mamoudzou : barge normale dès 5 h 30 toutes les 30 min, amphidrome dès 7 h 00 toutes les 15 min
const HORAIRES = (() => { const a = [];
  for (let m = 5*60+30; m <= 23*60; m += 30) a.push({m, type: "Barge normale"});
  for (let m = 7*60; m <= 22*60; m += 15) if (!a.some(x => x.m === m)) a.push({m, type: "Amphidrome"});
  return a.sort((x, y) => x.m - y.m); })();
const hm = m => `${Math.floor(m/60)} h ${String(m%60).padStart(2, "0")}`;
const dureeMin = m => m >= 60 ? `${Math.floor(m/60)} h${m%60 ? " " + String(m%60).padStart(2, "0") : ""}` : `${m} min`;
// Barge à prendre pour arriver à l'heure, et heure de départ de la maison
function planAller(svcM, vac){
  const full = tripsFor("aller").filter(t => (t.steps||[]).length >= 7 && (t.stamps||[]).length >= 7 && t.stamps[6] > t.stamps[2] && t.stamps[2] > t.stamps[0]);
  const apres = full.length >= 3 ? Math.round(pct(full.map(t => t.stamps[6] - t.stamps[2]), .8) / 60000) : S.apresBarge;
  const limite = svcM - S.margin - apres;
  const b = [...HORAIRES].reverse().find(x => x.m <= limite), barge = b || HORAIRES[0];
  const meme = full.filter(t => isVac(t) === vac);
  const appris = meme.length >= 3;
  const avant = appris ? Math.round(pct(meme.map(t => t.stamps[2] - t.stamps[0]), .8) / 60000) : S.avantBarge + (vac ? 0 : S.plusScolaire);
  return {barge, trop: !b, apres, avant, appris, nApres: full.length, nAvant: meme.length};
}
const TAGS = ["Attente taxi", "Attente bus", "Attente barge", "Route bloquée", "Pluie", "Accident"];
const HINTS = {"Arrivée à Mamoudzou":"Au quai de la barge", "Départ de Mamoudzou":"En taxi, voiture ou bus"};
const HINTS_DIR = {aller: {"Montée dans le taxi":"Au quai de Dzaoudzi, vers le travail", "Descente du taxi":"Devant le travail"},
  retour: {"Montée dans le taxi":"Vers la barge de Dzaoudzi", "Descente du taxi":"Au quai de la barge Dzaoudzi"}};
const isBarge = n => /embarquement barge|départ de la barge/i.test(n);
// Attente au quai : de l'arrivée au quai (Mamoudzou, ou descente du taxi à Dzaoudzi) jusqu'au départ de la barge
const quaiWait = t => { const i = (t.steps||[]).findIndex(isBarge); return i > 0 && /arrivée à mamoudzou|descente du taxi/i.test(t.steps[i-1]) && t.stamps[i] && t.stamps[i-1] ? t.stamps[i]-t.stamps[i-1] : null; };
const waitTxt = s => `Attente au quai depuis ${hhmm(new Date(s))} · ${fmtClock(Date.now()-s)}`;
// Attente du taxi : de l'étape précédente (arrivée barge Dzaoudzi à l'aller, sortie du travail au retour) jusqu'à la montée dans le taxi
const isTaxiUp = n => /^montée dans le taxi/i.test(n);
// À Dzaoudzi, chaque barge a son quai ; à Mamoudzou, les deux partent et arrivent au même quai
const QUAI = {"Amphidrome": "quai Ballou", "Barge normale": "quai Issoufali"};
const QUAIS_DZA = "Quai Ballou (amphidrome) ou quai Issoufali (barge normale)";
const taxiWait = t => { const i = (t.steps||[]).findIndex(isTaxiUp); return i > 0 && t.stamps[i] && t.stamps[i-1] ? t.stamps[i]-t.stamps[i-1] : null; };
const taxiTxt = s => `Attente du taxi depuis ${hhmm(new Date(s))} · ${fmtClock(Date.now()-s)}`;
let manualIdx = null, manualPick = null;

let S = {...DEF}, trips = [], dir = "aller", db = null, uid = null, tripsCol = null, setRef = null;
let active = null, tags = new Set(), note = "", pendingDel = null, tick = null, wake = null;
let pendingLocal = [], abandonAsk = false, evPick = false, lateStart = false; const modeMem = {};
const EV_TYPES = ["Accident", "Route bloquée / barrage", "Travaux", "Contrôle routier", "Barge à l'arrêt ou retardée", "Longue attente de taxi", "Route inondée / éboulement", "Pluie forte", "Panne", "Autre"];
const RULE_BEFORE = 480; // service avant 8 h : vérifier la première barge

const ls = {get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}},
            set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};

const noKaw = a => a.filter(n => !/^passage kaw/i.test(n) && !/^montée (taxi|bus) vers la barge$/i.test(n));
// Étapes fixes du trajet (les anciens réglages enregistrés ne les remplacent plus)
const steps = d => d === "aller" ? DEF.stepsA : DEF.stepsR;
const isHome = n => /vers le nord|départ de mamoudzou/i.test(n);
const isRoute = n => isHome(n);
const ROUTES = ["Par le nord", "Par le sud"];
let routeSel = null;
const dayKey = () => isoDay(Date.now() - 3*3600000);
const svc = d => { const k = d === "aller" ? "tA" : "tR";
  if (S.fixed) return S[k] || ""; return S.day && S.day.date === dayKey() ? (S.day[k] || "") : ""; };
const lab = t => t === "00:00" ? "minuit" : t;
const atTime = (base, t) => { const [h,m]=(t||"0:0").split(":").map(Number); const d=new Date(base); d.setHours(h,m,0,0); return d; };
const gap = ms => { const m=Math.round(Math.abs(ms)/60000); return m===0 ? "pile à l'heure" : (ms<0 ? `${m} min d'avance` : `${m} min de retard`); };
const fmtKm = m => (m / 1000).toFixed(1).replace(".", ",") + " km";
const tripKm = t => t.km != null ? t.km * 1000 : null;
const fmtDur = ms => { const m = Math.round(ms/60000); return m >= 60 ? `${Math.floor(m/60)}h${String(m%60).padStart(2,"0")}` : `${m} min`; };
const fmtClock = ms => { const s = Math.floor(ms/1000); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(x).padStart(2,"0")}` : `${m}:${String(x).padStart(2,"0")}`; };
const hhmm = d => d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
const curSteps = () => active && active.dir === dir ? active.steps : steps(dir);
const tripsFor = d => trips.filter(t => t.dir === d).sort((a,b)=>b.start-a.start);
// Arrêts volontaires (course, pause…) : retirés du temps de route
const STOP_MOTIFS = ["Course", "Pause", "Essence", "Déposer quelqu'un", "Autre"];
const stopMs = (t, from, to) => (t.stops||[]).reduce((a,x) => a + Math.max(0, Math.min(x.end ?? Date.now(), to) - Math.max(x.start, from)), 0);
const drive = t => (t.end - t.start) - stopMs(t, t.start, t.end);
const durs = d => tripsFor(d).slice(0,30).map(drive);
const pct = (arr,p) => { const s=[...arr].sort((a,b)=>a-b); return s[Math.max(0,Math.ceil(p*s.length)-1)]; };
const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;

// Vacances scolaires de l'académie de Mayotte : [premier jour sans cours, jour de reprise)
const VACANCES = [
  ["d'été", "2026-07-04", "2026-08-24"], ["de la Toussaint", "2026-10-10", "2026-10-26"], ["de Noël", "2026-12-12", "2027-01-11"],
  ["de Carnaval", "2027-02-20", "2027-03-08"], ["de Pâques", "2027-04-30", "2027-05-18"], ["d'été", "2027-07-10", "2027-08-23"],
];
const isoDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const vacOf = ms => { const k = isoDay(ms); return VACANCES.find(v => k >= v[1] && k < v[2]) || null; };
const isVac = t => typeof t.vac === "boolean" ? t.vac : !!vacOf(t.start);
const periodLbl = v => v ? "en vacances scolaires" : "en période scolaire";
const minOfDay = ms => { const d = new Date(ms); return d.getHours()*60 + d.getMinutes(); };
const cdiff = (a,b) => { const x = Math.abs(a-b) % 1440; return Math.min(x, 1440-x); };
const svcMin = d => { const t = svc(d); if (!t) return null; const [h,m] = t.split(":").map(Number); return h*60+m; };

let sigs = [], sigType = null, sigCol = null, sigSeen = new Set(), sigBooted = false;
const SIG_TYPES = ["Embouteillage", "Accident", "Route bloquée / barrage", "Barge à l'arrêt ou retardée", "Longue attente de taxi", "Route inondée / éboulement", "Autre"];
const PLACES = ["Handréma", "Bandraboua", "Dzoumogné", "Longoni", "M'tsamboro", "Acoua", "Mtsangamouji", "Koungou", "Majicavo", "Kawéni", "Mamoudzou centre", "Quai de la barge Mamoudzou", "Passamaïnty", "Tsoundzou", "Dembéni", "Combani", "Sada", "Chirongui", "Quai de la barge Dzaoudzi", "Quai Ballou (amphidrome, Dzaoudzi)", "Quai Issoufali (barge normale, Dzaoudzi)", "Labattoir", "Pamandzi", "Aéroport"];
const SIG_TTL = 2*3600000;
// Durée attendue à partir des trajets les plus comparables (même sens, même heure, même passage, même moyen)
function expected(d, opt = {}){
  const all = tripsFor(d).slice(0,80);
  const route = opt.route ?? null;
  const mode = d==="aller" ? (opt.mode ?? ls.get("trajet.modeA")) : null;
  const rm = refMs(d);
  const base = all.length >= 3 ? pct(all.map(drive), .8) : (rm ?? (d==="aller"?S.estA:S.estR)*60000);
  const sm = svcMin(d);
  const depMin = sm == null ? null : (d==="aller" ? sm - Math.round(base/60000) - S.margin : sm);
  const near = t => depMin == null || cdiff(minOfDay(t.start), depMin) <= 75;
  const vacNow = !!vacOf(Date.now()), same = t => isVac(t) === vacNow, P = ", " + periodLbl(vacNow);
  const levels = [
    {f: t => same(t) && near(t) && (!route || t.route===route) && (!mode || t.mode===mode), lbl: `à cette heure-ci${route?", "+route.toLowerCase():""}${mode?", en "+mode.toLowerCase():""}${P}`, p:1},
    {f: t => same(t) && near(t) && (!route || t.route===route), lbl: `à cette heure-ci${route?", "+route.toLowerCase():""}${P}`, p:1},
    {f: t => same(t) && near(t), lbl: `à cette heure-ci${P}`, p:1},
    {f: t => near(t) && (!route || t.route===route), lbl: `à cette heure-ci${route?", "+route.toLowerCase():""}`},
    {f: near, lbl: "à cette heure-ci"},
    {f: () => true, lbl: "tous horaires confondus"},
  ];
  for (const L of levels) {
    const set = all.filter(L.f);
    if (set.length >= 3) {
      const ds = set.map(drive);
      const wj = set.filter(t => (t.jams||[]).length);
      const jamAvg = wj.length ? avg(wj.map(t => t.jams.reduce((a,j)=>a+(j.end-j.start),0))) : 0;
      return {ms: pct(ds,.8), n: set.length, set, depMin, periodMatch: !!L.p, src: `d'après tes ${set.length} trajets ${L.lbl}`, jamRate: wj.length/set.length, jamAvg};
    }
  }
  if (rm && all.length < 3) return {ms: rm, n: all.length, set: [], depMin, jamRate: 0, jamAvg: 0,
    src: `selon ton trajet de référence « ${chosenOpt(d).nom} »${curRef(d).source === "osm" ? " (OpenStreetMap)" : " vérifié sur Internet"}, hors embouteillages (${all.length ? "encore " + (3-all.length) + " trajet(s) à chronométrer" : "chronomètre tes trajets pour l'affiner"})`};
  return {ms: base, n: all.length, set: [], depMin, src: all.length ? `estimation de départ, encore ${3-all.length} trajet(s) à chronométrer` : "estimation de départ, chronomètre 3 trajets pour l'affiner", jamRate: 0, jamAvg: 0};
}

function routeTip(d){
  if (d !== "aller" && d !== "retour") return "";
  const r = ROUTES.map(k => ({k, e: expected(d, {route: k})})).filter(x => x.e.set.length >= 3 && x.e.set.every(t=>t.route===x.k));
  if (r.length < 2) return "";
  r.sort((a,b)=>a.e.ms-b.e.ms);
  const gain = Math.round((r[1].e.ms - r[0].e.ms)/60000);
  return gain >= 5 ? ` ${r[0].k} est en général plus rapide de ${gain} min à cette heure.` : "";
}

// Règle de départ de la maison : avant l'arrivée de la première barge (5 h 30),
// 1 h avant pendant les vacances scolaires, 2 h 30 avant le reste de l'année.
const BARGE1 = [5, 30], AVANCE_VAC = 60, AVANCE_SCOL = 150;
function departRegle(){
  const now = new Date(), b = new Date(now); b.setHours(BARGE1[0], BARGE1[1], 0, 0);
  if (now > b) b.setDate(b.getDate() + 1);
  const vac = !!vacOf(+b), avance = vac ? AVANCE_VAC : AVANCE_SCOL;
  return {vac, avance, barge: b, depart: new Date(+b - avance*60000)};
}
function renderPlan(){
  const t = svc(dir);
  $("lA").classList.toggle("on", dir==="aller"); $("lR").classList.toggle("on", dir==="retour");
  renderVeille();
  $("advice").hidden = !advice; $("advice").textContent = advice;
  if (!t) { $("leaveAt").textContent = "--:--";
    $("why").textContent = dir==="aller" ? "Renseigne ton heure de début de service en haut pour savoir à quelle heure partir." : "Renseigne ton heure de fin de service en haut pour connaître ton heure d'arrivée à la maison."; return; }
  const e = expected(dir), chL = chosenOpt(dir), lv = chL ? liveMin(chL, dir) : 0, x = extraFromVeille() + lv;
  const [h,m] = t.split(":").map(Number);
  const target = new Date(); target.setHours(h,m,0,0);
  const vNow = vacOf(Date.now());
  const vacNote = vNow && !e.periodMatch && e.set.length ? " Vacances scolaires en cours : les routes sont en général moins chargées, ce calcul fondé sur des trajets en période scolaire est donc plutôt prudent." : "";
  const jam = e.jamRate >= .34 ? ` Embouteillage ${Math.round(e.jamRate*100)} % du temps sur ces trajets (${fmtDur(e.jamAvg)} perdues en moyenne), déjà compté.` : "";
  const al = x ? ` + ${x} min à cause des infos route du jour${lv ? " et des signalements en cours sur ton itinéraire" : ""}.` : "";
  if (dir === "aller") {
    // Le départ se cale sur la barge : la dernière qui te dépose à l'heure, puis le temps habituel pour l'attraper
    const vac = !!vacOf(+target), P = planAller(h*60+m, vac);
    const dep = new Date(target); dep.setHours(0, P.barge.m - P.avant - x, 0, 0);
    $("leaveAt").textContent = hhmm(dep);
    const evts = x ? `, plus ${x} min à cause ${lv && x - lv ? "des infos route du jour et des signalements en cours sur ton itinéraire" : lv ? "des signalements en cours sur ton itinéraire" : "des infos route du jour"}` : "";
    $("why").textContent = (P.trop ? `Aucune barge ne te dépose à l'heure pour ton service à ${t} : la première part à 5 h 30. Pars pour celle-là. ` : `Pour ton service à ${t} : ${P.barge.type.toLowerCase()} de ${hm(P.barge.m)}, la dernière qui te dépose à l'heure (${P.apres} min de la barge au travail${P.nApres >= 3 ? " d'après tes trajets" : ""}, ${S.margin} min de marge). `)
      + `Départ ${dureeMin(P.avant)} avant la barge${P.appris ? `, d'après tes ${P.nAvant} trajets en ${vac ? "vacances" : "période scolaire"}` : (vac ? " (vacances scolaires)" : `, dont ${S.plusScolaire} min de plus en période scolaire`)}${evts}.`
      + (P.appris ? "" : " Ces durées se règlent dans « Mes données » et s'ajustent toutes seules après 3 trajets chronométrés.");
  } else {
    $("leaveAt").textContent = hhmm(new Date(+target + e.ms + x*60000));
    $("why").textContent = `Si tu finis ton service à ${lab(t)} : ${fmtDur(e.ms)} de trajet ${e.src}${al || "."}${jam}${routeTip(dir)}${vacNote}`;
  }
}

function renderRoute(){
  const st = curSteps(), ol = $("route"); ol.innerHTML = "";
  const stamps = active && active.dir === dir ? active.stamps : [];
  st.forEach((name,i) => {
    const li = document.createElement("li");
    if (i < stamps.length) li.className = "done"; else if (i === stamps.length && active) li.className = "cur";
    const dot = document.createElement("span"); dot.className="dot"; dot.textContent = i < stamps.length ? "✓" : i+1;
    const nm = document.createElement("span"); nm.className="name"; nm.textContent = name;
    let hint = HINTS_DIR[dir]?.[name] || HINTS[name];
    const bq = active?.barge || active?.bargePick;
    if (/arrivée barge dzaoudzi/i.test(name)) hint = bq ? `${bq} · ${QUAI[bq]}` : QUAIS_DZA;
    if (/arrivée barge mamoudzou/i.test(name)) hint = "Même quai pour l'amphidrome et la barge normale";
    if (dir === "retour" && /^descente du taxi/i.test(name)) hint = bq ? `Au ${QUAI[bq]} (${bq.toLowerCase()})` : QUAIS_DZA;
    if (dir === "aller" && isTaxiUp(name) && bq && !(i > 0 && i < stamps.length)) hint = `Au ${QUAI[bq]}, vers le travail`;
    if (isTaxiUp(name) && i > 0 && i < stamps.length) hint = `${fmtDur(stamps[i]-stamps[i-1])} d'attente du taxi` + (dir === "aller" && bq ? ` au ${QUAI[bq]}` : "");
    if (dir==="aller" && i===0 && i < stamps.length && active?.mode) hint = [active.mode, active.route?.toLowerCase()].filter(Boolean).join(" · ");
    if (isRoute(name) && i < stamps.length && active?.route) hint = [isHome(name) ? active.mode : null, active.route.toLowerCase()].filter(Boolean).join(" · ");
    if (isBarge(name)) { hint = i < stamps.length && active?.barge ? active.barge : (active?.bargePick || "Amphidrome ou barge normale");
      if (dir === "retour" && bq) hint += ` · ${QUAI[bq]}`;
      if (i > 0 && i < stamps.length) hint += ` · ${fmtDur(stamps[i]-stamps[i-1])} d'attente au quai`; }
    if (i===st.length-1 && dir==="aller") hint = ((active?.service || svc("aller")) ? `Début de service à ${active?.service || svc("aller")}` + (i<stamps.length && active.service ? ` · ${gap(stamps[i]-atTime(stamps[0], active.service))}` : "") : "Début de service non renseigné");
    if (i===0 && dir==="retour") hint = ((active?.service || svc("retour")) ? `Fin de service à ${lab(active?.service || svc("retour"))}` : "Fin de service non renseignée");
    if (hint) { const h=document.createElement("span"); h.className="hint"; h.textContent=hint; nm.append(h); }
    const t = document.createElement("span"); t.className="t";
    if (i < stamps.length) {
      const tt = document.createElement("span"); tt.textContent = hhmm(new Date(stamps[i]));
      if (i > 0) { const dd = document.createElement("small"); dd.textContent = "+" + fmtDur(stamps[i]-stamps[i-1]); tt.append(dd); }
      const ed = btn("✎", "edit"); ed.setAttribute("aria-label", `Corriger l'heure : ${name}`); ed.title = "Corriger l'heure";
      ed.onclick = () => { manualIdx = i; manualPick = null; renderActions(); $("actions").scrollIntoView({behavior: "smooth", block: "center"}); };
      t.append(tt, ed);
    }
    li.append(dot,nm,t); ol.append(li);
  });
  renderJams();
  renderStops();
  renderActions();
}

function renderActions(){
  const box = $("actions"); box.innerHTML = "";
  const st = curSteps();
  if (active && active.dir !== dir) {
    box.innerHTML = `<p class="empty">Un trajet « ${active.dir} » est en cours. Repasse sur cet onglet pour le continuer.</p>`; return;
  }
  if (active && manualIdx != null && manualIdx < active.steps.length && manualIdx <= active.stamps.length) { renderManual(box); return; }
  if (!active) {
    // Rappel : les boutons d'arrêt, d'embouteillage et d'évènement s'activent une fois le départ lancé
    const tip = () => { const w = document.createElement("div");
      const sb = btn("Je m'arrête (course, pause…)", "btn stopbtn"); sb.style.opacity = ".55"; sb.setAttribute("aria-disabled", "true");
      const p = document.createElement("p"); p.className = "empty"; p.style.margin = "8px 0 0";
      p.textContent = "Arrêts, embouteillages et évènements se notent pendant le trajet : ces boutons s'activent dès que tu as lancé le départ. Le temps d'arrêt n'est pas compté dans ton temps de route.";
      sb.onclick = () => { status("Lance d'abord le trajet : le bouton « Je m'arrête » s'active juste après."); p.style.color = "var(--ambre)"; };
      w.append(sb, p); return w; };
    if (dir==="retour") { const b = btn("Je sors du travail", "btn"); b.onclick = () => start(); box.append(b); lateBox(box, null); box.append(tip()); return; }
    const q2 = document.createElement("p"); q2.className="empty"; q2.style.margin="0 0 10px"; q2.textContent = "Je pars de la maison en :"; box.append(q2);
    // Le moyen se choisit sans rien lancer (dernier choix déjà coché) ; seul le grand bouton démarre le chrono
    const saved = modeMem.A ?? ls.get("trajet.modeA"), cur = MODES.includes(saved) ? saved : null;
    const r0 = document.createElement("div"); r0.className="row bpick"; r0.style.marginTop="0"; r0.setAttribute("role","radiogroup"); r0.setAttribute("aria-label","Moyen de transport");
    MODES.forEach(k => { const b = btn(k, "btn ghost pick"); b.setAttribute("role","radio"); b.setAttribute("aria-checked", cur === k); b.onclick = () => { modeMem.A = k; ls.set("trajet.modeA", k); renderActions(); }; r0.append(b); });
    const go = btn(cur ? `Je pars · ${cur}` : "Choisis d'abord ton moyen", "btn"); go.id = "goBtn"; go.style.marginTop = "10px";
    go.disabled = !cur; if (!cur) go.style.opacity = ".45"; go.onclick = () => start(cur);
    box.append(r0, go); lateBox(box, cur); box.append(tip()); return;
  }
  const n = active.stamps.length;
  if (n < st.length && openStop()) {
    const o = openStop();
    const p = document.createElement("p"); p.className = "stopnow";
    p.textContent = `À l'arrêt depuis ${hhmm(new Date(o.start))}${o.motif ? " · " + o.motif : ""}. Le chrono du trajet continue, mais cet arrêt ne comptera pas dans ton temps de route.`;
    const b = btn("Je reprends la route", "btn"); b.onclick = toggleStop;
    const c = abandonBtn("Abandonner le trajet"); c.style.marginTop = "10px";
    box.append(p, b, c); return;
  }
  if (n < st.length) {
    if (isBarge(st[n])) {
      // 1) choisir la barge (ne lance rien), 2) appuyer sur « Départ » quand elle part
      const q = document.createElement("p"); q.className="empty"; q.style.margin="0 0 10px"; q.textContent = active.bargePick ? "Barge choisie. Appuie sur « Départ » quand elle part." : "Quelle barge prends-tu ? (le chrono ne se lance pas encore)"; box.append(q);
      { const w = document.createElement("p"); w.className = "stopnow"; w.id = "waitLive"; w.dataset.since = active.stamps.at(-1); w.textContent = waitTxt(active.stamps.at(-1)); box.insertBefore(w, q); }
      const r0 = document.createElement("div"); r0.className="row bpick"; r0.style.marginTop="0"; r0.setAttribute("role","radiogroup"); r0.setAttribute("aria-label","Type de barge");
      BARGES.forEach(k => { const b = btn(dir === "retour" ? `${k} · ${QUAI[k]}` : k, "btn ghost pick"); b.setAttribute("role","radio"); b.setAttribute("aria-checked", active.bargePick === k);
        b.onclick = () => { active.bargePick = k; persistActive(); renderActions(); }; r0.append(b); });
      box.append(r0);
      const go = btn(active.bargePick ? `Départ · ${active.bargePick === "Amphidrome" ? "l'amphidrome" : "la barge normale"}` : "Départ de la barge", "btn"); go.style.marginTop = "10px";
      go.disabled = !active.bargePick; if (go.disabled) go.style.opacity = ".45";
      go.onclick = () => { const k = active.bargePick; delete active.bargePick; stamp(k); }; box.append(go);
    } else if (isRoute(st[n])) {
      if (isHome(st[n])) {
        const q2 = document.createElement("p"); q2.className="empty"; q2.style.margin="0 0 10px"; q2.textContent = "Comment rentres-tu à la maison ?"; box.append(q2);
        const r0 = document.createElement("div"); r0.className="row"; r0.style.marginTop="0";
        MODES.forEach(k => { const b = btn(k, "btn"); b.onclick = () => stamp(null, k); r0.append(b); });
        box.append(r0);
      } else {
        const b = btn(`Je passe · ${st[n]}`, "btn"); b.onclick = () => stamp(); box.append(b);
      }
    } else {
      // Retour : la barge (et donc le quai Ballou ou Issoufali) se choisit à la descente du taxi
      if (dir === "retour" && /^descente du taxi/i.test(st[n])) {
        const q = document.createElement("p"); q.className="empty"; q.style.margin="0 0 10px"; q.textContent = "Quelle barge vas-tu prendre ? Le taxi te dépose à son quai."; box.append(q);
        const r0 = document.createElement("div"); r0.className="row bpick"; r0.style.margin="0 0 10px"; r0.setAttribute("role","radiogroup"); r0.setAttribute("aria-label","Type de barge");
        BARGES.forEach(k => { const c = btn(`${k} · ${QUAI[k]}`, "btn ghost pick"); c.setAttribute("role","radio"); c.setAttribute("aria-checked", active.bargePick === k);
          c.onclick = () => { active.bargePick = k; persistActive(); renderRoute(); }; r0.append(c); });
        box.append(r0);
      }
      if (isTaxiUp(st[n]) && n > 0) { const w = document.createElement("p"); w.className = "stopnow"; w.id = "waitLive"; w.dataset.kind = "taxi"; w.dataset.since = active.stamps.at(-1); w.textContent = taxiTxt(active.stamps.at(-1)); box.append(w); }
      const b = btn(st[n], "btn"); b.onclick = () => stamp(); box.append(b);
    }
    const mb = btn("Pas pu appuyer ? Saisir l'heure à la main", "btn ghost"); mb.style.marginTop = "10px";
    mb.onclick = () => { manualIdx = n; manualPick = null; renderActions(); }; box.append(mb);
    renderStopButton(box);
    const open = openJam();
    const jb = btn(open ? "Fin de l'embouteillage" : "Début d'embouteillage", "btn jam" + (open ? " on" : ""));
    jb.onclick = toggleJam; box.append(jb); renderEventButton(box);
    if (!open && sigCol) { const sh = document.createElement("p"); sh.className = "empty"; sh.style.margin = "6px 0 0"; sh.style.fontSize = ".82rem";
      sh.textContent = S.shareJams !== false ? "L'embouteillage sera aussi signalé aux autres utilisateurs (réglable dans « Mes données »)." : "Embouteillage noté pour toi seul (partage coupé dans « Mes données »)."; box.append(sh); }
    const sb = btn("Prévenir les autres utilisateurs (avec le lieu)", "btn ghost"); sb.style.marginTop = "10px";
    sb.onclick = () => { $("sigForm").open = true; $("signal").scrollIntoView({behavior: "smooth", block: "start"}); }; box.append(sb);
    const r = document.createElement("div"); r.className="row";
    const u = btn("Annuler la dernière étape","btn ghost"); u.onclick = undo;
    const c = abandonBtn("Abandonner");
    r.append(u,c); box.append(r);
  } else {
    const p = document.createElement("p"); p.className="empty"; p.textContent = "Quelque chose a ralenti le trajet ?"; box.append(p);
    const ch = document.createElement("div"); ch.className="chips";
    TAGS.forEach(t => { const c = btn(t,"chip"); c.setAttribute("aria-pressed", tags.has(t)); c.onclick=()=>{tags.has(t)?tags.delete(t):tags.add(t); renderActions();}; ch.append(c); });
    const ta = document.createElement("textarea"); ta.id="note"; ta.placeholder="Note (facultatif) : barge ratée de peu, déviation…"; ta.value=note; ta.oninput=e=>note=e.target.value;
    const s = btn(active.editId ? "Enregistrer la correction" : "Enregistrer le trajet","btn"); s.style.marginTop="12px"; s.onclick = finish;
    if (active.editId) { const k = btn("Annuler la correction","btn ghost"); k.style.marginTop="10px"; k.onclick = () => { active = null; tags = new Set(); note = ""; persistActive(); renderAll(); status("Correction annulée."); }; box.append(ch, ta, s, k); return; }
    const u = btn("Annuler la dernière étape","btn ghost"); u.style.marginTop="10px"; u.onclick = undo;
    box.append(ch, ta, s, u);
  }
}
const btn = (t,c) => { const b=document.createElement("button"); b.className=c; b.textContent=t; b.type="button"; return b; };
// Abandon en deux appuis : le premier demande confirmation pendant 6 secondes
function abandonBtn(label){
  const c = btn(abandonAsk ? "Confirmer : trajet perdu" : label, "btn ghost");
  if (abandonAsk) { c.style.color = "var(--rouge)"; c.style.borderColor = "var(--rouge)"; }
  c.onclick = () => {
    if (!abandonAsk) { abandonAsk = true; renderActions(); setTimeout(() => { if (abandonAsk) { abandonAsk = false; renderActions(); } }, 6000); return; }
    abandonAsk = false; const j = active && openJam(); if (j?.sigId) endSig(j.sigId, true);
    active = null; persistActive(); stopTick(); stopTracking(); renderAll(); status("Trajet abandonné.");
  };
  return c;
}

// Saisie manuelle d'une heure (étape oubliée) ou correction d'une heure déjà notée
function manualTs(v, i){
  const [h, m] = (v || "").split(":").map(Number); if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const ref = i > 0 ? active.stamps[i-1] : (active.stamps[0] ?? Date.now());
  let best = null;
  for (const dd of [-1, 0, 1]) { const d = new Date(ref); d.setDate(d.getDate()+dd); d.setHours(h, m, 0, 0);
    if (best == null || Math.abs(+d - ref) < Math.abs(best - ref)) best = +d; }
  return best;
}
function renderManual(box){
  const i = manualIdx, st = active.steps, isNew = i >= active.stamps.length, name = st[i];
  const p = document.createElement("p"); p.className = "stopnow";
  p.textContent = isNew ? `À quelle heure : « ${name} » ?` : `Corriger l'heure : « ${name} »`;
  box.append(p);
  const lb = document.createElement("label"); lb.className = "mlab"; lb.textContent = "Heure";
  const inp = document.createElement("input"); inp.type = "time"; inp.id = "mTime";
  inp.value = hhmm(new Date(isNew ? Date.now() : active.stamps[i])); lb.append(inp); box.append(lb);
  const pickFrom = isNew && isBarge(name) ? BARGES : (isNew && dir === "retour" && isHome(name) ? MODES : null);
  if (pickFrom) {
    manualPick ||= (isBarge(name) ? (active.bargePick || active.barge) : active.mode) || pickFrom[0];
    const q = document.createElement("p"); q.className = "empty"; q.style.margin = "12px 0 0"; q.textContent = isBarge(name) ? "Quelle barge ?" : "Comment rentres-tu ?"; box.append(q);
    const ch = document.createElement("div"); ch.className = "chips"; ch.style.margin = "8px 0 0";
    pickFrom.forEach(k => { const c = btn(k, "chip"); c.setAttribute("aria-pressed", manualPick === k);
      c.onclick = () => { const v = $("mTime").value; manualPick = k; renderActions(); $("mTime").value = v; }; ch.append(c); });
    box.append(ch);
  }
  const err = document.createElement("p"); err.className = "empty"; err.style.color = "var(--rouge)"; err.hidden = true; box.append(err);
  const ok = btn("Enregistrer cette heure", "btn"); ok.style.marginTop = "12px";
  ok.onclick = () => {
    let ts = manualTs(inp.value, i); const prev = active.stamps[i-1], next = isNew ? null : active.stamps[i+1];
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (ts == null) return fail("Indique une heure.");
    // Même minute que l'étape voisine : on cale sur elle plutôt que de refuser
    if (prev != null && ts < prev && prev - ts < 60000) ts = prev;
    if (next != null && ts > next && ts - next < 60000) ts = next;
    if (ts > Date.now() && ts - Date.now() < 60000) ts = Date.now();
    if (prev != null && ts < prev) return fail(`L'heure doit être après ${hhmm(new Date(prev))} (« ${st[i-1]} »).`);
    if (next != null && ts > next) return fail(`L'heure doit être avant ${hhmm(new Date(next))} (« ${st[i+1]} »).`);
    if (ts > Date.now() + 60000) return fail("Cette heure n'est pas encore passée.");
    const pick = manualPick; manualIdx = null; manualPick = null;
    if (isNew) { if (pickFrom && isBarge(name)) { delete active.bargePick; stamp(pick, null, null, ts); } else if (pickFrom) stamp(null, pick, null, ts); else stamp(null, null, null, ts); }
    else { active.stamps[i] = ts; persistActive(); renderAll(); }
    status(`Heure enregistrée : ${name} à ${hhmm(new Date(ts))}.`);
  };
  const c = btn("Annuler", "btn ghost"); c.style.marginTop = "10px"; c.onclick = () => { manualIdx = null; manualPick = null; renderActions(); };
  box.append(ok, c);
}
function start(mode, route){
  manualIdx = null; manualPick = null;
  let st = steps(dir);
  const o0 = chosenOpt(dir), L0 = refOf(dir), prevu = Math.round(expected(dir).ms);
  active = {dir, stamps:[Date.now()], steps: st, service: svc(dir) || null, vac: !!vacOf(Date.now()), prevu, itin: o0?.nom || null, dep: L0?.depart || null, arr: L0?.arrivee || null};
  if (mode) active.mode = mode; if (route) active.route = route;
  if (dir==="aller" && mode) ls.set("trajet.modeA", mode); tags=new Set(); note=""; active.track = []; persistActive(); startTick(); startTracking(); renderAll(); }
const openJam = () => active?.jams?.find(j => !j.end);
const openStop = () => active?.stops?.find(x => !x.end);
let stopPick = false;
function renderStopButton(box){
  if (!stopPick) { const b = btn("Je m'arrête (course, pause…)", "btn stopbtn"); b.onclick = () => { stopPick = true; renderActions(); }; box.append(b); return; }
  const q = document.createElement("p"); q.className = "empty"; q.style.margin = "12px 0 8px"; q.textContent = "Pourquoi t'arrêtes-tu ?"; box.append(q);
  const ch = document.createElement("div"); ch.className = "chips"; ch.style.margin = "0";
  STOP_MOTIFS.forEach(m => { const c = btn(m, "chip"); c.onclick = () => { stopPick = false; toggleStop(m); }; ch.append(c); });
  const x = btn("Annuler", "chip"); x.onclick = () => { stopPick = false; renderActions(); }; ch.append(x);
  box.append(ch);
}
function renderEventButton(box){
  const evs = active.events || [];
  if (evs.length) { const l = document.createElement("div"); l.className = "chips"; l.style.margin = "10px 0 0"; l.setAttribute("aria-label", "Évènements notés sur ce trajet");
    evs.forEach((e, k) => { const c = btn(`${e.type} · ${hhmm(new Date(e.at))} ✕`, "chip"); c.setAttribute("aria-pressed", "true"); c.setAttribute("aria-label", `Retirer : ${e.type} à ${hhmm(new Date(e.at))}`);
      c.onclick = () => { active.events.splice(k, 1); persistActive(); renderActions(); }; l.append(c); });
    box.append(l); }
  if (!evPick) { const b = btn("Noter un évènement (accident, route bloquée…)", "btn stopbtn"); b.style.color = "var(--ambre)"; b.style.borderColor = "var(--ambre)"; b.onclick = () => { evPick = true; renderActions(); }; box.append(b); return; }
  const q = document.createElement("p"); q.className = "empty"; q.style.margin = "12px 0 8px"; q.textContent = "Que rencontres-tu ? (noté avec l'heure dans ce trajet)"; box.append(q);
  const ch = document.createElement("div"); ch.className = "chips"; ch.style.margin = "0";
  EV_TYPES.forEach(t => { const c = btn(t, "chip"); c.onclick = () => { evPick = false; (active.events ||= []).push({type: t, at: Date.now(), after: active.steps[active.stamps.length-1], before: active.steps[active.stamps.length], pos: myPos ? {lat: myPos.lat, lng: myPos.lng} : null});
    persistActive(); renderActions(); status(`« ${t} » noté dans ton trajet à ${hhmm(new Date())}.`); }; ch.append(c); });
  const x = btn("Annuler", "chip"); x.onclick = () => { evPick = false; renderActions(); }; ch.append(x);
  box.append(ch);
}
// Trajet déjà commencé sans avoir appuyé : on saisit l'heure de départ, puis chaque étape avec « Saisir l'heure à la main »
function lateBox(box, mode){
  if (!lateStart) { const b = btn("Déjà parti ? Saisir l'heure de départ à la main", "btn ghost"); b.style.marginTop = "10px"; b.onclick = () => { lateStart = true; renderActions(); }; box.append(b); return; }
  const lb = document.createElement("label"); lb.className = "mlab"; lb.style.marginTop = "12px"; lb.textContent = "Heure de départ";
  const inp = document.createElement("input"); inp.type = "time"; inp.id = "lTime"; inp.value = hhmm(new Date()); lb.append(inp); box.append(lb);
  const err = document.createElement("p"); err.className = "empty"; err.style.color = "var(--rouge)"; err.hidden = true;
  const ok = btn("Démarrer le trajet à cette heure", "btn"); ok.style.marginTop = "12px";
  ok.onclick = () => {
    const [h, m] = (inp.value || "").split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) { err.textContent = "Indique une heure."; err.hidden = false; return; }
    if (dir === "aller" && !mode) { err.textContent = "Choisis d'abord ton moyen de transport, au-dessus."; err.hidden = false; return; }
    const d = new Date(); d.setHours(h, m, 0, 0); if (+d > Date.now() + 60000) d.setDate(d.getDate() - 1); // une heure pas encore passée aujourd'hui = hier
    lateStart = false; start(mode || undefined); active.stamps[0] = +d; active.vac = !!vacOf(+d); persistActive(); renderAll();
    status(`Trajet démarré à ${hhmm(d)}. Pour chaque étape déjà passée, touche « Pas pu appuyer ? Saisir l'heure à la main ».`);
  };
  const c = btn("Annuler", "btn ghost"); c.style.marginTop = "10px"; c.onclick = () => { lateStart = false; renderActions(); };
  box.append(err, ok, c);
}
function toggleStop(motif){
  active.stops ||= [];
  const o = openStop();
  if (o) o.end = Date.now();
  else {
    const j = openJam(); if (j) { j.end = Date.now(); if (j.sigId) endSig(j.sigId, true); }
    active.stops.push({start: Date.now(), end: null, motif: typeof motif === "string" ? motif : "", after: active.steps[active.stamps.length-1], before: active.steps[active.stamps.length]});
  }
  persistActive(); renderAll();
}
function renderStops(){
  const box = $("stops"); box.innerHTML = "";
  const list = active && active.dir === dir ? (active.stops || []) : [];
  box.hidden = !list.length; if (!list.length) return;
  const tot = list.reduce((a,x)=>a+((x.end||Date.now())-x.start),0);
  const h = document.createElement("b"); h.textContent = `Arrêts · ${fmtDur(tot)}`; box.append(h);
  list.forEach(x => { const d = document.createElement("div"); d.className = "j";
    const a = document.createElement("span"); a.textContent = `${hhmm(new Date(x.start))} → ${x.end ? hhmm(new Date(x.end)) : "en cours"}${x.motif ? " · " + x.motif : ""} ${jamSpot(x)}`;
    const b = document.createElement("span"); b.textContent = x.end ? fmtDur(x.end-x.start) : fmtClock(Date.now()-x.start);
    d.append(a,b); box.append(d); });
}
function toggleJam(){
  active.jams ||= [];
  const o = openJam();
  if (o) { o.end = Date.now(); if (o.sigId) endSig(o.sigId, true); }
  else { const j = {start: Date.now(), end: null, after: active.steps[active.stamps.length-1], before: active.steps[active.stamps.length]};
    if (S.shareJams !== false) sendSig("Embouteillage", `Entre « ${j.after} » et « ${j.before} »`, active.dir==="aller" ? "vers le travail" : "vers la maison").then(id => { if (id) { j.sigId = id; persistActive(); } });
    active.jams.push(j); }
  persistActive(); renderAll();
}
function jamSpot(j){ return j.after && j.before ? `entre « ${j.after} » et « ${j.before} »` : ""; }
function renderJams(){
  const box = $("jams"); box.innerHTML = "";
  const list = active && active.dir === dir ? (active.jams || []) : [];
  box.hidden = !list.length; if (!list.length) return;
  const tot = list.reduce((a,j)=>a+((j.end||Date.now())-j.start),0);
  const h = document.createElement("b"); h.textContent = `Embouteillages · ${fmtDur(tot)}`; box.append(h);
  list.forEach(j => { const d = document.createElement("div"); d.className = "j";
    const a = document.createElement("span"); a.textContent = `${hhmm(new Date(j.start))} → ${j.end ? hhmm(new Date(j.end)) : "en cours"} ${jamSpot(j)}`;
    const b = document.createElement("span"); b.textContent = j.end ? fmtDur(j.end-j.start) : fmtClock(Date.now()-j.start);
    d.append(a,b); box.append(d); });
}
function stamp(barge, mode, route, ts){ abandonAsk = false; if (barge) active.barge = barge; if (mode) active.mode = mode; if (route) active.route = route; const at = ts ?? Date.now(); active.stamps.push(at);
  { const s0 = openStop(); if (s0) s0.end = Math.max(s0.start, at); }
  if (active.stamps.length === active.steps.length) { const o = openJam(); if (o) o.end = Math.max(o.start, at); } persistActive(); if (active.stamps.length===active.steps.length) stopTick(); renderAll(); }
function undo(){ manualIdx = null; if (active.stamps.length<=1){ active=null; stopTick(); stopTracking(); } else { active.stamps.pop(); if (!active.stamps.some((_,k)=>isBarge(active.steps[k]))) delete active.barge; if (active.dir==="retour" && !active.stamps.some((_,k)=>isHome(active.steps[k]))) { delete active.mode; delete active.route; } startTick(); } persistActive(); renderAll(); }
async function finish(){
  const t = {dir: active.dir, start: active.stamps[0], end: active.stamps.at(-1), stamps: active.stamps, steps: active.steps, service: active.service || null, vac: !!active.vac, prevu: active.prevu || null, itin: active.itin || null, dep: active.dep || null, arr: active.arr || null, barge: active.barge || null, mode: active.mode || null, route: active.route || null, jams: (active.jams||[]).map(j=>({...j, end: j.end || active.stamps.at(-1)})), events: (active.events||[]).map(e=>({...e})), km: active.gpsM ? +(active.gpsM/1000).toFixed(1) : (active.km ?? null), vmax: active.vmax || null, stops: (active.stops||[]).map(x=>({...x, end: x.end || active.stamps.at(-1)})), track: (active.track||[]).slice(-400), tags:[...tags], note: note.trim()};
  const id = "t" + t.start, old = active.editId;
  trips = trips.filter(x=>x.id!==id && x.id!==old).concat({...t,id});
  active = null; persistActive(); stopTick(); stopTracking(); renderAll();
  await saveTrip(id, t);
  // Correction : si l'heure de départ a changé, l'ancienne fiche est retirée une fois la nouvelle enregistrée
  if (old && old !== id) { if (tripsCol) { try { await tripsCol.doc(old).delete(); } catch(e) {} } else ls.set("trajet.trips", trips); }
}
function editTrip(t){
  if (active) { status("Termine ou abandonne d'abord le trajet en cours."); return; }
  active = {dir: t.dir, stamps: [...t.stamps], steps: [...t.steps], service: t.service || null, vac: isVac(t), prevu: t.prevu || null, itin: t.itin || null, dep: t.dep || null, arr: t.arr || null,
    jams: (t.jams||[]).map(j => ({...j})), stops: (t.stops||[]).map(x => ({...x})), events: (t.events||[]).map(e => ({...e})), km: t.km ?? null, vmax: t.vmax ?? null, editId: t.id};
  if (t.barge) active.barge = t.barge; if (t.mode) active.mode = t.mode; if (t.route) active.route = t.route;
  if (t.track) active.track = t.track;
  tags = new Set(t.tags || []); note = t.note || ""; manualIdx = null; persistActive(); setDir(t.dir);
  status("Corrige les heures avec ✎ puis enregistre."); $("hRoute").scrollIntoView({behavior: "smooth", block: "start"});
}
function persistActive(){ ls.set("trajet.active", active); }

function startTick(){ stopTick(); updClock(); tick = setInterval(updClock, 1000);
  keepAwake(); }
function stopTick(){ clearInterval(tick); tick=null; updClock(); }
// Écran toujours allumé tant que l'appli est ouverte, pour suivre sa position sur la carte.
// Sur iPhone, l'appli native désactive aussi la mise en veille automatique (AppDelegate).
function keepAwake(){ if (document.hidden || wake) return;
  try { navigator.wakeLock?.request("screen").then(w => { wake = w; w.addEventListener?.("release", () => { wake = null; }); }).catch(() => {}); } catch(e) {} }
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepAwake(); });
["click", "touchend"].forEach(t => document.addEventListener(t, keepAwake, {passive: true}));
keepAwake();
function updClock(){
  if (!active || active.dir!==dir) { $("clock").textContent = "0:00"; $("vs").textContent = ""; return; }
  const end = active.stamps.length===active.steps.length ? active.stamps.at(-1) : Date.now();
  const el = end - active.stamps[0]; $("clock").textContent = fmtClock(el);
  { const wl = $("waitLive"); if (wl) wl.textContent = (wl.dataset.kind === "taxi" ? taxiTxt : waitTxt)(+wl.dataset.since); }
  if (openJam()) renderJams();
  if (openStop()) renderStops();
  const sm = stopMs(active, active.stamps[0], end);
  const e = expected(dir).ms, eta = new Date(active.stamps[0] + e + sm);
  $("vs").textContent = (active.gpsM ? `${fmtKm(active.gpsM)} · ` : "") + `arrivée prévue ${hhmm(eta)}` + (sm >= 60000 ? ` · dont ${fmtDur(sm)} d'arrêt` : "") + (dir==="aller" && active.service ? ` · service à ${active.service}` : "");
}

function renderStats(){
  const a = durs(dir);
  $("kN").textContent = tripsFor(dir).length;
  $("kAvg").textContent = a.length ? fmtDur(avg(a)) : "–";
  $("kP80").textContent = a.length >= 3 ? fmtDur(pct(a,.8)) : "–";
  const box = $("bars"); box.innerHTML = "";
  const st = steps(dir);
  const ok = tripsFor(dir).slice(0,30).filter(t => t.stamps.length === t.steps.length);
  const all = tripsFor(dir).slice(0,30);
  if (!all.length) { box.innerHTML = `<p class="empty">Le détail par tronçon apparaîtra ici après ton premier trajet chronométré. Tu verras alors combien de temps te coûte chaque tronçon.</p>`; return; }
  // Chaque tronçon est calculé sur les trajets qui l'ont (les anciens trajets avaient moins d'étapes)
  const segs = st.slice(1).map((n,i) => { const v = ok.map(t => { const a = t.steps.indexOf(st[i]), b = t.steps.indexOf(n);
      return a >= 0 && b === a+1 ? t.stamps[b]-t.stamps[a]-stopMs(t, t.stamps[a], t.stamps[b]) : null; }).filter(x => x != null);
    return v.length ? {label:`${st[i]} → ${n}`, ms: avg(v)} : null; }).filter(Boolean);
  const max = segs.length ? Math.max(...segs.map(s=>s.ms)) : 1;
  segs.forEach(s => {
    const r = document.createElement("div"); r.className = "bar" + (s.ms===max && segs.length>1 ? " slow":"");
    r.innerHTML = `<span class="lbl"></span><span class="track"><span class="fill" style="width:${Math.max(4,s.ms/max*100)}%"></span></span><span class="v">${fmtDur(s.ms)}</span>`;
    r.querySelector(".lbl").textContent = s.label; r.querySelector(".lbl").title = s.label; box.append(r);
  });
  const byB = {};
  ok.forEach(t => { if (!t.barge) return; const i = t.steps.findIndex(isBarge); if (i<0||!t.stamps[i+1]) return;
    (byB[t.barge] ||= []).push(t.stamps[i+1]-t.stamps[i]); });
  const bk = Object.keys(byB);
  if (bk.length) { const p=document.createElement("p"); p.className="empty";
    p.textContent = "Traversée moyenne : " + bk.map(k=>`${k} ${fmtDur(avg(byB[k]))} (${byB[k].length}×)`).join(" · ") + "."; box.append(p); }
  const ws = ok.map(t => ({t, w: quaiWait(t)})).filter(x => x.w != null);
  if (ws.length) { const byW = {}; ws.forEach(x => { if (x.t.barge) (byW[x.t.barge] ||= []).push(x.w); });
    const p=document.createElement("p"); p.className="empty";
    p.textContent = `Attente au quai avant la barge : ${fmtDur(avg(ws.map(x=>x.w)))} en moyenne, jusqu'à ${fmtDur(Math.max(...ws.map(x=>x.w)))} (${ws.length}×)` + (Object.keys(byW).length > 1 ? " · " + Object.keys(byW).map(k=>`${k} ${fmtDur(avg(byW[k]))}`).join(" · ") : "") + ". Comptée dans tes temps de trajet."; box.append(p); }
  const tw = ok.map(taxiWait).filter(x => x != null);
  if (tw.length) { const p=document.createElement("p"); p.className="empty";
    const byQ = {}; if (dir === "aller") ok.forEach(t => { const w = taxiWait(t); if (w != null && QUAI[t.barge]) (byQ[QUAI[t.barge]] ||= []).push(w); });
    p.textContent = `Attente du taxi ${dir === "aller" ? "à la sortie de la barge (Dzaoudzi)" : "à la sortie du travail"} : ${fmtDur(avg(tw))} en moyenne, jusqu'à ${fmtDur(Math.max(...tw))} (${tw.length}×)`
      + (Object.keys(byQ).length ? " · " + Object.keys(byQ).map(k => `${k} ${fmtDur(avg(byQ[k]))} (${byQ[k].length}×)`).join(" · ") : "") + ". Comptée dans tes temps de trajet."; box.append(p); }
  const byM = {};
  all.forEach(t => { if (!t.mode) return; const i = t.steps.findIndex(isHome); if (i<0) return;
    const k = t.mode + (t.route ? " " + t.route.replace("Par le ","par le ") : "");
    (byM[k] ||= []).push(t.end - t.stamps[i] - stopMs(t, t.stamps[i], t.end)); });
  const vs = all.filter(isVac), sc = all.filter(t => !isVac(t));
  if (vs.length && sc.length) { const p=document.createElement("p"); p.className="empty";
    p.textContent = `Période scolaire ${fmtDur(avg(sc.map(drive)))} (${sc.length}×) · vacances scolaires ${fmtDur(avg(vs.map(drive)))} (${vs.length}×).`; box.append(p); }
  const wk = all.filter(t => t.km);
  if (wk.length) { const p = document.createElement("p"); p.className = "empty"; const now = new Date();
    const mois = trips.filter(t => t.km && new Date(t.start).getMonth() === now.getMonth() && new Date(t.start).getFullYear() === now.getFullYear()).reduce((a, t) => a + t.km, 0);
    const tot = trips.filter(t => t.km).reduce((a, t) => a + t.km, 0);
    p.textContent = `Kilométrage (GPS) : ${fmtKm(avg(wk.map(t => t.km * 1000)))} en moyenne dans ce sens (${wk.length}×) · ${fmtKm(mois * 1000)} ce mois-ci · ${fmtKm(tot * 1000)} au total, aller et retour.`; box.append(p); }
  const pv = all.filter(t => t.prevu);
  if (pv.length) { const ec = Math.round(avg(pv.map(t => drive(t) - t.prevu))/60000), p = document.createElement("p"); p.className = "empty";
    p.textContent = `Prévisions : sur ${pv.length} trajet(s), le réel dépasse le prévu de ${ec} min en moyenne` + (ec < 0 ? " (tu arrives plus tôt que prévu)." : "."); box.append(p); }
  const byR = {}; all.forEach(t => { if (!t.route) return; const k = (t.dir==="aller" && t.mode ? t.mode + " " : "") + t.route.toLowerCase(); (byR[k] ||= []).push(drive(t)); });
  if (Object.keys(byR).length) { const p=document.createElement("p"); p.className="empty";
    p.textContent = "Trajet complet : " + Object.keys(byR).map(k=>`${k} ${fmtDur(avg(byR[k]))} (${byR[k].length}×)`).join(" · ") + "."; box.append(p); }
  const mk = Object.keys(byM);
  if (mk.length) { const p=document.createElement("p"); p.className="empty";
    p.textContent = "Mamoudzou → maison : " + mk.map(k=>`${k} ${fmtDur(avg(byM[k]))} (${byM[k].length}×)`).join(" · ") + "."; box.append(p); }
  const withJ = ok.filter(t => (t.jams||[]).length);
  if (withJ.length) { const tot = withJ.map(t => t.jams.reduce((a,j)=>a+(j.end-j.start),0));
    const spots = {}; withJ.forEach(t=>t.jams.forEach(j=>{ const k=jamSpot(j); if(k) spots[k]=(spots[k]||0)+1; }));
    const top = Object.entries(spots).sort((a,b)=>b[1]-a[1])[0];
    const p=document.createElement("p"); p.className="empty";
    p.textContent = `Embouteillages sur ${withJ.length} trajet(s) sur ${ok.length}, ${fmtDur(avg(tot))} perdues en moyenne` + (top ? `, surtout ${top[0]}.` : "."); box.append(p); }
  const tagCount = {}; ok.forEach(t=>{ (t.tags||[]).forEach(g=>tagCount[g]=(tagCount[g]||0)+1); [...new Set((t.events||[]).map(e=>e.type))].forEach(g=>tagCount[g]=(tagCount[g]||0)+1); });
  const top = Object.entries(tagCount).sort((a,b)=>b[1]-a[1])[0];
  if (top) { const p=document.createElement("p"); p.className="empty"; p.textContent=`Ralentissement le plus fréquent : ${top[0]} (${top[1]} fois).`; box.append(p); }
}

function renderHist(){
  const ul = $("hist"); ul.innerHTML = "";
  const list = tripsFor(dir).slice(0,20);
  if (!list.length) { ul.innerHTML = `<li><span class="d empty">Aucun trajet enregistré dans ce sens. Appuie sur le bouton de départ dès que tu te mets en route.</span></li>`; return; }
  list.forEach(t => {
    const li = document.createElement("li"); const d = new Date(t.start);
    const info = document.createElement("span"); info.className="d";
    let txt = d.toLocaleDateString("fr-FR",{weekday:"short",day:"numeric",month:"short"}) + " · départ " + hhmm(d);
    if (t.service && t.dir==="aller") txt += ` · service ${t.service}, ${gap(t.end - atTime(t.start,t.service))}`;
    if (t.service && t.dir==="retour") txt += ` · fin de service ${lab(t.service)}`;
    info.textContent = txt;
    const sm = document.createElement("small");
    if (t.barge) { const b=document.createElement("span"); b.className="tag barge"; b.textContent=t.barge; sm.append(b); }
    { const w = quaiWait(t); if (w != null) { const b=document.createElement("span"); b.className="tag"; b.textContent=`Attente quai ${fmtDur(w)}`; sm.append(b); } }
    { const w = taxiWait(t); if (w != null) { const b=document.createElement("span"); b.className="tag"; b.textContent=`Attente taxi ${fmtDur(w)}`; sm.append(b); } }
    (t.jams||[]).forEach(j => { const b=document.createElement("span"); b.className="tag jamt";
      b.textContent=`Embouteillage ${hhmm(new Date(j.start))}–${hhmm(new Date(j.end))} (${fmtDur(j.end-j.start)})`; b.title = jamSpot(j); sm.append(b); });
    (t.stops||[]).forEach(x => { const b=document.createElement("span"); b.className="tag stopt";
      b.textContent=`Arrêt${x.motif ? " " + x.motif.toLowerCase() : ""} ${hhmm(new Date(x.start))}–${hhmm(new Date(x.end))} (${fmtDur(x.end-x.start)})`; b.title = jamSpot(x); sm.append(b); });
    (t.events||[]).forEach(e => { const b=document.createElement("span"); b.className="tag jamt"; b.textContent=`${e.type} ${hhmm(new Date(e.at))}`; b.title = jamSpot(e); sm.append(b); });
    if (isVac(t)) { const b=document.createElement("span"); b.className="tag"; b.textContent="Vacances scolaires"; sm.append(b); }
    if (t.km) { const b=document.createElement("span"); b.className="tag barge"; b.textContent=fmtKm(t.km*1000); b.title = "Distance mesurée par le GPS"; sm.append(b);
      const b2=document.createElement("span"); b2.className="tag"; b2.textContent=`Moy. ${Math.round(t.km / (drive(t)/3600000))} km/h` + (t.vmax ? ` · max ${t.vmax} km/h` : ""); b2.title = "Vitesse moyenne sur le temps de route, barge et attentes comprises"; sm.append(b2); }
    if (t.prevu) { const b=document.createElement("span"); b.className="tag"; b.textContent=`Prévu ${fmtDur(t.prevu)}, ${gap(drive(t) - t.prevu)}`; sm.append(b); }
    if (t.itin) { const b=document.createElement("span"); b.className="tag barge"; b.textContent=t.itin; sm.append(b); }
    if (t.route) { const b=document.createElement("span"); b.className="tag barge"; b.textContent=t.route; sm.append(b); }
    if (t.mode) { const b=document.createElement("span"); b.className="tag barge"; b.textContent=t.mode; sm.append(b); }
    t.tags.forEach(g=>{const s=document.createElement("span");s.className="tag";s.textContent=g;sm.append(s);});
    t.steps.forEach((n,k)=>{ if(t.stamps[k] && (/taxi|bus/i.test(n) || isHome(n))) sm.append(document.createTextNode(`${isHome(n) ? (t.mode||"Départ") + " depuis Mamoudzou" : n.replace("Montée taxi","Taxi").replace("Montée bus","Bus")} ${hhmm(new Date(t.stamps[k]))} · `)); });
    if (t.note) sm.append(document.createTextNode(" " + t.note)); info.append(sm);
    const du = document.createElement("span"); du.className="dur"; du.textContent = fmtDur(drive(t));
    if ((t.stops||[]).length) du.title = `Temps de route, sans les arrêts (${fmtDur(t.end-t.start)} au total)`;
    const x = btn("✕","x"); x.setAttribute("aria-label","Supprimer ce trajet"); x.onclick=()=>{pendingDel=t.id; renderHist();};
    const acts = document.createElement("span"); acts.style.display = "flex"; acts.style.gap = "2px";
    if (t.stamps.length === t.steps.length) { const e = btn("✎","x"); e.setAttribute("aria-label","Corriger ce trajet"); e.title = "Corriger ce trajet"; e.onclick = () => editTrip(t); acts.append(e); }
    acts.append(x);
    li.append(info,du,acts);
    if (pendingDel===t.id){ const c=document.createElement("div"); c.className="confirm"; c.textContent="Supprimer ce trajet ? ";
      const y=btn("Supprimer",""); y.onclick=()=>delTrip(t.id); const n=btn("Garder",""); n.onclick=()=>{pendingDel=null;renderHist();}; c.append(y,n); li.append(c); }
    ul.append(li);
  });
}

function setDir(d){
  dir = d; $("dAller").setAttribute("aria-pressed", d==="aller"); $("dRetour").setAttribute("aria-pressed", d==="retour");
  $("dirSub").textContent = d==="aller" ? "Maison → barge → taxi → travail" : "Sortie du travail → barge → retour à la maison";
  $("hPlan").textContent = d==="aller" ? "Partir de la maison à" : "Arrivée à la maison vers";
  ls.set("trajet.dir2", d); renderAll();
}
// ---- signalements partagés
const sigActive = x => !x.endedAt && Date.now() - x.at < SIG_TTL;
function ago(ms){ const m = Math.round((Date.now()-ms)/60000); return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m/60)} h ${String(m%60).padStart(2,"0")}`; }
function renderSigForm(){
  const box = $("sigTypes"); box.innerHTML = "";
  SIG_TYPES.forEach(t => { const c = btn(t, "chip"); c.setAttribute("role","radio"); c.setAttribute("aria-checked", sigType===t); c.setAttribute("aria-pressed", sigType===t);
    c.onclick = () => { sigType = t; renderSigForm(); }; box.append(c); });
  const dl = $("placesList"); if (!dl.children.length) PLACES.forEach(p => { const o = document.createElement("option"); o.value = p; dl.append(o); });
}
function renderSigs(){
  const list = sigs.filter(sigActive).sort((a,b) => b.at - a.at), ul = $("sigList"); ul.innerHTML = "";
  $("sigCount").textContent = list.length ? `${list.length} en cours` : "aucun en cours";
  $("sigCount").className = "lvl " + (list.length ? "vigilance" : "none");
  if (!sigCol) { ul.innerHTML = `<li style="background:var(--bg)"><span class="sm">Les signalements partagés ont besoin du carnet en ligne.</span></li>`; }
  else if (!list.length) { const li = document.createElement("li"); li.style.background = "var(--bg)";
    const t = document.createElement("span"); t.className = "sm"; t.textContent = "Rien de signalé ces 2 dernières heures. Si tu vois un embouteillage, un accident ou une barge à l'arrêt, préviens les autres en un appui."; li.append(t); ul.append(li); }
  list.forEach(x => {
    const li = document.createElement("li"); if (x.by === uid) li.className = "mine";
    const st = document.createElement("span"); st.className = "st"; const b = document.createElement("b"); b.textContent = `${x.type} · ${x.lieu}`;
    const sm = document.createElement("small"); sm.textContent = ago(x.at); st.append(b, sm); li.append(st);
    const conf = Object.keys(x.confirms || {}).length;
    const dist = x.pos && myPos ? distKm(myPos, x.pos) : null;
    const meta = [dist != null ? (dist < 1 ? "à moins d'1 km de toi" : `à ${dist.toFixed(dist < 10 ? 1 : 0).replace(".", ",")} km de toi`) : null, x.detail, x.sens, x.by === uid ? "signalé par toi" : null, conf ? `confirmé par ${conf} personne${conf>1?"s":""}` : null].filter(Boolean).join(" · ");
    if (meta) { const m = document.createElement("span"); m.className = "sm"; m.textContent = meta; li.append(m); }
    const acts = document.createElement("span"); acts.className = "acts";
    if (x.by !== uid && !(x.confirms||{})[uid]) { const c = btn("C'est toujours le cas", ""); c.onclick = () => confirmSig(x.id); acts.append(c); }
    const e = btn("C'est terminé", ""); e.onclick = () => endSig(x.id); acts.append(e);
    if (x.pos) { const m = document.createElement("a"); m.href = `https://www.google.com/maps/search/?api=1&query=${x.pos.lat},${x.pos.lng}`; m.target = "_blank"; m.rel = "noopener"; m.textContent = "Voir sur la carte"; acts.append(m); }
    li.append(acts); ul.append(li);
  });
}
async function sendSig(type, lieu, sens){
  if (!sigCol) { status("Le signalement a besoin du carnet en ligne."); return null; }
  const ref = sigCol.doc(); const doc = {type, lieu, detail: "", sens: sens || "", at: Date.now(), by: uid, confirms: {}, pos: myPos ? {lat: myPos.lat, lng: myPos.lng, acc: myPos.acc} : null};
  try { await ref.set(doc); sigSeen.add(ref.id); return ref.id; } catch(e) { status("Le signalement n'a pas pu être envoyé. Réessaie."); return null; }
}
async function submitSig(){
  const lieu = $("sigLieu").value.trim(), det = $("sigDet").value.trim();
  if (!sigType) { $("sigHelp").textContent = "Choisis d'abord le type d'évènement."; return; }
  if (!lieu) { $("sigHelp").textContent = "Indique où ça se passe."; $("sigLieu").focus(); return; }
  if (!sigCol) { $("sigHelp").textContent = "Le carnet en ligne n'est pas connecté : recharge la page."; return; }
  $("sigSend").disabled = true;
  const ref = sigCol.doc();
  try {
    $("sigHelp").textContent = "Localisation en cours…";
    const pos = await getPosition();
    if (pos) myPos = pos;
    await ref.set({type: sigType, lieu: lieu.slice(0,80), detail: det.slice(0,140), sens: active ? (active.dir==="aller" ? "vers le travail" : "vers la maison") : "", at: Date.now(), by: uid, confirms: {}, pos: pos || null});
    sigSeen.add(ref.id); sigType = null; $("sigLieu").value = ""; $("sigDet").value = ""; $("sigForm").open = false;
    $("sigHelp").textContent = "Visible tout de suite par tous les utilisateurs de l'appli, pendant 2 heures."; renderSigForm(); status("Signalement envoyé à tous les utilisateurs.");
  } catch(e) { $("sigHelp").textContent = e?.code === "invalid_argument" ? "Ton accès à l'appli ne permet pas d'envoyer de signalement." : "Envoi impossible pour l'instant, réessaie."; }
  $("sigSend").disabled = false;
}
async function confirmSig(id){ try { await sigCol.doc(id).update({confirms: {[uid]: Date.now()}}); } catch(e) { status("Confirmation impossible pour l'instant."); } }
async function endSig(id, silent){ try { await sigCol.doc(id).update({endedAt: Date.now(), endedBy: uid}); } catch(e) { if (!silent) status("Impossible de clore ce signalement pour l'instant."); } }
let toastT = null;
function toast(x){ banner(`Nouveau signalement : ${x.type}`, `${x.lieu}${x.detail ? " · " + x.detail : ""}`); }
// Alerte dans l'appli : bandeau en haut de l'écran, petit son, et notification du système quand elle est disponible
let audioCtx = null;
document.addEventListener("touchstart", () => { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch(e) {} }, {once: true, passive: true});
function bip(){ try { if (!audioCtx) return; const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 880; g.gain.value = .15;
  o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + .25); } catch(e) {} }
function banner(title, body){
  const t = $("toast"); t.innerHTML = ""; const d = document.createElement("div");
  const b = document.createElement("b"); b.textContent = title; const p = document.createElement("span"); p.textContent = body;
  d.append(b, p); const c = btn("✕", ""); c.setAttribute("aria-label", "Fermer"); c.onclick = () => { t.hidden = true; };
  t.append(d, c); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 15000);
  try { navigator.vibrate?.([120, 60, 120]); } catch(e) {}
  bip();
  try { if (document.hidden && window.Notification?.permission === "granted") new Notification(title, {body}); } catch(e) {}
  document.title = "• Trajet Mayotte";
}
// Nouvelles infos route et barge : alerte pour chaque nouvel article signalant une gêne
function veilleAlert(v){
  if (!v || !Array.isArray(v.items)) return;
  let vus; try { vus = JSON.parse(localStorage.getItem("trajet.veilleVus") || "null"); } catch(e) { vus = null; }
  const titres = v.items.map(i => i.title).filter(Boolean);
  const neufs = vus ? titres.filter(x => !vus.includes(x)) : [];
  try { localStorage.setItem("trajet.veilleVus", JSON.stringify([...new Set([...(vus || []), ...titres])].slice(-60))); } catch(e) {}
  if (!neufs.length || v.level === "normal") return;
  const lv = v.level === "perturbe" ? "Perturbation sur le trajet" : "Vigilance route et barge";
  banner(`${lv}${neufs.length > 1 ? ` · ${neufs.length} nouvelles infos` : ""}`, neufs[0] + (v.extraMin ? ` · ${v.extraMin} min ajoutées à ton heure de départ` : ""));
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Trajet Mayotte"; });
function renderVac(){ const v = vacOf(Date.now()), b = $("vacBadge"); b.hidden = !v;
  if (v) { const end = new Date(v[2] + "T12:00:00"); end.setDate(end.getDate()-1);
    b.textContent = `Vacances ${v[0]} jusqu'au ${end.toLocaleDateString("fr-FR",{day:"numeric",month:"long"})} · routes plus calmes`; }
  else if (isoDay(Date.now()) >= VACANCES.at(-1)[2]) { b.hidden = false; b.textContent = "Calendrier des vacances à mettre à jour"; } }
function renderMap(){
  const R0 = refOf(dir), dep = R0?.depart || (dir === "aller" ? $("lieuDep")?.value : $("lieuArr")?.value) || "", arr = R0?.arrivee || (dir === "aller" ? $("lieuArr")?.value : $("lieuDep")?.value) || "";
  const a = active && active.dir === dir ? active : null;
  carteMaj({dir, dep: dep.trim(), arr: arr.trim(), active: a, pos: myPos, sigs: sigs.filter(sigActive), expectedMs: a ? (a.prevu || expected(dir).ms) : 0});
}
let mapTimer = null; const renderMapSoon = () => { clearTimeout(mapTimer); mapTimer = setTimeout(renderMap, 250); };
function renderAll(){ renderVac(); renderSigs(); renderRef(); renderPlan(); renderRoute(); renderStats(); renderHist(); updClock(); renderMapSoon(); }

function fillSettings(){ fillSvc(); if ($("sMargin")) $("sMargin").value = S.margin;
  [["sAvant", "avantBarge"], ["sScol", "plusScolaire"], ["sApres", "apresBarge"]].forEach(([id, k]) => { if ($(id)) $(id).value = S[k]; }); if ($("sShare")) $("sShare").checked = S.shareJams !== false; }

// ---- stockage
async function saveTrip(id,t){
  if (tripsCol) { try { await tripsCol.doc(id).set(t); status("Trajet enregistré dans ton carnet."); } catch(e){ status("Le trajet n'a pas pu être enregistré en ligne : il est gardé sur cet appareil et sera renvoyé à la prochaine ouverture.");
      pendingLocal = (ls.get("trajet.trips") || []).filter(x => x.id !== id).concat({...t, id}); ls.set("trajet.trips", pendingLocal); } }
  else { ls.set("trajet.trips", trips); status("Trajet enregistré sur cet appareil."); }
}
async function delTrip(id){
  pendingDel=null; trips = trips.filter(t=>t.id!==id); renderAll();
  if (pendingLocal.some(t => t.id === id)) { pendingLocal = pendingLocal.filter(t => t.id !== id); ls.set("trajet.trips", pendingLocal); }
  if (tripsCol) { try{ await tripsCol.doc(id).delete(); }catch(e){ status("Suppression impossible pour l'instant, réessaie."); } }
  else ls.set("trajet.trips", trips);
}
function csvExport(){
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`, mn = ms => Math.round(ms/60000);
  const rows = [["date","sens","lieu_depart","lieu_arrivee","heure_depart","heure_arrivee","route_min","total_min","km","vitesse_moy_kmh","vitesse_max_kmh","prevu_min","itineraire","moyen","passage","barge","service","vacances","embouteillages_min","arrets_min","evenements","etapes","ralentissements","note"]];
  [...trips].sort((a,b) => a.start - b.start).forEach(t => rows.push([isoDay(t.start), t.dir, t.dep || "", t.arr || "", hhmm(new Date(t.start)), hhmm(new Date(t.end)), mn(drive(t)), mn(t.end - t.start), t.km != null ? String(t.km).replace(".", ",") : "", t.km ? Math.round(t.km / (drive(t)/3600000)) : "", t.vmax || "", t.prevu ? mn(t.prevu) : "", t.itin || "", t.mode || "", t.route || "", t.barge || "", t.service || "", isVac(t) ? "oui" : "non",
    mn((t.jams||[]).reduce((a,j) => a + (j.end - j.start), 0)), mn(stopMs(t, t.start, t.end)), (t.events||[]).map(e => `${e.type} ${hhmm(new Date(e.at))}`).join(" | "), (t.steps||[]).map((n,k) => t.stamps[k] ? `${n} ${hhmm(new Date(t.stamps[k]))}` : null).filter(Boolean).join(" | "), (t.tags||[]).join(" | "), t.note || ""]));
  const csv = rows.map(r => r.map(q).join(";")).join("\r\n");
  const out = $("exportOut"); out.value = csv; out.hidden = false; out.style.minHeight = "120px";
  out.focus(); out.select();
  const done = ok => status(ok ? `${trips.length} trajet(s) copié(s) : colle le texte dans un fichier .csv ou un tableur.` : `${trips.length} trajet(s) prêts : copie le texte affiché et colle-le dans un fichier .csv ou un tableur.`);
  try { navigator.clipboard.writeText(csv).then(() => done(true), () => done(false)); } catch(e) { done(false); }
}
$("exportBtn").onclick = csvExport;
$("sMargin").addEventListener("change", e => { S.margin = Math.max(0, Math.min(120, Math.round(+e.target.value || 0))); e.target.value = S.margin; renderAll(); persistSettings(); status(`Marge de ${S.margin} min enregistrée.`); });
[["sAvant", "avantBarge", 15, 240, "Départ avant la barge"], ["sScol", "plusScolaire", 0, 90, "Supplément en période scolaire"], ["sApres", "apresBarge", 10, 120, "Temps de la barge au travail"]].forEach(([id, k, lo, hi, lbl]) =>
  $(id).addEventListener("change", e => { S[k] = Math.max(lo, Math.min(hi, Math.round(+e.target.value || 0))); e.target.value = S[k]; renderAll(); persistSettings(); status(`${lbl} : ${S[k]} min, enregistré.`); }));
$("sShare").addEventListener("change", e => { S.shareJams = e.target.checked; persistSettings(); renderActions(); status(S.shareJams ? "Tes embouteillages seront partagés." : "Tes embouteillages ne seront plus partagés."); });
async function persistSettings(){
  if (setRef) { try{ await setRef.set(S); }catch(e){ ls.set("trajet.settings", S); } } else ls.set("trajet.settings", S);
}
let tTimer=null;
function fillSvc(){ $("svcA").value = svc("aller"); $("svcR").value = svc("retour"); $("fixed").checked = !!S.fixed; }
function readSvc(){
  const a = $("svcA").value, r = $("svcR").value;
  if (S.fixed) { S.tA = a; S.tR = r; } else S.day = {date: dayKey(), tA: a, tR: r};
  if (active && !active.service) { active.service = (active.dir==="aller" ? a : r) || null; persistActive(); }
  renderAll(); clearTimeout(tTimer); tTimer = setTimeout(persistSettings, 600);
}
$("svcA").addEventListener("change", readSvc);
$("svcR").addEventListener("change", readSvc);
$("fixed").addEventListener("change", e => { S.fixed = e.target.checked; readSvc();
  status(S.fixed ? "Horaires fixes : ils seront pré-remplis chaque jour." : "Horaires variables : à renseigner chaque jour."); });
function status(m){ $("status").textContent = m; }

$("dAller").onclick = () => setDir("aller");
$("dRetour").onclick = () => setDir("retour");

$("sigSend").onclick = submitSig;
renderSigForm();
setInterval(renderSigs, 60000);


// ---- position GPS pendant le trajet
function distKm(a, b){ const R = 6371, r = Math.PI/180, dLat = (b.lat-a.lat)*r, dLng = (b.lng-a.lng)*r;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
async function startTracking(){
  if (watchId != null) return;
  watchId = await watchPosition(p => {
    // Vitesse : celle du GPS, sinon calculée entre deux positions
    const prev = myPos; let v = p.speed != null ? p.speed * 3.6 : null;
    if (v == null && prev && p.t > prev.t) { const dt = (p.t - prev.t) / 1000; if (dt >= 1 && dt <= 30) v = distKm(prev, p) * 3600 / dt; }
    p.kmh = v == null ? null : (v < 3 ? 0 : Math.round(v));
    myPos = p;
    // Vitesse maximale : seulement la vitesse mesurée par le GPS, plus fiable que l'écart entre deux positions
    if (active && p.speed != null && (p.acc || 0) <= 30 && p.kmh < 160) active.vmax = Math.max(active.vmax || 0, p.kmh);
    if (active && active.stamps.length < active.steps.length) {
      active.track ||= []; const last = active.track.at(-1);
      if (!last || p.t - last[0] >= 15000) { active.track.push([p.t, +p.lat.toFixed(5), +p.lng.toFixed(5)]); persistActive(); }
      // Kilométrage : somme des déplacements entre deux positions précises (on ignore le bruit de moins de 15 m)
      if ((p.acc || 0) <= 60) { const lf = active.lastFix, d = lf ? distKm(lf, p) * 1000 : 0;
        if (!lf || d >= 15) { if (lf) active.gpsM = (active.gpsM || 0) + d; active.lastFix = {lat: p.lat, lng: p.lng}; if (d >= 15) persistActive(); } }
    }
    renderSigs(); renderMapSoon();
  });
}
function stopTracking(){ if (watchId != null) { clearPositionWatch(watchId); watchId = null; } }

// ---- notifications push
function onPushForeground(data){ if (!data || data.by === uid) return; const x = sigs.find(s => s.id === data.id); if (!x && data.title) toast({type: data.title, lieu: data.body || "", detail: ""}); }
function onPushTap(){ $("signal").scrollIntoView({behavior: "smooth", block: "start"}); }
function renderNotifBtn(){ const b = $("notifBtn"); if (!b) return;
  b.hidden = pushState === "unsupported";
  b.disabled = pushState === "granted"; b.textContent = pushState === "granted" ? "Notifications activées" : pushState === "denied" ? "Notifications refusées (Réglages du téléphone)" : "Activer les notifications"; }
$("notifBtn").onclick = async () => { pushState = await enablePush(); renderNotifBtn(); };

// ---- effacement des données (exigé par l'App Store)
$("wipeBtn").onclick = () => { $("wipeConfirm").hidden = false; };
$("wipeNo").onclick = () => { $("wipeConfirm").hidden = true; };
$("wipeYes").onclick = async () => {
  $("wipeYes").disabled = true;
  try {
    if (tripsCol) for (const t of trips) await tripsCol.doc(t.id).delete();
    if (setRef) await setRef.delete();
    if (db && uid) { await db.doc(`data/users/${uid}/reference`).delete(); await db.doc(`data/users/${uid}/referenceRetour`).delete(); }
    await deleteAccount();
  } catch(e) { console.error(e); }
  try { localStorage.clear(); } catch(e) {}
  location.reload();
};
$("privacyLink").href = PRIVACY_URL;


// ---- veille, trajet de référence et conseil (fonctions serveur + API Claude)
let veille = null, advice = "", reference = null, referenceR = null, refBusy = false, refErr = false, adviceBusy = false;
function veilleFresh(){
  if (!veille || !veille.updatedAt) return null;
  return Date.now() - Date.parse(veille.updatedAt) < 18*3600000 ? veille : null;
}
const extraFromVeille = () => { const v = veilleFresh(); return v ? Math.max(0, Math.min(120, +v.extraMin || 0)) : 0; };
const refOptions = r => (r && Array.isArray(r.options)) ? r.options.filter(o => o && typeof o.min === "number" && o.min > 0).slice(0,3) : [];
const refOf = d => d === "retour" ? referenceR : reference;
const choixKey = d => d === "retour" ? "refChoixR" : "refChoix";
const chosenOpt = (d = dir) => { const o = refOptions(refOf(d)); if (!o.length) return null; return o.find(x => x.nom === S[choixKey(d)]) || o.reduce((a,b) => b.min < a.min ? b : a); };
const refMs = (d = dir) => { const o = chosenOpt(d); return o ? o.min*60000 : null; };
const curRef = (d = dir) => refOf(d);
const refBase = () => reference || (referenceR ? {depart: referenceR.arrivee, arrivee: referenceR.depart} : null);
const refLocked = () => false;
// Vérification en direct toutes les 2 minutes : itinéraires recalculés et signalements en cours sur chaque route
const LIVE_MS = 120000;
let liveAt = 0, liveBusy = false, liveErr = false;
const SIG_MIN = {"Embouteillage": 15, "Accident": 20, "Route bloquée / barrage": 60, "Barge à l'arrêt ou retardée": 30, "Longue attente de taxi": 10, "Route inondée / éboulement": 30, "Autre": 5};
const nrm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// Signalements en cours qui touchent cet itinéraire, et minutes à ajouter
function liveHits(o, d){
  const villes = (o.resume || "").replace(/^Par /, "").split(",").map(nrm).filter(Boolean);
  const barge = (o.etapes || []).some(e => /barge/i.test(e.label)), taxi = (o.etapes || []).some(e => /taxi/i.test(e.label));
  const hits = [], want = d === "aller" ? "vers le travail" : "vers la maison";
  sigs.filter(sigActive).forEach(x => {
    if (x.sens && x.sens !== want && !/barge/i.test(x.type)) return;
    const L = nrm(x.lieu);
    const onRoute = L && villes.some(v => L.includes(v) || v.includes(L));
    const ok = /barge/i.test(x.type) ? barge || onRoute : /taxi/i.test(x.type) ? taxi && (!L || /dzaoudzi|pamandzi|labattoir|aeroport|petite terre/.test(L) || onRoute) : onRoute;
    if (!ok) return;
    const n = Object.keys(x.confirms || {}).length;
    // Un signalement d'un autre utilisateur, non confirmé, pèse au plus 20 min
    let min = Math.round((SIG_MIN[x.type] ?? 5) * (n >= 2 ? 1.5 : 1)); if (!n && x.by !== uid) min = Math.min(min, 20);
    hits.push({type: x.type, lieu: x.lieu, min, bloque: /bloqu|barrage/i.test(x.type) && (n > 0 || x.by === uid)});
  });
  return hits;
}
const liveMin = (o, d) => Math.min(60, liveHits(o, d).reduce((a, h) => a + h.min, 0));
const liveBest = d => { const o = refOptions(refOf(d)); if (!o.length) return null;
  return o.map(x => ({o: x, tot: x.min + liveMin(x, d), bloque: liveHits(x, d).some(h => h.bloque)})).sort((a, b) => (a.bloque - b.bloque) || (a.tot - b.tot))[0]; };
async function liveCheck(force){
  const base = refBase();
  if (!base || liveBusy || (!force && document.hidden)) return;
  liveBusy = true;
  try {
    const [a, r] = await Promise.allSettled([
      callFn("/reference", {depart: base.depart, arrivee: base.arrivee, sens: "aller"}),
      callFn("/reference", {depart: base.arrivee, arrivee: base.depart, sens: "retour"})]);
    if (a.status === "fulfilled" && a.value?.options) reference = {...a.value, live: true};
    if (r.status === "fulfilled" && r.value?.options) referenceR = {...r.value, live: true};
    liveErr = a.status !== "fulfilled" && r.status !== "fulfilled";
    liveAt = Date.now();
  } catch (e) { liveErr = true; }
  liveBusy = false; renderRef(); renderPlan();
}
setInterval(() => liveCheck(false), LIVE_MS);
setTimeout(() => liveCheck(true), 6000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - liveAt > LIVE_MS) liveCheck(false); });
function renderVeille(){
  const box = $("veille"); box.innerHTML = "";
  const v = veilleFresh();
  const head = document.createElement("div"); head.className = "vhead";
  const h = document.createElement("h2"); h.textContent = "Infos route et barge"; head.append(h);
  const lv = document.createElement("span"); lv.className = "lvl " + (v ? (v.level||"normal") : "none");
  lv.textContent = !v ? "pas de veille récente" : ({normal:"rien à signaler", vigilance:"vigilance", perturbe:"perturbé"}[v.level] || v.level);
  head.append(lv); box.append(head);
  if (!v) { const p = document.createElement("p"); p.className="empty";
    p.textContent = veille ? `Dernière veille : ${new Date(veille.updatedAt).toLocaleString("fr-FR",{weekday:"short",hour:"2-digit",minute:"2-digit"})}, trop ancienne pour être prise en compte.` : "La veille Internet n'a pas encore tourné. Elle lit la presse locale (Journal de Mayotte, Mayotte Hebdo, L'Info Kwézi) toutes les 2 minutes.";
    box.append(p);
    const vb = btn("Vérifier maintenant", "btn ghost"); vb.id = "veilleBtn"; vb.style.marginTop = "10px"; vb.onclick = refreshVeille; box.append(vb); return; }
  if (v.summary) { const p = document.createElement("p"); p.className="vsum"; p.textContent = v.summary; box.append(p); }
  const ul = document.createElement("ul"); ul.className = "vlist";
  (v.items||[]).slice(0,6).forEach(it => {
    const li = document.createElement("li");
    const t = document.createElement("strong"); t.textContent = it.title; li.append(t);
    if (it.detail) li.append(document.createTextNode(" " + it.detail));
    const meta = document.createElement("small");
    if (it.url) { const a = document.createElement("a"); a.href = it.url; a.target="_blank"; a.rel="noopener"; a.textContent = it.source || "source"; meta.append(a); }
    else if (it.source) meta.append(document.createTextNode(it.source));
    if (it.date) meta.append(document.createTextNode(" · " + it.date));
    li.append(meta); ul.append(li);
  });
  if (ul.children.length) box.append(ul);
  const f = document.createElement("p"); f.className = "empty";
  f.textContent = `Presse locale vérifiée toutes les 2 minutes · dernière mise à jour ${new Date(v.updatedAt).toLocaleString("fr-FR",{weekday:"long",hour:"2-digit",minute:"2-digit"})}` + (v.extraMin ? ` · ${v.extraMin} min ajoutées au calcul de départ` : "");
  box.append(f);
  const vb = btn("Vérifier maintenant", "btn ghost"); vb.id = "veilleBtn"; vb.style.marginTop = "6px"; vb.onclick = refreshVeille; box.append(vb);
}


function refMsg(text, kind){ const m = $("refMsg"); m.hidden = !text; m.className = "refmsg" + (kind==="err" ? " err" : ""); m.textContent = "";
  if (!text) return; if (kind === "wait") { const sp = document.createElement("span"); sp.className = "spin"; sp.setAttribute("aria-hidden","true"); m.append(sp); }
  const t = document.createElement("span"); t.textContent = text; m.append(t); }
function renderRef(){
  const box = $("refOut"); box.innerHTML = "";
  const any = refOf("aller") || refOf("retour");
  $("refBtn").hidden = refBusy || !(any || refErr);
  if (!any) { const p = document.createElement("p"); p.className = "empty";
    p.textContent = "Jusqu'à trois itinéraires te seront proposés pour l'aller et pour le retour, avec la distance et la durée de chaque tronçon. Tu choisiras celui que tu prends."; box.append(p); $("refIntro").hidden = false; return; }
  $("refIntro").hidden = true;
  const st = document.createElement("p"); st.className = "refmsg"; st.style.margin = "0 0 12px";
  st.textContent = liveBusy ? "Vérification en direct…" : liveAt ? `${liveErr ? "Dernière vérification impossible" : "Vérifié en direct"} à ${hhmm(new Date(liveAt))} · prochaine vérification dans 2 min (itinéraires et signalements en cours)` : "Vérification en direct toutes les 2 minutes tant que l'appli est ouverte.";
  box.append(st);
  (dir === "retour" ? ["retour", "aller"] : ["aller", "retour"]).forEach(d => box.append(refBlock(d)));
}
function refBlock(d){
  const r = refOf(d), w = document.createElement("div"); w.className = "ref"; w.style.marginTop = "14px";
  const h = document.createElement("p"); h.className = "vsum"; h.style.margin = "0";
  if (!r) { h.textContent = d === "retour" ? "Retour : pas encore calculé" : "Aller : pas encore calculé"; w.append(h); return w; }
  h.textContent = `${d === "retour" ? "Retour" : "Aller"} · ${r.depart} → ${r.arrivee}`; w.append(h);
  const opts = refOptions(r), ch = chosenOpt(d), best = liveBest(d);
  if (best && ch && best.o.nom !== ch.nom && (best.tot + 5 <= ch.min + liveMin(ch, d) || liveHits(ch, d).some(x => x.bloque))) {
    const tip = document.createElement("p"); tip.className = "refmsg err"; tip.style.margin = "0";
    tip.textContent = `En ce moment, « ${best.o.nom} » est plus sûr que ton itinéraire habituel (${fmtDur(best.tot*60000)} estimées).`; w.append(tip); }
  if (opts.length > 1) { const q = document.createElement("p"); q.className = "empty"; q.style.margin = "0"; q.textContent = "Choisis l'itinéraire que tu prends d'habitude :"; w.append(q); }
  const list = document.createElement("div"); list.className = "opts"; list.setAttribute("role", "radiogroup"); list.setAttribute("aria-label", `Itinéraires ${d === "retour" ? "du retour" : "de l'aller"}`);
  opts.forEach(o => {
    const sel = ch && o.nom === ch.nom, hits = liveHits(o, d), plus = hits.reduce((a, x) => a + x.min, 0);
    const c = document.createElement("button"); c.type = "button"; c.className = "opt"; c.setAttribute("role", "radio"); c.setAttribute("aria-checked", sel);
    const top = document.createElement("span"); top.className = "otop";
    const nm = document.createElement("span"); nm.className = "onom"; nm.textContent = o.nom;
    const mn = document.createElement("span"); mn.className = "num omin"; mn.textContent = fmtDur((o.min + plus)*60000);
    top.append(nm, mn); c.append(top);
    if (hits.length) { const lv = document.createElement("span"); lv.className = "oexp"; lv.style.background = "var(--ambre-soft)";
      lv.textContent = (hits.some(x => x.bloque) ? "Route signalée bloquée : " : `+${plus} min en ce moment : `) + hits.map(x => `${x.type.toLowerCase()}${x.lieu ? " à " + x.lieu : ""}`).join(", ") + "."; c.append(lv); }
    const meta = [o.km ? o.km + " km" : null, sel ? (o.resume || null) : null].filter(Boolean).join(" · ") || (sel ? "" : "Touche pour voir le détail");
    if (meta) { const m = document.createElement("span"); m.className = "ometa"; m.textContent = meta; c.append(m); }
    if (sel && o.explication) { const ex = document.createElement("span"); ex.className = "oexp"; ex.textContent = o.explication; c.append(ex); }
    if (sel && (o.etapes||[]).length) { const ul = document.createElement("span"); ul.className = "oet";
      o.etapes.forEach(e => { const li = document.createElement("span"); const l = document.createElement("span"); l.textContent = e.label;
        const v = document.createElement("span"); v.textContent = [e.km ? e.km + " km" : null, e.min ? e.min + " min" : null].filter(Boolean).join(" · "); li.append(l, v); ul.append(li); });
      c.append(ul); }
    c.onclick = () => chooseOpt(o.nom, d);
    list.append(c);
  });
  w.append(list);
  if (r.notes) { const p = document.createElement("p"); p.className = "empty"; p.style.margin = "0"; p.textContent = r.notes; w.append(p); }
  return w;
}
async function chooseOpt(nom, d = dir){
  S[choixKey(d)] = nom; renderAll();
  try { await persistSettings(); } catch(e) { status("Le choix n'a pas pu être enregistré, réessaie."); }
}
const errText = e => e?.code === "ia/absent" ? "Cette fonction n'est pas encore activée."
  : e?.code === "ia/reseau" ? "Pas de connexion au service, vérifie ta connexion et réessaie."
  : e?.userMessage || "Le calcul n'a pas pu se faire. Réessaie dans quelques minutes.";
async function launchRef(){
  if (refBusy) return;
  const dep = $("lieuDep").value.trim(), arr = $("lieuArr").value.trim();
  if (!dep || !arr) { refMsg("Indique le village de départ et le lieu d'arrivée.", "err"); $(dep ? "lieuArr" : "lieuDep").focus(); return; }
  refBusy = true; refErr = false; $("refBtn").hidden = true;
  refMsg(`Recherche des itinéraires aller et retour entre ${dep} et ${arr}… quelques secondes.`, "wait");
  const [a, r] = await Promise.allSettled([
    callFn("/reference", {depart: dep, arrivee: arr, sens: "aller"}),
    callFn("/reference", {depart: arr, arrivee: dep, sens: "retour"})]);
  if (a.status === "fulfilled") { reference = a.value; S.refChoix = null; if (db && uid) db.doc(`data/users/${uid}/reference`).set(reference).catch(() => {}); }
  if (r.status === "fulfilled") { referenceR = r.value; S.refChoixR = null; if (db && uid) db.doc(`data/users/${uid}/referenceRetour`).set(referenceR).catch(() => {}); }
  refBusy = false;
  if (a.status === "rejected" && r.status === "rejected") { console.error(a.reason); refErr = true; refMsg(errText(a.reason), "err"); }
  else if (a.status === "rejected" || r.status === "rejected") { refErr = true; refMsg(`${a.status === "rejected" ? "L'aller" : "Le retour"} n'a pas pu être calculé : ${errText((a.status === "rejected" ? a : r).reason)}`, "err"); }
  else refMsg("");
  try { await persistSettings(); } catch(e) {}
  renderAll();
}
async function refreshVeille(silent){
  const b = $("veilleBtn"); if (b) { b.disabled = true; b.textContent = "Vérification en cours…"; }
  try { veille = await callFn("/veille/refresh", {}); veilleAlert(veille); renderPlan(); }
  catch(e) { console.error(e); if (!silent) status(errText(e)); if (b) { b.disabled = false; b.textContent = "Vérifier maintenant"; } }
}
// Conseil calculé dans l'appli, à partir de tes trajets, de la veille et des signalements (sans l'API Claude)
function askAdvice(){
  const all = tripsFor(dir).slice(0, 40), out = [];
  const h = $("leaveAt").textContent, ok = /\d/.test(h);
  out.push(!ok ? `Renseigne ta ${dir === "aller" ? "heure de début" : "fin"} de service en haut pour avoir une heure précise.`
    : dir === "aller" ? `Pars de la maison à ${h}.` : `En partant à ta fin de service, tu arriveras à la maison vers ${h}.`);
  const v = veilleFresh();
  if (v && v.level !== "normal") out.push(`Infos du jour : ${v.summary || "perturbations signalées"}${v.extraMin ? ` Prévois ${v.extraMin} min de plus.` : ""}`);
  const act = sigs.filter(sigActive);
  if (act.length) out.push(`${act.length} signalement${act.length > 1 ? "s" : ""} en cours : ${act.slice(0, 3).map(x => `${x.type.toLowerCase()}${x.lieu ? " à " + x.lieu : ""}`).join(", ")}.`);
  // Barge : traversée moyenne par type
  const byB = {}; all.forEach(t => { if (!t.barge) return; const i = (t.steps||[]).findIndex(isBarge); if (i < 0 || !t.stamps[i+1]) return; (byB[t.barge] ||= []).push(t.stamps[i+1] - t.stamps[i]); });
  if (byB["Amphidrome"]?.length >= 2 && byB["Barge normale"]?.length >= 2) {
    const d = Math.round((avg(byB["Barge normale"]) - avg(byB["Amphidrome"])) / 60000);
    if (Math.abs(d) >= 3) out.push(`${d > 0 ? "L'amphidrome" : "La barge normale"} est en moyenne ${Math.abs(d)} min plus rapide pour la traversée.`);
  }
  const qw = all.map(quaiWait).filter(x => x != null);
  if (qw.length >= 2 && avg(qw) >= 8 * 60000) out.push(`Tu attends en moyenne ${fmtDur(avg(qw))} au quai avant la barge, c'est déjà compté dans l'heure de départ.`);
  const tw = all.map(taxiWait).filter(x => x != null);
  if (tw.length >= 2 && avg(tw) >= 8 * 60000) out.push(`L'attente du taxi te coûte en moyenne ${fmtDur(avg(tw))}${dir === "aller" ? " à Dzaoudzi" : " à la sortie du travail"}.`);
  const tip = routeTip(dir).trim(); if (tip) out.push(tip);
  const e = expected(dir);
  if (e.jamRate >= .34) out.push(`À cette heure-ci, tu as eu un embouteillage ${Math.round(e.jamRate * 100)} % du temps (${fmtDur(e.jamAvg)} perdues en moyenne).`);
  const ch = chosenOpt(); if (ch && !tip) out.push(`Itinéraire conseillé : « ${ch.nom} » (${fmtDur(ch.min * 60000)} porte à porte sans circulation).`);
  if (all.length < 3) out.push(`Chronomètre encore ${3 - all.length} trajet${3 - all.length > 1 ? "s" : ""} dans ce sens pour des conseils plus précis.`);
  else if (out.length === 1) out.push("Rien de particulier à signaler d'après tes trajets et les infos du jour.");
  advice = out.join(" ");
  renderPlan();
}
$("adviceBtn").onclick = askAdvice;
$("refBtn").onclick = () => launchRef();
// Calcul automatique : dès que les deux lieux sont remplis (pause de frappe, sortie du champ ou Entrée).
let refTimer = null;
const refChanged = () => { const d = $("lieuDep").value.trim(), a = $("lieuArr").value.trim();
  return d.length >= 2 && a.length >= 2 && (!refBase() || refBase().depart !== d || refBase().arrivee !== a); };
const autoRef = (force) => { clearTimeout(refTimer); if (refLocked()) return;
  const d = $("lieuDep").value.trim(), a = $("lieuArr").value.trim(); if (d.length < 2 || a.length < 2) return;
  if (force || refChanged()) launchRef(); };
["lieuDep","lieuArr"].forEach(id => {
  $(id).addEventListener("input", () => { clearTimeout(refTimer); refTimer = setTimeout(() => autoRef(false), 2500); });
  $(id).addEventListener("change", () => autoRef(false)); });
$("lieuDep").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("lieuArr").focus(); } });
$("lieuArr").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); autoRef(false); } });
// ---- accueil : le trajet est demandé dès l'ouverture tant qu'il n'est pas enregistré
let welcomeAsked = false, wTimer = null;
function openWelcome(){ const w = $("welcome"); if (welcomeAsked || refLocked() || w.open) return; welcomeAsked = true;
  $("wDep").value = $("lieuDep").value; $("wArr").value = $("lieuArr").value;
  try { w.showModal(); } catch(e) { w.setAttribute("open", ""); }
  setTimeout(() => $($("wDep").value ? "wArr" : "wDep").focus(), 60); }
function closeWelcome(){ const w = $("welcome"); if (!w.open) return; try { w.close(); } catch(e) { w.removeAttribute("open"); } }
function welcomeGo(){ clearTimeout(wTimer); const a = $("wDep").value.trim(), b = $("wArr").value.trim(); if (a.length < 2 || b.length < 2) return;
  $("lieuDep").value = a; $("lieuArr").value = b; closeWelcome(); autoRef(false); }
["wDep","wArr"].forEach(id => {
  $(id).addEventListener("input", () => { clearTimeout(wTimer); wTimer = setTimeout(welcomeGo, 2500); });
  $(id).addEventListener("change", welcomeGo); });
$("wDep").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("wArr").focus(); } });
$("wArr").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); welcomeGo(); } });
$("wLater").onclick = closeWelcome;

// ---- démarrage : rendu immédiat depuis l'appareil, puis carnet en ligne
S = {...DEF, ...(ls.get("trajet.settings")||{})};
if (!S.fixed) { S.tA = ""; S.tR = ""; }
trips = ls.get("trajet.trips") || [];
active = ls.get("trajet.active");
dir = ls.get("trajet.dir2") || "retour";
if (active && !active.service) active.service = svc(active.dir) || null;
fillSettings(); setDir(dir);
getPosition().then(p => { if (p && !myPos) { myPos = p; renderMapSoon(); } });
if (active && active.stamps.length < active.steps.length) { startTick(); startTracking(); }

(async () => {
  initPush(onPushTap, onPushForeground).then(st => { pushState = st; renderNotifBtn(); });
  try {
    const fb = await initFirebase();
    db = fb.db; uid = fb.uid;
  } catch(e) { db = null; console.error(e); }
  if (!db || !uid) { status("Pas de connexion au carnet en ligne : tes trajets restent sur ce téléphone pour l'instant."); return; }
  const base = db.doc(`data/users/${uid}/carnet`);
  tripsCol = base.collection("trips");
  setRef = db.doc(`data/users/${uid}/reglages`);
  try {
    const s = await setRef.get();
    if (s.exists) { S = {...DEF, ...s.data()}; if (!S.fixed) { S.tA = ""; S.tR = ""; } fillSettings(); renderAll(); }
  } catch(e){}
  // rapatrie les trajets gardés hors ligne
  const local = ls.get("trajet.trips") || [];
  pendingLocal = [];
  for (const t of local) { try{ const {id,...b}=t; await tripsCol.doc(id).set(b); }catch(e){ pendingLocal.push(t); } }
  if (local.length) ls.set("trajet.trips", pendingLocal);
  // Infos route et barge : relues à l'ouverture puis toutes les 30 secondes ;
  // si la dernière vérification Internet date de plus d'une heure, une nouvelle est lancée à l'ouverture.
  const loadVeille = async () => { const v = await getVeille(); if (v) { veille = v; veilleAlert(v); } renderPlan(); };
  setInterval(loadVeille, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadVeille(); });
  loadVeille().then(() => { if (!veille?.updatedAt || Date.now() - Date.parse(veille.updatedAt) > 3600000) refreshVeille(true); });
  db.doc(`data/users/${uid}/reference`).onSnapshot(d => { reference = d.exists ? d.data() : null;
    if (reference) { if (!$("lieuDep").value) $("lieuDep").value = reference.depart || ""; if (!$("lieuArr").value) $("lieuArr").value = reference.arrivee || ""; closeWelcome(); }
    else if (!refBusy && !d.metadata?.hasPendingWrites) setTimeout(() => { if (!reference && !referenceR && !refBusy) openWelcome(); }, 800);
    renderAll(); }, () => {});
  db.doc(`data/users/${uid}/referenceRetour`).onSnapshot(d => { referenceR = d.exists ? d.data() : null; if (referenceR) closeWelcome(); renderAll(); }, () => {});
  sigCol = db.collection("signalements");
  sigCol.orderBy("at","desc").limit(60).onSnapshot(snap => {
    sigs = snap.docs.map(d => ({id: d.id, ...d.data()}));
    if (sigBooted) snap.docChanges().forEach(ch => { const x = {id: ch.doc.id, ...ch.doc.data()};
      if (ch.type === "added" && x.by !== uid && !sigSeen.has(x.id) && sigActive(x)) toast(x); sigSeen.add(x.id); });
    else sigs.forEach(x => sigSeen.add(x.id));
    sigBooted = true; renderSigs(); renderRef(); renderPlan(); renderMapSoon();
  }, () => {});
  tripsCol.orderBy("start","desc").limit(300).onSnapshot(snap => {
    trips = snap.docs.map(d => ({id:d.id, ...d.data()})); renderAll();
    status("Carnet synchronisé.");
  }, () => status("Synchronisation interrompue : vérifie ta connexion."));

})();
