import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  MinusCircleFilled,
  PauseCircleFilled,
  SyncOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';

type Tone = 'success' | 'processing' | 'default' | 'error' | 'warning' | 'stopped';

const palette: Record<Tone, { color: string; icon: (spinning: boolean) => ReactNode }> = {
  success: { color: '#52c41a', icon: () => <CheckCircleFilled /> },
  processing: { color: '#1677ff', icon: () => <SyncOutlined spin /> },
  default: { color: '#bfbfbf', icon: () => <MinusCircleFilled /> },
  error: { color: '#ff4d4f', icon: () => <CloseCircleFilled /> },
  warning: { color: '#faad14', icon: () => <ExclamationCircleFilled /> },
  stopped: { color: '#8c8c8c', icon: () => <PauseCircleFilled /> },
};

const map: Record<string, { tone: Tone; label?: string }> = {
  Running: { tone: 'success' },
  Ready: { tone: 'success' },
  Installed: { tone: 'success' },
  Available: { tone: 'success' },
  Bound: { tone: 'success' },
  Succeeded: { tone: 'success' },
  Active: { tone: 'success' },
  Pending: { tone: 'processing' },
  Progressing: { tone: 'processing' },
  Creating: { tone: 'processing' },
  Installing: { tone: 'processing' },
  Updating: { tone: 'processing' },
  Unknown: { tone: 'default' },
  Stopped: { tone: 'stopped' },
  NotInstalled: { tone: 'default', label: 'Not installed' },
  Failed: { tone: 'error' },
  Error: { tone: 'error' },
  CrashLoopBackOff: { tone: 'error' },
  Warning: { tone: 'warning' },
};

export function StatusTag({ value }: { value: string }) {
  const m = map[value] ?? { tone: 'default' as const };
  const p = palette[m.tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
    >
      <span style={{ color: p.color, fontSize: 16, display: 'inline-flex' }}>
        {p.icon(m.tone === 'processing')}
      </span>
      <span>{m.label ?? value}</span>
    </span>
  );
}
