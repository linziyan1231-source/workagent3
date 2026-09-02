package contracts

import (
	"strings"
	"testing"
)

func TestValidateModuleGraph(t *testing.T) {
	manifest := func(id string, dependencies ...ModuleDependency) ModuleManifest {
		return ModuleManifest{
			ID: id, Version: "1.0.0", Layer: "platform", Required: true,
			Capabilities: []string{id + ".read"}, Dependencies: dependencies,
			DataOwner: id, HealthCheck: "/health",
		}
	}
	valid := []ModuleManifest{manifest("owner"), manifest("consumer", ModuleDependency{ID: "owner", Contract: "OwnerPort/v1"})}
	if err := ValidateModuleGraph(valid); err != nil {
		t.Fatal(err)
	}
	missing := []ModuleManifest{manifest("consumer", ModuleDependency{ID: "missing", Contract: "OwnerPort/v1"})}
	if err := ValidateModuleGraph(missing); err == nil || !strings.Contains(err.Error(), "missing_module_dependency") {
		t.Fatalf("missing dependency = %v", err)
	}
	cycle := []ModuleManifest{
		manifest("first", ModuleDependency{ID: "second", Contract: "SecondPort/v1"}),
		manifest("second", ModuleDependency{ID: "first", Contract: "FirstPort/v1"}),
	}
	if err := ValidateModuleGraph(cycle); err == nil || !strings.Contains(err.Error(), "cyclic_module_dependency") {
		t.Fatalf("cycle = %v", err)
	}
}
