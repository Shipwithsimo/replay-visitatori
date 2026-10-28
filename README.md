# Replay visitatori

App Shopify ad uso personale per vedere **in tempo reale** e **rivedere** cosa fanno i visitatori del negozio: pagina, scroll, movimenti del mouse, click, cambi di pagina e carrello.

## Come funziona

```
Negozio (app embed) ──eventi rrweb ogni 1s──▶ Server Node ──WebSocket──▶ Pannello (live)
                                                   │
                                                   └── SQLite ──▶ Pannello (replay)
```

- `extensions/replay-recorder` – app embed del tema che carica `/recorder.js` su ogni pagina del negozio. Lo script usa [rrweb](https://github.com/rrweb-io/rrweb) e maschera tutti i campi dei moduli.
- `server/` – riceve gli eventi (`POST /ingest`), li salva in SQLite, li inoltra in diretta (`/live`, WebSocket) e serve il pannello.
- `public/` – il pannello: visitatori online, vista live, replay con controlli di velocità, elenco delle pagine visitate.

Il checkout di Shopify non permette script esterni, quindi lì non c'è registrazione video.

## Prova in locale

```bash
npm install
npm run dev        # http://localhost:3000, senza password
npm test           # test end-to-end con Playwright
```

## Messa online

1. **Server.** Gratis: segui [deploy/ORACLE.md](deploy/ORACLE.md) (Oracle Cloud Always Free). In alternativa pubblica questo repository su un hosting Node con disco persistente (Railway, Render, Fly.io…). Con Railway: *New Project → Deploy from GitHub repo*, aggiungi un **Volume** montato su `/data`, poi *Settings → Networking → Generate Domain*. Imposta le variabili d'ambiente di `.env.example`.
2. **App Shopify.** Nel [Dev Dashboard](https://dev.shopify.com/dashboard) crea un'app, copia *Client ID* e *Secret* nelle variabili `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` del server. In `shopify.app.toml` metti il Client ID e l'indirizzo del server, poi:
   ```bash
   npm install -g @shopify/cli
   shopify app deploy
   ```
   Installa l'app sul negozio dal Dev Dashboard.
3. **Attiva il registratore.** Admin Shopify → *Negozio online → Temi → Personalizza → Incorporamenti app* → attiva **Replay visitatori** e incolla l'indirizzo del server.
4. Apri l'app dall'admin Shopify (o vai all'indirizzo del server e usa `DASHBOARD_PASSWORD`).

## Variabili d'ambiente

| Variabile | A cosa serve |
|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Accesso al pannello dall'admin Shopify |
| `SHOP_DOMAIN` | Solo questo negozio può aprire il pannello |
| `DASHBOARD_PASSWORD` | Accesso al pannello fuori dall'admin |
| `ALLOWED_ORIGINS` | Accetta registrazioni solo da questi domini |
| `RETENTION_DAYS` | Giorni di conservazione delle sessioni (default 30) |
| `DATA_DIR` | Cartella del database (volume persistente) |
