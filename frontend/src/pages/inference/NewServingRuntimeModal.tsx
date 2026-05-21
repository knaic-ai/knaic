import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Col, Collapse, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Switch } from 'antd';
import { CodeOutlined, FormOutlined } from '@ant-design/icons';
import {
  createServingRuntime,
  defaultArgsForRuntimeFamily,
  defaultRuntimeSecurityContext,
  defaultServingRuntimeArgs,
  reloadRuntimes,
  updateServingRuntime,
  type RuntimeSecurityContext,
  type ServingRuntime,
} from '@/data/inference';
import { createNamespacedYaml } from '@/api/k8sres';
import { useGPUProfiles, type GPUProfile } from '@/data/gpuProfiles';
import { GPUProfileFields } from '@/components/GPUProfileFields';

// blankYamlTemplate is the skeleton we pre-fill the YAML editor with when
// the user flips to YAML mode on a new runtime. Built to compile with the
// upstream KServe ServingRuntime CRD; the user typically only edits the
// `name`, `image`, `args` and `resources` sections.
const blankYamlTemplate = (ns: string) => `apiVersion: serving.kserve.io/v1alpha1
kind: ServingRuntime
metadata:
  name: my-runtime
  namespace: ${ns}
  labels:
    knaic.io/managed: "true"
    knaic.io/component: inference
spec:
  supportedModelFormats:
    - name: huggingface
      autoSelect: true
  containers:
    - name: kserve-container
      image: vllm/vllm-openai:v0.7.2
      args:
        - --port
        - "8080"
        - --served-model-name
        - "{{.Name}}"
        - --model
        - /mnt/models
      resources:
        requests:
          cpu: "8"
          memory: 64Gi
        limits:
          cpu: "8"
          memory: 64Gi
          nvidia.com/gpu: 1
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: [ALL]
        privileged: false
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
`;

interface RuntimeFormShape {
  name: string;
  runtime: string;
  image: string;
  supportedModelFormats?: string[];
  defaultArgs?: string;
  securityContext: RuntimeSecurityContext;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
}

interface Props {
  open: boolean;
  namespace: string;
  // When provided, the modal acts as Edit (PUT /inference/runtimes/{name});
  // otherwise it creates a new runtime.
  editing?: ServingRuntime | null;
  onClose: () => void;
}

function formatArgs(args: string[]): string {
  return args.join('\n');
}

function defaultArgsForRuntime(runtime: string): string {
  return formatArgs(defaultArgsForRuntimeFamily(runtime));
}

function blankDefaults(): RuntimeFormShape {
  return {
    name: '',
    runtime: 'vllm',
    image: '',
    supportedModelFormats: ['huggingface'],
    defaultArgs: defaultArgsForRuntime('vllm'),
    securityContext: defaultRuntimeSecurityContext(),
    cpuRequest: '8',
    cpuLimit: '8',
    memoryRequest: '64Gi',
    memoryLimit: '64Gi',
  };
}

// matchProfile picks the GPU profile whose declared resource keys equal the
// keys present on the existing runtime, so the edit form re-binds to that
// profile and shows its labeled inputs. Returns undefined when nothing
// matches — the user can still set gpuValues by reselecting a profile.
function matchProfile(
  profiles: GPUProfile[],
  gpuValues: Record<string, number> | undefined,
): string | undefined {
  if (!gpuValues || Object.keys(gpuValues).length === 0) return undefined;
  const have = new Set(Object.keys(gpuValues));
  for (const p of profiles) {
    const want = new Set(p.fields.map(f => f.key));
    if (want.size === have.size && [...want].every(k => have.has(k))) {
      return p.id;
    }
  }
  return undefined;
}

function defaultsFromRuntime(sr: ServingRuntime, profiles: GPUProfile[]): RuntimeFormShape {
  return {
    name: sr.name,
    runtime: sr.runtime,
    image: sr.image,
    supportedModelFormats: sr.supportedModelFormats,
    defaultArgs: (sr.defaultArgs ?? []).join('\n') || defaultArgsForRuntime(sr.runtime),
    securityContext: sr.securityContext ?? defaultRuntimeSecurityContext(),
    cpuRequest: sr.cpuRequest ?? sr.resources.cpu ?? '',
    cpuLimit: sr.cpuLimit ?? sr.resources.cpu ?? '',
    memoryRequest: sr.memoryRequest ?? sr.resources.memory ?? '',
    memoryLimit: sr.memoryLimit ?? sr.resources.memory ?? '',
    gpuProfileId: matchProfile(profiles, sr.gpuValues),
    gpuValues: sr.gpuValues,
  };
}

export function NewServingRuntimeModal({ open, namespace, editing, onClose }: Props) {
  const { message } = App.useApp();
  const profiles = useGPUProfiles();
  const [form] = Form.useForm<RuntimeFormShape>();
  const isEdit = !!editing;
  // mode flips between the structured form and a raw YAML editor. Edit
  // mode keeps the form (the existing list page already has a separate
  // "Edit YAML" action for live runtimes — we don't duplicate that here).
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState<string>('');
  // Reset YAML buffer whenever the modal opens; the user lands on the form
  // tab and only sees the template after explicitly switching.
  useEffect(() => {
    if (open && !isEdit) {
      setMode('form');
      setYamlText(blankYamlTemplate(namespace));
    }
  }, [open, isEdit, namespace]);

  // Computed once per open + editing change. The Form below carries the
  // matching `key` so it remounts with these as initialValues — that's the
  // antd-recommended pattern when the form is shown inside a Modal with
  // destroyOnClose, and avoids the setFieldsValue/race we used to have.
  const initialValues = useMemo<RuntimeFormShape>(
    () => (editing ? defaultsFromRuntime(editing, profiles) : blankDefaults()),
    [editing, profiles],
  );
  const formKey = `${editing?.name ?? 'new'}::${profiles.length}`;

  // When the runtime family changes, replace the args block with the family
  // default — but only if the current value is empty or matches a known
  // default, so user-customised args aren't clobbered.
  const runtime = Form.useWatch('runtime', form);
  useEffect(() => {
    if (!open) return;
    const current = (form.getFieldValue('defaultArgs') ?? '').trim();
    const knownDefaults = Object.values(defaultServingRuntimeArgs).map(args => formatArgs(args).trim());
    if (current === '' || knownDefaults.includes(current)) {
      form.setFieldValue('defaultArgs', defaultArgsForRuntime(runtime ?? ''));
    }
  }, [runtime, open, form]);

  // "Limit defaults to request" mirroring (matches the InferenceService modal).
  const cpuReq = Form.useWatch('cpuRequest', form);
  const memReq = Form.useWatch('memoryRequest', form);
  useEffect(() => {
    if (!open) return;
    const { cpuLimit, memoryLimit } = form.getFieldsValue(['cpuLimit', 'memoryLimit']);
    if (!cpuLimit || cpuLimit === '') form.setFieldValue('cpuLimit', cpuReq);
    if (!memoryLimit || memoryLimit === '') form.setFieldValue('memoryLimit', memReq);
  }, [cpuReq, memReq, open, form]);

  const submit = async () => {
    if (mode === 'yaml' && !isEdit) {
      // YAML path: send the manifest verbatim through the generic
      // namespaced-YAML POST endpoint. The backend parses it server-side,
      // so any schema issues come back as an apiserver error message.
      const text = yamlText.trim();
      if (!text) {
        message.error('YAML cannot be empty');
        return;
      }
      try {
        await createNamespacedYaml('servingruntimes', namespace, text);
        message.success('Runtime created from YAML');
        reloadRuntimes(namespace);
        onClose();
      } catch (e) {
        message.error((e as Error).message);
      }
      return;
    }
    const v = await form.validateFields();
    const profile = profiles.find(p => p.id === v.gpuProfileId);
    const gpuValues = profile && v.gpuValues ? v.gpuValues : undefined;
    const payload = {
      name: v.name,
      image: v.image,
      runtime: v.runtime,
      supportedModelFormats: v.supportedModelFormats,
      args: (v.defaultArgs ?? '').split('\n').map(s => s.trim()).filter(Boolean),
      securityContext: v.securityContext,
      cpuRequest: v.cpuRequest,
      cpuLimit: v.cpuLimit,
      memoryRequest: v.memoryRequest,
      memoryLimit: v.memoryLimit,
      gpuValues,
    };
    try {
      if (isEdit) {
        await updateServingRuntime(namespace, editing!.name, payload);
        message.success('Runtime updated');
      } else {
        await createServingRuntime(namespace, payload);
        message.success('Runtime created');
      }
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Modal
      open={open}
      title={
        isEdit ? (
          `Edit runtime · ${editing!.name}`
        ) : (
          <Space>
            <span>New serving runtime</span>
            <Segmented
              size="small"
              value={mode}
              onChange={v => setMode(v as 'form' | 'yaml')}
              options={[
                { label: 'Form', value: 'form', icon: <FormOutlined /> },
                { label: 'YAML', value: 'yaml', icon: <CodeOutlined /> },
              ]}
            />
          </Space>
        )
      }
      width={mode === 'yaml' && !isEdit ? 860 : 640}
      onCancel={onClose}
      destroyOnClose
      okText={isEdit ? 'Save' : 'Create'}
      onOk={submit}
    >
      {!isEdit && mode === 'yaml' ? (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Paste or edit a ServingRuntime manifest"
            description={
              <span>
                The manifest is sent to the API server as-is — its{' '}
                <code>metadata.namespace</code> must be <code>{namespace}</code> or
                the apiserver will reject it.
              </span>
            }
          />
          <Input.TextArea
            value={yamlText}
            onChange={e => setYamlText(e.target.value)}
            rows={22}
            spellCheck={false}
            className="mono"
            style={{ fontSize: 12, lineHeight: 1.45 }}
          />
        </>
      ) : (
      <Form key={formKey} form={form} layout="vertical" initialValues={initialValues}>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input placeholder="my-vllm" disabled={isEdit} />
        </Form.Item>
        <Form.Item name="runtime" label="Runtime family" rules={[{ required: true }]}>
          <Select options={['vllm', 'sglang', 'custom'].map(v => ({ label: v, value: v }))} />
        </Form.Item>
        <Form.Item name="image" label="Container image" rules={[{ required: true }]}>
          <Input placeholder="vllm/vllm-openai:v0.7.2" />
        </Form.Item>
        <Form.Item name="supportedModelFormats" label="Supported model formats">
          <Select mode="tags" />
        </Form.Item>
        <Form.Item name="defaultArgs" label="Default args (one per line)">
          <Input.TextArea
            autoSize={{ minRows: 4, maxRows: 20 }}
            placeholder="--max-model-len&#10;32768"
          />
        </Form.Item>
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
        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'security',
              label: 'Security context',
              children: (
                <>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item
                        name={['securityContext', 'allowPrivilegeEscalation']}
                        label="Allow privilege escalation"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name={['securityContext', 'privileged']}
                        label="Privileged"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item
                        name={['securityContext', 'runAsNonRoot']}
                        label="Run as non-root"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name={['securityContext', 'runAsUser']} label="Run as user">
                        <InputNumber min={0} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item name={['securityContext', 'capabilities', 'drop']} label="Capabilities drop">
                        <Select mode="tags" options={[{ label: 'ALL', value: 'ALL' }]} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name={['securityContext', 'capabilities', 'add']} label="Capabilities add">
                        <Select mode="tags" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item name={['securityContext', 'seccompProfile', 'type']} label="Seccomp profile">
                    <Select
                      options={['RuntimeDefault', 'Unconfined'].map(v => ({ label: v, value: v }))}
                    />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </Form>
      )}
    </Modal>
  );
}
