//go:build windows

package winutil

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func init() {
	if os.Getenv("WORKAGENT_TEST_BROKER_IDENTITY") != "1" {
		return
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		os.Exit(2)
	}
	fmt.Println(listener.Addr().(*net.TCPAddr).Port)
	_, _ = os.Stdin.Read(make([]byte, 1))
	listener.Close()
	os.Exit(0)
}

func TestPublishedAppBrokerMatchesLiveListenerIdentityAndRejectsSpoofedClaims(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(t.TempDir(), "application with spaces", "run", "broker.json")
	command := exec.Command(executable, "--published-app-broker", config)
	command.Env = append(os.Environ(), "WORKAGENT_TEST_BROKER_IDENTITY=1")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { input.Close(); _ = command.Wait() }()
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatal(err)
	}
	if err = VerifyPublishedAppBroker(port, sid, executable, config); err != nil {
		t.Fatal("trusted worker rejected", err)
	}
	if err = VerifyAppListener(port, sid, "S-1-15-2-1", uint32(command.Process.Pid)); err == nil {
		t.Fatal("ordinary broker token accepted as isolated backend")
	}
	if err = VerifyAppListener(port, sid, "S-1-15-2-1", uint32(os.Getpid())); err == nil {
		t.Fatal("another listener process accepted as backend")
	}
	for _, claim := range []struct{ sid, image, config string }{
		{"S-1-5-21-999999-999999-999999-9999", executable, config},
		{sid, filepath.Join(t.TempDir(), "different-release", "userhost.exe"), config},
		{sid, executable, filepath.Join(t.TempDir(), "other-app", "broker.json")},
	} {
		if err = VerifyPublishedAppBroker(port, claim.sid, claim.image, claim.config); err == nil {
			t.Fatal("spoofed broker claim accepted")
		}
	}
	listener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err = VerifyPublishedAppBroker(listener.Addr().(*net.TCPAddr).Port, sid, executable, config); err == nil {
		t.Fatal("nonloopback listener accepted")
	}
}
