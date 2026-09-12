package main

import (
	"path/filepath"
	"testing"
)

func TestProfessionalDatabaseConfigurationRequiresTrustedEndpointAndPrivatePaths(t *testing.T) {
	if err := validateProfessionalDatabaseConfig(nil); err != nil {
		t.Fatal(err)
	}
	cfg := professionalDatabaseConfig{Endpoint: "http://127.0.0.1:18301/professional-database/mcp", DatabasePath: filepath.Join(t.TempDir(), "quota.db"), CredentialPath: filepath.Join(t.TempDir(), "credential.json")}
	if err := validateProfessionalDatabaseConfig(&cfg); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"", "http://127.0.0.1:18301/v1/users", "http://example.com:18301/professional-database/mcp"} {
		bad := cfg
		bad.Endpoint = endpoint
		if validateProfessionalDatabaseConfig(&bad) == nil {
			t.Errorf("unsafe service endpoint accepted: %s", endpoint)
		}
	}
	bad := cfg
	bad.CredentialPath = "credential.json"
	if validateProfessionalDatabaseConfig(&bad) == nil {
		t.Fatal("relative credential path accepted")
	}
}
