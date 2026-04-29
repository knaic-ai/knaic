import { useEffect, useRef, useState } from 'react';
import { Card, Select, Input, Button, Space, Tag, App } from 'antd';
import { ThunderboltOutlined, SendOutlined, ClearOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { useProviders } from '@/data/playground';
import { agentStream, type ChatMessage } from './fakeStream';

interface AgentStep {
  kind: 'thought' | 'action' | 'observation' | 'final';
  text: string;
}

export function Agent() {
  const providers = useProviders();
  const { message } = App.useApp();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<HTMLDivElement | null>(null);

  const tools = [
    'kubectl_list',
    'kubectl_logs',
    'model_hub_search',
    'prometheus_query',
    'finalize',
  ];

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [steps]);

  async function run() {
    const provider = providers.find(p => p.id === providerId);
    if (!input.trim() || !provider) return;
    const newHistory: ChatMessage[] = [...history, { role: 'user', content: input.trim() }];
    setHistory(newHistory);
    setInput('');
    setBusy(true);
    try {
      const gen = agentStream({ model: provider.model, temperature: 0.2, system: 'ReAct agent', history: newHistory });
      for await (const step of gen) {
        setSteps(prev => [...prev, step]);
        if (step.kind === 'final') {
          setHistory(h => [...h, { role: 'assistant', content: step.text }]);
        }
      }
    } catch (e) {
      message.error('Agent run failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="knaic-page">
      <PageHeader
        title="Playground · Agent"
        description="A simple ReAct-style agent (thought → action → observation → final). Wires the LLM to in-cluster tools like kubectl and Prometheus queries."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
        <Card size="small" title="Agent config">
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className="knaic-sub">LLM service</div>
              <Select
                style={{ width: '100%' }}
                value={providerId}
                onChange={setProviderId}
                options={providers.map(p => ({ label: p.name, value: p.id }))}
              />
            </div>
            <div>
              <div className="knaic-sub">Tools (langchain)</div>
              <Space wrap size={4}>
                {tools.map(t => (
                  <Tag key={t} color="blue">{t}</Tag>
                ))}
              </Space>
            </div>
            <Button block icon={<ClearOutlined />} onClick={() => { setSteps([]); setHistory([]); }}>
              Reset
            </Button>
            <div className="knaic-sub">Try: <i>"is everything running in team-ml?"</i> or <i>"which qwen models do we have?"</i></div>
          </Space>
        </Card>

        <Card size="small" title={<Space><ThunderboltOutlined /> Agent trace</Space>}>
          <div className="chat-scroll" style={{ height: 480 }} ref={scroll}>
            {steps.length === 0 && (
              <div className="knaic-sub" style={{ textAlign: 'center', padding: 40 }}>
                Ask something to see the agent reason, call tools and return a final answer.
              </div>
            )}
            {steps.map((s, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <Tag color={
                  s.kind === 'thought' ? 'default'
                  : s.kind === 'action' ? 'blue'
                  : s.kind === 'observation' ? 'gold'
                  : 'green'
                }>
                  {s.kind}
                </Tag>
                <div className={s.kind === 'final' ? 'chat-bubble assistant' : 'chat-bubble tool'} style={{ marginTop: 4 }}>
                  {s.text}
                </div>
              </div>
            ))}
          </div>
          <Space.Compact style={{ width: '100%', marginTop: 8 }}>
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask the agent"
              onPressEnter={run}
            />
            <Button type="primary" loading={busy} icon={<SendOutlined />} onClick={run}>Run</Button>
          </Space.Compact>
        </Card>
      </div>
    </div>
  );
}
