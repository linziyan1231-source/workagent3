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
	input     sharedProjectRequest
}

func (s *sharedProjectOperatorStub) Apply(_ context.Context, projectID string, input sharedProjectRequest) error {
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
