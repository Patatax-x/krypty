# Krypty

**La messagerie qui ne sait pas que vous existez.**

Pas de compte, pas de numéro, pas d'annuaire, pas de serveur. Votre identité est une paire de clés créée
dans votre navigateur. Vous invitez quelqu'un par un lien, la personne vous renvoie un code, et vous
parlez en direct, de navigateur à navigateur. Quand l'un de vous est absent, ce sont vos contacts qui
gardent le message chiffré. **Le cercle est le relais.** Rien à installer, aucun tiers.

Application : https://patatax-x.github.io/krypty/web/ · Documentation : https://patatax-x.github.io/krypty/

## Comment ça marche

```
 Alice ──── lien d'invitation (offre de connexion incluse) ── n'importe quel canal ──▶ Bob
 Alice ◀─── code de réponse ─────────────────────────────── n'importe quel canal ──── Bob
 Alice ◀══════════════ tunnel direct WebRTC : messages, fichiers ═══════════════════▶ Bob
 Alice ──── blob chiffré déposé chez Chloé (contact commun en ligne) ──▶ … Bob revient ──▶ livré, effacé
```

| Brique | Rôle | Ce qu'elle voit |
|---|---|---|
| Identité | X25519 + Ed25519 générées par WebCrypto, stockées dans IndexedDB | Vous seul |
| Clé de conversation | HKDF-SHA256(X25519(moi, lui)) → AES-256-GCM, dérivée localement | Les deux contacts |
| Tunnel direct (`web/link.js`) | WebRTC DataChannel. Ouvert par codes copiés-collés, ou par un contact déjà relié | Rien : chiffré deux fois |
| Porteur (`web/carry.js`) | Un contact garde des boîtes anonymes pour ses contacts, par-dessus le tunnel | Ids de boîtes, blobs chiffrés, horaires |
| Point de rendez-vous (`relay.py`, facultatif) | Même chose, chez un membre du cercle qui veut bien lancer un script | Ids de boîtes, blobs chiffrés, horaires |

- **Codes** : une offre WebRTC complète tient en ~900 caractères une fois compressée. Le lien d'invitation
  en contient une ; la réponse en est une autre, scellée pour l'inviteur. Pour se reconnecter plus tard :
  « Se connecter » donne un code, l'autre renvoie le sien. Les deux doivent être en ligne.
- **Cercle** : une fois relié à un contact, il transmet la signalisation vers vos contacts communs, et il
  garde vos messages quand vous êtes absent. Les porteurs sont vos deux contacts les plus récents, choisis
  automatiquement. Un message a un identifiant ; la première copie compte, les autres sont jetées.
- **STUN** : désactivé par défaut. Sans lui, la connexion directe passe en IPv6 ou sur le même réseau.
  Réglages, Avancé, pour l'activer (un serveur public voit alors votre IP, rien d'autre).

## Essayer

En ligne : ouvrir l'application dans deux navigateurs (ou une fenêtre normale et une privée).
Sur l'un : « Inviter », copier le lien. Sur l'autre : « Rejoindre », coller, « Ajouter », copier le code
de réponse. Sur le premier : « Rejoindre », coller le code. Vous êtes reliés.

En local :

```bash
python serve.py 8080          # sert web/ sans cache
python serve.py 8081          # une deuxième origine = une deuxième identité dans le même navigateur
python relay.py 8765          # facultatif : point de rendez-vous, ~100 lignes (pip install websockets cryptography)
```

## Structure

```
web/            l'application (HTML/CSS/JS, modules ES, aucune dépendance)
  core.js         crypto, IndexedDB, sauvegarde chiffrée, codes compressés
  link.js         tunnel direct WebRTC : codes, signalisation, fichiers en chunks
  carry.js        porteur : boîtes pour les contacts, par-dessus le tunnel
  relay.js        client d'un point de rendez-vous (WebSocket), facultatif
  app.js          protocole (invitation, cartes, outbox, présence) + interface
relay.py        point de rendez-vous Python, facultatif
docs/           site de documentation (GitHub Pages)
serve.py        serveur statique de développement
```

## Limites connues

- Deux navigateurs ne peuvent pas se trouver seuls : la première connexion, et chaque reconnexion sans
  contact commun en ligne, demande un échange de codes par un autre canal. C'est le prix du zéro serveur.
- Une identité vit sur un appareil. La sauvegarde chiffrée (`.krypty2`) permet de la déplacer.
- Pas de confidentialité persistante : la clé de paire est statique.
- Fichiers uniquement en direct. Pas de groupes.

Voir `SECURITY.md` pour le modèle de menace. Licence MIT.
