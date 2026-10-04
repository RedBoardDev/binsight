import { ErrorScreen } from '@app/core/ErrorScreen';
import { buttonVariants } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';

export const NotFoundScreen = () => {
  const { t } = useLingui();

  return (
    <ErrorScreen
      title={t`Page not found`}
      description={t`This address does not match any page of binsight.`}
      action={
        <Link to="/" className={buttonVariants({ size: 'lg' })}>
          {t`Back to the overview`}
        </Link>
      }
    />
  );
};
