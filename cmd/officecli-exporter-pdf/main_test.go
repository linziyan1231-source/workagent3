package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestInfoManifestConformsToProtocol(t *testing.T) {
	t.Parallel()
	payload, err := json.Marshal(infoManifest())
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Name       string   `json:"name"`
		Version    string   `json:"version"`
		Protocol   int      `json:"protocol"`
		Kinds      []string `json:"kinds"`
		Extensions []string `json:"extensions"`
		Runtime    string   `json:"runtime"`
		License    string   `json:"license"`
	}
	if err := json.Unmarshal(payload, &manifest); err != nil {
		t.Fatalf("manifest is not a single JSON object: %v", err)
	}
	if manifest.Name != pluginName || manifest.Version != pluginVersion || manifest.Protocol != 1 ||
		len(manifest.Kinds) != 1 || manifest.Kinds[0] != "exporter" ||
		len(manifest.Extensions) != 1 || manifest.Extensions[0] != ".pdf" ||
		manifest.Runtime != "go" || manifest.License == "" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
}

func TestStripViewPrefixes(t *testing.T) {
	t.Parallel()
	input := "[/body/p[@paraId=1]] 你好，世界\r\n[/body/p[2]] Second line\nA1=120000\tD2=Beijing\nplain line\n"
	expected := "你好，世界\nSecond line\nA1=120000\tD2=Beijing\nplain line\n"
	if got := stripViewPrefixes(input); got != expected {
		t.Fatalf("stripViewPrefixes = %q, want %q", got, expected)
	}
}

func TestWritePDFStructure(t *testing.T) {
	t.Parallel()
	var buffer bytes.Buffer
	if err := WritePDF(&buffer, "你好，WorkAgent3。\nSecond line with ASCII 12345."); err != nil {
		t.Fatal(err)
	}
	document := buffer.Bytes()
	if !bytes.HasPrefix(document, []byte("%PDF-1.4")) {
		t.Fatal("missing PDF header")
	}
	if !bytes.Contains(document, []byte("/UniGB-UCS2-H")) || !bytes.Contains(document, []byte("STSong-Light")) {
		t.Fatal("missing standard CJK font objects")
	}
	// The CJK line must be encoded as UCS-2 (UTF-16BE) hex: 你 = U+4F60.
	if !bytes.Contains(document, []byte("<4F60597D")) {
		t.Fatal("CJK text was not encoded as UCS-2 hex")
	}
	if !bytes.HasSuffix(document, []byte("%%EOF\n")) {
		t.Fatal("missing EOF marker")
	}
	entries, ok := xrefEntries(document)
	if !ok {
		t.Fatal("xref table is malformed")
	}
	scanned := pdfObjectOffsets(document)
	if len(entries) != len(scanned) {
		t.Fatalf("xref lists %d objects, scan found %d", len(entries), len(scanned))
	}
	for id, offset := range entries {
		if scanned[id] != offset {
			t.Fatalf("xref offset for object %d = %d, actual %d", id, offset, scanned[id])
		}
	}
}

func TestWritePDFEmptyTextProducesOnePage(t *testing.T) {
	t.Parallel()
	var buffer bytes.Buffer
	if err := WritePDF(&buffer, ""); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(buffer.Bytes(), []byte("/Count 1")) {
		t.Fatal("empty text must still produce one page")
	}
}

func TestWritePDFPaginatesLongDocuments(t *testing.T) {
	t.Parallel()
	var text bytes.Buffer
	for index := 0; index < linesPerPage+3; index++ {
		text.WriteString("line\n")
	}
	var buffer bytes.Buffer
	if err := WritePDF(&buffer, text.String()); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(buffer.Bytes(), []byte("/Count 2")) {
		t.Fatal("long document must paginate to two pages")
	}
}

func TestWrapLinesWrapsCJKAtContentWidth(t *testing.T) {
	t.Parallel()
	line := make([]rune, 0, 60)
	for index := 0; index < 60; index++ {
		line = append(line, '汉')
	}
	wrapped := wrapLines(string(line))
	if len(wrapped) != 2 {
		t.Fatalf("60 CJK runes wrapped into %d lines, want 2", len(wrapped))
	}
}

func TestExportRejectsUnsupportedFormat(t *testing.T) {
	t.Parallel()
	source := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(source, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := export([]string{source, "--out", filepath.Join(t.TempDir(), "out.pdf")}); code != exitUnsupported {
		t.Fatalf("export(.txt) = exit %d, want %d", code, exitUnsupported)
	}
}

func TestExportRequiresSourceAndTarget(t *testing.T) {
	t.Parallel()
	if code := export([]string{"--out", "x.pdf"}); code != exitProtocolMisuse {
		t.Fatalf("export without source = exit %d, want %d", code, exitProtocolMisuse)
	}
}
