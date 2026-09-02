package userhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillmigration"
)

// Migration disposition endpoints (W14): the Portal administrator console
// drives these through the runtime gateway to recover needs_auth/needs_review
// journal items. Retry re-evaluates the item against the live catalog and
// credential broker, then re-publishes the matching Harness projection;
// resolve settles an item the administrator handled by hand.

type migrationCredentialReadiness struct{ credentials credentialCatalog }

func (r migrationCredentialReadiness) CredentialReady(ctx context.Context, id string) bool {
	metadata, err := r.credentials.Metadata(ctx, id)
	return err == nil && metadata.State == credentialbroker.StateReady
}

type migrationMCPReadiness struct{ catalog *mcpruntime.Catalog }

func (r migrationMCPReadiness) MigrationStatus(ctx context.Context, ids []string) (skillmigration.Status, string) {
	for _, id := range ids {
		server, err := r.catalog.Get(ctx, id)
		if err == nil && server.OAuthState == "needs_auth" {
			return skillmigration.NeedsAuth, "mcp_needs_auth:" + id
		}
		if err != nil || !server.Enabled || server.Health == "unavailable" || server.Health == "needs_review" || server.Health == "unknown" {
			return skillmigration.NeedsReview, "mcp_not_healthy:" + id
		}
	}
	return skillmigration.Ready, ""
}

type migrationDispositionInput struct {
	Kind     string `json:"kind"`
	SourceID string `json:"sourceId"`
}

func decodeMigrationDispositionInput(writer http.ResponseWriter, request *http.Request) (migrationDispositionInput, bool) {
	var input migrationDispositionInput
	decoder := json.NewDecoder(io.LimitReader(request.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || input.SourceID == "" || len(input.SourceID) > 256 {
		writeRuntimeError(writer, http.StatusBadRequest, "invalid_migration_disposition")
		return migrationDispositionInput{}, false
	}
	return input, true
}

func writeMigrationDispositionError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, skillmigration.ErrMigrationItemNotFound):
		writeRuntimeError(writer, http.StatusNotFound, "migration_item_not_found")
	case errors.Is(err, skillmigration.ErrMigrationItemSettled):
		writeRuntimeError(writer, http.StatusConflict, "migration_item_settled")
	case errors.Is(err, skillmigration.ErrMigrationNoTarget):
		writeRuntimeError(writer, http.StatusConflict, "migration_item_no_target")
	default:
		writeRuntimeError(writer, http.StatusBadRequest, "invalid_migration_disposition")
	}
}

func retryMigration(migration *skillmigration.Store, catalog *mcpruntime.Catalog, credentials runtimeCredentialCatalog, publisher mcpProjectionPublisher, skillPublisher skillProjectionPublisher, presetPublisher *harnessPresetMigrationPublisher) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		input, ok := decodeMigrationDispositionInput(writer, request)
		if !ok {
			return
		}
		ctx := request.Context()
		var result skillmigration.Result
		var err error
		var publish func(context.Context) error
		switch input.Kind {
		case "mcp_server":
			result, err = migration.RetryMCP(ctx, input.SourceID, catalog, migrationCredentialReadiness{credentials})
			if publisher != nil {
				publish = publisher.Publish
			}
		case "skill":
			result, err = migration.RetrySkill(ctx, input.SourceID, migrationMCPReadiness{catalog})
			if skillPublisher != nil {
				publish = skillPublisher.Publish
			}
		case "preset", "skill_binding", "mcp_binding":
			if presetPublisher == nil {
				writeRuntimeError(writer, http.StatusServiceUnavailable, "preset_projection_unavailable")
				return
			}
			// The Preset projection publisher re-runs the ingress first; the
			// refreshed journal row is then read back.
			if publishErr := presetPublisher.Publish(ctx); publishErr != nil {
				writeRuntimeError(writer, http.StatusBadGateway, "migration_projection_failed")
				return
			}
			result, err = migration.PresetResult(ctx, input.SourceID)
		default:
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_migration_disposition")
			return
		}
		if err != nil {
			writeMigrationDispositionError(writer, err)
			return
		}
		if publish != nil {
			if err := publish(ctx); err != nil {
				writeRuntimeError(writer, http.StatusBadGateway, "migration_projection_failed")
				return
			}
		}
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"result": result})
	}
}

func resolveMigration(migration *skillmigration.Store) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		input, ok := decodeMigrationDispositionInput(writer, request)
		if !ok {
			return
		}
		result, err := migration.MarkResolved(request.Context(), input.Kind, input.SourceID)
		if err != nil {
			writeMigrationDispositionError(writer, err)
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"result": result})
	}
}
