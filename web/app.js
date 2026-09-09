// krypty2/app.js — protocole + interface. « La messagerie qui ne sait pas que vous existez. »
import * as C from "./core.js";
import { RelayPool } from "./relay.js";
import { Link } from "./link.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtSize = (n) => n < 1024 ? n + " o" : n < 1048576 ? (n / 1024).toFixed(0) + " Ko" : (n / 1048576).toFixed(1) + " Mo";

const S = {
  me: null, contacts: new Map(), links: new Map(), pool: null, active: null,
  relays: [], welcome: new Map(),   // welcome: box -> {key, pub, relay, xpriv}
  presence: new Map(),              // cid -> last hello ts
  pairKeys: new Map(),
};

// ═══════════════════════ Démarrage ═══════════════════════
async function boot() {
  S.relays = (await C.kv.get("relays")); if (!Array.isArray(S.relays) || !S.relays.length) S.relays = [defaultRelay()];
  S.me = await C.kv.get("me");
  if (S.me && !(S.me.x && S.me.x.pub && S.me.e && S.me.e.pub)) { await C.kv.del("me"); S.me = null; }   // format inconnu (ancien proto) → ré-onboarding
  if (!S.me) { showOnboard(); return; }
  if (!S.me.id) { S.me.id = await C.contactId(S.me.x.pub); await C.kv.set("me", S.me); }
  await start();
}
function defaultRelay() { return (location.protocol === "https:" ? "wss://" : "ws://") + (location.hostname || "localhost") + ":8765"; }

async function start() {
  S.pool = new RelayPool(onBlob, onRelayState);
  for (const c of await C.store.all("contacts")) { S.contacts.set(c.id, c); await ensurePair(c); }
  for (const url of S.relays) S.pool.get(url);
  await subscribeAll();
  // Reprise : ré-enregistrer les boîtes d'accueil encore valables
  const w = (await C.kv.get("welcome")) || [];
  for (const b of w) { S.welcome.set(b.box, b); S.pool.get(b.relay).subscribe(b.box, b.key, b.pub); }
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
}

// ═══════════════════════ Réception ═══════════════════════
// Un blob arrive dans une de MES boîtes. Retourne true si traité (→ ack = suppression au répondeur).
async function onBlob(relayUrl, box, mid, blob) {
  try {
    // Boîte d'accueil (invitation) : blob = xpub_acceptant.scellé
    if (S.welcome.has(box)) { await onIntro(S.welcome.get(box), blob); return true; }
    const c = [...S.contacts.values()].find(x => x.inbox.some(b => b.box === box));
    if (!c) return true;                                   // boîte inconnue : on jette
    const env = await C.open(await ensurePair(c), blob);
    await dispatch(c, env, "relay");
    return true;
  } catch (e) { console.warn("blob rejeté", e); return true; }
}
async function dispatch(c, env, via) {
  if (env.t === "msg") {
    if (await C.store.get("messages", env.id)) return;   // doublon (plusieurs porteurs)
    await C.store.put("messages", { id: env.id, contact: c.id, dir: "in", ts: env.ts, text: env.text, file: env.file || null, via });
    c.seen = Date.now(); c.last = env.text || "📎 " + (env.file?.name || "fichier");
    if (S.active !== c.id || document.hidden) c.unread = (c.unread || 0) + 1;
    await C.store.put("contacts", c);
    sendTo(c, { t: "ack", ids: [env.id] });
    renderContacts(); if (S.active === c.id) renderChat();
    notify(c, env.text);
  } else if (env.t === "ack") {
    for (const id of env.ids) { const m = await C.store.get("messages", id); if (m && m.dir === "out") { m.status = "read"; await C.store.put("messages", m); } await C.store.del("outbox", id); }
    if (S.active === c.id) renderChat();
  } else if (env.t === "hello") {
    if (Date.now() - env.ts > 120000) return;            // hello périmé (resté au répondeur)
    S.presence.set(c.id, Date.now());
    if (!env.reply) sendTo(c, { t: "hello", ts: Date.now(), reply: true });
    maybeLink(c);
    renderContacts();
  } else if (env.t === "profile") {         // nom / couleur changés
    if (env.name) c.name = String(env.name).slice(0, 24); if (env.color) c.color = env.color;
    await C.store.put("contacts", c); renderContacts(); if (S.active === c.id) renderChat();
  } else if (env.t === "card") {           // le contact a changé ses boîtes / porteurs
    c.outbox = env.inbox; await C.store.put("contacts", c);
  } else if (env.t === "intro-ack") {      // fin de l'invitation côté acceptant
    const wasPending = c.pending;
    c.name = env.name; c.epub = env.epub; c.outbox = env.inbox; c.pending = false; if (env.color) c.color = env.color;
    await C.store.put("contacts", c); if (env.id) sendTo(c, { t: "ack", ids: [env.id] });
    renderAll(); if (wasPending) { toast(`${c.name} est maintenant dans ton cercle`); flushOutbox(); }
  } else if (["offer", "answer", "ice"].includes(env.t)) {
    await getLink(c).onSignal(env);
  }
}

// ═══════════════════════ Envoi ═══════════════════════
let _lastPosted = [];
async function sendTo(c, env, skipRelays = []) {
  const key = await ensurePair(c);
  const blob = await C.seal(key, env);
  const l = S.links.get(c.id);
  _lastPosted = [];
  if (l && l.open && l.send(blob)) return "direct";
  for (const o of c.outbox) if (!skipRelays.includes(o.relay) && S.pool.get(o.relay).post(o.box, blob)) _lastPosted.push(o.relay);
  return _lastPosted.length ? "relay" : "queued";
}
// Présence : « hello » en direct si tunnel, sinon via répondeur au plus une fois / 10 min par
// contact silencieux (sinon des centaines de blobs s'empileraient dans sa boîte pendant son absence).
const _helloAt = new Map();
function broadcast(env) {
  for (const c of S.contacts.values()) {
    if (c.pending) continue;
    const l = S.links.get(c.id);
    if (l && l.open) { sendTo(c, env); continue; }
    const last = _helloAt.get(c.id) || 0, heard = S.presence.get(c.id) || 0;
    if (Date.now() - last < 600000 && Date.now() - heard > 60000) continue;
    if (Date.now() - last < 25000) continue;
    _helloAt.set(c.id, Date.now()); sendTo(c, env);
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
    const l = new Link(c.id, (sig) => sendTo(c, sig), (ev) => onLinkEvent(c, ev), (st) => {
      if (["closed", "failed", "disconnected"].includes(st)) S.presence.delete(c.id);   // tunnel mort = plus « en ligne » tant qu'un hello ne revient pas
      renderContacts(); if (S.active === c.id) renderChat(); if (st === "open") flushOutbox();
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
  const intro = await C.seal(key, { t: "intro", name: S.me.name, tag: S.me.tag, color: S.me.color, epub: C.b64u.enc(S.me.e.pub), inbox: inbox.map(b => ({ relay: b.relay, box: b.box })) });
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
  const c = { id, name: intro.name, tag: intro.tag, color: intro.color, xpub: xs, epub: intro.epub, inbox, outbox: intro.inbox, pending: false, seen: Date.now() };
  S.contacts.set(id, c); S.pairKeys.set(id, key); await C.store.put("contacts", c); await subscribeAll();
  // L'intro-ack passe par l'outbox comme un message : reposté jusqu'à l'ack de l'autre côté
  // (son répondeur peut être injoignable à cet instant, ou mon onglet fermé juste après).
  const ack = { t: "intro-ack", id: C.uid(), name: S.me.name, tag: S.me.tag, color: S.me.color, epub: C.b64u.enc(S.me.e.pub), inbox: inbox.map(b => ({ relay: b.relay, box: b.box })) };
  await sendTo(c, ack); await C.store.put("outbox", { id: ack.id, contact: c.id, env: ack, posted: _lastPosted, at: Date.now() });
  // boîte d'accueil consommée
  S.welcome.delete(w.box); await C.kv.set("welcome", [...S.welcome.values()]);
  renderAll(); toast(`${c.name} a rejoint ton cercle`); if (!S.active) openChat(c.id);
}
// Porteurs : ajouter un répondeur = nouvelles boîtes d'entrée partout + carte envoyée aux contacts
async function addRelay(url) {
  url = url.trim(); if (!url || S.relays.includes(url)) return;
  S.relays.push(url); await C.kv.set("relays", S.relays); S.pool.get(url);
  for (const c of S.contacts.values()) {
    c.inbox.push(await C.newBox(url)); await C.store.put("contacts", c);
    sendTo(c, { t: "card", inbox: c.inbox.map(b => ({ relay: b.relay, box: b.box })) });
  }
  await subscribeAll(); renderRelays(); toast("Répondeur ajouté — tes contacts sont prévenus");
}

// ═══════════════════════ UI ═══════════════════════
const $$ = (s) => [...document.querySelectorAll(s)];
const COLORS = ["#30D158", "#0A84FF", "#BF5AF2", "#FF9F0A", "#FF375F", "#64D2FF", "#FFD60A", "#AC8E68"];
const colorOf = (o) => o?.color || COLORS[0];
const initials = (n) => String(n || "?").trim().slice(0, 2).toUpperCase();
function setAv(el, o) { el.textContent = initials(o?.name); el.style.setProperty("--c", colorOf(o)); }
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
  $("#me-name").textContent = `${S.me.name}#${S.me.tag}`; setAv($("#me-av"), S.me);
  renderContacts(); renderRelays(); renderChat();
}
function statusOf(c) {
  const l = S.links.get(c.id);
  if (c.pending) return { k: "off", t: "invitation en attente" };
  if (l?.open) return { k: "direct", t: "tunnel direct" };
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
    li.innerHTML = `<span class="av${st.k !== "off" ? " on" : ""}"></span><div class="cbody"><div class="cname">${esc(c.name)}<span class="tag">#${esc(c.tag)}</span></div><div class="cst${st.k === "direct" ? " on" : ""}">${sub}</div></div>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}`;
    setAv(li.querySelector(".av"), c);
    li.onclick = () => openChat(c.id);
    ul.appendChild(li);
  }
  const anyOpen = S.pool && S.pool.states().some(s => s.open);
  $("#relay-dot").className = "dot" + (anyOpen ? " on" : "");
  $("#relay-txt").textContent = anyOpen ? "répondeur joignable" : "aucun répondeur joignable — les messages attendront ici";
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
  $("#chat-title").textContent = `${c.name}#${c.tag}`; setAv($("#chat-av"), c);
  const st = statusOf(c);
  $("#chat-pill").textContent = st.t; $("#chat-pill").className = "pill " + st.k;
  $("#chat-sub").textContent = c.pending ? "elle/il doit encore accepter ton lien" : st.k === "direct" ? "le répondeur ne voit rien passer — fichiers illimités" : st.k === "relay" ? "messages déposés chiffrés au répondeur" : "les messages attendent au répondeur jusqu'à sa connexion";
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
    $("#acc-name").textContent = `${inv.name}#${inv.tag}`;
    const g = sn.split(" "); $("#acc-sn").textContent = [g.slice(0, 4), g.slice(4, 8), g.slice(8, 12)].map(x => x.join("  ")).join("\n");
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
function openSettings() {
  $("#settings").hidden = false; $("#set-name").value = S.me.name; $("#set-tag").textContent = S.me.tag;
  swatches($("#set-colors"), colorOf(S.me), async (c) => { S.me.color = c; await C.kv.set("me", S.me); renderAll(); broadcast({ t: "profile", name: S.me.name, color: c }); });
  renderRelays();
}
async function renameMe(name) {
  name = name.trim(); if (!name || name === S.me.name) return;
  S.me.name = name; await C.kv.set("me", S.me); renderAll();
  broadcast({ t: "profile", name, color: colorOf(S.me) }); toast("Nom mis à jour — tes contacts le verront à leur prochaine connexion");
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
boot();
