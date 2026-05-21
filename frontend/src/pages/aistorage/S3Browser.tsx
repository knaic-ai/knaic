import { useEffect, useMemo, useState } from 'react';
import { App, Breadcrumb, Button, Card, Empty, Progress, Result, Select, Space, Table, Tag, Tooltip, Upload } from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone, CloseOutlined, DeleteOutlined, DownloadOutlined, FolderOutlined, ReloadOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import { RegisterAsModelModal } from '@/pages/models/RegisterAsModelModal';
import { PageHeader } from '@/components/PageHeader';
import { useApp } from '@/context/AppContext';
import {
  deleteS3Object,
  downloadS3File,
  listS3Buckets,
  listS3Objects,
  uploadS3Object,
  type S3ObjectDTO,
  type S3SecretDTO,
} from '@/api/aiStorage';
import {
  ensureS3SecretsLoaded,
  useAIStorageS3Secrets,
} from '@/data/aiStorage';

// UploadEntry is one row in the upload progress panel below the page
// header. We model it as a small state machine: uploading → done | error.
// `done` rows are removed after a short delay so the panel naturally
// collapses when there's nothing happening.
interface UploadEntry {
  id: string;
  name: string;
  size: number;
  percent: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

// "AI Storage · S3 Object Store" — read/upload/download files in the
// configured S3 buckets. Picks the namespace from AppContext; the user
// then picks one of the configured secrets and (optionally) a bucket.
export function S3BrowserPage() {
  const { namespace } = useApp();
  const secrets = useAIStorageS3Secrets(namespace);
  const { message, modal } = App.useApp();
  const [secretName, setSecretName] = useState<string | undefined>();
  const [bucket, setBucket] = useState<string | undefined>();
  const [buckets, setBuckets] = useState<string[]>([]);
  const [prefix, setPrefix] = useState('');
  const [items, setItems] = useState<S3ObjectDTO[]>([]);
  const [loading, setLoading] = useState(false);
  // Per-file upload progress. Keyed by a stable id (`name + size + start`) so
  // two same-name uploads don't collide and we don't lose history on rerender.
  // Status is split out from percent so a finished row can stay visible at
  // 100% for a few seconds before fading.
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  // Register-as-model modal is opened from the row Actions column. We
  // hold a small ad-hoc descriptor (uri + suggested name) rather than
  // the full S3ObjectDTO because the modal is shared with the PVC and
  // GitLab register flows.
  const [registerTarget, setRegisterTarget] = useState<
    { uri: string; name: string; label: string } | null
  >(null);

  // Load the secret list for the namespace.
  useEffect(() => {
    ensureS3SecretsLoaded(namespace);
    setSecretName(undefined);
    setBucket(undefined);
    setItems([]);
    setPrefix('');
  }, [namespace]);

  // Default to the first secret + its bucket once secrets arrive.
  useEffect(() => {
    if (!secretName && secrets.length > 0) {
      const first = secrets[0];
      setSecretName(first.name);
      setBucket(first.bucket);
    }
  }, [secrets, secretName]);

  // Whenever the selection changes, refresh the bucket list + listing.
  useEffect(() => {
    if (!secretName) return;
    let cancelled = false;
    listS3Buckets(namespace, secretName)
      .then(bs => { if (!cancelled) setBuckets(bs); })
      .catch(() => { /* surface only on listing failure */ });
    return () => { cancelled = true; };
  }, [namespace, secretName]);

  const reload = async () => {
    if (!secretName) return;
    setLoading(true);
    try {
      const data = await listS3Objects(namespace, secretName, bucket, prefix);
      setItems(data);
    } catch (e) {
      message.error((e as Error).message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [secretName, bucket, prefix]);

  const selectedSecret = useMemo<S3SecretDTO | undefined>(
    () => secrets.find(s => s.name === secretName),
    [secrets, secretName],
  );

  const onUpload = async (file: File): Promise<boolean> => {
    if (!secretName) {
      message.error('Select a secret first');
      return false;
    }
    const key = (prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '') + file.name;
    // Stable id per upload — name+size+start_time so the same file dragged
    // twice still shows two rows.
    const id = `${file.name}|${file.size}|${Date.now()}`;
    setUploads(prev => [...prev, { id, name: file.name, size: file.size, percent: 0, status: 'uploading' }]);
    try {
      await uploadS3Object(namespace, secretName, bucket, key, file, percent => {
        setUploads(prev => prev.map(u => (u.id === id ? { ...u, percent } : u)));
      });
      setUploads(prev => prev.map(u => (u.id === id ? { ...u, percent: 100, status: 'done' } : u)));
      // Auto-remove the completed row after a moment so the panel doesn't
      // accumulate state across a session.
      setTimeout(() => {
        setUploads(prev => prev.filter(u => u.id !== id));
      }, 3000);
      await reload();
    } catch (e) {
      setUploads(prev => prev.map(u => (u.id === id ? { ...u, status: 'error', error: (e as Error).message } : u)));
      message.error((e as Error).message);
    }
    return false;
  };

  // Prefix breadcrumb: clicking a segment jumps to that prefix.
  const crumbs = useMemo(() => {
    const segs = prefix.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    return [
      { key: '', label: '/', goto: '' },
      ...segs.map((s, i) => ({
        key: segs.slice(0, i + 1).join('/'),
        label: s,
        goto: segs.slice(0, i + 1).join('/') + '/',
      })),
    ];
  }, [prefix]);

  if (secrets.length === 0) {
    return (
      <div className="knaic-page">
        <PageHeader
          title="AI Storage · S3 Object Store"
          description={`Browse and manage files in the configured S3 buckets for namespace "${namespace}".`}
        />
        <Result
          status="info"
          title="No S3 secrets configured in this namespace"
          subTitle="Ask a platform admin to add an S3 secret under Admin Area → S3 Secrets, or pick a different namespace from the header."
        />
      </div>
    );
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="AI Storage · S3 Object Store"
        description={`Files in namespace "${namespace}".`}
        extra={
          <Space>
            <Select
              size="small"
              placeholder="Secret"
              value={secretName}
              onChange={v => { setSecretName(v); setPrefix(''); setBucket(secrets.find(s => s.name === v)?.bucket); }}
              options={secrets.map(s => ({ label: s.name, value: s.name }))}
              style={{ width: 180 }}
            />
            <Select
              size="small"
              placeholder="Bucket"
              value={bucket}
              onChange={v => { setBucket(v); setPrefix(''); }}
              options={(buckets.length > 0 ? buckets : (selectedSecret?.bucket ? [selectedSecret.bucket] : [])).map(b => ({ label: b, value: b }))}
              style={{ width: 220 }}
            />
            <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
            <Upload
              showUploadList={false}
              beforeUpload={onUpload}
              multiple
            >
              <Button type="primary" icon={<UploadOutlined />} disabled={!secretName}>Upload</Button>
            </Upload>
          </Space>
        }
      />
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={crumbs.map(c => ({
          key: c.key,
          title: <a onClick={() => setPrefix(c.goto)}>{c.label}</a>,
        }))}
      />
      {uploads.length > 0 && (
        <Card
          size="small"
          title={`Uploads (${uploads.filter(u => u.status === 'uploading').length} in progress)`}
          style={{ marginBottom: 12 }}
          bodyStyle={{ padding: '8px 12px' }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {uploads.map(u => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 24, textAlign: 'center' }}>
                  {u.status === 'done' && <CheckCircleTwoTone twoToneColor="#52c41a" />}
                  {u.status === 'error' && <CloseCircleTwoTone twoToneColor="#ff4d4f" />}
                </div>
                <div style={{ flex: '0 0 30%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.name}>
                  {u.name}
                </div>
                <div style={{ flex: 1 }}>
                  <Progress
                    percent={Math.round(u.percent)}
                    size="small"
                    status={u.status === 'error' ? 'exception' : u.status === 'done' ? 'success' : 'active'}
                  />
                  {u.status === 'error' && u.error && (
                    <div style={{ fontSize: 12, color: '#ff4d4f' }}>{u.error}</div>
                  )}
                </div>
                <div style={{ width: 80, textAlign: 'right', color: '#999', fontSize: 12 }}>
                  {formatBytes(u.size)}
                </div>
                <Button
                  size="small"
                  type="text"
                  icon={<CloseOutlined />}
                  onClick={() => setUploads(prev => prev.filter(x => x.id !== u.id))}
                />
              </div>
            ))}
          </Space>
        </Card>
      )}
      <Table<S3ObjectDTO>
        rowKey="key"
        size="middle"
        loading={loading}
        dataSource={items}
        locale={{ emptyText: <Empty description={prefix ? `No objects under "${prefix}"` : 'Empty bucket'} /> }}
        pagination={{ pageSize: 50 }}
        columns={[
          {
            title: 'Name',
            dataIndex: 'key',
            render: (key, r) => {
              const display = key.slice(prefix.length).replace(/\/$/, '');
              if (r.isPrefix) {
                return (
                  <a onClick={() => setPrefix(key)}>
                    <FolderOutlined /> {display || key}
                  </a>
                );
              }
              return <span>{display || key}</span>;
            },
          },
          {
            title: 'Type',
            dataIndex: 'isPrefix',
            width: 110,
            render: (v: boolean) => v ? <Tag>folder</Tag> : <Tag color="default">file</Tag>,
          },
          {
            title: 'Size',
            dataIndex: 'size',
            width: 120,
            render: (v: number, r) => r.isPrefix ? '—' : formatBytes(v),
          },
          { title: 'Modified', dataIndex: 'lastModified', width: 200 },
          {
            title: 'Actions',
            width: 200,
            render: (_, r) => {
              // For files: download + register + delete.
              // For folders: register (the prefix) — folders aren't
              // deletable here and aren't downloadable as a single blob,
              // but they are perfectly valid model sources.
              const baseName = r.key.replace(/\/$/, '').split('/').pop() ?? r.key;
              const uri = `s3://${bucket}/${r.key}`;
              const label = r.isPrefix ? 'S3 folder' : 'S3 file';
              return (
                <Space>
                  {!r.isPrefix && (
                    <Tooltip title="Download">
                      <Button
                        size="small"
                        icon={<DownloadOutlined />}
                        onClick={async () => {
                          try {
                            await downloadS3File(namespace, secretName!, r.key, bucket);
                          } catch (e) {
                            message.error((e as Error).message);
                          }
                        }}
                      />
                    </Tooltip>
                  )}
                  <Tooltip title="Register as private model">
                    <Button
                      size="small"
                      icon={<SaveOutlined />}
                      onClick={() =>
                        setRegisterTarget({
                          uri,
                          name: baseName,
                          label,
                        })
                      }
                    />
                  </Tooltip>
                  {!r.isPrefix && (
                    <Tooltip title="Delete">
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() =>
                          modal.confirm({
                            title: `Delete ${r.key}?`,
                            onOk: async () => {
                              try {
                                await deleteS3Object(namespace, secretName!, r.key, bucket);
                                message.success('Deleted');
                                await reload();
                              } catch (e) {
                                message.error((e as Error).message);
                              }
                            },
                          })
                        }
                      />
                    </Tooltip>
                  )}
                </Space>
              );
            },
          },
        ]}
      />
      <RegisterAsModelModal
        open={!!registerTarget}
        uri={registerTarget?.uri ?? ''}
        suggestedName={registerTarget?.name}
        sourceLabel={registerTarget?.label ?? 'S3 object'}
        onClose={() => setRegisterTarget(null)}
        onCreated={() => setRegisterTarget(null)}
      />
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

