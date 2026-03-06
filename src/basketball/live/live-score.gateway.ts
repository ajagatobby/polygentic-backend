import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import {
  BasketballLiveScoreService,
  BasketballDetectedEvent,
} from './live-score.service';

/**
 * WebSocket gateway that broadcasts live basketball game updates to connected clients.
 *
 * Namespace: 'basketball-live'
 * Events emitted to clients:
 *   - 'game-update'      — periodic state snapshot of all active games
 *   - 'score-update'     — score has changed
 *   - 'game-start'       — a tracked game has tipped off
 *   - 'game-end'         — a tracked game has finished
 *   - 'quarter-change'   — period/quarter changed
 */
@WebSocketGateway({ namespace: 'basketball-live', cors: true })
export class BasketballLiveScoreGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  private readonly logger = new Logger(BasketballLiveScoreGateway.name);

  @WebSocketServer()
  server: Server;

  private connectedClients = 0;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly liveScoreService: BasketballLiveScoreService) {}

  afterInit(): void {
    this.logger.log('Basketball live score WebSocket gateway initialized');

    this.liveScoreService.onEvent((event: BasketballDetectedEvent) => {
      this.broadcastEvent(event);
    });

    // Broadcast full game state every 30 seconds
    this.broadcastTimer = setInterval(() => {
      this.broadcastGameState();
    }, 30_000);
  }

  handleConnection(client: WebSocket): void {
    this.connectedClients++;
    this.logger.debug(
      `Client connected to /basketball-live (total: ${this.connectedClients})`,
    );

    const activeGames = this.liveScoreService.getActiveGames();
    this.sendToClient(client, 'game-update', {
      games: activeGames,
      count: activeGames.length,
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(): void {
    this.connectedClients--;
    this.logger.debug(
      `Client disconnected from /basketball-live (total: ${this.connectedClients})`,
    );
  }

  // ─── PRIVATE BROADCAST METHODS ───────────────────────────────────────

  private broadcastEvent(event: BasketballDetectedEvent): void {
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

    switch (event.type) {
      case 'score-update':
        this.broadcast('score-update', payload);
        break;
      case 'game-start':
        this.broadcast('game-start', payload);
        break;
      case 'game-end':
        this.broadcast('game-end', payload);
        break;
      case 'quarter-change':
        this.broadcast('quarter-change', payload);
        break;
      default:
        this.broadcast('game-update', payload);
        break;
    }
  }

  private broadcastGameState(): void {
    if (this.connectedClients === 0) return;

    const activeGames = this.liveScoreService.getActiveGames();
    this.broadcast('game-update', {
      games: activeGames,
      count: activeGames.length,
      timestamp: new Date().toISOString(),
    });
  }

  private broadcast(event: string, data: any): void {
    if (!this.server) return;

    const message = JSON.stringify({ event, data });

    this.server.clients?.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

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
    this.logger.log('Basketball live score WebSocket gateway destroyed');
  }
}
