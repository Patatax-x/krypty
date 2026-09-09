# Krypty 2 — « La messagerie qui ne sait pas que vous existez »

Prototype testable. Aucun compte, aucun annuaire, aucun serveur qui garde un nom.

- `web/` — l'app (navigateur). Identité = paire de clés locale. Chiffrement X25519 + HKDF + AES-256-GCM
  par paire. Historique dans IndexedDB. Tunnel direct WebRTC quand les deux sont en ligne
  (fichiers sans limite), sinon dépôt chiffré dans des boîtes anonymes sur un ou plusieurs
  « répondeurs ».
- `relay.py` — le répondeur aveugle (~100 lignes). Ne voit que des ids de boîtes aléatoires et des
  blobs chiffrés. Efface à la lecture (ack) ou après 15 jours. Peut tourner chez vous, chez un contact,
  sur un Raspberry : **le cercle est le relais**.

## Tester en local
```
py -3.14 -m pip install websockets cryptography
py -3.14 krypty2/relay.py 8765
py -3.14 krypty2/serve.py 8080      # statique + Cache-Control: no-store (les modules ES sinon restent en cache)
py -3.14 krypty2/serve.py 8081      # 2e origine = 2e identité dans le même navigateur (IndexedDB séparée)
```
Ouvrir http://localhost:8080 dans deux navigateurs (ou un onglet normal + un onglet privé :
IndexedDB séparée). Sur A : « ＋ Inviter » → copier le lien. Sur B : coller → Rejoindre.
Les deux se voient, échangent, passent en tunnel direct (⚡). Fermer B, écrire sur A : le message
attend au répondeur (⏳ → ✓) et arrive à la réouverture de B (✓✓ à la lecture).

## Sur deux PC
Remplacer `localhost` par l'IP du PC qui fait tourner `relay.py` (bouton « Ajouter » un répondeur,
puis « ＋ Inviter »). Chaque contact peut ajouter son propre répondeur : les messages sont déposés
sur tous les répondeurs connus du destinataire (dédoublonnés à l'arrivée).

## Vérifié le 2026-09-09 (deux onglets, 127.0.0.1:8080 / :8081, relay local)
- Onboarding → identité `Nom#TAG`, répondeur connecté.
- Invitation (lien `#i/…` signé Ed25519) → intro dans la boîte d'accueil → intro-ack → les deux « en ligne ».
- Message via répondeur : ⏱ → ✓ → ✓✓ (ack chiffré du destinataire, blob effacé au répondeur).
- Tunnel WebRTC ouvert automatiquement (signalisation chiffrée via boîtes) : messages ⚡, fichier 300 Ko
  transféré en chunks 64 Ko, SHA-256 identique des deux côtés.
- Hors-ligne : onglet B fermé, A envoie → ✓ (déposé) ; B rouvre → reçoit, A passe en ✓✓, tunnel relancé.

Corrigés pendant le test : `tx()` renvoyait l'objet requête au lieu de `undefined` pour une clé absente ;
rendu du chat qui pouvait peindre un état périmé (garde de séquence) ; envoi « direct » dans un tunnel
mourant compté comme livré (→ tout reste en outbox jusqu'à l'ack, repost via répondeur après 8 s) ;
`hello` de présence limité à 1 / 10 min par contact silencieux (sinon la boîte se remplissait).

## Pas encore fait
- Porteurs (« le cercle est le relais ») : `addRelay` + carte `card` existent, mais pas le dépôt chez
  un contact tiers ni le partage de secret (Shamir). Le répondeur Python reste le seul relais.
- Pas de forward secrecy (clé de paire statique). Pas de groupes. Pas de PWA/offline-cache, pas de Tauri.
