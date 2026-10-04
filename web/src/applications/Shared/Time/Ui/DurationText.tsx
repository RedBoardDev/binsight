import { readableDuration } from '@app/applications/Shared/Time/Domain/readableDuration';
import { durationFormat } from '@app/applications/Shared/Time/Domain/timeFormat';
import { useLanguageTag } from '@app/core/i18n/useLanguageTag';

interface DurationTextProps {
  seconds: number;
}

export const DurationText = ({ seconds }: DurationTextProps) => {
  const format = durationFormat(useLanguageTag(), { style: 'narrow' });
  const duration = readableDuration(seconds);
  const text =
    duration.kind === 'under-a-minute'
      ? `<${format.format({ minutes: 1 })}`
      : format.format(duration.parts);

  return <span className="num whitespace-nowrap">{text}</span>;
};
