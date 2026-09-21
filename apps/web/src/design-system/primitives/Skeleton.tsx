import type { CSSProperties } from 'react';

export interface SkeletonProps {
  width?: string;
  height?: string;
  label?: string;
}

export function Skeleton({ width = '100%', height = '1rem', label = 'Loading' }: SkeletonProps) {
  return (
    <span
      className="wf-skeleton"
      role="status"
      aria-label={label}
      style={{ '--wf-skeleton-width': width, '--wf-skeleton-height': height } as CSSProperties}
    />
  );
}
