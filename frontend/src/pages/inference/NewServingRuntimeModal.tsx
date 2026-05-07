import { useEffect, useMemo } from 'react';
import { App, Col, Collapse, Form, Input, InputNumber, Modal, Row, Select, Switch } from 'antd';
import {
  createServingRuntime,
  defaultArgsForRuntimeFamily,
  defaultRuntimeSecurityContext,
  defaultServingRuntimeArgs,
  updateServingRuntime,
  type RuntimeSecurityContext,
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
  securityContext: RuntimeSecurityContext;
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

function formatArgs(args: string[]): string {
  return args.join('\n');
}

function defaultArgsForRuntime(runtime: string): string {
  return formatArgs(defaultArgsForRuntimeFamily(runtime));
}

function blankDefaults(): RuntimeFormShape {
  return {
    name: '',
    runtime: 'vllm',
    image: '',
    supportedModelFormats: ['huggingface'],
    defaultArgs: defaultArgsForRuntime('vllm'),
    securityContext: defaultRuntimeSecurityContext(),
    cpuRequest: '8',
    cpuLimit: '8',
    memoryRequest: '64Gi',
    memoryLimit: '64Gi',
  };
}

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
    defaultArgs: (sr.defaultArgs ?? []).join('\n') || defaultArgsForRuntime(sr.runtime),
    securityContext: sr.securityContext ?? defaultRuntimeSecurityContext(),
    cpuRequest: sr.cpuRequest ?? sr.resources.cpu ?? '',
    cpuLimit: sr.cpuLimit ?? sr.resources.cpu ?? '',
    memoryRequest: sr.memoryRequest ?? sr.resources.memory ?? '',
    memoryLimit: sr.memoryLimit ?? sr.resources.memory ?? '',
    gpuProfileId: matchProfile(profiles, sr.gpuValues),
    gpuValues: sr.gpuValues,
  };
}

export function NewServingRuntimeModal({ open, namespace, editing, onClose }: Props) {
  const { message } = App.useApp();
  const profiles = useGPUProfiles();
  const [form] = Form.useForm<RuntimeFormShape>();
  const isEdit = !!editing;

  // Computed once per open + editing change. The Form below carries the
  // matching `key` so it remounts with these as initialValues — that's the
  // antd-recommended pattern when the form is shown inside a Modal with
  // destroyOnClose, and avoids the setFieldsValue/race we used to have.
  const initialValues = useMemo<RuntimeFormShape>(
    () => (editing ? defaultsFromRuntime(editing, profiles) : blankDefaults()),
    [editing, profiles],
  );
  const formKey = `${editing?.name ?? 'new'}::${profiles.length}`;

  // When the runtime family changes, replace the args block with the family
  // default — but only if the current value is empty or matches a known
  // default, so user-customised args aren't clobbered.
  const runtime = Form.useWatch('runtime', form);
  useEffect(() => {
    if (!open) return;
    const current = (form.getFieldValue('defaultArgs') ?? '').trim();
    const knownDefaults = Object.values(defaultServingRuntimeArgs).map(args => formatArgs(args).trim());
    if (current === '' || knownDefaults.includes(current)) {
      form.setFieldValue('defaultArgs', defaultArgsForRuntime(runtime ?? ''));
    }
  }, [runtime, open, form]);

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
          securityContext: v.securityContext,
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
      <Form key={formKey} form={form} layout="vertical" initialValues={initialValues}>
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
          <Input.TextArea
            autoSize={{ minRows: 4, maxRows: 20 }}
            placeholder="--max-model-len&#10;32768"
          />
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
        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'security',
              label: 'Security context',
              children: (
                <>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item
                        name={['securityContext', 'allowPrivilegeEscalation']}
                        label="Allow privilege escalation"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name={['securityContext', 'privileged']}
                        label="Privileged"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item
                        name={['securityContext', 'runAsNonRoot']}
                        label="Run as non-root"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name={['securityContext', 'runAsUser']} label="Run as user">
                        <InputNumber min={0} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item name={['securityContext', 'capabilities', 'drop']} label="Capabilities drop">
                        <Select mode="tags" options={[{ label: 'ALL', value: 'ALL' }]} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name={['securityContext', 'capabilities', 'add']} label="Capabilities add">
                        <Select mode="tags" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item name={['securityContext', 'seccompProfile', 'type']} label="Seccomp profile">
                    <Select
                      options={['RuntimeDefault', 'Unconfined'].map(v => ({ label: v, value: v }))}
                    />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}
