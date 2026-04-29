import { createStore, useStore, uid } from './store';

export interface K8sService {
  id: string;
  name: string;
  namespace: string;
  type: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  clusterIP: string;
  ports: { name?: string; port: number; targetPort: number; protocol: 'TCP' | 'UDP' }[];
  selector: Record<string, string>;
  createdAt: string;
}

export interface ConfigMap {
  id: string;
  name: string;
  namespace: string;
  data: Record<string, string>;
  createdAt: string;
}

export interface Secret {
  id: string;
  name: string;
  namespace: string;
  type: 'Opaque' | 'kubernetes.io/tls' | 'kubernetes.io/dockerconfigjson' | 'kubernetes.io/service-account-token';
  keys: string[];
  createdAt: string;
}

export interface Gateway {
  id: string;
  name: string;
  namespace: string;
  gatewayClassName: string;
  listeners: { name: string; port: number; protocol: 'HTTP' | 'HTTPS'; hostname?: string }[];
  addresses: string[];
  status: 'Accepted' | 'Pending' | 'Failed';
  createdAt: string;
}

export interface HTTPRoute {
  id: string;
  name: string;
  namespace: string;
  parentGateway: string;
  hostnames: string[];
  rules: { pathPrefix: string; backendService: string; port: number }[];
  createdAt: string;
}

const nowDate = () => new Date().toISOString().slice(0, 10);

const servicesInit: K8sService[] = [
  {
    id: uid('svc'), name: 'qwen3-5-7b', namespace: 'team-ml', type: 'ClusterIP',
    clusterIP: '10.96.34.11',
    ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
    selector: { 'serving.kserve.io/inferenceservice': 'qwen3-5-7b' },
    createdAt: nowDate(),
  },
  {
    id: uid('svc'), name: 'bge-embed', namespace: 'team-ml', type: 'ClusterIP',
    clusterIP: '10.96.34.22',
    ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
    selector: { app: 'bge-embed' }, createdAt: nowDate(),
  },
  {
    id: uid('svc'), name: 'helpdesk-agent', namespace: 'team-ml', type: 'LoadBalancer',
    clusterIP: '10.96.34.45',
    ports: [{ name: 'http', port: 80, targetPort: 3000, protocol: 'TCP' }],
    selector: { app: 'helpdesk-agent' }, createdAt: nowDate(),
  },
  {
    id: uid('svc'), name: 'sd3-frontend', namespace: 'team-vision', type: 'ClusterIP',
    clusterIP: '10.96.40.8',
    ports: [{ name: 'http', port: 80, targetPort: 8000, protocol: 'TCP' }],
    selector: { app: 'sd3-frontend' }, createdAt: nowDate(),
  },
];

const configMapsInit: ConfigMap[] = [
  {
    id: uid('cm'), name: 'helpdesk-prompts', namespace: 'team-ml',
    data: {
      'system.txt': 'You are a helpful internal helpdesk assistant…',
      'few_shots.json': '[{"q":"how to reset password","a":"…"}]',
    },
    createdAt: nowDate(),
  },
  {
    id: uid('cm'), name: 'vllm-extra-config', namespace: 'team-ml',
    data: { 'chat-template.jinja': '{% for m in messages %}…{% endfor %}' },
    createdAt: nowDate(),
  },
  {
    id: uid('cm'), name: 'sd3-config', namespace: 'team-vision',
    data: { 'config.yaml': 'guidance_scale: 7.5\nsteps: 28\n' },
    createdAt: nowDate(),
  },
];

const secretsInit: Secret[] = [
  {
    id: uid('sec'), name: 'hf-pull-token', namespace: 'team-ml', type: 'Opaque',
    keys: ['HF_TOKEN'], createdAt: nowDate(),
  },
  {
    id: uid('sec'), name: 'registry-pull', namespace: 'team-ml', type: 'kubernetes.io/dockerconfigjson',
    keys: ['.dockerconfigjson'], createdAt: nowDate(),
  },
  {
    id: uid('sec'), name: 'helpdesk-tls', namespace: 'team-ml', type: 'kubernetes.io/tls',
    keys: ['tls.crt', 'tls.key'], createdAt: nowDate(),
  },
  {
    id: uid('sec'), name: 'team-vision-sa-token', namespace: 'team-vision', type: 'kubernetes.io/service-account-token',
    keys: ['token', 'ca.crt'], createdAt: nowDate(),
  },
];

const gatewaysInit: Gateway[] = [
  {
    id: uid('gw'), name: 'knaic-edge', namespace: 'knaic-system',
    gatewayClassName: 'envoy',
    listeners: [
      { name: 'http', port: 80, protocol: 'HTTP' },
      { name: 'https', port: 443, protocol: 'HTTPS', hostname: '*.knaic.example.com' },
    ],
    addresses: ['203.0.113.45'],
    status: 'Accepted',
    createdAt: nowDate(),
  },
  {
    id: uid('gw'), name: 'team-ml-ingress', namespace: 'team-ml',
    gatewayClassName: 'envoy',
    listeners: [{ name: 'http', port: 80, protocol: 'HTTP' }],
    addresses: ['10.96.200.3'],
    status: 'Accepted',
    createdAt: nowDate(),
  },
];

const routesInit: HTTPRoute[] = [
  {
    id: uid('hr'), name: 'qwen-route', namespace: 'team-ml',
    parentGateway: 'team-ml-ingress',
    hostnames: ['qwen.team-ml.knaic.example.com'],
    rules: [{ pathPrefix: '/v1', backendService: 'qwen3-5-7b', port: 80 }],
    createdAt: nowDate(),
  },
  {
    id: uid('hr'), name: 'helpdesk-route', namespace: 'team-ml',
    parentGateway: 'team-ml-ingress',
    hostnames: ['helpdesk.team-ml.knaic.example.com'],
    rules: [{ pathPrefix: '/', backendService: 'helpdesk-agent', port: 80 }],
    createdAt: nowDate(),
  },
];

export const k8sServicesStore = createStore<K8sService[]>(servicesInit);
export const configMapsStore = createStore<ConfigMap[]>(configMapsInit);
export const secretsStore = createStore<Secret[]>(secretsInit);
export const gatewaysStore = createStore<Gateway[]>(gatewaysInit);
export const httpRoutesStore = createStore<HTTPRoute[]>(routesInit);

export const useK8sServices = () => useStore(k8sServicesStore);
export const useConfigMaps = () => useStore(configMapsStore);
export const useSecrets = () => useStore(secretsStore);
export const useGateways = () => useStore(gatewaysStore);
export const useHTTPRoutes = () => useStore(httpRoutesStore);

export function buildServiceYaml(s: K8sService): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${s.name}
  namespace: ${s.namespace}
spec:
  type: ${s.type}
  clusterIP: ${s.clusterIP}
  selector:
${Object.entries(s.selector).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
  ports:
${s.ports.map(p => `    - name: ${p.name ?? 'port'}
      port: ${p.port}
      targetPort: ${p.targetPort}
      protocol: ${p.protocol}`).join('\n')}
`;
}

export function buildConfigMapYaml(c: ConfigMap): string {
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${c.name}
  namespace: ${c.namespace}
data:
${Object.entries(c.data).map(([k, v]) => `  ${k}: |\n${v.split('\n').map(l => '    ' + l).join('\n')}`).join('\n')}
`;
}

export function buildSecretYaml(s: Secret): string {
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${s.name}
  namespace: ${s.namespace}
type: ${s.type}
data:
${s.keys.map(k => `  ${k}: <redacted>`).join('\n')}
`;
}

export function buildGatewayYaml(g: Gateway): string {
  return `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ${g.name}
  namespace: ${g.namespace}
spec:
  gatewayClassName: ${g.gatewayClassName}
  listeners:
${g.listeners.map(l => `    - name: ${l.name}
      port: ${l.port}
      protocol: ${l.protocol}${l.hostname ? `\n      hostname: ${l.hostname}` : ''}`).join('\n')}
`;
}

export function buildHTTPRouteYaml(r: HTTPRoute): string {
  return `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${r.name}
  namespace: ${r.namespace}
spec:
  parentRefs:
    - name: ${r.parentGateway}
  hostnames:
${r.hostnames.map(h => `    - ${h}`).join('\n')}
  rules:
${r.rules.map(rule => `    - matches:
        - path:
            type: PathPrefix
            value: ${rule.pathPrefix}
      backendRefs:
        - name: ${rule.backendService}
          port: ${rule.port}`).join('\n')}
`;
}

export function buildDeploymentYaml(d: {
  name: string; namespace: string; image: string; replicas: number; labels: Record<string, string>;
}): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${d.name}
  namespace: ${d.namespace}
  labels:
${Object.entries(d.labels).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
spec:
  replicas: ${d.replicas}
  selector:
    matchLabels:
${Object.entries(d.labels).map(([k, v]) => `      ${k}: ${v}`).join('\n')}
  template:
    metadata:
      labels:
${Object.entries(d.labels).map(([k, v]) => `        ${k}: ${v}`).join('\n')}
    spec:
      containers:
        - name: main
          image: ${d.image}
`;
}

export function buildStatefulSetYaml(s: {
  name: string; namespace: string; image: string; replicas: number; serviceName: string;
}): string {
  return `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${s.name}
  namespace: ${s.namespace}
spec:
  replicas: ${s.replicas}
  serviceName: ${s.serviceName}
  selector:
    matchLabels:
      app: ${s.name}
  template:
    metadata:
      labels:
        app: ${s.name}
    spec:
      containers:
        - name: main
          image: ${s.image}
`;
}

export function buildPodYaml(p: { name: string; namespace: string; node: string; containers: string[] }): string {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${p.name}
  namespace: ${p.namespace}
spec:
  nodeName: ${p.node}
  containers:
${p.containers.map(c => `    - name: ${c}\n      image: <resolved at runtime>`).join('\n')}
`;
}

export function buildPVCYaml(p: {
  name: string; namespace: string; storageClass: string; capacity: string; accessMode: string;
}): string {
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${p.name}
  namespace: ${p.namespace}
spec:
  accessModes:
    - ${p.accessMode === 'RWO' ? 'ReadWriteOnce' : p.accessMode === 'RWX' ? 'ReadWriteMany' : p.accessMode}
  storageClassName: ${p.storageClass}
  resources:
    requests:
      storage: ${p.capacity}
`;
}
