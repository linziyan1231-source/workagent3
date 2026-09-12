//go:build windows

package winutil

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func init() {
	if os.Getenv("WORKAGENT_GUID_INIT_PROBE") != "1" {
		return
	}
	// Run in a fresh process before TestMain or any test can load COM. The
	// published worker must reach dispatch without initializing ole32.dll.
	module, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("ole32.dll"))))
	if module != 0 {
		fmt.Fprintln(os.Stderr, "ole32.dll was loaded before worker dispatch")
		os.Exit(1)
	}
	os.Exit(0)
}

func TestAppNetworkInitializationDoesNotLoadCOM(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	probe := exec.Command(executable)
	probe.Env = append(os.Environ(), "WORKAGENT_GUID_INIT_PROBE=1")
	probe.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if output, err := probe.CombinedOutput(); err != nil {
		t.Fatalf("isolated worker initialization: %v; %s", err, output)
	}
}

func TestAppNetworkGUIDsRetainWindowsFilteringPlatformIdentities(t *testing.T) {
	conditions := []struct {
		guid windows.GUID
		want string
	}{
		{appSublayer, "{96b1407c-ab46-41e0-8374-9a3978d63ff2}"},
		{packageCondition, "{71bc78fa-f17c-4997-a602-6abb261f351c}"},
		{remoteAddressCondition, "{b235ae9a-1d64-49b8-a44c-5ff3d9095045}"},
		{localAddressCondition, "{d9ee00de-c1ef-4617-bfe3-ffd8f5a08957}"},
		{remotePortCondition, "{c35a604d-d22b-4e1a-91b4-68f674ee674b}"},
		{localPortCondition, "{0c1ba1af-5765-453f-af22-a8f791ac775b}"},
		{protocolCondition, "{3971ef2b-623e-4f9a-8cb1-6e79b806b9a7}"},
		{appNetworkLayers[0], "{c38d57d1-05a7-4c33-904f-7fbceee60e82}"},
		{appNetworkLayers[1], "{4a72393b-319f-44bc-84c3-ba54dcb3b6b4}"},
		{appNetworkLayers[2], "{e1cd9fe7-f4b5-4273-96c0-592e487b8650}"},
		{appNetworkLayers[3], "{a3b42c97-9f04-4672-b87e-cee9c483257f}"},
	}
	for _, test := range conditions {
		v := test.guid
		got := fmt.Sprintf("{%08x-%04x-%04x-%02x%02x-%x}", v.Data1, v.Data2, v.Data3, v.Data4[0], v.Data4[1], v.Data4[2:])
		if got != test.want {
			t.Fatalf("WFP identity changed: got %s, want %s", got, test.want)
		}
	}
}
