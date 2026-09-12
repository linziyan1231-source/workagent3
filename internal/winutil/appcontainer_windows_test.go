//go:build windows

package winutil

import (
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestMain(m *testing.M) {
	mode := os.Getenv("WORKAGENT_ISOLATION_HELPER")
	if mode == "" {
		os.Exit(m.Run())
	}
	write := func(name string, value any) {
		raw, _ := json.Marshal(value)
		if err := os.WriteFile(filepath.Join(os.Getenv("APP_DATA"), name), raw, 0600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
	}
	switch mode {
	case "registry":
		key, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\WorkAgentIsolationProbe`, registry.SET_VALUE)
		if err == nil {
			key.Close()
			registry.DeleteKey(registry.CURRENT_USER, `Software\WorkAgentIsolationProbe`)
		}
		write("registry.json", map[string]any{"denied": errors.Is(err, windows.ERROR_ACCESS_DENIED), "error": fmt.Sprint(err)})
	case "tree":
		executable, _ := os.Executable()
		child := exec.Command(executable)
		child.Env = []string{"SystemRoot=" + os.Getenv("SystemRoot"), "WORKAGENT_ISOLATION_HELPER=hold"}
		child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		write("tree.json", map[string]uint32{"childPID": uint32(child.Process.Pid)})
		time.Sleep(time.Minute)
	case "hold":
		time.Sleep(time.Minute)
	case "memory":
		baseline, baselineErr := windows.VirtualAlloc(0, 16*1024*1024, windows.MEM_COMMIT|windows.MEM_RESERVE, windows.PAGE_READWRITE)
		if baseline != 0 {
			windows.VirtualFree(baseline, 0, windows.MEM_RELEASE)
		}
		oversized, oversizedErr := windows.VirtualAlloc(0, 512*1024*1024, windows.MEM_COMMIT|windows.MEM_RESERVE, windows.PAGE_READWRITE)
		if oversized != 0 {
			windows.VirtualFree(oversized, 0, windows.MEM_RELEASE)
		}
		write("memory.json", map[string]any{"baseline": baseline != 0 && baselineErr == nil, "denied": oversized == 0 && oversizedErr != nil, "error": fmt.Sprint(oversizedErr)})
	case "cpu":
		var stop atomic.Bool
		for i := 0; i < min(runtime.NumCPU(), 8); i++ {
			go func() {
				for !stop.Load() {
				}
			}()
		}
		write("cpu-ready.json", true)
		time.Sleep(10 * time.Second)
		stop.Store(true)
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

func copyIsolationExecutable(t *testing.T, source, target string) {
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
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
}

func waitIsolationJSON(t *testing.T, path string, result any) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(path); err == nil && json.Unmarshal(raw, result) == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("isolation helper did not report %s", filepath.Base(path))
}

func assertOwnerJob(t *testing.T, job *Job, pid uint32) windows.Handle {
	t.Helper()
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { windows.CloseHandle(handle) })
	var contained int32
	ok, _, callErr := windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob").Call(uintptr(handle), uintptr(job.handle), uintptr(unsafe.Pointer(&contained)))
	if ok == 0 || contained != 1 {
		t.Fatalf("process %d escaped owner job: %v", pid, callErr)
	}
	return handle
}

func TestAppContainerBoundary(t *testing.T) {
	if os.Getenv("WORKAGENT_APP_ISOLATION_TEST") != "1" {
		t.Skip("explicit Windows isolation acceptance")
	}
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	owner := user.User.Sid.String()
	root := t.TempDir()
	bundle := filepath.Join(root, "bundle")
	data := filepath.Join(root, "data")
	private := filepath.Join(root, "private")
	foreign := filepath.Join(root, "another-owner")
	for _, dir := range []string{bundle, data, private, foreign} {
		if err = os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err = EnsurePrivateTree(private, owner); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(private, "secret"), []byte("private"), 0600)
	executable, err := exec.LookPath("node.exe")
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target, err := os.Create(filepath.Join(bundle, "node.exe"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(target, source)
	target.Close()
	if err != nil {
		t.Fatal(err)
	}
	broker, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })}
	go server.Serve(broker)
	defer server.Close()
	forbidden, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer forbidden.Close()
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	backendPort := backend.Addr().(*net.TCPAddr).Port
	backend.Close()
	appID := "testapp_1234567890123456"
	version := "testver_1234567890123456"
	identity, profile, err := PrepareAppContainer(appID, version)
	if err != nil {
		t.Fatal(err)
	}
	if err = ProtectAppTree(profile, owner, identity, false); err != nil {
		t.Fatal(err)
	}
	if err = ProtectAppProfileRegistry(appID, version, owner); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(foreign, "secret"), []byte("another owner"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = ProtectAppTree(foreign, "S-1-5-21-1-2-3-99999", identity, true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		descriptor, _ := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + owner + ")")
		acl, _, _ := descriptor.DACL()
		// Restore known paths directly; a recursive walker cannot enumerate the
		// deliberately foreign-owned root until this grant has been restored.
		for _, path := range []string{foreign, filepath.Join(foreign, "secret")} {
			if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
				t.Error(err)
			}
		}
	})
	// Remove the administrator grant too: the acceptance host is an administrator,
	// while production employees are standard users. Keep the SAME package SID
	// grant so the second AppContainer check alone cannot satisfy owner isolation.
	foreignSD, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-99999)(A;OICI;0x1301bf;;;" + identity + ")")
	if err != nil {
		t.Fatal(err)
	}
	foreignACL, _, err := foreignSD.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{foreign, filepath.Join(foreign, "secret")} {
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, foreignACL, nil); err != nil {
			t.Fatal(err)
		}
	}
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	copyIsolationExecutable(t, testExecutable, filepath.Join(bundle, "probe.exe"))
	if err = ProtectAppTree(bundle, owner, identity, false); err != nil {
		t.Fatal(err)
	}
	if err = ProtectAppTree(data, owner, identity, true); err != nil {
		t.Fatal(err)
	}
	script := `const fs=require('fs'),net=require('net'),http=require('http');
const data=process.env.APP_DATA,checks={};
checks.packageReadable=fs.readFileSync(__filename).length>0;
fs.writeFileSync(data+'/progress','filesystem');
try{fs.readFileSync(process.env.PRIVATE);checks.privateDenied=false}catch{checks.privateDenied=true}
try{fs.writeFileSync(__filename,'x');checks.packageReadOnly=false}catch{checks.packageReadOnly=true}
try{fs.readFileSync(process.env.FOREIGN+'/secret');checks.foreignReadDenied=false}catch{checks.foreignReadDenied=true}
try{fs.writeFileSync(process.env.FOREIGN+'/new','x');checks.foreignWriteDenied=false}catch{checks.foreignWriteDenied=true}
try{fs.writeFileSync(process.env.APP_PROFILE+'/write-probe','x');checks.profileReadOnly=false}catch{checks.profileReadOnly=true}
function connect(port,host='127.0.0.1'){return new Promise(r=>{const s=net.connect({host,port});s.setTimeout(1000);s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.on('timeout',()=>{s.destroy();r(false)})})}
(async()=>{checks.brokerAllowed=await connect(Number(process.env.BROKER));checks.privateNetworkDenied=!(await connect(Number(process.env.FORBIDDEN)));checks.ipv6Denied=!(await connect(Number(process.env.IPV6),'::1'));checks.directInternetDenied=!(await connect(443,'1.1.1.1'));fs.writeFileSync(data+'/result.json',JSON.stringify(checks));http.createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');setTimeout(()=>process.exit(),30000)})();`
	// The script is created after the root ACL and inherits its package grant.
	os.WriteFile(filepath.Join(bundle, "app.js"), []byte(script), 0600)
	rule := AppNetworkRule{AppID: appID, Version: version, BackendPort: backendPort, BrokerPort: broker.Addr().(*net.TCPAddr).Port}
	t.Cleanup(func() {
		if err := DisableAppNetwork(rule); err != nil {
			t.Error(err)
		}
		if err := DeleteAppContainer(appID, version); err != nil {
			t.Error(err)
		}
	})
	if _, err = EnableAppNetwork(rule); err != nil {
		t.Fatal(err)
	}
	job, err := NewJob("", JobLimits{MemoryBytes: 512 * 1024 * 1024, CPUPercent: 20, ActiveProcesses: 8})
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	options := AppProcessOptions{Executable: filepath.Join(bundle, "node.exe"), Arguments: []string{"app.js"}, Directory: bundle, PackageSID: identity, OwnerJob: job, Environment: []string{"SystemRoot=" + os.Getenv("SystemRoot"), "APP_DATA=" + data, "PRIVATE=" + filepath.Join(private, "secret"), "BROKER=" + strconv.Itoa(rule.BrokerPort), "FORBIDDEN=" + strconv.Itoa(forbidden.Addr().(*net.TCPAddr).Port), "PORT=" + strconv.Itoa(backendPort)}}
	options.Environment = append(options.Environment, "USERPROFILE="+data, "LOCALAPPDATA="+data, "APPDATA="+data, "TEMP="+data, "TMP="+data, "windir="+os.Getenv("SystemRoot"))
	options.LogPath = filepath.Join(data, "process.log")
	ipv6, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ipv6.Close()
	options.Environment = append(options.Environment, "FOREIGN="+foreign, "APP_PROFILE="+profile, "IPV6="+strconv.Itoa(ipv6.Addr().(*net.TCPAddr).Port))
	// A live unrestricted connection is required: timeout is not proof of a deny.
	for _, endpoint := range []string{ipv6.Addr().String(), "1.1.1.1:443"} {
		connection, err := net.DialTimeout("tcp", endpoint, 5*time.Second)
		if err != nil {
			t.Fatalf("unrestricted network control %s failed: %v", endpoint, err)
		}
		connection.Close()
	}
	registryOptions := options
	registryOptions.Executable = filepath.Join(bundle, "probe.exe")
	registryOptions.Arguments = nil
	registryOptions.LogPath = filepath.Join(data, "registry.log")
	registryOptions.Environment = append(append([]string{}, options.Environment...), "WORKAGENT_ISOLATION_HELPER=registry")
	registryProcess, err := StartAppProcess(registryOptions)
	if err != nil {
		t.Fatal(err)
	}
	defer registryProcess.Close()
	var registryResult struct {
		Denied bool   `json:"denied"`
		Error  string `json:"error"`
	}
	waitIsolationJSON(t, filepath.Join(data, "registry.json"), &registryResult)
	if !registryResult.Denied {
		t.Fatalf("HKCU create did not return access denied: %+v", registryResult)
	}
	if err = registryProcess.Wait(); err != nil {
		t.Fatal(err)
	}
	t.Logf("HKCU CreateKey rejected: %s", registryResult.Error)
	options.Arguments = []string{"--preserve-symlinks", "--preserve-symlinks-main", "app.js"}
	process, err := StartAppProcess(options)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	var results map[string]bool
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		raw, e := os.ReadFile(filepath.Join(data, "result.json"))
		if e == nil {
			if e = json.Unmarshal(raw, &results); e != nil {
				t.Fatal(e)
			}
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(results) != 10 {
		log, _ := os.ReadFile(options.LogPath)
		progress, _ := os.ReadFile(filepath.Join(data, "progress"))
		t.Fatalf("application did not report: %#v; progress %s; log: %s", results, progress, log)
	}
	for key, passed := range results {
		if !passed {
			t.Errorf("boundary failed: %s", key)
		}
		t.Logf("%s=%t", key, passed)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(backendPort))
	for retries := 0; err != nil && retries < 20; retries++ {
		time.Sleep(50 * time.Millisecond)
		response, err = client.Get("http://127.0.0.1:" + strconv.Itoa(backendPort))
	}
	if err != nil {
		log, _ := os.ReadFile(options.LogPath)
		t.Fatalf("backend: %v; log: %s", err, log)
	}
	response.Body.Close()
	assertOwnerJob(t, job, process.PID)
}

func TestAppContainerOwnerJobHardLimits(t *testing.T) {
	if os.Getenv("WORKAGENT_APP_ISOLATION_TEST") != "1" {
		t.Skip("explicit Windows isolation acceptance")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	start := func(t *testing.T, job *Job, root, mode string) *AppProcess {
		t.Helper()
		process, err := StartAppProcess(AppProcessOptions{Executable: executable, Directory: root, OwnerJob: job,
			Environment: []string{"SystemRoot=" + os.Getenv("SystemRoot"), "WORKAGENT_ISOLATION_HELPER=" + mode, "APP_DATA=" + root},
			LogPath:     filepath.Join(root, mode+"-"+strconv.FormatInt(time.Now().UnixNano(), 10)+".log")})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { process.Close() })
		return process
	}
	t.Run("descendants-process-cap-and-close-wait", func(t *testing.T) {
		root := t.TempDir()
		job, err := NewJob("", JobLimits{MemoryBytes: 512 * 1024 * 1024, CPUPercent: 20, ActiveProcesses: 3})
		if err != nil {
			t.Fatal(err)
		}
		defer job.Close()
		parent := start(t, job, root, "tree")
		var tree struct {
			ChildPID uint32 `json:"childPID"`
		}
		waitIsolationJSON(t, filepath.Join(root, "tree.json"), &tree)
		parentHandle := assertOwnerJob(t, job, parent.PID)
		childHandle := assertOwnerJob(t, job, tree.ChildPID)
		third := start(t, job, root, "hold")
		fourth, err := StartAppProcess(AppProcessOptions{Executable: executable, Directory: root, OwnerJob: job, Environment: []string{"SystemRoot=" + os.Getenv("SystemRoot"), "WORKAGENT_ISOLATION_HELPER=hold"}})
		if err == nil {
			fourth.Close()
			t.Fatal("fourth process exceeded aggregate active-process cap of three")
		}
		t.Logf("fourth process rejected at owner Job cap: %v", err)
		third.Close()
		replacement := start(t, job, root, "hold")
		assertOwnerJob(t, job, replacement.PID)
		replacement.Close()
		waits := make(chan error, 4)
		for i := 0; i < 4; i++ {
			go func() { waits <- parent.Wait() }()
		}
		if err := parent.Close(); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 4; i++ {
			select {
			case err := <-waits:
				if errors.Is(err, windows.ERROR_INVALID_HANDLE) {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("Close left a concurrent Wait blocked")
			}
		}
		for _, handle := range []windows.Handle{parentHandle, childHandle} {
			status, err := windows.WaitForSingleObject(handle, 3000)
			if err != nil || status != windows.WAIT_OBJECT_0 {
				t.Fatalf("child Job close left descendant alive: %d %v", status, err)
			}
		}
		t.Log("parent and real child belonged to owner Job; slot recovered; Close killed both and completed all Wait callers")
	})
	t.Run("memory-hard-cap", func(t *testing.T) {
		root := t.TempDir()
		// Prove the host can satisfy the same reservation outside the tested Job;
		// system-wide commit exhaustion must not masquerade as quota enforcement.
		control, controlErr := windows.VirtualAlloc(0, 512*1024*1024, windows.MEM_COMMIT|windows.MEM_RESERVE, windows.PAGE_READWRITE)
		if controlErr != nil || control == 0 {
			t.Fatalf("unrestricted memory control failed: %v", controlErr)
		}
		if err := windows.VirtualFree(control, 0, windows.MEM_RELEASE); err != nil {
			t.Fatal(err)
		}
		job, err := NewJob("", JobLimits{MemoryBytes: 256 * 1024 * 1024, CPUPercent: 20, ActiveProcesses: 3})
		if err != nil {
			t.Fatal(err)
		}
		defer job.Close()
		process := start(t, job, root, "memory")
		var result struct {
			Baseline bool   `json:"baseline"`
			Denied   bool   `json:"denied"`
			Error    string `json:"error"`
		}
		waitIsolationJSON(t, filepath.Join(root, "memory.json"), &result)
		if !result.Baseline || !result.Denied {
			t.Fatalf("owner memory hard-cap failed: %+v", result)
		}
		if err := process.Wait(); err != nil {
			t.Fatal(err)
		}
		t.Logf("16 MiB allocation succeeded; 512 MiB allocation under 256 MiB owner cap rejected: %s", result.Error)
	})
	t.Run("cpu-hard-cap", func(t *testing.T) {
		root := t.TempDir()
		job, err := NewJob("", JobLimits{MemoryBytes: 512 * 1024 * 1024, CPUPercent: 1, ActiveProcesses: 3})
		if err != nil {
			t.Fatal(err)
		}
		defer job.Close()
		var config jobCPUInfo
		var returned uint32
		ok, _, queryErr := windows.NewLazySystemDLL("kernel32.dll").NewProc("QueryInformationJobObject").Call(uintptr(job.handle), uintptr(windows.JobObjectCpuRateControlInformation), uintptr(unsafe.Pointer(&config)), unsafe.Sizeof(config), uintptr(unsafe.Pointer(&returned)))
		if ok == 0 || config.ControlFlags != 0x5 || config.CPURate != 100 {
			t.Fatalf("CPU hard-cap missing: %+v %v", config, queryErr)
		}
		process := start(t, job, root, "cpu")
		var ready bool
		waitIsolationJSON(t, filepath.Join(root, "cpu-ready.json"), &ready)
		handle := assertOwnerJob(t, job, process.PID)
		cpuTime := func() time.Duration {
			var creation, exit, kernel, user windows.Filetime
			if err := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
				t.Fatal(err)
			}
			ticks := func(value windows.Filetime) uint64 { return uint64(value.HighDateTime)<<32 | uint64(value.LowDateTime) }
			return time.Duration(ticks(kernel)+ticks(user)) * 100 * time.Nanosecond
		}
		before, started := cpuTime(), time.Now()
		time.Sleep(5 * time.Second)
		used, elapsed := cpuTime()-before, time.Since(started)
		// Windows' percentage is of all logical processors. Allow scheduling
		// bucket jitter, while still rejecting an unrestricted busy worker.
		budget := time.Duration(float64(elapsed)*float64(runtime.NumCPU())*0.01*1.5) + 200*time.Millisecond
		if used <= 0 || used > budget {
			t.Fatalf("CPU hard-cap did not throttle busy workers: used %s, wall %s, maximum %s", used, elapsed, budget)
		}
		t.Logf("1%% CPU hard cap: %s CPU over %s wall on %d logical processors (maximum %s)", used, elapsed, runtime.NumCPU(), budget)
	})
}

func deleteTestNetwork(identity string) error {
	var engine windows.Handle
	if err := appFWCall("FwpmEngineOpen0", 0, 10, 0, 0, uintptr(unsafe.Pointer(&engine))); err != nil {
		return err
	}
	defer appFWCall("FwpmEngineClose0", uintptr(engine))
	if err := removeAppFilters(engine, identity); err != nil {
		return err
	}
	var count uint32
	var items *windows.SIDAndAttributes
	result, _, _ := firewallAPI.NewProc("NetworkIsolationGetAppContainerConfig").Call(uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&items)))
	if result != 0 {
		return fmt.Errorf("get loopback: %d", result)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(items)))
	kept := []windows.SIDAndAttributes{}
	for _, item := range unsafe.Slice(items, count) {
		if item.Sid.String() != identity {
			kept = append(kept, item)
		}
	}
	var first uintptr
	if len(kept) > 0 {
		first = uintptr(unsafe.Pointer(&kept[0]))
	}
	result, _, _ = firewallAPI.NewProc("NetworkIsolationSetAppContainerConfig").Call(uintptr(len(kept)), first)
	if result != 0 {
		return fmt.Errorf("restore loopback: %d", result)
	}
	return nil
}
