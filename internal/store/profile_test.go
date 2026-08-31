package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestOpenMigratesLegacyUserProfileColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "portal.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, sid TEXT NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0); INSERT INTO users(username,sid,password_hash) VALUES('alice','S-1-5-21-1000','hash')`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.UserByUsername(t.Context(), "alice")
	if err != nil || user.DisplayName != "alice" || user.WindowsUsername != "alice" || user.CollaborationEnabled || !user.CollaborationCapable {
		t.Fatalf("migrated user = %#v, %v", user, err)
	}
}
