import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';

export interface PriceUpdate {
  type: string;
  assetId: string;
  price: string;
  size?: string;
  side?: string;
  timestamp: number;
}

type PriceUpdateCallback = (update: PriceUpdate) => void;

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

@Injectable()
export class PolymarketWebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(PolymarketWebSocketService.name);

  private ws: WebSocket | null = null;
  private subscribedTokenIds = new Set<string>();
  private callbacks: PriceUpdateCallback[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private isIntentionallyClosed = false;
  private isConnecting = false;

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to price updates for the given token IDs.
   * Opens a WebSocket connection if one is not already active.
   */
  subscribe(tokenIds: string[]): void {
    const newTokens = tokenIds.filter((id) => !this.subscribedTokenIds.has(id));
    if (newTokens.length === 0) return;

    for (const id of newTokens) {
      this.subscribedTokenIds.add(id);
    }

    this.logger.log(
      `Subscribing to ${newTokens.length} token(s). Total subscriptions: ${this.subscribedTokenIds.size}`,
    );

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(newTokens);
    } else if (!this.isConnecting) {
      this.connect();
    }
  }

  /**
   * Unsubscribe from the given token IDs.
   * If no subscriptions remain, the connection is closed.
   */
  unsubscribe(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokenIds.delete(id);
    }

    this.logger.log(
      `Unsubscribed ${tokenIds.length} token(s). Remaining: ${this.subscribedTokenIds.size}`,
    );

    if (this.subscribedTokenIds.size === 0) {
      this.close();
    }
  }

  /**
   * Register a callback that will be invoked on every price update.
   */
  onPriceUpdate(callback: PriceUpdateCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove a previously registered callback.
   */
  offPriceUpdate(callback: PriceUpdateCallback): void {
    this.callbacks = this.callbacks.filter((cb) => cb !== callback);
  }

  /**
   * Returns current connection state.
   */
  getStatus(): {
    connected: boolean;
    subscriptions: number;
    callbacks: number;
  } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      subscriptions: this.subscribedTokenIds.size,
      callbacks: this.callbacks.length,
    };
  }

  onModuleDestroy(): void {
    this.close();
  }

  // ─── Connection Management ──────────────────────────────────────────────────

  private connect(): void {
    if (this.isConnecting) return;
    this.isConnecting = true;
    this.isIntentionallyClosed = false;

    this.logger.log(`Connecting to Polymarket WebSocket: ${WS_URL}`);

    try {
      this.ws = new WebSocket(WS_URL);
    } catch (err) {
      this.logger.error(`Failed to create WebSocket: ${err.message}`);
      this.isConnecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.isConnecting = false;
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.logger.log('WebSocket connection established');

      // Subscribe to all currently tracked tokens
      if (this.subscribedTokenIds.size > 0) {
        this.sendSubscription(Array.from(this.subscribedTokenIds));
      }

      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isConnecting = false;
      this.stopHeartbeat();

      const reasonStr = reason?.toString() || 'unknown';
      this.logger.warn(
        `WebSocket closed: code=${code}, reason=${reasonStr}`,
      );

      if (!this.isIntentionallyClosed && this.subscribedTokenIds.size > 0) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('pong', () => {
      this.logger.debug('Received pong from server');
    });
  }

  private close(): void {
    this.isIntentionallyClosed = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.ws) {
      this.logger.log('Closing WebSocket connection');
      try {
        this.ws.close(1000, 'Client closing');
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  // ─── Subscription ──────────────────────────────────────────────────────────

  private sendSubscription(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        'Cannot send subscription: WebSocket is not open',
      );
      return;
    }

    const message = JSON.stringify({
      type: 'market',
      assets_id: tokenIds,
    });

    this.ws.send(message, (err) => {
      if (err) {
        this.logger.error(`Failed to send subscription: ${err.message}`);
      } else {
        this.logger.debug(
          `Sent subscription for ${tokenIds.length} token(s)`,
        );
      }
    });
  }

  // ─── Message Handling ───────────────────────────────────────────────────────

  private handleMessage(data: WebSocket.Data): void {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.logger.warn('Received non-JSON WebSocket message');
      return;
    }

    // Handle arrays of messages
    const messages = Array.isArray(parsed) ? parsed : [parsed];

    for (const msg of messages) {
      const type = msg.type;

      if (type === 'price_change' || type === 'trade') {
        const update: PriceUpdate = {
          type: msg.type,
          assetId: msg.asset_id,
          price: msg.price,
          size: msg.size,
          side: msg.side,
          timestamp: msg.timestamp ?? Math.floor(Date.now() / 1000),
        };

        for (const callback of this.callbacks) {
          try {
            callback(update);
          } catch (err) {
            this.logger.error(
              `Price update callback error: ${err.message}`,
            );
          }
        }
      }
    }
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.logger.debug('Sent ping to server');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Reconnection with Exponential Backoff ─────────────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    this.logger.log(
      `Scheduling reconnect in ${this.reconnectDelay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff with cap
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS,
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
