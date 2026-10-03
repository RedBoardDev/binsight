import { useRegisterSW } from 'virtual:pwa-register/react';
import { toast } from '@app/applications/Shared/Ui/toast';
import { useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

// Renders nothing: it shows a toast that stays until the owner reloads. The new version only
// takes over when they accept, so a tab never runs a mix of two versions.
export const UpdatePrompt = () => {
  const { t } = useLingui();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW: (_url, registration) => {
      if (registration !== undefined) {
        setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS);
      }
    },
  });

  useEffect(() => {
    if (!needRefresh) {
      return undefined;
    }
    const key = toast.info(t`A new version of binsight is available.`, {
      timeout: 0,
      actionProps: { children: t`Reload`, onPress: () => void updateServiceWorker(true) },
    });
    return () => toast.close(key);
  }, [needRefresh, t, updateServiceWorker]);

  return null;
};
