// Tunnel direct navigateur ↔ navigateur (WebRTC DataChannel).
// Deux façons d'ouvrir un tunnel :
//  - par « codes » : l'offre complète (candidats inclus) est copiée-collée par un autre canal, la
//    réponse revient de la même façon. Aucun serveur. Les deux doivent être en ligne.
//  - par signalisation : offre / réponse / candidats passent par un contact déjà relié ou un point
//    de rendez-vous, chiffrés comme n'importe quel message.
// Une fois ouvert, messages et fichiers passent en direct.
const CHUNK = 64 * 1024, GATHER_MS = 3000;

export class Link {
  // ice : liste de serveurs STUN, vide par défaut (aucun tiers). Réglable par l'app.
  static ice = [];
  constructor(cid, sendSignal, onEnvelope, onState) {
    this.cid = cid; this.sendSignal = sendSignal; this.onEnvelope = onEnvelope; this.onState = onState || (() => {});
    this.pc = null; this.dc = null; this.files = new Map(); this.polite = false; this.manual = false;
  }
  get open() { return !!this.dc && this.dc.readyState === "open"; }
  setup() {
    if (this.pc) return;
    const pc = this.pc = new RTCPeerConnection({ iceServers: Link.ice.length ? [{ urls: Link.ice }] : [] });
    // Les événements d'une ancienne connexion (fermée par teardown) arrivent après coup : on les ignore.
    pc.onicecandidate = (e) => { if (this.pc === pc && e.candidate && !this.manual) this.sendSignal({ t: "ice", c: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (this.pc !== pc) return; this.onState(pc.connectionState); if (["failed", "closed"].includes(pc.connectionState)) this.teardown(); };
    pc.ondatachannel = (e) => { if (this.pc === pc) this.attach(e.channel); };
  }
  attach(dc) {
    this.dc = dc; dc.binaryType = "arraybuffer";
    dc.onopen = () => { if (this.dc === dc) this.onState("open"); };
    dc.onclose = () => { if (this.dc !== dc) return; this.onState("closed"); this.teardown(); };
    dc.onmessage = (ev) => { if (this.dc === dc) this.recv(ev.data); };
  }
  teardown() { try { this.dc && this.dc.close(); } catch {} try { this.pc && this.pc.close(); } catch {} this.dc = null; this.pc = null; this.manual = false; }
  gathered() {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, GATHER_MS);
      this.pc.onicegatheringstatechange = () => { if (this.pc.iceGatheringState === "complete") { clearTimeout(t); res(); } };
    });
  }

  // ── Codes : offre / réponse complètes, à transmettre par un autre canal ──
  async offerCode() {
    this.teardown(); this.setup(); this.manual = true;
    this.attach(this.pc.createDataChannel("k", { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gathered();
    return this.pc.localDescription.sdp;
  }
  async answerCode(sdp) {
    this.teardown(); this.setup(); this.manual = true;
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gathered();
    return this.pc.localDescription.sdp;
  }
  async acceptAnswer(sdp) {
    if (!this.pc || this.pc.signalingState !== "have-local-offer") return false;
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    return true;
  }

  // ── Signalisation par messages (contact relié ou point de rendez-vous) ──
  // Le côté « impoli » (id le plus petit) initie ; l'autre attend l'offre : pas de collision.
  async offer() {
    if (this.pc) return;
    this.setup();
    this.attach(this.pc.createDataChannel("k", { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.sendSignal({ t: "offer", sdp: this.pc.localDescription });
  }
  async onSignal(m) {
    if (m.t === "offer") {
      if (this.pc && !this.polite) return;
      this.teardown(); this.setup();
      await this.pc.setRemoteDescription(m.sdp);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      this.sendSignal({ t: "answer", sdp: this.pc.localDescription });
    } else if (m.t === "answer") {
      if (this.pc && this.pc.signalingState === "have-local-offer") { try { await this.pc.setRemoteDescription(m.sdp); } catch {} }
    } else if (m.t === "ice") {
      if (this.pc) { try { await this.pc.addIceCandidate(m.c); } catch {} }
    }
  }

  // ── Données : chaînes = enveloppes scellées ou messages de boîte ; fichiers = en-tête puis chunks ──
  send(str) { if (!this.open) return false; try { this.dc.send(str); return true; } catch { this.teardown(); return false; } }
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
      if (j && j.__box) { this.onEnvelope({ t: "box", m: j }); return; }
      if (j && j.__file) { this.files.set(j.__file.id, { meta: j.__file, parts: [], got: 0 }); return; }
      if (j && j.__fileEnd) { const f = this.files.get(j.__fileEnd); this.files.delete(j.__fileEnd); if (f) this.onEnvelope({ t: "file", meta: f.meta, blob: new Blob(f.parts) }); return; }
      this.onEnvelope({ t: "sealed", blob: data });
    } else {
      const cur = [...this.files.values()].at(-1);
      if (cur) { cur.parts.push(data); cur.got += data.byteLength; this.onEnvelope({ t: "progress", id: cur.meta.id, got: cur.got, size: cur.meta.size }); }
    }
  }
}
