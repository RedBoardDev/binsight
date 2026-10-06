import { BinHistogram } from '@app/applications/Shared/Chart/Ui/BinHistogram';
import { BinStrip } from '@app/applications/Shared/Chart/Ui/BinStrip';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { useState } from 'react';
import {
  BIN_SAMPLES,
  SAMPLE_BIN_PRICE,
  SAMPLE_LOWER_PRICE,
  SAMPLE_UPPER_PRICE,
} from './binSamples';

export const BinSamples = () => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const format = useFigureFormatter();
  const price = (value: typeof SAMPLE_BIN_PRICE) =>
    format.areAmountsHidden ? 'amount hidden' : format.price(value).text;
  const quantity = (amount: string) => {
    if (format.areAmountsHidden) return 'amount hidden';
    const value = parseDecimalString(amount);
    if (value === null) return 'not available';
    return format.tokenQuantity(value);
  };
  const describeGroup = (indices: readonly number[]) =>
    indices
      .map((index) => {
        const bar = BIN_SAMPLES.bars[index];
        if (bar === undefined) return '';
        return `Server group beginning at bin ${bar.bin_id}: first-bin price ${price(SAMPLE_BIN_PRICE)} SOL; base ${quantity(bar.base)} token; quote ${quantity(bar.quote)} SOL.`;
      })
      .join(' ');
  return (
    <div className="mt-8 grid gap-8">
      <div className="flex flex-col gap-2 text-small text-muted">
        <span>Range cell · base and quote sides, active bin 104</span>
        <BinStrip chart={BIN_SAMPLES} height={18} />
        <span>Above range · marker at the right</span>
        <div data-bin-variant="out-quiet">
          <BinStrip chart={{ ...BIN_SAMPLES, active_bin_id: 215 }} height={20} />
        </div>
        <span>Above range · histogram colors</span>
        <div data-bin-variant="out-normal">
          <BinStrip chart={{ ...BIN_SAMPLES, active_bin_id: 215 }} height={20} emphasis="normal" />
        </div>
      </div>
      <BinHistogram
        chart={BIN_SAMPLES}
        label="Liquidity bins sample"
        summary="70 server groups; blue quote and neutral base bars, with an active mixed group. Mixed colors identify token sides, not their proportions."
        lowerLabel={price(SAMPLE_LOWER_PRICE)}
        upperLabel={price(SAMPLE_UPPER_PRICE)}
        rangeLabel="210 bins · 10.6% wide"
        activeIndex={activeIndex}
        onScrub={setActiveIndex}
        describeGroup={describeGroup}
        renderGroup={describeGroup}
      />
    </div>
  );
};
