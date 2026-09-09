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

## Interface (2026-09-09, 2e passe)
- Bug corrigé : `#onboard { display:grid }` l'emportait sur l'attribut `hidden` → les deux écrans
  s'affichaient en même temps après « Créer mon identité ». Règle `[hidden]{display:none!important}`.
- Onboarding : nom + couleur d'avatar, lien « restaurer une sauvegarde ». App : liste de contacts avec
  aperçu du dernier message, badge non-lus, recherche ; en-tête de conversation avec pastille
  d'état (hors ligne / en ligne / tunnel direct) ; séparateurs de jour ; modale Inviter/Rejoindre ;
  modale d'acceptation avec numéro de sécurité (plus de `confirm()`) ; Réglages (renommer, couleur,
  répondeurs, notifications, **export/import de sauvegarde chiffrée `.krypty2`**, tout effacer).
  Mobile : une colonne, bouton retour. Le changement de nom/couleur est diffusé aux contacts (`profile`).
- Protocole : `intro-ack` passe par l'outbox et est acquitté (avant : perdu si le répondeur de l'autre
  n'était pas encore connecté) ; un `post` vers un répondeur pas encore ouvert est mis en file ;
  `relay.py` écoute en IPv4+IPv6 (`ws://localhost` mettait ~9 s à cause de `::1`).
- Publication : voir `DEPLOY.md` (dépôt public + GitHub Pages, app servie depuis `web/`, doc dans `docs/`).

## Le cercle est le relais (2026-09-09, 3e passe) — `web/carry.js`
- **Porteurs automatiques** : mes 2 contacts les plus récents gardent mes messages quand je suis absent.
  Choisis tout seuls (`pickCarriers`), recalculés à chaque contact ajouté / message reçu, annoncés aux
  contacts par la « carte » (`card`, aussi portée par chaque `hello`). Aucun réglage.
- Chaque client est un porteur (`Carrier`) : boîtes anonymes + blobs chiffrés dans IndexedDB `carry`,
  même sémantique que `relay.py`, par-dessus le tunnel WebRTC (`{__box: sub|post|msg|ack}`). Le porteur
  **ne peut pas lire** : clé de paire expéditeur↔destinataire, jamais la sienne. Efface à l'ack, TTL 15 j
  (5 min pour présence/signalisation).
- Le cercle d'abord : si un porteur accepte, le point de rendez-vous WebSocket ne voit pas passer le
  message. Périmé/doublon : chaque enveloppe a un id, la 2e arrivée (autre chemin) est jetée puis acquittée.
- **Limite structurelle** : pour (re)connecter deux navigateurs, il faut un point joignable pour la
  signalisation WebRTC (un contact commun déjà en tunnel, ou un `relay.py`). Sans aucun point de
  rendez-vous, deux navigateurs derrière deux box ne peuvent pas se trouver. `BOOTSTRAP_RELAYS` (app.js)
  est vide : en production il faudra soit un mini rendez-vous gratuit (Cloudflare Worker), soit l'app de
  bureau qui embarque `relay.py`. Le rendez-vous ne voit que des boîtes anonymes et des blobs chiffrés.
- Vérifié : Alice absente → Bob écrit → blob stocké chez Chloé (184 o) → Alice revient → reçu, ✓✓ chez Bob,
  store de Chloé vidé. Trois tunnels rétablis après rechargement.

## Interface (3e passe)
- Tag `#XXXX` caché partout (fiche contact → détails techniques). Acceptation en un clic ; vérification
  optionnelle par **5 emojis** identiques des deux côtés (fiche contact), numéro à 60 chiffres en détails.
- Photo de profil (96 px JPEG ~2-5 Ko, chiffrée vers les contacts, jamais ailleurs), renommage local d'un contact,
  retrait du cercle. Pied de liste : « Prêt » / « Ajoute un contact pour commencer » (plus de « répondeur »).
- Réglages → « Hors ligne » explique en une phrase qui garde les messages ; « Avancé » pour les points de rendez-vous.
- Dev : `window.K` = état (localhost uniquement).

## Pas encore fait
- Partage de secret (Shamir) entre porteurs ; rendez-vous d'amorçage gratuit ; app de bureau avec relay embarqué.
- Pas de forward secrecy (clé de paire statique). Pas de groupes. Pas de PWA/offline-cache, pas de Tauri.
