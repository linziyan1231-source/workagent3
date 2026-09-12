package quota

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"workagent3/internal/contracts"
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

func TestRuntimeQuotaUsageRejectsOtherSIDAndPayerOverride(t *testing.T) {
	data := openTestStore(t)
	const sid = "S-1-5-21-100"
	if err := data.SetBudget(t.Context(), Budget{SID: sid, ModelID: "codex-native", Period: Daily, LimitUnits: 100}); err != nil {
		t.Fatal(err)
	}
	handler := RuntimeHandler(data, runtimeCredentialStub{sid: "alice-secret"})
	own := invokeRuntimeQuota(handler, "/internal/runtime/quota/usage", `{"sid":"`+sid+`","modelId":"codex-native"}`, "alice-secret", "127.0.0.1:55000")
	if own.Code != 200 || !strings.Contains(own.Body.String(), `"limitUnits":100`) {
		t.Fatalf("own usage: %d %s", own.Code, own.Body.String())
	}
	other := invokeRuntimeQuota(handler, "/internal/runtime/quota/usage", `{"sid":"S-1-5-21-200","modelId":"codex-native"}`, "alice-secret", "127.0.0.1:55000")
	if other.Code != 401 {
		t.Fatalf("cross SID: %d", other.Code)
	}
	override := invokeRuntimeQuota(handler, "/internal/runtime/quota/usage", `{"sid":"`+sid+`","modelId":"codex-native","payerSid":"S-1-5-21-200"}`, "alice-secret", "127.0.0.1:55000")
	if override.Code != 400 {
		t.Fatalf("payer override: %d", override.Code)
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
	if response := invokeRuntimeQuota(handler, "/internal/runtime/quota/reserve", `{"runId":"forged","sid":"`+owner+`","modelId":"gpt-5","estimatedUnits":2048,"payerSid":"`+payer+`"}`, "owner-secret", "127.0.0.1:55000"); response.Code != http.StatusNotFound {
		t.Fatalf("unadmitted shared reserve: %d", response.Code)
	}
	if err := store.ReserveSharedRun(t.Context(), contracts.SharedRunQuotaRequest{RunID: "run-shared-1", OwnerSID: owner, PayerSID: payer, ModelID: "gpt-5", EstimatedUnits: 2048}); err != nil {
		t.Fatal(err)
	}
	beforeClaim := invokeRuntimeQuota(handler, "/internal/runtime/quota/settle", `{"runId":"run-shared-1","sid":"`+owner+`","actualUnits":0}`, "owner-secret", "127.0.0.1:55000")
	if beforeClaim.Code != http.StatusConflict || !strings.Contains(beforeClaim.Body.String(), "quota_run_not_accepted") {
		t.Fatalf("settlement before claim: %d %s", beforeClaim.Code, beforeClaim.Body.String())
	}
	reserved := invokeRuntimeQuota(handler, "/internal/runtime/quota/reserve", `{"runId":"run-shared-1","sid":"`+owner+`","modelId":"gpt-5","estimatedUnits":2048,"payerSid":"`+payer+`"}`, "owner-secret", "127.0.0.1:55000")
	if reserved.Code != http.StatusOK || !strings.Contains(reserved.Body.String(), `"sid":"`+payer+`"`) {
		t.Fatalf("payer reserve response %d: %s", reserved.Code, reserved.Body.String())
	}
	// Payer is now inferred from persisted admission; the runtime need not send it.
	settled := invokeRuntimeQuota(handler, "/internal/runtime/quota/settle", `{"runId":"run-shared-1","sid":"`+owner+`","actualUnits":1500}`, "owner-secret", "127.0.0.1:55000")
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
