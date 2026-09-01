package contracts

import (
	"fmt"
	"regexp"
	"strings"
)

var moduleIDPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
var semanticVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

type ModuleDependency struct {
	ID       string `json:"id"`
	Contract string `json:"contract"`
}

type ModuleManifest struct {
	ID           string             `json:"id"`
	Version      string             `json:"version"`
	Layer        string             `json:"layer"`
	Required     bool               `json:"required"`
	Capabilities []string           `json:"capabilities"`
	Dependencies []ModuleDependency `json:"dependencies"`
	ConfigSchema string             `json:"configSchema"`
	DataOwner    string             `json:"dataOwner"`
	HealthCheck  string             `json:"healthCheck"`
}

type ModuleReadModelEntry struct {
	Manifest ModuleManifest `json:"manifest"`
	Status   string         `json:"status"`
}

type CapabilityReadModel struct {
	SchemaVersion   int                           `json:"schemaVersion"`
	PlatformModules []ModuleReadModelEntry        `json:"platformModules"`
	RuntimeModules  []ModuleManifest              `json:"runtimeModules"`
	RuntimeStatus   string                        `json:"runtimeStatus"`
	Engines         map[string]EngineCapabilities `json:"engines"`
}

type EngineCapabilities struct {
	Approval   bool `json:"approval"`
	Resume     bool `json:"resume"`
	Steer      bool `json:"steer"`
	ToolEvents bool `json:"toolEvents"`
	Usage      bool `json:"usage"`
}

func ValidateModuleGraph(manifests []ModuleManifest) error {
	modules := make(map[string]ModuleManifest, len(manifests))
	for _, manifest := range manifests {
		if !moduleIDPattern.MatchString(manifest.ID) || !semanticVersionPattern.MatchString(manifest.Version) || !validModuleLayer(manifest.Layer) || len(manifest.Capabilities) == 0 || strings.TrimSpace(manifest.ConfigSchema) == "" || strings.TrimSpace(manifest.DataOwner) == "" || strings.TrimSpace(manifest.HealthCheck) == "" {
			return fmt.Errorf("invalid_module_manifest:%s", manifest.ID)
		}
		for _, capability := range manifest.Capabilities {
			if strings.TrimSpace(capability) == "" {
				return fmt.Errorf("invalid_module_manifest:%s", manifest.ID)
			}
		}
		if _, exists := modules[manifest.ID]; exists {
			return fmt.Errorf("duplicate_module_id:%s", manifest.ID)
		}
		modules[manifest.ID] = manifest
	}
	for _, manifest := range manifests {
		for _, dependency := range manifest.Dependencies {
			if !moduleIDPattern.MatchString(dependency.ID) || strings.TrimSpace(dependency.Contract) == "" {
				return fmt.Errorf("invalid_module_dependency:%s:%s", manifest.ID, dependency.ID)
			}
			if _, exists := modules[dependency.ID]; !exists {
				return fmt.Errorf("missing_module_dependency:%s:%s", manifest.ID, dependency.ID)
			}
		}
	}
	visiting := make(map[string]bool, len(manifests))
	visited := make(map[string]bool, len(manifests))
	var visit func(string) error
	visit = func(id string) error {
		if visiting[id] {
			return fmt.Errorf("cyclic_module_dependency:%s", id)
		}
		if visited[id] {
			return nil
		}
		visiting[id] = true
		for _, dependency := range modules[id].Dependencies {
			if err := visit(dependency.ID); err != nil {
				return err
			}
		}
		delete(visiting, id)
		visited[id] = true
		return nil
	}
	for id := range modules {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

func validModuleLayer(layer string) bool {
	switch layer {
	case "web", "platform", "runtime", "adapter":
		return true
	default:
		return false
	}
}
