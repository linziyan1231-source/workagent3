//go:build !windows

package modelgateway

// The management key file ACL policy applies to Windows deployments only;
// other platforms are development targets where the check cannot run.
func verifyManagementKeyFileACL(string) error { return nil }
