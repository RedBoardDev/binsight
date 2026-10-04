import type { StreamState } from '@app/lib/sse/eventStream';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const STREAM_STATE_LABELS: Record<StreamState, MessageDescriptor> = {
  connecting: msg`Connecting`,
  open: msg`Live`,
  reconnecting: msg`Reconnecting`,
  paused: msg`Paused`,
};

interface StreamStateTone {
  readonly dot: string;
  readonly word: string;
}

export const STREAM_STATE_TONES: Record<StreamState, StreamStateTone> = {
  connecting: { dot: 'bg-warning', word: 'text-warning' },
  open: { dot: 'bg-gain', word: 'text-muted' },
  reconnecting: { dot: 'bg-warning', word: 'text-warning' },
  paused: { dot: 'bg-faint', word: 'text-faint' },
};
