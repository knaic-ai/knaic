import { Navigate, Route, Routes } from 'react-router-dom';
import { MainLayout } from './layouts/MainLayout';
import { AuthCallback, AuthGate } from './auth/AuthContext';
import { Dashboard } from './pages/Dashboard';
import { AgentWorkspacePage } from './pages/agent-workspace/AgentWorkspace';
import { ComponentsPage } from './pages/admin/Components';
import { NamespacesPage } from './pages/admin/Namespaces';
import { NodesPage } from './pages/admin/Nodes';
import { RegistryPage } from './pages/admin/Registry';
import { GPUProfilesPage } from './pages/admin/GPUProfiles';
import { ModelHub } from './pages/models/ModelHub';
import { ModelDetailPage } from './pages/models/ModelDetail';
import { ModelPublishRequestsPage } from './pages/admin/ModelPublishRequests';
import { Monitoring } from './pages/monitoring/Monitoring';
import { LLMMonitoring } from './pages/monitoring/LLMMonitoring';
import { TrainMonitoring } from './pages/monitoring/TrainMonitoring';
import { GPUStatus } from './pages/monitoring/GPUStatus';
import { Deployments } from './pages/containers/Deployments';
import { StatefulSets } from './pages/containers/StatefulSets';
import { Pods } from './pages/containers/Pods';
import { PVCs } from './pages/containers/PVCs';
import { Services } from './pages/containers/Services';
import { ConfigMaps } from './pages/containers/ConfigMaps';
import { Secrets } from './pages/containers/Secrets';
import { Gateways } from './pages/containers/Gateways';
import { UsersPage } from './pages/users/Users';
import { RolesPage } from './pages/users/Roles';
import { ServingRuntimesPage } from './pages/inference/ServingRuntimes';
import { InferenceServicesPage } from './pages/inference/InferenceServices';
import { InferenceServiceDetailPage } from './pages/inference/InferenceServiceDetail';
import { GatewayConfigPage } from './pages/inference/GatewayConfig';
import { StorageContainersPage } from './pages/inference/StorageContainers';
import { LLMConfigsPage } from './pages/inference/LLMConfigs';
import { LocalModelCachePage } from './pages/inference/LocalModelCache';
import { LLMRegistry } from './pages/playground/Registry';
import { Chat } from './pages/playground/Chat';
import { Agent } from './pages/playground/Agent';
import { TrainingRuntimesPage } from './pages/training/TrainingRuntimes';
import { TrainJobsPage } from './pages/training/TrainJobs';
import { NotebooksPage } from './pages/notebooks/Notebooks';
import { S3SecretsPage } from './pages/admin/S3Secrets';
import { GitLabConfigsPage } from './pages/admin/GitLabConfigs';
import { S3BrowserPage } from './pages/aistorage/S3Browser';
import { PVCManagerPage } from './pages/aistorage/PVCManager';
import { GitLabBrowserPage } from './pages/aistorage/GitLabBrowser';
import { GitLabProjectsPage } from './pages/aistorage/GitLabProjects';

export default function App() {
  return (
    <Routes>
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route element={<AuthGate><MainLayout /></AuthGate>}>
        <Route index element={<Dashboard />} />
        <Route path="/agent-workspace" element={<AgentWorkspacePage />} />
        <Route path="/admin/components" element={<ComponentsPage />} />
        <Route path="/admin/registry" element={<RegistryPage />} />
        <Route path="/admin/namespaces" element={<NamespacesPage />} />
        <Route path="/admin/nodes" element={<NodesPage />} />
        <Route path="/admin/gpu-profiles" element={<GPUProfilesPage />} />
        <Route path="/models" element={<Navigate to="/models/public" replace />} />
        <Route path="/models/:scope" element={<ModelHub />} />
        <Route path="/models/:scope/:id" element={<ModelDetailPage />} />
        <Route path="/admin/model-publish-requests" element={<ModelPublishRequestsPage />} />
        <Route path="/monitoring" element={<Navigate to="/monitoring/resources" replace />} />
        <Route path="/monitoring/resources" element={<Monitoring />} />
        <Route path="/monitoring/llm" element={<LLMMonitoring />} />
        <Route path="/monitoring/train" element={<TrainMonitoring />} />
        <Route path="/monitoring/gpu" element={<GPUStatus />} />
        <Route path="/containers/deployments" element={<Deployments />} />
        <Route path="/containers/statefulsets" element={<StatefulSets />} />
        <Route path="/containers/pods" element={<Pods />} />
        <Route path="/containers/services" element={<Services />} />
        <Route path="/containers/configmaps" element={<ConfigMaps />} />
        <Route path="/containers/secrets" element={<Secrets />} />
        <Route path="/containers/gateways" element={<Gateways />} />
        <Route path="/containers/pvcs" element={<PVCs />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/users/roles" element={<RolesPage />} />
        <Route path="/inference/serving-runtimes" element={<ServingRuntimesPage />} />
        <Route path="/inference/services" element={<InferenceServicesPage />} />
        <Route path="/inference/services/:namespace/:name" element={<InferenceServiceDetailPage />} />
        <Route path="/inference/gateway" element={<GatewayConfigPage />} />
        <Route path="/inference/storage-initializers" element={<StorageContainersPage />} />
        <Route path="/inference/llm-configs" element={<LLMConfigsPage />} />
        <Route path="/inference/local-model-cache" element={<LocalModelCachePage />} />
        <Route path="/playground/registry" element={<LLMRegistry />} />
        <Route path="/playground/chat" element={<Chat />} />
        <Route path="/playground/agent" element={<Agent />} />
        <Route path="/training/runtimes" element={<TrainingRuntimesPage />} />
        <Route path="/training/jobs" element={<TrainJobsPage />} />
        <Route path="/notebooks" element={<NotebooksPage />} />
        <Route path="/admin/s3-secrets" element={<S3SecretsPage />} />
        <Route path="/admin/gitlab-configs" element={<GitLabConfigsPage />} />
        <Route path="/aistorage" element={<Navigate to="/aistorage/s3" replace />} />
        <Route path="/aistorage/s3" element={<S3BrowserPage />} />
        <Route path="/aistorage/pvc" element={<PVCManagerPage />} />
        <Route path="/aistorage/gitlab" element={<GitLabProjectsPage />} />
        <Route path="/aistorage/gitlab/:config/:projectID" element={<GitLabBrowserPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
