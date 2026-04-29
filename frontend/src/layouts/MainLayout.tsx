import { useMemo } from 'react';
import { Layout, Menu, Dropdown, Avatar, Select, Tag, Space, Tooltip, Segmented } from 'antd';
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
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp, type NamespaceRole } from '@/context/AppContext';

const { Header, Sider, Content } = Layout;

type Item = Required<MenuProps>['items'][number];

const roleColor: Record<NamespaceRole, string> = {
  admin: 'gold',
  editor: 'blue',
  viewer: 'default',
};

export function MainLayout() {
  const { user, setUser, namespace, setNamespace, namespaces, themeMode, setThemeMode, isDark, roleIn } = useApp();
  const loc = useLocation();
  const nav = useNavigate();

  const myNamespaces = useMemo(
    () => (user.isPlatformAdmin ? namespaces : namespaces.filter(n => roleIn(n))),
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
          { key: '/monitoring/llm', label: <Link to="/monitoring/llm">LLM services</Link> },
          { key: '/monitoring/train', label: <Link to="/monitoring/train">Train jobs</Link> },
        ],
      },
      {
        key: 'containers',
        icon: <ContainerOutlined />,
        label: 'Containers',
        children: [
          { key: '/containers/deployments', label: <Link to="/containers/deployments">Deployments</Link> },
          { key: '/containers/statefulsets', label: <Link to="/containers/statefulsets">StatefulSets</Link> },
          { key: '/containers/pods', label: <Link to="/containers/pods">Pods</Link> },
          { key: '/containers/services', label: <Link to="/containers/services">Services</Link> },
          { key: '/containers/configmaps', label: <Link to="/containers/configmaps">ConfigMaps</Link> },
          { key: '/containers/secrets', label: <Link to="/containers/secrets">Secrets</Link> },
          { key: '/containers/gateways', label: <Link to="/containers/gateways">Gateway API</Link> },
          { key: '/containers/pvcs', label: <Link to="/containers/pvcs">PVC Volumes</Link> },
        ],
      },
      {
        key: 'inference',
        icon: <CloudServerOutlined />,
        label: 'Inference',
        children: [
          { key: '/inference/serving-runtimes', label: <Link to="/inference/serving-runtimes">Serving Runtimes</Link> },
          { key: '/inference/services', label: <Link to="/inference/services">Inference Services</Link> },
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
      {
        key: 'training',
        icon: <ExperimentOutlined />,
        label: 'Training',
        children: [
          { key: '/training/runtimes', label: <Link to="/training/runtimes">Training Runtimes</Link> },
          { key: '/training/jobs', label: <Link to="/training/jobs">Train Jobs</Link> },
        ],
      },
      { key: '/notebooks', icon: <BookOutlined />, label: <Link to="/notebooks">Notebooks</Link> },
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
    const groups: Record<string, string> = {
      '/models': 'models-group',
      '/monitoring': 'monitor-group',
      '/containers': 'containers',
      '/inference': 'inference',
      '/playground': 'playground',
      '/training': 'training',
      '/users': 'users',
      '/admin': 'admin',
    };
    return Object.entries(groups)
      .filter(([prefix]) => p.startsWith(prefix))
      .map(([, v]) => v);
  }, [loc.pathname]);

  const userMenu: MenuProps['items'] = [
    { key: 'profile', icon: <UserOutlined />, label: `${user.name} · ${user.email}` },
    {
      key: 'role-toggle',
      label: (
        <Space>
          <span>Platform admin</span>
          <Segmented
            size="small"
            value={user.isPlatformAdmin ? 'yes' : 'no'}
            onChange={v => setUser({ ...user, isPlatformAdmin: v === 'yes' })}
            options={[
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
            ]}
          />
        </Space>
      ),
    },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', onClick: () => nav('/') },
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
          <Space size={12} style={{ flex: 1 }}>
            <Tag color="blue" style={{ margin: 0 }}>
              <AppstoreOutlined /> Kubernetes Native AI Console
            </Tag>
            <span className="knaic-sub">Cluster: prod-ai-01</span>
          </Space>
          <Space size={12}>
            <Tooltip title="Color theme">
              <Segmented
                size="small"
                value={themeMode}
                onChange={v => setThemeMode(v as 'light' | 'dark' | 'auto')}
                options={[
                  { icon: <BulbOutlined />, value: 'light', label: 'Light' },
                  { icon: <BulbFilled />, value: 'dark', label: 'Dark' },
                  { icon: <DesktopOutlined />, value: 'auto', label: 'Auto' },
                ]}
              />
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
            <Dropdown menu={{ items: userMenu }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar size="small" style={{ background: '#2468f2' }}>
                  {user.name[0].toUpperCase()}
                </Avatar>
                <span>{user.name}</span>
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
