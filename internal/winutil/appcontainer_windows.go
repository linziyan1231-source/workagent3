//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var appUserenv = windows.NewLazySystemDLL("userenv.dll")
var createAppProfile = appUserenv.NewProc("CreateAppContainerProfile")
var deriveAppSID = appUserenv.NewProc("DeriveAppContainerSidFromAppContainerName")
var appFolder = appUserenv.NewProc("GetAppContainerFolderPath")
var appOle = windows.NewLazySystemDLL("ole32.dll").NewProc("CoTaskMemFree")

func DeleteAppContainer(appID, version string) error {
	name, err := AppContainerName(appID, version)
	if err != nil {
		return err
	}
	result, _, _ := appUserenv.NewProc("DeleteAppContainerProfile").Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(name))))
	if result != 0 {
		return fmt.Errorf("delete AppContainer profile: 0x%x", result)
	}
	return nil
}

func ProtectAppProfileRegistry(appID, version, ownerSID string) error {
	name, err := AppContainerName(appID, version)
	if err != nil {
		return err
	}
	identity, err := DerivedAppContainerSID(appID, version)
	if err != nil {
		return err
	}
	root := `Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Storage\` + strings.ToLower(name)
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KA;;;" + ownerSID + ")(A;CI;KR;;;" + identity + ")")
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	var protect func(string) error
	protect = func(path string) error {
		key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.READ)
		if err != nil {
			return err
		}
		names, err := key.ReadSubKeyNames(-1)
		key.Close()
		if err != nil {
			return err
		}
		if err = windows.SetNamedSecurityInfo(`CURRENT_USER\`+path, windows.SE_REGISTRY_KEY, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
			return err
		}
		for _, name := range names {
			if err = protect(path + `\` + name); err != nil {
				return err
			}
		}
		return nil
	}
	return protect(root)
}

func DerivedAppContainerSID(appID, version string) (string, error) {
	name, err := AppContainerName(appID, version)
	if err != nil {
		return "", err
	}
	var sid *windows.SID
	result, _, _ := deriveAppSID.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(name))), uintptr(unsafe.Pointer(&sid)))
	if result != 0 {
		return "", fmt.Errorf("derive AppContainer SID: 0x%x", result)
	}
	defer windows.FreeSid(sid)
	return sid.String(), nil
}

// PrepareAppContainer runs under the employee token. No network capabilities
// are granted. The separate privileged network broker installs the allowlist.
func PrepareAppContainer(appID, version string) (string, string, error) {
	name, err := AppContainerName(appID, version)
	if err != nil {
		return "", "", err
	}
	value := windows.StringToUTF16Ptr(name)
	var sid *windows.SID
	result, _, _ := createAppProfile.Call(uintptr(unsafe.Pointer(value)), uintptr(unsafe.Pointer(value)), uintptr(unsafe.Pointer(value)), 0, 0, uintptr(unsafe.Pointer(&sid)))
	if result == 0 {
		windows.FreeSid(sid)
	} else if uint32(result) != 0x800700b7 {
		return "", "", fmt.Errorf("create AppContainer profile: 0x%x", result)
	}
	identity, err := DerivedAppContainerSID(appID, version)
	if err != nil {
		return "", "", err
	}
	var folder *uint16
	result, _, _ = appFolder.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(identity))), uintptr(unsafe.Pointer(&folder)))
	if result != 0 {
		return "", "", fmt.Errorf("get AppContainer folder: 0x%x", result)
	}
	defer appOle.Call(uintptr(unsafe.Pointer(folder)))
	return identity, windows.UTF16PtrToString(folder), nil
}

// ProtectAppTree sets the package's second access-check grant. Employee-owned
// project directories have no such grant, even though the underlying token SID
// is the same employee. App data additionally receives a low-integrity label.
func ProtectAppTree(root, ownerSID, packageSID string, writable bool) error {
	if !filepath.IsAbs(root) {
		return errors.New("application tree must be absolute")
	}
	rights := "FRFX"
	label := ""
	if writable {
		rights = "0x1301bf"
		label = "S:(ML;OICI;NW;;;LW)"
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + ownerSID + ")(A;OICI;" + rights + ";;;" + packageSID + ")" + label)
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	var sacl *windows.ACL
	if writable {
		sacl, _, err = descriptor.SACL()
		if err != nil {
			return err
		}
	}
	return filepath.WalkDir(root, func(path string, item os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(path))
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("application tree contains a reparse point")
		}
		information := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION)
		if writable {
			information |= windows.LABEL_SECURITY_INFORMATION
		}
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, information, nil, nil, dacl, sacl)
	})
}

type appSecurityCapabilities struct {
	SID          *windows.SID
	Capabilities *windows.SIDAndAttributes
	Count        uint32
	Reserved     uint32
}

type AppProcess struct {
	process windows.Handle
	thread  windows.Handle
	job     windows.Handle
	PID     uint32
	once    sync.Once
	done    chan struct{}
	waitErr error
}

// StartAppProcess creates the process suspended and attaches it to both the
// employee aggregate Job and a kill-on-close child Job before any user code.
// An empty PackageSID is used only for the trusted snapshot worker.
func StartAppProcess(options AppProcessOptions) (*AppProcess, error) {
	if options.OwnerJob == nil || !filepath.IsAbs(options.Executable) || !filepath.IsAbs(options.Directory) {
		return nil, errors.New("application process requires owner Job and absolute paths")
	}
	childJob, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
	if _, err = windows.SetInformationJobObject(childJob, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(childJob)
		return nil, err
	}
	attributes, err := windows.NewProcThreadAttributeList(3)
	if err != nil {
		windows.CloseHandle(childJob)
		return nil, err
	}
	defer attributes.Delete()
	jobs := []windows.Handle{options.OwnerJob.handle, childJob}
	if err = attributes.Update(0x2000d, unsafe.Pointer(&jobs[0]), unsafe.Sizeof(jobs[0])*uintptr(len(jobs))); err != nil {
		windows.CloseHandle(childJob)
		return nil, err
	}
	var caps appSecurityCapabilities
	if options.PackageSID != "" {
		caps.SID, err = windows.StringToSid(options.PackageSID)
		if err != nil {
			windows.CloseHandle(childJob)
			return nil, err
		}
		if err = attributes.Update(0x20009, unsafe.Pointer(&caps), unsafe.Sizeof(caps)); err != nil {
			windows.CloseHandle(childJob)
			return nil, err
		}
	}
	var startup windows.StartupInfoEx
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.ProcThreadAttributeList = attributes.List()
	inherit := false
	if options.LogPath != "" {
		security := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
		logHandle, e := windows.CreateFile(windows.StringToUTF16Ptr(options.LogPath), windows.FILE_APPEND_DATA, windows.FILE_SHARE_READ, &security, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if e != nil {
			windows.CloseHandle(childJob)
			return nil, e
		}
		defer windows.CloseHandle(logHandle)
		inputHandle, e := windows.CreateFile(windows.StringToUTF16Ptr("NUL"), windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, &security, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if e != nil {
			windows.CloseHandle(childJob)
			return nil, e
		}
		defer windows.CloseHandle(inputHandle)
		inherited := []windows.Handle{logHandle, inputHandle}
		if e = attributes.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&inherited[0]), unsafe.Sizeof(inherited[0])*2); e != nil {
			windows.CloseHandle(childJob)
			return nil, e
		}
		startup.Flags |= windows.STARTF_USESTDHANDLES
		startup.StdInput = inputHandle
		startup.StdOutput = logHandle
		startup.StdErr = logHandle
		inherit = true
	}
	environment := append([]string{}, options.Environment...)
	sort.Slice(environment, func(i, j int) bool { return strings.ToUpper(environment[i]) < strings.ToUpper(environment[j]) })
	env := utf16.Encode([]rune(strings.Join(environment, "\x00") + "\x00\x00"))
	arguments := append([]string{options.Executable}, options.Arguments...)
	command, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(arguments))
	if err != nil {
		windows.CloseHandle(childJob)
		return nil, err
	}
	var info windows.ProcessInformation
	err = windows.CreateProcess(windows.StringToUTF16Ptr(options.Executable), command, nil, nil, inherit, windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW|windows.EXTENDED_STARTUPINFO_PRESENT, &env[0], windows.StringToUTF16Ptr(options.Directory), &startup.StartupInfo, &info)
	runtime.KeepAlive(caps)
	runtime.KeepAlive(jobs)
	if err != nil {
		windows.CloseHandle(childJob)
		return nil, fmt.Errorf("create isolated application: %w", err)
	}
	process := &AppProcess{process: info.Process, thread: info.Thread, job: childJob, PID: info.ProcessId, done: make(chan struct{})}
	go process.wait()
	if _, err = windows.ResumeThread(info.Thread); err != nil {
		process.Close()
		return nil, err
	}
	return process, nil
}
func (p *AppProcess) wait() {
	defer close(p.done)
	if _, err := windows.WaitForSingleObject(p.process, windows.INFINITE); err != nil {
		p.waitErr = err
		return
	}
	var code uint32
	if err := windows.GetExitCodeProcess(p.process, &code); err != nil {
		p.waitErr = err
		return
	}
	if code != 0 {
		p.waitErr = fmt.Errorf("application exited with code %d", code)
	}
}
func (p *AppProcess) Wait() error           { <-p.done; return p.waitErr }
func (p *AppProcess) Done() <-chan struct{} { return p.done }
func (p *AppProcess) Close() error {
	var err error
	p.once.Do(func() {
		err = windows.CloseHandle(p.job)
		<-p.done
		windows.CloseHandle(p.thread)
		windows.CloseHandle(p.process)
	})
	return err
}
