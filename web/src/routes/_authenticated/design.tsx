import { NotFoundScreen } from '@app/core/NotFoundScreen';
import { createFileRoute, lazyRouteComponent, notFound } from '@tanstack/react-router';

// Development only, and temporary: a production build turns import.meta.env.DEV into false, which
// drops the import of the page with its samples, and the address answers "not found".
export const Route = createFileRoute('/_authenticated/design')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw notFound();
    }
  },
  component: import.meta.env.DEV
    ? lazyRouteComponent(
        () => import('@app/applications/DesignReference/Ui/DesignReferencePage'),
        'DesignReferencePage',
      )
    : NotFoundScreen,
});
