import { useEffect } from 'react';
import { App, Form, Input, Modal, Select } from 'antd';
import { useCollections, ensureCollectionsLoaded } from '@/data/collections';
import { createPublishRequest } from '@/api/publishRequests';
import { isPublicSource, type ModelItem } from '@/data/models';

interface Props {
  open: boolean;
  model: ModelItem | null;
  onClose: () => void;
  onCreated: () => void;
}

/** Asks the user for a target catalog name + optional collection, then POSTs
 * /api/v1/model-publish-requests. The server validates that the model URI
 * is publicly accessible before accepting. */
export function PublishRequestModal({ open, model, onClose, onCreated }: Props) {
  const { message } = App.useApp();
  const publicCollections = useCollections().filter(c => c.scope === 'public');
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) {
      ensureCollectionsLoaded('public');
      // Suggest a catalog name from the private model's bare name; admins
      // can edit before approval but the requester sets the default.
      const suggested = model?.name ?? '';
      form.setFieldsValue({
        targetName: suggested,
        targetCollectionId: model?.collectionId || undefined,
        note: '',
      });
    }
  }, [open, model, form]);

  if (!model) return null;
  const eligible = isPublicSource(model.uri);

  return (
    <Modal
      open={open}
      title={`Request to publish ${model.name} to Model Catalog`}
      onCancel={onClose}
      destroyOnClose
      okText="Submit request"
      okButtonProps={{ disabled: !eligible }}
      onOk={async () => {
        const v = await form.validateFields();
        try {
          await createPublishRequest({
            privateModelId: model.id,
            targetName: v.targetName,
            targetCollectionId: v.targetCollectionId || undefined,
            note: v.note || undefined,
          });
          onCreated();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      {!eligible && (
        <p style={{ color: 'var(--knaic-warning, #d4380d)' }}>
          This model's URI <code>{model.uri}</code> is not publicly accessible. Only models stored
          on <code>hf://</code>, <code>hf-mirror://</code>, <code>modelscope://</code>, or HTTP(S)
          URLs can be published to the catalog.
        </p>
      )}
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="targetName"
          label="Catalog name"
          rules={[{ required: true, message: 'A catalog name is required.' }]}
        >
          <Input placeholder="my-org/model-name" />
        </Form.Item>
        <Form.Item name="targetCollectionId" label="Collection (optional)">
          <Select
            allowClear
            placeholder="Group with an existing public collection"
            options={publicCollections.map(c => ({ label: c.name, value: c.id }))}
          />
        </Form.Item>
        <Form.Item name="note" label="Note for reviewer">
          <Input.TextArea rows={3} placeholder="Why should this model be in the public catalog?" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
