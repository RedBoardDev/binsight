import { NotFoundScreen } from '@app/core/NotFoundScreen';
import { createFileRoute } from '@tanstack/react-router';

// Catches every unknown address under the shell, so a 404 keeps the menu (and, later, the
// sign-in guard of this layout).
export const Route = createFileRoute('/_authenticated/$')({ component: NotFoundScreen });
