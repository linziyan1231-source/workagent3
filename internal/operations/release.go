package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"workagent3/internal/contracts"
)

const (
	ManifestName           = "workagent-release.json"
	MinimumNotificationAge = 60 * time.Second
)

type Component string

const (
	ComponentWeb             Component = "web"
	ComponentPortal          Component = "portal"
	ComponentEmployeeManager Component = "employee-manager"
	ComponentUserHost        Component = "userhost"
	ComponentHarnessProfile  Component = "harness-profile"
	ComponentHarnessPlugin   Component = "harness-plugin"
	ComponentChatForward     Component = "chatforward"
	ComponentIMConnector     Component = "im-connector"
)

var allowedComponents = map[Component]struct{}{
	ComponentWeb: {}, ComponentPortal: {}, ComponentEmployeeManager: {}, ComponentUserHost: {},
	ComponentHarnessProfile: {}, ComponentHarnessPlugin: {}, ComponentChatForward: {}, ComponentIMConnector: {},
}

type Artifact struct {
	Component Component `json:"component"`
	File      string    `json:"file"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
}

type ReleaseManifest struct {
	FormatVersion      int         `json:"format_version"`
	Version            string      `json:"version"`
	IncludedComponents []Component `json:"included_components"`
	Artifacts          []Artifact  `json:"artifacts"`
}

type Probe struct {
	OK       bool   `json:"ok"`
	Evidence string `json:"evidence"`
}

type Readiness struct {
	CheckedAt       time.Time `json:"checked_at"`
	Harness         Probe     `json:"harness"`
	Codex           Probe     `json:"codex"`
	Kimi            Probe     `json:"kimi"`
	ManagedProvider Probe     `json:"managed_provider"`
}

type UpgradeNotice struct {
	InterruptionClass string
	Message           string
}

type NotificationPublisher interface {
	Publish(context.Context, contracts.NotificationInput) (contracts.Notification, error)
}

func NoticeFor(components []Component) (UpgradeNotice, error) {
	if err := validateComponents(components); err != nil {
		return UpgradeNotice{}, err
	}
	for _, component := range components {
		if component == ComponentUserHost || component == ComponentHarnessProfile || component == ComponentHarnessPlugin {
			return UpgradeNotice{
				InterruptionClass: "runtime",
				Message:           "系统正在升级，正在进行的任务可能会中断。",
			}, nil
		}
	}
	return UpgradeNotice{
		InterruptionClass: "management",
		Message:           "系统正在升级，页面可能需要刷新，但正在进行的任务不会中断。",
	}, nil
}

func (m ReleaseManifest) Validate() error {
	if m.FormatVersion != 1 || !validVersion(m.Version) {
		return errors.New("release manifest format or version is invalid")
	}
	if err := validateComponents(m.IncludedComponents); err != nil {
		return err
	}
	if len(m.Artifacts) != len(m.IncludedComponents) {
		return errors.New("release manifest requires exactly one artifact per component")
	}
	included := make(map[Component]bool, len(m.IncludedComponents))
	for _, component := range m.IncludedComponents {
		included[component] = true
	}
	seen := make(map[Component]bool, len(m.Artifacts))
	for _, artifact := range m.Artifacts {
		if !included[artifact.Component] || seen[artifact.Component] {
			return fmt.Errorf("release artifact component %q is missing or duplicated", artifact.Component)
		}
		if !validRelative(artifact.File) || artifact.Size < 0 || !validSHA256(artifact.SHA256) {
			return fmt.Errorf("release artifact for %q is invalid", artifact.Component)
		}
		seen[artifact.Component] = true
	}
	return nil
}

func ReadManifest(path string) (ReleaseManifest, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return ReleaseManifest{}, fmt.Errorf("read release manifest: %w", err)
	}
	var manifest ReleaseManifest
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return ReleaseManifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ReleaseManifest{}, errors.New("release manifest must contain one JSON value")
	}
	if err := manifest.Validate(); err != nil {
		return ReleaseManifest{}, err
	}
	return manifest, nil
}

func BuildReleaseManifest(sourceRoot, version string, componentFiles map[Component]string) (ReleaseManifest, error) {
	if !filepath.IsAbs(sourceRoot) || !validVersion(version) || len(componentFiles) == 0 {
		return ReleaseManifest{}, errors.New("absolute source root, valid version, and component files are required")
	}
	manifest := ReleaseManifest{FormatVersion: 1, Version: version}
	for component, file := range componentFiles {
		if _, ok := allowedComponents[component]; !ok {
			return ReleaseManifest{}, fmt.Errorf("unknown release component %q", component)
		}
		if !validRelative(file) {
			return ReleaseManifest{}, fmt.Errorf("invalid artifact path for %s", component)
		}
		path := filepath.Join(sourceRoot, filepath.FromSlash(file))
		if err := ensureRegularBeneath(sourceRoot, path); err != nil {
			return ReleaseManifest{}, err
		}
		info, err := os.Stat(path)
		if err != nil {
			return ReleaseManifest{}, err
		}
		digest, err := hashFile(path)
		if err != nil {
			return ReleaseManifest{}, err
		}
		manifest.IncludedComponents = append(manifest.IncludedComponents, component)
		manifest.Artifacts = append(manifest.Artifacts, Artifact{Component: component, File: file, Size: info.Size(), SHA256: digest})
	}
	manifest.IncludedComponents = sortedComponents(manifest.IncludedComponents)
	sort.Slice(manifest.Artifacts, func(i, j int) bool { return manifest.Artifacts[i].Component < manifest.Artifacts[j].Component })
	return manifest, manifest.Validate()
}

func WriteReleaseManifest(path string, manifest ReleaseManifest) error {
	if err := manifest.Validate(); err != nil {
		return err
	}
	return writeManifest(path, manifest)
}

func verifyReadiness(readiness Readiness) error {
	if readiness.CheckedAt.IsZero() {
		return errors.New("readiness check time is required")
	}
	probes := map[string]Probe{
		"harness": readiness.Harness, "codex": readiness.Codex,
		"kimi": readiness.Kimi, "managed_provider": readiness.ManagedProvider,
	}
	for name, probe := range probes {
		if !probe.OK || strings.TrimSpace(probe.Evidence) == "" || len(probe.Evidence) > 256 || strings.ContainsAny(probe.Evidence, "\r\n\x00") {
			return fmt.Errorf("successful redacted readiness evidence is required for %s", name)
		}
	}
	return nil
}

func validateComponents(components []Component) error {
	if len(components) == 0 {
		return errors.New("at least one release component is required")
	}
	seen := make(map[Component]bool, len(components))
	for _, component := range components {
		if _, ok := allowedComponents[component]; !ok {
			return fmt.Errorf("unknown release component %q", component)
		}
		if seen[component] {
			return fmt.Errorf("duplicate release component %q", component)
		}
		seen[component] = true
	}
	return nil
}

func verifyArtifacts(root string, manifest ReleaseManifest) error {
	for _, artifact := range manifest.Artifacts {
		path := filepath.Join(root, filepath.FromSlash(artifact.File))
		if err := ensureRegularBeneath(root, path); err != nil {
			return fmt.Errorf("verify %s artifact: %w", artifact.Component, err)
		}
		info, err := os.Stat(path)
		if err != nil || info.Size() != artifact.Size {
			return fmt.Errorf("release artifact %s has unexpected size", artifact.File)
		}
		digest, err := hashFile(path)
		if err != nil || !strings.EqualFold(digest, artifact.SHA256) {
			return fmt.Errorf("release artifact %s failed integrity verification", artifact.File)
		}
	}
	return nil
}

func copyArtifacts(source, destination string, manifest ReleaseManifest) error {
	for _, artifact := range manifest.Artifacts {
		from := filepath.Join(source, filepath.FromSlash(artifact.File))
		to := filepath.Join(destination, filepath.FromSlash(artifact.File))
		if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
			return err
		}
		input, err := os.Open(from)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		closeInputErr := input.Close()
		syncErr := output.Sync()
		closeOutputErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeInputErr != nil {
			return closeInputErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeOutputErr != nil {
			return closeOutputErr
		}
	}
	return nil
}

func writeManifest(path string, manifest ReleaseManifest) error {
	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o600)
}

func ensureRegularBeneath(root, path string) error {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("artifact escapes release root")
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 || isReparsePoint(rootInfo) {
		return errors.New("release root is not a normal directory")
	}
	current := root
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return errors.New("artifact path contains a reparse point")
		}
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("artifact is not a regular file")
	}
	return nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func validVersion(version string) bool {
	if version == "" || len(version) > 128 {
		return false
	}
	for _, character := range version {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && !strings.ContainsRune("._-+", character) {
			return false
		}
	}
	return version != "." && version != ".."
}

func validRelative(path string) bool {
	if path == "" || strings.Contains(path, "\\") || strings.HasPrefix(path, "/") {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(path)))
	return clean == path && clean != "." && clean != ".." && !strings.HasPrefix(clean, "../")
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func sortedComponents(values []Component) []Component {
	result := append([]Component(nil), values...)
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}
