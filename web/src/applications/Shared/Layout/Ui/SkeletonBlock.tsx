import { useReducedMotion } from '@app/applications/Shared/Motion/Ui/useReducedMotion';
import { Skeleton } from '@heroui/react';

interface SkeletonBlockProps {
  className: string;
}

export const SkeletonBlock = ({ className }: SkeletonBlockProps) => {
  const isReducedMotion = useReducedMotion();

  return (
    <Skeleton
      aria-hidden
      animationType={isReducedMotion ? 'none' : 'shimmer'}
      className={`rounded-lg ${className}`}
    />
  );
};
