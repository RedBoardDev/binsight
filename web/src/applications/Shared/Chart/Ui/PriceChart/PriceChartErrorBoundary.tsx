import { SectionError } from '@app/applications/Shared/Layout/Ui/SectionError';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Component, type ReactNode } from 'react';

const CHART_ERROR = msg`The price chart could not be loaded.`;

interface PriceChartErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onRetry: () => void;
}

export class PriceChartErrorBoundary extends Component<
  PriceChartErrorBoundaryProps,
  { hasFailed: boolean }
> {
  override state = { hasFailed: false };
  static getDerivedStateFromError(): { hasFailed: boolean } {
    return { hasFailed: true };
  }
  override render(): ReactNode {
    return this.state.hasFailed ? (
      <SectionError message={i18n._(CHART_ERROR)} onRetry={this.props.onRetry} />
    ) : (
      this.props.children
    );
  }
}
