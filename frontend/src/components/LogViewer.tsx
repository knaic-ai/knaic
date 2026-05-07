import { useEffect, useRef, useState } from 'react';
import { Modal, Button, Space, Select, Tag } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { streamPodLogs } from '@/api/k8sres';
import { streamInferenceServiceLogs } from '@/api/inference';
import { apiEnabled } from '@/api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  containers?: string[];

  /** When set, the viewer streams real pod logs from the backend. */
  podRef?: { namespace: string; name: string };

  /** Streams logs for the pod backing an inference service. */
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

export function LogViewer({ open, onClose, title, containers = ['main'], podRef, inferenceRef, sampleLines }: Props) {
  const [container, setContainer] = useState(containers[0]);
  const [lines, setLines] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fakeTimer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fallbackToFake = (!podRef && !inferenceRef) || !apiEnabled;

  useEffect(() => {
    setContainer(containers[0]);
  }, [containers, podRef?.name, inferenceRef?.name]);

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

    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming(true);
    const opts = {
      container,
      follow: true,
      tailLines: 200,
      signal: ac.signal,
      onLine: (line: string) => setLines(prev => [...prev, line]),
      onEnd: () => setStreaming(false),
      onError: (e: Error) => {
        setErr(e.message);
        setStreaming(false);
      },
    };
    void (podRef
      ? streamPodLogs(podRef.namespace, podRef.name, opts)
      : streamInferenceServiceLogs(inferenceRef!.namespace, inferenceRef!.name, inferenceRef!.kind, opts));
    return () => ac.abort();
  }, [
    open,
    container,
    podRef?.namespace,
    podRef?.name,
    inferenceRef?.namespace,
    inferenceRef?.name,
    inferenceRef?.kind,
    fallbackToFake,
    sampleLines,
  ]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  return (
    <Modal
      open={open}
      title={
        <Space>
          {title}
          {streaming && <Tag color="processing">streaming</Tag>}
          {err && <Tag color="error">stream error</Tag>}
        </Space>
      }
      onCancel={onClose}
      width={860}
      footer={null}
      destroyOnClose
    >
      <Space style={{ marginBottom: 8 }}>
        <span className="knaic-sub">Container</span>
        <Select
          size="small"
          value={container}
          onChange={setContainer}
          options={containers.map(c => ({ label: c, value: c }))}
          style={{ width: 180 }}
        />
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => {
            // Force a re-stream by toggling container.
            setContainer(c => c);
            setLines([]);
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
