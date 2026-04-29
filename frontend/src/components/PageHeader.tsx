import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}

export function PageHeader({ title, description, extra }: Props) {
  return (
    <div className="knaic-page-header">
      <div>
        <h2>{title}</h2>
        {description && <div className="knaic-sub">{description}</div>}
      </div>
      {extra && <div>{extra}</div>}
    </div>
  );
}
