import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import { CodeOutlined, ImportOutlined } from '@ant-design/icons';
import { createNamespacedYaml, fetchYaml, listCluster } from '@/api/k8sres';
import { reloadRuntimes } from '@/data/inference';

const { Paragraph, Text } = Typography;

interface ClusterRuntimeItem {
  id?: string;
  name: string;
  // The list endpoint projects only the bits we render in the picker; we
  // leave room for runtime/image to drive the per-row hint when present.
  runtime?: string;
  image?: string;
  supportedModelFormats?: string[];
}

interface Props {
  open: boolean;
  namespace: string;
  onClose: () => void;
}

// ImportClusterRuntimeModal copies a ClusterServingRuntime into the current
// namespace as a namespaced ServingRuntime. Flow:
//
//   1. List ClusterServingRuntime cluster-wide.
//   2. User picks one + optionally renames it.
//   3. We fetch its YAML, mutate the manifest (kind, metadata.namespace,
//      strip clusterRefs / status / resourceVersion etc.), and POST to the
//      generic /namespaces/{ns}/servingruntimes YAML endpoint.
//
// The conversion is intentionally textual — most ClusterServingRuntime CRs
// in the wild are kept close to the namespaced shape, and any per-field
// migration is the user's call once they see the YAML.
export function ImportClusterRuntimeModal({ open, namespace, onClose }: Props) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ClusterRuntimeItem[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [preview, setPreview] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [name, setName] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelected(undefined);
    setPreview('');
    setName('');
    listCluster<ClusterRuntimeItem>('clusterservingruntimes')
      .then(setItems)
      .catch(e => {
        message.error((e as Error).message);
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [open, message]);

  // When the user picks a CSR, fetch its YAML and convert it to a
  // namespaced ServingRuntime preview. The user can edit before submitting.
  useEffect(() => {
    if (!selected) {
      setPreview('');
      return;
    }
    setPreviewLoading(true);
    fetchYaml('clusterservingruntimes', null, selected)
      .then(text => {
        const converted = convertClusterToNamespaced(text, namespace, name || selected);
        setPreview(converted);
      })
      .catch(e => {
        message.error((e as Error).message);
        setPreview('');
      })
      .finally(() => setPreviewLoading(false));
  }, [selected, namespace, message]);

  // Live-update the namespace + name fields in the preview as the user
  // edits the rename input — avoids the user having to re-pick the CSR.
  useEffect(() => {
    if (!preview || !selected) return;
    setPreview(prev => rewriteNameAndNamespace(prev, namespace, name || selected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const options = useMemo(
    () =>
      items.map(it => ({
        label: (
          <Space>
            <Text strong>{it.name}</Text>
            {it.runtime && <Text type="secondary">· {it.runtime}</Text>}
            {it.image && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {it.image}
              </Text>
            )}
          </Space>
        ),
        value: it.name,
      })),
    [items],
  );

  const submit = async () => {
    if (!preview.trim()) {
      message.error('Pick a ClusterServingRuntime first');
      return;
    }
    setSubmitting(true);
    try {
      await createNamespacedYaml('servingruntimes', namespace, preview);
      message.success(`Imported ${selected} → ${name || selected}`);
      reloadRuntimes(namespace);
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <Space>
          <ImportOutlined />
          <span>Import from ClusterServingRuntime</span>
        </Space>
      }
      width={860}
      onCancel={onClose}
      onOk={submit}
      okText="Create in this namespace"
      confirmLoading={submitting}
      okButtonProps={{ disabled: !preview.trim() }}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="What this does"
        description={
          <span>
            Reads the chosen <Text code>ClusterServingRuntime</Text>, converts
            it to a namespaced <Text code>ServingRuntime</Text> in{' '}
            <Text code>{namespace}</Text>, and creates it. The YAML is shown
            below — edit before submit if you want to tweak the image or args.
          </span>
        }
      />
      <Form layout="vertical">
        <Form.Item label="ClusterServingRuntime">
          <Select
            showSearch
            placeholder={loading ? 'Loading…' : 'Pick a runtime'}
            loading={loading}
            value={selected}
            onChange={v => {
              setSelected(v);
              setName('');
            }}
            optionFilterProp="value"
            options={options}
            notFoundContent={
              loading ? <Spin size="small" /> : <span>None found</span>
            }
          />
        </Form.Item>
        <Form.Item
          label="Target name in this namespace"
          tooltip="Defaults to the source name. Edit to avoid colliding with an existing namespaced runtime."
        >
          <Input
            placeholder={selected ?? 'name'}
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={!selected}
          />
        </Form.Item>
        <Form.Item label={<><CodeOutlined /> Preview (editable)</>}>
          <Input.TextArea
            value={preview}
            onChange={e => setPreview(e.target.value)}
            rows={18}
            spellCheck={false}
            className="mono"
            style={{ fontSize: 12, lineHeight: 1.45 }}
            placeholder={
              previewLoading
                ? 'Loading source manifest…'
                : 'Pick a ClusterServingRuntime above to populate.'
            }
          />
        </Form.Item>
      </Form>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Imported runtimes are tagged with{' '}
        <Text code>knaic.io/managed=true</Text> and{' '}
        <Text code>knaic.io/imported-from=&lt;source&gt;</Text> so you can
        trace them back.
      </Paragraph>
    </Modal>
  );
}

// convertClusterToNamespaced rewrites a ClusterServingRuntime manifest into
// a namespaced ServingRuntime. Kept textual:
//
//   - kind: ClusterServingRuntime → ServingRuntime
//   - inject metadata.namespace
//   - rename if a target name is given
//   - drop status / resourceVersion / uid / generation (apiserver assigns
//     these — leaving them in causes a 422 on create)
//   - add labels marking provenance
//
// This is good-enough for the upstream KServe ClusterServingRuntime shape;
// users with custom subresources can edit the preview before submitting.
function convertClusterToNamespaced(
  src: string,
  ns: string,
  targetName: string,
): string {
  let out = src;
  out = out.replace(/^kind:\s*ClusterServingRuntime\s*$/m, 'kind: ServingRuntime');
  // Strip the typical apiserver-assigned metadata block; we re-emit
  // metadata.namespace + name + labels via rewriteNameAndNamespace.
  out = out.replace(/^\s*resourceVersion:.*$/gm, '');
  out = out.replace(/^\s*uid:.*$/gm, '');
  out = out.replace(/^\s*generation:.*$/gm, '');
  out = out.replace(/^\s*creationTimestamp:.*$/gm, '');
  // managedFields block: starts at the indented key and runs until the
  // next top-level key (the apiserver always emits these adjacent to other
  // metadata, so we anchor on the trailing newline + non-indented key).
  out = out.replace(/^\s*managedFields:[\s\S]*?(?=\n[A-Za-z])/m, '');
  // The status block lives at the bottom; strip it entirely since the
  // apiserver re-emits status on Create.
  out = out.replace(/\nstatus:[\s\S]*$/, '');
  out = rewriteNameAndNamespace(out, ns, targetName);
  // Append our provenance labels if the source didn't already have them.
  if (!/knaic\.io\/imported-from/.test(out)) {
    out = injectLabels(out, {
      'knaic.io/managed': 'true',
      'knaic.io/component': 'inference',
      'knaic.io/imported-from': targetName,
    });
  }
  return out.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// rewriteNameAndNamespace patches metadata.name and metadata.namespace in
// the given manifest. Inserts the keys when missing, replaces them when
// present. We deliberately rebuild the metadata header rather than using a
// real YAML parser — small, predictable, no extra deps.
function rewriteNameAndNamespace(src: string, ns: string, name: string): string {
  let out = src;
  if (/^\s*name:.*$/m.test(out.split(/^metadata:/m)[1] ?? '')) {
    out = out.replace(/^(metadata:[\s\S]*?\n\s*name:\s*).*$/m, `$1${name}`);
  } else {
    out = out.replace(/^metadata:\s*$/m, `metadata:\n  name: ${name}`);
  }
  if (/^\s*namespace:.*$/m.test(out.split(/^metadata:/m)[1] ?? '')) {
    out = out.replace(/^(metadata:[\s\S]*?\n\s*namespace:\s*).*$/m, `$1${ns}`);
  } else {
    out = out.replace(
      /^(metadata:[\s\S]*?\n\s*name:\s*.*\n)/m,
      `$1  namespace: ${ns}\n`,
    );
  }
  return out;
}

// injectLabels appends entries to metadata.labels (creating the block when
// absent). String-level so we don't pull a YAML parser into the bundle for
// what is a one-shot template tweak.
function injectLabels(src: string, labels: Record<string, string>): string {
  const labelLines = Object.entries(labels)
    .map(([k, v]) => `    ${k}: "${v}"`)
    .join('\n');
  if (/^\s*labels:/m.test(src.split(/^metadata:/m)[1] ?? '')) {
    return src.replace(
      /^(metadata:[\s\S]*?\n\s*labels:\s*\n)/m,
      `$1${labelLines}\n`,
    );
  }
  return src.replace(
    /^(metadata:[\s\S]*?\n\s*namespace:\s*.*\n)/m,
    `$1  labels:\n${labelLines}\n`,
  );
}
