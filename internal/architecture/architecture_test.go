package architecture_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var tableOwner = map[string]string{
	"users": "store", "sessions": "store", "runtime_credentials": "store",
	"shared_projects": "collaboration", "shared_members": "collaboration", "shared_invites": "collaboration", "shared_ownership_transfers": "collaboration",
	"shared_conversations": "collaboration", "shared_conversation_visibility": "collaboration", "shared_messages": "collaboration",
	"quota_budgets": "quota", "quota_reservations": "quota",
	"skill_market_entries": "skillmarket",
	"notifications":        "notifications", "notification_receipts": "notifications",
	"audit_events":    "audit",
	"client_settings": "settings",
	"model_catalog":   "modelaccess", "model_authorizations": "modelaccess", "model_downstream_keys": "modelaccess", "model_downstream_key_models": "modelaccess",
	"credentials":       "credentialbroker",
	"connector_configs": "imgateway", "pairings": "imgateway", "conversation_mappings": "imgateway", "inbound_receipts": "imgateway",
	"releases": "operations", "active_components": "operations", "activation_journal": "operations",
	"skills": "skillruntime", "mcp_servers": "mcpruntime",
	"skill_migrations": "skillmigration", "mcp_migrations": "skillmigration",
}

var sqlTableReference = regexp.MustCompile(`(?i)\b(?:from|join|into|update|table|references)\s+(?:if\s+not\s+exists\s+)?[\x60\x22\x5b]?([a-z][a-z0-9_]*)`)

var externalLegacyReaders = map[string]map[string]bool{
	"skillmigration/inventory.go": {"skills": true, "mcp_servers": true},
}

func TestSQLTablesAreOnlyAccessedByTheirOwner(t *testing.T) {
	internalRoot := internalDirectory(t)
	var violations []string
	walkGoSources(t, internalRoot, func(path, packageName, content string) {
		relativePath := relative(internalRoot, path)
		for _, match := range sqlTableReference.FindAllStringSubmatch(content, -1) {
			table := strings.ToLower(match[1])
			owner, owned := tableOwner[table]
			if externalLegacyReaders[relativePath][table] {
				continue
			}
			if owned && packageName != owner {
				violations = append(violations, relativePath+" accesses "+table+" owned by internal/"+owner)
			}
		}
	})
	sort.Strings(violations)
	if len(violations) != 0 {
		t.Fatalf("cross-module SQL access:\n%s", strings.Join(violations, "\n"))
	}
}

func TestDataOwnersDoNotDependOnProcessOrchestration(t *testing.T) {
	internalRoot := internalDirectory(t)
	owners := map[string]bool{
		"audit": true, "collaboration": true, "credentialbroker": true, "imgateway": true,
		"modelaccess": true, "notifications": true, "operations": true, "quota": true,
		"settings": true, "skillmarket": true, "store": true,
	}
	forbidden := []string{
		"workagent3/internal/portal", "workagent3/internal/userhost", "workagent3/internal/employee",
	}
	var violations []string
	walkGoSources(t, internalRoot, func(path, packageName, content string) {
		if !owners[packageName] {
			return
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, content, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imported := range file.Imports {
			pathValue := strings.Trim(imported.Path.Value, `"`)
			for _, prefix := range forbidden {
				if pathValue == prefix || strings.HasPrefix(pathValue, prefix+"/") {
					violations = append(violations, relative(internalRoot, path)+" imports "+pathValue)
				}
			}
		}
	})
	sort.Strings(violations)
	if len(violations) != 0 {
		t.Fatalf("data-owner reverse dependencies:\n%s", strings.Join(violations, "\n"))
	}
}

func internalDirectory(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func walkGoSources(t *testing.T, root string, visit func(path, packageName, content string)) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		payload, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, payload, parser.PackageClauseOnly)
		if err != nil {
			return err
		}
		visit(path, file.Name.Name, string(payload))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func relative(root, path string) string {
	value, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(value)
}
