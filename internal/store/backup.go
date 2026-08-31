package store

import (
	"context"
	"database/sql"
	"os"

	"workagent3/internal/sqlitebackup"

	_ "modernc.org/sqlite"
)

// ExportBackup owns the Portal/Auth backup projection. Active sessions and
// Runtime registration credentials are deliberately not part of the exported
// schema, so the Operations orchestrator never needs to read Portal tables.
func ExportBackup(ctx context.Context, source, destination string) error {
	if err := sqlitebackup.ValidateSource(source); err != nil {
		return err
	}
	input, err := sql.Open("sqlite", source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := sql.Open("sqlite", destination)
	if err != nil {
		return err
	}
	defer output.Close()
	if _, err := output.ExecContext(ctx, `CREATE TABLE users (
id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
display_name TEXT NOT NULL, sid TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
disabled INTEGER NOT NULL, admin INTEGER NOT NULL, collaboration_enabled INTEGER NOT NULL)`); err != nil {
		return err
	}
	adminExpression := "0"
	var hasAdmin int
	if err := input.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pragma_table_info('users') WHERE name='admin')`).Scan(&hasAdmin); err != nil {
		return err
	}
	if hasAdmin != 0 {
		adminExpression = "admin"
	}
	rows, err := input.QueryContext(ctx, `SELECT id,username,display_name,sid,password_hash,disabled,`+adminExpression+`,collaboration_enabled FROM users ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	tx, err := output.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for rows.Next() {
		var id int64
		var username, displayName, sid, passwordHash string
		var disabled, admin, collaborationEnabled int
		if err := rows.Scan(&id, &username, &displayName, &sid, &passwordHash, &disabled, &admin, &collaborationEnabled); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO users VALUES(?,?,?,?,?,?,?,?)`, id, username, displayName, sid, passwordHash, disabled, admin, collaborationEnabled); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return os.Chmod(destination, 0o600)
}
