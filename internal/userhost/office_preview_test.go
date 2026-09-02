package userhost

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestOfficePreviewService(t *testing.T, runs *int32) *officePreviewService {
	t.Helper()
	service, err := newOfficePreviewService(filepath.Join(t.TempDir(), "cache"), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	service.lookPath = func(string) (string, error) { return `C:\tools\officecli.exe`, nil }
	service.run = func(_ context.Context, _, _, output string) error {
		if runs != nil {
			atomic.AddInt32(runs, 1)
		}
		return os.WriteFile(output, []byte("%PDF-1.7 test"), 0o600)
	}
	return service
}

func writeOfficeSource(t *testing.T, directory, name string, content []byte) string {
	t.Helper()
	source := filepath.Join(directory, name)
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return source
}

func TestOfficePreviewConvertCachesByContentHash(t *testing.T) {
	var runs int32
	service := newTestOfficePreviewService(t, &runs)
	directory := t.TempDir()
	source := writeOfficeSource(t, directory, "report.docx", []byte("version one"))

	first, err := service.convert(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.convert(t.Context(), source)
	if err != nil || second != first {
		t.Fatalf("second convert = %q, %v", second, err)
	}
	if runs != 1 {
		t.Fatalf("officecli invocations = %d, want cache hit", runs)
	}
	if info, err := os.Stat(filepath.Join(service.cacheDir, first+".pdf")); err != nil || info.Size() == 0 {
		t.Fatalf("cached pdf missing: %v", err)
	}

	writeOfficeSource(t, directory, "report.docx", []byte("version two"))
	third, err := service.convert(t.Context(), source)
	if err != nil || third == first || runs != 2 {
		t.Fatalf("changed content = hash %q runs %d", third, runs)
	}
}

func TestOfficePreviewRejectsOversizedSource(t *testing.T) {
	service := newTestOfficePreviewService(t, nil)
	service.maxSourceBytes = 8
	source := writeOfficeSource(t, t.TempDir(), "big.xlsx", []byte("0123456789abcdef"))
	if _, err := service.convert(t.Context(), source); !errors.Is(err, errOfficePreviewTooLarge) {
		t.Fatalf("oversized source error = %v", err)
	}
}

func TestOfficePreviewRejectsOversizedOutput(t *testing.T) {
	service := newTestOfficePreviewService(t, nil)
	service.maxOutputBytes = 4
	service.run = func(_ context.Context, _, _, output string) error {
		return os.WriteFile(output, []byte("0123456789"), 0o600)
	}
	source := writeOfficeSource(t, t.TempDir(), "slides.pptx", []byte("deck"))
	if _, err := service.convert(t.Context(), source); !errors.Is(err, errOfficePreviewTooLarge) {
		t.Fatalf("oversized output error = %v", err)
	}
}

func TestOfficePreviewConvertIsCancelable(t *testing.T) {
	service := newTestOfficePreviewService(t, nil)
	service.run = func(ctx context.Context, _, _, _ string) error {
		<-ctx.Done()
		return ctx.Err()
	}
	source := writeOfficeSource(t, t.TempDir(), "report.docx", []byte("content"))
	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	if _, err := service.convert(ctx, source); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled convert error = %v", err)
	}
}

func TestOfficePreviewMissingOfficeCLI(t *testing.T) {
	service := newTestOfficePreviewService(t, nil)
	service.lookPath = func(string) (string, error) { return "", errors.New("not found") }
	source := writeOfficeSource(t, t.TempDir(), "report.docx", []byte("content"))
	if _, err := service.convert(t.Context(), source); !errors.Is(err, errOfficeCLINotFound) {
		t.Fatalf("missing officecli error = %v", err)
	}

	// A configured managed tools root without the binary must not be trusted
	// either; the PATH fallback is what can still locate officecli.
	service.managedToolsRoot = t.TempDir()
	if _, err := service.convert(t.Context(), source); !errors.Is(err, errOfficeCLINotFound) {
		t.Fatalf("empty managed root error = %v", err)
	}
}

func TestOfficePreviewConcurrencyLimit(t *testing.T) {
	service := newTestOfficePreviewService(t, nil)
	service.sem = make(chan struct{}, 1)
	var active, maxActive int32
	gate := make(chan struct{})
	service.run = func(_ context.Context, _, _, output string) error {
		current := atomic.AddInt32(&active, 1)
		for {
			peak := atomic.LoadInt32(&maxActive)
			if current <= peak || atomic.CompareAndSwapInt32(&maxActive, peak, current) {
				break
			}
		}
		<-gate
		atomic.AddInt32(&active, -1)
		return os.WriteFile(output, []byte("%PDF"), 0o600)
	}
	directory := t.TempDir()
	first := writeOfficeSource(t, directory, "a.docx", []byte("a"))
	second := writeOfficeSource(t, directory, "b.docx", []byte("b"))

	done := make(chan error, 2)
	go func() {
		_, err := service.convert(t.Context(), first)
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&active) != 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	go func() {
		_, err := service.convert(t.Context(), second)
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	if atomic.LoadInt32(&active) != 1 {
		t.Fatal("second conversion started despite the concurrency limit")
	}
	close(gate)
	for index := 0; index < 2; index++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if atomic.LoadInt32(&maxActive) != 1 {
		t.Fatalf("peak concurrency = %d, want 1", maxActive)
	}
}

func TestOfficePreviewConvertHandler(t *testing.T) {
	service := newTestOfficePreviewService(t, nil)
	workspaceRoot := t.TempDir()
	writeOfficeSource(t, filepath.Join(workspaceRoot, "workspace-1"), "docs/report.docx", []byte("content"))
	handler := officePreviewConvertHandler(service, workspaceRoot)

	call := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/office-preview/convert", strings.NewReader(body))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	ok := call(`{"workspace":"workspace-1","path":"docs/report.docx"}`)
	if ok.Code != http.StatusOK || !strings.Contains(ok.Body.String(), `"hash"`) {
		t.Fatalf("convert = %d %s", ok.Code, ok.Body.String())
	}
	if traversal := call(`{"workspace":"workspace-1","path":"../secret.docx"}`); traversal.Code != http.StatusBadRequest || !strings.Contains(traversal.Body.String(), "PATH_OUTSIDE_SANDBOX") {
		t.Fatalf("traversal = %d %s", traversal.Code, traversal.Body.String())
	}
	if badWorkspace := call(`{"workspace":"..","path":"a.docx"}`); badWorkspace.Code != http.StatusBadRequest {
		t.Fatalf("workspace id = %d %s", badWorkspace.Code, badWorkspace.Body.String())
	}
	if missing := call(`{"workspace":"workspace-1","path":"docs/missing.docx"}`); missing.Code != http.StatusNotFound {
		t.Fatalf("missing = %d %s", missing.Code, missing.Body.String())
	}
	writeOfficeSource(t, filepath.Join(workspaceRoot, "workspace-1"), "notes.txt", []byte("text"))
	if unsupported := call(`{"workspace":"workspace-1","path":"notes.txt"}`); unsupported.Code != http.StatusBadRequest || !strings.Contains(unsupported.Body.String(), "office_preview_unsupported_type") {
		t.Fatalf("unsupported = %d %s", unsupported.Code, unsupported.Body.String())
	}
}

func TestOfficePreviewContentHandlerServesSandboxedPDF(t *testing.T) {
	service := newTestOfficePreviewService(t, nil)
	name := strings.Repeat("ab", 32) + ".pdf"
	if err := os.WriteFile(filepath.Join(service.cacheDir, name), []byte("%PDF-1.7 cached"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := officePreviewContentHandler(service)

	request := httptest.NewRequest(http.MethodGet, "/v1/office-preview/content/"+name, nil)
	request.SetPathValue("name", name)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "%PDF-1.7 cached" {
		t.Fatalf("content = %d %q", response.Code, response.Body.String())
	}
	if policy := response.Header().Get("content-security-policy"); !strings.Contains(policy, "default-src 'none'") || !strings.Contains(policy, "frame-ancestors 'self'") {
		t.Fatalf("CSP = %q", policy)
	}
	if disposition := response.Header().Get("content-disposition"); !strings.HasPrefix(disposition, "inline;") {
		t.Fatalf("disposition = %q", disposition)
	}
	if response.Header().Get("content-type") != "application/pdf" {
		t.Fatalf("content-type = %q", response.Header().Get("content-type"))
	}
	if response.Header().Get("cache-control") != "no-store" {
		t.Fatalf("cache-control = %q", response.Header().Get("cache-control"))
	}

	bad := httptest.NewRequest(http.MethodGet, "/v1/office-preview/content/evil.pdf", nil)
	bad.SetPathValue("name", "evil.pdf")
	rejected := httptest.NewRecorder()
	handler.ServeHTTP(rejected, bad)
	if rejected.Code != http.StatusNotFound {
		t.Fatalf("invalid name = %d", rejected.Code)
	}
}

func TestOfficePreviewIntegrationRealOfficeCLI(t *testing.T) {
	toolPath, err := filepath.Abs(filepath.Join("..", "..", "release", "managed-tools", "officecli", "officecli.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(toolPath); err != nil || !info.Mode().IsRegular() {
		t.Skip("managed OfficeCLI binary is not installed")
	}
	// PDF export is an OfficeCLI exporter plugin; skip where only the bare
	// managed binary is installed.
	if plugins, err := exec.Command(toolPath, "plugins", "list").CombinedOutput(); err != nil || strings.Contains(string(plugins), "No plugins installed") {
		t.Skipf("OfficeCLI PDF exporter plugin is not installed: %s", strings.TrimSpace(string(plugins)))
	}
	service, err := newOfficePreviewService(filepath.Join(t.TempDir(), "cache"), filepath.Dir(toolPath), nil)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "sample.docx")
	if output, err := exec.Command(toolPath, "create", source).CombinedOutput(); err != nil {
		t.Fatalf("officecli create: %v\n%s", err, output)
	}
	// create leaves a resident process pinning the file; close flushes and
	// releases it so the conversion (and the test cleanup) can read it.
	if output, err := exec.Command(toolPath, "close", source).CombinedOutput(); err != nil {
		t.Fatalf("officecli close: %v\n%s", err, output)
	}
	hash, err := service.convert(t.Context(), source)
	if err != nil {
		t.Fatalf("real conversion failed: %v", err)
	}
	converted, err := os.ReadFile(filepath.Join(service.cacheDir, hash+".pdf"))
	if err != nil || !strings.HasPrefix(string(converted), "%PDF") {
		t.Fatalf("converted payload is not a PDF: %v", err)
	}
	again, err := service.convert(t.Context(), source)
	if err != nil || again != hash {
		t.Fatalf("cache hit = %q, %v", again, err)
	}
}
