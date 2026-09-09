# Publier Krypty : dépôt GitHub + site (GitHub Pages)

Le dépôt public `Patatax-x/krypty` contient uniquement ce dossier. Le site
`https://patatax-x.github.io/krypty/` sert la documentation (`docs/`) et **l'application elle-même**
(`web/`). Pages héberge du statique, gratuitement ; les points de rendez-vous et les porteurs sont
ailleurs (chez les utilisateurs, ou un Worker Cloudflare gratuit).

## Ce qui part, ce qui ne part jamais

| Publié | Jamais publié |
|---|---|
| `web/`, `relay.py`, `relay-worker/`, `serve.py`, `docs/`, `README.md`, `LICENSE`, `SECURITY.md` | l'app v1 (`app/`, URL Firebase, passphrase legacy), clés de signature, `settings.json`, sauvegardes `.krypty2` |

Le dépôt de travail `Krypty/` contient la v1 : on publie une **branche extraite** de `krypty2/` seulement,
sans réécrire d'historique.

## Première publication (fait le 2026-09-09)

```bash
cd E:/Code/Projet/Concret/App/Krypty
git subtree split --prefix=krypty2 -b krypty-public          # historique de krypty2/ uniquement
curl -X POST https://api.github.com/user/repos -H "Authorization: token $GH" \
     -d '{"name":"krypty","description":"La messagerie qui ne sait pas que vous existez.","homepage":"https://patatax-x.github.io/krypty/"}'
git push https://github.com/Patatax-x/krypty.git krypty-public:main
curl -X POST https://api.github.com/repos/Patatax-x/krypty/pages -H "Authorization: token $GH" \
     -d '{"source":{"branch":"main","path":"/"}}'
```
`$GH` est le jeton du gestionnaire d'identifiants Git (`git credential fill`). Avec `gh` :
`gh repo create krypty --public` puis `gh api -X POST repos/Patatax-x/krypty/pages -f 'source[branch]=main' -f 'source[path]=/'`.

## Mettre à jour

```bash
cd E:/Code/Projet/Concret/App/Krypty
git add krypty2 && git commit -m "krypty2 : ..."
git subtree split --prefix=krypty2 -b krypty-public
git push https://github.com/Patatax-x/krypty.git krypty-public:main
```
Pages se redéploie seul en une à deux minutes. Pas de cache à vider : pas de service worker.

## Le point à connaître : https et WebSocket

Une page servie en `https://` n'ouvre que des `wss://`, sauf vers `localhost` / `127.0.0.1`.

| Point de rendez-vous | Depuis le site (https) | Depuis `serve.py` (http local) |
|---|---|---|
| `ws://localhost:8765` sur le PC de l'utilisateur | oui | oui |
| `ws://192.168.x.x:8765` sur un autre PC du LAN | non (mixed content) | oui |
| `wss://…` (Worker Cloudflare, Caddy, tunnel) | oui | oui |

Pour que deux personnes se trouvent depuis le site sans rien installer, il faut un `wss://` public.
`relay-worker/` en déploie un gratuitement (`wrangler deploy`), et son URL peut devenir le rendez-vous
par défaut (`BOOTSTRAP_RELAYS` dans `web/app.js`). Une fois reliés, les contacts se portent entre eux.

## Vérifier après publication

1. `https://patatax-x.github.io/krypty/web/` dans deux navigateurs (ou normal + privé).
2. Réglages, Avancé : ajouter un `wss://` (Worker) ou `ws://localhost:8765` si `relay.py` tourne ici.
3. Inviter sur A, coller sur B, Ajouter. Message ✓✓, puis ⚡ en direct.
4. Fermer B, écrire depuis A, rouvrir B.
