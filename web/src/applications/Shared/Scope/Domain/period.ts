import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { z } from 'zod/mini';

export const PERIODS = ['7d', '1m', '3m', '1y', 'all'] as const;

export type Period = (typeof PERIODS)[number];

export const DEFAULT_PERIOD: Period = '1m';

export const periodSchema = z.enum(PERIODS);

export const PERIOD_LABELS: Record<Period, MessageDescriptor> = {
  '7d': msg({ message: '7d', comment: 'Period of seven days, in a row of short pills.' }),
  '1m': msg({ message: '1M', comment: 'Period of one month, in a row of short pills.' }),
  '3m': msg({ message: '3M', comment: 'Period of three months, in a row of short pills.' }),
  '1y': msg({ message: '1Y', comment: 'Period of one year, in a row of short pills.' }),
  all: msg({ message: 'All', comment: 'The whole history, in a row of short period pills.' }),
};
