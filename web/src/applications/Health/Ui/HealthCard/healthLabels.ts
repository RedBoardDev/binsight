import type { Health } from '@app/applications/Health/Api/getHealth';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const COMPONENT_STATUS_LABELS: Record<Health['database'], MessageDescriptor> = {
  ok: msg`Available`,
  unavailable: msg`Unavailable`,
};

export const ENGINE_STATUS_LABELS: Record<Health['engine'], MessageDescriptor> = {
  starting: msg`Starting`,
  running: msg`Running`,
  stopping: msg`Stopping`,
};

export const HEALTH_STATUS_LABELS: Record<Health['status'], MessageDescriptor> = {
  ok: msg`Healthy`,
  degraded: msg`Degraded`,
  unavailable: msg`Unavailable`,
};
