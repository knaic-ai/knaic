import { componentsStore } from './components';
import { configMapsStore, gatewaysStore, httpRoutesStore, k8sServicesStore, secretsStore } from './clusterResources';
import { servicesStore, runtimesStore } from './inference';
import { modelsStore } from './models';
import { nodesStore } from './nodes';
import { notebooksStore } from './notebooks';
import { providersStore } from './playground';
import { trainJobsStore, trainingRuntimesStore } from './training';
import { bindingsStore, rolesStore, usersStore } from './users';
import { deploymentsStore, podsStore, pvcsStore, statefulSetsStore } from './workloads';

let cleared = false;

export function clearSeedStoresForApiMode(): void {
  if (cleared) return;
  cleared = true;
  componentsStore.set([]);
  configMapsStore.set([]);
  deploymentsStore.set([]);
  gatewaysStore.set([]);
  httpRoutesStore.set([]);
  k8sServicesStore.set([]);
  modelsStore.set([]);
  nodesStore.set([]);
  notebooksStore.set([]);
  podsStore.set([]);
  providersStore.set([]);
  pvcsStore.set([]);
  rolesStore.set([]);
  runtimesStore.set([]);
  secretsStore.set([]);
  servicesStore.set([]);
  statefulSetsStore.set([]);
  trainJobsStore.set([]);
  trainingRuntimesStore.set([]);
  usersStore.set([]);
  bindingsStore.set([]);
}
