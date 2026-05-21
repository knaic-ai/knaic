import { useEffect, useMemo, useState } from 'react';
import { App, Button, Form, Input, Modal, Segmented, Select, Space } from 'antd';
import { createClusterYaml } from '@/api/k8sres';
import {
  buildCacheYaml,
  reloadLocalModel,
  useLocalModelNodeGroups,
} from '@/data/localModelCache';
import { ensureModelsLoaded, useModels } from '@/data/models';

// roundUpGi turns the Model Hub's sizeGB (float64 GB) into a Quantity string
// that fits the LocalModelCache.spec.modelSize requirement. We ceil with a
// small slack (20%) because download artifacts on disk are routinely larger
// than the headline "size" — partial weights, tokeniser shards, etc.
function roundUpGi(sizeGB: number): string {
  if (!sizeGB || sizeGB <= 0) return '';
  const padded = sizeGB * 1.2;
  const gi = Math.max(1, Math.ceil(padded));
  return `${gi}Gi`;
}

interface CacheFormShape {
  name: string;
  sourceModelUri: string;
  modelSize: string;
  nodeGroups: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function blankCache(): CacheFormShape {
  return { name: '', sourceModelUri: '', modelSize: '', nodeGroups: [] };
}

export function NewLocalModelCacheModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<CacheFormShape>();
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const initialValues = useMemo(() => blankCache(), []);
  const nodeGroups = useLocalModelNodeGroups();
  const models = useModels();

  // LocalModelCache is cluster-scoped, so we only surface public models —
  // private models live inside a single namespace and pulling one cluster-wide
  // would expose it beyond its tenant. Admins who really want a namespaced
  // private model can flip to YAML mode and paste any URI.
  useEffect(() => {
    if (open) {
      ensureModelsLoaded('public');
    }
  }, [open]);

  const modelOpts = useMemo(
    () =>
      models
        .filter(m => m.scope === 'public' && m.uri)
        .map(m => ({ label: `${m.name} — ${m.uri}`, value: m.uri })),
    [models],
  );

  // When the user picks a model from the hub, autofill modelSize from
  // sizeGB so they don't have to look it up. They can still hand-edit.
  const onModelChange = (uri: string) => {
    const m = models.find(x => x.uri === uri);
    if (!m) return;
    const cur = form.getFieldValue('modelSize');
    const suggested = roundUpGi(m.sizeGB);
    if (suggested && !cur) {
      form.setFieldValue('modelSize', suggested);
    }
  };

  const handleClose = () => {
    form.resetFields();
    setYamlText('');
    setMode('form');
    onClose();
  };

  const generateYaml = () => {
    const v = form.getFieldsValue(true) as CacheFormShape;
    setYamlText(buildCacheYaml({
      name: v.name ?? '',
      sourceModelUri: v.sourceModelUri ?? '',
      modelSize: v.modelSize ?? '',
      nodeGroups: v.nodeGroups ?? [],
    }));
  };

  const onOk = async () => {
    if (mode === 'yaml') {
      const text = yamlText.trim();
      if (!text) {
        message.error('YAML body is empty');
        return;
      }
      if (!/\bkind:\s*LocalModelCache\b/.test(text)) {
        message.error('YAML kind must be LocalModelCache');
        return;
      }
      try {
        await createClusterYaml('localmodelcaches', text);
        await reloadLocalModel();
        message.success('LocalModelCache created');
        handleClose();
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Failed to create LocalModelCache');
      }
      return;
    }
    const v = await form.validateFields();
    try {
      const yaml = buildCacheYaml({
        name: v.name,
        sourceModelUri: v.sourceModelUri,
        modelSize: v.modelSize,
        nodeGroups: v.nodeGroups ?? [],
      });
      await createClusterYaml('localmodelcaches', yaml);
      await reloadLocalModel();
      message.success('LocalModelCache created');
      handleClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create LocalModelCache');
    }
  };

  return (
    <Modal
      open={open}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 28 }}>
          <span>New LocalModelCache</span>
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
      width={680}
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
              Paste your manifest or regenerate it from the form values.
            </span>
          </Space>
          <Input.TextArea
            value={yamlText}
            onChange={e => setYamlText(e.target.value)}
            rows={22}
            spellCheck={false}
            className="mono"
            style={{ fontSize: 12, lineHeight: 1.45 }}
            placeholder={'apiVersion: serving.kserve.io/v1alpha1\nkind: LocalModelCache\n…'}
          />
        </>
      ) : (
        <Form form={form} layout="vertical" initialValues={initialValues}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="meta-llama3-8b-instruct" />
          </Form.Item>
          <Form.Item
            name="sourceModelUri"
            label="Source model URI"
            tooltip="Pick a model from the knaic Model Hub. Its URI (hf://, s3://, oci://, …) becomes the LocalModelCache.spec.sourceModelUri. To use a private/namespaced model, flip to YAML mode."
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              options={modelOpts}
              placeholder={modelOpts.length ? 'Pick a model from the hub' : 'No public models in the hub yet'}
              onChange={onModelChange}
              filterOption={(input, option) =>
                !!option && String(option.label).toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            name="modelSize"
            label="Model size"
            tooltip="Approximate on-disk size of the cached model (Quantity, e.g. 10Gi)."
            rules={[{ required: true }]}
          >
            <Input placeholder="10Gi" />
          </Form.Item>
          <Form.Item
            name="nodeGroups"
            label="Node groups"
            tooltip="Each LocalModelNodeGroup the cache should download onto."
            rules={[{ required: true, type: 'array', min: 1, message: 'Pick at least one node group' }]}
          >
            <Select
              mode="multiple"
              placeholder={nodeGroups.length ? 'Select node groups' : 'No node groups exist yet — create one first'}
              options={nodeGroups.map(g => ({ label: g.name, value: g.name }))}
            />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}
