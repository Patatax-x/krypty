// Point de rendez-vous Krypty sur Cloudflare Workers (offre gratuite) : même protocole que relay.py.
// Un Durable Object unique tient les boîtes en mémoire + stockage. Il ne voit que des identifiants de
// boîtes aléatoires et des blobs chiffrés ; il efface à l'acquittement ou après TTL.
//
//   wrangler deploy   →   wss://krypty-relay.<compte>.workers.dev
//
// Protocole (JSON sur WebSocket) :
//   →  { op: "challenge", nonce }                   à la connexion
//   ←  { op: "sub", box, pub, sig }                 sig = Ed25519(nonce ‖ box) ; premier abonné = propriétaire
//   ←  { op: "post", box, blob }                    anonyme
//   →  { op: "msg", box, mid, blob }
//   ←  { op: "ack", mid }                           efface (propriétaire seulement)

const TTL_MS = 15 * 24 * 3600 * 1000, MAX_BLOB = 64 * 1024, MAX_PER_BOX = 200;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("krypty relay: connect with WebSocket\n", { status: 426, headers: { "content-type": "text/plain" } });
    }
    const id = env.RELAY.idFromName(url.pathname || "/");   // un DO par chemin : "/" par défaut
    return env.RELAY.get(id).fetch(req);
  },
};

export class Relay {
  constructor(state) {
    this.state = state;
    this.boxes = new Map();     // box -> Map(mid -> { exp, blob })
    this.owners = new Map();    // box -> { pub, at }
    // Par WebSocket (survit à l'hibernation) : { nonce, mine: [box] } via serializeAttachment.
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get(["boxes", "owners"]);
      for (const [b, list] of Object.entries(saved.get("boxes") || {})) this.boxes.set(b, new Map(Object.entries(list)));
      for (const [b, o] of Object.entries(saved.get("owners") || {})) this.owners.set(b, o);
      this.purge();
    });
  }
  async persist() {
    const boxes = {}; for (const [b, m] of this.boxes) if (m.size) boxes[b] = Object.fromEntries(m);
    await this.state.storage.put({ boxes, owners: Object.fromEntries(this.owners) });
  }
  purge() {
    const now = Date.now();
    for (const [b, m] of this.boxes) { for (const [mid, v] of m) if (v.exp < now) m.delete(mid); if (!m.size) this.boxes.delete(b); }
    for (const [b, o] of this.owners) if (now - o.at > TTL_MS) this.owners.delete(b);
  }
  async fetch() {
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
    server.serializeAttachment({ nonce, mine: [] });
    server.send(JSON.stringify({ op: "challenge", nonce }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment() || { nonce: "", mine: [] };
    const box = String(m.box || "").slice(0, 64);
    if (m.op === "post" && box) {
      const blob = String(m.blob || "");
      const list = this.boxes.get(box) || new Map();
      if (blob.length > MAX_BLOB * 4 / 3 + 4 || list.size >= MAX_PER_BOX) return;
      const mid = b64(crypto.getRandomValues(new Uint8Array(9)));
      list.set(mid, { exp: Date.now() + TTL_MS, blob }); this.boxes.set(box, list);
      for (const s of this.subscribers(box)) try { s.send(JSON.stringify({ op: "msg", box, mid, blob })); } catch {}
      await this.persist();
    } else if (m.op === "sub" && box) {
      let pub, ok = false;
      try {
        pub = unb64(m.pub); const sig = unb64(m.sig);
        const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
        ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, concat(unb64(me.nonce), new TextEncoder().encode(box)));
      } catch { ok = false; }
      if (!ok) return ws.send(JSON.stringify({ op: "err", box, why: "sig" }));
      const owner = this.owners.get(box), pubS = b64(pub);
      if (owner && owner.pub !== pubS) return ws.send(JSON.stringify({ op: "err", box, why: "owner" }));
      this.owners.set(box, { pub: pubS, at: Date.now() });
      if (!me.mine.includes(box)) me.mine.push(box); ws.serializeAttachment(me);
      ws.send(JSON.stringify({ op: "ok", box }));
      for (const [mid, v] of this.boxes.get(box) || []) ws.send(JSON.stringify({ op: "msg", box, mid, blob: v.blob }));
      await this.persist();
    } else if (m.op === "ack") {
      const mid = String(m.mid || ""); let changed = false;
      for (const b of me.mine) { const list = this.boxes.get(b); if (list && list.delete(mid)) { changed = true; if (!list.size) this.boxes.delete(b); } }
      if (changed) await this.persist();
    } else if (m.op === "stats") {
      let pending = 0; for (const l of this.boxes.values()) pending += l.size;
      ws.send(JSON.stringify({ op: "stats", boxes: this.boxes.size, pending }));
    }
  }
  subscribers(box) { return this.state.getWebSockets().filter(w => { try { return (w.deserializeAttachment()?.mine || []).includes(box); } catch { return false; } }); }
  webSocketClose(ws) { try { ws.close(); } catch {} }
  webSocketError(ws) { try { ws.close(); } catch {} }
}

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const concat = (a, b) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; };
