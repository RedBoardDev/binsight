interface BrandMarkProps {
  size?: number;
  withWordmark?: boolean;
}

/** The Binsight lockup — the bin mark plus the wordmark in the display face. */
export const BrandMark = ({ size = 22, withWordmark = true }: BrandMarkProps) => (
  <div className="flex items-center gap-2.5">
    {/* biome-ignore lint/performance/noImgElement: a fixed static brand mark, no layout cost. */}
    <img src="/icon.svg" alt="" width={size} height={size} className="shrink-0" />
    {withWordmark && (
      <span className="whitespace-nowrap font-display font-semibold text-[15px] text-foreground tracking-tight">
        Binsight
      </span>
    )}
  </div>
);
