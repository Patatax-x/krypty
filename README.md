# Krypty

**La messagerie qui ne sait pas que vous existez.**

Pas de compte, pas de numéro, pas d'annuaire, pas de serveur qui garde vos messages. Votre identité est
une paire de clés créée dans votre navigateur. Vous invitez quelqu'un par un lien, vous parlez en direct
quand vous êtes tous les deux en ligne, et quand l'un est absent, ce sont vos contacts qui gardent le
message chiffré pour vous. **Le cercle est le relais.**

Site et application : voir la section « Essayer ». Documentation : `docs/`.

## Comment ça marche

```
 Alice ──── lien d'invitation (n'importe quel canal) ────▶ Bob
        ◀── intro chiffrée, boîte d'accueil à usage unique ──
 Alice ◀════════ tunnel direct WebRTC (messages, fichiers) ════════▶ Bob
 Alice ──── blob chiffré déposé chez Chloé (contact commun) ──▶ … Bob revient ──▶ livré, effacé
```

| Brique | Rôle | Ce qu'elle voit |
|---|---|---|
| Identité | X25519 + Ed25519 générées par WebCrypto, stockées dans IndexedDB | Vous seul |
| Clé de conversation | HKDF-SHA256(X25519(moi, lui)) → AES-256-GCM, dérivée localement | Les deux contacts |
| Tunnel direct | WebRTC DataChannel, STUN public interchangeable | Rien : chiffré deux fois |
| Porteur (`web/carry.js`) | Un contact garde des boîtes anonymes pour ses contacts, par-dessus le tunnel | Ids de boîtes, blobs chiffrés, horaires |
| Point de rendez-vous (`relay.py`, `relay-worker/`) | Boîtes anonymes pour la première connexion et la signalisation | Ids de boîtes, blobs chiffrés, horaires |

Les porteurs sont choisis automatiquement : vos deux contacts les plus récents. Rien à configurer.
Chaque message a un identifiant ; s'il arrive par plusieurs chemins, la première copie compte, les autres
sont jetées et effacées.

## Essayer

En local, avec un point de rendez-vous sur votre machine :

```bash
pip install websockets cryptography
python relay.py 8765          # point de rendez-vous, ~100 lignes
python serve.py 8080          # sert web/ sans cache
python serve.py 8081          # une deuxième origine = une deuxième identité dans le même navigateur
```

Ouvrir `http://localhost:8080` et `http://localhost:8081`. Sur l'un : « Inviter », copier le lien.
Sur l'autre : « Rejoindre », coller, « Ajouter ». Fermer un onglet, écrire depuis l'autre, rouvrir.

Depuis la version en ligne (GitHub Pages, servie en `https://`), le navigateur n'accepte que `wss://` ou
`localhost` comme point de rendez-vous. `relay-worker/` déploie le même relais gratuitement sur
Cloudflare Workers en une commande ; `DEPLOY.md` détaille le tout.

## Structure

```
web/            l'application (HTML/CSS/JS, modules ES, aucune dépendance)
  core.js         crypto, IndexedDB, sauvegarde chiffrée
  relay.js        client du point de rendez-vous (WebSocket)
  link.js         tunnel direct WebRTC, fichiers en chunks
  carry.js        porteur : boîtes pour les contacts, par-dessus le tunnel
  app.js          protocole (invitation, cartes, outbox, présence) + interface
relay.py        point de rendez-vous Python (websockets)
relay-worker/   le même, pour Cloudflare Workers
docs/           site de documentation (GitHub Pages)
serve.py        serveur statique de développement
```

## Limites connues

- Une identité vit sur un appareil. La sauvegarde chiffrée (`.krypty2`) permet de la déplacer ; deux
  appareils actifs en même temps se partagent les boîtes sans se synchroniser.
- Pas de confidentialité persistante : la clé de paire est statique.
- Deux navigateurs ne peuvent pas se trouver seuls : la signalisation WebRTC passe par un contact
  commun déjà connecté, ou par un point de rendez-vous.
- Fichiers uniquement en direct. Pas de groupes.

Voir `SECURITY.md` pour le modèle de menace. Licence MIT.
