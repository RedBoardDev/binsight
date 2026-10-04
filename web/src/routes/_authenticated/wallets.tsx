import { WalletsPage } from '@app/applications/Wallet/Ui/WalletsPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/wallets')({ component: WalletsPage });
