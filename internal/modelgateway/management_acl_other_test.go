//go:build !windows

package modelgateway

import "testing"

// restrictTestKeyFileACL is a no-op off Windows: the management key ACL gate
// only applies to Windows deployments.
func restrictTestKeyFileACL(t *testing.T, _ string) { t.Helper() }
