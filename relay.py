"""krypty-relay — répondeur aveugle minimal (prototype). ~100 lignes, Python + websockets.

Ce qu'il fait : des boîtes aux lettres identifiées par un id aléatoire. On y POSTE des blobs
opaques (déjà chiffrés côté client) ; un abonné WebSocket les reçoit en direct ; un blob est
supprimé dès qu'il est acquitté, ou après TTL. Rien d'autre.

Ce qu'il ne sait PAS : qui écrit, qui lit, ce que contient un blob, quel type de message,
quelles boîtes appartiennent à la même personne. Pas de compte, pas de journal.

Tourne partout où Python tourne : PC à la maison, Raspberry, VM gratuite, VPS.
Usage : py -3.14 proto/relay.py [port]      (défaut 8765)

Protocole (JSON sur WebSocket) :
  → {"op":"post", "box":"<id>", "blob":"<base64>"}        écrire (pas d'auth : l'id est le secret)
  → {"op":"sub",  "box":"<id>", "pub":"<b64 ed25519>", "sig":"<b64>"}   lire : signature du défi
  ← {"op":"challenge", "nonce":"<b64>"}                    envoyé à la connexion
  ← {"op":"msg", "box":"<id>", "mid":"<id>", "blob":"<base64>"}
  → {"op":"ack", "mid":"<id>"}                             → suppression définitive
Note : en prototype, `sub` accepte une clé publique quelconque et vérifie la signature du
défi avec elle ; la boîte est liée à cette clé au 1er `sub` (write-once). En prod : l'id de
boîte = hash(pubkey) → aucune liaison à stocker."""
try:
    import sys as _s; _s.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
import asyncio, json, os, sys, time, base64, hashlib
import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

TTL_S      = 15 * 24 * 3600      # 15 jours
MAX_BLOB   = 64 * 1024           # 64 Ko par blob (au-delà : P2P ou chunks)
MAX_PER_BOX = 200                # anti-saturation
boxes: dict[str, dict[str, tuple[float, str]]] = {}   # box -> {mid: (exp, blob)}
owners: dict[str, tuple[bytes, float]] = {}           # box -> (pubkey, dernier accès) — write-once
subs: dict[str, set] = {}                             # box -> websockets
stats = {"post": 0, "deliver": 0, "ack": 0, "refused": 0}

def purge():
    """Blobs expirés. La propriété d'une boîte n'expire QU'après TTL sans accès — sinon une
    boîte vidée (tout acquitté) redevenait libre et un intrus pouvait se l'approprier."""
    now = time.time()
    for b in list(boxes):
        boxes[b] = {m: v for m, v in boxes[b].items() if v[0] > now}
        if not boxes[b]: boxes.pop(b)
    for b in list(owners):
        if now - owners[b][1] > TTL_S: owners.pop(b)

async def deliver(ws, box):
    for mid, (_, blob) in list(boxes.get(box, {}).items()):
        await ws.send(json.dumps({"op": "msg", "box": box, "mid": mid, "blob": blob}))
        stats["deliver"] += 1

async def handle(ws):
    nonce = os.urandom(32)
    await ws.send(json.dumps({"op": "challenge", "nonce": base64.b64encode(nonce).decode()}))
    mine = set()
    try:
        async for raw in ws:
            try: m = json.loads(raw)
            except Exception: continue
            op, box = m.get("op"), str(m.get("box", ""))[:64]
            if op == "post" and box:
                blob = str(m.get("blob", ""))
                if len(blob) > MAX_BLOB * 4 // 3 + 4 or len(boxes.get(box, {})) >= MAX_PER_BOX:
                    stats["refused"] += 1; continue
                mid = base64.urlsafe_b64encode(os.urandom(9)).decode()
                boxes.setdefault(box, {})[mid] = (time.time() + TTL_S, blob)
                stats["post"] += 1
                for s in list(subs.get(box, ())):
                    try: await s.send(json.dumps({"op": "msg", "box": box, "mid": mid, "blob": blob})); stats["deliver"] += 1
                    except Exception: pass
            elif op == "sub" and box:
                try:
                    pub = base64.b64decode(m["pub"]); sig = base64.b64decode(m["sig"])
                    Ed25519PublicKey.from_public_bytes(pub).verify(sig, nonce + box.encode())
                except Exception:
                    stats["refused"] += 1; await ws.send(json.dumps({"op": "err", "box": box, "why": "sig"})); continue
                if owners.setdefault(box, (pub, time.time()))[0] != pub:
                    stats["refused"] += 1; await ws.send(json.dumps({"op": "err", "box": box, "why": "owner"})); continue
                owners[box] = (pub, time.time())
                subs.setdefault(box, set()).add(ws); mine.add(box)
                await ws.send(json.dumps({"op": "ok", "box": box}))
                await deliver(ws, box)
            elif op == "ack":
                mid = str(m.get("mid", ""))
                for b in mine:
                    if boxes.get(b, {}).pop(mid, None) is not None: stats["ack"] += 1
            elif op == "stats":
                await ws.send(json.dumps({"op": "stats", **stats, "boxes": len(boxes),
                                          "pending": sum(len(v) for v in boxes.values())}))
    finally:
        for b in mine: subs.get(b, set()).discard(ws)

async def main(port):
    async def purger():
        while True: await asyncio.sleep(60); purge()
    asyncio.create_task(purger())
    async with websockets.serve(handle, "0.0.0.0", port, max_size=MAX_BLOB * 2):
        print(f"krypty-relay prototype sur ws://0.0.0.0:{port} — TTL {TTL_S // 86400} j, blob ≤ {MAX_BLOB // 1024} Ko")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 8765))
