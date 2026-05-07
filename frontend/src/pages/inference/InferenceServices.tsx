import { useEffect, useMemo, useState } from 'react';
import { Table, Tag, Space, Button, App, Tooltip, Dropdown } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  FileTextOutlined,
  CodeOutlined,
  PauseOutlined,
  CaretRightOutlined,
  CopyOutlined,
  ExpandAltOutlined,
  ShrinkOutlined,
  EditOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  useInferenceServices,
  ensureInferenceServicesLoaded,
  reloadInferenceServices,
  deleteInferenceService,
  fetchInferenceServiceYaml,
  buildInferenceServiceYaml,
  setInferenceServiceStopped,
  updateInferenceServiceYaml,
  type InferenceService,
} from '@/data/inference';
import { useApp } from '@/context/AppContext';
import { LogViewer } from '@/components/LogViewer';
import { YamlViewer } from '@/components/YamlViewer';
import { YamlEditor } from '@/components/YamlEditor';
import { NewInferenceServiceModal } from './NewInferenceServiceModal';

const MODEL_COLUMN_WIDTH = 280;
const MODEL_TRUNCATE_AFTER = 36;

function ModelUriCell({ uri }: { uri: string }) {
  const { message } = App.useApp();
  const [expanded, setExpanded] = useState(false);
  const tooLong = uri.length > MODEL_TRUNCATE_AFTER;
  return (
    <div style={{ width: MODEL_COLUMN_WIDTH, display: 'flex', alignItems: 'center', gap: 4 }}>
      <Tooltip title={tooLong && !expanded ? uri : null} placement="topLeft">
        <span
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            ...(expanded
              ? { whiteSpace: 'normal', wordBreak: 'break-all' }
              : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
          }}
        >
          {uri}
        </span>
      </Tooltip>
      {tooLong && (
        <Button
          type="text"
          size="small"
          icon={expanded ? <ShrinkOutlined /> : <ExpandAltOutlined />}
          onClick={() => setExpanded(v => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        />
      )}
      <Button
        type="text"
        size="small"
        icon={<CopyOutlined />}
        onClick={() => {
          navigator.clipboard.writeText(uri).then(
            () => message.success('URI copied'),
            () => message.error('Copy failed'),
          );
        }}
        aria-label="Copy URI"
      />
    </div>
  );
}

export function InferenceServicesPage() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = useInferenceServices();
  const data = useMemo(() => all.filter(s => s.namespace === namespace), [all, namespace]);
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState<{ svc: InferenceService; text: string } | null>(null);
  const [yamlEdit, setYamlEdit] = useState<{ svc: InferenceService; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);
  const [yamlSaving, setYamlSaving] = useState(false);
  const [log, setLog] = useState<InferenceService | null>(null);

  useEffect(() => {
    ensureInferenceServicesLoaded(namespace);
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

  const openEditYaml = async (svc: InferenceService) => {
    setYamlLoading(svc.name);
    try {
      const text = await fetchInferenceServiceYaml(namespace, svc.name, svc.kind);
      setYamlEdit({ svc, text: text || buildInferenceServiceYaml(svc) });
    } catch (e) {
      setYamlEdit({ svc, text: buildInferenceServiceYaml(svc) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  const saveYaml = async () => {
    if (!yamlEdit) return;
    setYamlSaving(true);
    try {
      await updateInferenceServiceYaml(namespace, yamlEdit.svc.name, yamlEdit.svc.kind, yamlEdit.text);
      message.success('YAML updated');
      setYamlEdit(null);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setYamlSaving(false);
    }
  };

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
              onClick={() => setOpen(true)}
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
          {
            title: 'Deployment mode',
            dataIndex: 'deploymentMode',
            render: v => v ? <Tag color={v === 'RawDeployment' ? 'geekblue' : v === 'ModelMesh' ? 'magenta' : 'cyan'}>{v}</Tag> : '—',
          },
          {
            title: 'Model',
            dataIndex: 'modelUri',
            width: MODEL_COLUMN_WIDTH,
            render: v => <ModelUriCell uri={v} />,
          },
          { title: 'Replicas', render: (_, r) => r.minReplicas === r.maxReplicas ? r.minReplicas : `${r.minReplicas} – ${r.maxReplicas}` },
          {
            title: 'Resources',
            render: (_, r) => {
              const cpuMem = `${r.resources.cpu || '—'} CPU · ${r.resources.memory || '—'}`;
              if (r.gpuValues && Object.keys(r.gpuValues).length > 0) {
                // Render each accelerator key on its own line so HAMi-style
                // composite requests (gpualloc / gpucores / gpumem) all show.
                return (
                  <Space direction="vertical" size={0}>
                    <span>{cpuMem}</span>
                    {Object.entries(r.gpuValues).map(([k, v]) => (
                      <span key={k} className="mono" style={{ fontSize: 12 }}>
                        {k.split('/').pop()}={v}
                      </span>
                    ))}
                  </Space>
                );
              }
              return `${cpuMem} · ${r.resources.gpu > 0 ? `${r.resources.gpu} GPU` : 'no GPU'}`;
            },
          },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          { title: 'Endpoint', dataIndex: 'endpoint', render: v => <span className="mono">{v}</span> },
          {
            title: 'Actions',
            width: 320,
            render: (_, r) => {
              const isStopped = r.stopped || r.status === 'Stopped';
              return (
                <Space>
                  <Button
                    size="small"
                    icon={isStopped ? <CaretRightOutlined /> : <PauseOutlined />}
                    onClick={async () => {
                      try {
                        await setInferenceServiceStopped(namespace, r.name, r.kind, !isStopped);
                        message.success(isStopped ? 'Starting…' : 'Stopping…');
                      } catch (e) {
                        message.error((e as Error).message);
                      }
                    }}
                  >
                    {isStopped ? 'Start' : 'Stop'}
                  </Button>
                  <Button size="small" icon={<FileTextOutlined />} onClick={() => setLog(r)}>Logs</Button>
                  <Button
                    size="small"
                    icon={<CodeOutlined />}
                    loading={yamlLoading === r.name}
                    onClick={() => openYaml(r)}
                  >
                    YAML
                  </Button>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'edit-yaml', label: 'Edit YAML', icon: <EditOutlined /> },
                        { key: 'delete', label: 'Delete', icon: <DeleteOutlined />, danger: true },
                      ],
                      onClick: ({ key }) => {
                        if (key === 'edit-yaml') {
                          openEditYaml(r);
                        } else if (key === 'delete') {
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
                          });
                        }
                      },
                    }}
                  >
                    <Button
                      size="small"
                      icon={<MoreOutlined />}
                      loading={yamlLoading === r.name}
                      aria-label="More actions"
                    />
                  </Dropdown>
                </Space>
              );
            },
          },
        ]}
      />
      <NewInferenceServiceModal
        open={open}
        namespace={namespace}
        onClose={() => setOpen(false)}
      />

      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`${yaml?.svc.kind ?? ''} · ${yaml?.svc.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
      <YamlEditor
        open={!!yamlEdit}
        onClose={() => setYamlEdit(null)}
        title={`Edit YAML · ${yamlEdit?.svc.kind ?? ''} · ${yamlEdit?.svc.name ?? ''}`}
        value={yamlEdit?.text ?? ''}
        saving={yamlSaving}
        onChange={text => setYamlEdit(cur => (cur ? { ...cur, text } : cur))}
        onSave={saveYaml}
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
