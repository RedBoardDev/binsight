import type { LiveEvent, NotifRule, RuntimeSettings } from '@binsight/shared';

/** Notification delivery, presence and the owner's notification configuration. */

/** A delivery channel for notifications. */
export interface NotificationChannel {
  readonly name: string;
  deliver(event: LiveEvent): Promise<void>;
}

/** A presence signal the notification manager reads (is any client actively viewing right now?). */
export interface PresenceReader {
  isAnyClientActive(): boolean;
}

/** Stores wallets, runtime settings and notification rules. */
export interface ConfigRepository {
  /** Load the in-memory caches (settings, rules) and seed defaults. Call once before use. */
  init(): Promise<void>;
  getSettings(): RuntimeSettings;
  saveSettings(s: Partial<RuntimeSettings>): Promise<RuntimeSettings>;
  listNotifRules(): NotifRule[];
  saveNotifRule(rule: NotifRule): Promise<void>;
}
