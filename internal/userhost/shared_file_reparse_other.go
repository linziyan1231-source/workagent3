//go:build !windows

package userhost

func sharedPathIsReparse(string) bool { return false }
