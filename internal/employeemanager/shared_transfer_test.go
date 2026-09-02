package employeemanager

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"workagent3/internal/userhost"
)

func TestNewSharedTransferManagerRequiresAbsoluteBase(t *testing.T) {
	if _, err := NewSharedTransferManager("relative/base"); err == nil {
		t.Fatal("relative employee data root was accepted")
	}
	if _, err := NewSharedTransferManager(t.TempDir()); err != nil {
		t.Fatalf("absolute employee data root rejected: %v", err)
	}
}

func TestSharedTransferManagerRejectsNonTransferActions(t *testing.T) {
	manager, err := NewSharedTransferManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	request := userhost.SharedProjectRequest{Action: "reconcile", OwnerSID: "S-1-5-21-1000"}
	if err := manager.Apply(t.Context(), "project_1234567890", request); err == nil {
		t.Fatal("single-owner action was accepted by the transfer manager")
	}
}

func TestSharedTransferRouteRequiresTokenAndTransferAction(t *testing.T) {
	manager, err := NewSharedTransferManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler := Handler(&Service{SharedTransfers: manager}, "secret")

	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, httptest.NewRequest(http.MethodPut, "/v1/shared-projects/project_1234567890", strings.NewReader(`{"action":"transfer"}`)))
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", denied.Code)
	}

	request := httptest.NewRequest(http.MethodPut, "/v1/shared-projects/project_1234567890", strings.NewReader(`{"action":"reconcile","ownerSid":"S-1-5-21-1000","memberSids":[],"rootMemberSids":[]}`))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("non-transfer action status %d: %s", response.Code, response.Body.String())
	}
}
