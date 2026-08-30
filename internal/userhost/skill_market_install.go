package userhost

import (
	"archive/zip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"workagent3/internal/skillruntime"
)

const maxMarketArchiveBytes = 50 << 20

type marketSkillMetadata struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

func exportUserSkill(skills *skillruntime.Store) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		name := request.URL.Query().Get("name")
		if name == "" || len(name) > 240 {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_skill_name")
			return
		}
		entry, archive, err := skills.ExportUserPackage(request.Context(), name)
		if errors.Is(err, skillruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "skill_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "skill_publish_not_allowed")
			return
		}
		defer clear(archive)
		metadata, _ := json.Marshal(marketSkillMetadata{ID: entry.ID, Name: entry.Name, Description: entry.Description, Version: entry.Version})
		writer.Header().Set("Content-Type", "application/zip")
		writer.Header().Set("Content-Length", strconv.Itoa(len(archive)))
		writer.Header().Set("X-WorkAgent-Skill-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(archive)
	}
}

func installMarketSkill(skills *skillruntime.Store, publisher skillProjectionPublisher) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		metadata, err := decodeMarketSkillMetadata(request.Header.Get("X-WorkAgent-Skill-Metadata"))
		if err != nil || request.Header.Get("Content-Type") != "application/zip" {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_market_skill_package")
			return
		}
		temporary, err := os.MkdirTemp("", "workagent-market-skill-")
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_install_failed")
			return
		}
		defer os.RemoveAll(temporary)
		archivePath := filepath.Join(temporary, "package.zip")
		archive, err := os.OpenFile(archivePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_install_failed")
			return
		}
		written, copyErr := io.Copy(archive, io.LimitReader(request.Body, maxMarketArchiveBytes+1))
		closeErr := archive.Close()
		if copyErr != nil || closeErr != nil || written == 0 || written > maxMarketArchiveBytes {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_market_skill_package")
			return
		}
		extracted := filepath.Join(temporary, "extracted")
		if err := extractMarketSkillArchive(archivePath, extracted); err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_market_skill_package")
			return
		}
		source, err := marketSkillSource(extracted)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_market_skill_package")
			return
		}
		entry, err := skills.InstallMarket(request.Context(), skillruntime.InstallInput{
			Entry: skillruntime.Entry{
				ID: metadata.ID, Name: metadata.Name, Description: metadata.Description, Version: metadata.Version,
				Source: "market", Enabled: true, RequiredMCPServerIDs: []string{},
			},
			SourceDirectory: source,
		})
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "skill_install_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "skill_projection_failed")
			return
		}
		writeRuntimeJSON(writer, http.StatusCreated, entry)
	}
}

func decodeMarketSkillMetadata(encoded string) (marketSkillMetadata, error) {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > 8*1024 {
		return marketSkillMetadata{}, errors.New("invalid market skill metadata")
	}
	var metadata marketSkillMetadata
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&metadata) != nil || decoder.Decode(&struct{}{}) != io.EOF || metadata.ID == "" || metadata.Name == "" || metadata.Version == "" {
		return marketSkillMetadata{}, errors.New("invalid market skill metadata")
	}
	return metadata, nil
}

func extractMarketSkillArchive(archivePath, destination string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	if len(reader.File) == 0 || len(reader.File) > 10_000 {
		return errors.New("invalid market skill archive")
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return err
	}
	var total uint64
	for _, file := range reader.File {
		clean := path.Clean(file.Name)
		if clean == "." || clean == ".." || path.IsAbs(clean) || strings.HasPrefix(clean, "../") || strings.Contains(file.Name, `\`) {
			return errors.New("market skill archive escapes destination")
		}
		info := file.FileInfo()
		if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("market skill archive contains unsupported file")
		}
		total += file.UncompressedSize64
		if total > 512<<20 {
			return errors.New("market skill archive exceeds expanded size limit")
		}
		target := filepath.Join(destination, filepath.FromSlash(clean))
		if info.IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			source.Close()
			return err
		}
		copied, copyErr := io.Copy(output, io.LimitReader(source, int64(file.UncompressedSize64)+1))
		outputErr := output.Close()
		sourceErr := source.Close()
		if copyErr != nil || outputErr != nil || sourceErr != nil || copied != int64(file.UncompressedSize64) {
			return errors.New("market skill archive entry is invalid")
		}
	}
	return nil
}

func marketSkillSource(root string) (string, error) {
	if info, err := os.Stat(filepath.Join(root, "SKILL.md")); err == nil && info.Mode().IsRegular() {
		return root, nil
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || !entries[0].IsDir() {
		return "", errors.New("market skill archive must contain one skill")
	}
	source := filepath.Join(root, entries[0].Name())
	if info, err := os.Stat(filepath.Join(source, "SKILL.md")); err != nil || !info.Mode().IsRegular() {
		return "", errors.New("market skill archive is missing SKILL.md")
	}
	return source, nil
}
