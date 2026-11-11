// Carnet local : remplace le carnet en ligne de Claude par le stockage du téléphone.
// Même interface que celle utilisée par l'appli (documents, collections, écoute des changements).
(() => {
  const KEY = "trajet.carnet";
  let store;
  try { store = new Map(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch (e) { store = new Map(); }
  const subs = [];
  let n = 0;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...store])); } catch (e) { throw { code: "unavailable" }; } };
  const fire = () => subs.forEach(f => { try { f(); } catch (e) {} });
  const copy = v => JSON.parse(JSON.stringify(v));
  const snapDoc = path => ({ id: path.split("/").pop(), exists: store.has(path), data: () => copy(store.get(path)) });
  const docRef = path => ({
    id: path.split("/").pop(),
    async get() { return snapDoc(path); },
    async set(v) { store.set(path, copy(v)); save(); fire(); },
    async update(v) { const o = store.get(path) || {};
      for (const k in v) o[k] = (v[k] && typeof v[k] === "object" && !Array.isArray(v[k])) ? { ...(o[k] || {}), ...v[k] } : v[k];
      store.set(path, o); save(); fire(); },
    async delete() { store.delete(path); save(); fire(); },
    onSnapshot(cb) { const f = () => cb(snapDoc(path)); subs.push(f); setTimeout(f, 0); },
    collection(name) { return colRef(path + "/" + name); }
  });
  const colRef = path => {
    const list = () => [...store.keys()].filter(k => k.startsWith(path + "/") && k.slice(path.length + 1).indexOf("/") < 0).map(snapDoc);
    const q = { orderBy() { return q; }, limit() { return q; },
      async get() { return { docs: list() }; },
      onSnapshot(cb) { const f = () => cb({ docs: list(), docChanges: () => [] }); subs.push(f); setTimeout(f, 0); },
      doc(id) { return docRef(path + "/" + (id || "d" + Date.now() + (++n))); } };
    return q;
  };
  const db = { doc: docRef, collection: colRef };
  window.__standalone = true;
  window.claude = { use: async k => k === "db" ? db : k === "user" ? { id: async () => "moi", canEdit: async () => true } : null };
})();
