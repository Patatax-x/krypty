# Publier Krypty 2 — nouveau dépôt + site public (GitHub Pages)

Objectif : un dépôt public `krypty` qui contient l'app, le répondeur et la doc ; le site
`https://<toi>.github.io/krypty/` sert **l'app elle-même** (dossier `web/`) et la doc (`docs/`).
Aucun serveur à payer : Pages héberge du statique, les répondeurs tournent chez les utilisateurs.

## 0. Ce qui part, ce qui ne part pas

| Part dans le dépôt public | Ne part **jamais** |
|---|---|
| `web/` (app), `relay.py`, `serve.py`, `docs/`, `README.md`, `DEPLOY.md`, `LICENSE` | `~/.krypty/*.pem` (clé de signature v1), `settings.json`, `history.json`, sauvegardes `.krypty2`, tout l'ancien `app/` v1 (Firebase URL + passphrase legacy en clair) |

> Le dépôt actuel `Krypty/` contient l'app v1 avec l'URL Firebase et la passphrase legacy dans `app.py`.
> On ne publie **que** `krypty2/` dans un dépôt neuf — pas d'historique git à nettoyer.

## 1. Créer le dépôt (une fois)

```bash
cd E:/Code/Projet/Concret/App/Krypty/krypty2
git init -b main
printf '__pycache__/\n*.krypty2\n.DS_Store\n' > .gitignore
touch .nojekyll                      # Pages sert les fichiers tels quels (pas de build Jekyll)
git add . && git -c user.name="Morgan" -c user.email="morgan.bouchon@gmail.com" commit -m "Krypty 2 — première publication"
gh repo create krypty --public --source=. --remote=origin --push \
   --description "La messagerie qui ne sait pas que vous existez."
```

Sans `gh` : créer le dépôt vide sur github.com, puis
`git remote add origin https://github.com/<toi>/krypty.git && git push -u origin main`.

## 2. Activer GitHub Pages (une fois)

```bash
gh api -X POST repos/<toi>/krypty/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/'
```
ou : **Settings → Pages → Source : Deploy from a branch → `main` / `/ (root)`**.

Résultat, 1 à 2 min plus tard :
- `https://<toi>.github.io/krypty/` → page d'accueil / doc (`index.html` racine, redirige vers `docs/`)
- `https://<toi>.github.io/krypty/web/` → **l'application**
- `https://<toi>.github.io/krypty/docs/` → documentation

## 3. Mettre à jour (à chaque changement)

```bash
cd E:/Code/Projet/Concret/App/Krypty/krypty2
git add -A && git commit -m "web : <quoi>" && git push
```
Pages se redéploie tout seul (~1 min). Pas de cache à vider : les modules ES sont servis avec ETag,
et l'app n'a pas de service worker pour l'instant.

## 4. HTTPS ↔ répondeur : la règle à connaître

Une page servie en `https://` ne peut ouvrir que des `wss://` (WebSocket chiffré)… **sauf vers
`localhost` / `127.0.0.1`**, que les navigateurs considèrent sûrs. Donc :

| Répondeur | Depuis la version Pages (https) | Depuis `serve.py` local (http) |
|---|---|---|
| `ws://localhost:8765` (sur le PC de l'utilisateur) | ✅ | ✅ |
| `ws://192.168.x.x:8765` (autre PC du LAN) | ❌ bloqué (mixed content) | ✅ |
| `wss://mon-domaine:8765` (TLS) | ✅ | ✅ |

Pour un répondeur joignable depuis Internet en `wss://`, deux options gratuites :
1. **Caddy** devant `relay.py` (certificat Let's Encrypt automatique, 3 lignes de config) :
   ```
   relais.mondomaine.fr { reverse_proxy localhost:8765 }
   ```
2. **Tunnel Cloudflare** (`cloudflared tunnel --url ws://localhost:8765`) — donne une URL `wss://…trycloudflare.com`
   sans ouvrir de port. Un tiers voit passer des blobs chiffrés et des ids de boîtes, rien d'autre.

À terme : l'app de bureau (Tauri/pywebview) embarquera `relay.py` et l'exposera en `ws://localhost`,
donc **zéro configuration** pour l'utilisateur de bureau ; le navigateur seul utilise le répondeur d'un
contact du cercle.

## 5. Vérification après publication

1. Ouvrir `https://<toi>.github.io/krypty/web/` dans deux navigateurs différents (ou normal + privé).
2. Lancer `py -3.14 relay.py 8765` sur le PC ; dans l'app, Réglages → Répondeurs → `ws://localhost:8765`.
3. Inviter A → coller chez B → numéro de sécurité identique → message ✓✓ → ⚡ tunnel.
4. Fermer B, écrire depuis A (✓), rouvrir B (✓✓).

## 6. Licence et signalement

- Ajouter `LICENSE` (MIT ou AGPL-3.0 si tu veux que les forks restent ouverts).
- `SECURITY.md` : « signaler une faille par invitation Krypty à … » est cohérent avec le produit, mais
  garder aussi un mail — un chercheur n'a pas encore de client.
