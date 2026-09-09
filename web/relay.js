// krypty2/relay.js — client du « répondeur » aveugle (voir ../relay.py).
// Une connexion WebSocket par répondeur. On s'abonne à ses propres boîtes (preuve par
// signature Ed25519 de la clé de boîte), on poste des blobs opaques dans les boîtes des
// autres. Le répondeur ne sait ni qui écrit, ni qui lit, ni ce que contient un blob.
import { b64u, edSign } from "./core.js";

export class Relay {
  constructor(url, onBlob, onState) {
    this.url = url; this.onBlob = onBlob; this.onState = onState || (() => {});
    this.ws = null; this.nonce = null; this.subs = new Map(); // box -> {key, pub}
    this.pendingPosts = []; this.backoff = 1000; this.closed = false;
    this.connect();
  }
  connect() {
    if (this.closed) return;
    try { this.ws = new WebSocket(this.url); } catch { return this.retry(); }
    this.ws.onopen = () => { this.backoff = 1000; this.onState(this.url, "open"); };
    this.ws.onclose = () => { this.onState(this.url, "closed"); this.retry(); };
    this.ws.onerror = () => {};
    this.ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
  }
  retry() { if (this.closed) return; setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 2, 30000); }
  close() { this.closed = true; try { this.ws && this.ws.close(); } catch {} }
  get open() { return this.ws && this.ws.readyState === 1; }
  send(o) { if (this.open) { this.ws.send(JSON.stringify(o)); return true; } return false; }
  async handle(m) {
    if (m.op === "challenge") {
      this.nonce = b64u.dec(m.nonce.replace(/-/g, "+").replace(/_/g, "/"));
      for (const box of this.subs.keys()) await this.doSub(box);       // ré-abonnement après reconnexion
      const q = this.pendingPosts.splice(0); for (const p of q) this.send({ op: "post", ...p });
    } else if (m.op === "msg") {
      const ok = await this.onBlob(this.url, m.box, m.mid, m.blob);   // true = traité → ack (suppression)
      if (ok) this.send({ op: "ack", mid: m.mid });
    } else if (m.op === "err") {
      this.onState(this.url, "err:" + m.why);
    }
  }
  async subscribe(box, key, pub) {
    this.subs.set(box, { key, pub });
    if (this.open && this.nonce) await this.doSub(box);
  }
  async doSub(box) {
    const { key, pub } = this.subs.get(box);
    const msg = new Uint8Array([...this.nonce, ...new TextEncoder().encode(box)]);
    const sig = await edSign(key, msg);
    this.send({ op: "sub", box, pub: std(pub), sig: std(b64u.enc(sig)) });
  }
  // Un post vers un répondeur pas encore connecté (nouvelle URL trouvée dans une invitation, ou
  // reconnexion en cours) est mis en attente et part à l'ouverture — sinon il était perdu en silence.
  post(box, blob) {
    if (this.open) return this.send({ op: "post", box, blob });
    if (!this.closed && this.pendingPosts.length < 200) { this.pendingPosts.push({ box, blob }); return true; }
    return false;
  }
}
// le répondeur Python attend du base64 standard pour pub/sig
const std = (s) => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);

// Pool : un Relay par URL, partagé par tous les contacts.
export class RelayPool {
  constructor(onBlob, onState) { this.onBlob = onBlob; this.onState = onState; this.relays = new Map(); }
  get(url) {
    if (!this.relays.has(url)) this.relays.set(url, new Relay(url, this.onBlob, this.onState));
    return this.relays.get(url);
  }
  // Poster un blob sur TOUTES les boîtes de sortie d'un contact (son répondeur + porteurs).
  // Renvoie le nombre de répondeurs joignables ayant accepté.
  post(outboxes, blob) {
    let n = 0;
    for (const o of outboxes) if (this.get(o.relay).post(o.box, blob)) n++;
    return n;
  }
  states() { return [...this.relays.values()].map(r => ({ url: r.url, open: r.open })); }
}
