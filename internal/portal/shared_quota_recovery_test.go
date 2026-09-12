package portal

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/quota"
	"workagent3/internal/store"
)

type quotaRecoveryCollaboration struct {
	CollaborationPort
	runs map[string]contracts.SharedRunIdentity
}

type quotaCancellationCollaboration struct {
	CollaborationPort
	run collaboration.AIRun
}

func (c quotaCancellationCollaboration) StopAssistantRun(context.Context, string, string, int64, string) (collaboration.AIRun, collaboration.Message, error) {
	return c.run, collaboration.Message{}, nil
}

type quotaCancellationRuntime struct {
	SharedTurnRunner
	cancel func()
}

func (r quotaCancellationRuntime) Cancel(context.Context, string, string) error {
	r.cancel()
	return nil
}

func TestSharedStopClosesUndispatchedAdmissionBeforeRuntimeCancellation(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run(map[bool]string{false: "unaccepted", true: "accepted"}[accepted], func(t *testing.T) {
			q, err := quota.Open(":memory:", sharedTurnAuthorizerStub{})
			if err != nil {
				t.Fatal(err)
			}
			defer q.Close()
			owner, payer := "S-1-5-21-1", "S-1-5-21-2"
			if err := q.SetBudget(t.Context(), quota.Budget{SID: payer, ModelID: "model", Period: quota.Daily, LimitUnits: 1000}); err != nil {
				t.Fatal(err)
			}
			if err := q.ReserveSharedRun(t.Context(), contracts.SharedRunQuotaRequest{RunID: "stopped", OwnerSID: owner, PayerSID: payer, ModelID: "model", Engine: "codex", EstimatedUnits: 100}); err != nil {
				t.Fatal(err)
			}
			if accepted {
				if _, err := q.ReserveRuntime(t.Context(), owner, payer, quota.ReserveRequest{RunID: "stopped", ModelID: "model", Engine: "codex", EstimatedUnits: 100}); err != nil {
					t.Fatal(err)
				}
			}
			cancelled := false
			runtime := quotaCancellationRuntime{cancel: func() {
				cancelled = true
				value, err := q.LookupRuntimeRun(t.Context(), owner, "stopped")
				want := "settled"
				if accepted {
					want = "reserved"
				}
				if err != nil || value.Status != want {
					t.Fatalf("reservation at runtime cancellation: %+v %v", value, err)
				}
			}}
			s := &Server{sharedEvents: newSharedEventHub(), modules: Modules{SharedRunQuota: q, Collaboration: quotaCancellationCollaboration{run: collaboration.AIRun{ID: "stopped", OwnerSID: owner, PayerSID: payer}}, SharedTurns: runtime}}
			response := httptest.NewRecorder()
			s.cancelSharedRun(response, httptest.NewRequest("POST", "/", strings.NewReader(`{"conversation_id":"conversation","assistant_id":"codex"}`)), store.User{ID: 1})
			if response.Code != 200 || !cancelled {
				t.Fatalf("stop=%d cancelled=%v", response.Code, cancelled)
			}
		})
	}
}

func (c *quotaRecoveryCollaboration) QuotaRunIdentity(_ context.Context, id string) (contracts.SharedRunIdentity, error) {
	if r, ok := c.runs[id]; ok {
		return r, nil
	}
	return contracts.SharedRunIdentity{}, collaboration.ErrNotFound
}

func TestSharedQuotaRecoveryClosesUnacceptedAndRebindsOnlyKnownLegacyRuns(t *testing.T) {
	s, err := quota.Open(":memory:", sharedTurnAuthorizerStub{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := t.Context()
	owner := "S-1-5-21-1"
	payer := "S-1-5-21-2"
	if err := s.SetBudget(ctx, quota.Budget{SID: payer, ModelID: "model", Period: quota.Daily, LimitUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReserveSharedRun(ctx, contracts.SharedRunQuotaRequest{RunID: "unaccepted", OwnerSID: owner, PayerSID: payer, ModelID: "model", Engine: "codex", EstimatedUnits: 100}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"legacy", "unrelated"} {
		if _, err := s.Reserve(ctx, quota.ReserveRequest{RunID: id, SID: payer, ModelID: "model", EstimatedUnits: 100}); err != nil {
			t.Fatal(err)
		}
	}
	c := &quotaRecoveryCollaboration{runs: map[string]contracts.SharedRunIdentity{}}
	for _, id := range []string{"unaccepted", "legacy"} {
		c.runs[id] = contracts.SharedRunIdentity{RunID: id, OwnerSID: owner, PayerSID: payer, Engine: "codex", State: "failed"}
	}
	server := &Server{modules: Modules{Collaboration: c, SharedRunQuota: s}}
	for i := 0; i < 2; i++ {
		if err := server.reconcileSharedQuota(ctx); err != nil {
			t.Fatal(err)
		}
	}
	closed, err := s.LookupRuntimeRun(ctx, owner, "unaccepted")
	if err != nil || closed.Status != "settled" {
		t.Fatalf("unaccepted not closed: %+v %v", closed, err)
	}
	legacy, err := s.LookupRuntimeRun(ctx, owner, "legacy")
	if err != nil || !legacy.Accepted || legacy.Status != "reserved" {
		t.Fatalf("legacy inferred as unused: %+v %v", legacy, err)
	}
	if _, err := s.LookupRuntimeRun(ctx, owner, "unrelated"); !errors.Is(err, quota.ErrReservationNotFound) {
		t.Fatalf("unrelated reservation authorized: %v", err)
	}
	if err := s.SettleRuntime(ctx, owner, "", quota.SettleRequest{RunID: "legacy", ActualUnits: 50}); err != nil {
		t.Fatal(err)
	}
}
