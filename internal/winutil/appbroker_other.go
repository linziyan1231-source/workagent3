//go:build !windows

package winutil

func VerifyPublishedAppBroker(int, string, string, string) error { return errAppWindows }
func VerifyAppListener(int, string, string, uint32) error        { return errAppWindows }
