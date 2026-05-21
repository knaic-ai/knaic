// Shared mapping of `modelType` → colorful icon + label. Used by the model
// list cards, the model-type Segmented filter, and the model detail page
// header. Keeping it in one file means a new type only needs to be added
// in one place to light up everywhere.

import {
  ThunderboltFilled,
  DotChartOutlined,
  TagsFilled,
  PictureFilled,
  AudioFilled,
  EyeFilled,
  RobotFilled,
  QuestionCircleFilled,
  CodeFilled,
} from '@ant-design/icons';
import type { ComponentType } from 'react';

export interface ModelTypeMeta {
  /** Stable kebab-case identifier matching `Model.modelType`. */
  id: string;
  /** Capitalised label for buttons/tags. */
  label: string;
  /** Hex accent — used for the icon foreground and the filter pill background. */
  color: string;
  /** AntD icon component rendered next to the label. */
  Icon: ComponentType<{ style?: React.CSSProperties }>;
}

export const MODEL_TYPE_META: Record<string, ModelTypeMeta> = {
  llm: { id: 'llm', label: 'LLM', color: '#5B5BD6', Icon: ThunderboltFilled },
  embedding: { id: 'embedding', label: 'Embedding', color: '#13A055', Icon: DotChartOutlined },
  classifier: { id: 'classifier', label: 'Classifier', color: '#D29C00', Icon: TagsFilled },
  diffusion: { id: 'diffusion', label: 'Diffusion', color: '#C744AB', Icon: PictureFilled },
  multimodal: { id: 'multimodal', label: 'Multimodal', color: '#7A3DB8', Icon: RobotFilled },
  audio: { id: 'audio', label: 'Audio', color: '#0BA5C7', Icon: AudioFilled },
  vision: { id: 'vision', label: 'Vision', color: '#2F65D9', Icon: EyeFilled },
  code: { id: 'code', label: 'Code', color: '#3F8F4F', Icon: CodeFilled },
  other: { id: 'other', label: 'Other', color: '#8C8C8C', Icon: QuestionCircleFilled },
};

export function modelTypeMeta(type: string): ModelTypeMeta {
  return MODEL_TYPE_META[type] ?? {
    id: type || 'other',
    label: type || 'Other',
    color: '#8C8C8C',
    Icon: QuestionCircleFilled,
  };
}

export const MODEL_TYPE_OPTIONS = Object.values(MODEL_TYPE_META);
