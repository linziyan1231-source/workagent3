package modelgateway

import "testing"

func TestKeyPrefixMatchesManagedSIDConvention(t *testing.T) {
	if actual := keyPrefix("S-1-5-21-100-200-300-1017"); actual != "aionui-c6caa7a66c7a1ad24ed9" {
		t.Fatalf("key prefix = %q", actual)
	}
}
