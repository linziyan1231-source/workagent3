package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"workagent3/internal/skillmigration"
)

type harnessPresetMigrationPublisher struct {
	path      string
	target    *url.URL
	token     string
	client    *http.Client
	migration *skillmigration.Store
}

func (p *harnessPresetMigrationPublisher) Publish(ctx context.Context) error {
	info, err := os.Lstat(p.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 16<<20 {
		return errors.New("Preset migration ingress must be a regular file")
	}
	payload, err := os.ReadFile(p.path)
	if err != nil {
		return err
	}
	endpoint := p.target.ResolveReference(&url.URL{Path: "/internal/preset-migration"})
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("publish Preset migration: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("publish Preset migration: Harness returned %d", response.StatusCode)
	}
	var report struct {
		Results []skillmigration.Result `json:"results"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&report); err != nil {
		return fmt.Errorf("decode Preset migration results: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("Preset migration response must contain one JSON document")
	}
	if err := p.migration.ReplacePresetResults(ctx, report.Results); err != nil {
		return fmt.Errorf("record Preset migration results: %w", err)
	}
	return nil
}
