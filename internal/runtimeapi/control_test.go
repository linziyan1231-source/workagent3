package runtimeapi

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDrainProtectsRequestsAndExpires(t *testing.T) {
	r := NewRegistry()
	now := time.Now()
	r.now = func() time.Time { return now }
	if err := r.Register(Registration{"sid", "http://127.0.0.1:12345", "secret", now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	original := r.Snapshots()[0].LastAccess
	done, err := r.BeginRequest("sid")
	if err != nil {
		t.Fatal(err)
	}
	if r.BeginDrain("sid", original) {
		t.Fatal("drained active request")
	}
	now = now.Add(time.Second)
	done()
	if r.BeginDrain("sid", original) {
		t.Fatal("drained stale activity snapshot")
	}
	if !r.BeginDrain("sid", r.Snapshots()[0].LastAccess) {
		t.Fatal("idle drain failed")
	}
	if _, err := r.Resolve(context.Background(), "sid"); err == nil {
		t.Fatal("accepted request while draining")
	}
	now = now.Add(3 * time.Minute)
	if _, err := r.Resolve(context.Background(), "sid"); err != nil {
		t.Fatal("abandoned drain did not expire")
	}
}

func TestResolveSharesStartupWithoutLeaseProbeRecursion(t *testing.T) {
	r := NewRegistry()
	var starts atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	r.SetStarter(func(ctx context.Context, sid string) error {
		starts.Add(1)
		close(entered)
		<-release
		if _, err := r.Lookup(sid); err == nil {
			t.Error("unexpected lease")
		}
		return r.Register(Registration{sid, "http://127.0.0.1:12345", "secret", time.Now().Add(time.Hour)})
	})
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := r.Resolve(context.Background(), "sid"); err != nil {
				t.Error(err)
			}
		}()
	}
	<-entered
	close(release)
	wg.Wait()
	if starts.Load() != 1 {
		t.Fatalf("starts=%d", starts.Load())
	}
}
