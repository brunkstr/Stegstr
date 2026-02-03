# Stegstr relay proxy

Nostr WebSocket proxy that accepts client connections and forwards traffic to a configurable list of backend relays. Relay selection is controlled server-side (no app release needed to change relays).

## Behavior

- Listens for WebSocket connections (Nostr protocol).
- **Config:** Backend relay URLs are read from `relays.json` or the `RELAYS` environment variable (comma-separated) at startup.
- **Client → proxy:** Forwards `REQ`, `EVENT`, and `CLOSE` to all backend relays.
- **Backend → proxy → client:** Deduplicates `EVENT` by `event.id` per subscription; sends one `EOSE` per subscription when at least one backend has sent EOSE; forwards `OK` to the client.

## Run locally

```bash
cd relay-proxy
npm install
npm start
```

Defaults: listen on `0.0.0.0:8080`. Override with `PORT` and `HOST`:

```bash
PORT=3000 HOST=127.0.0.1 npm start
```

## Backend relay list

Edit `relays.json` (or set `RELAYS=wss://relay.a.com,wss://relay.b.com`) and restart the proxy. No app change required.

## App config

The Stegstr desktop app fetches the proxy WebSocket URL from the website config so it can connect to this proxy. That URL is set in the static file served by the main site:

- **Config URL (for app):** `https://stegstr.com/config/relay.json` (or your website origin) with content: `{ "proxyUrl": "wss://relay.stegstr.com" }`.

Deploy this proxy at the host specified in `proxyUrl` (e.g. `relay.stegstr.com`). Use a reverse proxy (e.g. nginx, Caddy) in front of this server to terminate TLS and forward `wss://` to the proxy port.

## Deploy with Docker

```bash
docker build -t stegstr-relay-proxy .
docker run -p 8080:8080 stegstr-relay-proxy
```

Override backend relays at run time:

```bash
docker run -p 8080:8080 -e RELAYS="wss://relay.damus.io,wss://nos.lol" stegstr-relay-proxy
```

## Health check

- `GET /health` or `GET /` returns `200 ok` (plain text). Use for load balancers or health checks.
