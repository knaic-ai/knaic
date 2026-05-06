import { useEffect } from 'react';
import { App, Button, Col, Collapse, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  createInferenceService,
  ensureInferenceServicesLoaded,
  ensureRuntimesLoaded,
  useRuntimes,
} from '@/data/inference';
import { ensureModelsLoaded, useModels } from '@/data/models';
import { useGPUProfiles } from '@/data/gpuProfiles';
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
}

interface FormShape {
  name: string;
  kind: InferenceKind;
  runtime: string;
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

export function NewInferenceServiceModal({
  open,
  namespace,
  defaults,
  lockModel,
  title,
  onClose,
  onCreated,
}: Props) {
  const { message } = App.useApp();
  const runtimes = useRuntimes();
  const models = useModels();
  const profiles = useGPUProfiles();
  const [form] = Form.useForm<FormShape>();

  useEffect(() => {
    if (!open) return;
    ensureRuntimesLoaded(namespace);
    ensureInferenceServicesLoaded(namespace);
    ensureModelsLoaded('public');
    ensureModelsLoaded('private', namespace);
  }, [open, namespace]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({ ...baseDefaults, ...defaults });
  }, [open, defaults, form]);

  const cpuReq = Form.useWatch('cpuRequest', form);
  const memReq = Form.useWatch('memoryRequest', form);
  useEffect(() => {
    if (!open) return;
    const { cpuLimit, memoryLimit } = form.getFieldsValue(['cpuLimit', 'memoryLimit']);
    if (!cpuLimit || cpuLimit === '') form.setFieldValue('cpuLimit', cpuReq);
    if (!memoryLimit || memoryLimit === '') form.setFieldValue('memoryLimit', memReq);
  }, [cpuReq, memReq, open, form]);

  const runtimeOpts = runtimes
    .filter(r => r.namespace === namespace || r.builtin)
    .map(r => ({ label: `${r.name} · ${r.image}`, value: r.name }));

  const modelOpts = models
    .filter(m => m.scope === 'public' || (m.scope === 'private' && m.namespace === namespace))
    .map(m => ({ label: `${m.name} — ${m.uri}`, value: m.uri }));

  return (
    <Modal
      open={open}
      title={title ?? 'New inference service'}
      width={760}
      onCancel={onClose}
      destroyOnClose
      okText="Create"
      onOk={async () => {
        const v = await form.validateFields();
        const profile = profiles.find(p => p.id === v.gpuProfileId);
        const gpuValues = profile && v.gpuValues ? v.gpuValues : undefined;
        try {
          await createInferenceService(namespace, {
            name: v.name,
            kind: v.kind,
            runtime: v.runtime,
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
          });
          message.success('Inference service created');
          onCreated?.({ name: v.name, kind: v.kind });
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Form form={form} layout="vertical" preserve={false} initialValues={{ ...baseDefaults, ...defaults }}>
        <Form.Item name="name" label="Name" rules={[{ required: true, pattern: /^[a-z0-9-]+$/ }]}>
          <Input placeholder="qwen3-5-7b" />
        </Form.Item>
        <Form.Item name="kind" label="Kind">
          <Segmented
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
        <Form.Item name="runtime" label="Serving runtime" rules={[{ required: true }]}>
          <Select options={runtimeOpts} placeholder="Pick a ServingRuntime" />
        </Form.Item>
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
                            <Space key={key} style={{ display: 'flex', marginBottom: 6 }}>
                              <Form.Item name={[name, 'name']} rules={[{ required: true }]}>
                                <Input placeholder="NAME" style={{ width: 200 }} />
                              </Form.Item>
                              <Form.Item name={[name, 'value']}>
                                <Input placeholder="value" style={{ width: 260 }} />
                              </Form.Item>
                              <Button danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
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
                    <Input.TextArea rows={3} placeholder="--max-model-len&#10;32768" />
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
