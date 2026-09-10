// krypty2/carry.js — « le cercle est le relais ».
// Chaque client est aussi un porteur : il garde des boîtes pour ses contacts, exactement comme
// relay.py, mais par-dessus le tunnel direct. Le porteur ne voit que des ids de boîtes et des blobs
// chiffrés pour quelqu'un d'autre ; il ne peut pas les lire (clé de paire entre l'expéditeur et le
// destinataire, jamais la sienne). Il efface à l'ack ou après TTL.
import { kv, store, uid } from "./core.js";

const TTL = 15 * 24 * 3600 * 1000, MAX_PER_BOX = 200, MAX_BLOB = 96 * 1024, MAX_TOTAL = 3000, MAX_OWNERS = 500;

// ── Rôle serveur : je porte pour les autres ──
export class Carrier {
  constructor(send /* (cid, obj) => bool */) { this.send = send; this.owners = new Map(); this.ready = this.load(); }
  async load() {
    this.owners = new Map(Object.entries((await kv.get("boxowners")) || {}));
    const now = Date.now();
    for (const b of await store.all("carry")) if (b.exp < now) await store.del("carry", b.id);   // périmés
  }
  async save() { await kv.set("boxowners", Object.fromEntries(this.owners)); }
  async handle(cid, m) {
    await this.ready;
    if (m.__box === "sub") {                       // un contact réclame une boîte (première fois = il en devient propriétaire)
      const o = this.owners.get(m.box);
      if (o && o !== cid) return;
      if (!o) { if (this.owners.size >= MAX_OWNERS) return; this.owners.set(m.box, cid); await this.save(); }
      await this.deliver(cid, m.box);
    } else if (m.__box === "post") {              // un contact dépose pour un tiers
      const box = String(m.box || "").slice(0, 64), blob = String(m.blob || "");
      if (!box || blob.length > MAX_BLOB) return;
      const all = await store.all("carry");
      if (all.length >= MAX_TOTAL || all.filter(b => b.box === box).length >= MAX_PER_BOX) return;
      const ttl = Math.min(Number(m.ttl) || TTL, TTL);       // signalisation / présence : courte durée, ne s'empile pas
      const rec = { id: uid(), box, blob, exp: Date.now() + ttl };
      await store.put("carry", rec);
      const owner = this.owners.get(box);
      if (owner) this.send(owner, { __box: "msg", box, mid: rec.id, blob });
    } else if (m.__box === "ack") {               // le propriétaire a lu → on efface
      const rec = await store.get("carry", String(m.mid || ""));
      if (rec && this.owners.get(rec.box) === cid) await store.del("carry", rec.id);
    }
  }
  async deliver(cid, box) {
    for (const b of await store.all("carry")) if (b.box === box) this.send(cid, { __box: "msg", box: b.box, mid: b.id, blob: b.blob });
  }
  async onOpen(cid) {                             // tunnel (re)ouvert : tout ce qui attend pour lui
    await this.ready;
    for (const [box, o] of this.owners) if (o === cid) await this.deliver(cid, box);
  }
}

// ── Rôle client : un contact porte pour moi. Même interface que Relay (relay.js). ──
export class PeerRelay {
  constructor(cid, getLink, onBlob) { this.cid = cid; this.url = "peer:" + cid; this.getLink = getLink; this.onBlob = onBlob; this.subs = new Map(); }
  get open() { const l = this.getLink(this.cid); return !!(l && l.open); }
  sendJSON(o) { const l = this.getLink(this.cid); return !!(l && l.open && l.send(JSON.stringify(o))); }
  async subscribe(box, key, pub) { this.subs.set(box, { key, pub }); if (this.open) this.sendJSON({ __box: "sub", box }); }
  resub() { for (const box of this.subs.keys()) this.sendJSON({ __box: "sub", box }); }
  post(box, blob, ttl) { return this.sendJSON({ __box: "post", box, blob, ttl }); }
  async handle(m) {
    if (m.__box !== "msg") return;
    const ok = await this.onBlob(this.url, m.box, m.mid, m.blob);
    if (ok) this.sendJSON({ __box: "ack", mid: m.mid });
  }
}
