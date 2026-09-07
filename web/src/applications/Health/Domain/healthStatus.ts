import type { Health, SourceStatus } from '@binsight/shared';

/** The worst of the engine's sources and this browser's own socket: a dead socket means the view is
 *  not live, whatever the engine last reported. */
export function overallHealthStatus(health: Health | null, connected: boolean): SourceStatus {
  if (!health || !connected) return 'down';
  const statuses = health.sources.map((source) => source.status);
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('lagging') || !health.wsConnected) return 'lagging';
  return 'ok';
}

export const HEALTH_LABEL: Record<SourceStatus, string> = {
  ok: 'Live',
  lagging: 'Degraded',
  down: 'Offline',
};

export const SOURCE_LABEL: Record<SourceStatus, string> = {
  ok: 'OK',
  lagging: 'Lagging',
  down: 'Down',
};

export const healthDotClass: Record<SourceStatus, string> = {
  ok: 'bg-success',
  lagging: 'bg-warning',
  down: 'bg-danger',
};
