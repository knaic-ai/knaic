import { useEffect } from 'react';
import { App, Col, Form, Input, Modal, Row, Select } from 'antd';
import {
  createServingRuntime,
  updateServingRuntime,
  type ServingRuntime,
} from '@/data/inference';
import { useGPUProfiles, type GPUProfile } from '@/data/gpuProfiles';
import { GPUProfileFields } from '@/components/GPUProfileFields';

interface RuntimeFormShape {
  name: string;
  runtime: string;
  image: string;
  supportedModelFormats?: string[];
  defaultArgs?: string;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gpuProfileId?: string;
  gpuValues?: Record<string, number>;
}

interface Props {
  open: boolean;
  namespace: string;
  // When provided, the modal acts as Edit (PUT /inference/runtimes/{name});
  // otherwise it creates a new runtime.
  editing?: ServingRuntime | null;
  onClose: () => void;
}

const blankDefaults: RuntimeFormShape = {
  name: '',
  runtime: 'vllm',
  image: '',
  supportedModelFormats: ['huggingface'],
  defaultArgs: '',
  cpuRequest: '8',
  cpuLimit: '8',
  memoryRequest: '64Gi',
  memoryLimit: '64Gi',
};

// matchProfile picks the GPU profile whose declared resource keys equal the
// keys present on the existing runtime, so the edit form re-binds to that
// profile and shows its labeled inputs. Returns undefined when nothing
// matches — the user can still set gpuValues by reselecting a profile.
function matchProfile(
  profiles: GPUProfile[],
  gpuValues: Record<string, number> | undefined,
): string | undefined {
  if (!gpuValues || Object.keys(gpuValues).length === 0) return undefined;
  const have = new Set(Object.keys(gpuValues));
  for (const p of profiles) {
    const want = new Set(p.fields.map(f => f.key));
    if (want.size === have.size && [...want].every(k => have.has(k))) {
      return p.id;
    }
  }
  return undefined;
}

function defaultsFromRuntime(sr: ServingRuntime, profiles: GPUProfile[]): RuntimeFormShape {
  return {
    name: sr.name,
    runtime: sr.runtime,
    image: sr.image,
    supportedModelFormats: sr.supportedModelFormats,
    defaultArgs: (sr.defaultArgs ?? []).join('\n'),
    // ServingRuntime doesn't carry separate request/limit — re-use the value
    // for both fields and let the user widen the limit if they want.
    cpuRequest: sr.resources.cpu || '',
    cpuLimit: sr.resources.cpu || '',
    memoryRequest: sr.resources.memory || '',
    memoryLimit: sr.resources.memory || '',
    gpuProfileId: matchProfile(profiles, sr.gpuValues),
    gpuValues: sr.gpuValues,
  };
}

export function NewServingRuntimeModal({ open, namespace, editing, onClose }: Props) {
  const { message } = App.useApp();
  const profiles = useGPUProfiles();
  const [form] = Form.useForm<RuntimeFormShape>();
  const isEdit = !!editing;

  // Reset / prefill on open.
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(editing ? defaultsFromRuntime(editing, profiles) : blankDefaults);
  }, [open, editing, profiles, form]);

  // "Limit defaults to request" mirroring (matches the InferenceService modal).
  const cpuReq = Form.useWatch('cpuRequest', form);
  const memReq = Form.useWatch('memoryRequest', form);
  useEffect(() => {
    if (!open) return;
    const { cpuLimit, memoryLimit } = form.getFieldsValue(['cpuLimit', 'memoryLimit']);
    if (!cpuLimit || cpuLimit === '') form.setFieldValue('cpuLimit', cpuReq);
    if (!memoryLimit || memoryLimit === '') form.setFieldValue('memoryLimit', memReq);
  }, [cpuReq, memReq, open, form]);

  return (
    <Modal
      open={open}
      title={isEdit ? `Edit runtime · ${editing!.name}` : 'New serving runtime'}
      width={640}
      onCancel={onClose}
      destroyOnClose
      okText={isEdit ? 'Save' : 'Create'}
      onOk={async () => {
        const v = await form.validateFields();
        const profile = profiles.find(p => p.id === v.gpuProfileId);
        const gpuValues = profile && v.gpuValues ? v.gpuValues : undefined;
        const payload = {
          name: v.name,
          image: v.image,
          runtime: v.runtime,
          supportedModelFormats: v.supportedModelFormats,
          args: (v.defaultArgs ?? '').split('\n').map(s => s.trim()).filter(Boolean),
          cpuRequest: v.cpuRequest,
          cpuLimit: v.cpuLimit,
          memoryRequest: v.memoryRequest,
          memoryLimit: v.memoryLimit,
          gpuValues,
        };
        try {
          if (isEdit) {
            await updateServingRuntime(namespace, editing!.name, payload);
            message.success('Runtime updated');
          } else {
            await createServingRuntime(namespace, payload);
            message.success('Runtime created');
          }
          onClose();
        } catch (e) {
          message.error((e as Error).message);
        }
      }}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input placeholder="my-vllm" disabled={isEdit} />
        </Form.Item>
        <Form.Item name="runtime" label="Runtime family" rules={[{ required: true }]}>
          <Select options={['vllm', 'sglang', 'custom'].map(v => ({ label: v, value: v }))} />
        </Form.Item>
        <Form.Item name="image" label="Container image" rules={[{ required: true }]}>
          <Input placeholder="vllm/vllm-openai:v0.7.2" />
        </Form.Item>
        <Form.Item name="supportedModelFormats" label="Supported model formats">
          <Select mode="tags" />
        </Form.Item>
        <Form.Item name="defaultArgs" label="Default args (one per line)">
          <Input.TextArea rows={4} placeholder="--max-model-len&#10;32768" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="cpuRequest" label="CPU request" rules={[{ required: true }]}>
              <Input placeholder="8" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="cpuLimit"
              label="CPU limit"
              tooltip="Defaults to the request; editable."
              rules={[{ required: true }]}
            >
              <Input placeholder="8" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="memoryRequest" label="Memory request" rules={[{ required: true }]}>
              <Input placeholder="64Gi" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="memoryLimit"
              label="Memory limit"
              tooltip="Defaults to the request; editable."
              rules={[{ required: true }]}
            >
              <Input placeholder="64Gi" />
            </Form.Item>
          </Col>
        </Row>
        <GPUProfileFields />
      </Form>
    </Modal>
  );
}
