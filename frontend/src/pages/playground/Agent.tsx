import { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Empty, Input, List, Select, Space, Tag, Tooltip } from 'antd';
import {
  ClearOutlined,
  DeleteOutlined,
  PauseOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { PageHeader } from '@/components/PageHeader';
import { ensureProvidersLoaded, useProviders } from '@/data/playground';
import { apiEnabled } from '@/api/client';
import {
  createAgentSession,
  deleteAgentSession,
  getAgentSession,
  listAgentSessions,
  streamAgentSession,
  type AgentEvent,
  type AgentSession,
} from '@/api/playground';
import { useApp } from '@/context/AppContext';
import { agentStream, type ChatMessage } from './fakeStream';

type AgentStepKind = AgentEvent['kind'] | 'user';

interface AgentStep {
  kind: AgentStepKind;
  text: string;
  toolName?: string;
}

const defaultSkills = ['k8s_list', 'k8s_yaml', 'pod_logs', 'model_search', 'prometheus_query'];

const tagColor: Record<AgentStepKind, string> = {
  user: 'purple',
  thought: 'default',
  action: 'blue',
  observation: 'gold',
  final: 'green',
  error: 'red',
};

export function Agent() {
  const { namespace } = useApp();
  const providers = useProviders();
  const { message } = App.useApp();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [input, setInput] = useState('');
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [current, setCurrent] = useState<AgentSession | null>(null);
  const [skills, setSkills] = useState<string[]>(defaultSkills);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    ensureProvidersLoaded(namespace);
  }, [namespace]);

  useEffect(() => {
    if (providers.length === 0) {
      if (providerId) setProviderId('');
      return;
    }
    if (!providers.some(p => p.id === providerId)) setProviderId(providers[0].id);
  }, [providerId, providers]);

  useEffect(() => {
    if (!apiEnabled) return;
    let active = true;
    listAgentSessions(namespace)
      .then(items => {
        if (!active) return;
        setSessions(items);
        setSessionId(prev => (prev && items.some(s => s.id === prev) ? prev : items[0]?.id ?? ''));
      })
      .catch(err => message.error(err instanceof Error ? err.message : 'Failed to load agent sessions'));
    return () => {
      active = false;
    };
  }, [namespace, message]);

  useEffect(() => {
    if (!apiEnabled || busy) return;
    if (!sessionId) {
      setCurrent(null);
      setSteps([]);
      return;
    }
    let active = true;
    getAgentSession(sessionId)
      .then(session => {
        if (!active) return;
        setCurrent(session);
        setProviderId(session.providerId);
        if (session.skills?.length) setSkills(session.skills);
        setSteps(stepsFromSession(session));
      })
      .catch(err => message.error(err instanceof Error ? err.message : 'Failed to load agent session'));
    return () => {
      active = false;
    };
  }, [sessionId, message, busy]);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [steps]);

  const provider = providers.find(p => p.id === providerId);

  async function refreshSessions(nextID?: string) {
    if (!apiEnabled) return;
    const items = await listAgentSessions(namespace);
    setSessions(items);
    if (nextID) {
      setSessionId(nextID);
    } else {
      setSessionId(prev => (prev && items.some(s => s.id === prev) ? prev : items[0]?.id ?? ''));
    }
  }

  async function newSession() {
    if (!provider) {
      message.warning('Select an LLM service first');
      return null;
    }
    if (!apiEnabled) {
      setCurrent(null);
      setSteps([]);
      return null;
    }
    const created = await createAgentSession({
      namespace,
      providerId: provider.id,
      title: `Agent session · ${namespace}`,
      skills,
    });
    setCurrent(created);
    setSteps([]);
    await refreshSessions(created.id);
    return created;
  }

  async function removeSession(id: string) {
    if (!apiEnabled || busy) return;
    await deleteAgentSession(id);
    setCurrent(null);
    setSteps([]);
    await refreshSessions();
  }

  function toggleSkill(skill: string) {
    setSkills(prev => (prev.includes(skill) ? prev.filter(s => s !== skill) : [...prev, skill]));
  }

  async function run() {
    const prompt = input.trim();
    if (!prompt || !provider) return;
    if (provider.status !== 'Ready') {
      message.warning(`Provider ${provider.name} is ${provider.status}`);
      return;
    }
    setInput('');
    setBusy(true);

    if (!apiEnabled) {
      setSteps(prev => [...prev, { kind: 'user', text: prompt }]);
      const history: ChatMessage[] = [
        ...steps
          .filter(step => step.kind === 'user' || step.kind === 'final')
          .map(step => ({ role: step.kind === 'user' ? 'user' : 'assistant', content: step.text }) as ChatMessage),
        { role: 'user', content: prompt },
      ];
      try {
        for await (const step of agentStream({ model: provider.model, temperature: 0.2, system: 'ReAct agent', history })) {
          setSteps(prev => [...prev, step]);
        }
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Agent run failed');
      } finally {
        setBusy(false);
      }
      return;
    }

    let sid = sessionId;
    try {
      if (!sid) {
        const created = await newSession();
        if (!created) return;
        sid = created.id;
      }
      const ac = new AbortController();
      cancelRef.current = () => ac.abort();
      setSteps(prev => [...prev, { kind: 'user', text: prompt }]);
      let hadError = false;
      await streamAgentSession(
        sid,
        { message: prompt, namespace },
        {
          signal: ac.signal,
          onEvent: event => {
            if (event.kind === 'error') hadError = true;
            setSteps(prev => appendAgentEvent(prev, event));
          },
          onDone: () => undefined,
        },
      );
      const fresh = await getAgentSession(sid);
      setCurrent(fresh);
      if (!hadError) setSteps(stepsFromSession(fresh));
      await refreshSessions(sid);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        message.error(err instanceof Error ? err.message : 'Agent run failed');
      }
    } finally {
      cancelRef.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="knaic-page">
      <PageHeader title="Playground · Agent" description="Run a read-only AI operations agent against the selected namespace." />
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
        <Card size="small" title="Agent config">
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
              <div className="knaic-sub">Tools</div>
              <Space wrap size={4}>
                {defaultSkills.map(skill => (
                  <Tag.CheckableTag
                    key={skill}
                    checked={skills.includes(skill)}
                    onChange={() => toggleSkill(skill)}
                  >
                    {skill}
                  </Tag.CheckableTag>
                ))}
              </Space>
            </div>
            <Space.Compact style={{ width: '100%' }}>
              <Button block icon={<PlusOutlined />} onClick={() => void newSession()} disabled={busy}>
                New session
              </Button>
              <Tooltip title="Refresh sessions">
                <Button icon={<ReloadOutlined />} onClick={() => void refreshSessions()} disabled={!apiEnabled || busy} />
              </Tooltip>
            </Space.Compact>
            <Button block icon={<ClearOutlined />} onClick={() => setSteps([])} disabled={busy}>
              Clear trace
            </Button>
            {apiEnabled && (
              <List
                size="small"
                dataSource={sessions}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No sessions" /> }}
                renderItem={item => (
                  <List.Item
                    actions={[
                      <Button
                        key="delete"
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => void removeSession(item.id)}
                      />,
                    ]}
                    style={{
                      cursor: 'pointer',
                      background: item.id === sessionId ? 'var(--knaic-hover, #eef5ff)' : undefined,
                      paddingInline: 8,
                    }}
                    onClick={() => setSessionId(item.id)}
                  >
                    <List.Item.Meta
                      title={item.title}
                      description={`${item.namespace || namespace} · ${new Date(item.updatedAt).toLocaleString()}`}
                    />
                  </List.Item>
                )}
              />
            )}
          </Space>
        </Card>

        <Card size="small" title={<Space><ThunderboltOutlined /> Agent trace</Space>}>
          <div className="chat-scroll" style={{ height: 480 }} ref={scroll}>
            {steps.length === 0 && (
              <div className="knaic-sub" style={{ textAlign: 'center', padding: 40 }}>
                {current ? 'This session has no messages yet.' : 'Start a session and ask the agent a question.'}
              </div>
            )}
            {steps.map((s, i) => (
              <div key={`${s.kind}-${i}`} style={{ marginBottom: 10 }}>
                <Tag color={tagColor[s.kind]}>
                  {s.toolName ? `${s.kind} · ${s.toolName}` : s.kind}
                </Tag>
                <div
                  className={s.kind === 'user' ? 'chat-bubble user' : s.kind === 'final' ? 'chat-bubble assistant' : 'chat-bubble tool'}
                  style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}
                >
                  {s.text}
                </div>
              </div>
            ))}
          </div>
          <Space.Compact style={{ width: '100%', marginTop: 8 }}>
            <Input.TextArea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask the agent"
              autoSize={{ minRows: 1, maxRows: 4 }}
              onPressEnter={e => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            {busy ? (
              <Button
                danger
                icon={<PauseOutlined />}
                onClick={() => {
                  cancelRef.current?.();
                  setBusy(false);
                }}
              >
                Stop
              </Button>
            ) : (
              <Button type="primary" icon={<SendOutlined />} onClick={() => void run()}>
                Run
              </Button>
            )}
          </Space.Compact>
        </Card>
      </div>
    </div>
  );
}

function normalizeEvent(event: AgentEvent): AgentStep {
  return {
    kind: event.kind,
    text: event.text,
    toolName: event.toolName,
  };
}

function appendAgentEvent(prev: AgentStep[], event: AgentEvent): AgentStep[] {
  const step = normalizeEvent(event);
  const last = prev[prev.length - 1];
  if (step.kind === 'final' && last?.kind === 'final' && !step.toolName) {
    return [...prev.slice(0, -1), { ...last, text: last.text + step.text }];
  }
  return [...prev, step];
}

function stepsFromSession(session: AgentSession): AgentStep[] {
  return (session.messages ?? []).map(msg => ({
    kind: msg.role === 'user' ? 'user' : 'final',
    text: msg.content,
  }));
}
