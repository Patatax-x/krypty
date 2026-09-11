// krypty2/app.js — protocole + interface. « La messagerie qui ne sait pas que vous existez. »
import * as C from "./core.js";
import { RelayPool } from "./relay.js";
import { Link } from "./link.js";
import { Carrier, PeerRelay } from "./carry.js";
import { qrDraw } from "./qr.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtSize = (n) => n < 1024 ? n + " o" : n < 1048576 ? (n / 1024).toFixed(0) + " Ko" : (n / 1048576).toFixed(1) + " Mo";

const S = {
  me: null, contacts: new Map(), links: new Map(), pool: null, active: null,
  relays: [], welcome: new Map(),   // welcome: box -> {key, pub, relay, xpriv}
  presence: new Map(),              // cid -> last hello ts
  pairKeys: new Map(),
  carrier: null,                    // je porte pour mes contacts (carry.js)
  carriers: [],                     // cids des contacts qui portent pour moi (choisis automatiquement)
  pendingInvites: new Map(),        // id d'invitation -> { link, created } : offre en attente d'une réponse
  backupAt: 0,                      // dernière sauvegarde exportée (bandeau de rappel tant qu'il n'y en a pas)
  reply: null, edit: null,          // composeur : message cité / message en cours de modification
  groups: new Map(),                // gid -> { id, name, color, members: [cid, ... moi inclus], creator, seen, last, unread }
};
const N_CARRIERS = 2, INVITE_TTL = 15 * 60 * 1000;
// Serveurs STUN publics, sans état : le navigateur leur demande son adresse publique, rien d'autre.
// Sans eux, deux navigateurs derrière deux box ne peuvent pas se joindre. Toujours actifs.
const STUN = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];

// ═══════════════════════ Démarrage ═══════════════════════
// Ce dont l'app a besoin, testé avant tout : sinon page vide sans explication.
async function supported() {
  try {
    if (!crypto?.subtle || typeof CompressionStream !== "function" || !("RTCPeerConnection" in window) || !("indexedDB" in window)) return false;
    await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]); await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    return true;
  } catch { return false; }
}
async function boot() {
  if (!(await supported())) { $("#onboard").hidden = false; $("#ob-old").hidden = false; $("#ob-start").disabled = true; return; }
  S.relays = (await C.kv.get("relays")); if (!Array.isArray(S.relays)) S.relays = defaultRelays();
  S.me = await C.kv.get("me");
  if (S.me && !(S.me.x && S.me.x.pub && S.me.e && S.me.e.pub)) { await C.kv.del("me"); S.me = null; }   // format inconnu (ancien proto) → ré-onboarding
  if (!S.me) { showOnboard(); return; }
  if (!S.me.id) { S.me.id = await C.contactId(S.me.x.pub); await C.kv.set("me", S.me); }
  try { await start(); } catch (e) { console.error("démarrage", e); toast("Erreur au démarrage : " + e.message, true); }
}
// Aucun point de rendez-vous par défaut : la première connexion passe par un échange de codes.
// En développement local, relay.py sur la même machine pour les tests automatisés.
function defaultRelays() { return ["localhost", "127.0.0.1"].includes(location.hostname) ? ["ws://" + location.hostname + ":8765"] : []; }

async function start() {
  Link.ice = STUN; S.backupAt = (await C.kv.get("backupAt")) || 0;
  S.pool = new RelayPool(onBlob, onRelayState, (cid) => new PeerRelay(cid, (id) => S.links.get(id), onBlob));
  S.carrier = new Carrier((cid, obj) => { const l = S.links.get(cid); return !!(l && l.open && l.send(JSON.stringify(obj))); });
  if (!S.me.pickups) S.me.pickups = {};
  S.carriers = ((await C.kv.get("carriers")) || []).filter(cid => S.me.pickups[cid]);
  for (const c of await C.store.all("contacts")) { try { await ensurePair(c); S.contacts.set(c.id, c); } catch { console.warn("contact illisible ignoré", c.id); } }
  for (const g of await C.store.all("groups")) S.groups.set(g.id, g);
  for (const url of S.relays) S.pool.get(url);
  await subscribeAll();
  // Reprise : ré-enregistrer les boîtes d'accueil encore valables
  const w = ((await C.kv.get("welcome")) || []).filter(b => Date.now() - (b.created || 0) < 7 * 86400000);
  await C.kv.set("welcome", w);
  for (const b of w) { S.welcome.set(b.box, b); S.pool.get(b.relay).subscribe(b.box, b.key, b.pub); }
  await pickCarriers(false);
  renderAll(); $("#btn-new").disabled = false; $("#empty-new").disabled = false;
  setInterval(flushOutbox, 15000);
  setInterval(() => { for (const [i, p] of S.pendingInvites) if (Date.now() - p.created > INVITE_TTL) { p.link.teardown(); S.pendingInvites.delete(i); } }, 60000);
  setInterval(() => broadcast({ t: "hello", ts: Date.now() }), 25000);
  setTimeout(() => broadcast({ t: "hello", ts: Date.now() }), 800);
  setTimeout(flushOutbox, 1500);
  if (location.hash.startsWith("#i/")) { await acceptInvite(location.hash.slice(3)); history.replaceState(null, "", location.pathname); }
}
async function ensurePair(c) {
  if (!S.pairKeys.has(c.id)) S.pairKeys.set(c.id, await C.pairKey(S.me.x.priv, C.b64u.dec(c.xpub)));
  return S.pairKeys.get(c.id);
}
async function subscribeAll() {
  for (const c of S.contacts.values()) for (const ib of c.inbox) S.pool.get(ib.relay).subscribe(ib.box, ib.key, ib.pub);
  for (const [cid, p] of Object.entries(S.me.pickups)) if (p && S.contacts.has(cid)) S.pool.get("peer:" + cid).subscribe(p.box, p.key, p.pub);   // porteurs choisis + boîtes reçues par présentation
}
// ── Porteurs automatiques : mes N contacts les plus récents gardent mes messages quand je suis absent.
// Rien à régler : recalculé à chaque contact ajouté / message échangé ; les contacts reçoivent ma carte.
async function pickCarriers(announce = true) {
  const want = [...S.contacts.values()].filter(c => !c.pending).sort((a, b) => (b.seen || 0) - (a.seen || 0)).slice(0, N_CARRIERS).map(c => c.id);
  const same = want.length === S.carriers.length && want.every((id, i) => id === S.carriers[i]);
  let changed = false;
  for (const cid of want) if (!S.me.pickups[cid]) { const b = await C.newBox("peer:" + cid); S.me.pickups[cid] = { box: b.box, key: b.key, pub: b.pub }; changed = true; }
  if (same && !changed) return;
  S.carriers = want; await C.kv.set("me", S.me); await C.kv.set("carriers", want);
  await subscribeAll(); renderContacts();
  if (announce) for (const c of S.contacts.values()) if (!c.pending) sendTo(c, { t: "card", inbox: myCard(c) });
}
// Une carte reçue vient d'un contact authentifié, mais on borne quand même sa forme.
function sanitizeCard(card) {
  if (!Array.isArray(card)) return [];
  return card.filter(o => o && typeof o.relay === "string" && typeof o.box === "string" && o.box.length < 64 && (o.relay.startsWith("peer:") || S.relays.includes(o.relay))).slice(0, 12).map(o => ({ relay: o.relay, box: o.box }));
}
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function myProfile() { return { t: "profile", name: S.me.name, color: S.me.color, photo: S.me.photo || null, bio: S.me.bio || "", pv: S.me.pv || 0 }; }
// Ce qu'un contact reçoit de moi (nom, couleur, photo, mot) : borné, la source est authentifiée mais pas forcément saine.
function takeProfile(c, p) {
  if (typeof p.name === "string") { c.rname = p.name.slice(0, 24); if (!c.alias) c.name = c.rname; }
  if (typeof p.color === "string") c.color = p.color.slice(0, 9);
  if ("photo" in p) c.photo = (typeof p.photo === "string" && p.photo.length < 40000 && PHOTO_RE.test(p.photo)) ? p.photo : null;
  if (typeof p.bio === "string") c.bio = p.bio.slice(0, 80);
}
// Ma carte de visite dans une intro / intro-ack
const myIntro = (c) => ({ name: S.me.name, tag: S.me.tag, color: S.me.color, photo: S.me.photo || null, bio: S.me.bio || "", epub: C.b64u.enc(S.me.e.pub), inbox: myCard(c) });
const helloFor = (c, reply = false) => ({ t: "hello", ts: Date.now(), reply, card: myCard(c), name: S.me.name, color: S.me.color, pv: S.me.pv || 0 });
// Envoi fiable : reste dans l'outbox jusqu'à l'ack du destinataire.
async function sendReliable(c, env) {
  if (!env.id) env.id = C.uid();
  const r = await sendTo(c, env); await C.store.put("outbox", { id: env.id, contact: c.id, env, posted: r.posted, at: Date.now() }); return r;
}
// Ma carte pour un contact : ses boîtes chez mes répondeurs WebSocket + mes boîtes chez mes porteurs
function myCard(c) {
  return [...c.inbox.map(b => ({ relay: b.relay, box: b.box })), ...Object.entries(S.me.pickups).filter(([cid]) => S.contacts.has(cid) && !S.contacts.get(cid).pending).map(([cid, p]) => ({ relay: "peer:" + cid, box: p.box }))];
}

// ═══════════════════════ Réception ═══════════════════════
// Un blob arrive dans une de MES boîtes. Retourne true si traité (→ ack = suppression au répondeur).
async function onBlob(relayUrl, box, mid, blob) {
  try {
    // Boîte d'accueil (invitation) : blob = xpub_acceptant.scellé
    if (S.welcome.has(box)) { await onIntro(S.welcome.get(box), blob); return true; }
    const via = relayUrl.startsWith("peer:") ? "peer" : "relay";
    let c = [...S.contacts.values()].find(x => x.inbox.some(b => b.box === box));
    if (!c && Object.values(S.me.pickups).some(p => p.box === box)) {       // boîte chez un porteur : partagée par tous mes contacts
      for (const x of S.contacts.values()) { try { const env = await C.open(await ensurePair(x), blob); await dispatch(x, env, via); return true; } catch {} }
      return true;                                         // indéchiffrable (contact supprimé ?) : on jette
    }
    if (!c) return true;                                   // boîte inconnue : on jette
    const env = await C.open(await ensurePair(c), blob);
    await dispatch(c, env, via);
    return true;
  } catch (e) { console.warn("blob rejeté", e); return true; }
}
// Une enveloppe peut arriver par plusieurs chemins (rendez-vous + porteurs) : on ne traite qu'une fois.
const _seen = new Set(); let _seenList = [];
function seenBefore(id) {
  if (!id) return false;
  if (_seen.has(id)) return true;
  _seen.add(id); _seenList.push(id);
  if (_seenList.length > 3000) { for (const x of _seenList.splice(0, 1000)) _seen.delete(x); }
  return false;
}
async function dispatch(c, env, via) {
  if (seenBefore(env.id)) return;
  // Un message/action de groupe porte l'id du groupe (string) ; le groupe doit être connu et l'expéditeur
  // en être membre. Sinon on ne l'acquitte pas : l'annonce du groupe arrive peut-être juste après, l'expéditeur
  // repostera. « group » lui-même porte l'annonce (un objet, pas un id) et suit son propre chemin plus bas.
  const GROUP_TYPES = ["msg", "edit", "del", "react", "gleave"];
  const g = GROUP_TYPES.includes(env.t) && typeof env.g === "string" ? S.groups.get(env.g) : null;
  if (GROUP_TYPES.includes(env.t) && !(g && g.members.includes(c.id))) return;
  const conv = g || c, table = g ? "groups" : "contacts";
  if (env.t === "msg") {
    if (await C.store.get("messages", env.id)) return;   // doublon (plusieurs porteurs)
    let re = null;                                       // citation : texte du message local de préférence, l'expéditeur ne peut pas le forger
    if (env.re && typeof env.re.id === "string") { const q = await C.store.get("messages", env.re.id); re = q && q.contact === conv.id ? { id: q.id, text: (q.text || (q.file ? "📎 " + q.file.name : "")).slice(0, 120), out: q.dir === "out", by: q.from } : { id: env.re.id, text: String(env.re.text || "").slice(0, 120), out: !env.re.out }; }
    const ts = Math.min(Number(env.ts) || Date.now(), Date.now() + 300000);
    const file = env.file && typeof env.file === "object" ? { name: String(env.file.name || "fichier").slice(0, 255), size: Math.max(0, Number(env.file.size) || 0) } : null;
    await C.store.put("messages", { id: env.id, contact: conv.id, from: g ? c.id : undefined, dir: "in", ts, text: String(env.text || "").slice(0, 20000), file, re, via });
    conv.seen = Date.now(); conv.last = (g ? c.name + " : " : "") + (String(env.text || "").slice(0, 200) || "📎 " + (file?.name || "fichier"));
    if (S.active !== conv.id || document.hidden) conv.unread = (conv.unread || 0) + 1;
    await C.store.put(table, conv);
    sendTo(c, { t: "ack", ids: [env.id] });
    renderContacts(); if (S.active === conv.id) renderChat();
    notify(conv, (g ? c.name + " : " : "") + (env.text || "")); pickCarriers();
  } else if (env.t === "ack") {
    for (const id of Array.isArray(env.ids) ? env.ids.slice(0, 200) : []) {
      const m = await C.store.get("messages", id);
      if (m && m.dir === "out") { m.acks = m.acks || {}; m.acks[c.id] = Date.now(); const gg = S.groups.get(m.contact); if (!gg || memberContacts(gg).every(x => m.acks[x.id])) m.status = "read"; await C.store.put("messages", m); }
      await C.store.del("outbox", id); await C.store.del("outbox", id + "@" + c.id);
    }
    renderChat();
  } else if (env.t === "hello") {
    if (Date.now() - env.ts > 120000) return;            // hello périmé (resté chez un porteur)
    S.presence.set(c.id, Date.now()); c.online = Date.now();
    const card = sanitizeCard(env.card); if (card.length) c.outbox = card;
    takeProfile(c, { name: env.name, color: env.color });
    if (env.pv && env.pv !== c.pv) sendTo(c, { t: "profile-req" });     // photo changée pendant mon absence
    await C.store.put("contacts", c);
    if (!env.reply) sendTo(c, helloFor(c, true));
    maybeLink(c);
    renderContacts(); if (S.active === c.id) renderChat();
  } else if (env.t === "profile-req") {
    sendTo(c, myProfile());
  } else if (env.t === "profile") {         // nom / couleur / photo / mot changés
    takeProfile(c, env); c.pv = env.pv || c.pv;
    await C.store.put("contacts", c); renderContacts(); if (S.active === c.id) renderChat();
  } else if (["edit", "del", "react"].includes(env.t)) {   // action sur un message existant, acquittée comme un message
    const m = await C.store.get("messages", String(env.ref || ""));
    const mine = m && m.dir === "in" && (!g || m.from === c.id);    // modifier / supprimer : seulement l'auteur
    if (m && m.contact === conv.id) {
      if (env.t === "edit" && mine && !m.deleted) { m.text = String(env.text || "").slice(0, 20000); m.edited = true; }
      else if (env.t === "del" && mine) { if (conv.last && conv.last.endsWith(m.text)) conv.last = "Message supprimé"; m.text = ""; m.file = null; m.blob = null; m.deleted = true; }
      else if (env.t === "react") { m.reacts = m.reacts || {}; delete m.reacts.them; const e = String(env.e || "").slice(0, 8); if (e) m.reacts[c.id] = e; else delete m.reacts[c.id]; }
      await C.store.put("messages", m); await C.store.put(table, conv);
      if (S.active === conv.id) renderChat(); renderContacts();
      sendTo(c, { t: "ack", ids: [env.id] });
    }
  } else if (env.t === "verify") {           // le contact a comparé les symboles de son côté
    c.theyVerified = Date.now(); await C.store.put("contacts", c); sendTo(c, { t: "ack", ids: [env.id] });
    renderContacts(); toast(`${c.name} a vérifié votre liaison de son côté`);
  } else if (env.t === "present") {          // un contact me présente d'autres personnes (cartes + boîtes chez lui)
    if (typeof env.mybox === "string" && env.mybox.length < 64) {
      const p = S.me.pickups[c.id];
      if (!p || p.box !== env.mybox) { S.me.pickups[c.id] = { ...(p || {}), box: env.mybox }; await C.kv.set("me", S.me); S.pool.get("peer:" + c.id).subscribe(env.mybox); }
    }
    const names = [];
    for (const k of Array.isArray(env.cards) ? env.cards.slice(0, 20) : []) {
      try {
        if (!k || typeof k.x !== "string" || typeof k.e !== "string") continue;
        const xp = C.b64u.dec(k.x); if (xp.length !== 32 || C.b64u.dec(k.e).length !== 32) continue;
        const id = await C.contactId(xp); if (id === S.me.id) continue;
        const boxes = sanitizeCard(k.boxes).filter(o => o.relay === "peer:" + c.id);
        const ex = S.contacts.get(id);
        if (ex) { for (const o of boxes) if (!ex.outbox.some(x => x.box === o.box)) ex.outbox.push(o); await C.store.put("contacts", ex); if (!isOnline(ex)) sendTo(ex, helloFor(ex)); continue; }
        const nc = await newContact(id, k.x, { name: k.name, color: k.color, epub: k.e, inbox: boxes }, null, false);
        nc.trust = "presented"; nc.via = c.name; nc.viaVerified = !!k.verified; await C.store.put("contacts", nc);
        names.push(nc.name); sendTo(nc, helloFor(nc));
      } catch {}
    }
    sendTo(c, { t: "ack", ids: [env.id] }); renderContacts();
    if (names.length) toast(`${c.name} t'a présenté ${names.join(", ")}`);
  } else if (env.t === "group") {            // annonce ou mise à jour d'un groupe par son créateur
    const gi = env.g; if (!gi || typeof gi.id !== "string" || gi.id.length > 32 || !Array.isArray(gi.members)) return;
    const ex = S.groups.get(gi.id); if (ex && ex.creator !== c.id) return;
    const photo = typeof gi.photo === "string" && gi.photo.length < 40000 && PHOTO_RE.test(gi.photo) ? gi.photo : null;
    const ng = { ...(ex || { seen: Date.now(), unread: 0, last: "" }), id: gi.id, name: String(gi.name || "Groupe").slice(0, 40), color: typeof gi.color === "string" ? gi.color.slice(0, 9) : COLORS[1], photo,
      members: gi.members.filter(x => typeof x === "string" && x.length < 40).slice(0, 50), creator: c.id, created: Number(gi.created) || Date.now() };
    if (!ng.members.includes(S.me.id)) { if (ex) { S.groups.delete(gi.id); await C.store.del("groups", gi.id); if (S.active === gi.id) S.active = null; } }
    else {
      S.groups.set(gi.id, ng); await C.store.put("groups", ng);
      if (!ex) toast(`${c.name} t'a ajouté au groupe « ${ng.name} »`);
      else if (ex.members.length !== ng.members.length) sysMsg(ng, "Membres mis à jour par " + c.name);
      else if (ex.name !== ng.name) sysMsg(ng, `${c.name} a renommé le groupe « ${ng.name} »`);
      else if (ex.photo !== ng.photo) sysMsg(ng, `${c.name} a changé la photo du groupe`);
    }
    sendTo(c, { t: "ack", ids: [env.id] }); renderAll();
  } else if (env.t === "gleave") {
    const gg = S.groups.get(String(env.g || ""));
    if (gg && gg.members.includes(c.id)) { gg.members = gg.members.filter(x => x !== c.id); await C.store.put("groups", gg); await sysMsg(gg, `${c.name} a quitté le groupe`); }
    sendTo(c, { t: "ack", ids: [env.id] }); renderAll();
  } else if (env.t === "card") {           // le contact a changé ses boîtes / porteurs
    const card = sanitizeCard(env.inbox); if (card.length) { c.outbox = card; await C.store.put("contacts", c); }
  } else if (env.t === "intro-ack") {      // fin de l'invitation côté acceptant
    const wasPending = c.pending;
    takeProfile(c, env); c.epub = env.epub; c.outbox = sanitizeCard(env.inbox); c.pending = false; c.online = Date.now();
    await C.store.put("contacts", c); if (env.id) sendTo(c, { t: "ack", ids: [env.id] });
    renderAll(); if (wasPending) { toast(`${c.name} est maintenant dans ton cercle`); flushOutbox(); pickCarriers(); }
  } else if (["offer", "answer", "ice"].includes(env.t)) {
    if (env.ts && Date.now() - env.ts > 60000) return;   // signalisation périmée (restée chez un porteur)
    await getLink(c).onSignal(env);
  }
}

// ═══════════════════════ Envoi ═══════════════════════
const SHORT = ["hello", "offer", "answer", "ice", "ack", "card", "profile"];   // pas de sens après quelques minutes → TTL court chez un porteur
async function sendTo(c, env, skipRelays = []) {
  const ttl = SHORT.includes(env.t) ? 5 * 60 * 1000 : undefined;
  if (!env.id) env.id = C.uid();
  const key = await ensurePair(c);
  const blob = await C.seal(key, env);
  const l = S.links.get(c.id), posted = [];
  if (l && l.open && l.send(blob)) return { via: "direct", posted };
  // Le cercle d'abord : si un porteur (contact commun, tunnel ouvert) accepte, le point de rendez-vous
  // ne voit pas passer le message. Il ne sert que de secours.
  const peers = c.outbox.filter(o => o.relay.startsWith("peer:")), wss = c.outbox.filter(o => !o.relay.startsWith("peer:"));
  for (const o of peers) {
    if (skipRelays.includes(o.relay)) continue;
    const cid = o.relay.slice(5); if (cid === S.me.id || !S.contacts.has(cid)) continue;   // porteur inconnu de moi : inutilisable
    if (S.pool.get(o.relay).post(o.box, blob, ttl)) posted.push(o.relay);
  }
  const carried = posted.length > 0 || peers.some(o => skipRelays.includes(o.relay));
  if (!carried || env.t !== "msg") for (const o of wss) if (!skipRelays.includes(o.relay) && S.pool.get(o.relay).post(o.box, blob)) posted.push(o.relay);
  return { via: posted.length ? "relay" : "queued", posted };
}
// Présence : « hello » en direct si tunnel, sinon via répondeur au plus une fois / 10 min par
// contact silencieux (sinon des centaines de blobs s'empileraient dans sa boîte pendant son absence).
const _helloAt = new Map();
function broadcast(env) {
  for (const c of S.contacts.values()) {
    if (c.pending) continue;
    const l = S.links.get(c.id);
    const e = env.t === "hello" ? helloFor(c) : env;
    if ((l && l.open) || env.t !== "hello") { sendTo(c, e); continue; }
    const last = _helloAt.get(c.id) || 0, heard = S.presence.get(c.id) || 0;
    if (Date.now() - last < 600000 && Date.now() - heard > 60000) continue;
    if (Date.now() - last < 25000) continue;
    _helloAt.set(c.id, Date.now()); sendTo(c, e);
  }
}
// Conversation active : un contact ou un groupe
const convOf = (id) => S.contacts.get(id) || S.groups.get(id);
const isGroup = (x) => !!(x && Array.isArray(x.members));
const memberContacts = (g) => g.members.filter(id => id !== S.me.id).map(id => S.contacts.get(id)).filter(Boolean);
// Livrer une enveloppe à une conversation : au contact, ou à chaque membre du groupe (chiffrée par paire).
// Reste dans l'outbox jusqu'à l'ack de chacun, même en direct : un tunnel qui meurt accepte encore
// des envois pendant quelques secondes sans les livrer.
async function deliver(conv, env) {
  if (!isGroup(conv)) return (await sendReliable(conv, env)).via;
  env.g = conv.id; const rank = { queued: 0, relay: 1, direct: 2 }; let best = "queued";
  for (const m of memberContacts(conv)) {
    const r = await sendTo(m, env); await C.store.put("outbox", { id: env.id + "@" + m.id, contact: m.id, env, posted: r.posted, at: Date.now() });
    if (rank[r.via] > rank[best]) best = r.via;
  }
  return best;
}
async function sendMessage(text, file) {
  const conv = convOf(S.active); if (!conv || (!text && !file)) return;
  const re = S.reply && S.reply.contact === conv.id ? { id: S.reply.id, text: (S.reply.text || (S.reply.file ? "📎 " + S.reply.file.name : "")).slice(0, 120), out: S.reply.dir === "out" } : null;
  setCompose(null);
  const env = { t: "msg", id: C.uid(), ts: Date.now(), text, file: file ? { name: file.name, size: file.size } : null, re };
  const m = { ...env, contact: conv.id, dir: "out", status: "sending" };
  await C.store.put("messages", m); conv.seen = Date.now(); conv.last = "Toi : " + (text || "📎 " + (file?.name || "")); await C.store.put(isGroup(conv) ? "groups" : "contacts", conv); renderChat(); renderContacts();
  let via;
  if (file) {
    const l = S.links.get(conv.id);
    if (isGroup(conv) || !(l && l.open)) { m.status = "failed"; m.error = isGroup(conv) ? "Pas de fichiers en groupe pour l'instant" : "Les fichiers passent en direct : attends que le contact soit en ligne"; await C.store.put("messages", m); renderChat(); return; }
    l.send(await C.seal(await ensurePair(conv), env));
    await l.sendFile({ id: env.id, name: file.name, size: file.size }, file);
    await C.store.put("outbox", { id: env.id, contact: conv.id, env, posted: [], at: Date.now() }); via = "direct";
  } else via = await deliver(conv, env);
  m.status = via === "queued" ? "queued" : "sent"; m.via = via;
  await C.store.put("messages", m); renderChat();
}
// Modifier / supprimer / réagir : une petite enveloppe qui vise un message par son id, livrée
// comme un message (outbox jusqu'à l'ack), appliquée localement tout de suite.
async function actOnMessage(m, env) {
  const conv = convOf(m.contact); if (!conv) return;
  env.id = C.uid(); env.ref = m.id;
  await C.store.put("messages", m);
  await deliver(conv, env);
  renderChat(); renderContacts();
}
// Message d'information local dans un groupe (arrivées, départs)
async function sysMsg(g, text) { await C.store.put("messages", { id: C.uid(), contact: g.id, dir: "sys", ts: Date.now(), text }); if (S.active === g.id) renderChat(); }
async function editMessage(m, text) { if (m.dir !== "out" || !text.trim()) return; m.text = text.trim(); m.edited = true; await actOnMessage(m, { t: "edit", text: m.text }); }
async function deleteMessage(m) {
  if (m.dir !== "out") return;
  const conv = convOf(m.contact); if (conv && conv.last === "Toi : " + m.text) { conv.last = "Toi : message supprimé"; await C.store.put(isGroup(conv) ? "groups" : "contacts", conv); }
  m.text = ""; m.file = null; m.blob = null; m.deleted = true; await actOnMessage(m, { t: "del" });
}
async function reactMessage(m, e) { m.reacts = m.reacts || {}; if (m.reacts.me === e) e = ""; if (e) m.reacts.me = e; else delete m.reacts.me; await actOnMessage(m, { t: "react", e }); }
// Reprise : tout ce qui n'est pas acquitté est reposté (dédoublonné à l'arrivée par id).
async function flushOutbox() {
  for (const o of await C.store.all("outbox")) {
    const c = S.contacts.get(o.contact); const at = o.at || Date.now();   // pas d'horodatage = tout neuf, jamais « périmé »
    if (!c || Date.now() - at > 15 * 86400000) { await C.store.del("outbox", o.id); continue; }
    if ((o.posted || []).length && Date.now() - at < 8000) continue;   // déjà déposé : laisser le temps à l'ack
    const posted = o.posted || [];
    const r = await sendTo(c, o.env, posted);
    if (r.via === "relay") { o.posted = [...posted, ...r.posted]; await C.store.put("outbox", o); }
    const m = await C.store.get("messages", o.id.split("@")[0]);
    if (m && m.status === "queued" && r.via !== "queued") { m.status = "sent"; m.via = r.via; await C.store.put("messages", m); if (S.active === m.contact) renderChat(); }
  }
}

// ═══════════════════════ Tunnel direct ═══════════════════════
function newLink(cid) {
  const l = new Link(cid,
    (sig) => { const c = S.contacts.get(l.cid); if (c) sendTo(c, { ...sig, id: C.uid(), ts: Date.now() }); },
    (ev) => { const c = S.contacts.get(l.cid); if (c) onLinkEvent(c, ev); },
    (st) => {
      const c = S.contacts.get(l.cid); if (!c) return;
      if (["closed", "failed", "disconnected"].includes(st)) S.presence.delete(c.id);   // tunnel mort = plus « en ligne » tant qu'un hello ne revient pas
      renderContacts(); if (S.active === c.id) renderChat();
      if (st === "open") { l.polite = S.me.id > c.id; c.online = Date.now(); C.store.put("contacts", c); $("#invite").hidden = true; $("#code").hidden = true; setSteps(1); $("#invite-link").value = ""; S.presence.set(c.id, Date.now()); S.carrier.onOpen(c.id); if (S.pool.has("peer:" + c.id)) S.pool.get("peer:" + c.id).resub(); flushOutbox(); toast(`Connecté à ${c.name}`); }
    });
  return l;
}
function getLink(c) {
  if (!S.links.has(c.id)) { const l = newLink(c.id); l.polite = S.me.id > c.id; S.links.set(c.id, l); }   // ordre total → un seul initiateur
  return S.links.get(c.id);
}
function maybeLink(c) {
  const l = getLink(c);
  if (!l.open && !l.polite && !l.pc) l.offer().catch(() => {});
}
async function onLinkEvent(c, ev) {
  if (ev.t === "box") {
    if (ev.m.__box === "msg") { if (S.pool.has("peer:" + c.id)) await S.pool.get("peer:" + c.id).handle(ev.m); }
    else await S.carrier.handle(c.id, ev.m);
    return;
  }
  if (ev.t === "sealed") { try { await dispatch(c, await C.open(await ensurePair(c), ev.blob), "direct"); } catch {} }
  else if (ev.t === "file") {
    if (typeof ev.meta.id !== "string") return;
    const m = await C.store.get("messages", ev.meta.id); if (m && m.contact !== c.id) return;
    if (m) { m.blob = ev.blob; m.file = { name: String(ev.meta.name || "fichier").slice(0, 255), size: ev.blob.size }; await C.store.put("messages", m); if (S.active === c.id) renderChat(); }
    else await C.store.put("messages", { id: ev.meta.id, contact: c.id, dir: "in", ts: Date.now(), text: "", file: { name: String(ev.meta.name || "fichier").slice(0, 255), size: ev.blob.size }, blob: ev.blob, via: "direct" });
    if (S.active === c.id) renderChat();
  } else if (ev.t === "progress") { const el = typeof ev.id === "string" ? $(`[data-id="${CSS.escape(ev.id)}"] .progress`) : null; if (el) el.textContent = `${fmtSize(ev.got)} / ${fmtSize(ev.size)}`; }
}
const isOnline = (c) => (S.links.get(c.id)?.open) || (Date.now() - (S.presence.get(c.id) || 0) < 60000);

// ═══════════════════════ Invitation ═══════════════════════
// Le lien contient : nom, couleur, clés publiques, une offre de connexion directe (valable tant que cet
// onglet est ouvert, 15 min), et, s'il y a un point de rendez-vous, une boîte d'accueil. Le tout signé ;
// la clé de vérification étant dans le lien, la signature protège contre l'altération, pas contre un faux lien.
async function makeInvite() {
  const iid = C.uid(), link = newLink(null);
  const o = await link.offerCode();
  S.pendingInvites.set(iid, { link, created: Date.now() });
  let w = null;
  const relay = S.relays[0];
  if (relay) {
    const wb = await C.newBox(relay);
    S.welcome.set(wb.box, { ...wb, created: Date.now() }); await C.kv.set("welcome", [...S.welcome.values()]);
    S.pool.get(relay).subscribe(wb.box, wb.key, wb.pub); w = { relay, box: wb.box };
  }
  const body = { v: 3, i: iid, name: S.me.name, tag: S.me.tag, c: S.me.color, x: C.b64u.enc(S.me.x.pub), e: C.b64u.enc(S.me.e.pub), w, o };
  body.sig = C.b64u.enc(await C.edSign(S.me.e.priv, await inviteDigest(body)));
  return location.origin + location.pathname + "#i/" + await C.packCode(body);
}
const inviteDigest = (b) => C.sha256(new TextEncoder().encode([b.x, b.e, b.i, b.name || "", b.c || "", b.w ? b.w.relay + "/" + b.w.box : "", b.o || ""].join("|")));
async function acceptInvite(code) {
  let inv; try { inv = await C.unpackCode(code); } catch { toast("Ce lien n'est pas une invitation valide", true); return; }
  if (!inv || inv.v !== 3 || typeof inv.i !== "string" || typeof inv.x !== "string" || typeof inv.e !== "string") { toast("Ce lien n'est pas une invitation valide", true); return; }
  if (inv.w && !(typeof inv.w.relay === "string" && /^wss?:\/\/[^\s/]+$/.test(inv.w.relay) && typeof inv.w.box === "string" && inv.w.box.length < 64)) inv.w = null;
  try { if (C.b64u.dec(inv.x).length !== 32 || C.b64u.dec(inv.e).length !== 32) throw 0; } catch { toast("Ce lien n'est pas une invitation valide", true); return; }
  if (typeof inv.o !== "string") inv.o = null;
  inv.name = String(inv.name || "Anonyme").slice(0, 24); inv.tag = String(inv.tag || "").slice(0, 4); if (typeof inv.c !== "string") inv.c = undefined;
  let ok = false; try { ok = await C.edVerify(C.b64u.dec(inv.e), C.b64u.dec(inv.sig), await inviteDigest(inv)); } catch {}
  if (!ok) { toast("Invitation non signée, refusée", true); return; }
  const xpub = C.b64u.dec(inv.x), id = await C.contactId(xpub);
  if (id === S.me.id) { toast("C'est ta propre invitation", true); return; }
  const known = S.contacts.get(id);
  if (known) {                                   // déjà dans le cercle : le lien sert à se reconnecter en direct
    if (!inv.o) { toast(`${known.name} est déjà dans ton cercle`); return; }
    if (S.links.get(id)?.open) { toast(`Déjà connecté à ${known.name}`); return; }
    const key = await ensurePair(known), l = getLink(known); l.polite = true;
    const a = await l.answerCode(inv.o);
    const code = "KR." + C.b64u.enc(S.me.x.pub) + "." + await C.seal(key, { t: "answer", i: inv.i, a, intro: { t: "intro", ...myIntro(known) } });
    openChat(id); showCode(code, `Renvoie ce code à ${known.name} : vous serez reconnectés en direct.`, "Ta réponse à " + known.name);
    return;
  }
  if (!(await askAccept(inv))) return;
  // Le point de rendez-vous de l'invitation devient aussi le mien : sans ça, celui qui rejoint sans
  // rien n'aurait aucune boîte où recevoir la réponse.
  if (inv.w && !S.relays.includes(inv.w.relay) && S.relays.length < 4) { S.relays.push(inv.w.relay); await C.kv.set("relays", S.relays); for (const x of S.contacts.values()) x.inbox.push(await C.newBox(inv.w.relay)); }
  // Mes boîtes où IL m'écrira : une par point de rendez-vous
  const c = await newContact(id, inv.x, { name: inv.name, tag: inv.tag, color: inv.c, epub: inv.e, inbox: [] }, null, true);
  c.trust = "link"; await C.store.put("contacts", c);
  const key = await ensurePair(c);
  const intro = { t: "intro", ...myIntro(c) };
  if (inv.w) S.pool.get(inv.w.relay).post(inv.w.box, C.b64u.enc(S.me.x.pub) + "." + await C.seal(key, intro));
  renderAll(); openChat(id);
  if (inv.o) {                                   // réponse directe : à renvoyer par n'importe quel canal
    const l = getLink(c); l.polite = true;
    const a = await l.answerCode(inv.o);
    const code = "KR." + C.b64u.enc(S.me.x.pub) + "." + await C.seal(key, { t: "answer", i: inv.i, a, intro });
    showCode(code, `Renvoie ce code à ${inv.name}, par le même canal. Dès qu'elle ou il le colle, vous êtes reliés en direct.`, "Ta réponse à " + inv.name);
  } else toast(`Demande envoyée à ${inv.name}, en attente de sa réponse`);
}
// Un contact entre dans le cercle : boîtes d'entrée chez mes points de rendez-vous, profil borné.
// pending = j'attends encore sa réponse (invitation envoyée par lien).
async function newContact(id, xpub, intro, key, pending = false) {
  const inbox = []; for (const r of S.relays) inbox.push(await C.newBox(r));
  const c = { id, name: "Anonyme", tag: String(intro.tag || "").slice(0, 4), xpub, epub: String(intro.epub || ""), inbox, outbox: sanitizeCard(intro.inbox), pending, seen: Date.now(), added: Date.now() };
  takeProfile(c, intro);
  S.contacts.set(id, c); if (key) S.pairKeys.set(id, key); await C.store.put("contacts", c); await subscribeAll();
  return c;
}
async function onIntro(w, blob) {
  const [xs, sealed] = blob.split("."); if (!sealed) return;
  const xpub = C.b64u.dec(xs), id = await C.contactId(xpub);
  const key = await C.pairKey(S.me.x.priv, xpub);
  const intro = await C.open(key, sealed); if (intro.t !== "intro") return;
  if (S.contacts.has(id)) return;
  const c = await newContact(id, xs, intro, key); c.trust = "link"; await C.store.put("contacts", c);
  // L'intro-ack passe par l'outbox comme un message : reposté jusqu'à l'ack de l'autre côté
  // (son porteur peut être injoignable à cet instant, ou mon onglet fermé juste après).
  await sendReliable(c, { t: "intro-ack", ...myIntro(c) });
  // boîte d'accueil consommée
  S.welcome.delete(w.box); await C.kv.set("welcome", [...S.welcome.values()]);
  renderAll(); toast(`${c.name} a rejoint ton cercle`); if (!S.active) openChat(c.id); pickCarriers();
}
// Code de réponse KR : à une invitation (nouveau contact + tunnel) ou à un lien de reconnexion (tunnel seul).
async function acceptCode(text) {
  const m = text.trim().match(/\bKR\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/); if (!m) return false;
  const [, who, sealed] = m;
  try {
    const xpub = C.b64u.dec(who), id = await C.contactId(xpub), key = await C.pairKey(S.me.x.priv, xpub);
    const env = await C.open(key, sealed); const p = S.pendingInvites.get(env.i);
    if (!p) { toast("Cette invitation n'est plus valable (onglet rechargé ou plus de 15 min). Refais un lien.", true); return true; }
    const intro = env.intro || {};
    let c = S.contacts.get(id);
    if (!c) {
      c = await newContact(id, who, intro, key); c.trust = "link"; await C.store.put("contacts", c);
      await C.store.put("outbox", { id: C.uid(), contact: c.id, env: { t: "intro-ack", id: C.uid(), ...myIntro(c) }, posted: [], at: Date.now() });
    }
    S.pendingInvites.delete(env.i); S.links.get(id)?.teardown();
    p.link.cid = id; p.link.polite = S.me.id > id; S.links.set(id, p.link);
    await p.link.acceptAnswer(env.a);
    renderAll(); openChat(id); toast(`Connexion avec ${c.name}…`); pickCarriers();
  } catch { toast("Code illisible ou pas pour toi", true); }
  return true;
}

// ═══════════════════════ Présentations et groupes ═══════════════════════
// La carte d'un contact telle que je la connais, plus une boîte chez moi où l'autre pourra lui écrire.
const cardOf = (c, box) => ({ id: c.id, x: c.xpub, e: c.epub, name: c.rname || c.name, color: c.color, verified: !!c.verified, boxes: box ? [{ relay: "peer:" + S.me.id, box }] : [] });
// Présenter a et b : chacun reçoit la carte de l'autre. Ils se joignent d'abord par moi (boîtes chez moi),
// échangent leurs cartes, puis ouvrent leur tunnel direct. Aucun code.
async function present(a, b) {
  if (a.id === b.id || a.pending || b.pending) return;
  const boxA = await S.carrier.boxFor(a.id), boxB = await S.carrier.boxFor(b.id);
  await sendReliable(a, { t: "present", by: S.me.name, mybox: boxA, cards: [cardOf(b, boxB)] });
  await sendReliable(b, { t: "present", by: S.me.name, mybox: boxB, cards: [cardOf(a, boxA)] });
}
const groupEnv = (g) => ({ id: g.id, name: g.name, color: g.color, photo: g.photo || null, members: g.members, creator: g.creator, created: g.created });
async function createGroup(name, memberIds) {
  const g = { id: C.uid(), name, color: COLORS[Math.floor(Math.random() * COLORS.length)], photo: null, members: [S.me.id, ...memberIds], creator: S.me.id, created: Date.now(), seen: Date.now(), last: "", unread: 0 };
  S.groups.set(g.id, g); await C.store.put("groups", g);
  await announceGroup(g, memberIds); renderAll(); openChat(g.id);
}
async function addToGroup(g, memberIds) {
  const add = memberIds.filter(id => !g.members.includes(id)); if (!add.length) return;
  g.members.push(...add); await C.store.put("groups", g);
  await sysMsg(g, "Ajouté : " + add.map(id => S.contacts.get(id)?.name).filter(Boolean).join(", "));
  await announceGroup(g, add); renderAll();
}
// Tous les membres reçoivent le groupe ; chaque nouveau membre est présenté à chacun des autres.
async function announceGroup(g, newIds) {
  const members = memberContacts(g);
  for (const m of members) await sendReliable(m, { t: "group", g: groupEnv(g) });
  for (const nid of newIds) for (const m of members) if (m.id !== nid) { const n = S.contacts.get(nid); if (n) await present(n, m); }
}
// Nom, couleur, photo : réservés au créateur, comme les membres. Chaque membre reçoit la nouvelle version.
async function updateGroup(g, patch) {
  Object.assign(g, patch); await C.store.put("groups", g);
  for (const m of memberContacts(g)) await sendReliable(m, { t: "group", g: groupEnv(g) });
  renderAll();
}
async function leaveGroup(g) {
  for (const m of memberContacts(g)) await sendReliable(m, g.creator === S.me.id ? { t: "group", g: groupEnv({ ...g, members: g.members.filter(x => x !== S.me.id) }) } : { t: "gleave", g: g.id });
  for (const m of await C.store.byContact("messages", g.id)) await C.store.del("messages", m.id);
  S.groups.delete(g.id); await C.store.del("groups", g.id); if (S.active === g.id) S.active = null; renderAll();
}
// Liste à cocher de contacts (présentation, groupe)
function pickList(ul, contacts, note = () => "") {
  ul.innerHTML = contacts.map(c => `<li><input type="checkbox" value="${esc(c.id)}" id="pk-${esc(c.id)}"><label for="pk-${esc(c.id)}" class="grow">${esc(c.name)}</label><span class="mini">${esc(note(c))}</span></li>`).join("") || `<li class="mini">Personne d'autre dans ton cercle pour l'instant.</li>`;
  ul.querySelectorAll("li").forEach(li => li.onclick = (e) => { const cb = li.querySelector("input"); if (cb && e.target !== cb && e.target.tagName !== "LABEL") cb.checked = !cb.checked; });
}
const picked = (ul) => [...ul.querySelectorAll("input:checked")].map(i => i.value);
function openPresent(c) {
  const others = [...S.contacts.values()].filter(x => x.id !== c.id && !x.pending);
  $("#present-title").textContent = `Présenter ${c.name} à…`; pickList($("#present-list"), others, x => statusOf(x).t); $("#present").hidden = false;
  $("#present-go").onclick = async () => {
    const ids = picked($("#present-list")); if (!ids.length) return; $("#present").hidden = true;
    for (const id of ids) await present(c, S.contacts.get(id));
    toast(`${c.name} présenté à ${ids.map(id => S.contacts.get(id)?.name).join(", ")}`);
  };
}
function openGroupModal(g = null) {
  const pool = [...S.contacts.values()].filter(x => !x.pending && !(g && g.members.includes(x.id)));
  $("#group-title").textContent = g ? `Ajouter à « ${g.name} »` : "Nouveau groupe"; $("#group-name").hidden = !!g; $("#group-name").value = "";
  $("#group-go").textContent = g ? "Ajouter" : "Créer"; pickList($("#group-list"), pool, x => statusOf(x).t); $("#group").hidden = false; if (!g) $("#group-name").focus();
  $("#group-go").onclick = async () => {
    const ids = picked($("#group-list")); const name = $("#group-name").value.trim();
    if (!ids.length) { toast("Choisis au moins une personne", true); return; }
    if (!g && !name) { toast("Donne un nom au groupe", true); $("#group-name").focus(); return; }
    $("#group").hidden = true; if (g) await addToGroup(g, ids); else await createGroup(name.slice(0, 40), ids);
  };
}
let _gcard = null;
function openGroupCard(g) {
  _gcard = g; const mine = g.creator === S.me.id;
  $("#gcard").hidden = false; $("#gc-name").textContent = g.name; setAv($("#gc-av"), g);
  $("#gc-av").classList.toggle("photo", mine); $("#gc-av").title = mine ? "Changer la photo du groupe" : "";
  $("#gc-edit").hidden = !mine; $("#gc-photo-rm").hidden = !(mine && g.photo);
  if (mine) {
    swatches($("#gc-colors"), g.color, (col) => updateGroup(g, { color: col }));
    $("#gc-rename").onclick = async () => {
      const name = $("#gc-rename-in").value.trim().slice(0, 40); if (!name || name === g.name) return;
      await updateGroup(g, { name }); await sysMsg(g, `Groupe renommé « ${name} »`); $("#gc-name").textContent = name; toast("Groupe renommé");
    };
    $("#gc-rename-in").value = g.name; $("#gc-rename-in").onkeydown = (e) => { if (e.key === "Enter") $("#gc-rename").click(); };
    $("#gc-photo-rm").onclick = async () => { await updateGroup(g, { photo: null }); setAv($("#gc-av"), g); $("#gc-photo-rm").hidden = true; };
  }
  const ms = memberContacts(g), on = ms.filter(isOnline).length;
  $("#gc-state").textContent = `${g.members.length} membres · ${on} en ligne` + (g.creator === S.me.id ? " · créé par toi" : ` · créé par ${S.contacts.get(g.creator)?.name || "un membre parti"}`);
  const rows = [[`<i>🟢</i><span>Toi</span>`]].concat(ms.map(c => [`<i>${statusOf(c).k === "off" ? "🌙" : "🟢"}</i><span>${esc(c.name)} <span class="trust">${statusOf(c).t}${c.verified ? " · vérifié" : c.trust === "presented" ? " · présenté par " + esc(c.via || "") : ""}</span></span>`]))
    .concat(g.members.filter(id => id !== S.me.id && !S.contacts.has(id)).map(() => [`<i>❔</i><span>Un membre que tu ne connais pas encore <span class="trust">(présentation en attente)</span></span>`]));
  $("#gc-members").innerHTML = rows.map(r => `<li>${r[0]}</li>`).join("");
  $("#gc-add").hidden = !mine;
  $("#gc-add").onclick = () => { $("#gcard").hidden = true; openGroupModal(g); };
  $("#gc-leave").onclick = async () => { if (confirm(`Quitter « ${g.name} » ? Les messages du groupe seront effacés ici.`)) { $("#gcard").hidden = true; await leaveGroup(g); } };
}

// ═══════════════════════ UI ═══════════════════════
const $$ = (s) => [...document.querySelectorAll(s)];
const COLORS = ["#30D158", "#0A84FF", "#BF5AF2", "#FF9F0A", "#FF375F", "#64D2FF", "#FFD60A", "#AC8E68"];
const colorOf = (o) => o?.color || COLORS[0];
const initials = (n) => String(n || "?").trim().slice(0, 2).toUpperCase();
function setAv(el, o) {
  el.style.setProperty("--c", colorOf(o));
  const keep = el.querySelector("input");          // (réglages : l'input file vit dans l'avatar)
  el.textContent = o?.photo ? "" : initials(o?.name);
  if (o?.photo) { const img = document.createElement("img"); img.alt = ""; img.src = o.photo; el.appendChild(img); }
  if (keep) el.appendChild(keep);
}
function swatches(container, current, onPick) {
  container.innerHTML = COLORS.map(c => `<button type="button" class="swatch${c === current ? " sel" : ""}" style="background:${c}" data-c="${c}" role="radio" aria-checked="${c === current}" aria-label="couleur"></button>`).join("");
  container.querySelectorAll(".swatch").forEach(b => b.onclick = () => { container.querySelectorAll(".swatch").forEach(x => x.classList.toggle("sel", x === b)); onPick(b.dataset.c); });
}
let _obColor = COLORS[Math.floor(Math.random() * COLORS.length)];
async function showOnboard() {
  $("#onboard").hidden = false; $("#app").hidden = true; $("#btn-new").disabled = true; $("#empty-new").disabled = true;   // pas d'invitation avant la fin du démarrage
  if (location.hash.startsWith("#i/")) {                       // arrivé par un lien : on montre qui invite
    try { const inv = await C.unpackCode(location.hash.slice(3)); if (inv && inv.v === 3) { $("#ob-inv-name").textContent = String(inv.name || "Quelqu'un").slice(0, 24); setAv($("#ob-inv-av"), { name: inv.name, color: inv.c }); $("#ob-invited").hidden = false; } } catch {}
  }
  const preview = () => setAv($("#ob-preview"), { name: $("#ob-name").value || "?", color: _obColor });
  swatches($("#ob-colors"), _obColor, (c) => { _obColor = c; preview(); }); preview();
  $("#ob-name").oninput = preview;
  $("#ob-name").onkeydown = (e) => { if (e.key === "Enter") $("#ob-go").click(); };
  $("#ob-start").onclick = () => { obPage(2); $("#ob-name").focus(); };
  $("#ob-go").onclick = async () => {
    const name = $("#ob-name").value.trim() || "Anonyme";
    $("#ob-go").disabled = true; $("#ob-go").textContent = "Création de la clé…";
    S.me = await C.loadOrCreateIdentity(name);
    S.me.id = await C.contactId(S.me.x.pub); S.me.color = _obColor; await C.kv.set("me", S.me);
    setAv($("#ob-done"), S.me); $("#ob-done-title").textContent = `${S.me.name}, ta clé est prête`;
    const inv = $("#ob-inv-name").textContent; if (!$("#ob-invited").hidden) $("#ob-enter").textContent = `Rejoindre ${inv}`;
    obPage(3); $("#ob-enter").focus();
  };
  $("#ob-enter").onclick = async () => { $("#ob-enter").disabled = true; await start(); };
  $("#ob-import").onclick = (e) => { e.preventDefault(); $("#import-file").click(); };
}
function obPage(n) {
  $$("#onboard .page").forEach(p => p.classList.toggle("on", p.dataset.page === String(n)));
  $$("#onboard .dots li").forEach((d, i) => { d.classList.toggle("on", i + 1 === n); d.classList.toggle("done", i + 1 < n); });
}
function renderAll() {
  $("#onboard").hidden = true; $("#app").hidden = false;
  $("#me-name").textContent = S.me.name; setAv($("#me-av"), S.me); $("#app").style.setProperty("--me", colorOf(S.me));
  renderContacts(); renderChat();
}
// Thème : auto (système), sombre ou clair. Lu avant le premier rendu par le petit script de index.html.
function applyTheme(t) {
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { if (t === "dark" || t === "light") localStorage.setItem("theme", t); else localStorage.removeItem("theme"); } catch {}
  $$("#theme button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.v === (t || "auto"))));
  const light = t === "light" || (t !== "dark" && matchMedia("(prefers-color-scheme: light)").matches);
  document.querySelector('meta[name="theme-color"]').content = light ? "#F2F4F1" : "#0D0D0F";
}
const curTheme = () => document.documentElement.dataset.theme || "auto";
const fmtDate = (ts) => new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 90 ? "à l'instant" : s < 3600 ? `il y a ${Math.round(s / 60)} min` : s < 86400 ? `il y a ${Math.round(s / 3600)} h` : `le ${fmtDate(ts)}`; };
function statusOf(c) {
  if (isGroup(c)) { const ms = memberContacts(c), on = ms.filter(isOnline).length; return { k: on ? "relay" : "off", t: `${on}/${ms.length} en ligne` }; }
  const l = S.links.get(c.id);
  if (c.pending) return { k: "off", t: "en attente de sa réponse" };
  if (l?.open) return { k: "direct", t: "⚡ en direct" };
  if (isOnline(c)) return { k: "relay", t: "en ligne" };
  return { k: "off", t: c.online ? "vu " + ago(c.online) : "hors ligne" };
}
function renderContacts() {
  const ul = $("#contacts"); ul.innerHTML = "";
  const q = ($("#search").value || "").trim().toLowerCase();
  const list = [...S.contacts.values(), ...S.groups.values()].filter(c => !q || c.name.toLowerCase().includes(q)).sort((a, b) => (b.seen || 0) - (a.seen || 0));
  if (!S.contacts.size) ul.innerHTML = `<li class="empty">Personne encore.<br>Le bouton <b>＋ Nouveau</b> crée un lien à envoyer.</li>`;
  else if (!list.length) ul.innerHTML = `<li class="empty">Aucun contact ne correspond.</li>`;
  for (const c of list) {
    const li = document.createElement("li"); li.className = "contact" + (S.active === c.id ? " active" : "") + (c.unread ? " unread" : "");
    const st = statusOf(c), grp = isGroup(c);
    const sub = c.pending ? st.t : (c.last ? esc(c.last) : st.t);
    const badge = grp ? "" : c.verified ? ' <span class="tag" title="vérifié">✓</span>' : c.trust === "presented" ? ` <span class="trust" title="présenté par ${esc(c.via || "")}">via ${esc(c.via || "")}</span>` : "";
    li.innerHTML = `<span class="av${st.k !== "off" && !grp ? " on" : ""}${grp ? " grp" : ""}"></span><div class="cbody"><div class="cname">${esc(c.name)}${badge}</div><div class="cst${st.k === "direct" ? " on" : ""}">${sub}</div></div>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}`;
    setAv(li.querySelector(".av"), c);
    li.onclick = () => openChat(c.id);
    ul.appendChild(li);
  }
  // État « hors ligne » sans jargon : est-ce que quelqu'un garde mes messages quand je suis absent ?
  const carriersOn = S.carriers.filter(cid => S.links.get(cid)?.open).length, ws = S.pool && S.pool.wsOpen();
  const ok = ws || carriersOn > 0;
  $("#relay-dot").className = "dot" + (ok ? " on" : "");
  $("#relay-txt").textContent = ok ? "Prêt" : S.contacts.size ? "Hors ligne : tes messages partiront au retour d'un contact" : "Ajoute un contact pour commencer";
  $("#side-foot").title = ok ? "Tes messages en attente sont gardés chiffrés" + (carriersOn ? " par " + S.carriers.filter(cid => S.links.get(cid)?.open).map(cid => S.contacts.get(cid)?.name).join(", ") : " par un point de rendez-vous") : "";
  // Rappel de sauvegarde : dès qu'il y a quelque chose à perdre, jusqu'à la première sauvegarde (ou « plus tard » : une semaine)
  let later = 0; try { later = Number(localStorage.getItem("nudgeLater")) || 0; } catch {}
  $("#nudge").hidden = !(S.contacts.size && !S.backupAt && Date.now() - later > 7 * 86400000);
}
async function openChat(id) {
  if (S.active !== id) { setCompose(null); hideActions(); $("#input").value = ""; }
  S.active = id; const c = convOf(id);
  if (c && c.unread) { c.unread = 0; await C.store.put(isGroup(c) ? "groups" : "contacts", c); }
  $("#app").classList.add("in-chat");
  renderContacts(); renderChat(); $("#input").focus();
}
function onRelayState() { renderContacts(); }
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;
const linkify = (escaped) => escaped.replace(URL_RE, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const dayKey = (ts) => new Date(ts).toDateString();
const fmtDay = (ts) => { const d = new Date(ts), t = new Date(); return dayKey(ts) === dayKey(t) ? "Aujourd'hui" : d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }); };
let _renderSeq = 0;
async function renderChat() {
  const c = convOf(S.active); const box = $("#messages"); const grp = isGroup(c);
  $("#chat-empty").hidden = !!c; $("#chat-view").hidden = !c;
  if (!c) return;
  $("#chat-title").textContent = c.name; setAv($("#chat-av"), c); $("#chat-av").classList.toggle("grp", grp);
  const st = statusOf(c);
  $("#chat-pill").textContent = st.t; $("#chat-pill").className = "pill " + st.k;
  $("#chat-sub").textContent = grp ? `${c.members.length} membres, chiffré pour chacun` : c.pending ? "en attente : elle ou il doit coller ton code de réponse" : st.k === "direct" ? "connexion directe, fichiers sans limite" : st.k === "relay" ? "chiffré de bout en bout" : "tes messages partiront dès sa prochaine connexion";
  $("#attach").classList.toggle("off", st.k !== "direct");
  const seq = ++_renderSeq;
  const msgs = (await C.store.byContact("messages", c.id)).sort((a, b) => a.ts - b.ts);
  if (seq !== _renderSeq) return;
  hideActions(); box.innerHTML = ""; let lastDay = null;
  const pos = (i) => {                           // même expéditeur à moins de 3 min : bulles groupées
    const m = msgs[i], p = msgs[i - 1], n = msgs[i + 1];
    const same = (x, y) => x.dir === y.dir && x.from === y.from && Math.abs(x.ts - y.ts) < 180000 && dayKey(x.ts) === dayKey(y.ts);
    const a = p && same(p, m), b = n && same(n, m);
    return (a && b ? "mid" : a ? "last" : b ? "first" : "only") + (a ? "" : " gap");
  };
  msgs.forEach((m, i) => {
    if (dayKey(m.ts) !== lastDay) { lastDay = dayKey(m.ts); const d = document.createElement("div"); d.className = "day"; d.textContent = fmtDay(m.ts); box.appendChild(d); }
    if (m.dir === "sys") { const d = document.createElement("div"); d.className = "msg sys"; d.textContent = m.text; box.appendChild(d); return; }
    const d = document.createElement("div"); d.className = `msg ${m.dir} ${pos(i)}` + (m.status === "failed" ? " failed" : "") + (m.deleted ? " deleted" : ""); d.dataset.id = m.id;
    const author = m.dir === "in" ? (grp ? S.contacts.get(m.from) : c) : null;
    if (author) d.style.setProperty("--c", colorOf(author));
    const quotedBy = m.re ? (m.re.out ? "Toi" : esc((grp ? S.contacts.get(m.re.by)?.name : c.name) || "Membre")) : "";
    let body = grp && author && /first|only/.test(pos(i)) ? `<span class="who">${esc(author.name)}</span>` : "";
    if (m.re) body += `<span class="quote" data-go="${esc(m.re.id)}"><b>${quotedBy}</b><span>${esc(m.re.text) || "…"}</span></span>`;
    if (m.deleted) body += `<span class="txt">Message supprimé</span>`;
    else if (m.text) body += `<span class="txt">${linkify(esc(m.text))}</span>`;
    if (m.file) body += `<span class="file">📎 <span>${esc(m.file.name)} · ${fmtSize(m.file.size)}</span> ${m.blob ? `<a href="#" data-dl="${m.id}">enregistrer</a>` : `<span class="progress mini">${m.dir === "in" ? "réception…" : ""}</span>`}</span>`;
    const stx = m.dir === "out" ? ({ sending: "⏱", queued: "⏳", sent: "✓", read: "✓✓", failed: "✗" }[m.status] || "") : "";
    const title = m.dir === "out" ? ({ sending: "envoi…", queued: "en attente d'un contact en ligne", sent: "déposé", read: "lu", failed: "échec" }[m.status] || "") : "";
    const rx = Object.entries(m.reacts || {}).filter(([, e]) => e);
    const reacts = rx.length ? `<span class="reacts">${rx.map(([who, e]) => `<span class="${who === "me" ? "me" : ""}" title="${who === "me" ? "toi" : esc(S.contacts.get(who)?.name || c.name)}">${esc(e)}</span>`).join("")}</span>` : "";
    d.innerHTML = `${body}${reacts}<span class="meta" title="${title}">${m.edited && !m.deleted ? "modifié · " : ""}${m.via === "direct" ? "⚡" : ""}${fmtTime(m.ts)} ${stx}</span>${m.error ? `<span class="err">${esc(m.error)}</span>` : ""}`;
    d.onclick = (e) => { if (e.target.closest("a")) return; showActions(m, d); };
    box.appendChild(d);
  });
  box.querySelectorAll("[data-dl]").forEach(a => a.onclick = async (e) => { e.preventDefault(); e.stopPropagation(); const m = await C.store.get("messages", a.dataset.dl); const u = URL.createObjectURL(m.blob); const x = document.createElement("a"); x.href = u; x.download = m.file.name; x.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); });
  box.querySelectorAll("[data-go]").forEach(q => q.onclick = (e) => { e.stopPropagation(); const t = box.querySelector(`[data-id="${CSS.escape(q.dataset.go)}"]`); if (t) { t.scrollIntoView({ block: "center", behavior: "smooth" }); t.classList.add("sel"); setTimeout(() => t.classList.remove("sel"), 1200); } });
  box.scrollTop = box.scrollHeight;
}
// Barre d'actions d'un message (réagir, répondre, copier, modifier, supprimer), au clic sur la bulle.
let _actMsg = null;
function showActions(m, el) {
  const bar = $("#msg-actions"), box = $("#chat-view");
  if (_actMsg === m.id && !bar.hidden) { hideActions(); return; }
  hideActions(); _actMsg = m.id; el.classList.add("sel");
  bar.classList.toggle("theirs", m.dir !== "out" || m.deleted || !!m.file);
  bar.querySelector('[data-act="edit"]').hidden = m.dir !== "out" || m.deleted || !!m.file;
  bar.querySelector('[data-act="del"]').hidden = m.dir !== "out" || m.deleted;
  bar.hidden = false;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(), w = bar.offsetWidth;
  bar.style.top = Math.max(4, r.top - b.top - bar.offsetHeight - 6) + "px";
  bar.style.left = Math.max(8, Math.min(b.width - w - 8, (m.dir === "out" ? r.right - b.left - w : r.left - b.left))) + "px";
  bar.onclick = async (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    const msg = await C.store.get("messages", m.id); hideActions(); if (!msg) return;
    if (btn.dataset.act === "react") reactMessage(msg, btn.dataset.e);
    else if (btn.dataset.act === "reply") setCompose({ kind: "reply", m: msg });
    else if (btn.dataset.act === "copy") { try { await navigator.clipboard.writeText(msg.text || ""); toast("Texte copié"); } catch {} }
    else if (btn.dataset.act === "edit") setCompose({ kind: "edit", m: msg });
    else if (btn.dataset.act === "del") { if (confirm("Supprimer ce message chez vous deux ?")) deleteMessage(msg); }
  };
}
function hideActions() { $("#msg-actions").hidden = true; $$("#messages .msg.sel").forEach(x => x.classList.remove("sel")); _actMsg = null; }
// Composeur en mode « réponse à » ou « modification de »
function setCompose(ctx) {
  S.reply = ctx?.kind === "reply" ? ctx.m : null; S.edit = ctx?.kind === "edit" ? ctx.m : null;
  $("#compose-ctx").hidden = !ctx;
  if (!ctx) return;
  const c = convOf(ctx.m.contact), who = isGroup(c) ? S.contacts.get(ctx.m.from) : c;
  $("#ctx-title").textContent = ctx.kind === "edit" ? "Modifier" : "Répondre à " + (ctx.m.dir === "out" ? "toi-même" : who?.name || "");
  $("#ctx-text").textContent = ctx.m.text || (ctx.m.file ? "📎 " + ctx.m.file.name : "");
  if (ctx.kind === "edit") { $("#input").value = ctx.m.text; $("#input").dispatchEvent(new Event("input")); }
  $("#input").focus();
}
let _toastT;
function toast(t, err) { const el = $("#toast"); el.textContent = t; el.className = "show" + (err ? " err" : ""); clearTimeout(_toastT); _toastT = setTimeout(() => el.className = "", 3800); }
function notify(conv, text) { if ((S.active !== conv.id || document.hidden) && "Notification" in window && Notification.permission === "granted") new Notification(conv.name, { body: text || "📎 fichier" }); }
function askAccept(inv) {
  return new Promise((res) => {
    $("#acc-name").textContent = inv.name; setAv($("#acc-av"), { name: inv.name, color: inv.c });
    $("#accept").hidden = false;
    const done = (v) => { $("#accept").hidden = true; res(v); };
    $("#acc-ok").onclick = () => done(true); $("#acc-no").onclick = () => done(false);
  });
}
function showCode(code, text, title = "Code à envoyer") {
  $("#code-title").textContent = title; $("#code-txt").textContent = text; $("#code-val").value = code; $("#code").hidden = false;
  $("#code-share").hidden = !navigator.share;
  navigator.clipboard?.writeText(code).then(() => toast("Code copié")).catch(() => {});
}
function setSteps(n) { [1, 2, 3].forEach(i => { const el = $("#st" + i); el.classList.toggle("on", i === n); el.classList.toggle("done", i < n); }); }
async function share(text, title) { try { await navigator.share({ title, text }); return true; } catch { return false; } }
// Un lien ou un code collé n'importe où dans l'app (hors champ de saisie) est pris en charge.
async function handlePasted(v) {
  v = String(v || "").trim(); if (!v) return false;
  const i = v.indexOf("#i/");
  if (i >= 0) { await acceptInvite(v.slice(i + 3).split(/\s/)[0]); return true; }
  return acceptCode(v);
}
// Une seule chose à la fois : on arrive ici depuis « Nouveau » avec un choix précis, pas d'onglet vers l'autre.
function openInvite(tab) {
  $("#invite").hidden = false;
  $("#invite-title").textContent = tab === "inv-join" ? "J'ai reçu un lien ou un code" : "Relier quelqu'un";
  $("#inv-make").hidden = tab !== "inv-make"; $("#inv-join").hidden = tab !== "inv-join";
  if (tab === "inv-make" && !$("#invite-link").value) { setSteps(1); $("#invite-new").click(); }
  $("#invite-share").hidden = !navigator.share;
  if (tab === "inv-join") $("#paste").focus();
}
// La fiche explique la liaison sans jargon : depuis quand, par où, qui garde quoi.
function howLinked(c) {
  const st = statusOf(c), rows = [];
  if (c.pending) rows.push(["⏳", "Invitation envoyée, en attente de son code de réponse."]);
  else if (c.trust === "presented") rows.push(["🤝", `Présenté par ${c.via || "un contact"} le ${fmtDate(c.added || Date.now())}${c.viaVerified ? ", qui l'avait vérifié" : ""}. Vous ne vous êtes encore rien envoyé par lien.`]);
  else rows.push(["🔗", `Dans ton cercle depuis le ${fmtDate(c.added || c.seen || Date.now())}, par un lien d'invitation.`]);
  if (st.k === "direct") rows.push(["⚡", "Connectés en direct, de navigateur à navigateur : messages et fichiers ne passent par personne."]);
  else if (st.k === "relay") rows.push(["🟢", "En ligne. Vos messages passent chiffrés par un contact commun, le temps d'ouvrir une connexion directe."]);
  else if (!c.pending) rows.push(["🌙", `Hors ligne${c.online ? ", vu " + ago(c.online) : ""}. Tes messages attendent chiffrés chez vos contacts communs, ou chez toi jusqu'à son retour. Pour le joindre tout de suite : envoie-lui un nouveau lien d'invitation, il te renvoie un code.`]);
  const mine = S.carriers.map(cid => S.contacts.get(cid)?.name).filter(Boolean);
  if (mine.includes(c.name)) rows.push(["📦", `${c.name} garde tes messages quand tu es absent. Impossible pour ${c.name} de les lire.`]);
  if ((c.outbox || []).some(o => o.relay === "peer:" + S.me.id)) rows.push(["🤝", `Tu gardes ses messages quand ${c.name} est absent, chiffrés pour ses contacts, illisibles pour toi.`]);
  rows.push([c.verified && c.theyVerified ? "✅" : c.verified || c.theyVerified ? "☑️" : "🔍",
    c.verified && c.theyVerified ? "Vérifié des deux côtés : personne entre vous." : c.verified ? `Tu as vérifié. ${c.name} n'a pas encore confirmé de son côté.` : c.theyVerified ? `${c.name} a vérifié de son côté. Compare et confirme.` : "Pas encore vérifié. À faire une fois, de vive voix ou en visio : symboles ou chiffres."]);
  return rows;
}
async function openContact(id) {
  const c = S.contacts.get(id); if (!c) return;
  $("#contact").hidden = false; $("#ct-name").textContent = c.name; setAv($("#ct-av"), c); $("#ct-state").textContent = statusOf(c).t;
  $("#ct-bio").textContent = c.bio || ""; $("#ct-bio").hidden = !c.bio;
  $("#ct-how").innerHTML = howLinked(c).map(([i, t]) => `<li><i>${i}</i><span>${esc(t)}</span></li>`).join("");
  const vtxt = () => c.verified && c.theyVerified ? "✓ vérifié des deux côtés" : c.verified ? "✓ vérifié par toi" : c.theyVerified ? `${c.name} a confirmé de son côté` : "";
  $("#ct-verified").textContent = vtxt(); $("#ct-verify").hidden = !!c.verified;
  const fp = await C.fingerprint(S.me.x.pub, C.b64u.dec(c.xpub));
  $("#ct-emo").textContent = fp.emoji; $("#ct-digits").textContent = fp.digits;
  $("#ct-verify").onclick = async () => { c.verified = Date.now(); await C.store.put("contacts", c); $("#ct-verified").textContent = vtxt(); $("#ct-verify").hidden = true; renderContacts(); await sendReliable(c, { t: "verify" }); toast(`Vérifié. ${c.name} verra que tu as confirmé.`); };
  $("#ct-present").onclick = () => { $("#contact").hidden = true; openPresent(c); };
  $("#ct-rename").onclick = async () => { const n = prompt("Nom affiché chez toi pour ce contact (vide : son nom à lui) :", c.name); if (n === null) return; c.alias = n.trim().slice(0, 24) || null; c.name = c.alias || c.rname || c.name; await C.store.put("contacts", c); renderAll(); $("#ct-name").textContent = c.name; };
  $("#ct-delete").onclick = async () => {
    if (!confirm(`Retirer ${c.name} de ton cercle ? Les messages échangés seront effacés ici.`)) return;
    for (const m of await C.store.byContact("messages", c.id)) await C.store.del("messages", m.id);
    for (const o of await C.store.byContact("outbox", c.id)) await C.store.del("outbox", o.id);
    await C.store.del("contacts", c.id); S.contacts.delete(c.id); S.links.get(c.id)?.teardown(); S.links.delete(c.id);
    delete S.me.pickups[c.id]; await C.kv.set("me", S.me);
    $("#contact").hidden = true; if (S.active === c.id) S.active = null; renderAll(); pickCarriers();
  };
}
function openSettings() {
  $("#settings").hidden = false; $("#set-name").value = S.me.name; $("#set-bio").value = S.me.bio || "";
  setAv($("#set-av"), S.me); applyTheme(curTheme());
  $("#set-backup").textContent = (S.backupAt ? `Dernière sauvegarde : ${fmtDate(S.backupAt)}. ` : "Aucune sauvegarde pour l'instant. ") + "Le fichier (identité, contacts, messages) est chiffré avec une phrase secrète : c'est le seul moyen de retrouver ton identité sur un autre appareil.";
  swatches($("#set-colors"), colorOf(S.me), async (c) => { S.me.color = c; await saveProfile(); });
  const names = S.carriers.map(cid => S.contacts.get(cid)?.name).filter(Boolean);
  $("#set-carry").textContent = names.length ? `Quand tu es absent, tes messages sont gardés chiffrés chez ${names.join(" et ")} (choisis automatiquement : tes contacts les plus récents). Eux ne peuvent pas les lire.`
    : S.contacts.size ? "Dès qu'un contact aura accepté, il gardera tes messages chiffrés quand tu es absent, automatiquement." : "Ajoute un contact : ton cercle gardera tes messages quand tu es absent, sans rien régler.";
}
async function renameMe(name) {
  name = name.trim(); if (!name || name === S.me.name) return;
  S.me.name = name; await saveProfile(); toast("Nom mis à jour");
}
async function setBio(bio) {
  bio = bio.trim().slice(0, 80); if (bio === (S.me.bio || "")) return;
  S.me.bio = bio; await saveProfile(); toast(bio ? "Mot mis à jour" : "Mot retiré");
}
// Phrase secrète : une petite modale plutôt que prompt() (masquée, confirmée à l'export)
function askPass(title, text, confirm) {
  return new Promise((res) => {
    $("#pass-title").textContent = title; $("#pass-txt").textContent = text;
    $("#pass-1").value = ""; $("#pass-2").value = ""; $("#pass-2").hidden = !confirm; $("#pass").hidden = false; $("#pass-1").focus();
    const done = (v) => { $("#pass").hidden = true; res(v); };
    $("#pass-ok").onclick = () => {
      const a = $("#pass-1").value; if (!a) return;
      if (confirm && a.length < 8) { toast("Au moins 8 caractères", true); return; }
      if (confirm && a !== $("#pass-2").value) { toast("Les deux phrases ne sont pas identiques", true); return; }
      done(a);
    };
    $("#pass-no").onclick = $("#pass-close").onclick = () => done(null);
    $("#pass-1").onkeydown = $("#pass-2").onkeydown = (e) => { if (e.key === "Enter") $("#pass-ok").click(); };
  });
}
async function exportBackup() {
  const pass = await askPass("Sauvegarder", "Choisis une phrase secrète. Sans elle, le fichier est illisible, même pour toi.", true); if (!pass) return;
  const blob = await C.exportBackup(pass); const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `krypty-${S.me.name}-${new Date().toISOString().slice(0, 10)}.krypty2`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000);
  S.backupAt = Date.now(); await C.kv.set("backupAt", S.backupAt); renderContacts(); toast("Sauvegarde enregistrée");
}

// ── Événements ──
$("#send").onclick = () => {
  const t = $("#input").value.trim(); if (!t) return; $("#input").value = ""; $("#input").style.height = "";
  if (S.edit) { const m = S.edit; setCompose(null); editMessage(m, t); } else sendMessage(t, null);
};
$("#input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#send").click(); } if (e.key === "Escape" && (S.reply || S.edit)) { setCompose(null); $("#input").value = ""; } };
$("#ctx-cancel").onclick = () => { if (S.edit) $("#input").value = ""; setCompose(null); };
$("#messages").addEventListener("scroll", hideActions);
document.addEventListener("click", (e) => { if (!e.target.closest("#msg-actions") && !e.target.closest(".msg")) hideActions(); });
$("#input").oninput = (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px"; };
$("#file").onchange = (e) => { const f = e.target.files[0]; if (f) sendMessage("", f); e.target.value = ""; };
$("#attach").onclick = (e) => { if ($("#attach").classList.contains("off")) { e.preventDefault(); toast("Les fichiers passent uniquement par le tunnel direct : attends que le contact soit en ligne", true); } };
$("#search").oninput = renderContacts;
$("#btn-back").onclick = () => { $("#app").classList.remove("in-chat"); S.active = null; setCompose(null); hideActions(); renderContacts(); renderChat(); };
function openNewMenu() { $("#newmenu").hidden = false; }
$("#btn-new").onclick = openNewMenu;
$("#empty-new").onclick = openNewMenu;
$("#newmenu-close").onclick = () => $("#newmenu").hidden = true;
$("#newmenu-person").onclick = () => { $("#newmenu").hidden = true; openInvite("inv-make"); };
$("#newmenu-paste").onclick = () => { $("#newmenu").hidden = true; openInvite("inv-join"); };
$("#newmenu-group").onclick = () => {
  $("#newmenu").hidden = true;
  if (![...S.contacts.values()].some(c => !c.pending)) { toast("Relie d'abord une personne : un groupe se crée à partir de ton cercle", true); return; }
  openGroupModal();
};
$("#invite-back").onclick = () => { $("#invite").hidden = true; openNewMenu(); };
$("#gc-photo-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  const g = _gcard; if (!f || !g || g.creator !== S.me.id) return;
  try { await updateGroup(g, { photo: await C.resizePhoto(f) }); setAv($("#gc-av"), g); $("#gc-photo-rm").hidden = false; await sysMsg(g, "Photo du groupe changée"); }
  catch { toast("Image illisible", true); }
};
$("#gc-av").onclick = (e) => { if (!_gcard || _gcard.creator !== S.me.id) e.preventDefault(); };
$("#invite-close").onclick = () => $("#invite").hidden = true;
$("#invite-new").onclick = async () => {
  for (const [i, p] of S.pendingInvites) { p.link.teardown(); S.pendingInvites.delete(i); }   // une seule offre vivante à la fois
  $("#invite-link").value = "…"; $("#qrwrap").hidden = true; $("#invite-link").value = await makeInvite();
};
$("#invite-qr").onclick = () => {
  const w = $("#qrwrap"); if (!w.hidden) { w.hidden = true; return; }
  try { qrDraw($("#qr"), $("#invite-link").value, { px: 4, fg: "#111", bg: "#fff" }); w.hidden = false; } catch { toast("QR code impossible pour ce lien", true); }
};
$("#invite-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#invite-link").value); toast("Lien copié. Étape suivante : attends son code."); setSteps(2); } catch { $("#invite-link").select(); toast("Sélectionne et copie le lien (Ctrl+C)"); } };
$("#paste-go").onclick = async () => {
  const v = $("#paste").value; $("#invite").hidden = true; $("#paste").value = "";
  if (!(await handlePasted(v))) toast("Ni un lien d'invitation, ni un code Krypty", true);
};
$("#invite-answer-go").onclick = async () => {
  const v = $("#invite-answer").value; if (!v.trim()) return;
  if (await handlePasted(v)) { $("#invite-answer").value = ""; setSteps(3); setTimeout(() => { $("#invite").hidden = true; setSteps(1); $("#invite-link").value = ""; }, 900); }
  else toast("Ce n'est pas un code de réponse", true);
};
$("#invite-answer").oninput = () => { if ($("#invite-answer").value.trim()) setSteps(2); };
$("#invite-share").onclick = () => share($("#invite-link").value, "Rejoins-moi sur Krypty");
$("#code-share").onclick = () => share($("#code-val").value, "Code Krypty");
$("#code-ok").onclick = () => $("#code").hidden = true;
document.addEventListener("paste", async (e) => {
  const t = e.target; if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
  const v = e.clipboardData?.getData("text") || ""; if (!/#i\/|\bKR\./.test(v)) return;
  e.preventDefault(); if (await handlePasted(v)) $$(".modal").forEach(m => { if (m.id !== "code" && m.id !== "accept") m.hidden = true; });
});
$("#code-close").onclick = () => $("#code").hidden = true;
$("#code-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#code-val").value); toast("Code copié"); } catch { $("#code-val").select(); } };
$$("#theme button").forEach(b => b.onclick = () => applyTheme(b.dataset.v));
$("#btn-settings").onclick = openSettings;
$("#btn-contact").onclick = () => { const c = convOf(S.active); if (!c) return; if (isGroup(c)) openGroupCard(c); else openContact(S.active); };
$("#group-close").onclick = () => $("#group").hidden = true;
$("#present-close").onclick = () => $("#present").hidden = true;
$("#gc-close").onclick = () => $("#gcard").hidden = true;
$("#ct-close").onclick = () => $("#contact").hidden = true;
$("#photo-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { S.me.photo = await C.resizePhoto(f); await saveProfile(); toast("Photo mise à jour"); }
  catch { toast("Image illisible", true); }
};
$("#photo-rm").onclick = async () => { S.me.photo = null; await saveProfile(); };
async function saveProfile() { S.me.pv = Date.now(); await C.kv.set("me", S.me); renderAll(); setAv($("#set-av"), S.me); broadcast(myProfile()); }
$("#set-close").onclick = () => $("#settings").hidden = true;
$("#set-name-ok").onclick = () => renameMe($("#set-name").value);
$("#set-name").onkeydown = (e) => { if (e.key === "Enter") renameMe(e.target.value); };
$("#set-bio-ok").onclick = () => setBio($("#set-bio").value);
$("#set-bio").onkeydown = (e) => { if (e.key === "Enter") setBio(e.target.value); };
$("#btn-notif").onclick = async () => { if (!("Notification" in window)) { toast("Pas de notifications dans ce navigateur", true); return; } const p = await Notification.requestPermission(); toast(p === "granted" ? "Notifications activées" : "Notifications refusées par le navigateur", p !== "granted"); };
$("#btn-export").onclick = exportBackup;
$("#nudge-go").onclick = exportBackup;
$("#nudge-later").onclick = () => { try { localStorage.setItem("nudgeLater", String(Date.now())); } catch {} $("#nudge").hidden = true; };
$("#import-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (S.me && !confirm("Restaurer remplace l'identité de cet appareil par celle de la sauvegarde. Continuer ?")) return;
  const pass = await askPass("Restaurer", `Phrase secrète de « ${f.name} ».`, false); if (!pass) return;
  try { await C.importBackup(f, pass); toast("Sauvegarde restaurée, rechargement"); setTimeout(() => location.reload(), 800); }
  catch (err) { toast("Impossible : " + (err.message === "bad-pass" ? "phrase secrète incorrecte" : "fichier invalide"), true); }
};
$("#btn-wipe").onclick = async () => { if (confirm("Tout effacer sur cet appareil ? Identité, contacts, messages. Sans sauvegarde, c'est définitif.")) { await C.wipe(); location.hash = ""; location.reload(); } };
document.addEventListener("keydown", (e) => { if (e.key !== "Escape") return; if (!$("#accept").hidden) $("#acc-no").click(); if (!$("#pass").hidden) $("#pass-no").click(); $$(".modal").forEach(m => m.hidden = true); });
document.addEventListener("visibilitychange", async () => { const c = S.contacts.get(S.active); if (!document.hidden && c && c.unread) { c.unread = 0; await C.store.put("contacts", c); renderContacts(); } });
if (["localhost", "127.0.0.1"].includes(location.hostname)) { window.K = S; S.dev = { acceptInvite, handlePasted, present, createGroup }; }   // inspectable en développement seulement
$$(".modal .box").forEach(b => { b.setAttribute("role", "dialog"); b.setAttribute("aria-modal", "true"); });
applyTheme(curTheme());
boot();
