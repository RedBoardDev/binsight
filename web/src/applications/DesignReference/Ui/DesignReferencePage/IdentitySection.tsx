import { ReferenceSection } from '@app/applications/DesignReference/Ui/DesignReferencePage/ReferenceSection';
import { ShortAddress } from '@app/applications/Shared/Token/Ui/ShortAddress';
import { TokenPair } from '@app/applications/Shared/Token/Ui/TokenPair';
import { CopyButton } from '@app/applications/Shared/Ui/CopyButton';
import { ExternalLink } from '@app/applications/Shared/Ui/ExternalLink';

const SAMPLE_ADDRESS = 'EdfeJhR3pW8VZy1oxKq7bS9cTn2mLu4AvG6sWx5Pfegz';

export const IdentitySection = () => (
  <ReferenceSection title="Identity">
    <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
      <TokenPair base="WIF" quote="SOL" />
      <TokenPair base="POPCAT" quote="SOL" />
      <span className="inline-flex items-center gap-1 text-muted">
        <ShortAddress address={SAMPLE_ADDRESS} />
        <CopyButton value={SAMPLE_ADDRESS} label="Copy the address" />
      </span>
      <ExternalLink href="https://solscan.io">Solscan</ExternalLink>
    </div>
  </ReferenceSection>
);
