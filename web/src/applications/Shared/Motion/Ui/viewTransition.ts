import { reducedMotionStore } from '@app/applications/Shared/Motion/Ui/reducedMotionStore';

type ViewTransitionKind = 'theme';

// Runs a DOM update inside a view transition (see motion.css), or directly when the browser has
// none or motion is reduced. The update must change the DOM synchronously: the browser takes the
// "after" snapshot as soon as it returns.
export const withViewTransition = (kind: ViewTransitionKind, update: () => void): void => {
  if (typeof document.startViewTransition !== 'function' || reducedMotionStore.isReduced()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.viewTransition = kind;
  const transition = document.startViewTransition(update);
  void transition.finished.finally(() => {
    delete root.dataset.viewTransition;
  });
};
