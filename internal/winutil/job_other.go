//go:build !windows

package winutil

import "errors"

type JobLimits struct {
	MemoryBytes     uint64
	CPUPercent      uint32
	ActiveProcesses uint32
}

type Job struct{}

func ValidateJobLimits(limits JobLimits) error {
	if limits.MemoryBytes < 256*1024*1024 || limits.CPUPercent < 1 || limits.CPUPercent > 100 || limits.ActiveProcesses < 3 {
		return errors.New("invalid Job Object limits")
	}
	return nil
}

func NewJob(_ string, _ JobLimits) (*Job, error) {
	return nil, errors.New("Windows Job Objects are only available on Windows")
}

func (j *Job) AssignPID(_ uint32) error {
	return errors.New("Windows Job Objects are only available on Windows")
}
func (j *Job) Close() error { return nil }
