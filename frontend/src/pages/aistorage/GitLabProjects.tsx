import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Input, Result, Select, Space, Table, Tag, Tooltip } from 'antd';
import { ExportOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { RegisterAsModelModal } from '@/pages/models/RegisterAsModelModal';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  listGitLabProjects,
  type GitLabProjectDTO,
} from '@/api/aiStorage';
import {
  ensureGitLabConfigsLoaded,
  useAIStorageGitLabConfigs,
} from '@/data/aiStorage';

// AI Storage · GitLab — the project index. Lists every project the
// namespace's configured token can reach, sorted by path. Click a row to
// open the file browser for that project.
//
// One config at a time: if a namespace has multiple configs, a small Select
// in the header picks which one's projects to show. Search is client-side
// over the already-fetched list so it stays snappy with hundreds of projects.
export function GitLabProjectsPage() {
  const { namespace } = useApp();
  const navigate = useNavigate();
  const configs = useAIStorageGitLabConfigs(namespace);
  const { message } = App.useApp();
  const [configName, setConfigName] = useState<string | undefined>();
  const [projects, setProjects] = useState<GitLabProjectDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [registerTarget, setRegisterTarget] = useState<
    { uri: string; name: string } | null
  >(null);

  const activeConfig = useMemo(
    () => configs.find(c => c.name === configName),
    [configs, configName],
  );

  // Build a git://<host>/<path> URI from a project. We strip the scheme
  // from the configured GitLab URL so the resulting URI is a real git
  // wire-protocol address that can be cloned with `git clone git://...`
  // — even though knaic's downloader currently treats it as opaque.
  const gitUriFor = (p: GitLabProjectDTO): string => {
    const base = activeConfig?.url ?? '';
    const host = base.replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '');
    return `git://${host || 'gitlab'}/${p.pathWithNamespace}`;
  };

  useEffect(() => {
    ensureGitLabConfigsLoaded(namespace);
    setConfigName(undefined);
    setProjects([]);
    setFilter('');
  }, [namespace]);

  useEffect(() => {
    if (!configName && configs.length > 0) setConfigName(configs[0].name);
  }, [configs, configName]);

  const reload = async () => {
    if (!configName) return;
    setLoading(true);
    try {
      const ps = await listGitLabProjects(namespace, configName);
      setProjects(ps);
    } catch (e) {
      message.error((e as Error).message);
      setProjects([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [namespace, configName]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return projects;
    return projects.filter(p => p.pathWithNamespace.toLowerCase().includes(f));
  }, [projects, filter]);

  if (configs.length === 0) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="AI Storage · GitLab"
          description={`Browse, upload and download files in GitLab projects for namespace "${namespace}".`}
        />
        <Result
          status="info"
          title="No GitLab configs in this namespace"
          subTitle="Ask a platform admin to add one under Admin Area → GitLab Configs."
        />
      </div>
    );
  }

  const openProject = (p: GitLabProjectDTO) => {
    if (!configName) return;
    navigate(`/aistorage/gitlab/${encodeURIComponent(configName)}/${p.id}`);
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="AI Storage · GitLab"
        description={`Projects accessible to namespace "${namespace}" via the configured token.`}
        extra={
          <Space>
            {configs.length > 1 && (
              <Select
                size="small"
                placeholder="Config"
                value={configName}
                onChange={v => setConfigName(v)}
                options={configs.map(c => ({ label: c.name, value: c.name }))}
                style={{ width: 200 }}
              />
            )}
            <Input.Search
              placeholder="Filter by path"
              allowClear
              size="middle"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ width: 260 }}
            />
            <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
          </Space>
        }
      />
      <Table<GitLabProjectDTO>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={filtered}
        pagination={{ pageSize: 30, showSizeChanger: true }}
        onRow={r => ({
          onClick: () => openProject(r),
          style: { cursor: 'pointer' },
        })}
        columns={[
          {
            title: 'Project',
            dataIndex: 'pathWithNamespace',
            render: (v: string) => {
              // Render the group prefix slightly dimmer so the project name
              // stands out — most user scanning is on the trailing segment.
              const idx = v.lastIndexOf('/');
              if (idx < 0) return <b>{v}</b>;
              return (
                <span>
                  <span style={{ color: '#999' }}>{v.slice(0, idx + 1)}</span>
                  <b>{v.slice(idx + 1)}</b>
                </span>
              );
            },
          },
          {
            title: 'Default branch',
            dataIndex: 'defaultBranch',
            width: 160,
            render: (v?: string) => v ? <Tag>{v}</Tag> : <span style={{ color: '#999' }}>—</span>,
          },
          {
            title: 'LFS',
            dataIndex: 'lfsEnabled',
            width: 80,
            render: (v: boolean) => v ? <Tag color="purple">on</Tag> : <Tag>off</Tag>,
          },
          {
            title: 'Actions',
            width: 130,
            render: (_, r) => (
              <Space>
                <Tooltip title="Register as private model">
                  <Button
                    size="small"
                    icon={<SaveOutlined />}
                    onClick={e => {
                      e.stopPropagation();
                      const base = r.pathWithNamespace.split('/').pop() ?? r.pathWithNamespace;
                      setRegisterTarget({
                        uri: gitUriFor(r),
                        name: base,
                      });
                    }}
                  />
                </Tooltip>
                {r.webUrl && (
                  <Tooltip title="Open in GitLab">
                    <Button
                      size="small"
                      type="text"
                      icon={<ExportOutlined />}
                      onClick={e => {
                        // Don't trigger the row's onClick — opening GitLab in
                        // a new tab shouldn't also navigate the knaic UI.
                        e.stopPropagation();
                        window.open(r.webUrl, '_blank', 'noopener,noreferrer');
                      }}
                    />
                  </Tooltip>
                )}
              </Space>
            ),
          },
        ]}
      />
      <RegisterAsModelModal
        open={!!registerTarget}
        uri={registerTarget?.uri ?? ''}
        suggestedName={registerTarget?.name}
        sourceLabel="GitLab project"
        onClose={() => setRegisterTarget(null)}
        onCreated={() => setRegisterTarget(null)}
      />
    </div>
  );
}
