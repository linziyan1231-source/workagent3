//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

type JobLimits struct {
	MemoryBytes     uint64
	CPUPercent      uint32
	ActiveProcesses uint32
}

type Job struct {
	handle windows.Handle
	once   sync.Once
}

type jobCPUInfo struct {
	ControlFlags uint32
	CPURate      uint32
}

func NewJob(name string, limits JobLimits) (*Job, error) {
	if limits.MemoryBytes < 256*1024*1024 || limits.CPUPercent < 1 || limits.CPUPercent > 100 || limits.ActiveProcesses < 3 {
		return nil, errors.New("invalid Job Object limits")
	}
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateJobObject(nil, namePointer)
	if err != nil {
		return nil, fmt.Errorf("create Job Object: %w", err)
	}
	job := &Job{handle: handle}
	runtime.SetFinalizer(job, func(value *Job) { value.Close() })
	var extended windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	extended.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
		windows.JOB_OBJECT_LIMIT_JOB_MEMORY | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
	extended.BasicLimitInformation.ActiveProcessLimit = limits.ActiveProcesses
	extended.JobMemoryLimit = uintptr(limits.MemoryBytes)
	if _, err := windows.SetInformationJobObject(handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&extended)), uint32(unsafe.Sizeof(extended))); err != nil {
		job.Close()
		return nil, fmt.Errorf("set Job Object memory/process limits: %w", err)
	}
	cpu := jobCPUInfo{ControlFlags: 0x1 | 0x4, CPURate: limits.CPUPercent * 100}
	if _, err := windows.SetInformationJobObject(handle, windows.JobObjectCpuRateControlInformation, uintptr(unsafe.Pointer(&cpu)), uint32(unsafe.Sizeof(cpu))); err != nil {
		job.Close()
		return nil, fmt.Errorf("set Job Object CPU limit: %w", err)
	}
	return job, nil
}

func (j *Job) AssignPID(pid uint32) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return fmt.Errorf("open PID %d for Job Object assignment: %w", pid, err)
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(j.handle, process); err != nil {
		return fmt.Errorf("assign PID %d to Job Object: %w", pid, err)
	}
	return nil
}

func (j *Job) Close() error {
	var err error
	j.once.Do(func() {
		runtime.SetFinalizer(j, nil)
		err = windows.CloseHandle(j.handle)
	})
	return err
}
