//go:build windows

package publishedapps

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"workagent3/internal/winutil"
)

func copyTestExecutable(t *testing.T, source, target string) {
	t.Helper()
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(output, input)
	output.Close()
	if err != nil {
		t.Fatal(err)
	}
}
func TestWindowsRunnerSnapshotAndColdStart(t *testing.T) {
	if os.Getenv("WORKAGENT_APP_ISOLATION_TEST") != "1" {
		t.Skip("explicit Windows isolation acceptance")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	owner := user.User.Sid.String()
	root := t.TempDir()
	software := filepath.Join(root, "software")
	os.Mkdir(software, 0700)
	executable, _ := os.Executable()
	worker := filepath.Join(software, "userhost.exe")
	copyTestExecutable(t, executable, worker)
	nodeSource, err := exec.LookPath("node.exe")
	if err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(software, "node.exe")
	copyTestExecutable(t, nodeSource, node)
	pythonRootRaw, err := exec.Command("python.exe", "-c", "import sys;print(sys.prefix)").Output()
	if err != nil {
		t.Fatal(err)
	}
	pythonRoot := strings.TrimSpace(string(pythonRootRaw))
	pythonDir := filepath.Join(software, "python")
	os.Mkdir(pythonDir, 0700)
	err = filepath.WalkDir(pythonRoot, func(source string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, _ := filepath.Rel(pythonRoot, source)
		if relative == "." {
			return nil
		}
		if entry.IsDir() && (entry.Name() == "site-packages" || entry.Name() == "__pycache__" || relative == "include" || relative == "libs" || relative == "Scripts" || relative == "tcl") {
			return filepath.SkipDir
		}
		target := filepath.Join(pythonDir, relative)
		if entry.IsDir() {
			return os.Mkdir(target, 0700)
		}
		copyTestExecutable(t, source, target)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"static", "node", "python"} {
		t.Run(kind, func(t *testing.T) {
			id := "runner_" + strings.Repeat(kind[:1], 17)
			version := "version" + strings.Repeat(kind[:1], 17)
			if err = winutil.ProtectAppTree(software, owner, "S-1-15-2-1", false); err != nil {
				t.Fatal(err)
			}
			job, err := winutil.NewJob("", winutil.JobLimits{MemoryBytes: 768 * 1024 * 1024, CPUPercent: 50, ActiveProcesses: 12})
			if err != nil {
				t.Fatal(err)
			}
			defer job.Close()
			rule := winutil.AppNetworkRule{AppID: id, Version: version}
			defer func() {
				if err := winutil.DisableAppNetwork(rule); err != nil {
					t.Error(err)
				}
				if err := winutil.DeleteAppContainer(id, version); err != nil {
					t.Error(err)
				}
			}()
			runner, err := NewRunner(RunnerConfig{Root: filepath.Join(root, kind, "apps"), OwnerSID: owner, OwnerJob: job, WorkerCommand: worker, NodeCommand: node, PythonCommand: filepath.Join(pythonDir, "python.exe"), AuthorizeNetwork: func(ctx context.Context, value winutil.AppNetworkRule) (string, error) {
				return winutil.EnableAppNetwork(value)
			}, RevokeNetwork: func(ctx context.Context, value winutil.AppNetworkRule) error {
				return winutil.DisableAppNetwork(value)
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer runner.Close()
			source := filepath.Join(root, kind, "source")
			os.MkdirAll(source, 0700)
			entry := "index.html"
			content := "frozen version"
			if kind == "node" {
				entry = "server.js"
				content = `const http=require('http'),fs=require('fs');fs.writeFileSync(process.env.APP_DATA+'/started','yes');http.createServer((q,s)=>s.end('frozen version')).listen(Number(process.env.PORT),'127.0.0.1');`
			}
			os.WriteFile(filepath.Join(source, entry), []byte(content), 0600)
			if kind == "python" {
				entry = "server.py"
				content = "import os\nfrom http.server import HTTPServer,BaseHTTPRequestHandler\nopen(os.path.join(os.environ['APP_DATA'],'started'),'w').write('yes')\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200)\n  self.end_headers()\n  self.wfile.write(b'frozen version')\nHTTPServer(('127.0.0.1',int(os.environ['PORT'])),Handler).serve_forever()\n"
				os.Remove(filepath.Join(source, "index.html"))
				os.WriteFile(filepath.Join(source, entry), []byte(content), 0600)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
			defer cancel()
			manifest, err := runner.Snapshot(ctx, id, source, entry, Manifest{Version: version, Kind: kind, Entry: entry})
			if err != nil {
				filepath.WalkDir(filepath.Join(root, kind), func(p string, d os.DirEntry, e error) error {
					if e == nil && !d.IsDir() && strings.HasSuffix(p, ".log") {
						raw, _ := os.ReadFile(p)
						t.Logf("%s: %s", filepath.Base(p), raw)
					}
					return nil
				})
				t.Fatal(err)
			}
			if manifest.FileCount != 1 {
				t.Fatal(manifest)
			}
			if _, err = os.Stat(filepath.Join(root, kind, "apps", id, "appdata", "started")); !os.IsNotExist(err) {
				t.Fatal("validation touched production data")
			}
			os.WriteFile(filepath.Join(source, entry), []byte("changed workspace"), 0600)
			for index := 0; index < 2; index++ {
				address, release, err := runner.Acquire(ctx, id, version, false)
				if err != nil {
					t.Fatal(err)
				}
				response, err := (&http.Client{Timeout: 2 * time.Second}).Get(address.String())
				if err != nil {
					t.Fatal(err)
				}
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				release()
				if string(body) != "frozen version" {
					t.Fatal(string(body))
				}
				if !runner.Activity() {
					t.Fatal("activity missing")
				}
				if runner.Status(id, "").State != "running" {
					t.Fatal("latest status omitted production process")
				}
				runner.Stop(id)
			}
			if kind == "node" {
				testWindowsRunnerLifecycle(t, runner, source, id, version, entry, content)
			}
		})
	}
}

func waitRunnerTest(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("application transition did not finish")
}
func testWindowsRunnerLifecycle(t *testing.T, runner *Runner, source, id, version, entry, content string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	_, release, err := runner.Acquire(ctx, id, version, false)
	if err != nil {
		t.Fatal(err)
	}
	release()
	runner.mu.Lock()
	instance := runner.running[id+":"+version]
	runner.mu.Unlock()
	if err = instance.broker.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-instance.process.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("backend survived its outbound broker")
	}
	waitRunnerTest(t, func() bool { return runner.Status(id, version).State == "failed" })
	runner.Stop(id)

	// Simulate a slowly starting valid package, then cancel through the owner
	// Stop API. Status must remain available while startup is pending.
	directory, _ := runner.versionPath(id, version)
	slow := `setTimeout(()=>{` + content + `},10000);`
	if err = os.WriteFile(filepath.Join(directory, "bundle", entry), []byte(slow), 0600); err != nil {
		t.Fatal(err)
	}
	first := make(chan error, 1)
	go func() {
		_, release, err := runner.Acquire(ctx, id, version, false)
		if release != nil {
			release()
		}
		first <- err
	}()
	waitRunnerTest(t, func() bool { return runner.Status(id, version).State == "starting" })
	stopped := make(chan struct{})
	go func() { runner.Stop(id); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop blocked behind startup")
	}
	if err = <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled startup: %v", err)
	}
	if status := runner.Status(id, ""); status.State != "stopped" {
		t.Fatalf("owner stop reported failure: %#v", status)
	}

	// A second version must cancel and join the older startup before opening
	// production appdata. The fixture creates a frozen bundle directly.
	secondVersion := strings.Repeat("b", 24)
	secondDirectory, _ := runner.versionPath(id, secondVersion)
	os.WriteFile(filepath.Join(source, entry), []byte(content), 0600)
	if err = RunSnapshot(SnapshotInput{SourceRoot: source, Entry: entry, Destination: secondDirectory, Manifest: Manifest{AppID: id, Version: secondVersion, Kind: "node"}}); err != nil {
		t.Fatal(err)
	}
	defer winutil.DeleteAppContainer(id, secondVersion)
	go func() {
		_, release, err := runner.Acquire(ctx, id, version, false)
		if release != nil {
			release()
		}
		first <- err
	}()
	waitRunnerTest(t, func() bool { return runner.Status(id, version).State == "starting" })
	_, release, err = runner.Acquire(ctx, id, secondVersion, false)
	if err != nil {
		t.Fatal(err)
	}
	release()
	if err = <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("superseded startup: %v", err)
	}
	runner.mu.Lock()
	running := len(runner.running)
	runner.mu.Unlock()
	if running != 1 {
		t.Fatalf("concurrent production versions: %d", running)
	}
	runner.Stop(id)

	failedVersion := strings.Repeat("f", 24)
	os.WriteFile(filepath.Join(source, entry), []byte(`throw new Error('publish diagnostic sample');`), 0600)
	_, err = runner.Snapshot(ctx, id, source, entry, Manifest{Version: failedVersion, Kind: "node"})
	if err == nil {
		t.Fatal("broken backend passed validation")
	}
	failedDirectory, _ := runner.versionPath(id, failedVersion)
	for _, path := range []string{failedDirectory, failedDirectory + ".staging", failedDirectory + ".input.json", failedDirectory + ".snapshot.log"} {
		if _, err = os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("failed snapshot retained %s: %v", path, err)
		}
	}
	status := runner.Status(id, "")
	if status.State != "failed" || !strings.Contains(status.LogTail, "publish diagnostic sample") {
		t.Fatalf("latest failure lost diagnostic: %#v", status)
	}

	cancelledVersion := strings.Repeat("c", 24)
	os.WriteFile(filepath.Join(source, entry), []byte(`setInterval(()=>{},1000);`), 0600)
	copyContext, cancelCopy := context.WithCancel(ctx)
	go func() {
		_, err := runner.Snapshot(copyContext, id, source, entry, Manifest{Version: cancelledVersion, Kind: "node"})
		first <- err
	}()
	cancelledDirectory, _ := runner.versionPath(id, cancelledVersion)
	waitRunnerTest(t, func() bool {
		_, err := os.Stat(filepath.Join(cancelledDirectory, "run", "broker.json"))
		return err == nil
	})
	cancelCopy()
	select {
	case err = <-first:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled snapshot: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("snapshot cancellation did not join process")
	}
	for _, path := range []string{cancelledDirectory, cancelledDirectory + ".staging", cancelledDirectory + ".input.json"} {
		if _, err = os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("cancelled snapshot retained %s", path)
		}
	}
}
