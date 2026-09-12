//go:build windows

package winutil

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var getPublishedBrokerTCPTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

// VerifyAppListener ties backend readiness to the exact AppContainer process
// started by UserHost, so a competing listener cannot satisfy its HTTP probe.
func VerifyAppListener(port int, ownerSID, packageSID string, parentPID uint32) error {
	pid, err := publishedBrokerListenerPID(port)
	if err != nil {
		return err
	}
	if parentPID == 0 || pid != parentPID {
		return errors.New("published application backend process mismatch")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err = windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	if !strings.EqualFold(user.User.Sid.String(), ownerSID) {
		return errors.New("published application backend owner mismatch")
	}
	var length uint32
	const tokenAppContainerSID = 31
	_ = windows.GetTokenInformation(token, tokenAppContainerSID, nil, 0, &length)
	if length < uint32(unsafe.Sizeof(uintptr(0))) {
		return errors.New("published application backend is not isolated")
	}
	buffer := make([]byte, length)
	if err = windows.GetTokenInformation(token, tokenAppContainerSID, &buffer[0], length, &length); err != nil {
		return err
	}
	identity := *(**windows.SID)(unsafe.Pointer(&buffer[0]))
	if identity == nil || !strings.EqualFold(identity.String(), packageSID) {
		return errors.New("published application backend package mismatch")
	}
	runtime.KeepAlive(buffer)
	return nil
}

// VerifyPublishedAppBroker accepts only a loopback listener owned by the
// expected employee and the immutable UserHost executable in broker mode.
// All expected paths must come from privileged deployment/runtime configuration.
// Neither worker command lines nor broker configuration contents are logged.
func VerifyPublishedAppBroker(port int, ownerSID, expectedExecutable, expectedConfigPath string) error {
	if port < 1024 || port > 65535 || ownerSID == "" || !filepath.IsAbs(expectedExecutable) || !filepath.IsAbs(expectedConfigPath) {
		return errors.New("invalid published application broker identity")
	}
	pid, err := publishedBrokerListenerPID(port)
	if err != nil {
		return err
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return fmt.Errorf("open published application broker: %w", err)
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err = windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	if !strings.EqualFold(user.User.Sid.String(), ownerSID) {
		return errors.New("published application broker owner mismatch")
	}
	image := make([]uint16, 32768)
	length := uint32(len(image))
	if err = windows.QueryFullProcessImageName(process, 0, &image[0], &length); err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(image[:length])), filepath.Clean(expectedExecutable)) {
		return errors.New("published application broker executable mismatch")
	}
	command, err := publishedBrokerCommandLine(process)
	if err != nil {
		return err
	}
	args, err := windows.DecomposeCommandLine(command)
	if err != nil || len(args) != 3 || args[1] != "--published-app-broker" || !strings.EqualFold(filepath.Clean(args[0]), filepath.Clean(expectedExecutable)) || !strings.EqualFold(filepath.Clean(args[2]), filepath.Clean(expectedConfigPath)) {
		return errors.New("published application broker command mismatch")
	}
	// Re-read after process inspection: a stale listener/PID must never authorize
	// a replacement service that acquired the port while we inspected it.
	current, err := publishedBrokerListenerPID(port)
	if err != nil {
		return err
	}
	if current != pid {
		return errors.New("published application broker changed")
	}
	return nil
}

func publishedBrokerListenerPID(port int) (uint32, error) {
	// AF_INET and TCP_TABLE_OWNER_PID_LISTENER return MIB_TCPTABLE_OWNER_PID.
	var size uint32
	for attempts := 0; attempts < 3; attempts++ {
		var table []byte
		var pointer unsafe.Pointer
		if size > 0 {
			table = make([]byte, size)
			pointer = unsafe.Pointer(&table[0])
		}
		result, _, _ := getPublishedBrokerTCPTable.Call(uintptr(pointer), uintptr(unsafe.Pointer(&size)), 0, windows.AF_INET, 3, 0)
		if syscall.Errno(result) == windows.ERROR_INSUFFICIENT_BUFFER {
			continue
		}
		if result != 0 {
			return 0, fmt.Errorf("read published application broker listener: %w", syscall.Errno(result))
		}
		if len(table) < 4 {
			return 0, errors.New("invalid TCP listener table")
		}
		count := int(binary.LittleEndian.Uint32(table[:4]))
		if count > (len(table)-4)/24 {
			return 0, errors.New("invalid TCP listener table")
		}
		var found uint32
		for index := 0; index < count; index++ {
			row := table[4+index*24 : 4+(index+1)*24]
			if int(binary.BigEndian.Uint16(row[8:10])) != port {
				continue
			}
			if binary.LittleEndian.Uint32(row[:4]) != 2 || row[4] != 127 || row[5] != 0 || row[6] != 0 || row[7] != 1 || found != 0 {
				return 0, errors.New("published application broker must have one loopback listener")
			}
			found = binary.LittleEndian.Uint32(row[20:24])
		}
		if found == 0 {
			return 0, errors.New("published application broker is not listening")
		}
		return found, nil
	}
	return 0, errors.New("published application listener table changed")
}

func publishedBrokerCommandLine(process windows.Handle) (string, error) {
	var size uint32
	_ = windows.NtQueryInformationProcess(process, windows.ProcessCommandLineInformation, nil, 0, &size)
	if size < uint32(unsafe.Sizeof(windows.NTUnicodeString{})) || size > 1024*1024 {
		return "", errors.New("published application broker command unavailable")
	}
	buffer := make([]byte, size)
	if err := windows.NtQueryInformationProcess(process, windows.ProcessCommandLineInformation, unsafe.Pointer(&buffer[0]), size, &size); err != nil {
		return "", err
	}
	value := (*windows.NTUnicodeString)(unsafe.Pointer(&buffer[0]))
	start, text := uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(value.Buffer))
	if text < start || text > start+uintptr(len(buffer)) || uintptr(value.Length) > start+uintptr(len(buffer))-text || value.Length%2 != 0 {
		return "", errors.New("invalid published application broker command")
	}
	result := windows.UTF16ToString(unsafe.Slice(value.Buffer, value.Length/2))
	runtime.KeepAlive(buffer)
	return result, nil
}
