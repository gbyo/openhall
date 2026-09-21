import { Client, type Notification } from 'pg';

export interface ObservedOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string | null;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

type EventHandler = (event: ObservedOutboxEvent) => void;
type HealthHandler = (healthy: boolean) => void;

interface OutboxRow {
  id: string;
  tenant_id: string;
  organization_id: string | null;
  aggregate_kind: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * Dedicated LISTEN connection for committed outbox wakeups. It never marks
 * published_at: browser SSE observes durable rows but does not consume the
 * future integration-delivery queue.
 */
export class PostgresOutboxListener {
  private client: Client | null = null;
  private stopping = false;
  private healthy = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly healthHandlers = new Set<HealthHandler>();

  constructor(private readonly databaseUrl: string) {}

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onHealth(handler: HealthHandler): () => void {
    this.healthHandlers.add(handler);
    return () => this.healthHandlers.delete(handler);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    this.setHealthy(false);
    if (client !== null) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    const client = new Client({ connectionString: this.databaseUrl });
    client.on('notification', (message) => void this.handleNotification(client, message));
    client.on('error', () => {
      this.disconnected(client);
    });
    client.on('end', () => {
      this.disconnected(client);
    });
    try {
      await client.connect();
      await client.query('LISTEN openhall_outbox_v1');
      if (this.isStopping()) {
        await client.end();
        return;
      }
      this.client = client;
      this.reconnectAttempt = 0;
      this.setHealthy(true);
    } catch {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
      this.setHealthy(false);
      this.scheduleReconnect();
    }
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private disconnected(client: Client): void {
    if (this.client === client) this.client = null;
    client.removeAllListeners();
    void client.end().catch(() => undefined);
    this.setHealthy(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== null) return;
    const delay = Math.min(10_000, 250 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 6);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async handleNotification(client: Client, message: Notification): Promise<void> {
    if (message.channel !== 'openhall_outbox_v1' || message.payload === undefined) return;
    let row: OutboxRow | undefined;
    try {
      const result = await client.query<OutboxRow>(
        `select id, tenant_id, organization_id, aggregate_kind, aggregate_id, event_type, payload
           from outbox_event
          where id = $1`,
        [message.payload],
      );
      row = result.rows[0];
    } catch {
      this.disconnected(client);
      return;
    }
    if (row === undefined) return;
    const event: ObservedOutboxEvent = {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      aggregateKind: row.aggregate_kind,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
    };
    // Subscriber bugs must not look like database failures: a throwing
    // handler neither drops this connection nor blocks later subscribers.
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        continue;
      }
    }
  }

  private setHealthy(value: boolean): void {
    if (this.healthy === value) return;
    this.healthy = value;
    for (const handler of this.healthHandlers) handler(value);
  }
}
