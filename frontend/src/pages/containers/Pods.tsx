import { useEffect, useMemo, useState } from 'react';
import { Table, Space, Button, Tag, App } from 'antd';
import { DeleteOutlined, FileTextOutlined, CodeOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import {
  usePods,
  ensurePodsLoaded,
  reloadPods,
  deleteWorkload,
  fetchResourceYaml,
  type Pod,
} from '@/data/workloads';
import { useApp } from '@/context/AppContext';
import { LogViewer } from '@/components/LogViewer';
import { YamlViewer } from '@/components/YamlViewer';
import { buildPodYaml } from '@/data/clusterResources';

export function Pods() {
  const { namespace } = useApp();
  const { message, modal } = App.useApp();
  const all = usePods();
  const data = useMemo(() => all.filter(p => p.namespace === namespace), [all, namespace]);
  const [logTarget, setLogTarget] = useState<Pod | null>(null);
  const [yaml, setYaml] = useState<{ pod: Pod; text: string } | null>(null);
  const [yamlLoading, setYamlLoading] = useState<string | null>(null);

  useEffect(() => {
    ensurePodsLoaded(namespace);
  }, [namespace]);

  const openYaml = async (pod: Pod) => {
    setYamlLoading(pod.name);
    try {
      const text = await fetchResourceYaml('pods', namespace, pod.name);
      setYaml({ pod, text });
    } catch (e) {
      // Fall back to the prototype's local YAML builder if the backend
      // doesn't have this pod (e.g. running in offline mode).
      setYaml({ pod, text: buildPodYaml(pod) });
      message.warning(`Falling back to local YAML: ${(e as Error).message}`);
    } finally {
      setYamlLoading(null);
    }
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="Pods"
        description={`Pods running in namespace ${namespace}`}
        extra={
          <Button onClick={() => reloadPods(namespace)}>Refresh</Button>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        dataSource={data}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <b>{v}</b> },
          { title: 'Node', dataIndex: 'node' },
          { title: 'IP', dataIndex: 'ip', render: v => <span className="mono">{v}</span> },
          { title: 'Owner', dataIndex: 'ownerRef' },
          {
            title: 'Containers',
            dataIndex: 'containers',
            render: (v: string[]) => (
              <Space wrap size={4}>
                {v?.map(c => (
                  <Tag key={c}>{c}</Tag>
                ))}
              </Space>
            ),
          },
          { title: 'Restarts', dataIndex: 'restarts' },
          { title: 'Age', dataIndex: 'age' },
          { title: 'Status', dataIndex: 'status', render: v => <StatusTag value={v} /> },
          {
            title: 'Actions',
            width: 200,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<FileTextOutlined />} onClick={() => setLogTarget(r)}>
                  Logs
                </Button>
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
                      title: `Delete pod ${r.name}?`,
                      content: 'A controller will likely recreate it.',
                      onOk: async () => {
                        try {
                          await deleteWorkload('pods', namespace, r.name);
                          message.success('Pod deleted');
                          reloadPods(namespace);
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
      <LogViewer
        open={!!logTarget}
        onClose={() => setLogTarget(null)}
        title={`Logs · ${logTarget?.name ?? ''}`}
        containers={logTarget?.containers ?? ['main']}
        podRef={logTarget ? { namespace: logTarget.namespace, name: logTarget.name } : undefined}
      />
      <YamlViewer
        open={!!yaml}
        onClose={() => setYaml(null)}
        title={`Pod · ${yaml?.pod.name ?? ''}`}
        yaml={yaml?.text ?? ''}
      />
    </div>
  );
}
