import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface RoomRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: string;
  description?: string;
  leading?: ReactNode;
}

export function RoomRow({ name, description, leading, ...props }: RoomRowProps) {
  return (
    <button {...props} className="wf-destination-row">
      {leading && (
        <span className="wf-destination-row__leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="wf-destination-row__text">
        <span className="wf-destination-row__name">{name}</span>
        {description && <span className="wf-destination-row__description">{description}</span>}
      </span>
      <span className="wf-destination-row__arrow" aria-hidden="true">
        →
      </span>
    </button>
  );
}
