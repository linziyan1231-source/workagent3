package modelgateway

import (
	"fmt"
	"strings"
)

// managementKeyACLCheck enforces the deployment policy for the CLIProxyAPI
// management key file: only the Employee Manager service account, SYSTEM, and
// the local Administrators group may hold any access. principals lists the
// SIDs named by the file's allow ACEs; allowed is the permitted set. The
// comparison is case-insensitive because SID strings round-trip in either
// case.
func managementKeyACLCheck(principals, allowed []string) error {
	permitted := make(map[string]struct{}, len(allowed))
	for _, sid := range allowed {
		permitted[strings.ToUpper(sid)] = struct{}{}
	}
	for _, principal := range principals {
		if _, ok := permitted[strings.ToUpper(principal)]; !ok {
			return fmt.Errorf("CLIProxyAPI management key file grants access to an unauthorized principal: %s", principal)
		}
	}
	return nil
}
