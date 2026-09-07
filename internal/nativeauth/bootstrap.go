package nativeauth

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const bootstrapFileName = "native-model-bootstrap-v1.json"

var apiKeyPattern = regexp.MustCompile(`^cpa_[A-Za-z0-9_-]{20,256}$`)

type Bundle struct {
	FormatVersion int      `json:"formatVersion"`
	BaseURL       string   `json:"baseUrl"`
	CodexAPIKey   string   `json:"codexApiKey"`
	KimiAPIKey    string   `json:"kimiApiKey"`
	CodexModel    string   `json:"codexModel"`
	KimiModel     string   `json:"kimiModel"`
	KimiModels    []string `json:"kimiModels,omitempty"`
}

func (b Bundle) Validate() error {
	if err := ValidateBaseURL(b.BaseURL); err != nil {
		return err
	}
	if b.FormatVersion != 1 || !apiKeyPattern.MatchString(b.CodexAPIKey) || !apiKeyPattern.MatchString(b.KimiAPIKey) {
		return errors.New("native model bootstrap contains invalid credentials")
	}
	if !ValidModel(b.CodexModel) || !ValidModel(b.KimiModel) {
		return errors.New("native model bootstrap contains an invalid model")
	}
	for _, model := range b.KimiModels {
		if !ValidModel(model) {
			return errors.New("native model bootstrap contains an invalid Kimi model")
		}
	}
	return nil
}

// ValidateBaseURL enforces the exact IPv4 loopback /v1 HTTP shape every
// consumer of the native model gateway relies on.
func ValidateBaseURL(raw string) error {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Port() == "" || endpoint.Path != "/v1" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("native model gateway must be an exact IPv4 loopback /v1 HTTP URL")
	}
	return nil
}

// ValidModel reports whether value is an acceptable managed model identifier.
func ValidModel(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || strings.ContainsRune("._:-", character)) {
			return false
		}
	}
	return true
}

func Ready(dataRoot string) bool {
	return regular(filepath.Join(dataRoot, "native", "codex", "auth.json")) &&
		regular(filepath.Join(dataRoot, "native", "kimi", "config.toml"))
}

func Stage(dataRoot string, bundle Bundle) error {
	if err := bundle.Validate(); err != nil {
		return err
	}
	encoded, err := json.Marshal(bundle)
	if err != nil {
		return err
	}
	return writePrivate(filepath.Join(dataRoot, "runtime", bootstrapFileName), append(encoded, '\n'))
}

// Load reads the staged one-time bootstrap without consuming it. The second
// return value reports whether a bundle is staged at all.
func Load(dataRoot string) (Bundle, bool, error) {
	path := filepath.Join(dataRoot, "runtime", bootstrapFileName)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Bundle{}, false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 64*1024 {
		return Bundle{}, false, errors.New("native model bootstrap must be a bounded regular non-symlink file")
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return Bundle{}, false, err
	}
	defer clear(payload)
	var bundle Bundle
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&bundle) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return Bundle{}, false, errors.New("native model bootstrap is invalid")
	}
	if err := bundle.Validate(); err != nil {
		return Bundle{}, false, err
	}
	return bundle, true, nil
}

// Apply writes the staged bundle into the native engine homes (ordered
// delivery step 1). The staged file stays in place until Consume marks the
// whole delivery complete, so a failed later step is replayed on the next
// start.
func Apply(dataRoot string) error {
	bundle, staged, err := Load(dataRoot)
	if err != nil {
		return err
	}
	if !staged {
		return nil
	}
	codexHome := filepath.Join(dataRoot, "native", "codex")
	kimiHome := filepath.Join(dataRoot, "native", "kimi")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(kimiHome, 0o700); err != nil {
		return err
	}
	auth, _ := json.Marshal(map[string]string{"auth_mode": "apikey", "OPENAI_API_KEY": bundle.CodexAPIKey})
	if err := writePrivate(filepath.Join(codexHome, "auth.json"), append(auth, '\n')); err != nil {
		return fmt.Errorf("write native Codex authentication: %w", err)
	}
	codexConfig := "# CLIProxyAPI settings managed by WorkAgent3.\n" +
		"openai_base_url = " + strconv.Quote(bundle.BaseURL) + "\n" +
		"model = " + strconv.Quote(bundle.CodexModel) + "\n" +
		"cli_auth_credentials_store = \"file\"\n"
	if err := writePrivate(filepath.Join(codexHome, "config.toml"), []byte(codexConfig)); err != nil {
		return fmt.Errorf("write native Codex configuration: %w", err)
	}
	kimiConfig := kimiConfiguration(bundle)
	if err := writePrivate(filepath.Join(kimiHome, "config.toml"), []byte(kimiConfig)); err != nil {
		return fmt.Errorf("write native Kimi configuration: %w", err)
	}
	if !Ready(dataRoot) {
		return errors.New("native model authentication readback failed")
	}
	return nil
}

// Consume marks the staged bootstrap fully delivered to every consumer (native
// engine homes and the SID Credential Broker) and removes the one-time file.
func Consume(dataRoot string) error {
	path := filepath.Join(dataRoot, "runtime", bootstrapFileName)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("consume native model bootstrap: %w", err)
	}
	return nil
}

func kimiConfiguration(bundle Bundle) string {
	config := "# CLIProxyAPI settings managed by WorkAgent3.\n" +
		"default_model = " + strconv.Quote("kimi-code/"+bundle.KimiModel) + "\n" +
		"default_thinking = true\n" +
		"default_yolo = true\n\n" +
		"[providers.\"managed:kimi-code\"]\n" +
		"type = \"kimi\"\n" +
		"base_url = " + strconv.Quote(bundle.BaseURL) + "\n" +
		"api_key = " + strconv.Quote(bundle.KimiAPIKey) + "\n\n"
	models := append([]string{bundle.KimiModel}, bundle.KimiModels...)
	seen := make(map[string]bool)
	for _, model := range models {
		if seen[model] {
			continue
		}
		seen[model] = true
		name, contextSize := model, 1048576
		capabilities := "[\"thinking\"]"
		efforts := ""
		switch model {
		case "kimi-for-coding", "kimi-for-coding-highspeed":
			name, contextSize = "Kimi K2.7", 262144
			if model == "kimi-for-coding-highspeed" {
				name += " Fast"
			}
			capabilities = "[\"thinking\", \"always_thinking\"]"
		case "kimi-k3", "k3":
			name = "Kimi K3"
			capabilities = "[\"thinking\", \"always_thinking\"]"
			efforts = "support_efforts = [\"low\", \"high\", \"max\"]\ndefault_effort = \"low\"\n"
		}
		config += "[models.\"kimi-code/" + model + "\"]\n" +
			"provider = \"managed:kimi-code\"\n" +
			"model = " + strconv.Quote(model) + "\n" +
			"max_context_size = " + strconv.Itoa(contextSize) + "\n" +
			"capabilities = " + capabilities + "\n" +
			"display_name = " + strconv.Quote(name) + "\n" + efforts + "\n"
	}
	return config +
		"[thinking]\n" +
		"enabled = true\n\n" +
		"[services.moonshot_search]\n" +
		"base_url = " + strconv.Quote(bundle.BaseURL+"/search?model="+bundle.KimiModel) + "\n" +
		"api_key = " + strconv.Quote(bundle.KimiAPIKey) + "\n\n" +
		"[services.moonshot_fetch]\n" +
		"base_url = " + strconv.Quote(bundle.BaseURL+"/fetch?model="+bundle.KimiModel) + "\n" +
		"api_key = " + strconv.Quote(bundle.KimiAPIKey) + "\n"
}

func regular(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func writePrivate(path string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".native-auth-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return removeErr
		}
		return os.Rename(temporaryPath, path)
	}
	return nil
}
