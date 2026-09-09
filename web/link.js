// krypty2/link.js — tunnel direct PC↔PC (WebRTC DataChannel).
// La signalisation (offre/réponse/candidats) passe par les boîtes du répondeur, chiffrée
// comme n'importe quel message. Une fois le tunnel ouvert, messages et fichiers passent
// en direct : le répondeur ne voit plus rien passer.
const ICE = { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }] };
const CHUNK = 64 * 1024;

export class Link {
  constructor(contactId, sendSignal, onEnvelope, onState) {
    this.cid = contactId; this.sendSignal = sendSignal; this.onEnvelope = onEnvelope; this.onState = onState || (() => {});
    this.pc = null; this.dc = null; this.files = new Map(); this.polite = false;
  }
  get open() { return this.dc && this.dc.readyState === "open"; }
  setup() {
    if (this.pc) return;
    this.pc = new RTCPeerConnection(ICE);
    this.pc.onicecandidate = (e) => { if (e.candidate) this.sendSignal({ t: "ice", c: e.candidate.toJSON() }); };
    this.pc.onconnectionstatechange = () => { this.onState(this.pc.connectionState); if (["failed", "closed", "disconnected"].includes(this.pc.connectionState)) this.teardown(); };
    this.pc.ondatachannel = (e) => this.attach(e.channel);
  }
  attach(dc) {
    this.dc = dc; dc.binaryType = "arraybuffer";
    dc.onopen = () => this.onState("open");
    dc.onclose = () => { this.onState("closed"); this.teardown(); };
    dc.onmessage = (ev) => this.recv(ev.data);
  }
  teardown() { try { this.dc && this.dc.close(); } catch {} try { this.pc && this.pc.close(); } catch {} this.dc = null; this.pc = null; }
  // Côté « impoli » (id le plus petit) initie ; l'autre attend l'offre → pas de collision.
  async offer() {
    if (this.pc) return;
    this.setup();
    this.attach(this.pc.createDataChannel("k", { ordered: true }));
    const o = await this.pc.createOffer(); await this.pc.setLocalDescription(o);
    this.sendSignal({ t: "offer", sdp: this.pc.localDescription });
  }
  async onSignal(m) {
    if (m.t === "offer") {
      if (this.pc && !this.polite) return;           // glare : l'impoli ignore l'offre adverse
      this.teardown(); this.setup();
      await this.pc.setRemoteDescription(m.sdp);
      const a = await this.pc.createAnswer(); await this.pc.setLocalDescription(a);
      this.sendSignal({ t: "answer", sdp: this.pc.localDescription });
    } else if (m.t === "answer") {
      if (this.pc && this.pc.signalingState === "have-local-offer") await this.pc.setRemoteDescription(m.sdp);
    } else if (m.t === "ice") {
      if (this.pc) { try { await this.pc.addIceCandidate(m.c); } catch {} }
    }
  }
  // Messages : chaînes (enveloppes scellées) ; fichiers : en-tête JSON puis chunks binaires.
  send(str) { if (!this.open) return false; try { this.dc.send(str); return true; } catch { this.teardown(); return false; } }   // canal en train de mourir → échec propre, pas d'exception
  async sendFile(meta, blob) {
    if (!this.open) return false;
    this.dc.send(JSON.stringify({ __file: meta }));
    const buf = await blob.arrayBuffer();
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      while (this.dc.bufferedAmount > 4 * CHUNK) await new Promise(r => setTimeout(r, 3));
      this.dc.send(buf.slice(off, off + CHUNK));
    }
    this.dc.send(JSON.stringify({ __fileEnd: meta.id }));
    return true;
  }
  recv(data) {
    if (typeof data === "string") {
      let j = null; try { j = JSON.parse(data); } catch {}
      if (j && j.__file) { this.files.set(j.__file.id, { meta: j.__file, parts: [], got: 0 }); return; }
      if (j && j.__fileEnd) { const f = this.files.get(j.__fileEnd); this.files.delete(j.__fileEnd); if (f) this.onEnvelope({ t: "file", meta: f.meta, blob: new Blob(f.parts) }); return; }
      this.onEnvelope({ t: "sealed", blob: data });
    } else {
      const cur = [...this.files.values()].at(-1); if (cur) { cur.parts.push(data); cur.got += data.byteLength; this.onEnvelope({ t: "progress", id: cur.meta.id, got: cur.got, size: cur.meta.size }); }
    }
  }
}
