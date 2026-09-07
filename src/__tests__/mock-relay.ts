/**
 * A controllable, in-process Nostr relay for failure-injection testing
 * (Phase 3: no Docker available, so no nostr-rs-relay/strfry -- this gives
 * the same "offline and deterministic" property the plan asked for, plus
 * fine-grained control over exactly when/how each failure fires, which a
 * real relay implementation doesn't expose knobs for anyway).
 *
 * Speaks just enough of NIP-01 (EVENT/REQ/CLOSE, EOSE, OK) to drive
 * src/relay.ts's real client code, with hooks to inject: connection refusal
 * ("relay down"), delayed responses ("relay slow"), a mid-subscription
 * connection drop, malformed/CLOSED/NOTICE responses (rate-limiting), and
 * inspecting exactly what a connected client sent.
 */
import { WebSocketServer, WebSocket as WSClient } from "ws";
import type { AddressInfo } from "node:net";

export type MockRelayOptions = {
  /** Delay (ms) before responding to anything (REQ -> EOSE, EVENT -> OK). Simulates a slow relay. */
  responseDelayMs?: number;
  /** If true, refuse the TCP/WS handshake entirely (simulates "relay down"). */
  refuseConnections?: boolean;
  /** Close the socket after sending this many EVENTs for a subscription, before EOSE (simulates a mid-subscription drop). */
  dropAfterNEvents?: number;
  /** Events to replay for any REQ (kind/filter-agnostic, for simplicity). */
  storedEvents?: unknown[];
  /** If set, respond to EVENT publishes with OK=false and this reason (simulates a relay actively rejecting, e.g. rate-limit). */
  rejectPublishReason?: string;
  /** If true, respond to the first REQ with a CLOSED message instead of subscribing (NIP-01 CLOSED, e.g. for rate-limiting a subscription). */
  closeSubscriptionImmediately?: boolean;
  /** If set, never respond to REQ at all (no EOSE ever) -- simulates a relay silently rate-limiting without telling the client. */
  neverEose?: boolean;
};

export class MockRelay {
  private wss: WebSocketServer | null = null;
  public port = 0;
  public connectionsOpened = 0;
  public receivedMessages: unknown[][] = [];
  private opts: MockRelayOptions;
  private sockets: WSClient[] = [];

  constructor(opts: MockRelayOptions = {}) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: 0 });
      this.wss.on("listening", () => {
        this.port = (this.wss!.address() as AddressInfo).port;
        resolve();
      });
      this.wss.on("connection", (ws) => {
        if (this.opts.refuseConnections) {
          ws.close(1008, "refused");
          return;
        }
        this.connectionsOpened++;
        this.sockets.push(ws);
        ws.on("message", (data) => {
          let msg: unknown[];
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          this.receivedMessages.push(msg);
          this.handleMessage(ws, msg);
        });
      });
    });
  }

  private delay(): Promise<void> {
    const ms = this.opts.responseDelayMs ?? 0;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private async handleMessage(ws: WSClient, msg: unknown[]) {
    const [type] = msg;
    if (type === "REQ") {
      const subId = msg[1] as string;
      if (this.opts.closeSubscriptionImmediately) {
        ws.send(JSON.stringify(["CLOSED", subId, "rate-limited: too many subscriptions"]));
        return;
      }
      await this.delay();
      const events = this.opts.storedEvents ?? [];
      const n = this.opts.dropAfterNEvents;
      const toSend = n !== undefined ? events.slice(0, n) : events;
      for (const ev of toSend) {
        ws.send(JSON.stringify(["EVENT", subId, ev]));
      }
      if (n !== undefined && toSend.length >= n) {
        // Simulate a mid-subscription drop: close before EOSE.
        ws.close();
        return;
      }
      if (!this.opts.neverEose) {
        ws.send(JSON.stringify(["EOSE", subId]));
      }
    } else if (type === "EVENT") {
      const event = msg[1] as { id: string };
      await this.delay();
      if (this.opts.rejectPublishReason) {
        ws.send(JSON.stringify(["OK", event.id, false, this.opts.rejectPublishReason]));
      } else {
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
      }
    }
    // CLOSE messages from the client: no response needed for these tests.
  }

  /** Forcibly close all currently-open connections (simulates the relay dying mid-session). */
  dropAllConnections(): void {
    this.sockets.forEach((s) => s.terminate());
    this.sockets = [];
  }

  async stop(): Promise<void> {
    this.sockets.forEach((s) => s.terminate());
    this.sockets = [];
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }
}
