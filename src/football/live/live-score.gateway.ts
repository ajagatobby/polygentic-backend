import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { LiveScoreService, DetectedEvent } from './live-score.service';

/**
 * WebSocket gateway that broadcasts live match updates to connected clients.
 *
 * Namespace: 'live'
 * Events emitted to clients:
 *   - 'match-update'  — periodic state snapshot of all active matches
 *   - 'goal'          — a goal has been scored
 *   - 'red-card'      — a red card has been shown
 *   - 'match-start'   — a tracked match has kicked off
 *   - 'match-end'     — a tracked match has finished
 */
@WebSocketGateway({ namespace: 'live', cors: true })
export class LiveScoreGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  private readonly logger = new Logger(LiveScoreGateway.name);

  @WebSocketServer()
  server: Server;

  /** Track connected client count for logging. */
  private connectedClients = 0;

  /** Interval handle for periodic match-update broadcasts. */
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly liveScoreService: LiveScoreService) {}

  afterInit(): void {
    this.logger.log('Live score WebSocket gateway initialized');

    // Register for live events from the service
    this.liveScoreService.onEvent((event: DetectedEvent) => {
      this.broadcastEvent(event);
    });

    // Broadcast full match state every 30 seconds to all clients
    this.broadcastTimer = setInterval(() => {
      this.broadcastMatchState();
    }, 30_000);
  }

  handleConnection(client: WebSocket): void {
    this.connectedClients++;
    this.logger.debug(
      `Client connected to /live (total: ${this.connectedClients})`,
    );

    // Send current match state immediately on connect
    const activeMatches = this.liveScoreService.getActiveMatches();
    this.sendToClient(client, 'match-update', {
      matches: activeMatches,
      count: activeMatches.length,
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(): void {
    this.connectedClients--;
    this.logger.debug(
      `Client disconnected from /live (total: ${this.connectedClients})`,
    );
  }

  // ─── PRIVATE BROADCAST METHODS ───────────────────────────────────────

  /**
   * Broadcast a detected live event to all connected clients,
   * mapped to the appropriate WebSocket event name.
   */
  private broadcastEvent(event: DetectedEvent): void {
    const payload = {
      fixtureId: event.fixtureId,
      homeTeamId: event.homeTeamId,
      homeTeamName: event.homeTeamName,
      awayTeamId: event.awayTeamId,
      awayTeamName: event.awayTeamName,
      leagueId: event.leagueId,
      leagueName: event.leagueName,
      detail: event.detail,
      data: event.data,
      timestamp: event.timestamp.toISOString(),
    };

    // Map internal event type to WebSocket event name
    switch (event.type) {
      case 'goal':
        this.broadcast('goal', payload);
        break;
      case 'red-card':
        this.broadcast('red-card', payload);
        break;
      case 'match-start':
        this.broadcast('match-start', payload);
        break;
      case 'match-end':
        this.broadcast('match-end', payload);
        break;
      default:
        // status-change and others go as generic match-update
        this.broadcast('match-update', payload);
        break;
    }
  }

  /**
   * Broadcast the full current match state to all clients.
   */
  private broadcastMatchState(): void {
    if (this.connectedClients === 0) return;

    const activeMatches = this.liveScoreService.getActiveMatches();
    this.broadcast('match-update', {
      matches: activeMatches,
      count: activeMatches.length,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send a JSON message to all connected WebSocket clients.
   */
  private broadcast(event: string, data: any): void {
    if (!this.server) return;

    const message = JSON.stringify({ event, data });

    this.server.clients?.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /**
   * Send a JSON message to a single WebSocket client.
   */
  private sendToClient(client: WebSocket, event: string, data: any): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }

  onModuleDestroy(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.logger.log('Live score WebSocket gateway destroyed');
  }
}
