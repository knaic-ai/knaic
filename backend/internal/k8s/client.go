package k8s

import (
	"fmt"

	"k8s.io/cli-runtime/pkg/genericclioptions"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type Clients struct {
	Config     *rest.Config
	Typed      kubernetes.Interface
	Dynamic    dynamic.Interface
	Discovery  discovery.DiscoveryInterface
	RESTGetter genericclioptions.RESTClientGetter
}

// Impersonate returns a typed client that talks to the apiserver as the named
// user/groups via the standard impersonation headers. Requires the backend's
// service account to hold a ClusterRole granting `impersonate` on
// users/groups/serviceaccounts in `authentication.k8s.io` (or be cluster-admin).
func (c *Clients) Impersonate(userName string, groups []string) (kubernetes.Interface, error) {
	if c == nil || c.Config == nil {
		return nil, fmt.Errorf("k8s clients not initialized")
	}
	cfg := rest.CopyConfig(c.Config)
	cfg.Impersonate = rest.ImpersonationConfig{
		UserName: userName,
		Groups:   groups,
	}
	return kubernetes.NewForConfig(cfg)
}

// New returns a Clients bundle. If kubeconfigPath is empty, in-cluster config
// is used; if that fails, the default ~/.kube/config is loaded.
func New(kubeconfigPath string) (*Clients, error) {
	cfg, getter, err := loadConfig(kubeconfigPath)
	if err != nil {
		return nil, err
	}
	typed, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("typed client: %w", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("dynamic client: %w", err)
	}
	disc, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("discovery client: %w", err)
	}
	return &Clients{
		Config:     cfg,
		Typed:      typed,
		Dynamic:    dyn,
		Discovery:  disc,
		RESTGetter: getter,
	}, nil
}

func loadConfig(path string) (*rest.Config, genericclioptions.RESTClientGetter, error) {
	if path == "" {
		if cfg, err := rest.InClusterConfig(); err == nil {
			getter := genericclioptions.NewConfigFlags(false)
			return cfg, getter, nil
		}
	}
	loading := clientcmd.NewDefaultClientConfigLoadingRules()
	if path != "" {
		loading.ExplicitPath = path
	}
	overrides := &clientcmd.ConfigOverrides{}
	cc := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loading, overrides)
	cfg, err := cc.ClientConfig()
	if err != nil {
		return nil, nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	getter := genericclioptions.NewConfigFlags(false)
	if path != "" {
		getter.KubeConfig = &path
	}
	return cfg, getter, nil
}
