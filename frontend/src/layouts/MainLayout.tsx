import { useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Dropdown, Avatar, Select, Tag, Space, Tooltip, Segmented } from 'antd';
import { fetchClusterInfo, type ClusterInfo } from '@/api/auth';
import type { MenuProps } from 'antd';
import {
  DashboardOutlined,
  RobotOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  LineChartOutlined,
  ContainerOutlined,
  TeamOutlined,
  CloudServerOutlined,
  MessageOutlined,
  ExperimentOutlined,
  BookOutlined,
  SettingOutlined,
  LogoutOutlined,
  UserOutlined,
  CrownOutlined,
  BulbOutlined,
  BulbFilled,
  DesktopOutlined,
  ApiOutlined,
  FileTextOutlined,
  HddOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useApp, type NamespaceRole } from '@/context/AppContext';
import { apiEnabled } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';

const { Header, Sider, Content } = Layout;

type Item = Required<MenuProps>['items'][number];

const roleColor: Record<NamespaceRole, string> = {
  admin: 'gold',
  editor: 'blue',
  viewer: 'default',
};

export function MainLayout() {
  const { user, namespace, setNamespace, namespaces, themeMode, setThemeMode, isDark, roleIn } = useApp();
  const auth = useAuth();
  const loc = useLocation();
  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | null>(null);

  // Fetched from /api/v1/cluster-info; the header label tracks whichever
  // cluster name the backend was started with.
  useEffect(() => {
    if (!apiEnabled) return;
    let cancelled = false;
    fetchClusterInfo().then(info => {
      if (!cancelled) setClusterInfo(info);
    }).catch(() => { /* fail-soft — header just won't show a cluster name */ });
    return () => { cancelled = true; };
  }, []);

  // In API mode the backend has already filtered the namespaces list to those
  // the caller can see (via apiserver impersonation), so the local membership
  // filter is only relevant in prototype mode.
  const myNamespaces = useMemo(
    () => (apiEnabled || user.isPlatformAdmin ? namespaces : namespaces.filter(n => roleIn(n))),
    [namespaces, user, roleIn],
  );

  const currentRole = roleIn(namespace);

  const items: Item[] = useMemo(
    () => [
      { key: '/', icon: <DashboardOutlined />, label: <Link to="/">Dashboard</Link> },
      { key: '/agent-workspace', icon: <RobotOutlined />, label: <Link to="/agent-workspace">Agent Workspace</Link> },
      {
        key: 'models-group',
        icon: <DatabaseOutlined />,
        label: 'Model Hub',
        children: [
          { key: '/models/public', label: <Link to="/models/public">Model Catalog</Link> },
          { key: '/models/private', label: <Link to="/models/private">Private Models</Link> },
        ],
      },
      {
        key: 'monitor-group',
        icon: <LineChartOutlined />,
        label: 'Monitoring',
        children: [
          { key: '/monitoring/resources', label: <Link to="/monitoring/resources">Resource usage</Link> },
          { key: '/monitoring/gpu', label: <Link to="/monitoring/gpu">GPU status</Link> },
          { key: '/monitoring/llm', label: <Link to="/monitoring/llm">LLM services</Link> },
          { key: '/monitoring/train', label: <Link to="/monitoring/train">Train jobs</Link> },
        ],
      },
      {
        key: 'inference',
        icon: <CloudServerOutlined />,
        label: 'Inference',
        children: [
          { key: '/inference/services', label: <Link to="/inference/services">Inference Services</Link> },
          { key: '/inference/gateway', label: <Link to="/inference/gateway">Gateway</Link> },
          { key: '/inference/serving-runtimes', label: <Link to="/inference/serving-runtimes">Serving Runtimes</Link> },
          { key: '/inference/storage-initializers', label: <Link to="/inference/storage-initializers">Storage Initializer</Link> },
          { key: '/inference/llm-configs', label: <Link to="/inference/llm-configs">LLM Inference Config</Link> },
          { key: '/inference/local-model-cache', label: <Link to="/inference/local-model-cache">Local Model Cache</Link> },
        ],
      },
      {
        key: 'playground',
        icon: <MessageOutlined />,
        label: 'LLM Playground',
        children: [
          { key: '/playground/registry', label: <Link to="/playground/registry">LLM Registry</Link> },
          { key: '/playground/chat', label: <Link to="/playground/chat">Chat</Link> },
          { key: '/playground/agent', label: <Link to="/playground/agent">Agent</Link> },
        ],
      },
      { key: '/notebooks', icon: <BookOutlined />, label: <Link to="/notebooks">Notebooks</Link> },
      {
        key: 'training',
        icon: <ExperimentOutlined />,
        label: 'Training',
        children: [
          { key: '/training/runtimes', label: <Link to="/training/runtimes">Training Runtimes</Link> },
          { key: '/training/jobs', label: <Link to="/training/jobs">Train Jobs</Link> },
        ],
      },
      // AI Storage is workload-adjacent so it sits with Training/Notebooks
      // rather than down with the raw K8s storage view. Bracketed by
      // explicit dividers so it reads as its own band.
      { type: 'divider' as const },
      {
        key: 'aistorage',
        icon: <HddOutlined />,
        label: 'AI Storage',
        children: [
          { key: '/aistorage/s3', label: <Link to="/aistorage/s3">S3 Object Store</Link> },
          { key: '/aistorage/pvc', label: <Link to="/aistorage/pvc">PVC</Link> },
          { key: '/aistorage/gitlab', label: <Link to="/aistorage/gitlab">GitLab</Link> },
        ],
      },
      // Per-resource Kubernetes views grouped by function. Routes still live
      // under /containers/* so deep links keep working — only the menu
      // grouping has changed.
      { type: 'divider' as const },
      {
        key: 'containers',
        icon: <ContainerOutlined />,
        label: 'Containers',
        children: [
          { key: '/containers/deployments', label: <Link to="/containers/deployments">Deployments</Link> },
          { key: '/containers/statefulsets', label: <Link to="/containers/statefulsets">StatefulSets</Link> },
          { key: '/containers/pods', label: <Link to="/containers/pods">Pods</Link> },
        ],
      },
      {
        key: 'networking',
        icon: <ApiOutlined />,
        label: 'Networking',
        children: [
          { key: '/containers/services', label: <Link to="/containers/services">Services</Link> },
          { key: '/containers/gateways', label: <Link to="/containers/gateways">Gateway API</Link> },
        ],
      },
      {
        key: 'configuration',
        icon: <FileTextOutlined />,
        label: 'Configuration',
        children: [
          { key: '/containers/configmaps', label: <Link to="/containers/configmaps">ConfigMaps</Link> },
          { key: '/containers/secrets', label: <Link to="/containers/secrets">Secrets</Link> },
        ],
      },
      {
        key: 'storage',
        icon: <HddOutlined />,
        label: 'Storage',
        children: [
          { key: '/containers/pvcs', label: <Link to="/containers/pvcs">PVC Volumes</Link> },
        ],
      },
      {
        key: 'users',
        icon: <TeamOutlined />,
        label: 'Users & RBAC',
        children: [
          { key: '/users', label: <Link to="/users">Users</Link> },
          { key: '/users/roles', label: <Link to="/users/roles">Roles & Bindings</Link> },
        ],
      },
      { type: 'divider' as const },
      ...(user.isPlatformAdmin
        ? ([
            {
              key: 'admin',
              icon: <SettingOutlined />,
              label: 'Admin Area',
              children: [
                { key: '/admin/components', label: <Link to="/admin/components">Components</Link> },
                { key: '/admin/registry', label: <Link to="/admin/registry">Image registry</Link> },
                { key: '/admin/namespaces', label: <Link to="/admin/namespaces">Namespaces</Link> },
                { key: '/admin/nodes', label: <Link to="/admin/nodes">Nodes</Link> },
                { key: '/admin/gpu-profiles', label: <Link to="/admin/gpu-profiles">GPU profiles</Link> },
                { key: '/admin/s3-secrets', label: <Link to="/admin/s3-secrets">S3 Secrets</Link> },
                { key: '/admin/gitlab-configs', label: <Link to="/admin/gitlab-configs">GitLab Configs</Link> },
                { key: '/admin/model-publish-requests', label: <Link to="/admin/model-publish-requests">Model publish requests</Link> },
              ],
            },
          ] as Item[])
        : []),
    ],
    [user.isPlatformAdmin],
  );

  const selected = useMemo(() => {
    const key = loc.pathname.replace(/\/$/, '') || '/';
    // Nested URLs (e.g. the per-project file browser at
    // /aistorage/gitlab/:config/:projectID) should still highlight the
    // parent menu item — the user is still in that section, so leaving
    // the menu un-highlighted is jarring.
    if (key.startsWith('/aistorage/gitlab/')) return ['/aistorage/gitlab'];
    // /models/:scope/:id (the detail page) should highlight the parent
    // /models/:scope list item.
    const modelDetail = key.match(/^\/models\/(public|private)\//);
    if (modelDetail) return [`/models/${modelDetail[1]}`];
    // /inference/services/:namespace/:name (the detail page) should keep
    // "Inference Services" highlighted.
    if (key.startsWith('/inference/services/')) return ['/inference/services'];
    return [key];
  }, [loc.pathname]);

  const openKeys = useMemo(() => {
    const p = loc.pathname;
    // Most-specific first — the per-path entries below need to win over the
    // generic /containers fallback so e.g. /containers/services opens
    // "networking" rather than "containers".
    const rules: { prefix: string; group: string }[] = [
      { prefix: '/containers/services', group: 'networking' },
      { prefix: '/containers/gateways', group: 'networking' },
      { prefix: '/containers/configmaps', group: 'configuration' },
      { prefix: '/containers/secrets', group: 'configuration' },
      { prefix: '/containers/pvcs', group: 'storage' },
      { prefix: '/containers', group: 'containers' },
      { prefix: '/models', group: 'models-group' },
      { prefix: '/monitoring', group: 'monitor-group' },
      { prefix: '/inference', group: 'inference' },
      { prefix: '/playground', group: 'playground' },
      { prefix: '/training', group: 'training' },
      { prefix: '/aistorage', group: 'aistorage' },
      { prefix: '/users', group: 'users' },
      { prefix: '/admin', group: 'admin' },
    ];
    for (const { prefix, group } of rules) {
      if (p.startsWith(prefix)) return [group];
    }
    return [];
  }, [loc.pathname]);

  const userMenu: MenuProps['items'] = [
    { key: 'profile', icon: <UserOutlined />, label: `${user.name} · ${user.email}` },
    { type: 'divider' },
    {
      key: 'theme',
      // Inline Segmented inside a menu row so the user can flip light /
      // dark / auto without leaving the dropdown.
      label: (
        <Space>
          <span>Theme</span>
          <Segmented
            size="small"
            value={themeMode}
            onChange={v => setThemeMode(v as 'light' | 'dark' | 'auto')}
            options={[
              { icon: <BulbOutlined />, value: 'light' },
              { icon: <BulbFilled />, value: 'dark' },
              { icon: <DesktopOutlined />, value: 'auto' },
            ]}
          />
        </Space>
      ),
    },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', onClick: auth.logout },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/*
        Pin the Sider to the viewport so its Menu scrolls independently —
        otherwise a long nav (Admin Area expanded, AI Storage band, …)
        pushes the page itself into a scroll and the header scrolls with
        the content. position:sticky + top:0 keeps it under the page's
        own scroll model (no fixed-positioned overlap with the Header)
        and clipping the Sider to viewport height lets the inner Menu
        own its own overflow.
      */}
      <Sider
        width={232}
        theme="dark"
        collapsible
        style={{
          height: '100vh',
          position: 'sticky',
          top: 0,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 48,
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 700,
            letterSpacing: 2,
            fontSize: 16,
            background: isDark ? '#060b18' : '#15202e',
          }}
        >
          knaic
        </div>
        {/*
          The Menu sits below the 48-px brand band; we give it the
          remaining viewport height and let it scroll. Antd Sider's own
          collapse trigger is 48 px tall too, so we subtract both —
          otherwise the bottom-most menu item hides behind the trigger
          when the list overflows.
        */}
        <div
          style={{
            height: 'calc(100vh - 96px)',
            overflowY: 'auto',
            overflowX: 'hidden',
            // Trap scroll momentum inside the menu so it does not roll
            // over to the page when the user keeps scrolling at the
            // top or bottom of the list.
            overscrollBehavior: 'contain',
          }}
        >
          <Menu
            theme="dark"
            mode="inline"
            items={items}
            selectedKeys={selected}
            defaultOpenKeys={openKeys}
            style={{ borderInlineEnd: 'none' }}
          />
        </div>
      </Sider>
      <Layout>
        <Header style={{ borderBottom: '1px solid var(--knaic-hdr-border, #d0e0fb)', display: 'flex', alignItems: 'center' }}>
          {/*
            Left side: brand → cluster name → namespace selector → role tag.
            clusterName comes from the backend /api/v1/cluster-info endpoint
            (configured via KNAIC_CLUSTER_NAME); the namespace selector
            lives right next to it because the two answer the same question
            ("where am I working?").
          */}
          <Space size={12} style={{ flex: 1 }}>
            <Tag color="blue" style={{ margin: 0 }}>
              <AppstoreOutlined /> Kubernetes Native AI Console
            </Tag>
            <Tooltip title="Cluster identity (from KNAIC_CLUSTER_NAME)">
              <span className="knaic-sub">
                Cluster: <b>{clusterInfo?.clusterName || (apiEnabled ? '…' : 'prototype')}</b>
              </span>
            </Tooltip>
            <Tooltip title="Current namespace (workspace)">
              <Select
                value={namespace}
                onChange={setNamespace}
                options={myNamespaces.map(n => ({ label: n, value: n }))}
                style={{ width: 200 }}
                size="small"
              />
            </Tooltip>
            {currentRole && (
              <Tag color={roleColor[currentRole]} style={{ margin: 0 }}>
                {currentRole}
              </Tag>
            )}
          </Space>
          <Space size={12}>
            <Dropdown menu={{ items: userMenu }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar size="small" style={{ background: '#2468f2' }}>
                  {(user.name[0] ?? '?').toUpperCase()}
                </Avatar>
                <span>{user.name || 'user'}</span>
                {user.isPlatformAdmin && <CrownOutlined style={{ color: '#f8b418' }} />}
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
