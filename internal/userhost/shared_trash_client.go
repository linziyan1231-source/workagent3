package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Reuse the existing employee platform identity. Unlike best-effort audit,
// recycling must succeed centrally before the file operation reports success.
func (c *auditClient) recycleSharedFile(ctx context.Context, projectID, path string) error {
	body, _ := json.Marshal(map[string]string{
		"sid": c.sid, "projectId": projectID, "operation": "recycle", "path": path,
	})
	endpoint := strings.TrimSuffix(c.endpoint, "/audit") + "/shared-trash"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.credential)
	request.Header.Set("Content-Type", "application/json")
	client := *c.client
	client.Timeout = 3 * time.Minute
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var payload struct {
			Error string `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&payload) == nil && payload.Error != "" {
			return errors.New(payload.Error)
		}
		return fmt.Errorf("shared_trash_http_%d", response.StatusCode)
	}
	return nil
}
