import { useEffect, useMemo, useState } from 'react';
import { App, Form, Input, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import { useApp } from '@/context/AppContext';
import { addModel } from '@/data/models';
import {
  ensureS3SecretsLoaded,
  ensureGitLabConfigsLoaded,
  useAIStorageS3Secrets,
  useAIStorageGitLabConfigs,
} from '@/data/aiStorage';
import { MODEL_TYPE_OPTIONS } from './modelTypeMeta';

type Source = 's3-file' | 's3-folder' | 'gitlab';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

/** Asks the user to pick an AI Storage source (S3 object/folder or GitLab
 * project), then registers a Private Model whose URI points at that source.
 *
 * We deliberately stop short of validating the path actually exists — the
 * S3 / GitLab modules already provide browsers for that; this modal is for
 * users who already know where their model lives. */
export function RegisterFromAIStorageModal({ open, onClose, onCreated }: Props) {
  const { namespace, user } = useApp();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [source, setSource] = useState<Source>('s3-folder');

  const s3Secrets = useAIStorageS3Secrets(namespace);
  const gitlabConfigs = useAIStorageGitLabConfigs(namespace);

  useEffect(() => {
    if (open) {
      ensureS3SecretsLoaded(namespace);
      ensureGitLabConfigsLoaded(namespace);
      form.resetFields();
      setSource('s3-folder');
    }
  }, [open, namespace, form]);

  const sourceOptions = useMemo(
    () => [
      { label: 'S3 folder (prefix)', value: 's3-folder' },
      { label: 'S3 file', value: 's3-file' },
      { label: 'GitLab project', value: 'gitlab' },
    ],
    [],
  );

  const buildUri = (v: Record<string, string>): string => {
    if (source === 'gitlab') {
      // gitlab://<config>/<projectID>[#<branch>]
      const ref = v.ref ? `#${v.ref}` : '';
      return `gitlab://${v.gitlabConfig}/${v.projectID}${ref}`;
    }
    const bucket = (v.bucket ?? '').trim();
    let key = (v.key ?? '').trim().replace(/^\/+/, '');
    if (source === 's3-folder' && key && !key.endsWith('/')) key += '/';
    return `s3://${bucket}/${key}`;
  };

  return (
    <Modal
      open={open}
      title="Register a private model from AI Storage"
      onCancel={onClose}
      destroyOnClose
      okText="Register"
      onOk={async () => {
        const v = await form.validateFields();
        const uri = buildUri(v);
        try {
          await addModel({
            name: v.name,
            owner: user.name,
            scope: 'private',
            namespace,
            uri,
            scheme: source === 'gitlab' ? 'gitlab' : 's3',
            tags: ['ai-storage'],
            modelType: v.modelType || 'llm',
            sizeGB: 0,
            readme:
              v.readme ||
              `# ${v.name}\n\nRegistered from AI Storage: \`${uri}\`.`,
          });
          onCreated();
          message.success(`Registered ${v.name}`);
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Form form={form} layout="vertical" preserve={false} initialValues={{ modelType: 'llm' }}>
        <Form.Item label="Source">
          <Radio.Group
            value={source}
            onChange={e => setSource(e.target.value)}
            optionType="button"
            options={sourceOptions}
          />
        </Form.Item>
        <Form.Item name="name" label="Model name" rules={[{ required: true }]}>
          <Input placeholder="my-team/my-model" />
        </Form.Item>
        {source !== 'gitlab' ? (
          <>
            <Form.Item name="secret" label="S3 secret" rules={[{ required: true }]} extra="Tells knaic which S3 credentials to use when fetching the model.">
              <Select
                placeholder="Pick an S3 secret"
                options={s3Secrets.map(s => ({
                  label: (
                    <Space>
                      <strong>{s.name}</strong>
                      <Typography.Text type="secondary">{s.endpoint}</Typography.Text>
                    </Space>
                  ),
                  value: s.name,
                }))}
              />
            </Form.Item>
            <Form.Item name="bucket" label="Bucket" rules={[{ required: true }]}>
              <Input placeholder="my-bucket" />
            </Form.Item>
            <Form.Item
              name="key"
              label={source === 's3-folder' ? 'Folder (prefix)' : 'File key'}
              rules={[{ required: true }]}
            >
              <Input placeholder={source === 's3-folder' ? 'models/qwen3.5/' : 'models/qwen3.5/safetensors.bin'} />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="gitlabConfig" label="GitLab config" rules={[{ required: true }]}>
              <Select
                placeholder="Pick a GitLab config"
                options={gitlabConfigs.map(c => ({
                  label: (
                    <Space>
                      <strong>{c.name}</strong>
                      <Tag color="magenta">{c.url}</Tag>
                    </Space>
                  ),
                  value: c.name,
                }))}
              />
            </Form.Item>
            <Form.Item name="projectID" label="Project ID or path" rules={[{ required: true }]} extra="Numeric ID or URL-encoded full path (e.g. group%2Fproject).">
              <Input placeholder="1234" />
            </Form.Item>
            <Form.Item name="ref" label="Branch / tag (optional)">
              <Input placeholder="main" />
            </Form.Item>
          </>
        )}
        <Form.Item name="modelType" label="Model type">
          <Select options={MODEL_TYPE_OPTIONS.map(o => ({ label: o.label, value: o.id }))} />
        </Form.Item>
        <Form.Item name="readme" label="README.md (optional)">
          <Input.TextArea rows={3} placeholder="# Model title" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
