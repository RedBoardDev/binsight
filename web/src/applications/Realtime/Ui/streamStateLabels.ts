import type { StreamState } from '@app/lib/sse/eventStream';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const STREAM_STATE_LABELS: Record<StreamState, MessageDescriptor> = {
  connecting: msg`Connecting`,
  open: msg`Live`,
  reconnecting: msg`Reconnecting`,
  paused: msg`Paused`,
};

export const STREAM_STATE_COLORS = {
  connecting: 'warning',
  open: 'success',
  reconnecting: 'warning',
  paused: 'default',
} as const satisfies Record<StreamState, string>;
