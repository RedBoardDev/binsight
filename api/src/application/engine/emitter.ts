import type { Health, OpenPosition, WalletState } from '@binsight/shared';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import { buildWalletState, combineOnchain } from '@/application/wallet-state';
import type { OnchainValued } from '@/domain/dlmm';
import type { ConnectionStatus } from '@/domain/ports';

/** The per-wallet state the emitter reads. */
export interface WalletView {
  open: Map<string, OpenPosition>;
  onchain: OnchainValued | null;
}

/**
 * Stable change signature of a health frame for the emit-on-change dedup: only what a client renders.
 * `uptimeSeconds` and the sources' timestamps advance every tick without a visible change.
 */
function healthChangeSignature(payload: Health): string {
  return JSON.stringify({
    ok: payload.ok,
    wsConnected: payload.wsConnected,
    chainTipSlot: payload.chainTipSlot,
    sources: payload.sources.map((s) => ({
      name: s.name,
      status: s.status,
      detail: s.detail,
      consecutiveErrors: s.consecutiveErrors,
    })),
  });
}

export class StateEmitter {
  private lastHealthSig: string | null = null;

  constructor(
    private readonly wallets: ReadonlyMap<string, WalletView>,
    private readonly backbone: ConnectionStatus,
    private readonly bus: EventBus,
    private readonly health: HealthMonitor,
  ) {}

  emitState(address: string): void {
    const w = this.wallets.get(address);
    if (!w) return;
    this.bus.emit('state', buildWalletState(address, [...w.open.values()], w.onchain));
  }

  /** Emit a state from explicit positions + valuation — the approximate price mark. Its valuation is
   *  not authoritative, so it surfaces as freshness 'syncing' and is never recorded as net worth. */
  emitMarked(address: string, positions: OpenPosition[], valued: OnchainValued): void {
    if (!this.wallets.has(address)) return;
    this.bus.emit('state', buildWalletState(address, positions, valued));
  }

  /** The current health payload, without emitting. */
  snapshotHealth(): Health {
    return {
      ok: this.health.ok,
      wsConnected: this.backbone.isConnected(),
      chainTipSlot: this.health.chainTipSlot,
      sources: this.health.list(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  /** Emit health if anything a client renders changed since the last frame. */
  emitHealth(): void {
    const wsOk = this.backbone.isConnected();
    this.health.set('ws', wsOk ? 'ok' : 'down', wsOk ? undefined : 'disconnected');
    const payload = this.snapshotHealth();
    const sig = healthChangeSignature(payload);
    if (sig === this.lastHealthSig) return;
    this.lastHealthSig = sig;
    this.bus.emit('health', payload);
  }

  /** Aggregate state across the given wallets (the caller's watchlist), labelled `scope`. */
  getState(wallets: string[], scope: string): WalletState {
    const all: OpenPosition[] = [];
    const onchains: OnchainValued[] = [];
    for (const address of wallets) {
      const w = this.wallets.get(address);
      if (!w) continue;
      all.push(...w.open.values());
      if (w.onchain) onchains.push(w.onchain);
    }
    return buildWalletState(scope, all, combineOnchain(onchains));
  }
}
