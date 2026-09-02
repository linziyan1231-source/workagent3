// officecli-exporter-pdf is the WorkAgent3-internal OfficeCLI exporter plugin
// (plugin protocol v1, kind "exporter") that renders .docx/.xlsx/.pptx sources
// to PDF. No official upstream PDF exporter exists (the officecli.ai plugin
// registry is unreachable and iOfficeAI/OfficeCLI issue #171 is unanswered), so
// the release ships this managed plugin at
// release/managed-tools/officecli/plugins/exporter/pdf/plugin.exe, where the
// managed officecli.exe discovers it as a bundled plugin.
//
// Rendering is text-fidelity: the plugin shells out to the managed officecli
// itself (`officecli view <source> text`) for format-accurate text extraction,
// then paginates the text into a simple A4 PDF with a non-embedded standard CJK
// font (STSong-Light / UniGB-UCS2-H), which browser PDF viewers substitute with
// system fonts. It never writes to the source file.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const (
	pluginName    = "officecli-exporter-pdf"
	pluginVersion = "1.0.0"

	// exportTextTimeout bounds the officecli text-extraction subprocess. The
	// host's idle watchdog (idle_timeout_seconds, export=120s) is the outer
	// bound; heartbeats keep it satisfied while extraction runs.
	exportTextTimeout = 100 * time.Second
	heartbeatInterval = 5 * time.Second
)

// Protocol exit codes (plugins/plugin-protocol.md §6.5).
const (
	exitOK             = 0
	exitCorruptInput   = 2
	exitUnsupported    = 3
	exitProtocolMisuse = 5
)

func main() {
	os.Exit(run(os.Args))
}

func run(args []string) int {
	if len(args) >= 2 && args[1] == "--info" {
		return printInfo()
	}
	if len(args) >= 2 && args[1] == "export" {
		return export(args[2:])
	}
	fmt.Fprintf(os.Stderr, "usage: %s --info | export <source-file> --out <target-file>\n", pluginName)
	return exitProtocolMisuse
}

func infoManifest() map[string]any {
	return map[string]any{
		"name":       pluginName,
		"version":    pluginVersion,
		"protocol":   1,
		"kinds":      []string{"exporter"},
		"extensions": []string{".pdf"},
		"runtime":    "go",
		"idle_timeout_seconds": map[string]any{
			"default": 60,
			"verbs":   map[string]int{"export": 120},
		},
		"supports":    []string{"from:docx", "from:xlsx", "from:pptx"},
		"description": "WorkAgent3 managed text-fidelity PDF exporter",
		"license":     "Proprietary",
	}
}

func printInfo() int {
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(infoManifest()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitUnsupported
	}
	return exitOK
}

// export implements `<plugin> export <source-file> --out <target-file>`. The
// source is read-only; the target is written atomically (temp file + rename)
// so the host never observes a partial PDF.
func export(args []string) int {
	var source, target string
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--out":
			if index+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "export: --out requires a target path")
				return exitProtocolMisuse
			}
			target = args[index+1]
			index++
		case "--options":
			index++ // accepted per protocol §5.2, no backend options defined yet
		default:
			if strings.HasPrefix(args[index], "--") {
				fmt.Fprintf(os.Stderr, "export: unknown option %s\n", args[index])
				return exitProtocolMisuse
			}
			if source != "" {
				fmt.Fprintln(os.Stderr, "export: exactly one source file is accepted")
				return exitProtocolMisuse
			}
			source = args[index]
		}
	}
	if source == "" || target == "" {
		fmt.Fprintln(os.Stderr, "export: source file and --out target are required")
		return exitProtocolMisuse
	}
	absoluteTarget, err := filepath.Abs(target)
	if err != nil {
		fmt.Fprintln(os.Stderr, "export: "+err.Error())
		return exitProtocolMisuse
	}
	switch strings.ToLower(filepath.Ext(source)) {
	case ".docx", ".xlsx", ".pptx":
	default:
		fmt.Fprintf(os.Stderr, "export: unsupported source format %s\n", filepath.Ext(source))
		return exitUnsupported
	}
	info, err := os.Stat(source)
	if err != nil || info.IsDir() {
		fmt.Fprintf(os.Stderr, "export: source file is not readable: %v\n", err)
		return exitCorruptInput
	}
	officeCLI, err := locateOfficeCLI()
	if err != nil {
		fmt.Fprintln(os.Stderr, "export: "+err.Error())
		return exitUnsupported
	}
	stopHeartbeat := heartbeat()
	text, err := extractText(officeCLI, source)
	// `officecli view` keeps the document in a resident process that holds the
	// source open and pins the caller's working directory; release it. close is
	// content- and mtime-neutral for an unmodified source (verified against the
	// pinned officecli 1.0.146), so the source stays read-only.
	closeResident(officeCLI, source)
	stopHeartbeat()
	if err != nil {
		fmt.Fprintf(os.Stderr, "export: text extraction failed: %v\n", err)
		return exitCorruptInput
	}
	if err := writePDFAtomic(absoluteTarget, text); err != nil {
		fmt.Fprintf(os.Stderr, "export: %v\n", err)
		return exitCorruptInput
	}
	return exitOK
}

// locateOfficeCLI finds the officecli binary used for text extraction, in
// order: the OFFICECLI_BIN variable the host sets when spawning plugins, the
// managed-tools root three levels above the bundled plugin path, then PATH.
func locateOfficeCLI() (string, error) {
	if fromEnv := strings.TrimSpace(os.Getenv("OFFICECLI_BIN")); fromEnv != "" {
		if info, err := os.Stat(fromEnv); err == nil && info.Mode().IsRegular() {
			return fromEnv, nil
		}
	}
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), "..", "..", "..", "officecli.exe")
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return filepath.Clean(candidate), nil
		}
	}
	if resolved, err := exec.LookPath("officecli.exe"); err == nil {
		return resolved, nil
	}
	return "", errors.New("managed officecli binary not found (OFFICECLI_BIN, bundled layout, PATH)")
}

// heartbeat keeps the host idle watchdog satisfied during the extraction
// subprocess, per protocol §5.6.
func heartbeat() (stop func()) {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				fmt.Fprintln(os.Stderr, `{"heartbeat":true}`)
			}
		}
	}()
	return func() { close(done) }
}

func extractText(officeCLI, source string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), exportTextTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, officeCLI, "view", source, "text")
	output, err := command.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", errors.New("officecli text extraction timed out")
		}
		return "", err
	}
	return stripViewPrefixes(string(output)), nil
}

// closeResident stops the resident officecli keeps for the source after a
// view. Best-effort: a leaked resident idles without blocking the produced
// PDF, so a close failure only earns a stderr diagnostic.
func closeResident(officeCLI, source string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, officeCLI, "close", source).CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "export: releasing the officecli resident failed: %v: %s\n", err, strings.TrimSpace(string(output)))
	}
}

// stripViewPrefixes removes the leading `[<data-path>] ` annotation that
// `officecli view <file> text` puts on docx/pptx lines (e.g.
// `[/body/p[1]] Hello`). The data-path itself may contain `]` (attribute
// selectors like `[@paraId=1]`), so the prefix ends at the first `]` that is
// followed by a space — or at end of line for empty paragraphs. xlsx cell
// lines (`A1=value`) carry no prefix and pass through untouched.
func stripViewPrefixes(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for index, line := range lines {
		if !strings.HasPrefix(line, "[/") {
			continue
		}
		if cut := strings.Index(line, "] "); cut >= 0 {
			lines[index] = line[cut+2:]
		} else if strings.HasSuffix(line, "]") {
			lines[index] = ""
		}
	}
	return strings.Join(lines, "\n")
}

func writePDFAtomic(target, text string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".officecli-exporter-pdf-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if err := WritePDF(temporary, text); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), target)
}

// wrapWidth is the A4 content width (595pt page, 50pt margins) measured in
// font em units: CJK runes count 1em, others 0.5em at the 11pt body size.
const wrapWidth = (595 - 100) / 11.0

// wrapLines splits extraction output into display lines that fit the page.
// Tabs expand to spaces; control runes and non-BMP runes (unrepresentable in
// the UCS-2 CMap) are replaced.
func wrapLines(text string) []string {
	var wrapped []string
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.Map(func(r rune) rune {
			switch {
			case r == '\t':
				return ' '
			case unicode.IsControl(r) || r > 0xFFFF:
				return -1
			}
			return r
		}, raw)
		if line == "" {
			wrapped = append(wrapped, "")
			continue
		}
		for line != "" {
			width := 0.0
			cut := 0
			for index, r := range line {
				runeWidth := 0.5
				if r > 0xFF {
					runeWidth = 1.0
				}
				if width+runeWidth > wrapWidth {
					break
				}
				width += runeWidth
				cut = index + len(string(r))
			}
			if cut == 0 {
				cut = len(line)
			}
			wrapped = append(wrapped, line[:cut])
			line = strings.TrimLeft(line[cut:], " ")
		}
	}
	return wrapped
}

// encodeUCS2Hex renders a display line as a PDF hex string of UTF-16BE
// (UCS-2) codes for the UniGB-UCS2-H CMap.
func encodeUCS2Hex(line string) string {
	var builder strings.Builder
	builder.Grow(len(line)*4 + 2)
	builder.WriteByte('<')
	for _, r := range line {
		fmt.Fprintf(&builder, "%04X", r)
	}
	builder.WriteByte('>')
	return builder.String()
}
