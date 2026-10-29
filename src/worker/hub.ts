import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * Fans changes out to open dashboards over WebSockets. Uses hibernation, so
 * idle connections cost nothing. Messages only say "something changed";
 * clients refetch through the API.
 */
export class Hub extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async broadcast(message: string): Promise<number> {
    let sent = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
        sent += 1;
      } catch {
        // Closed sockets drop out of getWebSockets() on their own.
      }
    }
    return sent;
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    socket.close(code === 1005 ? 1000 : code, "closing");
  }
}
