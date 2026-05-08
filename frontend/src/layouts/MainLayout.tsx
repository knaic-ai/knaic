import { useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Dropdown, Avatar, Select, Tag, Space, Tooltip, Segmented } from 'antd';
import { fetchClusterInfo, type ClusterInfo } from '@/api/auth';
import type { MenuProps } from 'antd';
import {
  DashboardOutlined,
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

  // Pulled from kube-public/global-info via /api/v1/cluster-info; the
  // header label tracks whichever cluster the backend is wired against.
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
      {
        key: 'models-group',
        icon: <DatabaseOutlined />,
        label: 'Model Hub',
        children: [
          { key: '/models/public', label: <Link to="/models/public">Public Models</Link> },
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
          { key: '/inference/serving-runtimes', label: <Link to="/inference/serving-runtimes">Serving Runtimes</Link> },
          { key: '/inference/storage-initializers', label: <Link to="/inference/storage-initializers">Storage Initializer</Link> },
          { key: '/inference/llm-configs', label: <Link to="/inference/llm-configs">LLM Inference Config</Link> },
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
              ],
            },
          ] as Item[])
        : []),
    ],
    [user.isPlatformAdmin],
  );

  const selected = useMemo(() => {
    const key = loc.pathname.replace(/\/$/, '') || '/';
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
      <Sider width={232} theme="dark" collapsible>
        <div
          style={{
            height: 48,
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
        <Menu
          theme="dark"
          mode="inline"
          items={items}
          selectedKeys={selected}
          defaultOpenKeys={openKeys}
        />
      </Sider>
      <Layout>
        <Header style={{ borderBottom: '1px solid var(--knaic-hdr-border, #d0e0fb)', display: 'flex', alignItems: 'center' }}>
          {/*
            Left side: brand → cluster name → namespace selector → role tag.
            Per the cpaas convention, clusterName comes from the
            kube-public/global-info ConfigMap; the namespace selector lives
            right next to it because the two answer the same question
            ("where am I working?").
          */}
          <Space size={12} style={{ flex: 1 }}>
            <Tag color="blue" style={{ margin: 0 }}>
              <AppstoreOutlined /> Kubernetes Native AI Console
            </Tag>
            <Tooltip title="Cluster identity (kube-public/global-info)">
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
