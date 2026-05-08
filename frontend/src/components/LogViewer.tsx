import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Space, Select, Tag } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { streamPodLogs } from '@/api/k8sres';
import {
  listInferenceServicePods,
  streamInferenceServiceLogs,
  type InferencePodInfo,
} from '@/api/inference';
import { apiEnabled } from '@/api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  containers?: string[];

  /** When set, the viewer streams real pod logs from the backend. */
  podRef?: { namespace: string; name: string };

  /**
   * Streams logs for the pod backing an inference service. The viewer
   * fetches the candidate pod list from the backend and renders a pod
   * picker — useful during a rolling update when there's both an old and a
   * new ReplicaSet, and lets users open init containers like
   * `storage-initializer` after they've completed.
   */
  inferenceRef?: { namespace: string; name: string; kind: 'InferenceService' | 'LLMInferenceService' };

  /** Fallback for prototype mode (no backend log source). */
  sampleLines?: (container: string) => string[];
}

const defaultSample = (container: string) => [
  `[INFO ] starting container ${container}`,
  `[INFO ] loading config from /etc/${container}/config.yaml`,
  `[INFO ] initializing modules …`,
  `[DEBUG] registered route /healthz`,
  `[DEBUG] registered route /metrics`,
  `[INFO ] listening on :8080`,
  `[INFO ] ready`,
];

interface ContainerOption {
  label: React.ReactNode;
  value: string;
  init?: boolean;
}

function podLabel(p: InferencePodInfo): React.ReactNode {
  return (
    <Space size={6}>
      <span className="mono" style={{ fontSize: 12 }}>{p.name}</span>
      {p.ready ? (
        <Tag color="success" style={{ marginRight: 0 }}>ready</Tag>
      ) : (
        <Tag color={p.phase === 'Running' ? 'processing' : 'default'} style={{ marginRight: 0 }}>{p.phase}</Tag>
      )}
    </Space>
  );
}

function containerOptions(pod: InferencePodInfo | undefined, fallback: string[]): ContainerOption[] {
  if (!pod) {
    return fallback.map(c => ({ label: c, value: c }));
  }
  const opts: ContainerOption[] = [];
  for (const c of pod.containers) {
    opts.push({ label: c, value: c });
  }
  for (const c of pod.initContainers ?? []) {
    opts.push({
      label: (
        <Space size={4}>
          <span>{c}</span>
          <Tag color="purple" style={{ marginRight: 0 }}>init</Tag>
        </Space>
      ),
      value: c,
      init: true,
    });
  }
  return opts;
}

export function LogViewer({ open, onClose, title, containers = ['main'], podRef, inferenceRef, sampleLines }: Props) {
  const [pods, setPods] = useState<InferencePodInfo[]>([]);
  const [podName, setPodName] = useState<string>('');
  const [container, setContainer] = useState(containers[0]);
  const [previous, setPrevious] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const fakeTimer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fallbackToFake = (!podRef && !inferenceRef) || !apiEnabled;

  const selectedPod = useMemo(
    () => pods.find(p => p.name === podName),
    [pods, podName],
  );

  // Fetch the pod list whenever the inference target changes or the user
  // hits the reload button. We refetch on each open so the list reflects a
  // rolling-update mid-flight.
  useEffect(() => {
    if (!open || !inferenceRef || fallbackToFake) {
      setPods([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await listInferenceServicePods(inferenceRef.namespace, inferenceRef.name, inferenceRef.kind);
        if (cancelled) return;
        setPods(list);
        setPodName(prev => (prev && list.some(p => p.name === prev) ? prev : list[0]?.name ?? ''));
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [open, inferenceRef?.namespace, inferenceRef?.name, inferenceRef?.kind, fallbackToFake, reloadTick]);

  // Re-derive container options when the selected pod changes (init
  // containers on the new pod may differ from the old one).
  const ctrOpts = useMemo(
    () => containerOptions(selectedPod, containers),
    [selectedPod, containers],
  );

  // Keep the container selection valid when the pod changes — fall back to
  // the first non-init container for the new pod.
  useEffect(() => {
    if (ctrOpts.length === 0) return;
    if (!ctrOpts.some(o => o.value === container)) {
      const firstApp = ctrOpts.find(o => !o.init) ?? ctrOpts[0];
      setContainer(firstApp.value);
    }
  }, [ctrOpts, container]);

  const isInit = useMemo(() => ctrOpts.some(o => o.value === container && o.init), [ctrOpts, container]);

  // The actual streaming.
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      if (fakeTimer.current) window.clearInterval(fakeTimer.current);
      setLines([]);
      setErr(null);
      setStreaming(false);
      return;
    }
    setLines([]);
    setErr(null);

    if (fallbackToFake) {
      const base = (sampleLines ?? defaultSample)(container);
      setLines(base);
      fakeTimer.current = window.setInterval(() => {
        setLines(prev => [
          ...prev,
          `[${new Date().toISOString().slice(11, 19)}] heartbeat ok — rss=${Math.floor(Math.random() * 200 + 400)}MiB`,
        ]);
      }, 1500);
      return () => {
        if (fakeTimer.current) window.clearInterval(fakeTimer.current);
      };
    }

    if (inferenceRef && !podName) return; // wait for pod list to arrive

    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming(true);
    const opts = {
      container,
      // Don't follow init containers — they almost always have terminated by
      // the time the user opens the viewer, and follow=true would just hang.
      follow: !isInit && !previous,
      previous,
      tailLines: 200,
      signal: ac.signal,
      onLine: (line: string) => setLines(prev => [...prev, line]),
      onEnd: () => setStreaming(false),
      onError: (e: Error) => {
        setErr(e.message);
        setStreaming(false);
      },
    };
    if (podRef) {
      void streamPodLogs(podRef.namespace, podRef.name, opts);
    } else if (inferenceRef && podName) {
      // Stream from the chosen pod directly, not the auto-resolved one, so
      // the picker actually controls which pod's logs are shown.
      void streamPodLogs(inferenceRef.namespace, podName, opts);
    } else if (inferenceRef) {
      void streamInferenceServiceLogs(inferenceRef.namespace, inferenceRef.name, inferenceRef.kind, opts);
    }
    return () => ac.abort();
  }, [
    open,
    container,
    podRef?.namespace,
    podRef?.name,
    inferenceRef?.namespace,
    inferenceRef?.name,
    inferenceRef?.kind,
    podName,
    previous,
    isInit,
    fallbackToFake,
    sampleLines,
    reloadTick,
  ]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  const showPodPicker = !!inferenceRef && !fallbackToFake;
  const podOpts = useMemo(
    () => pods.map(p => ({ label: podLabel(p), value: p.name })),
    [pods],
  );

  return (
    <Modal
      open={open}
      title={
        <Space>
          {title}
          {streaming && <Tag color="processing">streaming</Tag>}
          {isInit && <Tag color="purple">init container</Tag>}
          {err && <Tag color="error">stream error</Tag>}
        </Space>
      }
      onCancel={onClose}
      width={920}
      footer={null}
      destroyOnClose
    >
      <Space style={{ marginBottom: 8 }} wrap>
        {showPodPicker && (
          <>
            <span className="knaic-sub">Pod</span>
            <Select
              size="small"
              value={podName || undefined}
              onChange={setPodName}
              options={podOpts}
              placeholder="(no matching pods)"
              style={{ minWidth: 320 }}
              notFoundContent="No pods backing this service yet."
            />
          </>
        )}
        <span className="knaic-sub">Container</span>
        <Select
          size="small"
          value={container}
          onChange={setContainer}
          options={ctrOpts}
          style={{ minWidth: 220 }}
        />
        {isInit && (
          // For init containers, "previous" pulls the logs that survived the
          // pod's last restart — useful when the init failed and the kubelet
          // already restarted it.
          <Button
            size="small"
            type={previous ? 'primary' : 'default'}
            onClick={() => setPrevious(p => !p)}
          >
            {previous ? 'Previous logs' : 'Current logs'}
          </Button>
        )}
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => {
            setLines([]);
            setReloadTick(t => t + 1);
          }}
        >
          Reload
        </Button>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          onClick={() => {
            const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${title}.log`;
            a.click();
          }}
        >
          Download
        </Button>
      </Space>
      {err && <div style={{ color: '#e94f4f', marginBottom: 8 }}>{err}</div>}
      <div className="log-viewer" ref={boxRef}>
        {lines.join('\n')}
      </div>
    </Modal>
  );
}
