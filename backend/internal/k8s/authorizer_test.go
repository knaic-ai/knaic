package k8s

import (
	"context"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	clientgotesting "k8s.io/client-go/testing"

	"github.com/alauda/knaic-backend/internal/auth"
)

func TestAuthorizerChecksPrivateModelWriteWithSubjectAccessReview(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.Fake.PrependReactor("create", "subjectaccessreviews", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		create := action.(clientgotesting.CreateAction)
		sar := create.GetObject().(*authorizationv1.SubjectAccessReview)
		if sar.Spec.User != "oidc:alice@example.com" {
			t.Fatalf("SAR user = %q", sar.Spec.User)
		}
		if got := sar.Spec.Groups; len(got) != 1 || got[0] != "team-ml" {
			t.Fatalf("SAR groups = %#v", got)
		}
		attrs := sar.Spec.ResourceAttributes
		if attrs == nil {
			t.Fatalf("SAR resource attributes are nil")
		}
		if attrs.Namespace != "team-ml" || attrs.Verb != "create" || attrs.Group != "" || attrs.Resource != "configmaps" {
			t.Fatalf("SAR attrs = %#v", attrs)
		}
		sar.Status = authorizationv1.SubjectAccessReviewStatus{Allowed: true}
		return true, sar, nil
	})

	authorizer := NewAuthorizer(&Clients{Typed: client}, "email", "oidc:", false)
	allowed, err := authorizer.CanWritePrivateModel(context.Background(), &auth.User{
		Email:  "alice@example.com",
		Groups: []string{"team-ml"},
	}, "team-ml")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if !allowed {
		t.Fatalf("allowed = false, want true")
	}

	actions := client.Actions()
	if len(actions) != 1 {
		t.Fatalf("actions = %d, want 1", len(actions))
	}
	wantResource := schema.GroupResource{Group: "authorization.k8s.io", Resource: "subjectaccessreviews"}
	if actions[0].GetResource().GroupResource() != wantResource {
		t.Fatalf("resource = %s", actions[0].GetResource().String())
	}
}
