import { useEffect, useRef, useState } from 'react';
import { Card, Space, Select, Input, Button, Slider, App } from 'antd';
import { SendOutlined, ClearOutlined, PauseOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { useProviders } from '@/data/playground';
import { streamResponse, type ChatMessage } from './fakeStream';

export function Chat() {
  const providers = useProviders();
  const { message } = App.useApp();
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? '');
  const [system, setSystem] = useState('You are a helpful assistant running inside a Kubernetes cluster.');
  const [temperature, setTemperature] = useState(0.7);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const provider = providers.find(p => p.id === providerId);

  async function send() {
    if (!input.trim() || !provider) return;
    if (provider.status !== 'Ready') {
      message.warning(`Provider ${provider.name} is ${provider.status}`);
      return;
    }
    const history: ChatMessage[] = [
      ...messages,
      { role: 'user', content: input.trim() },
      { role: 'assistant', content: '' },
    ];
    setMessages(history);
    setInput('');
    setStreaming(true);
    cancelRef.current = streamResponse(
      { model: provider.model, temperature, system, history: history.slice(0, -1) },
      chunk => {
        setMessages(prev => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + chunk };
          return copy;
        });
      },
      () => setStreaming(false),
    );
  }

  return (
    <div className="knaic-page">
      <PageHeader title="Playground · Chat" description="Stream responses from an OpenAI-compatible endpoint." />
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
        <Card size="small" title="Conversation settings">
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className="knaic-sub">LLM service</div>
              <Select
                style={{ width: '100%' }}
                value={providerId}
                onChange={setProviderId}
                options={providers.map(p => ({ label: `${p.name} · ${p.model}`, value: p.id }))}
              />
            </div>
            <div>
              <div className="knaic-sub">System prompt</div>
              <Input.TextArea
                rows={5}
                value={system}
                onChange={e => setSystem(e.target.value)}
              />
            </div>
            <div>
              <div className="knaic-sub">Temperature · {temperature}</div>
              <Slider min={0} max={2} step={0.05} value={temperature} onChange={setTemperature} />
            </div>
            <Button block icon={<ClearOutlined />} onClick={() => setMessages([])}>
              Clear conversation
            </Button>
            {provider && (
              <div className="knaic-sub" style={{ marginTop: 8 }}>
                Calls <span className="mono">{provider.endpoint}/chat/completions</span> with <code>stream=true</code>.
              </div>
            )}
          </Space>
        </Card>

        <Card size="small" title="Chat">
          <div className="chat-scroll" style={{ height: 480 }} ref={scrollRef}>
            {messages.length === 0 && (
              <div className="knaic-sub" style={{ textAlign: 'center', padding: 40 }}>
                Start a conversation with <b>{provider?.name ?? 'the selected model'}</b>.
              </div>
            )}
            {messages.map((m, i) => (
              <div className="chat-msg" key={i} style={{ justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div className={`chat-bubble ${m.role}`}>
                  {m.content || (m.role === 'assistant' && streaming ? '▍' : '')}
                </div>
              </div>
            ))}
          </div>
          <Space.Compact style={{ width: '100%', marginTop: 8 }}>
            <Input.TextArea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Type a message"
              autoSize={{ minRows: 1, maxRows: 4 }}
              onPressEnter={e => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {streaming ? (
              <Button
                danger
                icon={<PauseOutlined />}
                onClick={() => {
                  cancelRef.current?.();
                  setStreaming(false);
                }}
              >
                Stop
              </Button>
            ) : (
              <Button type="primary" icon={<SendOutlined />} onClick={send}>
                Send
              </Button>
            )}
          </Space.Compact>
        </Card>
      </div>
    </div>
  );
}
