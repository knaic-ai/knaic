import { useEffect, useMemo, useState } from 'react';
import {
  App,
  AutoComplete,
  Button,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
} from 'antd';
import { createClusterYaml } from '@/api/k8sres';
import {
  buildNodeGroupYaml,
  reloadLocalModel,
  useLocalModelOptions,
  useLocalModelStatus,
} from '@/data/localModelCache';

interface NodeGroupFormShape {
  name: string;
  storageLimit: string;
  capacity: string;
  storageClassName: string;
  localPath: string;
  selectorKey: string;
  selectorValues: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function blankNodeGroup(localPath: string): NodeGroupFormShape {
  return {
    name: '',
    storageLimit: '500Gi',
    capacity: '500Gi',
    storageClassName: 'local-storage',
    localPath: localPath || '/mnt/models',
    selectorKey: 'kubernetes.io/hostname',
    selectorValues: [],
  };
}

export function NewLocalModelNodeGroupModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const status = useLocalModelStatus();
  const options = useLocalModelOptions();
  const [form] = Form.useForm<NodeGroupFormShape>();
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const initialValues = useMemo(() => blankNodeGroup(status.hostPath ?? ''), [status.hostPath]);

  // Node-selector keys: cluster's full label-key set, with the most common
  // sensible defaults at the top. We push 'kubernetes.io/hostname' first
  // since pinning the cache to a specific node by hostname is the canonical
  // KServe example.
  const nodeKeyOptions = useMemo(() => {
    const preferred = ['kubernetes.io/hostname', 'node-role.kubernetes.io/worker'];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const k of preferred) if (!seen.has(k)) { seen.add(k); ordered.push(k); }
    for (const k of options.nodeLabelKeys) if (!seen.has(k)) { seen.add(k); ordered.push(k); }
    return ordered.map(k => ({ label: k, value: k }));
  }, [options.nodeLabelKeys]);

  // StorageClass picker: ensures local-storage is offered even if the
  // cluster doesn't have a StorageClass object with that name yet (the PV
  // template references it as a label only, not a real provisioner).
  const storageClassOptions = useMemo(() => {
    const names = new Set<string>(options.storageClasses);
    names.add('local-storage');
    return Array.from(names)
      .sort((a, b) => (a === 'local-storage' ? -1 : b === 'local-storage' ? 1 : a.localeCompare(b)))
      .map(n => ({ label: n, value: n }));
  }, [options.storageClasses]);

  // When the modal opens we want the localPath placeholder to reflect the
  // currently detected hostPath. Pushing it onto the form so the field is
  // pre-filled (and editable) rather than just shown as a tooltip.
  useEffect(() => {
    if (open) {
      form.setFieldsValue({ localPath: status.hostPath || '/mnt/models' });
    }
  }, [open, status.hostPath, form]);

  const handleClose = () => {
    form.resetFields();
    setYamlText('');
    setMode('form');
    onClose();
  };

  const generateYaml = () => {
    const v = form.getFieldsValue(true) as NodeGroupFormShape;
    setYamlText(buildNodeGroupYaml({
      name: v.name ?? '',
      storageLimit: v.storageLimit ?? '',
      capacity: v.capacity || v.storageLimit || '',
      storageClassName: v.storageClassName ?? '',
      localPath: v.localPath ?? '',
      selectorKey: v.selectorKey ?? 'kubernetes.io/hostname',
      selectorValues: v.selectorValues ?? [],
    }));
  };

  const onOk = async () => {
    if (mode === 'yaml') {
      const text = yamlText.trim();
      if (!text) {
        message.error('YAML body is empty');
        return;
      }
      if (!/\bkind:\s*LocalModelNodeGroup\b/.test(text)) {
        message.error('YAML kind must be LocalModelNodeGroup');
        return;
      }
      try {
        await createClusterYaml('localmodelnodegroups', text);
        await reloadLocalModel();
        message.success('LocalModelNodeGroup created');
        handleClose();
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Failed to create LocalModelNodeGroup');
      }
      return;
    }
    const v = await form.validateFields();
    try {
      const yaml = buildNodeGroupYaml({
        name: v.name,
        storageLimit: v.storageLimit,
        capacity: v.capacity || v.storageLimit,
        storageClassName: v.storageClassName,
        localPath: v.localPath,
        selectorKey: v.selectorKey || 'kubernetes.io/hostname',
        selectorValues: v.selectorValues ?? [],
      });
      await createClusterYaml('localmodelnodegroups', yaml);
      await reloadLocalModel();
      message.success('LocalModelNodeGroup created');
      handleClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create LocalModelNodeGroup');
    }
  };

  return (
    <Modal
      open={open}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 28 }}>
          <span>New LocalModelNodeGroup</span>
          <Segmented
            value={mode}
            onChange={v => {
              const next = v as 'form' | 'yaml';
              if (next === 'yaml' && !yamlText) generateYaml();
              setMode(next);
            }}
            options={[
              { label: 'Form', value: 'form' },
              { label: 'YAML', value: 'yaml' },
            ]}
          />
        </div>
      }
      width={760}
      destroyOnClose
      onCancel={handleClose}
      onOk={onOk}
      okText="Create"
    >
      {mode === 'yaml' ? (
        <>
          <Space style={{ marginBottom: 8 }}>
            <Button size="small" onClick={generateYaml}>Regenerate from form</Button>
            <span className="knaic-sub" style={{ fontSize: 12 }}>
              Form mode generates a minimal NodeGroup. Flip to YAML to customise PV/PVC defaults or affinity.
            </span>
          </Space>
          <Input.TextArea
            value={yamlText}
            onChange={e => setYamlText(e.target.value)}
            rows={22}
            spellCheck={false}
            className="mono"
            style={{ fontSize: 12, lineHeight: 1.45 }}
            placeholder={'apiVersion: serving.kserve.io/v1alpha1\nkind: LocalModelNodeGroup\n…'}
          />
        </>
      ) : (
        <Form form={form} layout="vertical" initialValues={initialValues}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="workers" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="storageLimit"
                label="Storage limit"
                tooltip="Maximum cache storage to use per node (Quantity)."
                rules={[{ required: true }]}
              >
                <Input placeholder="500Gi" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="capacity"
                label="PV capacity"
                tooltip="storage value used for both the PV and PVC templates. Defaults to storageLimit if left blank."
              >
                <Input placeholder="500Gi" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="storageClassName"
                label="Storage class"
                tooltip={
                  'KServe writes cached blobs to a node-local hostPath, so the PV/PVC must bind to a class that does not dynamically provision elsewhere. local-storage is the recommended default — pick a different class only if you have a static provisioner that also pins volumes to the same node as the agent.'
                }
                rules={[{ required: true }]}
              >
                <Select
                  showSearch
                  options={storageClassOptions}
                  placeholder="local-storage"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="localPath"
                label="Host path"
                tooltip={
                  status.installed
                    ? `Must equal the agent DaemonSet's models hostPath (${status.hostPath || 'detected'}).`
                    : 'Must equal the kserve-localmodelnode-agent DaemonSet models volume hostPath.'
                }
                rules={[{ required: true }]}
              >
                <Input placeholder="/mnt/models" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item
                name="selectorKey"
                label="Node selector key"
                tooltip="Label key for the matchExpression that selects nodes into this group. Suggestions come from cluster node labels; you can also type a custom key."
              >
                <AutoComplete
                  options={nodeKeyOptions}
                  filterOption={(input, option) =>
                    !!option && String(option.value).toLowerCase().includes(input.toLowerCase())
                  }
                  placeholder="kubernetes.io/hostname"
                />
              </Form.Item>
            </Col>
            <Col span={14}>
              <Form.Item
                name="selectorValues"
                label="Node selector values"
                tooltip="Press Enter to add each value. matchExpression operator is In."
                rules={[{ required: true, type: 'array', min: 1, message: 'Pick at least one value' }]}
              >
                <Select mode="tags" tokenSeparators={[',']} placeholder="worker-0" open={false} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      )}
    </Modal>
  );
}
