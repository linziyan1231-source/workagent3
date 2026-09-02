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
	"shared_projects": "collaboration", "shared_members": "collaboration", "shared_invites": "collaboration", "shared_invite_links": "collaboration", "shared_ownership_transfers": "collaboration",
	"shared_conversations": "collaboration", "shared_conversation_visibility": "collaboration", "shared_conversation_user_state": "collaboration", "shared_messages": "collaboration",
	"shared_ai_runs": "collaboration", "shared_ai_run_payers": "collaboration",
	"quota_budgets": "quota", "quota_reservations": "quota",
	"quota_gateway_keys": "quota", "quota_gateway_usage": "quota",
	"skill_market_entries": "skillmarket",
	"notifications":        "notifications", "notification_receipts": "notifications",
	"audit_events":    "audit",
	"client_settings": "settings",
	"model_catalog":   "modelaccess", "model_authorizations": "modelaccess", "model_downstream_keys": "modelaccess", "model_downstream_key_models": "modelaccess",
	"credentials":       "credentialbroker",
	"connector_configs": "imgateway", "pairings": "imgateway", "conversation_mappings": "imgateway", "inbound_receipts": "imgateway",
	"releases": "operations", "active_components": "operations", "activation_journal": "operations", "release_readiness": "operations",
	"skills": "skillruntime", "mcp_servers": "mcpruntime",
	"skill_migrations": "skillmigration", "mcp_migrations": "skillmigration",
	"preset_migrations": "skillmigration",
}

var sqlTableReference = regexp.MustCompile(`(?i)\b(?:from|join|into|update|table|references)\s+(?:if\s+not\s+exists\s+)?[\x60\x22\x5b]?([a-z][a-z0-9_]*)`)
var sqlTableDefinition = regexp.MustCompile(`(?i)\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?[\x60\x22\x5b]?([a-z][a-z0-9_]*)`)

var externalLegacyReaders = map[string]map[string]bool{
	"internal/skillmigration/inventory.go": {"skills": true, "mcp_servers": true},
}

// productionSourceRoots are the Go trees scanned for cross-module SQL access:
// internal/ holds the owner modules and cmd/ holds the process entrypoints.
// cmd/ packages are all named main, so violations are reported by file path.
var productionSourceRoots = []string{"internal", "cmd"}

func TestSQLTablesAreOnlyAccessedByTheirOwner(t *testing.T) {
	repoRoot := repositoryRoot(t)
	var violations []string
	for _, rootName := range productionSourceRoots {
		root := filepath.Join(repoRoot, rootName)
		walkGoSources(t, root, func(path, packageName, content string) {
			reportPath := rootName + "/" + relative(root, path)
			for _, match := range sqlTableReference.FindAllStringSubmatch(content, -1) {
				table := strings.ToLower(match[1])
				owner, owned := tableOwner[table]
				if externalLegacyReaders[reportPath][table] {
					continue
				}
				if owned && packageName != owner {
					violations = append(violations, reportPath+" accesses "+table+" owned by internal/"+owner)
				}
			}
		})
	}
	sort.Strings(violations)
	if len(violations) != 0 {
		t.Fatalf("cross-module SQL access:\n%s", strings.Join(violations, "\n"))
	}
}

func TestEveryProductionTableHasOneDeclaredOwner(t *testing.T) {
	repoRoot := repositoryRoot(t)
	defined := make(map[string]bool)
	var violations []string
	for _, rootName := range productionSourceRoots {
		root := filepath.Join(repoRoot, rootName)
		walkGoSources(t, root, func(path, packageName, content string) {
			for _, match := range sqlTableDefinition.FindAllStringSubmatch(content, -1) {
				table := strings.ToLower(match[1])
				defined[table] = true
				owner, declared := tableOwner[table]
				if !declared {
					violations = append(violations, rootName+"/"+relative(root, path)+" defines undeclared table "+table)
					continue
				}
				if packageName != owner {
					violations = append(violations, rootName+"/"+relative(root, path)+" defines "+table+" owned by internal/"+owner)
				}
			}
		})
	}
	for table, owner := range tableOwner {
		if !defined[table] {
			violations = append(violations, "declared owner internal/"+owner+" has no production definition for "+table)
		}
	}
	sort.Strings(violations)
	if len(violations) != 0 {
		t.Fatalf("data-owner declarations:\n%s", strings.Join(violations, "\n"))
	}
}

func TestDataOwnersDoNotDependOnProcessOrchestration(t *testing.T) {
	internalRoot := internalDirectory(t)
	owners := map[string]bool{
		"audit": true, "collaboration": true, "credentialbroker": true, "imgateway": true,
		"modelaccess": true, "notifications": true, "operations": true, "quota": true,
		"settings": true, "skillmarket": true, "store": true, "skillruntime": true,
		"mcpruntime": true, "skillmigration": true,
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

// forbiddenModuleImports pins the dependency directions from plan 5.4 that
// actually exist in the code today: employeemanager → employee → userhost,
// and none of them import portal (the composition root, which may import
// everything and is therefore not listed). Only reverse directions are
// forbidden; no rules are invented for pairs with no established direction.
var forbiddenModuleImports = map[string][]string{
	"userhost": {
		"workagent3/internal/employee",
		"workagent3/internal/employeemanager",
		"workagent3/internal/portal",
	},
	"employee": {
		"workagent3/internal/employeemanager",
		"workagent3/internal/portal",
	},
	"employeemanager": {
		"workagent3/internal/portal",
	},
}

func TestModuleDependencyDirection(t *testing.T) {
	internalRoot := internalDirectory(t)
	var violations []string
	walkGoSources(t, internalRoot, func(path, packageName, content string) {
		forbidden, guarded := forbiddenModuleImports[packageName]
		if !guarded {
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
		t.Fatalf("module dependency direction violations:\n%s", strings.Join(violations, "\n"))
	}
}

// firstReleaseCoverage maps every row of the plan 5.5 first-release matrix to
// the module manifest ids that must cover it. Platform ids are declared in
// internal/portal/capabilities.go (platformModuleManifests); runtime ids are
// declared in harness-bundle/src/module-manifests.ts (RUNTIME_MODULES served
// at userhost /v1/capabilities).
//
// Deferred rows are pinned explicitly, not skipped silently:
//   - ChatForward (real service), Speech and external IM connectors are
//     deferred per plan; their manifest entries already exist and are
//     asserted here.
//   - The usage-telemetry Harness plugin is deferred; gateway usage telemetry
//     is delivered by the platform quota module as the quota.gateway-usage
//     capability instead.
var firstReleaseCoverage = []struct {
	feature  string
	platform []string
	runtime  []string
}{
	{"浏览器密码登录、改密、Session", []string{"portal-auth"}, nil},
	{"管理员与员工完整生命周期", []string{"employee-management"}, nil},
	{"Windows SID/Profile/ACL/计划任务", []string{"employee-management"}, nil},
	{"每 SID UserHost、进程树、健康和资源限制", []string{"runtime-router"}, nil},
	{"个人项目和 Workspace", nil, []string{"workspace-runtime"}},
	{"会话 CRUD、搜索、分支/克隆、流式、取消、恢复", nil, []string{"personal-work"}},
	{"助手、Preset、头像、导入和能力绑定", nil, []string{"preset-runtime"}},
	{"确认、工具审批和用户补充输入", nil, []string{"approval-bridge"}},
	{"文件浏览、上传、下载、附件和产物", nil, []string{"workspace-runtime"}},
	{"定时任务、立即运行、暂停恢复和历史", nil, []string{"automation"}},
	{"模型目录、权限、价格和受限下游 Key", []string{"model-access"}, nil},
	{"Codex/Kimi 原生认证和 Session", nil, []string{"engine-registry"}},
	{"普通工作模式", nil, []string{"personal-work"}},
	{"人人协作、共享目录、邀请和实时消息", []string{"collaboration"}, []string{"shared-turn"}},
	{"AI 团队、成员、任务板和邮箱", nil, []string{"ai-team"}},
	{"额度、计费和资源限额", []string{"quota"}, nil},
	{"Skill Market 发布、审核和下载", []string{"skill-market"}, nil},
	{"SID Skill 安装、绑定和现有 Skill 迁移", nil, []string{"skill-runtime"}},
	{"MCP、OAuth、工具授权和现有 MCP 迁移", nil, []string{"mcp-runtime"}},
	{"ChatForward", []string{"chatforward"}, nil},
	{"外部 IM、配对、授权、会话和发送", []string{"im-gateway"}, []string{"im-inbox"}},
	{"语音输入与流式转写", []string{"speech"}, nil},
	{"能力目录、权限和风险展示", []string{"capability-read-model"}, []string{"engine-registry"}},
	{"外观、语言、默认项和帮助", []string{"settings"}, nil},
	{"版本、组件健康和 Runtime 修复", []string{"release"}, nil},
	{"站内通知、任务完成和升级通知", []string{"notifications"}, nil},
	{"安全和管理审计", []string{"audit"}, nil},
	{"日志、指标、健康和脱敏诊断", []string{"observability"}, nil},
	{"备份、恢复和数据迁移", []string{"operations"}, nil},
	{"组件发布、升级和回滚", []string{"release"}, nil},
}

var platformManifestID = regexp.MustCompile(`manifest\("([a-z0-9-]+)"`)
var runtimeManifestID = regexp.MustCompile(`\bid:\s*"([a-z0-9-]+)"`)

func TestFirstReleaseMatrixHasManifestCoverage(t *testing.T) {
	repoRoot := repositoryRoot(t)
	platformSource, err := os.ReadFile(filepath.Join(repoRoot, "internal", "portal", "capabilities.go"))
	if err != nil {
		t.Fatal(err)
	}
	runtimeSource, err := os.ReadFile(filepath.Join(repoRoot, "harness-bundle", "src", "module-manifests.ts"))
	if err != nil {
		t.Fatal(err)
	}
	declared := func(pattern *regexp.Regexp, source []byte) map[string]bool {
		ids := make(map[string]bool)
		for _, match := range pattern.FindAllSubmatch(source, -1) {
			ids[string(match[1])] = true
		}
		return ids
	}
	platform := declared(platformManifestID, platformSource)
	runtime := declared(runtimeManifestID, runtimeSource)
	var missing []string
	for _, row := range firstReleaseCoverage {
		for _, id := range row.platform {
			if !platform[id] {
				missing = append(missing, row.feature+" → platform manifest "+id)
			}
		}
		for _, id := range row.runtime {
			if !runtime[id] {
				missing = append(missing, row.feature+" → runtime manifest "+id)
			}
		}
	}
	sort.Strings(missing)
	if len(missing) != 0 {
		t.Fatalf("plan 5.5 matrix rows without manifest coverage:\n%s", strings.Join(missing, "\n"))
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

func repositoryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
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
