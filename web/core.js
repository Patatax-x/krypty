// krypty2/core.js — identité, contacts, chiffrement, stockage local. Zéro dépendance.
// Tout ce fichier tourne dans le navigateur (WebCrypto + IndexedDB). Rien ne quitte
// l'appareil en clair. « La messagerie qui ne sait pas que vous existez » : il n'y a
// aucun compte — l'identité est une paire de clés créée ici et connue de vos contacts.

export const b64u = {
  enc: (u8) => btoa(String.fromCharCode(...new Uint8Array(u8))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)),
};
const te = new TextEncoder(), td = new TextDecoder();
export const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
export const uid = () => b64u.enc(rand(12));
export async function sha256(u8) { return new Uint8Array(await crypto.subtle.digest("SHA-256", u8)); }

// ── Clés ──────────────────────────────────────────────────────────────────────────
export async function genX25519() {
  const k = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  return { pub: new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)), priv: await crypto.subtle.exportKey("jwk", k.privateKey) };
}
export async function genEd25519() {
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { pub: new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)), priv: await crypto.subtle.exportKey("jwk", k.privateKey) };
}
export async function edSign(privJwk, data) {
  const k = await crypto.subtle.importKey("jwk", privJwk, { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k, data));
}
export async function edVerify(pubRaw, sig, data) {
  try {
    const k = await crypto.subtle.importKey("raw", pubRaw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, sig, data);
  } catch { return false; }
}
// Clé de paire = HKDF(X25519(moi, lui)). Identique des deux côtés, jamais transmise.
export async function pairKey(myPrivJwk, theirPubRaw) {
  const priv = await crypto.subtle.importKey("jwk", myPrivJwk, { name: "X25519" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", theirPubRaw, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode("krypty2"), info: te.encode("pair-v1") },
    hk, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
export async function seal(key, obj) {          // objet → base64url(iv ‖ AES-GCM)
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64u.enc(out);
}
export async function open(key, blob) {
  const raw = b64u.dec(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(td.decode(pt));
}
// Numéro de sécurité : SHA-256(min ‖ max) → 60 chiffres, identique des deux côtés.
export async function safetyNumber(pubA, pubB) {
  const [a, b] = [b64u.enc(pubA), b64u.enc(pubB)].sort();
  const h = await sha256(te.encode(a + "|" + b));
  let n = 0n; for (const x of h) n = (n << 8n) | BigInt(x);
  const s = n.toString().padStart(60, "0").slice(-60);
  return s.match(/.{5}/g).join(" ");
}
export async function tagOf(pubRaw) { return b64u.enc((await sha256(pubRaw)).slice(0, 3)).slice(0, 4).toUpperCase(); }

// ── Stockage local (IndexedDB) ────────────────────────────────────────────────────
// Tables : kv (identité, réglages), contacts, messages (par contact), outbox (à livrer).
export const DB = "krypty2-v2", VER = 1;
let _db;
export function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("kv");
      d.createObjectStore("contacts", { keyPath: "id" });
      const m = d.createObjectStore("messages", { keyPath: "id" }); m.createIndex("byContact", "contact");
      d.createObjectStore("outbox", { keyPath: "id" }).createIndex("byContact", "contact");
      d.createObjectStore("carry", { keyPath: "id" });    // blobs portés pour des tiers
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
const tx = async (store, mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); /* get() absent → undefined */ t.onerror = () => rej(t.error); }); };
export const kv = {
  get: (k) => tx("kv", "readonly", s => s.get(k)),
  set: (k, v) => tx("kv", "readwrite", s => s.put(v, k)),
  del: (k) => tx("kv", "readwrite", s => s.delete(k)),
};
export const store = {
  put: (table, obj) => tx(table, "readwrite", s => s.put(obj)),
  del: (table, id) => tx(table, "readwrite", s => s.delete(id)),
  get: (table, id) => tx(table, "readonly", s => s.get(id)),
  all: (table) => tx(table, "readonly", s => s.getAll()),
  byContact: (table, contact) => tx(table, "readonly", s => s.index("byContact").getAll(contact)),
};

// ── Identité ──────────────────────────────────────────────────────────────────────
export async function loadOrCreateIdentity(name) {
  let me = await kv.get("me");
  if (me && me.x && me.x.pub && me.e && me.e.pub) return me;
  const x = await genX25519(), e = await genEd25519();
  me = { name: name || "Anonyme", x, e, tag: await tagOf(e.pub), created: Date.now() };
  await kv.set("me", me);
  return me;
}

// ── Contacts ──────────────────────────────────────────────────────────────────────
// contact = { id, name, tag, xpub, epub, verified, inbox: [{relay, box, key(ed jwk), pub}],
//             outbox: [{relay, box}], seen }
// inbox  = boîtes où LUI m'écrit (je possède la clé de lecture)
// outbox = boîtes où J'écris pour lui (je ne connais que l'id)
export async function contactId(xpub) { return b64u.enc((await sha256(xpub)).slice(0, 12)); }
export async function newBox(relay) {
  const k = await genEd25519();
  return { relay, box: b64u.enc(rand(24)), key: k.priv, pub: b64u.enc(k.pub) };
}

// ── Sauvegarde chiffrée (.krypty2) : identité + contacts + relais + messages (sans les fichiers) ──
// Format : "KRYPTY2" ‖ salt16 ‖ iv12 ‖ AES-GCM(PBKDF2-SHA256(pass, 300k), JSON)
async function passKey(pass, salt) {
  const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 300000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function exportBackup(pass) {
  const data = { v: 1, at: Date.now(), me: await kv.get("me"), relays: await kv.get("relays"), welcome: await kv.get("welcome"),
    contacts: await store.all("contacts"), messages: (await store.all("messages")).map(m => { const { blob, ...r } = m; return r; }) };
  const salt = rand(16), iv = rand(12), key = await passKey(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(data))));
  return new Blob([te.encode("KRYPTY2"), salt, iv, ct], { type: "application/octet-stream" });
}
export async function importBackup(file, pass) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  if (td.decode(u8.slice(0, 7)) !== "KRYPTY2") throw new Error("bad-format");
  const key = await passKey(pass, u8.slice(7, 23));
  let data; try { data = JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u8.slice(23, 35) }, key, u8.slice(35)))); } catch { throw new Error("bad-pass"); }
  if (!data.me || !data.me.x) throw new Error("bad-format");
  await kv.set("me", data.me); if (data.relays) await kv.set("relays", data.relays); if (data.welcome) await kv.set("welcome", data.welcome);
  for (const c of data.contacts || []) await store.put("contacts", c);
  for (const m of data.messages || []) if (!(await store.get("messages", m.id))) await store.put("messages", m);
}
export function wipe() { return new Promise((res) => { if (_db) _db.close(); _db = null; const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => res(); }); }
