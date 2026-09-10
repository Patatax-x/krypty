# Publier Krypty : dépôt GitHub + site (GitHub Pages)

Le dépôt public `Patatax-x/krypty` contient uniquement ce dossier. Le site
`https://patatax-x.github.io/krypty/` sert la documentation (`docs/`) et **l'application elle-même**
(`web/`). GitHub Pages héberge du statique, gratuitement. Aucun autre service : les connexions se font
de navigateur à navigateur, et les messages en attente vivent chez les contacts.

## Ce qui part, ce qui ne part jamais

| Publié | Jamais publié |
|---|---|
| `web/`, `relay.py`, `serve.py`, `docs/`, `README.md`, `LICENSE`, `SECURITY.md` | l'app v1 (`app/`, URL Firebase, passphrase legacy), clés de signature, `settings.json`, sauvegardes `.krypty2` |

Le dépôt de travail `Krypty/` contient la v1 : on publie une **branche extraite** de `krypty2/` seulement.

## Mettre à jour

```bash
cd E:/Code/Projet/Concret/App/Krypty
git add krypty2 && git commit -m "krypty2 : ..."
git subtree split --prefix=krypty2 -b krypty-public
git push https://github.com/Patatax-x/krypty.git krypty-public:main
```
Pages se redéploie seul en une à deux minutes. Pas de cache à vider : pas de service worker.

## Première publication (faite le 2026-09-09)

Dépôt créé et Pages activé par l'API GitHub avec le jeton du gestionnaire d'identifiants Git
(`git credential fill`) : `POST /user/repos` puis `POST /repos/Patatax-x/krypty/pages` avec
`{"source":{"branch":"main","path":"/"}}`. Équivalent `gh` : `gh repo create krypty --public` puis
`gh api -X POST repos/Patatax-x/krypty/pages -f 'source[branch]=main' -f 'source[path]=/'`.

## Point de rendez-vous facultatif

Il n'y a plus d'interface pour en ajouter un : l'application en utilise un seulement s'il figure dans
une invitation reçue ou une sauvegarde restaurée (`relays` dans IndexedDB), ou sur `localhost` en
développement. Depuis une page `https://`, le navigateur n'accepte que `wss://` ou `ws://localhost` :
un membre du cercle qui lance `relay.py` chez lui doit l'exposer derrière un certificat TLS. Sans ça,
l'app fonctionne entièrement par codes et par le cercle, et c'est le cas nominal.

## Vérifier après publication

1. `https://patatax-x.github.io/krypty/web/` dans deux navigateurs.
2. Inviter sur A (lien ou QR), ouvrir sur B, choisir un nom, Ajouter, copier le code de réponse, le coller sur A. ⚡ en direct.
3. Fermer les deux, rouvrir, « Se connecter » sur A, coller sur B, recoller la réponse sur A.
