import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';

const SCALE = [
  { name: 'hero · 52/600', className: 'text-hero', sample: '+0.421' },
  { name: 'hero-compact · 44/600', className: 'text-hero-compact', sample: '+14.61' },
  { name: 'hero-phone · 36/600', className: 'text-hero-phone', sample: '+0.421' },
  { name: 'page-title · 24/600', className: 'text-page-title', sample: 'History' },
  { name: 'key · 20/600', className: 'text-key', sample: '61.540' },
  { name: 'pair · 17/600', className: 'text-pair', sample: '+1.336' },
  { name: 'section · 16/600', className: 'text-section', sample: 'Open positions' },
  { name: 'body · 14', className: 'text-body', sample: 'Bid-Ask · Main' },
  { name: 'meta · 13', className: 'text-meta', sample: 'Last close 3 h ago' },
  { name: 'small · 12', className: 'text-small', sample: 'inv. 4.81' },
  { name: 'caps-label · 11/500', className: 'caps-label', sample: 'Net worth' },
  { name: 'micro · 10/600', className: 'text-micro', sample: 'Overview' },
] as const;

export const TypographySection = () => (
  <ReferenceSection title="Typography">
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] items-baseline gap-x-6 gap-y-4">
      {SCALE.map(({ name, className, sample }) => (
        <div key={name} className="contents">
          <dt className="text-small text-faint">{name}</dt>
          <dd className={`num truncate ${className}`}>{sample}</dd>
        </div>
      ))}
    </dl>
    <p className="font-mono text-meta text-muted">7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU</p>
  </ReferenceSection>
);
