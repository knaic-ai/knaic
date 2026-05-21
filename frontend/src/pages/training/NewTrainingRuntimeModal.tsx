import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { createTrainingRuntime, reloadTrainingRuntimes, type TrainingFramework } from '@/data/training';
import { createNamespacedYaml, createClusterYaml } from '@/api/k8sres';
import { GPUProfileFields } from '@/components/GPUProfileFields';
import { useApp } from '@/context/AppContext';

const FRAMEWORKS: TrainingFramework[] = ['torch', 'deepspeed', 'mpi', 'tensorflow', 'jax'];

// The Kubeflow Trainer v2 TrainingRuntime CRD only recognises two
// pre-training initializer steps. Each is identified by both a fixed
// replicatedJob name AND the `trainer.kubeflow.org/trainjob-ancestor-step`
// label — the controller wires storage / configmaps to these well-known
// step names. We expose exactly these two slots, no free-form pre-jobs.
const PRE_JOB_TYPES = ['dataset-initializer', 'model-initializer'] as const;
type PreJobType = (typeof PRE_JOB_TYPES)[number];

const PRE_JOB_LABELS: Record<PreJobType, string> = {
  'dataset-initializer': 'Dataset initializer',
  'model-initializer': 'Model initializer',
};

const PRE_JOB_HINTS: Record<PreJobType, string> = {
  'dataset-initializer': 'Downloads the training dataset into the shared volume before the trainer starts.',
  'model-initializer': 'Downloads the base model checkpoint. Runs after the dataset initializer if both are enabled.',
};

interface EnvEntry {
  name: string;
  value: string;
}

interface PreJobFields {
  image: string;
  command?: string;
  args?: string;
  env?: EnvEntry[];
}

interface RuntimeFormShape {
  name: string;
  framework: TrainingFramework;
  numNodes: number;

  image: string;
  command?: string;
  args?: string;
  env?: EnvEntry[];

  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;

  // Pre-job field bags. Enablement is tracked outside the form (see the
  // PreJobEnabled state in the modal): mounting/unmounting Form.Items
  // based on an in-form flag confuses Form.useWatch (the Add button bug
  // from the previous iteration), so the toggle is plain React state.
  preJobs: Record<PreJobType, PreJobFields>;

  cluster?: boolean;
}

type PreJobEnabled = Record<PreJobType, boolean>;

interface Props {
  open: boolean;
  namespace: string;
  onClose: () => void;
}

function blankPreJob(): PreJobFields {
  return { image: '', command: '', args: '', env: [] };
}

function blankDefaults(): RuntimeFormShape {
  return {
    name: '',
    framework: 'torch',
    numNodes: 1,
    image: '',
    command: '',
    args: '',
    env: [],
    cpuRequest: '8',
    cpuLimit: '8',
    memoryRequest: '64Gi',
    memoryLimit: '64Gi',
    preJobs: {
      'dataset-initializer': blankPreJob(),
      'model-initializer': blankPreJob(),
    },
  };
}

// linesToArray splits a multi-line textarea value into a non-empty string
// slice — matches the convention used by NewServingRuntimeModal's args
// textarea so users can paste a shell command block verbatim.
function linesToArray(s: string | undefined): string[] {
  if (!s) return [];
  return s.split('\n').map(x => x.trim()).filter(Boolean);
}

export function NewTrainingRuntimeModal({ open, namespace, onClose }: Props) {
  const { user } = useApp();
  const { message } = App.useApp();
  const [form] = Form.useForm<RuntimeFormShape>();
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const [preJobEnabled, setPreJobEnabled] = useState<PreJobEnabled>({
    'dataset-initializer': false,
    'model-initializer': false,
  });

  const initialValues = useMemo<RuntimeFormShape>(() => blankDefaults(), []);

  const resetAll = () => {
    form.resetFields();
    setPreJobEnabled({ 'dataset-initializer': false, 'model-initializer': false });
    setYamlText('');
    setMode('form');
  };

  const handleClose = () => {
    resetAll();
    onClose();
  };

  // collectPayload reads the form into the CreateRuntimeRequest shape. Used
  // both by the form-mode submit path and by the "Generate YAML from form"
  // button so the two stay in lock-step.
  const collectPayload = (v: RuntimeFormShape) => {
    const preJobs = PRE_JOB_TYPES.flatMap(t => {
      if (!preJobEnabled[t]) return [];
      const slot = v.preJobs?.[t] ?? blankPreJob();
      return [{
        name: t,
        image: slot.image,
        command: linesToArray(slot.command),
        args: linesToArray(slot.args),
        env: (slot.env ?? []).filter(e => e?.name),
      }];
    });
    return {
      name: v.name,
      framework: v.framework,
      image: v.image,
      numNodes: v.numNodes,
      command: linesToArray(v.command),
      args: linesToArray(v.args),
      env: (v.env ?? []).filter(e => e?.name),
      cpuRequest: v.cpuRequest,
      cpuLimit: v.cpuLimit,
      memoryRequest: v.memoryRequest,
      memoryLimit: v.memoryLimit,
      gpuValues: v.gpuProfileId ? v.gpuValues : undefined,
      preJobs,
      cluster: v.cluster,
    };
  };

  const generateYaml = () => {
    // Pull whatever is in the form right now (no validation — the user
    // may want to start the YAML from a partial fill).
    const v = form.getFieldsValue(true) as RuntimeFormShape;
    const payload = collectPayload(v);
    setYamlText(buildTrainingRuntimeYaml(payload, namespace));
  };

  const onOk = async () => {
    if (mode === 'yaml') {
      const text = yamlText.trim();
      if (!text) {
        message.error('YAML body is empty');
        return;
      }
      try {
        const isCluster = /\bkind:\s*ClusterTrainingRuntime\b/.test(text);
        if (isCluster) {
          await createClusterYaml('clustertrainingruntimes', text);
        } else {
          await createNamespacedYaml('trainingruntimes', namespace, text);
        }
        reloadTrainingRuntimes(namespace);
        message.success('TrainingRuntime created');
        handleClose();
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Failed to create TrainingRuntime');
      }
      return;
    }
    const v = await form.validateFields();
    try {
      await createTrainingRuntime(namespace, collectPayload(v));
      message.success('TrainingRuntime created');
      handleClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create TrainingRuntime');
    }
  };

  return (
    <Modal
      open={open}
      title={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <span>New training runtime</span>
          <Segmented
            value={mode}
            onChange={v => {
              const next = v as 'form' | 'yaml';
              if (next === 'yaml' && !yamlText) generateYaml();
              setMode(next);
            }}
            options={[
              { label: 'Form', value: 'form' },
              { label: 'YAML', value: 'yaml' },
            ]}
          />
        </Space>
      }
      width={760}
      destroyOnClose
      onCancel={handleClose}
      onOk={onOk}
    >
      {mode === 'yaml' ? (
        <>
          <Space style={{ marginBottom: 8 }}>
            <Button size="small" onClick={generateYaml}>Regenerate from form</Button>
            <span className="knaic-sub" style={{ fontSize: 12 }}>
              Paste your own manifest, or click Regenerate to refresh from the form values.
              The Cluster vs namespaced target is taken from <code className="mono">kind:</code> in the YAML.
            </span>
          </Space>
          <Input.TextArea
            value={yamlText}
            onChange={e => setYamlText(e.target.value)}
            rows={24}
            spellCheck={false}
            className="mono"
            style={{ fontSize: 12, lineHeight: 1.45 }}
            placeholder="apiVersion: trainer.kubeflow.org/v1alpha1&#10;kind: TrainingRuntime&#10;metadata:&#10;  name: my-runtime&#10;spec:&#10;  ..."
          />
        </>
      ) : (
        <Form form={form} layout="vertical" initialValues={initialValues}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="Name" rules={[{ required: true }]}>
                <Input placeholder="my-training-runtime" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="framework" label="Framework">
                <Select options={FRAMEWORKS.map(v => ({ label: v, value: v }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="numNodes" label="Number of nodes">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Card size="small" title="Trainer container" style={{ marginBottom: 12 }}>
            <Form.Item name="image" label="Image" rules={[{ required: true }]}>
              <Input placeholder="ghcr.io/kubeflow/trainer/torch-runtime:2.4.0" />
            </Form.Item>
            <CommandArgsEnvCollapse rootPath={[]} />
          </Card>

          <Card size="small" title="Resources per node" style={{ marginBottom: 12 }}>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="cpuRequest" label="CPU request" rules={[{ required: true }]}>
                  <Input placeholder="8" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="cpuLimit"
                  label="CPU limit"
                  tooltip="Defaults to the request; editable."
                  rules={[{ required: true }]}
                >
                  <Input placeholder="8" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="memoryRequest" label="Memory request" rules={[{ required: true }]}>
                  <Input placeholder="64Gi" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="memoryLimit"
                  label="Memory limit"
                  tooltip="Defaults to the request; editable."
                  rules={[{ required: true }]}
                >
                  <Input placeholder="64Gi" />
                </Form.Item>
              </Col>
            </Row>
            <GPUProfileFields />
          </Card>

          <Card
            size="small"
            title={
              <Space>
                <span>Pre-training jobs</span>
                <Tag color="default">init steps</Tag>
              </Space>
            }
            extra={
              <span className="knaic-sub" style={{ fontSize: 12 }}>
                Only the two initializer types recognised by Kubeflow Trainer v2.
              </span>
            }
            style={{ marginBottom: 12 }}
          >
            {PRE_JOB_TYPES.map(type => (
              <PreJobSlot
                key={type}
                type={type}
                enabled={preJobEnabled[type]}
                onToggle={next =>
                  setPreJobEnabled(prev => ({ ...prev, [type]: next }))
                }
              />
            ))}
          </Card>

          {user.isPlatformAdmin && (
            <Form.Item
              name="cluster"
              label="ClusterTrainingRuntime"
              valuePropName="checked"
              tooltip="Cluster-scoped, shared across all namespaces. Stored in knaic-system."
            >
              <Switch />
            </Form.Item>
          )}
        </Form>
      )}
    </Modal>
  );
}

// CommandArgsEnvCollapse wraps the three "advanced" container settings —
// command, arguments, environment variables — in a single collapsible
// panel so the trainer card and pre-job cards stay compact by default.
// rootPath is the form-name prefix the inner fields nest under (empty for
// the trainer, ['preJobs', type] for a pre-job).
function CommandArgsEnvCollapse({ rootPath }: { rootPath: (string | number)[] }) {
  return (
    <Collapse
      size="small"
      ghost
      items={[
        {
          key: 'cmd',
          label: 'Command, arguments and environment',
          children: (
            <>
              <Form.Item
                name={[...rootPath, 'command']}
                label="Command (one per line)"
                tooltip="Overrides the container's ENTRYPOINT. Leave empty to keep the image default."
              >
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} placeholder={'bash\n-c'} />
              </Form.Item>
              <Form.Item
                name={[...rootPath, 'args']}
                label="Arguments (one per line)"
                tooltip="Passed after the command. Leave empty to keep the image default."
              >
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 12 }} placeholder={'--epochs\n3'} />
              </Form.Item>
              <EnvList name={[...rootPath, 'env']} />
            </>
          ),
        },
      ]}
    />
  );
}

// EnvList renders a compact name/value editor backed by Form.List.
function EnvList({ name }: { name: (string | number)[] }) {
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <Form.Item label="Environment variables">
          {fields.length === 0 && (
            <Empty
              imageStyle={{ height: 28 }}
              description={<span className="knaic-sub" style={{ fontSize: 12 }}>No env vars</span>}
              style={{ margin: '4px 0' }}
            />
          )}
          {fields.map(({ key, name: fName }) => (
            <Row key={key} gutter={6} style={{ marginBottom: 6 }}>
              <Col span={10}>
                <Form.Item name={[fName, 'name']} noStyle>
                  <Input placeholder="NAME" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name={[fName, 'value']} noStyle>
                  <Input placeholder="value" />
                </Form.Item>
              </Col>
              <Col span={2}>
                <Button size="small" icon={<DeleteOutlined />} onClick={() => remove(fName)} />
              </Col>
            </Row>
          ))}
          <Button size="small" icon={<PlusOutlined />} onClick={() => add({ name: '', value: '' })}>
            Add variable
          </Button>
        </Form.Item>
      )}
    </Form.List>
  );
}

// PreJobSlot renders one of the two fixed pre-job slots. The `enabled`
// flag is owned by the parent (plain React state) — keeping it inside
// the antd Form previously left useWatch stuck on its stale value and
// broke the Add button.
function PreJobSlot({
  type,
  enabled,
  onToggle,
}: {
  type: PreJobType;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  if (!enabled) {
    return (
      <Card
        size="small"
        type="inner"
        style={{ marginBottom: 8 }}
        title={
          <Space>
            <b>{PRE_JOB_LABELS[type]}</b>
            <span className="mono knaic-sub" style={{ fontSize: 12 }}>{type}</span>
          </Space>
        }
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={() => onToggle(true)}>
            Add
          </Button>
        }
      >
        <span className="knaic-sub" style={{ fontSize: 12 }}>{PRE_JOB_HINTS[type]}</span>
      </Card>
    );
  }

  return (
    <Card
      size="small"
      type="inner"
      style={{ marginBottom: 8 }}
      title={
        <Space>
          <b>{PRE_JOB_LABELS[type]}</b>
          <span className="mono knaic-sub" style={{ fontSize: 12 }}>{type}</span>
        </Space>
      }
      extra={
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onToggle(false)}>
          Remove
        </Button>
      }
    >
      <Form.Item
        name={['preJobs', type, 'image']}
        label="Image"
        rules={[{ required: true, message: 'required' }]}
      >
        <Input placeholder="my-registry/dataset-fetcher:v1" />
      </Form.Item>
      <CommandArgsEnvCollapse rootPath={['preJobs', type]} />
    </Card>
  );
}

// YamlPayload is the shape collectPayload() emits, restated explicitly so
// the YAML emitter below has a precise input type without depending on
// CreateRuntimeRequest from another module.
interface YamlPayload {
  name: string;
  framework: string;
  image: string;
  numNodes: number;
  command: string[];
  args: string[];
  env: EnvEntry[];
  cpuRequest: string;
  cpuLimit?: string;
  memoryRequest: string;
  memoryLimit?: string;
  gpuValues?: Record<string, number>;
  preJobs: Array<{ name: string; image: string; command: string[]; args: string[]; env: EnvEntry[] }>;
  cluster?: boolean;
}

// buildTrainingRuntimeYaml emits a YAML representation of the runtime so
// the user can review / paste / edit in YAML mode. We don't ship a YAML
// library — the shape is well-known so we hand-emit. Keep this in sync
// with backend/internal/training/service.go CreateRuntime.
function buildTrainingRuntimeYaml(req: YamlPayload, namespace: string): string {
  const lines: string[] = [];
  const kind = req.cluster ? 'ClusterTrainingRuntime' : 'TrainingRuntime';
  const framework = req.framework || 'torch';
  const numNodes = req.numNodes || 1;

  lines.push('apiVersion: trainer.kubeflow.org/v1alpha1');
  lines.push(`kind: ${kind}`);
  lines.push('metadata:');
  lines.push(`  name: ${req.name || '<name>'}`);
  if (!req.cluster) lines.push(`  namespace: ${namespace}`);
  lines.push('  labels:');
  lines.push('    knaic.io/managed: "true"');
  lines.push('    knaic.io/component: training');
  lines.push(`    knaic.io/framework: ${framework}`);
  lines.push('spec:');
  lines.push('  mlPolicy:');
  lines.push(`    numNodes: ${numNodes}`);
  lines.push(`    ${framework}: {}`);
  lines.push('  template:');
  lines.push('    spec:');
  lines.push('      replicatedJobs:');

  const indent = (n: number) => '  '.repeat(n);

  const emitContainer = (name: string, image: string, command: string[], args: string[], env: EnvEntry[], indentLevel: number, resources?: { requests: Record<string, string | number>; limits: Record<string, string | number> }) => {
    const p = indent(indentLevel);
    lines.push(`${p}- name: ${name}`);
    lines.push(`${p}  image: ${image || '<image>'}`);
    if (command.length) {
      lines.push(`${p}  command:`);
      command.forEach(c => lines.push(`${p}    - ${yamlQuote(c)}`));
    }
    if (args.length) {
      lines.push(`${p}  args:`);
      args.forEach(a => lines.push(`${p}    - ${yamlQuote(a)}`));
    }
    if (env.length) {
      lines.push(`${p}  env:`);
      env.forEach(e => {
        lines.push(`${p}    - name: ${e.name}`);
        lines.push(`${p}      value: ${yamlQuote(e.value)}`);
      });
    }
    if (resources) {
      lines.push(`${p}  resources:`);
      lines.push(`${p}    requests:`);
      for (const [k, v] of Object.entries(resources.requests)) {
        lines.push(`${p}      ${k}: ${typeof v === 'string' ? yamlQuote(v) : v}`);
      }
      lines.push(`${p}    limits:`);
      for (const [k, v] of Object.entries(resources.limits)) {
        lines.push(`${p}      ${k}: ${typeof v === 'string' ? yamlQuote(v) : v}`);
      }
    }
  };

  let lastStep: string | undefined;
  for (const p of req.preJobs) {
    lines.push(`        - name: ${p.name}`);
    if (lastStep) {
      lines.push(`          dependsOn:`);
      lines.push(`            - name: ${lastStep}`);
      lines.push(`              status: Complete`);
    }
    lines.push(`          template:`);
    lines.push(`            metadata:`);
    lines.push(`              labels:`);
    lines.push(`                trainer.kubeflow.org/trainjob-ancestor-step: ${p.name}`);
    lines.push(`            spec:`);
    lines.push(`              template:`);
    lines.push(`                spec:`);
    lines.push(`                  containers:`);
    emitContainer(p.name, p.image, p.command, p.args, p.env, 10);
    lastStep = p.name;
  }

  // Trainer ("node") replicatedJob.
  lines.push(`        - name: node`);
  if (lastStep) {
    lines.push(`          dependsOn:`);
    lines.push(`            - name: ${lastStep}`);
    lines.push(`              status: Complete`);
  }
  lines.push(`          template:`);
  lines.push(`            metadata:`);
  lines.push(`              labels:`);
  lines.push(`                trainer.kubeflow.org/trainjob-ancestor-step: trainer`);
  lines.push(`            spec:`);
  lines.push(`              template:`);
  lines.push(`                spec:`);
  lines.push(`                  containers:`);

  const requests: Record<string, string | number> = {};
  const limits: Record<string, string | number> = {};
  if (req.cpuRequest) requests.cpu = req.cpuRequest;
  if (req.memoryRequest) requests.memory = req.memoryRequest;
  if (req.cpuLimit ?? req.cpuRequest) limits.cpu = (req.cpuLimit ?? req.cpuRequest) as string;
  if (req.memoryLimit ?? req.memoryRequest) limits.memory = (req.memoryLimit ?? req.memoryRequest) as string;
  for (const [k, v] of Object.entries(req.gpuValues ?? {})) {
    requests[k] = v as number;
    limits[k] = v as number;
  }
  emitContainer('node', req.image, req.command, req.args, req.env, 10, { requests, limits });

  return lines.join('\n') + '\n';
}

// yamlQuote returns a value formatted for YAML — quoted if it contains
// any character that would need escaping (whitespace, special punctuation,
// or YAML control chars).
function yamlQuote(s: string): string {
  if (s === '' || /[\s:#&*!|>'"%@`,{}[\]?-]/.test(s) || /^(true|false|null|yes|no)$/i.test(s) || /^-?\d/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

