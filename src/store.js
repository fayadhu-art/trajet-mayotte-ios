// Accès à Firebase (Auth anonyme + Firestore), exposé avec une petite API
// doc()/collection()/onSnapshot() pour que le reste de l'appli reste simple.
import { initializeApp } from "firebase/app";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInAnonymously, onAuthStateChanged, deleteUser,
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, collection, getDoc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit,
} from "firebase/firestore";
import { firebaseConfig, IA_URL } from "./firebase-config.js";

let app, auth, fs;

export async function initFirebase() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("REMPLACER")) {
    throw new Error("Configuration Firebase manquante : remplis src/firebase-config.js");
  }
  app = initializeApp(firebaseConfig);
  // Dans la WebView iOS/Android, la persistance IndexedDB garde la session anonyme
  // d'un lancement à l'autre : l'utilisateur retrouve ses trajets.
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) });

  const user = await new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, async (u) => {
      if (u) { stop(); resolve(u); return; }
      try { await signInAnonymously(auth); } catch (e) { stop(); reject(e); }
    });
  });
  return { db: makeDb(fs), uid: user.uid };
}

// Appelle le service IA (Cloudflare Workers) avec le jeton de connexion Firebase.
export async function callFn(path, data) {
  if (!IA_URL || IA_URL.startsWith("REMPLACER")) throw Object.assign(new Error("Service IA pas encore installé."), { code: "ia/absent" });
  const token = await auth.currentUser.getIdToken();
  let r;
  try {
    r = await fetch(IA_URL.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(data || {}) });
  } catch (e) { throw Object.assign(new Error("Pas de connexion au service."), { code: "ia/reseau" }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "Erreur du service."), { code: "ia/" + r.status, userMessage: j.error });
  return j;
}
export async function getVeille() {
  if (!IA_URL || IA_URL.startsWith("REMPLACER")) return null;
  try { const r = await fetch(IA_URL.replace(/\/$/, "") + "/veille"); return r.ok ? await r.json() : null; } catch (e) { return null; }
}

export async function deleteAccount() {
  if (auth?.currentUser) await deleteUser(auth.currentUser);
}

// ---------- petite surcouche ----------
const snapDoc = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });

function wrapDoc(path) {
  const ref = doc(fs, path);
  return {
    id: ref.id,
    path,
    get: async () => snapDoc(await getDoc(ref)),
    set: (data) => setDoc(ref, data),
    // fusion profonde, comme dans la version web (ex. confirms.{uid})
    update: (data) => setDoc(ref, data, { merge: true }),
    delete: () => deleteDoc(ref),
    onSnapshot: (next, err) => onSnapshot(ref, (s) => next(snapDoc(s)), err),
    collection: (sub) => wrapCol(`${path}/${sub}`),
  };
}

function wrapCol(path, constraints = []) {
  const ref = collection(fs, path);
  const q = () => (constraints.length ? query(ref, ...constraints) : ref);
  return {
    path,
    doc: (id) => wrapDoc(id ? `${path}/${id}` : doc(ref).path),
    orderBy: (field, dir = "asc") => wrapCol(path, [...constraints, orderBy(field, dir)]),
    limit: (n) => wrapCol(path, [...constraints, limit(n)]),
    onSnapshot: (next, err) => onSnapshot(q(), (s) => next({
      docs: s.docs.map(snapDoc),
      size: s.size,
      empty: s.empty,
      docChanges: () => s.docChanges().map((c) => ({ type: c.type, doc: snapDoc(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex })),
    }), err),
  };
}

function makeDb() {
  return { doc: wrapDoc, collection: (p) => wrapCol(p) };
}
