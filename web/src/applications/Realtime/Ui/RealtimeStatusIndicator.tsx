import {
  STREAM_STATE_LABELS,
  STREAM_STATE_TONES,
} from '@app/applications/Realtime/Ui/streamStateLabels';
import { useRealtimeStatus } from '@app/applications/Realtime/Ui/useRealtimeStatus';
import { useLingui } from '@lingui/react/macro';

// A live region announces a change of its text, never a change of its aria-label: the state must
// stay text, even where only the dot shows.
export const RealtimeStatusIndicator = () => {
  const { i18n, t } = useLingui();
  const { state } = useRealtimeStatus();
  const tone = STREAM_STATE_TONES[state];

  return (
    <span
      role="status"
      className={`inline-flex h-9 items-center gap-2 px-2 font-medium text-meta ${tone.word}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${tone.dot}`} />
      <span className="sr-only">{`${t`Live updates:`} `}</span>
      <span className="sr-only lg:not-sr-only">{i18n._(STREAM_STATE_LABELS[state])}</span>
    </span>
  );
};
