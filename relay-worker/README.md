# Point de rendez-vous sur Cloudflare Workers (gratuit)

Même protocole que `../relay.py`, hébergé sans serveur. Nécessaire pour que deux navigateurs se
trouvent la première fois (ou après un redémarrage sans contact commun en ligne). Il ne voit que des
identifiants de boîtes aléatoires et des blobs chiffrés, et efface à l'acquittement.

```bash
npm install -g wrangler
wrangler login
cd relay-worker
wrangler deploy
# → https://krypty-relay.<compte>.workers.dev
```

Dans l'app : Réglages, Avancé, ajouter `wss://krypty-relay.<compte>.workers.dev`.
Pour en faire le rendez-vous par défaut de votre déploiement : `BOOTSTRAP_RELAYS` dans `web/app.js`.

Limites de l'offre gratuite (2025) : 100 000 requêtes/jour, Durable Objects avec stockage SQLite,
largement suffisant pour quelques centaines de cercles. Test local : `wrangler dev` puis `ws://localhost:8787`.
