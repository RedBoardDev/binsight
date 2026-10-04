import { shortAddress } from '@app/applications/Shared/Token/Domain/shortAddress';

interface ShortAddressProps {
  address: string;
}

export const ShortAddress = ({ address }: ShortAddressProps) => (
  <span title={address} className="font-mono text-meta">
    {shortAddress(address)}
  </span>
);
