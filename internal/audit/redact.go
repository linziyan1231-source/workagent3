package audit

import (
	"regexp"
	"strings"

	"workagent3/internal/contracts"
)

// sensitiveMetadataFragments mark metadata keys whose values are masked on
// export regardless of content. Producers already avoid writing credentials;
// this is the export-boundary safety net.
var sensitiveMetadataFragments = []string{"secret", "token", "password", "credential", "apikey", "api_key"}

// plainKeyValuePattern matches CLIProxyAPI plain key material should it ever
// appear in a metadata value by mistake.
var plainKeyValuePattern = regexp.MustCompile(`cpa_[A-Za-z0-9_-]{8,}`)

const redactedValue = "[redacted]"

// RedactEvents returns copies of the events with sensitive-looking metadata
// values masked. Both the Portal admin endpoints and the audit-export CLI
// pass their output through it, so the exported format never carries
// credential material even if a producer regresses.
func RedactEvents(events []contracts.AuditEvent) []contracts.AuditEvent {
	redacted := make([]contracts.AuditEvent, len(events))
	for index, event := range events {
		if len(event.Metadata) > 0 {
			metadata := make(map[string]string, len(event.Metadata))
			for key, value := range event.Metadata {
				metadata[key] = redactMetadataValue(key, value)
			}
			event.Metadata = metadata
		}
		redacted[index] = event
	}
	return redacted
}

func redactMetadataValue(key, value string) string {
	lowered := strings.ToLower(key)
	for _, fragment := range sensitiveMetadataFragments {
		if strings.Contains(lowered, fragment) {
			return redactedValue
		}
	}
	return plainKeyValuePattern.ReplaceAllString(value, redactedValue)
}
