import { Tag } from 'antd';
import { modelTypeMeta } from './modelTypeMeta';

interface Props {
  type: string;
  /** When true, render a fuller pill with both icon and label. Default true. */
  showLabel?: boolean;
  /** Kept for backward compatibility with the small-on-cards usage. The
   * badge's overall dimensions follow Antd's Tag defaults regardless,
   * which is what keeps it baseline-aligned with sibling Tags; this prop
   * only shifts the icon size slightly. */
  size?: 'small' | 'default';
}

/** Colorful, icon-prefixed badge for a model's `modelType` value.
 *
 * Uses Antd Tag's built-in `icon` prop so the height + padding + line-height
 * match every other Tag rendered next to it (scheme tag, collection tag,
 * etc.). That alignment is the whole reason this lives as a single shared
 * component — earlier inline-flex/padding overrides made the badge taller
 * than its sibling Tags and broke the row baseline. */
export function ModelTypeBadge({ type, showLabel = true, size = 'default' }: Props) {
  const meta = modelTypeMeta(type);
  const Icon = meta.Icon;
  const iconSize = size === 'small' ? 11 : 12;
  return (
    <Tag
      icon={<Icon style={{ color: meta.color, fontSize: iconSize }} />}
      style={{
        background: `${meta.color}1A`,
        borderColor: `${meta.color}55`,
        color: meta.color,
        fontWeight: 600,
        margin: 0,
      }}
    >
      {showLabel ? meta.label : null}
    </Tag>
  );
}
