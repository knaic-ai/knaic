import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App, Modal, Form, Input } from 'antd';
import { PlusOutlined, DeleteOutlined, SyncOutlined, LinkOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  addProvider,
  ensureProvidersLoaded,
  removeProvider,
  replaceClusterProviders,
  useProviders,
  type LLMProvider,
} from '@/data/playground';
import {
  ensureInferenceServicesLoaded,
  ensureRuntimesLoaded,
  isOpenAICompatibleService,
  openAIBaseURL,
  useInferenceServices,
  useRuntimes,
} from '@/data/inference';
import { useApp } from '@/context/AppContext';
import { apiEnabled } from '@/api/client';
import { streamChat } from '@/api/playground';

export function LLMRegistry() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const providers = useProviders();
  const services = useInferenceServices();
  const runtimes = useRuntimes();
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [form] = Form.useForm();

  const inScope = useMemo(
    () =>
      providers.filter(p => p.source === 'external' || p.namespace === namespace || p.source === 'cluster'),
    [providers, namespace],
  );

  useEffect(() => {
    ensureProvidersLoaded(namespace);
    ensureInferenceServicesLoaded(namespace);
    // Runtimes are needed to resolve InferenceService.runtime (a name) to a
    // family — see isOpenAICompatibleService for the lookup.
    ensureRuntimesLoaded(namespace);
  }, [namespace]);

  async function discover() {
    // Surface every InferenceService / LLMInferenceService whose serving
    // runtime exposes the OpenAI chat/completions API. KServe's status.url
    // typically omits /v1, so openAIBaseURL appends it for the proxy to
    // hit `${url}/chat/completions` correctly.
    //
    // Skip entries whose status hasn't populated the URL yet (Progressing
    // services have empty status.url) or where the model identifier can't
    // be derived — the backend rejects providers missing endpoint/model
    // with a 400, which would abort the whole batch and surface as an
    // opaque "name, endpoint and model are required" toast.
    const candidates = services.filter(s => isOpenAICompatibleService(s, runtimes));
    const skipped: string[] = [];
    const fresh: LLMProvider[] = [];
    for (const s of candidates) {
      const endpoint = openAIBaseURL(s.endpoint);
      // Default to the InferenceService name — that's what the vLLM /
      // SGLang ServingRuntime templates pass as `--served-model-name`,
      // and it's what the upstream advertises at /v1/models. modelUri
      // (e.g. "hf://Qwen/Qwen3.5-0.5B") is the storage location, not the
      // served-model-name; using it makes the upstream return 404. The
      // backend proxy still validates against /v1/models and substitutes
      // when this guess turns out wrong.
      const model = (s.modelName || s.name || '').trim();
      if (!endpoint || !model || !s.name) {
        skipped.push(s.name || s.id);
        continue;
      }
      fresh.push({
        id: `discovered-${s.id}`,
        name: `${s.name} (cluster)`,
        source: 'cluster',
        namespace: s.namespace,
        endpoint,
        model,
        description: `Auto-discovered from ${s.kind} ${s.name}`,
        status: s.status,
      });
    }
    try {
      await replaceClusterProviders(fresh.map(({ id: _id, ...p }) => p), namespace);
      const summary = skipped.length
        ? `Re-synced ${fresh.length} services; skipped ${skipped.length} with no endpoint/model yet (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''})`
        : `Re-synced ${fresh.length} in-cluster LLM services`;
      if (skipped.length) message.warning(summary);
      else message.success(summary);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to sync providers');
    }
  }

  async function testProvider(provider: LLMProvider) {
    if (provider.status !== 'Ready') {
      message.warning(`Provider ${provider.name} is ${provider.status}`);
      return;
    }
    if (!apiEnabled) {
      message.success('Provider is available in prototype mode');
      return;
    }
    setTesting(provider.id);
    try {
      let gotChunk = false;
      await streamChat(
        {
          providerId: provider.id,
          messages: [{ role: 'user', content: 'ping' }],
          temperature: 0,
          maxTokens: 8,
        },
        {
          onChunk: () => {
            gotChunk = true;
          },
          onDone: () => undefined,
        },
      );
      message.success(gotChunk ? 'Provider responded' : 'Provider stream completed');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Provider test failed');
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="LLM service registry"
        description="LLMs that the playground and agent can call. Cluster-sourced entries mirror any LLMInferenceService or InferenceService whose runtime (vLLM / SGLang / TGI / llama.cpp / LMDeploy) exposes the OpenAI chat/completions API. External entries let you plug in OpenAI / Anthropic / etc."
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
                <Button
                  size="small"
                  icon={<LinkOutlined />}
                  loading={testing === r.id}
                  onClick={() => void testProvider(r)}
                >
                  Test
                </Button>
                {r.source === 'external' && (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      modal.confirm({
                        title: `Delete provider ${r.name}?`,
                        onOk: async () => {
                          try {
                            await removeProvider(r.id);
                            message.success('Provider removed');
                          } catch (err) {
                            message.error(err instanceof Error ? err.message : 'Failed to remove provider');
                            throw err;
                          }
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
          try {
            await addProvider({
              name: v.name,
              source: 'external',
              endpoint: v.endpoint,
              apiKey: v.apiKey,
              model: v.model,
              description: v.description,
              status: 'Ready',
            });
            setOpen(false);
            form.resetFields();
            message.success('Provider added');
          } catch (err) {
            message.error(err instanceof Error ? err.message : 'Failed to add provider');
          }
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
