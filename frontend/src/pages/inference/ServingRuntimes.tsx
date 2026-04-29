import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App, Modal, Form, Input, InputNumber, Select } from 'antd';
import { PlusOutlined, DeleteOutlined, CodeOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import {
  useRuntimes,
  ensureRuntimesLoaded,
  reloadRuntimes,
  createServingRuntime,
  deleteServingRuntime,
  fetchServingRuntimeYaml,
  buildServingRuntimeYaml,
  type ServingRuntime,
} from '@/data/inference';
import { useApp } from '@/context/AppContext';
import { YamlViewer } from '@/components/YamlViewer';

export function ServingRuntimesPage() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useRuntimes();
  const data = useMemo(() => all.filter(r => r.namespace === namespace || r.builtin), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState<{ sr: ServingRuntime; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    ensureRuntimesLoaded(namespace);
  }, [namespace]);

  const openYaml = async (sr: ServingRuntime) => {
    setYamlLoading(sr.name);
    try {
      const text = sr.builtin
        ? buildServingRuntimeYaml(sr)
        : await fetchServingRuntimeYaml(namespace, sr.name);
      setYaml({ sr, text: text || buildServingRuntimeYaml(sr) });
    } catch (e) {
      setYaml({ sr, text: buildServingRuntimeYaml(sr) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="Serving runtimes"
        description="KServe ServingRuntimes configurable via UI. Built-in runtimes (vllm, sglang) are bundled by knaic and cloned into each namespace on demand."
        extra={
          <Space>
            <Button onClick={() => reloadRuntimes(namespace)}>Refresh</Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setOpen(true);
              }}
            >
              New runtime
            </Button>
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          {
            title: 'Name',
            render: (_, r) => (
              <Space>
                <b>{r.name}</b>
                {r.builtin && <Tag color="gold">built-in</Tag>}
              </Space>
            ),
          },
          { title: 'Runtime', dataIndex: 'runtime', render: v => <Tag color="blue">{v}</Tag> },
          { title: 'Image', dataIndex: 'image', render: v => <span className="mono">{v}</span> },
          {
            title: 'Default resources',
            render: (_, r) => `${r.resources.cpu || '—'} CPU · ${r.resources.memory || '—'} · ${r.resources.gpu || 0} GPU`,
          },
          {
            title: 'Formats',
            dataIndex: 'supportedModelFormats',
            render: (v: string[]) => v?.map(f => <Tag key={f}>{f}</Tag>),
          },
          {
            title: 'Actions',
            width: 200,
            render: (_, r) => (
              <Space>
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
                  disabled={r.builtin}
                  onClick={() =>
                    modal.confirm({
                      title: `Delete runtime ${r.name}?`,
                      onOk: async () => {
                        try {
                          await deleteServingRuntime(namespace, r.name);
                          message.success('Runtime deleted');
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
        title="New serving runtime"
        width={640}
        onCancel={() => setOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        onOk={async () => {
          const v = await form.validateFields();
          setSubmitting(true);
          try {
            await createServingRuntime(namespace, {
              name: v.name,
              image: v.image,
              runtime: v.runtime,
              supportedModelFormats: v.supportedModelFormats,
              args: ((v.defaultArgs as string) ?? '').split('\n').map(s => s.trim()).filter(Boolean),
              cpuLimit: v.cpu,
              memoryLimit: v.memory,
              gpuLimit: v.gpu,
            });
            message.success('Runtime created');
            setOpen(false);
            form.resetFields();
          } catch (e) {
            message.error((e as Error).message);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="my-vllm" />
          </Form.Item>
          <Form.Item name="runtime" label="Runtime family" initialValue="vllm" rules={[{ required: true }]}>
            <Select options={['vllm', 'sglang', 'custom'].map(v => ({ label: v, value: v }))} />
          </Form.Item>
          <Form.Item name="image" label="Container image" rules={[{ required: true }]}>
            <Input placeholder="vllm/vllm-openai:v0.7.2" />
          </Form.Item>
          <Form.Item name="supportedModelFormats" label="Supported model formats" initialValue={['huggingface']}>
            <Select mode="tags" />
          </Form.Item>
          <Form.Item name="defaultArgs" label="Default args (one per line)">
            <Input.TextArea rows={4} placeholder="--max-model-len&#10;32768" />
          </Form.Item>
          <Space>
            <Form.Item name="cpu" label="CPU limit" initialValue="8"><Input style={{ width: 120 }} /></Form.Item>
            <Form.Item name="memory" label="Memory limit" initialValue="64Gi"><Input style={{ width: 140 }} /></Form.Item>
            <Form.Item name="gpu" label="GPU limit" initialValue={1}><InputNumber min={0} style={{ width: 100 }} /></Form.Item>
          </Space>
        </Form>
      </Modal>

      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`ServingRuntime · ${yaml?.sr.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
    </div>
  );
}
