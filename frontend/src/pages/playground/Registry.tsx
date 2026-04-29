import { useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App, Modal, Form, Input } from 'antd';
import { PlusOutlined, DeleteOutlined, SyncOutlined, LinkOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { providersStore, useProviders, type LLMProvider } from '@/data/playground';
import { useInferenceServices } from '@/data/inference';
import { uid } from '@/data/store';
import { useApp } from '@/context/AppContext';

export function LLMRegistry() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const providers = useProviders();
  const services = useInferenceServices();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const inScope = useMemo(
    () =>
      providers.filter(p => p.source === 'external' || p.namespace === namespace || p.source === 'cluster'),
    [providers, namespace],
  );

  function discover() {
    const fresh = services
      .filter(s => s.kind === 'LLMInferenceService')
      .map<LLMProvider>(s => ({
        id: `discovered-${s.id}`,
        name: `${s.name} (cluster)`,
        source: 'cluster',
        namespace: s.namespace,
        endpoint: s.endpoint,
        model: s.modelUri.replace(/^hf:\/\//, ''),
        description: `Auto-discovered from LLMInferenceService ${s.name}`,
        status: s.status,
      }));
    providersStore.set(prev => {
      const external = prev.filter(p => p.source === 'external');
      return [...fresh, ...external];
    });
    message.success(`Re-synced ${fresh.length} in-cluster LLM services`);
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="LLM service registry"
        description="LLMs that the playground and agent can call. Cluster-sourced entries mirror LLMInferenceServices; external entries let you plug in OpenAI / Anthropic / etc."
        extra={
          <Space>
            <Button icon={<SyncOutlined />} onClick={discover}>
              Re-sync cluster services
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              Add external provider
            </Button>
          </Space>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={inScope}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          {
            title: 'Source',
            dataIndex: 'source',
            render: v => <Tag color={v === 'cluster' ? 'blue' : 'geekblue'}>{v}</Tag>,
          },
          { title: 'Model', dataIndex: 'model', render: v => <span className="mono">{v}</span> },
          { title: 'Endpoint', dataIndex: 'endpoint', render: v => <span className="mono">{v}</span> },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          { title: 'Description', dataIndex: 'description' },
          {
            title: 'Actions',
            width: 160,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<LinkOutlined />}>Test</Button>
                {r.source === 'external' && (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      modal.confirm({
                        title: `Delete provider ${r.name}?`,
                        onOk: () => {
                          providersStore.set(prev => prev.filter(p => p.id !== r.id));
                          message.success('Provider removed');
                        },
                      })
                    }
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        title="Add external LLM provider"
        onCancel={() => setOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          providersStore.set(prev => [
            {
              id: uid('llm'),
              name: v.name,
              source: 'external',
              endpoint: v.endpoint,
              apiKey: v.apiKey,
              model: v.model,
              description: v.description,
              status: 'Ready',
            },
            ...prev,
          ]);
          setOpen(false);
          form.resetFields();
          message.success('Provider added');
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="openai-gpt-4o" />
          </Form.Item>
          <Form.Item name="endpoint" label="OpenAI-compatible endpoint" rules={[{ required: true }]}>
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key">
            <Input.Password placeholder="sk-…" />
          </Form.Item>
          <Form.Item name="model" label="Model id" rules={[{ required: true }]}>
            <Input placeholder="gpt-4o" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
