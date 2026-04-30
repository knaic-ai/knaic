import { useEffect, useMemo, useState } from 'react';
import {
  Table, Tag, Space, Button, Progress, App, Modal, Form, Input, InputNumber, Select,
  Tabs, Card, Row, Col, Empty, Collapse, Tooltip as AntTooltip,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, FileTextOutlined, StopOutlined,
  LineChartOutlined,
} from '@ant-design/icons';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  createTrainJob,
  deleteTrainJob,
  ensureTrainJobsLoaded,
  ensureTrainingRuntimesLoaded,
  trainJobsStore,
  useTrainJobs,
  useTrainingRuntimes,
  type TrainJob,
} from '@/data/training';
import { ensurePodsLoaded, usePods, type Pod } from '@/data/workloads';
import { useApp } from '@/context/AppContext';
import { useModels } from '@/data/models';
import { LogViewer } from '@/components/LogViewer';
import { GPUProfileFields } from '@/components/GPUProfileFields';
import { useGPUProfiles } from '@/data/gpuProfiles';
import { apiEnabled } from '@/api/client';

interface FormShape {
  name: string;
  runtime: string;
  numNodes: number;
  modelUri?: string;
  datasetUri?: string;
  command: string;
  args?: string;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
  env?: { name: string; value: string }[];
}

const RUN_COLORS = ['#2468f2', '#e94f4f', '#10b981', '#f8b418', '#a855f7', '#0ea5e9'];

export function TrainJobsPage() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useTrainJobs();
  const pods = usePods();
  const runtimes = useTrainingRuntimes();
  const models = useModels();
  const profiles = useGPUProfiles();
  const data = useMemo(() => all.filter(j => j.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<{ job: TrainJob; pod?: Pod } | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [form] = Form.useForm<FormShape>();

  const cpuReq = Form.useWatch('cpuRequest', form);
  const memReq = Form.useWatch('memoryRequest', form);

  useEffect(() => {
    ensureTrainingRuntimesLoaded(namespace);
    ensureTrainJobsLoaded(namespace);
    ensurePodsLoaded(namespace);
  }, [namespace]);

  useEffect(() => {
    if (!open) return;
    const { cpuLimit, memoryLimit } = form.getFieldsValue(['cpuLimit', 'memoryLimit']);
    if (!cpuLimit) form.setFieldValue('cpuLimit', cpuReq);
    if (!memoryLimit) form.setFieldValue('memoryLimit', memReq);
  }, [cpuReq, memReq, open, form]);

  const runtimeOpts = runtimes
    .filter(r => r.builtin || r.namespace === namespace)
    .map(r => ({ label: `${r.name} · ${r.framework}`, value: r.name }));

  const modelOpts = models
    .filter(m => m.scope === 'public' || (m.scope === 'private' && m.namespace === namespace))
    .map(m => ({ label: `${m.name} — ${m.uri}`, value: m.uri }));

  const podFor = (job: TrainJob) =>
    pods.find(p => p.namespace === job.namespace && p.ownerRef === `TrainJob/${job.name}`);

  const tracedJobs = data.filter(j => j.mlflow);
  const compared = tracedJobs.filter(j => compareIds.includes(j.id));
  useEffect(() => {
    if (compareIds.length === 0 && tracedJobs.length > 0) {
      setCompareIds(tracedJobs.slice(0, Math.min(2, tracedJobs.length)).map(j => j.id));
    }
  }, [tracedJobs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const compareData = useMemo(() => {
    if (compared.length === 0) return [];
    const maxStep = Math.max(...compared.map(j => j.mlflow!.samples.length));
    return Array.from({ length: maxStep }, (_, i) => {
      const row: Record<string, number | string> = { step: i + 1 };
      for (const j of compared) {
        const s = j.mlflow!.samples[i];
        if (s) {
          row[`${j.name}__loss`] = s.loss;
          if (s.accuracy !== undefined) row[`${j.name}__acc`] = s.accuracy;
        }
      }
      return row;
    });
  }, [compared]);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Train jobs"
        description="Kubeflow Trainer v2 TrainJobs running in the current namespace."
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setOpen(true); }}>
            New train job
          </Button>
        }
      />
      <Tabs
        defaultActiveKey="jobs"
        items={[
          {
            key: 'jobs',
            label: 'Jobs',
            children: (
              <Table
                rowKey="id"
                size="middle"
                dataSource={data}
                columns={[
                  { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
                  { title: 'Runtime', dataIndex: 'runtime' },
                  { title: 'Nodes', dataIndex: 'numNodes' },
                  {
                    title: 'Resources',
                    render: (_, r) => {
                      const gpu = r.gpuValues
                        ? Object.entries(r.gpuValues)
                            .map(([k, v]) => `${k.split('/').pop()}=${v}`)
                            .join(' ')
                        : '—';
                      return `${r.cpu} CPU · ${r.memory} · ${gpu}`;
                    },
                  },
                  { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
                  {
                    title: 'Progress',
                    render: (_, r) => (
                      <Progress
                        percent={r.progress}
                        size="small"
                        status={r.status === 'Failed' ? 'exception' : r.status === 'Succeeded' ? 'success' : 'active'}
                      />
                    ),
                  },
                  { title: 'Duration', dataIndex: 'duration' },
                  {
                    title: 'MLflow',
                    render: (_, r) =>
                      r.mlflow ? (
                        <Tag icon={<LineChartOutlined />} color="blue">
                          {r.mlflow.runId}
                        </Tag>
                      ) : (
                        <span className="knaic-sub">—</span>
                      ),
                  },
                  {
                    title: 'Actions',
                    width: 220,
                    render: (_, r) => (
                      <Space>
                        <Button
                          size="small"
                          icon={<FileTextOutlined />}
                          onClick={() => {
                            const pod = podFor(r);
                            if (apiEnabled && !pod) {
                              message.warning('No pod found for this TrainJob');
                              return;
                            }
                            setLog({ job: r, pod });
                          }}
                        >
                          Logs
                        </Button>
                        {r.status === 'Running' && (
                          <AntTooltip title={apiEnabled ? 'Cancel is not exposed by the backend API yet' : ''}>
                            <Button
                              size="small"
                              icon={<StopOutlined />}
                              disabled={apiEnabled}
                              onClick={() => {
                                trainJobsStore.set(prev => prev.map(x => (x.id === r.id ? { ...x, status: 'Failed' } : x)));
                                message.warning('Train job canceled');
                              }}
                            >
                              Cancel
                            </Button>
                          </AntTooltip>
                        )}
                        <Button
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() =>
                            modal.confirm({
                              title: `Delete job ${r.name}?`,
                              onOk: async () => {
                                try {
                                  await deleteTrainJob(namespace, r);
                                  message.success('Deleted');
                                } catch (err) {
                                  message.error(err instanceof Error ? err.message : 'Failed to delete TrainJob');
                                  throw err;
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
            ),
          },
          {
            key: 'mlflow',
            label: `MLflow tracing${tracedJobs.length ? ` · ${tracedJobs.length}` : ''}`,
            children: tracedJobs.length === 0 ? (
              <Empty description="No TrainJobs in this namespace are reporting to MLflow." />
            ) : (
              <>
                <Card size="small" style={{ marginBottom: 12 }}>
                  <Space wrap>
                    <span className="knaic-sub">Compare runs:</span>
                    <Select
                      mode="multiple"
                      value={compareIds}
                      onChange={setCompareIds}
                      style={{ minWidth: 360 }}
                      maxTagCount="responsive"
                      options={tracedJobs.map(j => ({
                        label: `${j.name} · ${j.mlflow!.runId}`,
                        value: j.id,
                      }))}
                    />
                    <Tag color="blue">experiment: {tracedJobs[0].mlflow!.experiment}</Tag>
                    <span className="knaic-sub mono">{tracedJobs[0].mlflow!.trackingUri}</span>
                  </Space>
                </Card>
                <Row gutter={[12, 12]}>
                  <Col span={12}>
                    <Card title="Loss" size="small">
                      <div style={{ height: 260 }}>
                        <ResponsiveContainer>
                          <LineChart data={compareData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                            <XAxis dataKey="step" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} />
                            <Tooltip />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                            {compared.map((j, i) => (
                              <Line
                                key={j.id}
                                type="monotone"
                                dataKey={`${j.name}__loss`}
                                name={j.name}
                                stroke={RUN_COLORS[i % RUN_COLORS.length]}
                                dot={false}
                                strokeWidth={2}
                              />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Card title="Accuracy" size="small">
                      <div style={{ height: 260 }}>
                        <ResponsiveContainer>
                          <LineChart data={compareData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                            <XAxis dataKey="step" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} domain={[0, 1]} />
                            <Tooltip />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                            {compared.map((j, i) => (
                              <Line
                                key={j.id}
                                type="monotone"
                                dataKey={`${j.name}__acc`}
                                name={j.name}
                                stroke={RUN_COLORS[i % RUN_COLORS.length]}
                                dot={false}
                                strokeWidth={2}
                              />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  </Col>
                </Row>
                <Card title="Runs" size="small" style={{ marginTop: 12 }}>
                  <Table
                    rowKey="id"
                    size="small"
                    pagination={false}
                    dataSource={tracedJobs}
                    columns={[
                      { title: 'Job', dataIndex: 'name', render: v => <b>{v}</b> },
                      { title: 'Run ID', render: (_, r) => <span className="mono">{r.mlflow!.runId}</span> },
                      { title: 'Experiment', render: (_, r) => r.mlflow!.experiment },
                      {
                        title: 'Final loss',
                        render: (_, r) => {
                          const s = r.mlflow!.samples;
                          return s[s.length - 1]?.loss.toFixed(3) ?? '—';
                        },
                      },
                      {
                        title: 'Final accuracy',
                        render: (_, r) => {
                          const s = r.mlflow!.samples;
                          const a = s[s.length - 1]?.accuracy;
                          return a !== undefined ? a.toFixed(3) : '—';
                        },
                      },
                      { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
                    ]}
                  />
                </Card>
              </>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title="New train job"
        width={760}
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          const profile = profiles.find(p => p.id === v.gpuProfileId);
          const gpuValues = profile && v.gpuValues ? v.gpuValues : undefined;
          try {
            await createTrainJob(namespace, {
              name: v.name,
              runtime: v.runtime,
              numNodes: v.numNodes,
              command: v.command.trim().split(/\s+/).filter(Boolean),
              args: v.args ? v.args.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
              env: v.env,
              modelUri: v.modelUri,
              datasetUri: v.datasetUri,
              cpuRequest: v.cpuRequest,
              cpuLimit: v.cpuLimit,
              memoryRequest: v.memoryRequest,
              memoryLimit: v.memoryLimit,
              gpuValues,
            });
            setOpen(false);
            form.resetFields();
            message.success('TrainJob submitted');
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to submit TrainJob');
          }
        }}
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            numNodes: 1,
            cpuRequest: '16',
            cpuLimit: '16',
            memoryRequest: '128Gi',
            memoryLimit: '128Gi',
            command: 'python sft.py',
          }}
        >
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item name="name" label="Job name" rules={[{ required: true, pattern: /^[a-z0-9-]+$/ }]}>
                <Input placeholder="qwen-helpdesk-sft-02" />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="numNodes" label="Nodes" rules={[{ required: true }]}>
                <InputNumber min={1} max={64} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="runtime" label="TrainingRuntime" rules={[{ required: true }]}>
            <Select options={runtimeOpts} placeholder="Pick a TrainingRuntime" />
          </Form.Item>
          <Form.Item name="modelUri" label="Base model">
            <Select allowClear showSearch options={modelOpts} placeholder="Pick a model from the hub (optional)" />
          </Form.Item>
          <Form.Item name="datasetUri" label="Dataset URI">
            <Input placeholder="s3://knaic-data/team-ml/your-dataset.jsonl" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="cpuRequest" label="CPU request" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="cpuLimit"
                label="CPU limit"
                tooltip="Defaults to the request; editable."
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="memoryRequest" label="Memory request" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="memoryLimit"
                label="Memory limit"
                tooltip="Defaults to the request; editable."
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <GPUProfileFields />
          <Form.Item name="command" label="Command" rules={[{ required: true }]}>
            <Input placeholder="python sft.py" />
          </Form.Item>
          <Collapse
            size="small"
            ghost
            items={[
              {
                key: 'advanced',
                label: 'Advanced · args, env',
                children: (
                  <>
                    <Form.Item name="args" label="Args (one per line)">
                      <Input.TextArea rows={3} placeholder="--epochs&#10;3&#10;--lr&#10;2e-5" />
                    </Form.Item>
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
                                  <Input placeholder="value" style={{ width: 240 }} />
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
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Modal>
      <LogViewer
        open={!!log}
        onClose={() => setLog(null)}
        title={`Logs · ${log?.job.name ?? ''}`}
        containers={log?.pod?.containers ?? ['trainer', 'launcher']}
        podRef={log?.pod ? { namespace: log.pod.namespace, name: log.pod.name } : undefined}
      />
    </div>
  );
}
