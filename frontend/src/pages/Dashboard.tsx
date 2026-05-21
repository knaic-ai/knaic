import { useEffect, useState } from 'react';
import { Row, Col, Card, Progress, Space, Tag, Button, Tooltip } from 'antd';
import {
  RocketOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  BookOutlined,
  ThunderboltOutlined,
  AlertOutlined,
  ArrowRightOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import { ensureModelsLoaded, useModels } from '@/data/models';
import { ensureInferenceServicesLoaded, useInferenceServices } from '@/data/inference';
import { ensureTrainJobsLoaded, useTrainJobs } from '@/data/training';
import { ensureNotebooksLoaded, useNotebooks } from '@/data/notebooks';
import { ensureInitialLoad as ensureComponentsLoaded, useComponents } from '@/data/components';
import { useApp } from '@/context/AppContext';
import { apiEnabled } from '@/api/client';
import { fetchGPUStatus, type GPUStatus } from '@/api/gpu';

// MetricCard is the small icon+label+value tile that runs across the top
// strip. Pulled out so the four tiles all share the same look without each
// page re-doing the Space layout inline.
function MetricCard({
  icon,
  color,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card className="metric-card">
      <Space align="start">
        <span style={{ color, fontSize: 22 }}>{icon}</span>
        <div>
          <div className="l">{label}</div>
          <div className="v">{value}</div>
          {hint && <div className="knaic-sub" style={{ fontSize: 11 }}>{hint}</div>}
        </div>
      </Space>
    </Card>
  );
}

export function Dashboard() {
  const { user, namespace, namespaces } = useApp();
  const models = useModels();
  const services = useInferenceServices();
  const jobs = useTrainJobs();
  const notebooks = useNotebooks();
  const components = useComponents();
  const [gpu, setGpu] = useState<GPUStatus | null>(null);

  // Trigger every loader the dashboard widgets read from. The hooks above
  // return whatever's in the store today (often an empty array on first
  // load); these calls warm the cache so the user lands on real numbers
  // once the requests resolve.
  useEffect(() => {
    if (!apiEnabled) return;
    ensureComponentsLoaded();
    ensureModelsLoaded('public');
    ensureModelsLoaded('private', namespace);
    ensureInferenceServicesLoaded(namespace);
    ensureTrainJobsLoaded(namespace);
    ensureNotebooksLoaded(namespace);
  }, [namespace]);

  // GPU status — cluster scope for admins (full inventory), namespace
  // scope for everyone else (just what their workspace consumes).
  useEffect(() => {
    if (!apiEnabled) {
      setGpu(null);
      return;
    }
    let cancelled = false;
    fetchGPUStatus(user.isPlatformAdmin ? 'cluster' : 'namespace', user.isPlatformAdmin ? undefined : namespace)
      .then(s => { if (!cancelled) setGpu(s); })
      .catch(() => { if (!cancelled) setGpu(null); });
    return () => { cancelled = true; };
  }, [namespace, user.isPlatformAdmin]);

  const nsServices = services.filter(s => s.namespace === namespace);
  const nsJobs = jobs.filter(j => j.namespace === namespace);
  const nsNotebooks = notebooks.filter(n => n.namespace === namespace);
  const notInstalled = components.filter(c => c.status !== 'Installed');
  const installPct = components.length > 0
    ? Math.round(((components.length - notInstalled.length) / components.length) * 100)
    : 0;

  // Recent activity sorts the newest TrainJob / InferenceService to the top
  // so users get a "what just happened" glance without opening the dedicated
  // page. TrainJob carries startTime (its CR doesn't expose creation
  // timestamp on the spec); InferenceService uses createdAt.
  const recentJobs = [...nsJobs]
    .sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))
    .slice(0, 4);
  const recentServices = [...nsServices]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 4);

  return (
    <div className="knaic-page">
      <PageHeader
        title={`Welcome, ${user.name || 'there'}`}
        description={`Current workspace: ${namespace}${user.isPlatformAdmin ? ' · platform admin' : ''}`}
      />
      <IntroBanner />
      {/* Top metric strip — 5 tiles wide on lg, wrapping on smaller. */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} sm={8} lg={5}>
          <MetricCard
            icon={<RocketOutlined />}
            color="#2468f2"
            label="Inference services"
            value={nsServices.length}
            hint={`in ${namespace}`}
          />
        </Col>
        <Col xs={12} sm={8} lg={5}>
          <MetricCard
            icon={<ExperimentOutlined />}
            color="#f8b418"
            label="Training jobs running"
            value={nsJobs.filter(j => j.status === 'Running').length}
            hint={`${nsJobs.length} total`}
          />
        </Col>
        <Col xs={12} sm={8} lg={5}>
          <MetricCard
            icon={<BookOutlined />}
            color="#2dbb55"
            label="Active notebooks"
            value={nsNotebooks.filter(n => n.status === 'Running').length}
            hint={`${nsNotebooks.length} total`}
          />
        </Col>
        <Col xs={12} sm={8} lg={5}>
          <MetricCard
            icon={<DatabaseOutlined />}
            color="#8b5cf6"
            label="Models in hub"
            value={models.length}
            hint={`${models.filter(m => m.scope === 'public').length} public · ${models.filter(m => m.scope === 'private' && m.namespace === namespace).length} in ${namespace}`}
          />
        </Col>
        <Col xs={24} sm={8} lg={4}>
          <MetricCard
            icon={<AppstoreOutlined />}
            color="#0ea5e9"
            label="Namespaces"
            value={namespaces.length}
            hint={user.isPlatformAdmin ? 'cluster-wide' : 'visible to you'}
          />
        </Col>
      </Row>

      {/* Second strip — GPU summary across the full row. Pulls from the
          same backend service the GPU Status page uses. */}
      <Card style={{ marginBottom: 12 }} title={user.isPlatformAdmin ? 'GPUs across the cluster' : `GPUs in ${namespace}`} size="small"
        extra={<Link to="/monitoring/gpu">Open GPU status <ArrowRightOutlined /></Link>}
      >
        <Row gutter={16}>
          <Col xs={8}>
            <MetricCard icon={<ThunderboltOutlined />} color="#2468f2" label={user.isPlatformAdmin ? 'Total GPUs' : 'GPUs requested'} value={gpu?.summary.total ?? 0} />
          </Col>
          <Col xs={8}>
            <MetricCard icon={<ThunderboltOutlined />} color="#f8b418" label="In use" value={gpu?.summary.used ?? 0} />
          </Col>
          <Col xs={8}>
            <MetricCard
              icon={<ThunderboltOutlined />}
              color={(gpu?.summary.available ?? 0) === 0 ? '#e94f4f' : '#10b981'}
              label="Available"
              value={gpu?.summary.available ?? 0}
              hint={gpu && gpu.vendors.length > 0 ? gpu.vendors.map(v => v.vendor).join(' · ') : undefined}
            />
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={16}>
          {/* Cluster-readiness only matters for admins; the install %
              comes from the components catalog' s reconcile result. */}
          {user.isPlatformAdmin && (
            <Card
              title="Cluster readiness"
              extra={
                <Link to="/admin/components">
                  Manage components <ArrowRightOutlined />
                </Link>
              }
              style={{ marginBottom: 12 }}
            >
              <Space direction="vertical" style={{ width: '100%' }} size={16}>
                <div>
                  <div className="knaic-sub">Component installation</div>
                  <Progress percent={installPct} size="small" />
                </div>
                {notInstalled.length > 0 && (
                  <div>
                    <Space wrap>
                      <AlertOutlined style={{ color: '#f8b418' }} />
                      <span>Not yet installed:</span>
                      {notInstalled.map(c => (
                        <Tooltip key={c.name} title={c.description}>
                          <Tag color="warning">{c.displayName}</Tag>
                        </Tooltip>
                      ))}
                    </Space>
                  </div>
                )}
              </Space>
            </Card>
          )}

          <Card title="Recent activity">
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {recentJobs.length === 0 && recentServices.length === 0 && (
                <div className="knaic-sub">
                  No recent inference services or train jobs in <b>{namespace}</b>.
                </div>
              )}
              {recentJobs.map(j => (
                <div key={j.id}>
                  <Tag
                    color={
                      j.status === 'Running' ? 'processing'
                        : j.status === 'Succeeded' ? 'success'
                          : j.status === 'Failed' ? 'error'
                            : 'default'
                    }
                  >
                    {j.status}
                  </Tag>
                  TrainJob <Link to="/training/jobs"><b>{j.name}</b></Link> on runtime <i>{j.runtime}</i>
                </div>
              ))}
              {recentServices.map(s => (
                <div key={s.id}>
                  <Tag color={s.status === 'Ready' ? 'success' : s.status === 'Failed' ? 'error' : 'processing'}>{s.status}</Tag>
                  {s.kind} <Link to="/inference/services"><b>{s.name}</b></Link> serving <code>{s.modelUri}</code>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="Quick actions">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button block icon={<RocketOutlined />}>
                <Link to="/inference/services">New inference service</Link>
              </Button>
              <Button block icon={<ExperimentOutlined />}>
                <Link to="/training/jobs">New train job</Link>
              </Button>
              <Button block icon={<BookOutlined />}>
                <Link to="/notebooks">New notebook</Link>
              </Button>
              <Button block icon={<ThunderboltOutlined />}>
                <Link to="/playground/chat">Open playground</Link>
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}

// IntroBanner is the brand-focused intro that sits at the top of the
// dashboard. It explains what the console is and points at the four areas
// users land in most often (Model Hub, Inference, Playground, Notebooks).
//
// Rendered for every user — there is no per-user dismiss state today; the
// strip is short enough (~110 px) that it doesn't push the metrics below
// the fold on standard laptop heights. If this ever becomes noisy we can
// stash a dismissed flag in localStorage and render conditionally.
function IntroBanner() {
  return (
    <Card
      className="dashboard-intro"
      style={{
        marginBottom: 12,
        background:
          'linear-gradient(135deg, #2468f2 0%, #6b46f0 50%, #d946ef 100%)',
        color: '#fff',
        border: 'none',
        overflow: 'hidden',
      }}
      styles={{ body: { padding: 20 } }}
    >
      <Row align="middle" gutter={[16, 12]}>
        <Col xs={24} md={16}>
          <Space size={10} style={{ marginBottom: 8 }}>
            <RocketOutlined style={{ fontSize: 22 }} />
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 0.2 }}>
              Kubernetes Native AI Console
            </span>
            <Tag color="rgba(255,255,255,0.18)" style={{ color: '#fff', border: 'none' }}>
              knaic
            </Tag>
          </Space>
          <div style={{ opacity: 0.92, lineHeight: 1.55 }}>
            Build, serve and monitor LLM workloads on Kubernetes — models,
            inference services, training jobs, notebooks and GPU usage in one
            place. Click a button on the right to jump in, or use the sidebar.
          </div>
        </Col>
        <Col xs={24} md={8}>
          <Space wrap style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Link to="/models/public">
              <Button
                type="default"
                icon={<DatabaseOutlined />}
                style={introButtonStyle}
              >
                Browse models
              </Button>
            </Link>
            <Link to="/inference/services">
              <Button
                type="default"
                icon={<CloudServerOutlined />}
                style={introButtonStyle}
              >
                Inference
              </Button>
            </Link>
            <Link to="/playground/chat">
              <Button
                type="default"
                icon={<MessageOutlined />}
                style={introButtonStyle}
              >
                Playground
              </Button>
            </Link>
            <Link to="/notebooks">
              <Button
                type="default"
                icon={<BookOutlined />}
                style={introButtonStyle}
              >
                Notebooks
              </Button>
            </Link>
          </Space>
        </Col>
      </Row>
    </Card>
  );
}

// Translucent white-on-gradient look so the buttons read as part of the
// banner rather than competing with the cards below. Single shared style
// keeps the four buttons visually consistent.
const introButtonStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.18)',
  borderColor: 'rgba(255,255,255,0.35)',
  color: '#fff',
  fontWeight: 500,
};
