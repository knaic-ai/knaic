import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Result,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudServerOutlined,
  CopyOutlined,
  ExclamationCircleOutlined,
  GlobalOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  ensureInferenceServicesLoaded,
  useInferenceServices,
} from '@/data/inference';
import {
  createAIGatewayRoute,
  fetchGatewayConfig,
  fetchServiceRouteStatus,
  type CreateAIGatewayRouteRequest,
  type CreatedResourceDTO,
  type GatewayConfigDTO,
  type ServiceRouteStatusDTO,
} from '@/api/inference';

const { Text, Paragraph } = Typography;

// Per-row aggregated route + rate-limit summary; built by fetching
// /route-status for every InferenceService in the current namespace.
interface ServiceRow {
  name: string;
  namespace: string;
  kind: string;
  modelUri: string;
  routeCount: number;
  rateLimitCount: number;
  hostnames: string[];
}

// Inference · Gateway page. The single place to:
//
//   1. See KServe's gateway-related config (ingress.enableGatewayApi,
//      deploy.defaultDeploymentMode, kserve-ingress-gateway status).
//   2. Know whether the Envoy AI Gateway CRDs are installed.
//   3. Per-InferenceService: provision an AIGatewayRoute (+ optional
//      BackendTrafficPolicy rate limit). The form pops up the exact list of
//      CRs that will be created and prints them back when the call returns.
//
// Designed to degrade independently — if discovery says the AI Gateway is
// missing, the per-service action explains why and links to the install
// docs rather than silently failing.
export function GatewayConfigPage() {
  const { namespace } = useApp();
  const { message } = App.useApp();
  const allServices = useInferenceServices();

  const [config, setConfig] = useState<GatewayConfigDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [rowLoading, setRowLoading] = useState(false);
  const [creating, setCreating] = useState<ServiceRow | null>(null);

  const services = useMemo(
    () => allServices.filter(s => s.namespace === namespace),
    [allServices, namespace],
  );

  const reload = () => {
    setLoading(true);
    fetchGatewayConfig()
      .then(setConfig)
      .catch(e => {
        message.error((e as Error).message);
        setConfig(null);
      })
      .finally(() => setLoading(false));
  };

  const reloadRows = async () => {
    setRowLoading(true);
    try {
      const out: ServiceRow[] = [];
      // Sequential — the API runs cluster-wide list calls for each, and we
      // want to avoid a burst when a namespace has dozens of services.
      for (const svc of services) {
        try {
          const rs = await fetchServiceRouteStatus(svc.namespace, svc.name);
          const hostnames = Array.from(
            new Set(rs.routes.flatMap(r => r.hostnames ?? [])),
          );
          out.push({
            name: svc.name,
            namespace: svc.namespace,
            kind: svc.kind,
            modelUri: svc.modelUri,
            routeCount: rs.routes.length,
            rateLimitCount: rs.rateLimits.length,
            hostnames,
          });
        } catch {
          out.push({
            name: svc.name,
            namespace: svc.namespace,
            kind: svc.kind,
            modelUri: svc.modelUri,
            routeCount: 0,
            rateLimitCount: 0,
            hostnames: [],
          });
        }
      }
      setRows(out);
    } finally {
      setRowLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    ensureInferenceServicesLoaded(namespace);
  }, [namespace]);

  useEffect(() => {
    void reloadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services.length, namespace]);

  return (
    <div className="knaic-page">
      <PageHeader
        title="Inference · Gateway"
        description="KServe gateway configuration, Envoy AI Gateway resources, and per-InferenceService route / rate-limit management."
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={reload}>
              Refresh
            </Button>
          </Space>
        }
      />

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <SafetyCertificateOutlined /> KServe config
              </Space>
            }
          >
            {loading ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : !config ? (
              <Empty description="Cluster config unavailable" />
            ) : (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="Gateway API ingress">
                  {config.ingressGatewayApiEnabled ? (
                    <Tag icon={<CheckCircleOutlined />} color="green">
                      enabled
                    </Tag>
                  ) : (
                    <Tag icon={<CloseCircleOutlined />} color="red">
                      disabled
                    </Tag>
                  )}
                  <Text type="secondary"> (ingress.enableGatewayApi)</Text>
                </Descriptions.Item>
                <Descriptions.Item label="Default deployment mode">
                  {config.defaultDeploymentMode ? (
                    <Tag color="cyan">{config.defaultDeploymentMode}</Tag>
                  ) : (
                    <Text type="secondary">—</Text>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="Ingress domain">
                  {config.ingressDomain ? (
                    <Text code>{config.ingressDomain}</Text>
                  ) : (
                    <Text type="secondary">—</Text>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="URL scheme">
                  {config.urlScheme ? (
                    <Text code>{config.urlScheme}</Text>
                  ) : (
                    <Text type="secondary">—</Text>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="Istio VirtualHost">
                  {config.disableIstioVirtualHost ? (
                    <Tag>disabled</Tag>
                  ) : (
                    <Tag color="default">legacy enabled</Tag>
                  )}
                </Descriptions.Item>
              </Descriptions>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <GlobalOutlined /> kserve-ingress-gateway
              </Space>
            }
          >
            {loading ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : !config?.gateway ? (
              <Alert
                type="warning"
                showIcon
                icon={<ExclamationCircleOutlined />}
                message="kserve-ingress-gateway not found"
                description={
                  config?.ingressGatewayApiEnabled
                    ? 'KServe is configured for Gateway API but the default Gateway resource is missing. Apply the Gateway CR from KServe docs.'
                    : 'Gateway API ingress is disabled in KServe config — the default Gateway is not provisioned.'
                }
              />
            ) : (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="Namespace / Name">
                  <Text code>{`${config.gateway.namespace}/${config.gateway.name}`}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="GatewayClass">
                  {config.gateway.gatewayClassName ? (
                    <Tag color="blue">{config.gateway.gatewayClassName}</Tag>
                  ) : (
                    '—'
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="Status">
                  <Tag
                    color={
                      config.gateway.status === 'Accepted'
                        ? 'green'
                        : config.gateway.status === 'Failed'
                          ? 'red'
                          : 'gold'
                    }
                  >
                    {config.gateway.status}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Listeners">
                  <Space wrap>
                    {(config.gateway.listeners ?? []).map(l => (
                      <Tag key={l}>{l}</Tag>
                    ))}
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="Addresses">
                  <Space direction="vertical">
                    {(config.gateway.addresses ?? []).map(a => (
                      <Space key={a}>
                        <Text code>{a}</Text>
                        <Tooltip title="Copy">
                          <Button
                            size="small"
                            type="text"
                            icon={<CopyOutlined />}
                            onClick={() => {
                              navigator.clipboard.writeText(a).then(
                                () => message.success('Copied'),
                                () => message.error('Copy failed'),
                              );
                            }}
                          />
                        </Tooltip>
                      </Space>
                    ))}
                    {!config.gateway.addresses?.length && (
                      <Text type="secondary">
                        No external addresses programmed yet.
                      </Text>
                    )}
                  </Space>
                </Descriptions.Item>
              </Descriptions>
            )}
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={
          <Space>
            <ThunderboltOutlined /> Envoy AI Gateway
          </Space>
        }
        style={{ marginBottom: 12 }}
        extra={
          config && (
            <Tag color={config.envoyAiGatewayInstalled ? 'green' : 'default'}>
              {config.envoyAiGatewayInstalled ? 'installed' : 'not installed'}
            </Tag>
          )
        }
      >
        {!config?.envoyAiGatewayInstalled ? (
          <Alert
            type="info"
            showIcon
            message="aigateway.envoyproxy.io CRDs not detected"
            description={
              <>
                The Envoy AI Gateway provides AIGatewayRoute and AIServiceBackend
                CRDs that wire an InferenceService into an LLM-aware gateway with
                token-based rate limits and OpenAI-style routing. Install it on
                the cluster to enable per-service route creation below.
              </>
            }
          />
        ) : (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Create an <Text code>AIGatewayRoute</Text> + <Text code>AIServiceBackend</Text>
            {' '}for any InferenceService below. An optional{' '}
            <Text code>BackendTrafficPolicy</Text> attaches a token-counting global
            rate limit. The route is wired to{' '}
            <Text code>{config?.gateway?.name ?? 'kserve-ingress-gateway'}</Text>.
          </Paragraph>
        )}
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <ApiOutlined /> Inference services · routes &amp; rate limits
          </Space>
        }
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void reloadRows()}
            loading={rowLoading}
          >
            Refresh
          </Button>
        }
      >
        <Table<ServiceRow>
          rowKey={r => `${r.namespace}/${r.name}`}
          size="small"
          loading={rowLoading}
          dataSource={rows}
          locale={{
            emptyText: (
              <Empty
                description={`No InferenceService in namespace "${namespace}".`}
              />
            ),
          }}
          columns={[
            { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
            {
              title: 'Kind',
              dataIndex: 'kind',
              render: v => (
                <Tag color={v === 'LLMInferenceService' ? 'blue' : 'purple'}>
                  {v}
                </Tag>
              ),
            },
            {
              title: 'Model URI',
              dataIndex: 'modelUri',
              ellipsis: true,
              render: v => (
                <Text code style={{ fontSize: 12 }}>
                  {v}
                </Text>
              ),
            },
            {
              title: 'Routes',
              dataIndex: 'routeCount',
              width: 100,
              render: v =>
                v > 0 ? (
                  <Tag color="green">{v}</Tag>
                ) : (
                  <Tag>0</Tag>
                ),
            },
            {
              title: 'Rate limits',
              dataIndex: 'rateLimitCount',
              width: 110,
              render: v =>
                v > 0 ? (
                  <Tag color="orange">{v}</Tag>
                ) : (
                  <Tag>0</Tag>
                ),
            },
            {
              title: 'Hostnames',
              dataIndex: 'hostnames',
              render: (v: string[]) =>
                v.length === 0 ? (
                  <Text type="secondary">—</Text>
                ) : (
                  <Space wrap size={4}>
                    {v.map(h => (
                      <Tag key={h}>{h}</Tag>
                    ))}
                  </Space>
                ),
            },
            {
              title: 'Action',
              width: 200,
              render: (_, r) => (
                <Space>
                  <Button
                    size="small"
                    type={r.routeCount > 0 ? 'default' : 'primary'}
                    icon={<PlusOutlined />}
                    disabled={!config?.envoyAiGatewayInstalled}
                    onClick={() => setCreating(r)}
                  >
                    {r.routeCount > 0 ? 'Update route' : 'Create route'}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <CreateRouteModal
        target={creating}
        config={config}
        onClose={() => setCreating(null)}
        onCreated={() => {
          setCreating(null);
          void reloadRows();
        }}
      />
    </div>
  );
}

interface CreateRouteModalProps {
  target: ServiceRow | null;
  config: GatewayConfigDTO | null;
  onClose: () => void;
  onCreated: () => void;
}

// CreateRouteModal builds a CreateAIGatewayRouteRequest and POSTs it.
// Returns the list of CRs the backend created in a follow-up Result modal so
// the user knows exactly what was applied.
function CreateRouteModal({ target, config, onClose, onCreated }: CreateRouteModalProps) {
  const [form] = Form.useForm();
  const { message, modal } = App.useApp();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target) {
      const suggestedHost =
        config?.ingressDomain && config.urlScheme
          ? `${target.name}-${target.namespace}.${config.ingressDomain}`
          : '';
      form.setFieldsValue({
        gatewayNamespace: config?.gateway?.namespace ?? 'kserve',
        gatewayName: config?.gateway?.name ?? 'kserve-ingress-gateway',
        modelHeader: target.name,
        servicePort: 80,
        hostnames: suggestedHost,
        withRateLimit: false,
        rateRequests: 1000,
        rateUnit: 'Hour',
        rateClient: 'x-user-id',
        rateCountTokens: true,
      });
    }
  }, [target, config, form]);

  const handleSubmit = async () => {
    if (!target) return;
    const values = await form.validateFields();
    const req: CreateAIGatewayRouteRequest = {
      gatewayNamespace: values.gatewayNamespace,
      gatewayName: values.gatewayName,
      modelHeader: values.modelHeader,
      servicePort: values.servicePort || 80,
      hostnames: values.hostnames
        ? String(values.hostnames)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : [],
    };
    if (values.withRateLimit) {
      req.rateLimit = {
        requests: values.rateRequests,
        unit: values.rateUnit,
        clientHeader: values.rateClient,
        countTokens: !!values.rateCountTokens,
      };
    }
    setSubmitting(true);
    try {
      const res = await createAIGatewayRoute(target.namespace, target.name, req);
      message.success('Gateway route applied');
      showCreatedResult(modal, res.created);
      onCreated();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title={
        target ? (
          <Space>
            <CloudServerOutlined />
            <span>Create gateway route for {target.name}</span>
          </Space>
        ) : (
          ''
        )
      }
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okText="Apply"
      destroyOnClose
      width={620}
    >
      {target && (
        <Form form={form} layout="vertical" preserve={false}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Resources that will be created or updated"
            description={
              <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
                <li>
                  <Text code>AIServiceBackend</Text> · {target.namespace}/{target.name}-aibackend
                </li>
                <li>
                  <Text code>AIGatewayRoute</Text> · {target.namespace}/{target.name}-route
                </li>
                <li>
                  <Text code>BackendTrafficPolicy</Text> · {target.namespace}/{target.name}-ratelimit (when rate limit is on)
                </li>
              </ul>
            }
          />
          <Form.Item label="Attach to Gateway" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="gatewayNamespace" noStyle rules={[{ required: true }]}>
                <Input placeholder="kserve" style={{ width: '40%' }} />
              </Form.Item>
              <Form.Item name="gatewayName" noStyle rules={[{ required: true }]}>
                <Input placeholder="kserve-ingress-gateway" style={{ width: '60%' }} />
              </Form.Item>
            </Space.Compact>
          </Form.Item>
          <Form.Item
            label="Model header value (x-ai-eg-model)"
            name="modelHeader"
            rules={[{ required: true }]}
            tooltip="Routes are matched by an exact x-ai-eg-model header. Defaults to the InferenceService name."
          >
            <Input />
          </Form.Item>
          <Form.Item
            label="Service port"
            name="servicePort"
            tooltip="Port on the InferenceService's predictor Service. 80 for Standard, 8080 for RawDeployment."
          >
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="Hostnames"
            name="hostnames"
            tooltip="Comma-separated. Leave blank to inherit from the gateway listener."
          >
            <Input placeholder="e.g. qwen.team-ml.example.com" />
          </Form.Item>
          <Form.Item
            label="Rate limit"
            name="withRateLimit"
            valuePropName="checked"
            tooltip="Adds a BackendTrafficPolicy with a Global rate limit clientSelector."
          >
            <Switch />
          </Form.Item>
          <Form.Item dependencies={['withRateLimit']} noStyle>
            {({ getFieldValue }) =>
              getFieldValue('withRateLimit') ? (
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="rateRequests" noStyle rules={[{ required: true }]}>
                    <InputNumber min={1} placeholder="1000" style={{ width: '25%' }} />
                  </Form.Item>
                  <Form.Item name="rateUnit" noStyle>
                    <Select
                      style={{ width: '25%' }}
                      options={[
                        { label: 'per second', value: 'Second' },
                        { label: 'per minute', value: 'Minute' },
                        { label: 'per hour', value: 'Hour' },
                        { label: 'per day', value: 'Day' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="rateClient" noStyle>
                    <Input placeholder="client header (x-user-id)" style={{ width: '50%' }} />
                  </Form.Item>
                </Space.Compact>
              ) : null
            }
          </Form.Item>
          <Form.Item
            dependencies={['withRateLimit']}
            name="rateCountTokens"
            valuePropName="checked"
            tooltip="When on, the limit counts LLM tokens (llm_total_token metadata) instead of just requests. Request cost is fixed at 0 per Envoy AI Gateway docs."
          >
            <Form.Item shouldUpdate noStyle>
              {({ getFieldValue }) =>
                getFieldValue('withRateLimit') ? (
                  <Switch checkedChildren="count tokens" unCheckedChildren="count requests" />
                ) : null
              }
            </Form.Item>
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

function showCreatedResult(
  modal: ReturnType<typeof App.useApp>['modal'],
  created: CreatedResourceDTO[],
) {
  modal.success({
    title: 'Resources applied',
    width: 560,
    content: (
      <div>
        <Paragraph>
          The following Kubernetes resources were created or updated:
        </Paragraph>
        <ul style={{ paddingLeft: 16 }}>
          {created.map(c => (
            <li key={`${c.kind}/${c.namespace}/${c.name}`}>
              <Text code>{c.apiVersion}</Text> · <b>{c.kind}</b>{' '}
              <Text type="secondary">
                ({c.namespace}/{c.name})
              </Text>
            </li>
          ))}
        </ul>
      </div>
    ),
  });
}
