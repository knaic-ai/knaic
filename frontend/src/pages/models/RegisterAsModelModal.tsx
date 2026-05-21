import { useEffect } from 'react';
import { App, Form, Input, Modal, Select, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { addModel, parseUri } from '@/data/models';
import { MODEL_TYPE_OPTIONS } from './modelTypeMeta';

interface Props {
  open: boolean;
  /** Pre-filled storage URI such as `s3://bucket/key/`, `pvc://my-pvc/path`,
   * or `git://gitlab-host/group/project`. The user can edit before submitting
   * but the URI scheme determines what kind of source this is. */
  uri: string;
  /** Suggested model name. Usually derived from the URI's last segment. */
  suggestedName?: string;
  /** Short label shown in the modal title to remind the user where the
   * register action was triggered (e.g. "S3 file", "PVC", "GitLab project"). */
  sourceLabel: string;
  onClose: () => void;
  /** Fired after the model is successfully created. Defaults to navigating
   * to `/models/private`. */
  onCreated?: () => void;
}

/** Generic "register as a Private Model" modal. Each AI Storage page (S3,
 * PVC, GitLab) builds the right URI for the clicked row and hands it off
 * here — the modal only collects the model's name + type + readme. */
export function RegisterAsModelModal({
  open,
  uri,
  suggestedName,
  sourceLabel,
  onClose,
  onCreated,
}: Props) {
  const { namespace, user } = useApp();
  const { message } = App.useApp();
  const nav = useNavigate();
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        name: suggestedName ?? '',
        uri,
        modelType: 'llm',
        readme: '',
      });
    }
  }, [open, suggestedName, uri, form]);

  return (
    <Modal
      open={open}
      title={`Register ${sourceLabel} as private model`}
      onCancel={onClose}
      destroyOnClose
      okText="Register"
      onOk={async () => {
        const v = await form.validateFields();
        const scheme = parseUri(v.uri);
        if (!scheme) {
          message.error('Unsupported URI scheme.');
          return;
        }
        try {
          const created = await addModel({
            name: v.name,
            owner: user.name,
            scope: 'private',
            namespace,
            uri: v.uri,
            scheme,
            tags: ['ai-storage'],
            modelType: v.modelType || 'llm',
            sizeGB: 0,
            readme:
              v.readme || `# ${v.name}\n\nRegistered from AI Storage: \`${v.uri}\`.`,
          });
          message.success(`Registered ${created.name}`);
          if (onCreated) onCreated();
          else nav('/models/private');
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="Model name" rules={[{ required: true }]}>
          <Input placeholder="my-team/my-model" />
        </Form.Item>
        <Form.Item name="uri" label="Storage URI" rules={[{ required: true }]} extra="Pre-filled from the selected source. Editable.">
          <Input />
        </Form.Item>
        <Form.Item name="modelType" label="Model type">
          <Select options={MODEL_TYPE_OPTIONS.map(o => ({ label: o.label, value: o.id }))} />
        </Form.Item>
        <Form.Item name="readme" label="README.md (optional)">
          <Input.TextArea rows={3} placeholder="# Model title" />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          The model will be created under namespace <strong>{namespace}</strong>.
        </Typography.Paragraph>
      </Form>
    </Modal>
  );
}
