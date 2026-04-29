import { useEffect, useMemo, useState } from 'react';
import {
  Table, Tag, Space, Button, App, Modal, Form, Input, InputNumber, Select, Segmented, Collapse, Row, Col,
} from 'antd';
import { PlusOutlined, DeleteOutlined, FileTextOutlined, CodeOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  useInferenceServices,
  useRuntimes,
  ensureInferenceServicesLoaded,
  ensureRuntimesLoaded,
  reloadInferenceServices,
  createInferenceService,
  deleteInferenceService,
  fetchInferenceServiceYaml,
  buildInferenceServiceYaml,
  type InferenceService,
} from '@/data/inference';
import { useApp } from '@/context/AppContext';
import { useModels } from '@/data/models';
import { LogViewer } from '@/components/LogViewer';
import { YamlViewer } from '@/components/YamlViewer';
import { GPUProfileFields } from '@/components/GPUProfileFields';
import { useGPUProfiles } from '@/data/gpuProfiles';

interface FormShape {
  name: string;
  kind: 'LLMInferenceService' | 'InferenceService';
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

export function InferenceServicesPage() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useInferenceServices();
  const runtimes = useRuntimes();
  const models = useModels();
  const profiles = useGPUProfiles();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState<{ svc: InferenceService; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);
  const [log, setLog] = useState<InferenceService | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<FormShape>();

  useEffect(() => {
    ensureInferenceServicesLoaded(namespace);
    ensureRuntimesLoaded(namespace);
  }, [namespace]);

  const openYaml = async (svc: InferenceService) => {
    setYamlLoading(svc.name);
    try {
      const text = await fetchInferenceServiceYaml(namespace, svc.name, svc.kind);
      setYaml({ svc, text: text || buildInferenceServiceYaml(svc) });
    } catch (e) {
      setYaml({ svc, text: buildInferenceServiceYaml(svc) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

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
    <div className="knaic-page">
      <PageHeader
        title="Inference services"
        description="KServe InferenceService and LLMInferenceService resources in the current namespace."
        extra={
          <Space>
            <Button onClick={() => reloadInferenceServices(namespace)}>Refresh</Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setOpen(true);
              }}
            >
              New inference service
            </Button>
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          {
            title: 'Kind',
            dataIndex: 'kind',
            render: v => <Tag color={v === 'LLMInferenceService' ? 'blue' : 'purple'}>{v}</Tag>,
          },
          { title: 'Runtime', dataIndex: 'runtime' },
          { title: 'Model', dataIndex: 'modelUri', render: v => <span className="mono">{v}</span> },
          { title: 'Replicas', render: (_, r) => r.minReplicas === r.maxReplicas ? r.minReplicas : `${r.minReplicas} – ${r.maxReplicas}` },
          {
            title: 'Resources',
            render: (_, r) => {
              const gpuDesc = r.gpuValues
                ? Object.entries(r.gpuValues).map(([k, v]) => `${k.split('/').pop()}=${v}`).join(' ')
                : r.resources.gpu > 0 ? `${r.resources.gpu} GPU` : '—';
              return `${r.resources.cpu} CPU · ${r.resources.memory} · ${gpuDesc}`;
            },
          },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          { title: 'Endpoint', dataIndex: 'endpoint', render: v => <span className="mono">{v}</span> },
          {
            title: 'Actions',
            width: 240,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<FileTextOutlined />} onClick={() => setLog(r)}>Logs</Button>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  loading={yamlLoading === r.name}
                  onClick={() => openYaml(r)}
                >
                  YAML
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete service ${r.name}?`,
                      onOk: async () => {
                        try {
                          await deleteInferenceService(namespace, r.name, r.kind);
                          message.success('Service deleted');
                        } catch (e) {
                          message.error((e as Error).message);
                        }
                      },
                    })
                  }
                />
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        title="New inference service"
        width={760}
        onCancel={() => setOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        onOk={async () => {
          const v = await form.validateFields();
          const profile = profiles.find(p => p.id === v.gpuProfileId);
          const gpuValues = profile && v.gpuValues ? v.gpuValues : undefined;
          setSubmitting(true);
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
            setOpen(false);
            form.resetFields();
          } catch (e) {
            message.error((e as Error).message);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            kind: 'LLMInferenceService',
            replicas: 1,
            cpuRequest: '8',
            cpuLimit: '8',
            memoryRequest: '64Gi',
            memoryLimit: '64Gi',
          }}
        >
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
            <Select showSearch options={modelOpts} placeholder="Pick a model from the hub" />
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

      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`${yaml?.svc.kind ?? ''} · ${yaml?.svc.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
      <LogViewer
        open={!!log}
        onClose={() => setLog(null)}
        title={`Logs · ${log?.name ?? ''}`}
        containers={['kserve-container', 'queue-proxy']}
      />
    </div>
  );
}
