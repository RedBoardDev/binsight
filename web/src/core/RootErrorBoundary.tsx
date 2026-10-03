import { ErrorScreen } from '@app/core/ErrorScreen';
import { Button } from '@heroui/react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Component, type ReactNode } from 'react';

const CRASH_TITLE = msg`binsight stopped working`;
const CRASH_DESCRIPTION = msg`An unexpected error stopped the app. Reload the page to start again.`;
const RELOAD_LABEL = msg`Reload`;

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  hasCrashed: boolean;
}

// The last resort, above every provider: any of them may be what crashed, so this screen uses none.
// It translates through the global i18n instance, which main.tsx activates before the first render.
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { hasCrashed: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasCrashed: true };
  }

  override render(): ReactNode {
    if (!this.state.hasCrashed) {
      return this.props.children;
    }
    return (
      <ErrorScreen
        title={i18n._(CRASH_TITLE)}
        description={i18n._(CRASH_DESCRIPTION)}
        action={
          <Button size="lg" onPress={() => window.location.reload()}>
            {i18n._(RELOAD_LABEL)}
          </Button>
        }
      />
    );
  }
}
