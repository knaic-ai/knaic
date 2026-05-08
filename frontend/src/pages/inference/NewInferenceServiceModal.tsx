import { useEffect, useMemo } from 'react';
import { App, Button, Col, Collapse, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  createInferenceService,
  ensureDeploymentModesLoaded,
  ensureInferenceServicesLoaded,
  ensureLLMConfigsLoaded,
  ensureRuntimesLoaded,
  useDeploymentModes,
  useLLMConfigs,
  useRuntimes,
  updateInferenceService,
  type InferenceService,
} from '@/data/inference';
import { ensureModelsLoaded, useModels } from '@/data/models';
import { useGPUProfiles, type GPUProfile } from '@/data/gpuProfiles';
import { GPUProfileFields } from '@/components/GPUProfileFields';

export type InferenceKind = 'LLMInferenceService' | 'InferenceService';

export interface InferenceFormDefaults {
  name?: string;
  kind?: InferenceKind;
  runtime?: string;
  modelUri?: string;
  replicas?: number;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  baseConfigs?: string[];
  modelName?: string;
  containerImage?: string;
  gpuValues?: Record<string, number>;
  env?: { name: string; value: string }[];
  command?: string[];
  args?: string[];
  deploymentMode?: string;
}

interface FormShape {
  name: string;
  kind: InferenceKind;
  // InferenceService only.
  runtime?: string;
  deploymentMode?: string;
  // LLMInferenceService only.
  baseConfigs?: string[];
  modelName?: string;
  containerImage?: string;
  modelUri: string;
  replicas: number;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
  env?: { name: string; value: string }[];
  command?: string;
  args?: string;
}

interface Props {
  open: boolean;
  namespace: string;
  defaults?: InferenceFormDefaults;
  editing?: InferenceService | null;
  // When true, the model picker is disabled — used from the Model Hub's
  // Publish flow where the model is already chosen.
  lockModel?: boolean;
  title?: string;
  onClose: () => void;
  onCreated?: (svc: { name: string; kind: InferenceKind }) => void;
}

const baseDefaults: FormShape = {
  name: '',
  kind: 'LLMInferenceService',
  runtime: '',
  modelUri: '',
  replicas: 1,
  cpuRequest: '8',
  cpuLimit: '8',
  memoryRequest: '64Gi',
  memoryLimit: '64Gi',
};

function matchProfile(
  profiles: GPUProfile[],
  gpuValues: Record<string, number> | undefined,
): string | undefined {
  if (!gpuValues || Object.keys(gpuValues).length === 0) return undefined;
  const have = new Set(Object.keys(gpuValues));
  for (const p of profiles) {
    const want = new Set(p.fields.map(f => f.key));
    if (want.size === have.size && [...want].every(k => have.has(k))) return p.id;
  }
  return undefined;
}

function defaultsFromService(svc: InferenceService, profiles: GPUProfile[]): FormShape {
  return {
    name: svc.name,
    kind: svc.kind,
    runtime: svc.kind === 'InferenceService' ? svc.runtime : undefined,
    deploymentMode: svc.kind === 'InferenceService' ? svc.deploymentMode : undefined,
    baseConfigs: svc.baseConfigs,
    modelName: svc.modelName,
    containerImage: svc.containerImage,
    modelUri: svc.modelUri,
    replicas: svc.maxReplicas || svc.minReplicas || 1,
    cpuRequest: svc.cpuRequest ?? svc.resources.cpu ?? '',
    cpuLimit: svc.cpuLimit ?? svc.resources.cpu ?? '',
    memoryRequest: svc.memoryRequest ?? svc.resources.memory ?? '',
    memoryLimit: svc.memoryLimit ?? svc.resources.memory ?? '',
    gpuProfileId: matchProfile(profiles, svc.gpuValues),
    gpuValues: svc.gpuValues,
    env: svc.env,
    command: svc.command?.join(' '),
    args: svc.args?.join('\n'),
  };
}

function defaultsFromProps(defaults?: InferenceFormDefaults): FormShape {
  return {
    ...baseDefaults,
    ...defaults,
    command: defaults?.command?.join(' '),
    args: defaults?.args?.join('\n'),
  };
}

export function NewInferenceServiceModal({
  open,
  namespace,
  defaults,
  editing,
  lockModel,
  title,
  onClose,
  onCreated,
}: Props) {
  const { message } = App.useApp();
  const runtimes = useRuntimes();
  const llmConfigs = useLLMConfigs();
  const deploymentModes = useDeploymentModes();
  const models = useModels();
  const profiles = useGPUProfiles();
  const [form] = Form.useForm<FormShape>();
  const isEdit = !!editing;

  const initialValues = useMemo<FormShape>(
    () => (editing ? defaultsFromService(editing, profiles) : defaultsFromProps(defaults)),
    [defaults, editing, profiles],
  );
  const formKey = `${editing?.kind ?? 'new'}::${editing?.name ?? defaults?.name ?? 'blank'}::${profiles.length}`;

  useEffect(() => {
    if (!open) return;
    ensureRuntimesLoaded(namespace);
    ensureInferenceServicesLoaded(namespace);
    ensureLLMConfigsLoaded();
    ensureDeploymentModesLoaded();
    ensureModelsLoaded('public');
    ensureModelsLoaded('private', namespace);
  }, [open, namespace]);

  // Watch the kind so the form can swap runtime ↔ base-config picker.
  const kind = Form.useWatch('kind', form) ?? initialValues.kind ?? 'LLMInferenceService';
  const isLLM = kind === 'LLMInferenceService';

  // Default the deploymentMode field to whatever the cluster reports as its
  // default — but only on first encounter, so the user's manual picks stick.
  useEffect(() => {
    if (!open || isLLM || isEdit) return;
    const current = form.getFieldValue('deploymentMode');
    if (!current) {
      form.setFieldValue('deploymentMode', deploymentModes.default);
    }
  }, [open, isLLM, isEdit, deploymentModes.default, form]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(initialValues);
  }, [open, initialValues, form]);

  const cpuReq = Form.useWatch('cpuRequest', form);
  const memReq = Form.useWatch('memoryRequest', form);
  useEffect(() => {
    // Auto-fill the limit from the request only when creating — in edit
    // mode the existing limit is authoritative and racing it with the
    // mount-time initialValues round-trip leaves the wrong value visible.
    if (!open || isEdit) return;
    const { cpuLimit, memoryLimit } = form.getFieldsValue(['cpuLimit', 'memoryLimit']);
    if (!cpuLimit || cpuLimit === '') form.setFieldValue('cpuLimit', cpuReq);
    if (!memoryLimit || memoryLimit === '') form.setFieldValue('memoryLimit', memReq);
  }, [cpuReq, memReq, open, isEdit, form]);

  const runtimeOpts = runtimes
    .filter(r => r.namespace === namespace || r.builtin)
    .map(r => ({ label: `${r.name} · ${r.image}`, value: r.name }));

  const llmConfigOpts = llmConfigs.map(c => ({
    label: `${c.namespace}/${c.name}`,
    value: c.name,
  }));

  const modelOpts = models
    .filter(m => m.scope === 'public' || (m.scope === 'private' && m.namespace === namespace))
    .map(m => ({ label: `${m.name} — ${m.uri}`, value: m.uri }));

  return (
    <Modal
      open={open}
      title={title ?? (isEdit ? `Edit inference service · ${editing!.name}` : 'New inference service')}
      width={760}
      onCancel={onClose}
      destroyOnClose
      okText={isEdit ? 'Save' : 'Create'}
      onOk={async () => {
        const v = await form.validateFields();
        const profile = profiles.find(p => p.id === v.gpuProfileId);
        const gpuValues = profile && v.gpuValues ? v.gpuValues : undefined;
        try {
          const llm = v.kind === 'LLMInferenceService';
          const payload = {
            name: v.name,
            kind: v.kind,
            // Runtime ref only applies to InferenceService; the backend
            // ignores it for LLM kind, but we omit it to keep the payload tidy.
            runtime: llm ? undefined : v.runtime,
            // serving.kserve.io/deploymentMode annotation — InferenceService
            // only. KServe picks its own default for LLMInferenceService.
            deploymentMode: llm ? undefined : v.deploymentMode,
            // LLM-only fields — likewise omitted for InferenceService.
            baseConfigs: llm ? v.baseConfigs : undefined,
            modelName: llm ? v.modelName : undefined,
            containerImage: llm ? v.containerImage : undefined,
            modelUri: v.modelUri,
            replicas: v.replicas,
            cpuRequest: v.cpuRequest,
            cpuLimit: v.cpuLimit,
            memoryRequest: v.memoryRequest,
            memoryLimit: v.memoryLimit,
            gpuValues,
            env: v.env,
            command: v.command ? v.command.split(/\s+/).filter(Boolean) : undefined,
            args: v.args ? v.args.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
          };
          if (isEdit) {
            await updateInferenceService(namespace, editing!.name, payload);
            message.success('Inference service updated');
          } else {
            await createInferenceService(namespace, payload);
            message.success('Inference service created');
            onCreated?.({ name: v.name, kind: v.kind });
          }
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      {/* preserve={false} drops values for any temporarily-unmounted Form.Item
          (e.g. the runtime ↔ baseConfigs swap) and stomps on the initial
          values of fields like cpuLimit/memoryLimit during the profile-load
          remount — keep antd's default preserve=true. */}
      <Form key={formKey} form={form} layout="vertical" initialValues={initialValues}>
        <Form.Item name="name" label="Name" rules={[{ required: true, pattern: /^[a-z0-9-]+$/ }]}>
          <Input placeholder="qwen3-5-7b" disabled={isEdit} />
        </Form.Item>
        <Form.Item name="kind" label="Kind">
          <Segmented
            disabled={isEdit}
            options={[
              { label: 'LLMInferenceService', value: 'LLMInferenceService' },
              { label: 'InferenceService', value: 'InferenceService' },
            ]}
          />
        </Form.Item>
        <Form.Item name="modelUri" label="Model" rules={[{ required: true }]}>
          <Select
            showSearch
            options={modelOpts}
            placeholder="Pick a model from the hub"
            disabled={lockModel}
          />
        </Form.Item>
        {isLLM ? (
          <>
            <Form.Item
              name="baseConfigs"
              label="Base config"
              tooltip="LLMInferenceServiceConfig CRs whose template/router/parallelism etc. are merged into this service's spec via spec.baseRefs."
            >
              <Select
                mode="multiple"
                allowClear
                options={llmConfigOpts}
                placeholder="(optional) pick one or more LLMInferenceServiceConfigs"
              />
            </Form.Item>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item
                  name="modelName"
                  label="Model name"
                  tooltip="Optional spec.model.name. Used by some runtimes as the served model id."
                >
                  <Input placeholder="qwen3-5-7b" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="containerImage"
                  label="Container image (override)"
                  tooltip="Leave empty to inherit the image from the chosen base config."
                >
                  <Input placeholder="vllm/vllm-openai:v0.7.2" />
                </Form.Item>
              </Col>
            </Row>
          </>
        ) : (
          <>
            <Form.Item name="runtime" label="Serving runtime" rules={[{ required: true }]}>
              <Select options={runtimeOpts} placeholder="Pick a ServingRuntime" />
            </Form.Item>
            <Form.Item
              name="deploymentMode"
              label="Deployment mode"
              tooltip="Pinned via the serving.kserve.io/deploymentMode annotation. Modes the cluster's KServe install can handle are listed here; the cluster's configured default is pre-selected."
            >
              <Select
                options={deploymentModes.modes.map(m => ({ label: m, value: m }))}
                placeholder="Use cluster default"
                allowClear
              />
            </Form.Item>
          </>
        )}
        <Form.Item name="replicas" label="Replicas" rules={[{ required: true }]}>
          <InputNumber min={1} max={32} style={{ width: 180 }} />
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
              key: 'advanced',
              label: 'Advanced · env, command, args',
              children: (
                <>
                  <Form.Item label="Environment variables">
                    <Form.List name="env">
                      {(fields, { add, remove }) => (
                        <>
                          {fields.map(({ key, name }) => (
                            // align="baseline" lets the delete button sit on
                            // the same line as the Inputs; marginBottom: 0
                            // on the inner Form.Items removes their default
                            // 24px vertical gap so the row stays a single line.
                            <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 6 }}>
                              <Form.Item
                                name={[name, 'name']}
                                rules={[{ required: true, message: 'name required' }]}
                                style={{ marginBottom: 0 }}
                              >
                                <Input placeholder="NAME" style={{ width: 200 }} />
                              </Form.Item>
                              <Form.Item name={[name, 'value']} style={{ marginBottom: 0 }}>
                                <Input placeholder="value" style={{ width: 260 }} />
                              </Form.Item>
                              <Button
                                danger
                                icon={<DeleteOutlined />}
                                onClick={() => remove(name)}
                                aria-label="Remove env var"
                              />
                            </Space>
                          ))}
                          <Button block icon={<PlusOutlined />} onClick={() => add({ name: '', value: '' })}>
                            Add env var
                          </Button>
                        </>
                      )}
                    </Form.List>
                  </Form.Item>
                  <Form.Item name="command" label="Command (space-separated)">
                    <Input placeholder="python -m vllm.entrypoints.openai.api_server" />
                  </Form.Item>
                  <Form.Item name="args" label="Args (one per line)">
                    <Input.TextArea
                      autoSize={{ minRows: 3, maxRows: 16 }}
                      placeholder="--max-model-len&#10;32768"
                    />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}
