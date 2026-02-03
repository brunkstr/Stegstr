/**
 * Stegstr Nostr relay proxy.
 * Accepts WebSocket connections from clients, forwards Nostr protocol messages
 * to a configurable list of backend relays, merges and deduplicates responses.
 */

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

function loadBackendRelays() {
  const envRelays = process.env.RELAYS;
  if (envRelays && typeof envRelays === "string") {
    return envRelays.split(",").map((u) => u.trim()).filter(Boolean);
  }
  const configPath = path.join(__dirname, "relays.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((u) => typeof u === "string" && (u.startsWith("wss://") || u.startsWith("ws://"))) : [];
  } catch (e) {
    console.error("Failed to load relays.json:", e.message);
    return [];
  }
}

const backendRelayUrls = loadBackendRelays();
if (backendRelayUrls.length === 0) {
  console.error("No backend relays configured. Set RELAYS env or relays.json.");
  process.exit(1);
}
console.log("Backend relays:", backendRelayUrls.length, backendRelayUrls);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server, path: "/" });

wss.on("connection", (clientWs) => {
  const backendSockets = [];
  const subTracking = new Map();

  function forwardToClient(msg) {
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.send(typeof msg === "string" ? msg : JSON.stringify(msg));
      } catch (e) {
        // ignore
      }
    }
  }

  function forwardToBackends(msg) {
    const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
    backendSockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  }

  function trackSub(subId, expectedEoseCount) {
    subTracking.set(subId, {
      seenEventIds: new Set(),
      eoseSent: false,
      expectedEose: expectedEoseCount,
      eoseCount: 0,
    });
  }

  function untrackSub(subId) {
    subTracking.delete(subId);
  }

  backendRelayUrls.forEach((url) => {
    const ws = new WebSocket(url);
    backendSockets.push(ws);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!Array.isArray(msg) || msg.length < 2) return;

        const type = msg[0];
        if (type === "EVENT") {
          const subId = msg[1];
          const event = msg[2];
          const eventId = event && typeof event === "object" && event.id;
          let track = subTracking.get(subId);
          if (!track) {
            track = { seenEventIds: new Set(), eoseSent: false, expectedEose: backendSockets.length, eoseCount: 0 };
            subTracking.set(subId, track);
          }
          if (eventId && !track.seenEventIds.has(eventId)) {
            track.seenEventIds.add(eventId);
            forwardToClient(msg);
          }
          return;
        }
        if (type === "EOSE") {
          const subId = msg[1];
          let track = subTracking.get(subId);
          if (!track) {
            track = { seenEventIds: new Set(), eoseSent: false, expectedEose: backendSockets.length, eoseCount: 0 };
            subTracking.set(subId, track);
          }
          track.eoseCount++;
          if (!track.eoseSent) {
            track.eoseSent = true;
            forwardToClient(msg);
          }
          return;
        }
        if (type === "OK") {
          forwardToClient(msg);
          return;
        }
      } catch (_) {
        // ignore malformed
      }
    });

    ws.on("error", () => {});
    ws.on("close", () => {});
  });

  clientWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!Array.isArray(msg) || msg.length < 1) return;

      const type = msg[0];
      if (type === "REQ") {
        const subId = msg[1];
        if (typeof subId === "string") trackSub(subId, backendSockets.length);
        forwardToBackends(msg);
        return;
      }
      if (type === "CLOSE") {
        const subId = msg[1];
        if (typeof subId === "string") untrackSub(subId);
        forwardToBackends(msg);
        return;
      }
      if (type === "EVENT") {
        forwardToBackends(msg);
        return;
      }
    } catch (_) {
      // ignore malformed
    }
  });

  clientWs.on("close", () => {
    backendSockets.forEach((ws) => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      } catch (_) {}
    });
    subTracking.clear();
  });

  clientWs.on("error", () => {});
});

server.listen(PORT, HOST, () => {
  console.log(`Stegstr relay proxy listening on ${HOST}:${PORT}`);
});
