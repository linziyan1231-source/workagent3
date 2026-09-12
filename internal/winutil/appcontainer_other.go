//go:build !windows

package winutil

import "errors"

var errAppWindows = errors.New("published backend isolation requires Windows")

func DisableAppNetwork(AppNetworkRule) error  { return errAppWindows }
func DeleteAppContainer(string, string) error { return errAppWindows }

func ProtectAppProfileRegistry(string, string, string) error { return errAppWindows }

type AppProcess struct{ PID uint32 }

func (p *AppProcess) Done() <-chan struct{} { done := make(chan struct{}); close(done); return done }

func DerivedAppContainerSID(string, string) (string, error)      { return "", errAppWindows }
func PrepareAppContainer(string, string) (string, string, error) { return "", "", errAppWindows }
func ProtectAppTree(string, string, string, bool) error          { return errAppWindows }
func StartAppProcess(AppProcessOptions) (*AppProcess, error)     { return nil, errAppWindows }
func (*AppProcess) Wait() error                                  { return errAppWindows }
func (*AppProcess) Close() error                                 { return nil }
func EnableAppNetwork(AppNetworkRule) (string, error)            { return "", errAppWindows }
