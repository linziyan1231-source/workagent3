package collaboration

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound        = errors.New("shared project not found")
	ErrForbidden       = errors.New("shared project access forbidden")
	ErrConflict        = errors.New("shared project conflict")
	ErrInviteExpired   = errors.New("shared project invite expired")
	ErrTransferPending = errors.New("shared ownership transfer pending")
)

var stableIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type Project struct {
	ID             string    `json:"id"`
	OwnerUserID    int64     `json:"ownerUserId"`
	OwnerSID       string    `json:"ownerSid"`
	Name           string    `json:"name"`
	State          string    `json:"state"`
	CurrentRole    string    `json:"currentRole"`
	Hidden         bool      `json:"hidden"`
	PendingOwnerID *int64    `json:"pendingOwnerUserId,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type Member struct {
	ProjectID string    `json:"projectId"`
	UserID    int64     `json:"userId"`
	SID       string    `json:"sid"`
	Role      string    `json:"role"`
	State     string    `json:"state"`
	JoinedAt  time.Time `json:"joinedAt"`
}

type Invite struct {
	ID            string     `json:"id"`
	ProjectID     string     `json:"projectId"`
	InviterUserID int64      `json:"inviterUserId"`
	TargetUserID  int64      `json:"targetUserId"`
	TargetSID     string     `json:"targetSid"`
	Status        string     `json:"status"`
	ExpiresAt     time.Time  `json:"expiresAt"`
	CreatedAt     time.Time  `json:"createdAt"`
	ActedAt       *time.Time `json:"actedAt,omitempty"`
}

type OwnershipTransfer struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"projectId"`
	FromUserID int64     `json:"fromUserId"`
	ToUserID   int64     `json:"toUserId"`
	ToSID      string    `json:"toSid"`
	State      string    `json:"state"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open collaboration database: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, now: time.Now}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS shared_projects (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  owner_sid TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning','active','transfer_pending','archived','failed')),
  pending_owner_user_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shared_members (
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  sid TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  state TEXT NOT NULL CHECK (state IN ('pending_acl','accepted','removal_pending')),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (project_id,user_id),
  UNIQUE (project_id,sid)
);
CREATE UNIQUE INDEX IF NOT EXISTS shared_one_owner
ON shared_members(project_id) WHERE role='owner';
CREATE TABLE IF NOT EXISTS shared_invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  inviter_user_id INTEGER NOT NULL,
  target_user_id INTEGER NOT NULL,
  target_sid TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepting','accepted','declined','revoked','expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  acted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS shared_pending_invite
ON shared_invites(project_id,target_user_id) WHERE status IN ('pending','accepting');
CREATE TABLE IF NOT EXISTS shared_ownership_transfers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  to_sid TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','committed','aborted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shared_pending_transfer
ON shared_ownership_transfers(project_id) WHERE state='pending';
`)
	if err != nil {
		return fmt.Errorf("migrate collaboration database: %w", err)
	}
	return nil
}

func (s *Store) CreateProject(ctx context.Context, project Project) (Project, error) {
	project.ID = strings.TrimSpace(project.ID)
	project.Name = strings.TrimSpace(project.Name)
	if !stableIDPattern.MatchString(project.ID) || project.OwnerUserID <= 0 || !validSID(project.OwnerSID) || project.Name == "" || len(project.Name) > 128 {
		return Project{}, errors.New("invalid shared project")
	}
	stamp := s.now().UTC().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Project{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO shared_projects(id,owner_user_id,owner_sid,name,state,created_at,updated_at) VALUES(?,?,?,?, 'provisioning',?,?)`, project.ID, project.OwnerUserID, project.OwnerSID, project.Name, stamp, stamp); err != nil {
		return Project{}, fmt.Errorf("create shared project: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO shared_members(project_id,user_id,sid,role,state,joined_at) VALUES(?,?,?,'owner','accepted',?)`, project.ID, project.OwnerUserID, project.OwnerSID, stamp); err != nil {
		return Project{}, fmt.Errorf("create shared project owner: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Project{}, err
	}
	return s.ProjectForUser(ctx, project.ID, project.OwnerUserID, true)
}

func (s *Store) SetProvisioningResult(ctx context.Context, projectID string, active bool) error {
	state := "failed"
	if active {
		state = "active"
	}
	result, err := s.db.ExecContext(ctx, `UPDATE shared_projects SET state=?,updated_at=? WHERE id=? AND state='provisioning'`, state, s.now().UTC().UnixMilli(), strings.TrimSpace(projectID))
	if err != nil {
		return err
	}
	return requireOne(result, ErrConflict)
}

func (s *Store) AbortProjectProvisioning(ctx context.Context, projectID string, ownerUserID int64) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM shared_projects WHERE id=? AND owner_user_id=? AND state IN ('provisioning','failed')`, strings.TrimSpace(projectID), ownerUserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrConflict)
}

func (s *Store) ProjectForUser(ctx context.Context, projectID string, userID int64, includeHidden bool) (Project, error) {
	var project Project
	var hidden int
	var pending sql.NullInt64
	var created, updated int64
	err := s.db.QueryRowContext(ctx, `SELECT p.id,p.owner_user_id,p.owner_sid,p.name,p.state,m.role,m.hidden,p.pending_owner_user_id,p.created_at,p.updated_at
FROM shared_projects p JOIN shared_members m ON m.project_id=p.id AND m.user_id=? AND m.state='accepted'
WHERE p.id=?`, userID, strings.TrimSpace(projectID)).Scan(&project.ID, &project.OwnerUserID, &project.OwnerSID, &project.Name, &project.State, &project.CurrentRole, &hidden, &pending, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, err
	}
	project.Hidden = hidden != 0
	if project.Hidden && !includeHidden {
		return Project{}, ErrNotFound
	}
	if pending.Valid {
		project.PendingOwnerID = &pending.Int64
	}
	project.CreatedAt = time.UnixMilli(created).UTC()
	project.UpdatedAt = time.UnixMilli(updated).UTC()
	return project, nil
}

func (s *Store) ListProjects(ctx context.Context, userID int64, includeHidden bool) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id FROM shared_projects p JOIN shared_members m ON m.project_id=p.id AND m.user_id=? AND m.state='accepted' WHERE (? OR m.hidden=0) ORDER BY p.updated_at DESC,p.id`, userID, includeHidden)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	projects := make([]Project, 0, len(ids))
	for _, id := range ids {
		project, err := s.ProjectForUser(ctx, id, userID, includeHidden)
		if err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	return projects, nil
}

func (s *Store) RenameProject(ctx context.Context, projectID string, ownerUserID int64, name string) (Project, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 {
		return Project{}, errors.New("invalid shared project name")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE shared_projects SET name=?,updated_at=? WHERE id=? AND owner_user_id=? AND state IN ('active','transfer_pending')`, name, s.now().UTC().UnixMilli(), projectID, ownerUserID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrForbidden); err != nil {
		return Project{}, err
	}
	return s.ProjectForUser(ctx, projectID, ownerUserID, true)
}

func (s *Store) SetHidden(ctx context.Context, projectID string, userID int64, hidden bool) error {
	result, err := s.db.ExecContext(ctx, `UPDATE shared_members SET hidden=? WHERE project_id=? AND user_id=? AND state='accepted'`, hidden, projectID, userID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrNotFound)
}

func (s *Store) Members(ctx context.Context, projectID string, requesterID int64) ([]Member, error) {
	if _, err := s.ProjectForUser(ctx, projectID, requesterID, true); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT project_id,user_id,sid,role,state,joined_at FROM shared_members WHERE project_id=? AND state='accepted' ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,joined_at,user_id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var members []Member
	for rows.Next() {
		var member Member
		var joined int64
		if err := rows.Scan(&member.ProjectID, &member.UserID, &member.SID, &member.Role, &member.State, &joined); err != nil {
			return nil, err
		}
		member.JoinedAt = time.UnixMilli(joined).UTC()
		members = append(members, member)
	}
	return members, rows.Err()
}

func (s *Store) CreateInvite(ctx context.Context, invite Invite) (Invite, error) {
	if !stableIDPattern.MatchString(invite.ID) || invite.InviterUserID <= 0 || invite.TargetUserID <= 0 || invite.InviterUserID == invite.TargetUserID || !validSID(invite.TargetSID) || invite.ExpiresAt.IsZero() {
		return Invite{}, errors.New("invalid shared invite")
	}
	project, err := s.ProjectForUser(ctx, invite.ProjectID, invite.InviterUserID, true)
	if err != nil || project.CurrentRole != "owner" || project.State != "active" {
		return Invite{}, ErrForbidden
	}
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM shared_members WHERE project_id=? AND user_id=?)`, invite.ProjectID, invite.TargetUserID).Scan(&exists); err != nil {
		return Invite{}, err
	}
	if exists != 0 {
		return Invite{}, ErrConflict
	}
	stamp := s.now().UTC()
	if !invite.ExpiresAt.After(stamp) {
		return Invite{}, ErrInviteExpired
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO shared_invites(id,project_id,inviter_user_id,target_user_id,target_sid,status,expires_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)`, invite.ID, invite.ProjectID, invite.InviterUserID, invite.TargetUserID, invite.TargetSID, invite.ExpiresAt.UTC().UnixMilli(), stamp.UnixMilli())
	if err != nil {
		return Invite{}, fmt.Errorf("create shared invite: %w", err)
	}
	return s.Invite(ctx, invite.ID)
}

func (s *Store) Invite(ctx context.Context, id string) (Invite, error) {
	var invite Invite
	var expires, created int64
	var acted sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT id,project_id,inviter_user_id,target_user_id,target_sid,status,expires_at,created_at,acted_at FROM shared_invites WHERE id=?`, id).Scan(&invite.ID, &invite.ProjectID, &invite.InviterUserID, &invite.TargetUserID, &invite.TargetSID, &invite.Status, &expires, &created, &acted)
	if errors.Is(err, sql.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	if err != nil {
		return Invite{}, err
	}
	invite.ExpiresAt, invite.CreatedAt = time.UnixMilli(expires).UTC(), time.UnixMilli(created).UTC()
	if acted.Valid {
		value := time.UnixMilli(acted.Int64).UTC()
		invite.ActedAt = &value
	}
	return invite, nil
}

func (s *Store) BeginInviteAcceptance(ctx context.Context, inviteID string, targetUserID int64) (Member, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Member{}, err
	}
	defer tx.Rollback()
	var projectID, targetSID, status, projectState string
	var expectedTarget, expires int64
	err = tx.QueryRowContext(ctx, `SELECT i.project_id,i.target_user_id,i.target_sid,i.status,i.expires_at,p.state FROM shared_invites i JOIN shared_projects p ON p.id=i.project_id WHERE i.id=?`, inviteID).Scan(&projectID, &expectedTarget, &targetSID, &status, &expires, &projectState)
	if errors.Is(err, sql.ErrNoRows) {
		return Member{}, ErrNotFound
	}
	if err != nil {
		return Member{}, err
	}
	if expectedTarget != targetUserID {
		return Member{}, ErrForbidden
	}
	if status != "pending" || projectState != "active" {
		return Member{}, ErrConflict
	}
	stamp := s.now().UTC()
	if !stamp.Before(time.UnixMilli(expires)) {
		if _, err := tx.ExecContext(ctx, `UPDATE shared_invites SET status='expired',acted_at=? WHERE id=? AND status='pending'`, stamp.UnixMilli(), inviteID); err != nil {
			return Member{}, err
		}
		if err := tx.Commit(); err != nil {
			return Member{}, err
		}
		return Member{}, ErrInviteExpired
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO shared_members(project_id,user_id,sid,role,state,joined_at) VALUES(?,?,?,'member','pending_acl',?)`, projectID, targetUserID, targetSID, stamp.UnixMilli()); err != nil {
		return Member{}, ErrConflict
	}
	result, err := tx.ExecContext(ctx, `UPDATE shared_invites SET status='accepting' WHERE id=? AND status='pending'`, inviteID)
	if err != nil {
		return Member{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Member{}, err
	}
	if err := tx.Commit(); err != nil {
		return Member{}, err
	}
	return Member{ProjectID: projectID, UserID: targetUserID, SID: targetSID, Role: "member", State: "pending_acl", JoinedAt: stamp}, nil
}

func (s *Store) CompleteInviteAcceptance(ctx context.Context, inviteID string, targetUserID int64) (Project, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Project{}, err
	}
	defer tx.Rollback()
	var projectID string
	if err := tx.QueryRowContext(ctx, `SELECT project_id FROM shared_invites WHERE id=? AND target_user_id=? AND status='accepting'`, inviteID, targetUserID).Scan(&projectID); errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrConflict
	} else if err != nil {
		return Project{}, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE shared_members SET state='accepted' WHERE project_id=? AND user_id=? AND state='pending_acl'`, projectID, targetUserID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Project{}, err
	}
	result, err = tx.ExecContext(ctx, `UPDATE shared_invites SET status='accepted',acted_at=? WHERE id=? AND target_user_id=? AND status='accepting'`, s.now().UTC().UnixMilli(), inviteID, targetUserID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Project{}, err
	}
	if err := tx.Commit(); err != nil {
		return Project{}, err
	}
	return s.ProjectForUser(ctx, projectID, targetUserID, true)
}

func (s *Store) AbortInviteAcceptance(ctx context.Context, inviteID string, targetUserID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var projectID string
	var expires int64
	if err := tx.QueryRowContext(ctx, `SELECT project_id,expires_at FROM shared_invites WHERE id=? AND target_user_id=? AND status='accepting'`, inviteID, targetUserID).Scan(&projectID, &expires); errors.Is(err, sql.ErrNoRows) {
		return ErrConflict
	} else if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM shared_members WHERE project_id=? AND user_id=? AND state='pending_acl'`, projectID, targetUserID)
	if err != nil {
		return err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return err
	}
	status := "pending"
	var acted any
	if !s.now().UTC().Before(time.UnixMilli(expires)) {
		status, acted = "expired", s.now().UTC().UnixMilli()
	}
	result, err = tx.ExecContext(ctx, `UPDATE shared_invites SET status=?,acted_at=? WHERE id=? AND status='accepting'`, status, acted, inviteID)
	if err != nil {
		return err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeclineInvite(ctx context.Context, inviteID string, targetUserID int64) error {
	result, err := s.db.ExecContext(ctx, `UPDATE shared_invites SET status='declined',acted_at=? WHERE id=? AND target_user_id=? AND status='pending'`, s.now().UTC().UnixMilli(), inviteID, targetUserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrForbidden)
}

func (s *Store) RevokeInvite(ctx context.Context, inviteID string, ownerUserID int64) error {
	result, err := s.db.ExecContext(ctx, `UPDATE shared_invites SET status='revoked',acted_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM shared_projects p WHERE p.id=shared_invites.project_id AND p.owner_user_id=?)`, s.now().UTC().UnixMilli(), inviteID, ownerUserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrForbidden)
}

func (s *Store) InvitesForTarget(ctx context.Context, targetUserID int64) ([]Invite, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM shared_invites WHERE target_user_id=? AND status='pending' ORDER BY created_at,id`, targetUserID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	invites := make([]Invite, 0, len(ids))
	for _, id := range ids {
		invite, err := s.Invite(ctx, id)
		if err != nil {
			return nil, err
		}
		invites = append(invites, invite)
	}
	return invites, nil
}

func (s *Store) BeginMemberRemoval(ctx context.Context, projectID string, requesterUserID, targetUserID int64) (Member, error) {
	if requesterUserID <= 0 || targetUserID <= 0 {
		return Member{}, ErrForbidden
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Member{}, err
	}
	defer tx.Rollback()
	var owner int64
	var projectState string
	if err := tx.QueryRowContext(ctx, `SELECT owner_user_id,state FROM shared_projects WHERE id=?`, projectID).Scan(&owner, &projectState); errors.Is(err, sql.ErrNoRows) {
		return Member{}, ErrNotFound
	} else if err != nil {
		return Member{}, err
	}
	if projectState != "active" || (requesterUserID != owner && requesterUserID != targetUserID) || targetUserID == owner {
		return Member{}, ErrForbidden
	}
	member, err := memberInTx(ctx, tx, projectID, targetUserID)
	if err != nil || member.Role != "member" || member.State != "accepted" {
		return Member{}, ErrNotFound
	}
	result, err := tx.ExecContext(ctx, `UPDATE shared_members SET state='removal_pending' WHERE project_id=? AND user_id=? AND state='accepted'`, projectID, targetUserID)
	if err != nil {
		return Member{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Member{}, err
	}
	if err := tx.Commit(); err != nil {
		return Member{}, err
	}
	member.State = "removal_pending"
	return member, nil
}

func (s *Store) CompleteMemberRemoval(ctx context.Context, projectID string, requesterUserID, targetUserID int64) error {
	if err := s.authorizeMemberRemoval(ctx, projectID, requesterUserID, targetUserID); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM shared_members WHERE project_id=? AND user_id=? AND role='member' AND state='removal_pending'`, projectID, targetUserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrConflict)
}

func (s *Store) AbortMemberRemoval(ctx context.Context, projectID string, requesterUserID, targetUserID int64) error {
	if err := s.authorizeMemberRemoval(ctx, projectID, requesterUserID, targetUserID); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE shared_members SET state='accepted' WHERE project_id=? AND user_id=? AND role='member' AND state='removal_pending'`, projectID, targetUserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrConflict)
}

func (s *Store) authorizeMemberRemoval(ctx context.Context, projectID string, requesterUserID, targetUserID int64) error {
	var owner int64
	var state string
	if err := s.db.QueryRowContext(ctx, `SELECT owner_user_id,state FROM shared_projects WHERE id=?`, projectID).Scan(&owner, &state); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if state != "active" || targetUserID == owner || (requesterUserID != owner && requesterUserID != targetUserID) {
		return ErrForbidden
	}
	return nil
}

func memberInTx(ctx context.Context, tx *sql.Tx, projectID string, userID int64) (Member, error) {
	var member Member
	var joined int64
	err := tx.QueryRowContext(ctx, `SELECT project_id,user_id,sid,role,state,joined_at FROM shared_members WHERE project_id=? AND user_id=?`, projectID, userID).Scan(&member.ProjectID, &member.UserID, &member.SID, &member.Role, &member.State, &joined)
	if errors.Is(err, sql.ErrNoRows) {
		return Member{}, ErrNotFound
	}
	if err != nil {
		return Member{}, err
	}
	member.JoinedAt = time.UnixMilli(joined).UTC()
	return member, nil
}

func (s *Store) ArchiveProject(ctx context.Context, projectID string, ownerUserID int64) error {
	result, err := s.db.ExecContext(ctx, `UPDATE shared_projects SET state='archived',updated_at=? WHERE id=? AND owner_user_id=? AND state='active'`, s.now().UTC().UnixMilli(), projectID, ownerUserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrForbidden)
}

func (s *Store) BeginOwnershipTransfer(ctx context.Context, transfer OwnershipTransfer, ownerUserID int64) (OwnershipTransfer, error) {
	if !stableIDPattern.MatchString(transfer.ID) || transfer.ToUserID <= 0 || transfer.ToUserID == ownerUserID || !validSID(transfer.ToSID) {
		return OwnershipTransfer{}, errors.New("invalid ownership transfer")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return OwnershipTransfer{}, err
	}
	defer tx.Rollback()
	var owner int64
	var state string
	if err := tx.QueryRowContext(ctx, `SELECT owner_user_id,state FROM shared_projects WHERE id=?`, transfer.ProjectID).Scan(&owner, &state); err != nil {
		return OwnershipTransfer{}, ErrNotFound
	}
	if owner != ownerUserID {
		return OwnershipTransfer{}, ErrForbidden
	}
	if state == "transfer_pending" {
		return OwnershipTransfer{}, ErrTransferPending
	}
	if state != "active" {
		return OwnershipTransfer{}, ErrConflict
	}
	var memberSID string
	if err := tx.QueryRowContext(ctx, `SELECT sid FROM shared_members WHERE project_id=? AND user_id=? AND role='member' AND state='accepted'`, transfer.ProjectID, transfer.ToUserID).Scan(&memberSID); err != nil || !strings.EqualFold(memberSID, transfer.ToSID) {
		return OwnershipTransfer{}, ErrForbidden
	}
	stamp := s.now().UTC().UnixMilli()
	if _, err := tx.ExecContext(ctx, `INSERT INTO shared_ownership_transfers(id,project_id,from_user_id,to_user_id,to_sid,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)`, transfer.ID, transfer.ProjectID, ownerUserID, transfer.ToUserID, transfer.ToSID, stamp, stamp); err != nil {
		return OwnershipTransfer{}, fmt.Errorf("begin ownership transfer: %w", err)
	}
	result, err := tx.ExecContext(ctx, `UPDATE shared_projects SET state='transfer_pending',pending_owner_user_id=?,updated_at=? WHERE id=? AND state='active'`, transfer.ToUserID, stamp, transfer.ProjectID)
	if err != nil {
		return OwnershipTransfer{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return OwnershipTransfer{}, err
	}
	if err := tx.Commit(); err != nil {
		return OwnershipTransfer{}, err
	}
	return s.OwnershipTransfer(ctx, transfer.ID)
}

func (s *Store) CompleteOwnershipTransfer(ctx context.Context, transferID string) (Project, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Project{}, err
	}
	defer tx.Rollback()
	var projectID, toSID, state string
	var fromUserID, toUserID int64
	if err := tx.QueryRowContext(ctx, `SELECT project_id,from_user_id,to_user_id,to_sid,state FROM shared_ownership_transfers WHERE id=?`, transferID).Scan(&projectID, &fromUserID, &toUserID, &toSID, &state); err != nil {
		return Project{}, ErrNotFound
	}
	if state != "pending" {
		return Project{}, ErrConflict
	}
	stamp := s.now().UTC().UnixMilli()
	result, err := tx.ExecContext(ctx, `UPDATE shared_members SET role='member' WHERE project_id=? AND user_id=? AND role='owner' AND state='accepted'`, projectID, fromUserID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Project{}, err
	}
	result, err = tx.ExecContext(ctx, `UPDATE shared_members SET role='owner' WHERE project_id=? AND user_id=? AND role='member' AND state='accepted'`, projectID, toUserID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Project{}, err
	}
	result, err = tx.ExecContext(ctx, `UPDATE shared_projects SET owner_user_id=?,owner_sid=?,state='active',pending_owner_user_id=NULL,updated_at=? WHERE id=? AND state='transfer_pending' AND pending_owner_user_id=?`, toUserID, toSID, stamp, projectID, toUserID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Project{}, err
	}
	result, err = tx.ExecContext(ctx, `UPDATE shared_ownership_transfers SET state='committed',updated_at=? WHERE id=? AND state='pending'`, stamp, transferID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Project{}, err
	}
	if err := tx.Commit(); err != nil {
		return Project{}, err
	}
	return s.ProjectForUser(ctx, projectID, toUserID, true)
}

func (s *Store) AbortOwnershipTransfer(ctx context.Context, transferID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var projectID string
	if err := tx.QueryRowContext(ctx, `SELECT project_id FROM shared_ownership_transfers WHERE id=? AND state='pending'`, transferID).Scan(&projectID); err != nil {
		return ErrNotFound
	}
	stamp := s.now().UTC().UnixMilli()
	result, err := tx.ExecContext(ctx, `UPDATE shared_projects SET state='active',pending_owner_user_id=NULL,updated_at=? WHERE id=? AND state='transfer_pending'`, stamp, projectID)
	if err != nil {
		return err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return err
	}
	result, err = tx.ExecContext(ctx, `UPDATE shared_ownership_transfers SET state='aborted',updated_at=? WHERE id=? AND state='pending'`, stamp, transferID)
	if err != nil {
		return err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) OwnershipTransfer(ctx context.Context, id string) (OwnershipTransfer, error) {
	var transfer OwnershipTransfer
	var created, updated int64
	err := s.db.QueryRowContext(ctx, `SELECT id,project_id,from_user_id,to_user_id,to_sid,state,created_at,updated_at FROM shared_ownership_transfers WHERE id=?`, id).Scan(&transfer.ID, &transfer.ProjectID, &transfer.FromUserID, &transfer.ToUserID, &transfer.ToSID, &transfer.State, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return OwnershipTransfer{}, ErrNotFound
	}
	if err != nil {
		return OwnershipTransfer{}, err
	}
	transfer.CreatedAt, transfer.UpdatedAt = time.UnixMilli(created).UTC(), time.UnixMilli(updated).UTC()
	return transfer, nil
}

func (s *Store) PendingOwnershipTransfers(ctx context.Context) ([]OwnershipTransfer, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM shared_ownership_transfers WHERE state='pending' ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	transfers := make([]OwnershipTransfer, 0, len(ids))
	for _, id := range ids {
		transfer, err := s.OwnershipTransfer(ctx, id)
		if err != nil {
			return nil, err
		}
		transfers = append(transfers, transfer)
	}
	return transfers, nil
}

func validSID(value string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(value)), "S-1-") && len(value) <= 184
}

func requireOne(result sql.Result, fallback error) error {
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return fallback
	}
	return nil
}
