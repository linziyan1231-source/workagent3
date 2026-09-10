package quota

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestReservationsShareDatabaseWithUsageRecorder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.db")
	portal, err := Open(path, authorizationStub{authorized: true})
	if err != nil {
		t.Fatal(err)
	}
	defer portal.Close()
	recorder, err := OpenRecorder(path)
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.Close()
	sid := "S-1-5-21-100"
	if err := portal.SetBudget(t.Context(), Budget{SID: sid, ModelID: "codex-native", Period: Daily, LimitUnits: 100000}); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Add(1)
	done := make(chan struct{})
	go func() {
		defer workers.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			if err := recorder.MarkGatewayDrained(t.Context(), time.Now()); err != nil {
				t.Errorf("recorder: %v", err)
				return
			}
		}
	}()
	defer func() { close(done); workers.Wait() }()
	for i := 0; i < 100; i++ {
		id := fmt.Sprintf("concurrent-%d", i)
		if _, err := portal.Reserve(t.Context(), ReserveRequest{RunID: id, SID: sid, ModelID: "codex-native", EstimatedUnits: 1}); err != nil {
			t.Fatalf("reserve %d: %v", i, err)
		}
		if err := portal.Settle(t.Context(), SettleRequest{RunID: id, ActualUnits: 0}); err != nil {
			t.Fatalf("settle %d: %v", i, err)
		}
	}
}
