package userhost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/mcpruntime"
)

type sharedProjectOperatorStub struct {
	projectID string
	input     SharedProjectRequest
}

func (s *sharedProjectOperatorStub) Apply(_ context.Context, projectID string, input SharedProjectRequest) error {
	s.projectID, s.input = projectID, input
	return nil
}

func TestRuntimeGatewayAuthenticatesSharedProjectPlatformRoute(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	target, _ := url.Parse("http://127.0.0.1:1")
	operator := &sharedProjectOperatorStub{}
	handler := newRuntimeGatewayHandlerWithShared(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "runtime-token", operator)
	body := `{"action":"reconcile","ownerSid":"S-1-5-21-1000","memberSids":["S-1-5-21-2000"]}`

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPut, "/internal/shared-projects/project_1234567890", strings.NewReader(body)))
	if unauthorized.Code != http.StatusUnauthorized || operator.projectID != "" {
		t.Fatalf("unauthorized response = %d, operator = %#v", unauthorized.Code, operator)
	}

	request := httptest.NewRequest(http.MethodPut, "/internal/shared-projects/project_1234567890", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer runtime-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || operator.projectID != "project_1234567890" || operator.input.Action != "reconcile" || len(operator.input.MemberSIDs) != 1 {
		t.Fatalf("response = %d %s, operator = %#v", response.Code, response.Body.String(), operator)
	}
}

func TestSharedProjectRequestRejectsGeneralPrincipals(t *testing.T) {
	if _, err := normalizeSharedMembers("S-1-5-21-1000", []string{"S-1-1-0"}); err == nil {
		t.Fatal("Everyone was accepted as a shared-project member")
	}
	if _, err := normalizeSharedMembers("S-1-5-21-1000", []string{"S-1-5-21-2000", "S-1-5-21-2000"}); err != nil {
		t.Fatalf("duplicate exact member should normalize: %v", err)
	}
}

// The limited owner Runtime must not attempt cross-user transfer steps: it
// lacks the privileges and cross-account write access, and a half-applied
// attempt strands the project tree. Transfers run on the Employee Manager.
func TestRuntimeSharedProjectOperatorRejectsTransferActions(t *testing.T) {
	operator := runtimeSharedProjectOperator{}
	for _, action := range []string{"transfer", "transfer_commit", "transfer_rollback"} {
		if err := operator.Apply(t.Context(), "project_1234567890", SharedProjectRequest{Action: action, OwnerSID: "S-1-5-21-1000"}); err == nil {
			t.Fatalf("runtime operator accepted %q", action)
		}
	}
}
