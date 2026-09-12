package userhost

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"golang.org/x/mod/semver"
	"gopkg.in/yaml.v3"
)

type globalCapability struct {
	CompatibleEngines                                                []string
	Key, Kind, Name, Description, Directory, Version, Stamp, Problem string
	Enabled                                                          bool
	MCP                                                              importedMCP
}

// Discovery has no workspace argument: project installations never enter the
// employee catalog. Paths are supplied by the UserHost, not an HTTP request.
func discoverGlobalCapabilities(dataRoot string) ([]globalCapability, error) {
	home := filepath.Join(dataRoot, "native", "codex")
	var config struct {
		MCP     map[string]map[string]any `toml:"mcp_servers"`
		Plugins map[string]struct {
			Enabled bool `toml:"enabled"`
		} `toml:"plugins"`
	}
	contents, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(contents) > 0 && toml.Unmarshal(contents, &config) != nil {
		return nil, errors.New("codex_config_invalid")
	}
	result := []globalCapability{}
	for name, raw := range config.MCP {
		result = append(result, discoverGlobalMCP("codex/config:"+name, name, raw, "", fileStamp(filepath.Join(home, "config.toml"))))
	}
	result = append(result, discoverGlobalSkills(filepath.Join(home, "skills"), "codex/skills")...)
	// This is the employee's shared directory, not the interactive administrator's HOME.
	result = append(result, discoverGlobalSkills(filepath.Join(dataRoot, ".agents", "skills"), "agents/skills")...)
	for id, plugin := range config.Plugins {
		if !plugin.Enabled {
			continue
		}
		name, market, ok := strings.Cut(id, "@")
		if !ok || !safePluginSegment(name) || !safePluginSegment(market) {
			continue
		}
		root := activePluginRoot(filepath.Join(home, "plugins", "cache", market, name))
		if root == "" {
			result = append(result, globalCapability{Key: "plugin:" + id, Kind: "plugin", Name: id, Problem: "plugin_installation_missing"})
			continue
		}
		var manifest map[string]json.RawMessage
		data, err := os.ReadFile(filepath.Join(root, ".codex-plugin", "plugin.json"))
		if err != nil || json.Unmarshal(data, &manifest) != nil {
			result = append(result, globalCapability{Key: "plugin:" + id, Kind: "plugin", Name: id, Problem: "plugin_manifest_invalid"})
			continue
		}
		roots := []string{"skills"}
		if raw, ok := manifest["skills"]; ok {
			var single string
			if json.Unmarshal(raw, &single) == nil {
				roots = []string{single}
			} else if json.Unmarshal(raw, &roots) != nil {
				roots = nil
			}
		}
		_, hosted := manifest["apps"]
		if _, err := os.Stat(filepath.Join(root, ".app.json")); err == nil {
			hosted = true
		}
		for _, relative := range roots {
			path := filepath.Join(root, filepath.FromSlash(relative))
			if withinDirectory(root, path) {
				skills := discoverGlobalSkills(path, "plugin:"+id+"/"+relative)
				for index := range skills {
					if hosted {
						skills[index].CompatibleEngines = []string{"codex"}
					}
					if skills[index].Version == "local" {
						skills[index].Version = filepath.Base(root)
					}
				}
				result = append(result, skills...)
			}
		}
		mcpPaths := []string{".mcp.json"}
		var inline map[string]map[string]any
		if raw, ok := manifest["mcpServers"]; ok {
			var single string
			if json.Unmarshal(raw, &single) == nil {
				mcpPaths = []string{single}
			} else if json.Unmarshal(raw, &mcpPaths) != nil {
				mcpPaths = nil
				if json.Unmarshal(raw, &inline) != nil {
					result = append(result, globalCapability{Key: "plugin:" + id + "/mcp", Kind: "mcp", Name: id, Problem: "plugin_mcp_manifest_unsupported"})
				}
			}
		}
		appendServers := func(servers map[string]map[string]any, stamp string) {
			for key, raw := range servers {
				result = append(result, discoverGlobalMCP("plugin:"+id+"/mcp:"+key, key, raw, root, stamp))
			}
		}
		appendServers(inline, fileStamp(filepath.Join(root, ".codex-plugin", "plugin.json")))
		for _, relative := range mcpPaths {
			path := filepath.Join(root, filepath.FromSlash(relative))
			if !withinDirectory(root, path) {
				continue
			}
			data, err := os.ReadFile(path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			var envelope struct {
				Servers map[string]map[string]any `json:"mcpServers"`
			}
			if err != nil || json.Unmarshal(data, &envelope) != nil {
				result = append(result, globalCapability{Key: "plugin:" + id + "/mcp", Kind: "mcp", Name: id, Problem: "plugin_mcp_config_invalid"})
				continue
			}
			appendServers(envelope.Servers, fileStamp(path))
		}
		if _, ok := manifest["apps"]; ok {
			result = append(result, globalCapability{Key: "plugin:" + id + "/apps", Kind: "plugin", Name: id, Problem: "codex_hosted_connector_only"})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result, nil
}

func discoverGlobalSkills(root, origin string) []globalCapability {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	result := []globalCapability{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		directory := filepath.Join(root, entry.Name())
		data, err := os.ReadFile(filepath.Join(directory, "SKILL.md"))
		if err != nil {
			continue
		}
		normalized := strings.ReplaceAll(string(data), "\r\n", "\n")
		item := globalCapability{Key: origin + ":" + entry.Name(), Kind: "skill", Name: entry.Name(), Directory: directory, Version: "local", Enabled: true, Stamp: fileStamp(filepath.Join(directory, "SKILL.md"))}
		if strings.HasPrefix(normalized, "---\n") {
			header, _, ok := strings.Cut(normalized[4:], "\n---")
			var metadata struct {
				Name        string `yaml:"name"`
				Description string `yaml:"description"`
				Version     string `yaml:"version"`
			}
			if ok && yaml.Unmarshal([]byte(header), &metadata) == nil && metadata.Name != "" && metadata.Description != "" {
				item.Name = metadata.Name
				item.Description = metadata.Description
				if metadata.Version != "" {
					item.Version = metadata.Version
				}
			} else {
				item.Problem = "skill_frontmatter_invalid"
			}
		} else {
			item.Problem = "skill_frontmatter_invalid"
		}
		result = append(result, item)
	}
	return result
}

func discoverGlobalMCP(key, name string, raw map[string]any, pluginRoot, stamp string) globalCapability {
	item := globalCapability{Key: key, Kind: "mcp", Name: name, Enabled: true, Stamp: stamp}
	if value, ok := raw["enabled"].(bool); ok {
		item.Enabled = value
	}
	value := func(key string) string {
		text, _ := raw[key].(string)
		return strings.ReplaceAll(text, "${CLAUDE_PLUGIN_ROOT}", pluginRoot)
	}
	item.MCP = importedMCP{GlobalSource: key, NativeName: name, Command: value("command"), URL: value("url"), Type: value("type"), Env: map[string]string{}, Headers: map[string]string{}}
	encoded, _ := json.Marshal(raw["args"])
	_ = json.Unmarshal(encoded, &item.MCP.Args)
	for index, arg := range item.MCP.Args {
		item.MCP.Args[index] = strings.ReplaceAll(arg, "${CLAUDE_PLUGIN_ROOT}", pluginRoot)
	}
	for _, pair := range []struct {
		key    string
		target map[string]string
	}{{"env", item.MCP.Env}, {"headers", item.MCP.Headers}, {"http_headers", item.MCP.Headers}} {
		if table, ok := raw[pair.key].(map[string]any); ok {
			for key, value := range table {
				if text, ok := value.(string); ok {
					pair.target[key] = strings.ReplaceAll(text, "${CLAUDE_PLUGIN_ROOT}", pluginRoot)
				}
			}
		}
	}
	if names, ok := raw["env_vars"].([]any); ok {
		for _, name := range names {
			if key, ok := name.(string); ok {
				if value, found := os.LookupEnv(key); found {
					item.MCP.Env[key] = value
				} else {
					item.Problem = "environment_missing"
				}
			}
		}
	}
	if names, ok := raw["env_http_headers"].(map[string]any); ok {
		for name, value := range names {
			key, _ := value.(string)
			if secret, found := os.LookupEnv(key); found {
				item.MCP.Headers[name] = secret
			} else {
				item.Problem = "environment_missing"
			}
		}
	}
	if key := value("bearer_token_env_var"); key != "" {
		if secret, found := os.LookupEnv(key); found {
			item.MCP.Headers["Authorization"] = "Bearer " + secret
		} else {
			item.Problem = "authentication_missing"
		}
	}
	if item.MCP.Command != "" && !filepath.IsAbs(item.MCP.Command) {
		command, err := exec.LookPath(item.MCP.Command)
		if err != nil {
			item.Problem = "command_not_found"
		} else {
			item.MCP.Command = command
		}
	}
	for _, unsupported := range []string{"cwd", "enabled_tools", "disabled_tools", "scopes", "oauth_resource"} {
		if _, ok := raw[unsupported]; ok {
			item.Problem = "mcp_option_requires_review:" + unsupported
		}
	}
	return item
}

func fileStamp(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return info.ModTime().UTC().Format("2006-01-02T15:04:05.999999999Z")
}
func safePluginSegment(value string) bool {
	return value != "" && value != "." && value != ".." && !strings.ContainsAny(value, "/\\:")
}
func withinDirectory(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
func activePluginRoot(root string) string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	versions := []string{}
	for _, entry := range entries {
		if entry.IsDir() && safePluginSegment(entry.Name()) {
			if entry.Name() == "local" {
				return filepath.Join(root, "local")
			}
			versions = append(versions, entry.Name())
		}
	}
	sort.Slice(versions, func(i, j int) bool {
		left, right := "v"+versions[i], "v"+versions[j]
		if semver.IsValid(left) && semver.IsValid(right) {
			if comparison := semver.Compare(left, right); comparison != 0 {
				return comparison < 0
			}
		}
		return versions[i] < versions[j]
	})
	if len(versions) == 0 {
		return ""
	}
	return filepath.Join(root, versions[len(versions)-1])
}
