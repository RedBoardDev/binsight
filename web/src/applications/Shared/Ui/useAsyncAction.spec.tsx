import { useAsyncAction } from '@app/applications/Shared/Ui/useAsyncAction';
import { Button } from '@heroui/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

interface ArchiveButtonProps {
  archive: (id: string) => Promise<unknown>;
}

const ArchiveButton = ({ archive }: ArchiveButtonProps) => {
  const archiving = useAsyncAction(archive);

  return (
    <Button isPending={archiving.isPending} onPress={() => archiving.run('position-1')}>
      Archive
    </Button>
  );
};

// Every test settles its action: React keeps pending async transitions entangled, so one that
// never settles would keep the next test's button pending too.
const createControlledArchive = () => {
  const settlers: Array<() => void> = [];
  const archive = vi.fn(
    (_id: string) =>
      new Promise<void>((resolve) => {
        settlers.push(resolve);
      }),
  );
  const settleAll = (): void => {
    for (const settle of settlers) {
      settle();
    }
  };
  return { archive, settleAll };
};

describe('useAsyncAction', () => {
  it('ignores a second press while the action is in flight', async () => {
    const user = userEvent.setup();
    const { archive, settleAll } = createControlledArchive();
    render(<ArchiveButton archive={archive} />);

    const button = screen.getByRole('button', { name: 'Archive' });
    await user.click(button);
    await user.click(button);

    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith('position-1');
    expect(button).toHaveAttribute('data-pending', 'true');
    settleAll();
    await waitFor(() => expect(button).not.toHaveAttribute('data-pending', 'true'));
  });

  it('runs again once the previous action has settled', async () => {
    const user = userEvent.setup();
    const { archive, settleAll } = createControlledArchive();
    render(<ArchiveButton archive={archive} />);

    const button = screen.getByRole('button', { name: 'Archive' });
    await user.click(button);
    settleAll();
    await waitFor(() => expect(button).not.toHaveAttribute('data-pending', 'true'));
    await user.click(button);

    expect(archive).toHaveBeenCalledTimes(2);
    settleAll();
    await waitFor(() => expect(button).not.toHaveAttribute('data-pending', 'true'));
  });
});
