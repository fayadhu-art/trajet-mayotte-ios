// Fonctions natives : position GPS et notifications push.
// Sur iPhone/Android elles passent par les plugins Capacitor ;
// dans un navigateur (tests sur ordinateur) elles se rabattent sur les API web.
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";

const native = Capacitor.isNativePlatform();
const toPos = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0), t: p.timestamp || Date.now(),
  speed: p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed : null });

export async function getPosition() {
  try {
    if (native) {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted") {
        const r = await Geolocation.requestPermissions({ permissions: ["location"] });
        if (r.location !== "granted") return null;
      }
      return toPos(await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 }));
    }
    if (!navigator.geolocation) return null;
    return await new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res(toPos(p)), () => res(null), { enableHighAccuracy: true, timeout: 10000 }));
  } catch (e) {
    return null;
  }
}

// Suit la position pendant un trajet (appli ouverte). Renvoie un identifiant à passer à clearPositionWatch.
export async function watchPosition(onPos) {
  try {
    if (native) {
      const first = await getPosition();
      if (first) onPos(first);
      return await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20000 }, (p) => { if (p) onPos(toPos(p)); });
    }
    if (!navigator.geolocation) return null;
    return navigator.geolocation.watchPosition((p) => onPos(toPos(p)), () => {}, { enableHighAccuracy: true });
  } catch (e) {
    return null;
  }
}

export function clearPositionWatch(id) {
  if (id == null) return;
  if (native) Geolocation.clearWatch({ id });
  else navigator.geolocation?.clearWatch(id);
}

// ---------- notifications ----------
// Version 1 des stores : pas de notifications push (elles demandent l'offre payante de Firebase).
export async function initPush() { return "unsupported"; }
export async function enablePush() { return "unsupported"; }
