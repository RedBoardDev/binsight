import { msg } from '@lingui/core/macro';
import { LayoutDashboard } from 'lucide-react';

export const NAV_ITEMS = [{ to: '/', label: msg`Dashboard`, Icon: LayoutDashboard }] as const;
