# Sécurité

Krypty est un prototype. Le protocole n'a pas encore été audité par un tiers.

## Signaler une faille

Ouvrez une issue privée (« Report a vulnerability » dans l'onglet Security du dépôt) ou écrivez à
l'adresse indiquée sur le profil GitHub du mainteneur. Merci de ne pas publier de détails avant un correctif.

## Ce que le modèle garantit

- Contenu des messages, noms, photos : chiffrés de bout en bout (X25519 + HKDF-SHA256 + AES-256-GCM),
  clé dérivée localement des deux côtés, jamais transmise.
- Points de rendez-vous et porteurs : ne voient que des identifiants de boîtes aléatoires et des
  blobs chiffrés. Lire une boîte demande une signature Ed25519 ; poster est anonyme.
- Invitations : signées Ed25519, refusées si modifiées.

## Ce qu'il ne garantit pas (encore)

- Pas de confidentialité persistante (forward secrecy) : la clé de paire est statique.
- Un porteur (contact commun) sait qu'un message est passé entre deux de ses contacts, et quand.
- Un point de rendez-vous peut jeter des blobs (déni de service) ou observer des horaires.
- Le navigateur est la base de confiance : extensions, profil compromis ou machine partagée
  donnent accès aux clés. La sauvegarde chiffrée est le seul moyen de les déplacer.
