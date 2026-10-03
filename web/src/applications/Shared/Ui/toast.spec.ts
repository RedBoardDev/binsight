import { toast } from '@app/applications/Shared/Ui/toast';
import { describe, expect, it, vi } from 'vitest';

const heroToast = vi.hoisted(() => ({
  success: vi.fn(() => 'toast-key'),
  info: vi.fn(() => 'toast-key'),
  warning: vi.fn(() => 'toast-key'),
  danger: vi.fn(() => 'toast-key'),
  close: vi.fn(),
}));

vi.mock('@heroui/react', () => ({ toast: heroToast }));

describe('toast', () => {
  it('keeps notices for 6 seconds', () => {
    toast.success('Saved');
    toast.info('Syncing');
    toast.warning('Partial data');

    expect(heroToast.success).toHaveBeenCalledWith('Saved', { timeout: 6_000 });
    expect(heroToast.info).toHaveBeenCalledWith('Syncing', { timeout: 6_000 });
    expect(heroToast.warning).toHaveBeenCalledWith('Partial data', { timeout: 6_000 });
  });

  it('keeps errors for 10 seconds', () => {
    toast.danger('Could not save');

    expect(heroToast.danger).toHaveBeenCalledWith('Could not save', { timeout: 10_000 });
  });

  it('keeps a toast open when the caller asks for a zero timeout', () => {
    toast.info('A new version is available', { timeout: 0 });

    expect(heroToast.info).toHaveBeenCalledWith('A new version is available', { timeout: 0 });
  });

  it('passes the other options through and returns the toast key', () => {
    const onClose = vi.fn();

    expect(toast.success('Saved', { description: 'Wallet added', onClose })).toBe('toast-key');
    expect(heroToast.success).toHaveBeenCalledWith('Saved', {
      description: 'Wallet added',
      onClose,
      timeout: 6_000,
    });
  });

  it('closes a toast by key', () => {
    toast.close('toast-key');

    expect(heroToast.close).toHaveBeenCalledWith('toast-key');
  });
});
