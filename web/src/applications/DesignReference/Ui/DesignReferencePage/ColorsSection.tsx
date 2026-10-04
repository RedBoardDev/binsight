import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';

// Class tables, not built class names: Tailwind only generates the classes it can read.
const SURFACES = [
  { name: 'background', className: 'bg-background' },
  { name: 'surface', className: 'bg-surface' },
  { name: 'overlay', className: 'bg-overlay' },
  { name: 'inset', className: 'bg-inset' },
  { name: 'hover', className: 'bg-hover' },
  { name: 'border', className: 'bg-border' },
] as const;

const TEXTS = [
  { name: 'foreground', className: 'text-foreground' },
  { name: 'muted', className: 'text-muted' },
  { name: 'faint', className: 'text-faint' },
  { name: 'accent', className: 'text-accent' },
  { name: 'gain', className: 'text-gain' },
  { name: 'loss', className: 'text-loss' },
  { name: 'warning', className: 'text-warning' },
  { name: 'info', className: 'text-info' },
] as const;

const WALLETS = [
  'bg-wallet-1',
  'bg-wallet-2',
  'bg-wallet-3',
  'bg-wallet-4',
  'bg-wallet-5',
  'bg-wallet-6',
  'bg-wallet-7',
  'bg-wallet-8',
] as const;

export const ColorsSection = () => (
  <ReferenceSection title="Colors">
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {SURFACES.map(({ name, className }) => (
        <div key={name} className="flex flex-col gap-2">
          <div className={`h-14 rounded-xl ring-1 ring-border ${className}`} />
          <span className="text-small text-muted">{name}</span>
        </div>
      ))}
    </div>
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {TEXTS.map(({ name, className }) => (
        <span key={name} className={`font-medium text-body ${className}`}>
          {name}
        </span>
      ))}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      {WALLETS.map((className, index) => (
        <span key={className} className="inline-flex items-center gap-1.5 text-small text-muted">
          <span className={`size-2 rounded-full ${className}`} />
          {`wallet ${index + 1}`}
        </span>
      ))}
    </div>
  </ReferenceSection>
);
