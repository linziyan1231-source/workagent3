package portal

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/store"
)

type CollaborationPort interface {
	CreateProject(context.Context, collaboration.Project) (collaboration.Project, error)
	SetProvisioningResult(context.Context, string, bool) error
	AbortProjectProvisioning(context.Context, string, int64) error
	ListProjects(context.Context, int64, bool) ([]collaboration.Project, error)
	RenameProject(context.Context, string, int64, string) (collaboration.Project, error)
	SetHidden(context.Context, string, int64, bool) error
	Members(context.Context, string, int64) ([]collaboration.Member, error)
	CreateInvite(context.Context, collaboration.Invite) (collaboration.Invite, error)
	InvitesForTarget(context.Context, int64) ([]collaboration.Invite, error)
	BeginInviteAcceptance(context.Context, string, int64) (collaboration.Member, error)
	CompleteInviteAcceptance(context.Context, string, int64) (collaboration.Project, error)
	AbortInviteAcceptance(context.Context, string, int64) error
	DeclineInvite(context.Context, string, int64) error
	BeginMemberRemoval(context.Context, string, int64, int64) (collaboration.Member, error)
	CompleteMemberRemoval(context.Context, string, int64, int64) error
	AbortMemberRemoval(context.Context, string, int64, int64) error
	BeginOwnershipTransfer(context.Context, collaboration.OwnershipTransfer, int64) (collaboration.OwnershipTransfer, error)
	CompleteOwnershipTransfer(context.Context, string) (collaboration.Project, error)
	AbortOwnershipTransfer(context.Context, string) error
}

// SharedProjectPlatformPort is implemented by the privileged Employee Manager
// adapter. Portal coordinates the business transaction but never edits ACLs.
type SharedProjectPlatformPort interface {
	ProvisionProject(context.Context, string, string) error
	GrantProjectMember(context.Context, string, string) error
	RevokeProjectMember(context.Context, string, string) error
	TransferProjectOwnership(context.Context, string, string, string, []string) error
}

type sharedProjectDTO struct {
	ID             string    `json:"id"`
	OwnerUserID    int64     `json:"ownerUserId"`
	Name           string    `json:"name"`
	State          string    `json:"state"`
	CurrentRole    string    `json:"currentRole"`
	Hidden         bool      `json:"hidden"`
	PendingOwnerID *int64    `json:"pendingOwnerUserId,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type sharedMemberDTO struct {
	UserID   int64     `json:"userId"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joinedAt"`
}

type sharedInviteDTO struct {
	ID            string     `json:"id"`
	ProjectID     string     `json:"projectId"`
	ProjectName   string     `json:"projectName"`
	InviterName   string     `json:"inviterName"`
	InviterUserID int64      `json:"inviterUserId"`
	TargetUserID  int64      `json:"targetUserId"`
	Status        string     `json:"status"`
	ExpiresAt     time.Time  `json:"expiresAt"`
	CreatedAt     time.Time  `json:"createdAt"`
	ActedAt       *time.Time `json:"actedAt,omitempty"`
}

func (s *Server) sharedProjects(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	if request.Method == http.MethodGet {
		projects, err := s.modules.Collaboration.ListProjects(request.Context(), user.ID, request.URL.Query().Get("include_hidden") == "true")
		if err != nil {
			writeCollaborationError(writer, err)
			return
		}
		values := make([]sharedProjectDTO, 0, len(projects))
		for _, project := range projects {
			values = append(values, projectDTO(project))
		}
		writeJSON(writer, http.StatusOK, map[string]any{"projects": values})
		return
	}
	if s.modules.SharedProjects == nil {
		writeError(writer, http.StatusServiceUnavailable, "shared_project_platform_unavailable")
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if !decodeJSON(request, &input, 8*1024) || strings.TrimSpace(input.Name) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_shared_project")
		return
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_project_failed")
		return
	}
	project, err := s.modules.Collaboration.CreateProject(request.Context(), collaboration.Project{ID: id, OwnerUserID: user.ID, OwnerSID: user.SID, Name: input.Name})
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	if err := s.modules.SharedProjects.ProvisionProject(request.Context(), project.ID, user.SID); err != nil {
		_ = s.modules.Collaboration.SetProvisioningResult(request.Context(), project.ID, false)
		_ = s.modules.Collaboration.AbortProjectProvisioning(request.Context(), project.ID, user.ID)
		writeError(writer, http.StatusServiceUnavailable, "shared_project_provision_failed")
		return
	}
	if err := s.modules.Collaboration.SetProvisioningResult(request.Context(), project.ID, true); err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_project_failed")
		return
	}
	projects, err := s.modules.Collaboration.ListProjects(request.Context(), user.ID, true)
	if err != nil || len(projects) == 0 {
		writeError(writer, http.StatusInternalServerError, "shared_project_failed")
		return
	}
	for _, active := range projects {
		if active.ID == project.ID {
			writeJSON(writer, http.StatusCreated, map[string]any{"project": projectDTO(active)})
			return
		}
	}
	writeError(writer, http.StatusInternalServerError, "shared_project_failed")
}

func (s *Server) sharedProject(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	var input struct {
		Name   *string `json:"name"`
		Hidden *bool   `json:"hidden"`
	}
	if !decodeJSON(request, &input, 8*1024) || (input.Name == nil) == (input.Hidden == nil) {
		writeError(writer, http.StatusBadRequest, "invalid_shared_project_update")
		return
	}
	id := request.PathValue("id")
	if input.Name != nil {
		project, err := s.modules.Collaboration.RenameProject(request.Context(), id, user.ID, *input.Name)
		if err != nil {
			writeCollaborationError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"project": projectDTO(project)})
		return
	}
	if err := s.modules.Collaboration.SetHidden(request.Context(), id, user.ID, *input.Hidden); err != nil {
		writeCollaborationError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) sharedProjectMembers(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	members, err := s.modules.Collaboration.Members(request.Context(), request.PathValue("id"), user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	values := make([]sharedMemberDTO, 0, len(members))
	for _, member := range members {
		values = append(values, sharedMemberDTO{UserID: member.UserID, Role: member.Role, JoinedAt: member.JoinedAt})
	}
	writeJSON(writer, http.StatusOK, map[string]any{"members": values})
}

func (s *Server) sharedProjectInvites(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	var input struct {
		TargetUsername string `json:"targetUsername"`
		ExpiresInHours int    `json:"expiresInHours"`
	}
	if !decodeJSON(request, &input, 8*1024) || strings.TrimSpace(input.TargetUsername) == "" || input.ExpiresInHours < 1 || input.ExpiresInHours > 24*30 {
		writeError(writer, http.StatusBadRequest, "invalid_shared_invite")
		return
	}
	target, err := s.store.UserByUsername(request.Context(), input.TargetUsername)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && target.Disabled) {
		writeError(writer, http.StatusNotFound, "invite_target_not_found")
		return
	}
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_invite_failed")
		return
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_invite_failed")
		return
	}
	invite, err := s.modules.Collaboration.CreateInvite(request.Context(), collaboration.Invite{ID: id, ProjectID: request.PathValue("id"), InviterUserID: user.ID, TargetUserID: target.ID, TargetSID: target.SID, ExpiresAt: s.now().Add(time.Duration(input.ExpiresInHours) * time.Hour)})
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{"invite": inviteDTO(invite, user.DisplayName)})
}

func (s *Server) sharedInvites(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	invites, err := s.modules.Collaboration.InvitesForTarget(request.Context(), user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	values := make([]sharedInviteDTO, 0, len(invites))
	for _, invite := range invites {
		inviter, err := s.store.UserByID(request.Context(), invite.InviterUserID)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "shared_invite_failed")
			return
		}
		values = append(values, inviteDTO(invite, inviter.DisplayName))
	}
	writeJSON(writer, http.StatusOK, map[string]any{"invites": values})
}

func (s *Server) sharedInviteAction(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	id := request.PathValue("id")
	switch request.PathValue("action") {
	case "decline":
		if err := s.modules.Collaboration.DeclineInvite(request.Context(), id, user.ID); err != nil {
			writeCollaborationError(writer, err)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	case "accept":
		if s.modules.SharedProjects == nil {
			writeError(writer, http.StatusServiceUnavailable, "shared_project_platform_unavailable")
			return
		}
		member, err := s.modules.Collaboration.BeginInviteAcceptance(request.Context(), id, user.ID)
		if err != nil {
			writeCollaborationError(writer, err)
			return
		}
		if err := s.modules.SharedProjects.GrantProjectMember(request.Context(), member.ProjectID, member.SID); err != nil {
			_ = s.modules.Collaboration.AbortInviteAcceptance(request.Context(), id, user.ID)
			_ = s.modules.SharedProjects.GrantProjectMember(request.Context(), member.ProjectID, member.SID)
			writeError(writer, http.StatusServiceUnavailable, "shared_project_acl_failed")
			return
		}
		project, err := s.modules.Collaboration.CompleteInviteAcceptance(request.Context(), id, user.ID)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "shared_invite_failed")
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"project": projectDTO(project)})
	default:
		writeError(writer, http.StatusNotFound, "shared_invite_action_not_found")
	}
}

func (s *Server) sharedProjectMember(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil || s.modules.SharedProjects == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	targetUserID, err := strconv.ParseInt(request.PathValue("userID"), 10, 64)
	if err != nil || targetUserID <= 0 {
		writeError(writer, http.StatusBadRequest, "invalid_shared_member")
		return
	}
	member, err := s.modules.Collaboration.BeginMemberRemoval(request.Context(), request.PathValue("id"), user.ID, targetUserID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	if err := s.modules.SharedProjects.RevokeProjectMember(request.Context(), member.ProjectID, member.SID); err != nil {
		_ = s.modules.Collaboration.AbortMemberRemoval(request.Context(), member.ProjectID, user.ID, targetUserID)
		_ = s.modules.SharedProjects.RevokeProjectMember(request.Context(), member.ProjectID, member.SID)
		writeError(writer, http.StatusServiceUnavailable, "shared_project_acl_failed")
		return
	}
	if err := s.modules.Collaboration.CompleteMemberRemoval(request.Context(), member.ProjectID, user.ID, targetUserID); err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_member_failed")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) sharedProjectOwnership(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil || s.modules.SharedProjects == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	var input struct {
		TargetUsername string `json:"targetUsername"`
	}
	if !decodeJSON(request, &input, 8*1024) {
		writeError(writer, http.StatusBadRequest, "invalid_ownership_transfer")
		return
	}
	target, err := s.store.UserByUsername(request.Context(), input.TargetUsername)
	if err != nil || target.Disabled {
		writeError(writer, http.StatusNotFound, "transfer_target_not_found")
		return
	}
	members, err := s.modules.Collaboration.Members(request.Context(), request.PathValue("id"), user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	memberSIDs := make([]string, 0, len(members))
	for _, member := range members {
		memberSIDs = append(memberSIDs, member.SID)
	}
	transferID, err := auth.RandomToken(18)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "ownership_transfer_failed")
		return
	}
	transfer, err := s.modules.Collaboration.BeginOwnershipTransfer(request.Context(), collaboration.OwnershipTransfer{ID: transferID, ProjectID: request.PathValue("id"), ToUserID: target.ID, ToSID: target.SID}, user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	if err := s.modules.SharedProjects.TransferProjectOwnership(request.Context(), transfer.ProjectID, user.SID, target.SID, memberSIDs); err != nil {
		_ = s.modules.Collaboration.AbortOwnershipTransfer(request.Context(), transfer.ID)
		writeError(writer, http.StatusServiceUnavailable, "shared_project_acl_failed")
		return
	}
	project, err := s.modules.Collaboration.CompleteOwnershipTransfer(request.Context(), transfer.ID)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "ownership_transfer_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"project": projectDTO(project)})
}

func decodeJSON(request *http.Request, value any, limit int64) bool {
	decoder := json.NewDecoder(io.LimitReader(request.Body, limit))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value) == nil && decoder.Decode(&struct{}{}) == io.EOF
}

func projectDTO(project collaboration.Project) sharedProjectDTO {
	return sharedProjectDTO{ID: project.ID, OwnerUserID: project.OwnerUserID, Name: project.Name, State: project.State, CurrentRole: project.CurrentRole, Hidden: project.Hidden, PendingOwnerID: project.PendingOwnerID, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt}
}

func inviteDTO(invite collaboration.Invite, inviterName string) sharedInviteDTO {
	return sharedInviteDTO{ID: invite.ID, ProjectID: invite.ProjectID, ProjectName: invite.ProjectName, InviterName: inviterName, InviterUserID: invite.InviterUserID, TargetUserID: invite.TargetUserID, Status: invite.Status, ExpiresAt: invite.ExpiresAt, CreatedAt: invite.CreatedAt, ActedAt: invite.ActedAt}
}

func writeCollaborationError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, collaboration.ErrNotFound):
		writeError(writer, http.StatusNotFound, "shared_project_not_found")
	case errors.Is(err, collaboration.ErrForbidden):
		writeError(writer, http.StatusForbidden, "shared_project_forbidden")
	case errors.Is(err, collaboration.ErrInviteExpired):
		writeError(writer, http.StatusGone, "shared_invite_expired")
	case errors.Is(err, collaboration.ErrConflict), errors.Is(err, collaboration.ErrTransferPending):
		writeError(writer, http.StatusConflict, "shared_project_conflict")
	default:
		writeError(writer, http.StatusInternalServerError, "collaboration_failed")
	}
}
