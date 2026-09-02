package quota

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type runtimeCredentialStub map[string]string

func (credentials runtimeCredentialStub) RuntimeRegistrationAuthorized(_ context.Context, sid, credential string) bool {
	return credentials[sid] == credential
}

func invokeRuntimeQuota(handler http.Handler, path, body, credential, remote string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.RemoteAddr = remote
	request.Header.Set("Authorization", "Bearer "+credential)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestRuntimeQuotaHandlerReservesAndSettlesForAuthenticatedSID(t *testing.T) {
	store := openTestStore(t)
	const sid = "S-1-5-21-100"
	if err := store.SetBudget(t.Context(), Budget{SID: sid, ModelID: "codex-native", Period: Daily, LimitUnits: 100}); err != nil {
		t.Fatal(err)
	}
	handler := RuntimeHandler(store, runtimeCredentialStub{sid: "sid-secret"})
	reserved := invokeRuntimeQuota(handler, "/internal/runtime/quota/reserve", `{"runId":"automation-run-1","sid":"`+sid+`","modelId":"codex-native","estimatedUnits":40}`, "sid-secret", "127.0.0.1:55000")
	if reserved.Code != http.StatusOK || !strings.Contains(reserved.Body.String(), `"runId":"automation-run-1"`) {
		t.Fatalf("reserve response %d: %s", reserved.Code, reserved.Body.String())
	}
	settled := invokeRuntimeQuota(handler, "/internal/runtime/quota/settle", `{"runId":"automation-run-1","sid":"`+sid+`","actualUnits":25}`, "sid-secret", "[::1]:55000")
	if settled.Code != http.StatusNoContent {
		t.Fatalf("settle response %d: %s", settled.Code, settled.Body.String())
	}
	usage, err := store.Usage(t.Context(), sid, "codex-native", store.now())
	if err != nil || usage.ConsumedUnits != 25 || usage.ReservedUnits != 0 {
		t.Fatalf("unexpected settled usage: %#v, %v", usage, err)
	}
}

func TestRuntimeQuotaHandlerRejectsCrossSIDAndRemoteCallers(t *testing.T) {
	store := openTestStore(t)
	handler := RuntimeHandler(store, runtimeCredentialStub{"S-1-5-21-100": "alice-secret"})
	body := `{"runId":"run-1","sid":"S-1-5-21-200","modelId":"codex-native","estimatedUnits":1}`
	if response := invokeRuntimeQuota(handler, "/internal/runtime/quota/reserve", body, "alice-secret", "127.0.0.1:55000"); response.Code != http.StatusUnauthorized {
		t.Fatalf("cross-SID reserve returned %d: %s", response.Code, response.Body.String())
	}
	if response := invokeRuntimeQuota(handler, "/internal/runtime/quota/reserve", body, "alice-secret", "192.0.2.20:55000"); response.Code != http.StatusForbidden {
		t.Fatalf("remote reserve returned %d: %s", response.Code, response.Body.String())
	}
}

func TestRuntimeQuotaSettlementCannotCrossSID(t *testing.T) {
	store := openTestStore(t)
	const alice = "S-1-5-21-100"
	if err := store.SetBudget(t.Context(), Budget{SID: alice, ModelID: "codex-native", Period: Daily, LimitUnits: 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reserve(t.Context(), ReserveRequest{RunID: "run-1", SID: alice, ModelID: "codex-native", EstimatedUnits: 10}); err != nil {
		t.Fatal(err)
	}
	handler := RuntimeHandler(store, runtimeCredentialStub{"S-1-5-21-200": "bob-secret"})
	response := invokeRuntimeQuota(handler, "/internal/runtime/quota/settle", `{"runId":"run-1","sid":"S-1-5-21-200","actualUnits":0}`, "bob-secret", "127.0.0.1:55000")
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-SID settle returned %d: %s", response.Code, response.Body.String())
	}
}

func TestRuntimeQuotaHandlerSharedRunBillsFrozenPayer(t *testing.T) {
	store := openTestStore(t)
	const owner = "S-1-5-21-100"
	const payer = "S-1-5-21-200"
	if err := store.SetBudget(t.Context(), Budget{SID: payer, ModelID: "gpt-5", Period: Daily, LimitUnits: 10000}); err != nil {
		t.Fatal(err)
	}
	handler := RuntimeHandler(store, runtimeCredentialStub{owner: "owner-secret"})
	reserved := invokeRuntimeQuota(handler, "/internal/runtime/quota/reserve", `{"runId":"run-shared-1","sid":"`+owner+`","modelId":"gpt-5","estimatedUnits":2048,"payerSid":"`+payer+`"}`, "owner-secret", "127.0.0.1:55000")
	if reserved.Code != http.StatusOK || !strings.Contains(reserved.Body.String(), `"sid":"`+payer+`"`) {
		t.Fatalf("payer reserve response %d: %s", reserved.Code, reserved.Body.String())
	}
	// Without the frozen payer pin the owner credential cannot touch the
	// payer's reservation.
	denied := invokeRuntimeQuota(handler, "/internal/runtime/quota/settle", `{"runId":"run-shared-1","sid":"`+owner+`","actualUnits":0}`, "owner-secret", "127.0.0.1:55000")
	if denied.Code != http.StatusNotFound {
		t.Fatalf("unpinned settle returned %d: %s", denied.Code, denied.Body.String())
	}
	settled := invokeRuntimeQuota(handler, "/internal/runtime/quota/settle", `{"runId":"run-shared-1","sid":"`+owner+`","actualUnits":1500,"payerSid":"`+payer+`"}`, "owner-secret", "127.0.0.1:55000")
	if settled.Code != http.StatusNoContent {
		t.Fatalf("payer settle response %d: %s", settled.Code, settled.Body.String())
	}
	usage, err := store.Usage(t.Context(), payer, "gpt-5", store.now())
	if err != nil || usage.ConsumedUnits != 1500 {
		t.Fatalf("payer usage = %#v, %v", usage, err)
	}
	if rejected := invokeRuntimeQuota(handler, "/internal/runtime/quota/reserve", `{"runId":"run-shared-3","sid":"`+owner+`","modelId":"gpt-5","estimatedUnits":1,"payerSid":"`+payer+`"}`, "wrong-secret", "127.0.0.1:55000"); rejected.Code != http.StatusUnauthorized {
		t.Fatalf("wrong credential returned %d: %s", rejected.Code, rejected.Body.String())
	}
}
