// krypty2/app.js — protocole + interface. « La messagerie qui ne sait pas que vous existez. »
import * as C from "./core.js";
import { RelayPool } from "./relay.js";
import { Link } from "./link.js";
import { Carrier, PeerRelay } from "./carry.js";

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
};
const N_CARRIERS = 2;
// Répondeurs WebSocket par défaut : uniquement en développement local. En production, personne :
// « si aucun contact, pas de répondeur » — le cercle porte, plus il y a de monde, plus il y a de porteurs.
const BOOTSTRAP_RELAYS = [];

// ═══════════════════════ Démarrage ═══════════════════════
async function boot() {
  S.relays = (await C.kv.get("relays")); if (!Array.isArray(S.relays)) S.relays = defaultRelays();
  S.me = await C.kv.get("me");
  if (S.me && !(S.me.x && S.me.x.pub && S.me.e && S.me.e.pub)) { await C.kv.del("me"); S.me = null; }   // format inconnu (ancien proto) → ré-onboarding
  if (!S.me) { showOnboard(); return; }
  if (!S.me.id) { S.me.id = await C.contactId(S.me.x.pub); await C.kv.set("me", S.me); }
  await start();
}
function defaultRelays() {
  if (["localhost", "127.0.0.1"].includes(location.hostname)) return ["ws://" + location.hostname + ":8765"];   // dev
  return [...BOOTSTRAP_RELAYS];
}

async function start() {
  S.pool = new RelayPool(onBlob, onRelayState, (cid) => new PeerRelay(cid, (id) => S.links.get(id), onBlob));
  S.carrier = new Carrier((cid, obj) => { const l = S.links.get(cid); return !!(l && l.open && l.send(JSON.stringify(obj))); });
  if (!S.me.pickups) S.me.pickups = {};
  S.carriers = ((await C.kv.get("carriers")) || []).filter(cid => S.me.pickups[cid]);
  for (const c of await C.store.all("contacts")) { S.contacts.set(c.id, c); await ensurePair(c); }
  for (const url of S.relays) S.pool.get(url);
  await subscribeAll();
  // Reprise : ré-enregistrer les boîtes d'accueil encore valables
  const w = (await C.kv.get("welcome")) || [];
  for (const b of w) { S.welcome.set(b.box, b); S.pool.get(b.relay).subscribe(b.box, b.key, b.pub); }
  await pickCarriers(false);
  renderAll();
  setInterval(flushOutbox, 15000);
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
  for (const cid of S.carriers) { const p = S.me.pickups[cid]; if (p && S.contacts.has(cid)) S.pool.get("peer:" + cid).subscribe(p.box, p.key, p.pub); }
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
// Ma carte pour un contact : ses boîtes chez mes répondeurs WebSocket + mes boîtes chez mes porteurs
function myCard(c) {
  return [...c.inbox.map(b => ({ relay: b.relay, box: b.box })), ...S.carriers.filter(cid => S.me.pickups[cid]).map(cid => ({ relay: "peer:" + cid, box: S.me.pickups[cid].box }))];
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
      for (const x of S.contacts.values()) { if (x.pending) continue; try { const env = await C.open(await ensurePair(x), blob); await dispatch(x, env, via); return true; } catch {} }
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
  if (env.t === "msg") {
    if (await C.store.get("messages", env.id)) return;   // doublon (plusieurs porteurs)
    await C.store.put("messages", { id: env.id, contact: c.id, dir: "in", ts: env.ts, text: env.text, file: env.file || null, via });
    c.seen = Date.now(); c.last = env.text || "📎 " + (env.file?.name || "fichier");
    if (S.active !== c.id || document.hidden) c.unread = (c.unread || 0) + 1;
    await C.store.put("contacts", c);
    sendTo(c, { t: "ack", ids: [env.id] });
    renderContacts(); if (S.active === c.id) renderChat();
    notify(c, env.text); pickCarriers();
  } else if (env.t === "ack") {
    for (const id of env.ids) { const m = await C.store.get("messages", id); if (m && m.dir === "out") { m.status = "read"; await C.store.put("messages", m); } await C.store.del("outbox", id); }
    if (S.active === c.id) renderChat();
  } else if (env.t === "hello") {
    if (Date.now() - env.ts > 120000) return;            // hello périmé (resté au répondeur)
    S.presence.set(c.id, Date.now());
    if (Array.isArray(env.card) && env.card.length) { c.outbox = env.card; await C.store.put("contacts", c); }
    if (!env.reply) sendTo(c, { t: "hello", ts: Date.now(), reply: true, card: myCard(c) });
    maybeLink(c);
    renderContacts();
  } else if (env.t === "profile") {         // nom / couleur / photo changés
    if (env.name) c.name = String(env.name).slice(0, 24); if (env.color) c.color = env.color;
    if ("photo" in env) c.photo = (typeof env.photo === "string" && env.photo.startsWith("data:image/") && env.photo.length < 40000) ? env.photo : null;
    await C.store.put("contacts", c); renderContacts(); if (S.active === c.id) renderChat();
  } else if (env.t === "card") {           // le contact a changé ses boîtes / porteurs
    c.outbox = env.inbox; await C.store.put("contacts", c);
  } else if (env.t === "intro-ack") {      // fin de l'invitation côté acceptant
    const wasPending = c.pending;
    c.name = env.name; c.epub = env.epub; c.outbox = env.inbox; c.pending = false; if (env.color) c.color = env.color; if (env.photo) c.photo = env.photo;
    await C.store.put("contacts", c); if (env.id) sendTo(c, { t: "ack", ids: [env.id] });
    renderAll(); if (wasPending) { toast(`${c.name} est maintenant dans ton cercle`); flushOutbox(); pickCarriers(); }
  } else if (["offer", "answer", "ice"].includes(env.t)) {
    if (env.ts && Date.now() - env.ts > 60000) return;   // signalisation périmée (restée chez un porteur)
    await getLink(c).onSignal(env);
  }
}

// ═══════════════════════ Envoi ═══════════════════════
let _lastPosted = [];
const SHORT = ["hello", "offer", "answer", "ice", "ack", "card", "profile"];   // pas de sens après quelques minutes → TTL court chez un porteur
async function sendTo(c, env, skipRelays = []) {
  const ttl = SHORT.includes(env.t) ? 5 * 60 * 1000 : undefined;
  if (!env.id) env.id = C.uid();
  const key = await ensurePair(c);
  const blob = await C.seal(key, env);
  const l = S.links.get(c.id);
  _lastPosted = [];
  if (l && l.open && l.send(blob)) return "direct";
  // Le cercle d'abord : si un porteur (contact commun, tunnel ouvert) accepte, le point de rendez-vous
  // ne voit pas passer le message. Il ne sert que de secours.
  const peers = c.outbox.filter(o => o.relay.startsWith("peer:")), wss = c.outbox.filter(o => !o.relay.startsWith("peer:"));
  for (const o of peers) {
    if (skipRelays.includes(o.relay)) continue;
    const cid = o.relay.slice(5); if (cid === S.me.id || !S.contacts.has(cid)) continue;   // porteur inconnu de moi : inutilisable
    if (S.pool.get(o.relay).post(o.box, blob, ttl)) _lastPosted.push(o.relay);
  }
  const carried = _lastPosted.length > 0 || peers.some(o => skipRelays.includes(o.relay));
  if (!carried || env.t !== "msg") for (const o of wss) if (!skipRelays.includes(o.relay) && S.pool.get(o.relay).post(o.box, blob)) _lastPosted.push(o.relay);
  return _lastPosted.length ? "relay" : "queued";
}
// Présence : « hello » en direct si tunnel, sinon via répondeur au plus une fois / 10 min par
// contact silencieux (sinon des centaines de blobs s'empileraient dans sa boîte pendant son absence).
const _helloAt = new Map();
function broadcast(env) {
  for (const c of S.contacts.values()) {
    if (c.pending) continue;
    const l = S.links.get(c.id);
    const e = env.t === "hello" ? { ...env, card: myCard(c) } : env;
    if (l && l.open) { sendTo(c, e); continue; }
    const last = _helloAt.get(c.id) || 0, heard = S.presence.get(c.id) || 0;
    if (Date.now() - last < 600000 && Date.now() - heard > 60000) continue;
    if (Date.now() - last < 25000) continue;
    _helloAt.set(c.id, Date.now()); sendTo(c, e);
  }
}
async function sendMessage(text, file) {
  const c = S.contacts.get(S.active); if (!c || (!text && !file)) return;
  const env = { t: "msg", id: C.uid(), ts: Date.now(), text, file: file ? { name: file.name, size: file.size } : null };
  const m = { ...env, contact: c.id, dir: "out", status: "sending" };
  await C.store.put("messages", m); c.seen = Date.now(); c.last = "Toi : " + (text || "📎 " + (file?.name || "")); await C.store.put("contacts", c); renderChat(); renderContacts();
  let via;
  if (file) {
    const l = S.links.get(c.id);
    if (!(l && l.open)) { m.status = "failed"; m.error = "Fichier : tunnel direct requis (contact hors ligne)"; await C.store.put("messages", m); renderChat(); return; }
    await l.send(await C.seal(await ensurePair(c), env));
    await l.sendFile({ id: env.id, name: file.name, size: file.size }, file);
    via = "direct";
  } else via = await sendTo(c, env);
  m.status = via === "queued" ? "queued" : "sent"; m.via = via;
  await C.store.put("messages", m);
  // Tout reste dans l'outbox jusqu'à l'ack du destinataire — même en direct : un tunnel qui meurt
  // (onglet fermé, réseau coupé) accepte encore des envois pendant quelques secondes sans les livrer.
  await C.store.put("outbox", { id: env.id, contact: c.id, env, posted: _lastPosted, at: Date.now() });
  renderChat();
}
// Reprise : tout ce qui n'est pas acquitté est reposté (dédoublonné à l'arrivée par id).
async function flushOutbox() {
  for (const o of await C.store.all("outbox")) {
    const c = S.contacts.get(o.contact); if (!c) { await C.store.del("outbox", o.id); continue; }
    if ((o.posted || []).length && Date.now() - (o.at || 0) < 8000) continue;   // déjà déposé : laisser le temps à l'ack
    const posted = o.posted || [];
    const via = await sendTo(c, o.env, posted);
    if (via === "relay") { o.posted = [...posted, ..._lastPosted]; await C.store.put("outbox", o); }
    const m = await C.store.get("messages", o.id);
    if (m && m.status === "queued" && via !== "queued") { m.status = "sent"; m.via = via; await C.store.put("messages", m); if (S.active === c.id) renderChat(); }
  }
}

// ═══════════════════════ Tunnel direct ═══════════════════════
function getLink(c) {
  if (!S.links.has(c.id)) {
    const l = new Link(c.id, (sig) => sendTo(c, { ...sig, id: C.uid(), ts: Date.now() }), (ev) => onLinkEvent(c, ev), (st) => {
      if (["closed", "failed", "disconnected"].includes(st)) S.presence.delete(c.id);   // tunnel mort = plus « en ligne » tant qu'un hello ne revient pas
      renderContacts(); if (S.active === c.id) renderChat();
      if (st === "open") { S.carrier.onOpen(c.id); if (S.pool.has("peer:" + c.id)) S.pool.get("peer:" + c.id).resub(); flushOutbox(); }
    });
    l.polite = S.me.id > c.id;    // ordre total → un seul initiateur
    S.links.set(c.id, l);
  }
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
    const m = await C.store.get("messages", ev.meta.id);
    if (m) { m.blob = ev.blob; m.file = { name: ev.meta.name, size: ev.meta.size }; await C.store.put("messages", m); if (S.active === c.id) renderChat(); }
    else await C.store.put("messages", { id: ev.meta.id, contact: c.id, dir: "in", ts: Date.now(), text: "", file: { name: ev.meta.name, size: ev.meta.size }, blob: ev.blob, via: "direct" });
    if (S.active === c.id) renderChat();
  } else if (ev.t === "progress") { const el = $(`[data-id="${ev.id}"] .progress`); if (el) el.textContent = `${fmtSize(ev.got)} / ${fmtSize(ev.size)}`; }
}
const isOnline = (c) => (S.links.get(c.id)?.open) || (Date.now() - (S.presence.get(c.id) || 0) < 60000);

// ═══════════════════════ Invitation ═══════════════════════
// Le lien contient : mon nom, mes clés publiques, une boîte d'accueil (répondeur + id), signé.
async function makeInvite() {
  const relay = S.relays[0];
  if (!relay) { toast("Première connexion : un point de rendez-vous est nécessaire (Réglages → Avancé)", true); return ""; }
  const wb = await C.newBox(relay);
  const rec = { ...wb, created: Date.now() };
  S.welcome.set(wb.box, rec);
  await C.kv.set("welcome", [...S.welcome.values()]);
  S.pool.get(relay).subscribe(wb.box, wb.key, wb.pub);
  const body = { v: 2, name: S.me.name, tag: S.me.tag, c: S.me.color, x: C.b64u.enc(S.me.x.pub), e: C.b64u.enc(S.me.e.pub), w: { relay, box: wb.box } };
  body.sig = C.b64u.enc(await C.edSign(S.me.e.priv, new TextEncoder().encode(body.x + "|" + body.w.box)));
  const link = location.origin + location.pathname + "#i/" + C.b64u.enc(new TextEncoder().encode(JSON.stringify(body)));
  return link;
}
async function acceptInvite(code) {
  let inv; try { inv = JSON.parse(new TextDecoder().decode(C.b64u.dec(code))); } catch { toast("Lien invalide", true); return; }
  const ok = await C.edVerify(C.b64u.dec(inv.e), C.b64u.dec(inv.sig), new TextEncoder().encode(inv.x + "|" + inv.w.box));
  if (!ok) { toast("Invitation non signée — refusée", true); return; }
  const xpub = C.b64u.dec(inv.x), id = await C.contactId(xpub);
  if (id === S.me.id) { toast("C'est ta propre invitation", true); return; }
  if (S.contacts.has(id)) { toast(`${inv.name} est déjà dans ton cercle`); return; }
  const sn = await C.safetyNumber(S.me.x.pub, xpub);
  if (!(await askAccept(inv, sn))) return;
  // Mes boîtes où IL m'écrira : une par répondeur que j'utilise (le mien + porteurs)
  const inbox = []; for (const r of S.relays) inbox.push(await C.newBox(r));
  const c = { id, name: inv.name, tag: inv.tag, color: inv.c, xpub: inv.x, epub: inv.e, inbox, outbox: [], pending: true, seen: Date.now() };
  S.contacts.set(id, c); await C.store.put("contacts", c); await subscribeAll();
  const key = await ensurePair(c);
  const intro = await C.seal(key, { t: "intro", name: S.me.name, tag: S.me.tag, color: S.me.color, photo: S.me.photo || null, epub: C.b64u.enc(S.me.e.pub), inbox: myCard(c) });
  S.pool.get(inv.w.relay).post(inv.w.box, C.b64u.enc(S.me.x.pub) + "." + intro);
  renderAll(); openChat(id); toast(`Demande envoyée à ${inv.name} — en attente de sa réponse`);
}
async function onIntro(w, blob) {
  const [xs, sealed] = blob.split("."); if (!sealed) return;
  const xpub = C.b64u.dec(xs), id = await C.contactId(xpub);
  const key = await C.pairKey(S.me.x.priv, xpub);
  const intro = await C.open(key, sealed); if (intro.t !== "intro") return;
  if (S.contacts.has(id)) return;
  const inbox = []; for (const r of S.relays) inbox.push(await C.newBox(r));
  const c = { id, name: intro.name, tag: intro.tag, color: intro.color, photo: intro.photo || null, xpub: xs, epub: intro.epub, inbox, outbox: intro.inbox, pending: false, seen: Date.now() };
  S.contacts.set(id, c); S.pairKeys.set(id, key); await C.store.put("contacts", c); await subscribeAll();
  // L'intro-ack passe par l'outbox comme un message : reposté jusqu'à l'ack de l'autre côté
  // (son répondeur peut être injoignable à cet instant, ou mon onglet fermé juste après).
  const ack = { t: "intro-ack", id: C.uid(), name: S.me.name, tag: S.me.tag, color: S.me.color, photo: S.me.photo || null, epub: C.b64u.enc(S.me.e.pub), inbox: myCard(c) };
  await sendTo(c, ack); await C.store.put("outbox", { id: ack.id, contact: c.id, env: ack, posted: _lastPosted, at: Date.now() });
  // boîte d'accueil consommée
  S.welcome.delete(w.box); await C.kv.set("welcome", [...S.welcome.values()]);
  renderAll(); toast(`${c.name} a rejoint ton cercle`); if (!S.active) openChat(c.id); pickCarriers();
}
// Porteurs : ajouter un répondeur = nouvelles boîtes d'entrée partout + carte envoyée aux contacts
async function addRelay(url) {
  url = url.trim(); if (!url || S.relays.includes(url)) return;
  S.relays.push(url); await C.kv.set("relays", S.relays); S.pool.get(url);
  for (const c of S.contacts.values()) {
    c.inbox.push(await C.newBox(url)); await C.store.put("contacts", c);
    sendTo(c, { t: "card", inbox: myCard(c) });
  }
  await subscribeAll(); renderRelays(); toast("Point de rendez-vous ajouté — tes contacts sont prévenus");
}

// ═══════════════════════ UI ═══════════════════════
const $$ = (s) => [...document.querySelectorAll(s)];
const COLORS = ["#30D158", "#0A84FF", "#BF5AF2", "#FF9F0A", "#FF375F", "#64D2FF", "#FFD60A", "#AC8E68"];
const colorOf = (o) => o?.color || COLORS[0];
const initials = (n) => String(n || "?").trim().slice(0, 2).toUpperCase();
function setAv(el, o) {
  el.style.setProperty("--c", colorOf(o));
  const keep = el.querySelector("input");          // (réglages : l'input file vit dans l'avatar)
  el.innerHTML = o?.photo ? `<img src="${o.photo}" alt="">` : esc(initials(o?.name));
  if (keep) el.appendChild(keep);
}
function swatches(container, current, onPick) {
  container.innerHTML = COLORS.map(c => `<button type="button" class="swatch${c === current ? " sel" : ""}" style="background:${c}" data-c="${c}" role="radio" aria-checked="${c === current}" aria-label="couleur"></button>`).join("");
  container.querySelectorAll(".swatch").forEach(b => b.onclick = () => { container.querySelectorAll(".swatch").forEach(x => x.classList.toggle("sel", x === b)); onPick(b.dataset.c); });
}
let _obColor = COLORS[Math.floor(Math.random() * COLORS.length)];
function showOnboard() {
  $("#onboard").hidden = false; $("#app").hidden = true;
  $("#ob-logo").style.background = _obColor;
  swatches($("#ob-colors"), _obColor, (c) => { _obColor = c; $("#ob-logo").style.background = c; });
  $("#ob-name").oninput = () => { $("#ob-logo").textContent = initials($("#ob-name").value) || "K"; };
  $("#ob-name").onkeydown = (e) => { if (e.key === "Enter") $("#ob-go").click(); };
  $("#ob-go").onclick = async () => {
    const name = $("#ob-name").value.trim() || "Anonyme";
    $("#ob-go").disabled = true; $("#ob-go").textContent = "Création des clés…";
    S.me = await C.loadOrCreateIdentity(name);
    S.me.id = await C.contactId(S.me.x.pub); S.me.color = _obColor; await C.kv.set("me", S.me);
    await start();
  };
  $("#ob-import").onclick = (e) => { e.preventDefault(); $("#import-file").click(); };
}
function renderAll() {
  $("#onboard").hidden = true; $("#app").hidden = false;
  $("#me-name").textContent = S.me.name; setAv($("#me-av"), S.me);
  renderContacts(); renderRelays(); renderChat();
}
function statusOf(c) {
  const l = S.links.get(c.id);
  if (c.pending) return { k: "off", t: "en attente de sa réponse" };
  if (l?.open) return { k: "direct", t: "⚡ en direct" };
  if (isOnline(c)) return { k: "relay", t: "en ligne" };
  return { k: "off", t: "hors ligne" };
}
function renderContacts() {
  const ul = $("#contacts"); ul.innerHTML = "";
  const q = ($("#search").value || "").trim().toLowerCase();
  const list = [...S.contacts.values()].filter(c => !q || (c.name + "#" + c.tag).toLowerCase().includes(q)).sort((a, b) => (b.seen || 0) - (a.seen || 0));
  if (!S.contacts.size) ul.innerHTML = `<li class="empty">Personne encore.<br>Le bouton <b>＋ Inviter</b> crée un lien à envoyer.</li>`;
  else if (!list.length) ul.innerHTML = `<li class="empty">Aucun contact ne correspond.</li>`;
  for (const c of list) {
    const li = document.createElement("li"); li.className = "contact" + (S.active === c.id ? " active" : "");
    const st = statusOf(c);
    const sub = c.pending ? st.t : (c.last ? esc(c.last) : st.t);
    li.innerHTML = `<span class="av${st.k !== "off" ? " on" : ""}"></span><div class="cbody"><div class="cname">${esc(c.name)}${c.verified ? ' <span class="tag" title="vérifié">✓</span>' : ""}</div><div class="cst${st.k === "direct" ? " on" : ""}">${sub}</div></div>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}`;
    setAv(li.querySelector(".av"), c);
    li.onclick = () => openChat(c.id);
    ul.appendChild(li);
  }
  // État « hors ligne » sans jargon : est-ce que quelqu'un garde mes messages quand je suis absent ?
  const carriersOn = S.carriers.filter(cid => S.links.get(cid)?.open).length, ws = S.pool && S.pool.wsOpen();
  const ok = ws || carriersOn > 0;
  $("#relay-dot").className = "dot" + (ok ? " on" : "");
  $("#relay-txt").textContent = ok ? "Prêt" : S.contacts.size ? "Tes messages arriveront quand tu seras en ligne" : "Ajoute un contact pour commencer";
  $("#side-foot").title = ok ? "Tes messages en attente sont gardés chiffrés" + (carriersOn ? " par " + S.carriers.filter(cid => S.links.get(cid)?.open).map(cid => S.contacts.get(cid)?.name).join(", ") : " par un point de rendez-vous") : "";
}
async function openChat(id) {
  S.active = id; const c = S.contacts.get(id);
  if (c && c.unread) { c.unread = 0; await C.store.put("contacts", c); }
  $("#app").classList.add("in-chat");
  renderContacts(); renderChat(); $("#input").focus();
}
function renderRelays() {
  const st = S.pool ? S.pool.states() : [];
  $("#relays").innerHTML = S.relays.map(u => { const s = st.find(x => x.url === u); return `<li><span class="dot ${s?.open ? "on" : ""}"></span><span class="grow">${esc(u)}</span><span class="mini">${s?.open ? "connecté" : "injoignable"}</span></li>`; }).join("");
}
function onRelayState() { renderRelays(); renderContacts(); }
const dayKey = (ts) => new Date(ts).toDateString();
const fmtDay = (ts) => { const d = new Date(ts), t = new Date(); return dayKey(ts) === dayKey(t) ? "Aujourd'hui" : d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }); };
let _renderSeq = 0;
async function renderChat() {
  const c = S.contacts.get(S.active); const box = $("#messages");
  $("#chat-empty").hidden = !!c; $("#chat-view").hidden = !c;
  if (!c) return;
  $("#chat-title").textContent = c.name; setAv($("#chat-av"), c);
  const st = statusOf(c);
  $("#chat-pill").textContent = st.t; $("#chat-pill").className = "pill " + st.k;
  $("#chat-sub").textContent = c.pending ? "elle/il doit encore accepter ton lien" : st.k === "direct" ? "connexion directe, fichiers sans limite" : st.k === "relay" ? "chiffré de bout en bout" : "tes messages l'attendront";
  $("#attach").classList.toggle("off", st.k !== "direct");
  const seq = ++_renderSeq;
  const msgs = (await C.store.byContact("messages", c.id)).sort((a, b) => a.ts - b.ts);
  if (seq !== _renderSeq) return;
  box.innerHTML = ""; let lastDay = null;
  for (const m of msgs) {
    if (dayKey(m.ts) !== lastDay) { lastDay = dayKey(m.ts); const d = document.createElement("div"); d.className = "day"; d.textContent = fmtDay(m.ts); box.appendChild(d); }
    const d = document.createElement("div"); d.className = "msg " + m.dir + (m.status === "failed" ? " failed" : ""); d.dataset.id = m.id;
    let body = m.text ? `<span class="txt">${esc(m.text)}</span>` : "";
    if (m.file) body += `<span class="file">📎 <span>${esc(m.file.name)} · ${fmtSize(m.file.size)}</span> ${m.blob ? `<a href="#" data-dl="${m.id}">enregistrer</a>` : `<span class="progress mini">${m.dir === "in" ? "réception…" : ""}</span>`}</span>`;
    const stx = m.dir === "out" ? ({ sending: "⏱", queued: "⏳", sent: "✓", read: "✓✓", failed: "✗" }[m.status] || "") : "";
    const title = m.dir === "out" ? ({ sending: "envoi…", queued: "en attente d'un répondeur", sent: "déposé", read: "lu", failed: "échec" }[m.status] || "") : "";
    d.innerHTML = `${body}<span class="meta" title="${title}">${m.via === "direct" ? "⚡" : ""}${fmtTime(m.ts)} ${stx}</span>${m.error ? `<span class="err">${esc(m.error)}</span>` : ""}`;
    box.appendChild(d);
  }
  box.querySelectorAll("[data-dl]").forEach(a => a.onclick = async (e) => { e.preventDefault(); const m = await C.store.get("messages", a.dataset.dl); const u = URL.createObjectURL(m.blob); const x = document.createElement("a"); x.href = u; x.download = m.file.name; x.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); });
  box.scrollTop = box.scrollHeight;
}
let _toastT;
function toast(t, err) { const el = $("#toast"); el.textContent = t; el.className = "show" + (err ? " err" : ""); clearTimeout(_toastT); _toastT = setTimeout(() => el.className = "", 3800); }
function notify(c, text) { if ((S.active !== c.id || document.hidden) && "Notification" in window && Notification.permission === "granted") new Notification(c.name, { body: text || "📎 fichier" }); }
function askAccept(inv, sn) {
  return new Promise((res) => {
    $("#acc-name").textContent = inv.name; setAv($("#acc-av"), { name: inv.name, color: inv.c });
    $("#accept").hidden = false;
    const done = (v) => { $("#accept").hidden = true; res(v); };
    $("#acc-ok").onclick = () => done(true); $("#acc-no").onclick = () => done(false);
  });
}
function openInvite(tab) {
  $("#invite").hidden = false;
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  $("#inv-make").hidden = tab !== "inv-make"; $("#inv-join").hidden = tab !== "inv-join";
  if (tab === "inv-make" && !$("#invite-link").value) $("#invite-new").click();
  if (tab === "inv-join") $("#paste").focus();
}
async function openContact(id) {
  const c = S.contacts.get(id); if (!c) return;
  $("#contact").hidden = false; $("#ct-name").textContent = c.name; setAv($("#ct-av"), c); $("#ct-state").textContent = statusOf(c).t;
  $("#ct-tag").textContent = `${c.name}#${c.tag}`; $("#ct-verified").textContent = c.verified ? "✓ vérifié" : "";
  const xp = C.b64u.dec(c.xpub);
  $("#ct-emo").textContent = await C.emojiFingerprint(S.me.x.pub, xp);
  const g = (await C.safetyNumber(S.me.x.pub, xp)).split(" "); $("#ct-sn").textContent = [g.slice(0, 4), g.slice(4, 8), g.slice(8, 12)].map(x => x.join("  ")).join("\n");
  $("#ct-verify").onclick = async () => { c.verified = true; await C.store.put("contacts", c); $("#ct-verified").textContent = "✓ vérifié"; renderContacts(); toast("Contact vérifié"); };
  $("#ct-rename").onclick = async () => { const n = prompt("Nom affiché chez toi pour ce contact :", c.name); if (n && n.trim()) { c.name = n.trim().slice(0, 24); await C.store.put("contacts", c); renderAll(); $("#ct-name").textContent = c.name; } };
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
  $("#settings").hidden = false; $("#set-name").value = S.me.name; $("#set-tag").textContent = `${S.me.name}#${S.me.tag}`;
  setAv($("#set-av"), S.me);
  swatches($("#set-colors"), colorOf(S.me), async (c) => { S.me.color = c; await C.kv.set("me", S.me); renderAll(); setAv($("#set-av"), S.me); broadcast({ t: "profile", name: S.me.name, color: c }); });
  const names = S.carriers.map(cid => S.contacts.get(cid)?.name).filter(Boolean);
  $("#set-carry").textContent = names.length ? `Quand tu es absent, tes messages sont gardés chiffrés chez ${names.join(" et ")} (choisis automatiquement : tes contacts les plus récents). Eux ne peuvent pas les lire.`
    : S.contacts.size ? "Dès qu'un contact aura accepté, il gardera tes messages chiffrés quand tu es absent — automatiquement." : "Ajoute un contact : ton cercle gardera tes messages quand tu es absent, sans rien régler.";
  renderRelays();
}
async function renameMe(name) {
  name = name.trim(); if (!name || name === S.me.name) return;
  S.me.name = name; await C.kv.set("me", S.me); renderAll(); $("#set-tag").textContent = `${S.me.name}#${S.me.tag}`;
  broadcast({ t: "profile", name, color: colorOf(S.me) }); toast("Nom mis à jour");
}

// ── Événements ──
$("#send").onclick = () => { const t = $("#input").value.trim(); if (!t) return; $("#input").value = ""; $("#input").style.height = ""; sendMessage(t, null); };
$("#input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#send").click(); } };
$("#input").oninput = (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px"; };
$("#file").onchange = (e) => { const f = e.target.files[0]; if (f) sendMessage("", f); e.target.value = ""; };
$("#attach").onclick = (e) => { if ($("#attach").classList.contains("off")) { e.preventDefault(); toast("Les fichiers passent uniquement par le tunnel direct : attends que le contact soit en ligne", true); } };
$("#search").oninput = renderContacts;
$("#btn-back").onclick = () => { $("#app").classList.remove("in-chat"); S.active = null; renderContacts(); renderChat(); };
$("#btn-invite").onclick = () => openInvite("inv-make");
$("#empty-invite").onclick = () => openInvite("inv-make");
$("#empty-join").onclick = () => openInvite("inv-join");
$$(".tab").forEach(t => t.onclick = () => openInvite(t.dataset.tab));
$("#invite-close").onclick = () => $("#invite").hidden = true;
$("#invite-new").onclick = async () => { $("#invite-link").value = await makeInvite(); };
$("#invite-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#invite-link").value); toast("Lien copié — valable une fois"); } catch { $("#invite-link").select(); toast("Sélectionne et copie le lien (Ctrl+C)"); } };
$("#paste-go").onclick = async () => { const v = $("#paste").value.trim(); const i = v.indexOf("#i/"); if (i < 0) return toast("Ce n'est pas un lien d'invitation Krypty", true); $("#invite").hidden = true; await acceptInvite(v.slice(i + 3)); $("#paste").value = ""; };
$("#btn-settings").onclick = openSettings;
$("#btn-contact").onclick = () => { if (S.active) openContact(S.active); };
$("#ct-close").onclick = () => $("#contact").hidden = true;
$("#photo-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { S.me.photo = await C.resizePhoto(f); await C.kv.set("me", S.me); renderAll(); setAv($("#set-av"), S.me); broadcast({ t: "profile", name: S.me.name, color: colorOf(S.me), photo: S.me.photo }); toast("Photo mise à jour"); }
  catch { toast("Image illisible", true); }
};
$("#photo-rm").onclick = async () => { S.me.photo = null; await C.kv.set("me", S.me); renderAll(); setAv($("#set-av"), S.me); broadcast({ t: "profile", name: S.me.name, color: colorOf(S.me), photo: null }); };
$("#set-close").onclick = () => $("#settings").hidden = true;
$("#set-name-ok").onclick = () => renameMe($("#set-name").value);
$("#set-name").onkeydown = (e) => { if (e.key === "Enter") renameMe(e.target.value); };
$("#relay-add").onclick = () => { addRelay($("#relay-url").value); $("#relay-url").value = ""; };
$("#btn-notif").onclick = async () => { const p = await Notification.requestPermission(); toast(p === "granted" ? "Notifications activées" : "Notifications refusées par le navigateur", p !== "granted"); };
$("#btn-export").onclick = async () => {
  const pass = prompt("Phrase secrète pour chiffrer la sauvegarde (à retenir : sans elle, le fichier est illisible) :"); if (!pass) return;
  const blob = await C.exportBackup(pass); const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `krypty-${S.me.name}-${new Date().toISOString().slice(0, 10)}.krypty2`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000);
  toast("Sauvegarde exportée");
};
$("#import-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const pass = prompt("Phrase secrète de cette sauvegarde :"); if (!pass) return;
  try { await C.importBackup(f, pass); toast("Sauvegarde restaurée — rechargement"); setTimeout(() => location.reload(), 800); }
  catch (err) { toast("Impossible : " + (err.message === "bad-pass" ? "phrase secrète incorrecte" : "fichier invalide"), true); }
};
$("#btn-wipe").onclick = async () => { if (confirm("Tout effacer sur cet appareil ? Identité, contacts, messages — sans sauvegarde, c'est définitif.")) { await C.wipe(); location.hash = ""; location.reload(); } };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".modal").forEach(m => m.hidden = true); });
if (["localhost", "127.0.0.1"].includes(location.hostname)) window.K = S;   // inspection en dev uniquement
boot();
