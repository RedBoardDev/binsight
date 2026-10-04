import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';

const STRIPES = [
  'bg-wallet-1',
  'bg-wallet-2',
  'bg-wallet-3',
  'bg-wallet-4',
  'bg-wallet-5',
] as const;

export const MaterialsSection = () => (
  <ReferenceSection title="Materials">
    <div className="relative h-44 overflow-hidden rounded-2xl ring-1 ring-border">
      <div className="absolute inset-0 flex flex-col">
        {STRIPES.map((className) => (
          <div key={className} className={`flex-1 ${className}`} />
        ))}
      </div>
      <div className="glass-thin absolute inset-x-4 top-4 flex h-12 items-center rounded-xl px-4 font-medium text-body">
        Thin glass · top bar
      </div>
      <div className="glass-thick absolute inset-x-4 bottom-4 flex h-14 items-center rounded-full px-5 font-medium text-body">
        Thick glass · floating tab bar
      </div>
    </div>
  </ReferenceSection>
);
