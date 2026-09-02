package collaboration

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	ErrInviteLinkRevoked   = errors.New("shared invite link revoked")
	ErrInviteLinkExhausted = errors.New("shared invite link exhausted")
)

// InviteLink is an unguessable bearer token (crypto/rand, stored like session
// tokens) that turns its holder into a project member on acceptance. MaxUses
// of 0 means the link stays usable until expiry or revocation; 1 makes it
// single-use.
type InviteLink struct {
	Token         string     `json:"token"`
	ProjectID     string     `json:"projectId"`
	ProjectName   string     `json:"projectName"`
	CreatorUserID int64      `json:"creatorUserId"`
	MaxUses       int        `json:"maxUses"`
	UseCount      int        `json:"useCount"`
	Status        string     `json:"status"`
	ExpiresAt     time.Time  `json:"expiresAt"`
	CreatedAt     time.Time  `json:"createdAt"`
	ActedAt       *time.Time `json:"actedAt,omitempty"`
}

func (s *Store) CreateInviteLink(ctx context.Context, link InviteLink) (InviteLink, error) {
	if !stableIDPattern.MatchString(link.Token) || link.CreatorUserID <= 0 || link.MaxUses < 0 || link.ExpiresAt.IsZero() {
		return InviteLink{}, errors.New("invalid shared invite link")
	}
	project, err := s.ProjectForUser(ctx, link.ProjectID, link.CreatorUserID, true)
	if err != nil || project.CurrentRole != "owner" || project.State != "active" {
		return InviteLink{}, ErrForbidden
	}
	stamp := s.now().UTC()
	if !link.ExpiresAt.After(stamp) {
		return InviteLink{}, ErrInviteExpired
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO shared_invite_links(token,project_id,creator_user_id,max_uses,status,expires_at,created_at) VALUES(?,?,?,?,'active',?,?)`, link.Token, link.ProjectID, link.CreatorUserID, link.MaxUses, link.ExpiresAt.UTC().UnixMilli(), stamp.UnixMilli())
	if err != nil {
		return InviteLink{}, fmt.Errorf("create shared invite link: %w", err)
	}
	return s.InviteLink(ctx, link.Token)
}

func (s *Store) InviteLink(ctx context.Context, token string) (InviteLink, error) {
	var link InviteLink
	var expires, created int64
	var acted sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT l.token,l.project_id,p.name,l.creator_user_id,l.max_uses,l.use_count,l.status,l.expires_at,l.created_at,l.acted_at FROM shared_invite_links l JOIN shared_projects p ON p.id=l.project_id WHERE l.token=?`, token).Scan(&link.Token, &link.ProjectID, &link.ProjectName, &link.CreatorUserID, &link.MaxUses, &link.UseCount, &link.Status, &expires, &created, &acted)
	if errors.Is(err, sql.ErrNoRows) {
		return InviteLink{}, ErrNotFound
	}
	if err != nil {
		return InviteLink{}, err
	}
	link.ExpiresAt, link.CreatedAt = time.UnixMilli(expires).UTC(), time.UnixMilli(created).UTC()
	if acted.Valid {
		value := time.UnixMilli(acted.Int64).UTC()
		link.ActedAt = &value
	}
	return link, nil
}

func (s *Store) RevokeInviteLink(ctx context.Context, token, projectID string, ownerUserID int64) error {
	result, err := s.db.ExecContext(ctx, `UPDATE shared_invite_links SET status='revoked',acted_at=? WHERE token=? AND project_id=? AND creator_user_id=? AND status='active'`, s.now().UTC().UnixMilli(), token, projectID, ownerUserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrForbidden)
}

// BeginInviteLinkAcceptance mirrors BeginInviteAcceptance: inside one
// transaction it validates the token lifecycle (unknown, revoked, exhausted,
// expired, archived project, already a member) and records the new member as
// pending_acl so Portal can compensate around one idempotent ACL grant. A
// single-use link flips to exhausted here so a concurrent acceptance cannot
// slip through.
func (s *Store) BeginInviteLinkAcceptance(ctx context.Context, token string, userID int64, sid string) (Member, error) {
	if userID <= 0 || !validSID(sid) {
		return Member{}, ErrForbidden
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Member{}, err
	}
	defer tx.Rollback()
	var projectID, status, projectState string
	var maxUses, useCount, expires int64
	err = tx.QueryRowContext(ctx, `SELECT l.project_id,l.max_uses,l.use_count,l.status,l.expires_at,p.state FROM shared_invite_links l JOIN shared_projects p ON p.id=l.project_id WHERE l.token=?`, token).Scan(&projectID, &maxUses, &useCount, &status, &expires, &projectState)
	if errors.Is(err, sql.ErrNoRows) {
		return Member{}, ErrNotFound
	}
	if err != nil {
		return Member{}, err
	}
	switch status {
	case "revoked":
		return Member{}, ErrInviteLinkRevoked
	case "exhausted":
		return Member{}, ErrInviteLinkExhausted
	}
	if projectState != "active" {
		return Member{}, ErrConflict
	}
	stamp := s.now().UTC()
	if !stamp.Before(time.UnixMilli(expires)) {
		return Member{}, ErrInviteExpired
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO shared_members(project_id,user_id,sid,role,state,joined_at) VALUES(?,?,?,'member','pending_acl',?)`, projectID, userID, sid, stamp.UnixMilli()); err != nil {
		return Member{}, ErrConflict
	}
	newCount := useCount + 1
	newStatus := "active"
	var acted any
	if maxUses > 0 && newCount >= maxUses {
		newStatus, acted = "exhausted", stamp.UnixMilli()
	}
	result, err := tx.ExecContext(ctx, `UPDATE shared_invite_links SET use_count=?,status=?,acted_at=? WHERE token=? AND status='active' AND use_count=?`, newCount, newStatus, acted, token, useCount)
	if err != nil {
		return Member{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Member{}, err
	}
	if err := tx.Commit(); err != nil {
		return Member{}, err
	}
	return Member{ProjectID: projectID, UserID: userID, SID: sid, Role: "member", State: "pending_acl", JoinedAt: stamp}, nil
}

func (s *Store) CompleteInviteLinkAcceptance(ctx context.Context, token string, userID int64) (Project, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Project{}, err
	}
	defer tx.Rollback()
	var projectID string
	if err := tx.QueryRowContext(ctx, `SELECT project_id FROM shared_invite_links WHERE token=?`, token).Scan(&projectID); errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	} else if err != nil {
		return Project{}, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE shared_members SET state='accepted' WHERE project_id=? AND user_id=? AND state='pending_acl'`, projectID, userID)
	if err != nil {
		return Project{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Project{}, err
	}
	if err := tx.Commit(); err != nil {
		return Project{}, err
	}
	return s.ProjectForUser(ctx, projectID, userID, true)
}

// AbortInviteLinkAcceptance compensates a failed ACL grant: it removes the
// pending member row and hands the consumed use back, so a transient ACL
// failure never burns a single-use link.
func (s *Store) AbortInviteLinkAcceptance(ctx context.Context, token string, userID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var projectID, status string
	var maxUses, useCount int
	var acted sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT project_id,max_uses,use_count,status,acted_at FROM shared_invite_links WHERE token=?`, token).Scan(&projectID, &maxUses, &useCount, &status, &acted); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM shared_members WHERE project_id=? AND user_id=? AND state='pending_acl'`, projectID, userID)
	if err != nil {
		return err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return err
	}
	restored, restoreActed := status, acted
	if status == "exhausted" && useCount-1 < maxUses {
		restored, restoreActed = "active", sql.NullInt64{}
	}
	result, err = tx.ExecContext(ctx, `UPDATE shared_invite_links SET use_count=use_count-1,status=?,acted_at=? WHERE token=?`, restored, restoreActed, token)
	if err != nil {
		return err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return err
	}
	return tx.Commit()
}
