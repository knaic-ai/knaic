import { useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Table, Space, Button, App, Tag } from 'antd';
import { CodeOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { YamlViewer } from '@/components/YamlViewer';
import { YamlEditor } from '@/components/YamlEditor';
import {
  buildGatewayYaml,
  buildHTTPRouteYaml,
  createClusterResource,
  deleteClusterResource,
  ensureGatewaysLoaded,
  fetchClusterResourceYaml,
  gatewayTemplate,
  httpRouteTemplate,
  useGateways,
  useHTTPRoutes,
  type Gateway,
  type HTTPRoute,
} from '@/data/clusterResources';
import { useApp } from '@/context/AppContext';

// createKind picks which template + slug + label the YAML editor uses. Both
// Gateway and HTTPRoute live on the same page, so a single editor with a
// `kind` discriminator keeps the JSX flat.
type CreateKind = 'gateways' | 'httproutes';

export function Gateways() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const gws = useGateways();
  const routes = useHTTPRoutes();
  const gwData = useMemo(() => gws.filter(g => g.namespace === namespace), [gws, namespace]);
  const routeData = useMemo(() => routes.filter(r => r.namespace === namespace), [routes, namespace]);
  const [yaml, setYaml] = useState<{ title: string; body: string } | null>(null);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [createYaml, setCreateYaml] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    ensureGatewaysLoaded(namespace);
  }, [namespace]);

  async function showYaml(slug: 'gateways' | 'httproutes', name: string, fallback: string, title: string) {
    try {
      const body = await fetchClusterResourceYaml(slug, namespace, name, fallback);
      setYaml({ title, body });
    } catch (err) {
      setYaml({ title, body: fallback });
      message.error(err instanceof Error ? err.message : 'Failed to fetch YAML');
    }
  }

  function openCreate(kind: CreateKind) {
    setCreateKind(kind);
    setCreateYaml(kind === 'gateways' ? gatewayTemplate(namespace) : httpRouteTemplate(namespace));
  }

  async function submitCreate() {
    if (!createKind) return;
    setCreating(true);
    try {
      await createClusterResource(createKind, namespace, createYaml);
      message.success(createKind === 'gateways' ? 'Gateway created' : 'HTTPRoute created');
      setCreateKind(null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create resource');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="Gateway API"
        description="Gateway + HTTPRoute resources — Kubernetes Gateway API v1. Configured by namespace editors and admins."
      />
      <Row gutter={12}>
        <Col span={24}>
          <Card
            title="Gateways"
            size="small"
            style={{ marginBottom: 12 }}
            extra={
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate('gateways')}>
                New Gateway
              </Button>
            }
          >
            <Table<Gateway>
              rowKey="id"
              size="small"
              dataSource={gwData}
              pagination={false}
              columns={[
                { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
                { title: 'GatewayClass', dataIndex: 'gatewayClassName', render: v => <Tag>{v}</Tag> },
                {
                  title: 'Listeners',
                  render: (_, r) => (
                    <Space wrap size={4}>
                      {r.listeners.map(l => (
                        <Tag key={l.name} color={l.protocol === 'HTTPS' ? 'geekblue' : 'blue'}>
                          {l.protocol}:{l.port}{l.hostname ? ` · ${l.hostname}` : ''}
                        </Tag>
                      ))}
                    </Space>
                  ),
                },
                { title: 'Address', render: (_, r) => <span className="mono">{r.addresses.join(', ')}</span> },
                { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v === 'Accepted' ? 'Ready' : v} /> },
                {
                  title: 'Actions',
                  width: 140,
                  render: (_, r) => (
                    <Space>
                      <Button
                        size="small"
                        icon={<CodeOutlined />}
                        onClick={() => void showYaml('gateways', r.name, buildGatewayYaml(r), `Gateway · ${r.name}`)}
                      >
                        YAML
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() =>
                          modal.confirm({
                            title: `Delete Gateway ${r.name}?`,
                            onOk: async () => {
                              try {
                                await deleteClusterResource('gateways', r.namespace, r.name);
                                message.success('Deleted');
                              } catch (err) {
                                message.error(err instanceof Error ? err.message : 'Failed to delete Gateway');
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
          </Card>
          <Card
            title="HTTP Routes"
            size="small"
            extra={
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate('httproutes')}>
                New HTTPRoute
              </Button>
            }
          >
            <Table<HTTPRoute>
              rowKey="id"
              size="small"
              dataSource={routeData}
              pagination={false}
              columns={[
                { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
                { title: 'Parent gateway', dataIndex: 'parentGateway', render: v => <Tag>{v}</Tag> },
                {
                  title: 'Hostnames',
                  render: (_, r) => <Space wrap size={4}>{r.hostnames.map(h => <Tag key={h}>{h}</Tag>)}</Space>,
                },
                {
                  title: 'Rules',
                  render: (_, r) => (
                    <Space direction="vertical" size={2}>
                      {r.rules.map((rule, i) => (
                        <span key={i} className="mono knaic-sub">
                          {rule.pathPrefix} → {rule.backendService}:{rule.port}
                        </span>
                      ))}
                    </Space>
                  ),
                },
                {
                  title: 'Actions',
                  width: 140,
                  render: (_, r) => (
                    <Space>
                      <Button
                        size="small"
                        icon={<CodeOutlined />}
                        onClick={() => void showYaml('httproutes', r.name, buildHTTPRouteYaml(r), `HTTPRoute · ${r.name}`)}
                      >
                        YAML
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() =>
                          modal.confirm({
                            title: `Delete HTTPRoute ${r.name}?`,
                            onOk: async () => {
                              try {
                                await deleteClusterResource('httproutes', r.namespace, r.name);
                                message.success('Deleted');
                              } catch (err) {
                                message.error(err instanceof Error ? err.message : 'Failed to delete HTTPRoute');
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
          </Card>
        </Col>
      </Row>
      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={yaml?.title ?? ''}
        yaml={yaml?.body ?? ''}
      />
      <YamlEditor
        open={!!createKind}
        title={createKind === 'gateways' ? `New Gateway in ${namespace}` : `New HTTPRoute in ${namespace}`}
        value={createYaml}
        saving={creating}
        onChange={setCreateYaml}
        onSave={() => void submitCreate()}
        onClose={() => setCreateKind(null)}
      />
    </div>
  );
}
