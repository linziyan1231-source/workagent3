package main

import (
	"bytes"
	"fmt"
	"io"
	"strings"
)

// Minimal PDF writer: A4 pages, one non-embedded standard CJK font
// (STSong-Light with the UniGB-UCS2-H CMap, Adobe-GB1 supplement 5), text
// lines positioned with Td. Browser PDF viewers (PDFium, pdf.js) and Acrobat
// with the Asian font pack substitute/render this standard font; no font
// bytes are embedded, keeping the exporter dependency-free.

const (
	pageWidth    = 595.0
	pageHeight   = 842.0
	pageMargin   = 50.0
	bodyFontSize = 11.0
	lineHeight   = 16.0
)

var linesPerPage = int(pageHeight-2*pageMargin) / int(lineHeight) // 46 lines per A4 page

// WritePDF renders text (already normalized to \n line endings) as a simple
// paginated PDF.
func WritePDF(output io.Writer, text string) error {
	lines := wrapLines(text)
	var pages [][]string
	for start := 0; start < len(lines); start += linesPerPage {
		end := start + linesPerPage
		if end > len(lines) {
			end = len(lines)
		}
		pages = append(pages, lines[start:end])
	}
	if len(pages) == 0 {
		pages = append(pages, nil)
	}

	// Object layout: 1 catalog, 2 pages, 3 Type0 font, 4 descendant CIDFont,
	// then per page a page object followed by its content stream.
	pageObjectIDs := make([]int, len(pages))
	for index := range pages {
		pageObjectIDs[index] = 5 + 2*index
	}

	var document bytes.Buffer
	offsets := map[int]int{}
	writeObject := func(id int, body string) {
		offsets[id] = document.Len()
		fmt.Fprintf(&document, "%d 0 obj\n%s\nendobj\n", id, body)
	}

	document.WriteString("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>")

	kids := ""
	for _, id := range pageObjectIDs {
		kids += fmt.Sprintf("%d 0 R ", id)
	}
	writeObject(2, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", kids, len(pages)))

	writeObject(3, "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>")
	writeObject(4, "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "+
		"/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /DW 1000 >>")

	for index, page := range pages {
		contentID := pageObjectIDs[index] + 1
		writeObject(pageObjectIDs[index], fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.0f %.0f] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>",
			pageWidth, pageHeight, contentID))

		var stream bytes.Buffer
		stream.WriteString("BT /F1 11 Tf 16 TL 50 792 Td\n")
		for position, line := range page {
			if position > 0 {
				stream.WriteString("T*\n")
			}
			stream.WriteString(encodeUCS2Hex(line) + " Tj\n")
		}
		stream.WriteString("ET")
		writeObject(contentID, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", stream.Len(), stream.Bytes()))
	}

	maxID := 4 + 2*len(pages)
	xrefStart := document.Len()
	fmt.Fprintf(&document, "xref\n0 %d\n0000000000 65535 f \n", maxID+1)
	for id := 1; id <= maxID; id++ {
		fmt.Fprintf(&document, "%010d 00000 n \n", offsets[id])
	}
	fmt.Fprintf(&document, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", maxID+1, xrefStart)

	_, err := output.Write(document.Bytes())
	return err
}

// pdfObjectOffsets is a test helper: it re-derives object offsets by scanning
// line starts, so tests can cross-check the xref table without a PDF library.
func pdfObjectOffsets(document []byte) map[int]int {
	offsets := map[int]int{}
	for position := 0; position+7 < len(document); position++ {
		if document[position] == '\n' || position == 0 {
			start := position
			if document[position] == '\n' {
				start++
			}
			var id, generation int
			var marker string
			if count, _ := fmt.Sscanf(string(document[start:min(start+32, len(document))]), "%d %d %s", &id, &generation, &marker); count == 3 && marker == "obj" {
				offsets[id] = start
			}
		}
	}
	return offsets
}

// xrefEntries parses the xref table body (test helper).
func xrefEntries(document []byte) (map[int]int, bool) {
	trailer := bytes.LastIndex(document, []byte("startxref\n"))
	if trailer < 0 {
		return nil, false
	}
	var xrefStart int
	if _, err := fmt.Sscanf(string(document[trailer+len("startxref\n"):]), "%d", &xrefStart); err != nil {
		return nil, false
	}
	if xrefStart < 0 || xrefStart+5 > len(document) || !bytes.HasPrefix(document[xrefStart:], []byte("xref\n")) {
		return nil, false
	}
	lines := strings.Split(string(document[xrefStart:]), "\n")
	var first, count int
	if _, err := fmt.Sscanf(lines[1], "%d %d", &first, &count); err != nil || first != 0 {
		return nil, false
	}
	if len(lines) < 2+count {
		return nil, false
	}
	entries := map[int]int{}
	for index := 1; index < count; index++ {
		var offset, generation int
		var status string
		if _, err := fmt.Sscanf(lines[2+index], "%d %d %s", &offset, &generation, &status); err != nil || status != "n" {
			return nil, false
		}
		entries[first+index] = offset
	}
	return entries, true
}

