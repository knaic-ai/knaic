import { Row, Col, Card, Statistic, Progress, Space, Tag, Button } from 'antd';
import {
  RocketOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  BookOutlined,
  ThunderboltOutlined,
  AlertOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import { useModels } from '@/data/models';
import { useInferenceServices } from '@/data/inference';
import { useTrainJobs } from '@/data/training';
import { useNotebooks } from '@/data/notebooks';
import { useComponents } from '@/data/components';
import { useApp } from '@/context/AppContext';

export function Dashboard() {
  const { user, namespace } = useApp();
  const models = useModels();
  const services = useInferenceServices();
  const jobs = useTrainJobs();
  const notebooks = useNotebooks();
  const components = useComponents();

  const nsServices = services.filter(s => s.namespace === namespace);
  const nsJobs = jobs.filter(j => j.namespace === namespace);
  const nsNotebooks = notebooks.filter(n => n.namespace === namespace);
  const notInstalled = components.filter(c => c.status !== 'Installed');

  return (
    <div className="knaic-page">
      <PageHeader
        title={`Welcome, ${user.name}`}
        description={`Current workspace: ${namespace}${user.isPlatformAdmin ? ' · platform admin' : ''}`}
      />
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <Card className="metric-card">
            <Space align="start">
              <RocketOutlined style={{ color: '#2468f2', fontSize: 22 }} />
              <div>
                <div className="l">Inference services</div>
                <div className="v">{nsServices.length}</div>
              </div>
            </Space>
          </Card>
        </Col>
        <Col span={6}>
          <Card className="metric-card">
            <Space align="start">
              <ExperimentOutlined style={{ color: '#f8b418', fontSize: 22 }} />
              <div>
                <div className="l">Running train jobs</div>
                <div className="v">{nsJobs.filter(j => j.status === 'Running').length}</div>
              </div>
            </Space>
          </Card>
        </Col>
        <Col span={6}>
          <Card className="metric-card">
            <Space align="start">
              <BookOutlined style={{ color: '#2dbb55', fontSize: 22 }} />
              <div>
                <div className="l">Active notebooks</div>
                <div className="v">{nsNotebooks.filter(n => n.status === 'Running').length}</div>
              </div>
            </Space>
          </Card>
        </Col>
        <Col span={6}>
          <Card className="metric-card">
            <Space align="start">
              <DatabaseOutlined style={{ color: '#8b5cf6', fontSize: 22 }} />
              <div>
                <div className="l">Models in hub</div>
                <div className="v">{models.length}</div>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={16}>
          <Card
            title="Cluster readiness"
            extra={
              user.isPlatformAdmin && (
                <Link to="/admin/components">
                  Manage components <ArrowRightOutlined />
                </Link>
              )
            }
          >
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              <div>
                <div className="knaic-sub">Component installation</div>
                <Progress
                  percent={Math.round(((components.length - notInstalled.length) / components.length) * 100)}
                  size="small"
                />
              </div>
              {notInstalled.length > 0 && (
                <div>
                  <Space wrap>
                    <AlertOutlined style={{ color: '#f8b418' }} />
                    <span>The following components are not installed:</span>
                    {notInstalled.map(c => (
                      <Tag key={c.name} color="warning">
                        {c.displayName}
                      </Tag>
                    ))}
                  </Space>
                </div>
              )}
            </Space>
          </Card>

          <Card style={{ marginTop: 12 }} title="Recent activity">
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {nsJobs.slice(0, 3).map(j => (
                <div key={j.id}>
                  <Tag color={j.status === 'Running' ? 'processing' : j.status === 'Succeeded' ? 'success' : 'error'}>
                    {j.status}
                  </Tag>
                  TrainJob <b>{j.name}</b> on runtime <i>{j.runtime}</i>
                </div>
              ))}
              {nsServices.slice(0, 3).map(s => (
                <div key={s.id}>
                  <Tag color={s.status === 'Ready' ? 'success' : 'processing'}>{s.status}</Tag>
                  {s.kind} <b>{s.name}</b> serving <code>{s.modelUri}</code>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
        <Col span={8}>
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
