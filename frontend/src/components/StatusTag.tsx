import { Badge } from 'antd';

const map: Record<string, { color: 'success' | 'processing' | 'default' | 'error' | 'warning'; label?: string }> = {
  Running: { color: 'success' },
  Ready: { color: 'success' },
  Installed: { color: 'success' },
  Available: { color: 'success' },
  Bound: { color: 'success' },
  Succeeded: { color: 'success' },
  Active: { color: 'success' },
  Pending: { color: 'processing' },
  Progressing: { color: 'processing' },
  Creating: { color: 'processing' },
  Installing: { color: 'processing' },
  Updating: { color: 'processing' },
  Unknown: { color: 'default' },
  Stopped: { color: 'default' },
  NotInstalled: { color: 'default', label: 'Not installed' },
  Failed: { color: 'error' },
  Error: { color: 'error' },
  CrashLoopBackOff: { color: 'error' },
  Warning: { color: 'warning' },
};

export function StatusTag({ value }: { value: string }) {
  const m = map[value] ?? { color: 'default' as const };
  return <Badge status={m.color} text={m.label ?? value} />;
}
