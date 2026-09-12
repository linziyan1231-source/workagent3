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

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

type CollaborationPort interface {
	QuotaRunIdentity(context.Context,string) (contracts.SharedRunIdentity,error)
	PersonalTaskStore
	ChannelHead(context.Context) (int64, error)
	ChannelHistory(context.Context, string, int64, int64, int64, int) ([]collaboration.Message, int64, error)
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
	CreateInviteLink(context.Context, collaboration.InviteLink) (collaboration.InviteLink, error)
	RevokeInviteLink(context.Context, string, string, int64) error
	BeginInviteLinkAcceptance(context.Context, string, int64, string) (collaboration.Member, error)
	CompleteInviteLinkAcceptance(context.Context, string, int64) (collaboration.Project, error)
	AbortInviteLinkAcceptance(context.Context, string, int64) error
	BeginMemberRemoval(context.Context, string, int64, int64) (collaboration.Member, error)
	CompleteMemberRemoval(context.Context, string, int64, int64) error
	AbortMemberRemoval(context.Context, string, int64, int64) error
	BeginOwnershipTransfer(context.Context, collaboration.OwnershipTransfer, int64) (collaboration.OwnershipTransfer, error)
	CompleteOwnershipTransfer(context.Context, string) (collaboration.Project, error)
	AbortOwnershipTransfer(context.Context, string) error
	FinalizeOwnershipTransfer(context.Context, string) error
	FinalizingOwnershipTransfers(context.Context) ([]collaboration.OwnershipTransfer, error)
	CreateConversation(context.Context, collaboration.Conversation, int64) (collaboration.Conversation, error)
	ConversationForUser(context.Context, string, int64, bool) (collaboration.Conversation, error)
	ListConversations(context.Context, int64, bool) ([]collaboration.Conversation, error)
	SetConversationHidden(context.Context, string, int64, bool) (collaboration.Conversation, error)
	UpdateConversationMetadata(context.Context, string, int64, *string, *bool, *bool) (collaboration.Conversation, error)
	DeleteConversation(context.Context, string, int64) error
	UpdateConversationRuntime(context.Context, string, int64, string, string) (collaboration.Conversation, error)
	AddMessage(context.Context, collaboration.Message, int64) (collaboration.Message, error)
	ListMessages(context.Context, string, int64, int64, int) ([]collaboration.Message, error)
	ListMessagesForUserAfter(context.Context, int64, int64, int) ([]collaboration.Message, error)
	ReserveAIRun(context.Context, string, collaboration.Message, int64) (collaboration.AIRun, error)
	AssistantMembers(context.Context, string, int64) ([]collaboration.AssistantMember, error)
	InviteAssistant(context.Context, collaboration.AssistantMember, int64) (collaboration.AssistantMember, error)
	UpdateAssistantSettings(context.Context, string, string, int64, string, string) (collaboration.AssistantMember, error)
	RemoveAssistant(context.Context, string, string, int64) error
	ReserveAssistantRun(context.Context, string, collaboration.Message, int64, string) (collaboration.AIRun, error)
	SharedMessagesRange(context.Context, string, int64, int64) ([]collaboration.Message, error)
	StopAssistantRun(context.Context, string, string, int64, string) (collaboration.AIRun, collaboration.Message, error)
	UserMessagesRange(context.Context, string, int64, int64) ([]collaboration.Message, error)
	FinishAIRun(context.Context, collaboration.AIRun, string, string, string, error) (collaboration.Message, error)
	StopAIRun(context.Context, string, int64, string) (collaboration.AIRun, collaboration.Message, error)
	ProjectForUser(context.Context, string, int64, bool) (collaboration.Project, error)
	DefaultConversation(context.Context, string, int64) (collaboration.Conversation, error)
	MessageByID(context.Context, string, string, int64) (collaboration.Message, error)
	ProjectInvites(context.Context, string, int64) ([]collaboration.Invite, error)
	RevokeInvite(context.Context, string, int64) error
	BindAssistant(context.Context, string, int64, string, string, string, string) (collaboration.Conversation, error)
}

// SharedProjectPlatformPort is implemented by the privileged Employee Manager
// adapter. Portal coordinates the business transaction but never edits ACLs.
type SharedProjectPlatformPort interface {
	ProvisionProject(context.Context, string, string) error
	GrantProjectMember(context.Context, string, string) error
	RevokeProjectMember(context.Context, string, string) error
	TransferProjectOwnership(context.Context, string, string, string, []string) error
	FinalizeProjectOwnership(context.Context, string, string, bool) error
}

type SharedFileRequest struct {
	ProjectID string `json:"project_id"`
	Operation string `json:"operation"`
	Path      string `json:"path,omitempty"`
	Data      string `json:"data,omitempty"`
	NewName   string `json:"new_name,omitempty"`
}

// SharedFilePlatformPort routes an already-authorized request to the project
// owner's Runtime. Portal never resolves or opens a shared filesystem path.
type SharedFilePlatformPort interface {
	Operate(context.Context, string, SharedFileRequest) (json.RawMessage, error)
	// OperateOfficePreview converts a shared Office document on the owner's
	// Runtime and returns the cached PDF rendering.
	OperateOfficePreview(context.Context, string, SharedFileRequest) (OfficePreviewData, error)
}

// OfficePreviewData carries a converted Office document back from the owner's
// Runtime through the shared-files envelope.
type OfficePreviewData struct {
	Name string
	PDF  []byte
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
	UserID      int64     `json:"userId"`
	DisplayName string    `json:"displayName"`
	Username    string    `json:"username"`
	Role        string    `json:"role"`
	JoinedAt    time.Time `json:"joinedAt"`
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

type sharedInviteLinkDTO struct {
	Token     string    `json:"token"`
	ProjectID string    `json:"projectId"`
	SingleUse bool      `json:"singleUse"`
	UseCount  int       `json:"useCount"`
	Status    string    `json:"status"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
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
		Name        string `json:"name"`
		OperationID string `json:"operation_id"`
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
	sharedCreationMu.Lock()
	defer sharedCreationMu.Unlock()
	if input.OperationID != "" {
		if !sharedOperationPattern.MatchString(input.OperationID) {
			writeError(writer, http.StatusBadRequest, "invalid_operation_id")
			return
		}
		id = "project_" + strconv.FormatInt(user.ID, 10) + "_" + input.OperationID
		if existing, lookupErr := s.modules.Collaboration.ProjectForUser(request.Context(), id, user.ID, true); lookupErr == nil {
			if existing.Name != strings.TrimSpace(input.Name) {
				writeError(writer, http.StatusConflict, "shared_operation_conflict")
				return
			}
			if existing.State == "active" {
				s.writeCreatedSharedProject(writer, request, user, existing)
				return
			}
			if existing.State != "provisioning" {
				writeError(writer, http.StatusConflict, "shared_project_busy")
				return
			}
			if err := s.modules.SharedProjects.ProvisionProject(request.Context(), id, user.SID); err != nil {
				writeError(writer, http.StatusServiceUnavailable, "shared_project_provision_failed")
				return
			}
			if err := s.modules.Collaboration.SetProvisioningResult(request.Context(), id, true); err != nil {
				writeCollaborationError(writer, err)
				return
			}
			existing.State = "active"
			s.writeCreatedSharedProject(writer, request, user, existing)
			return
		} else if !errors.Is(lookupErr, collaboration.ErrNotFound) {
			writeCollaborationError(writer, lookupErr)
			return
		}
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
			s.writeCreatedSharedProject(writer, request, user, active)
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
		account, err := s.store.UserByID(request.Context(), member.UserID)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "shared_members_failed")
			return
		}
		values = append(values, sharedMemberDTO{UserID: member.UserID, DisplayName: account.DisplayName, Username: account.Username, Role: member.Role, JoinedAt: member.JoinedAt})
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
	if !decodeJSON(request, &input, 8*1024) || strings.TrimSpace(input.TargetUsername) == "" || input.ExpiresInHours < 0 || input.ExpiresInHours > 24*30 {
		writeError(writer, http.StatusBadRequest, "invalid_shared_invite")
		return
	}
	if input.ExpiresInHours == 0 {
		input.ExpiresInHours = 72
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
	s.createSharedInvite(writer, request, user, target, request.PathValue("id"), input.ExpiresInHours)
}

func (s *Server) createSharedInvite(writer http.ResponseWriter, request *http.Request, user, target store.User, projectID string, expiresInHours int) {
	sharedCreationMu.Lock()
	defer sharedCreationMu.Unlock()
	if target.Disabled || target.Offboarded || target.Admin || target.ID == user.ID {
		writeError(writer, http.StatusNotFound, "invite_target_not_found")
		return
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_invite_failed")
		return
	}
	invite, err := s.modules.Collaboration.CreateInvite(request.Context(), collaboration.Invite{ID: id, ProjectID: projectID, InviterUserID: user.ID, TargetUserID: target.ID, TargetSID: target.SID, ExpiresAt: s.now().Add(time.Duration(expiresInHours) * time.Hour)})
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	s.publishNotification(request.Context(), contracts.NotificationInput{TargetSID: target.SID, Kind: "shared_invite", Title: "共享项目邀请", Message: user.DisplayName + " 邀请你加入 " + invite.ProjectName, DeepLink: "/?workagent=shared&invite=" + invite.ID, ExpiresAt: &invite.ExpiresAt})
	writeJSON(writer, http.StatusCreated, map[string]any{"invite": inviteDTO(invite, user.DisplayName)})
}

func (s *Server) sharedInviteByUserID(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	var input struct {
		ProjectID    string `json:"project_id"`
		TargetUserID int64  `json:"target_user_id"`
	}
	if !decodeJSON(request, &input, 8*1024) || input.TargetUserID <= 0 {
		writeError(writer, http.StatusBadRequest, "invalid_shared_invite")
		return
	}
	target, err := s.store.UserByID(request.Context(), input.TargetUserID)
	if err != nil {
		writeError(writer, http.StatusNotFound, "invite_target_not_found")
		return
	}
	s.createSharedInvite(writer, request, user, target, input.ProjectID, 72)
}

func (s *Server) sharedUsers(writer http.ResponseWriter, request *http.Request, user store.User) {
	query := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("q")))
	if query == "" || len(query) > 64 {
		writeJSON(writer, http.StatusOK, map[string]any{"users": []any{}})
		return
	}
	users, err := s.store.ListManagedUsers(request.Context())
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_user_search_failed")
		return
	}
	values := make([]map[string]any, 0, 20)
	for _, candidate := range users {
		if candidate.ID == user.ID || candidate.Disabled || candidate.Offboarded {
			continue
		}
		if !strings.Contains(strings.ToLower(candidate.Username), query) && !strings.Contains(strings.ToLower(candidate.DisplayName), query) {
			continue
		}
		values = append(values, map[string]any{"id": candidate.ID, "username": candidate.Username, "display_name": candidate.DisplayName})
		if len(values) == 20 {
			break
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"users": values})
}

func (s *Server) sharedMembers(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	members, err := s.modules.Collaboration.Members(request.Context(), request.URL.Query().Get("project_id"), user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	values := make([]map[string]any, 0, len(members))
	for _, member := range members {
		account, err := s.store.UserByID(request.Context(), member.UserID)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "shared_member_failed")
			return
		}
		values = append(values, map[string]any{"id": account.ID, "username": account.Username, "display_name": account.DisplayName, "role": member.Role})
	}
	writeJSON(writer, http.StatusOK, map[string]any{"members": values})
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
			s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationACLGrant, member.ProjectID, err, map[string]string{"member_sid": member.SID})
			writeError(writer, http.StatusServiceUnavailable, "shared_project_acl_failed")
			return
		}
		project, err := s.modules.Collaboration.CompleteInviteAcceptance(request.Context(), id, user.ID)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "shared_invite_failed")
			return
		}
		s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationACLGrant, member.ProjectID, nil, map[string]string{"member_sid": member.SID})
		if owner, lookupErr := s.store.UserByID(request.Context(), project.OwnerUserID); lookupErr == nil {
			s.publishNotification(request.Context(), contracts.NotificationInput{TargetSID: owner.SID, Kind: "shared_member", Title: "Project member joined", Message: user.DisplayName + " joined " + project.Name, DeepLink: "/"})
		}
		writeJSON(writer, http.StatusOK, map[string]any{"project": projectDTO(project)})
	default:
		writeError(writer, http.StatusNotFound, "shared_invite_action_not_found")
	}
}

func (s *Server) sharedProjectInviteLinkCreate(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	var input struct {
		ExpiresInHours int  `json:"expiresInHours"`
		SingleUse      bool `json:"singleUse"`
	}
	if !decodeJSON(request, &input, 8*1024) {
		writeError(writer, http.StatusBadRequest, "invalid_shared_invite_link")
		return
	}
	if input.ExpiresInHours == 0 {
		input.ExpiresInHours = 72
	}
	if input.ExpiresInHours < 1 || input.ExpiresInHours > 24*30 {
		writeError(writer, http.StatusBadRequest, "invalid_shared_invite_link")
		return
	}
	token, err := auth.RandomToken(24)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_invite_link_failed")
		return
	}
	maxUses := 0
	if input.SingleUse {
		maxUses = 1
	}
	link, err := s.modules.Collaboration.CreateInviteLink(request.Context(), collaboration.InviteLink{Token: token, ProjectID: request.PathValue("id"), CreatorUserID: user.ID, MaxUses: maxUses, ExpiresAt: s.now().Add(time.Duration(input.ExpiresInHours) * time.Hour)})
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationInviteLinkCreate, link.ProjectID, nil, map[string]string{"single_use": strconv.FormatBool(input.SingleUse)})
	writeJSON(writer, http.StatusCreated, map[string]any{"link": inviteLinkDTO(link)})
}

func (s *Server) sharedProjectInviteLinkRevoke(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	projectID := request.PathValue("id")
	if err := s.modules.Collaboration.RevokeInviteLink(request.Context(), request.PathValue("token"), projectID, user.ID); err != nil {
		writeCollaborationError(writer, err)
		return
	}
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationInviteLinkRevoke, projectID, nil, nil)
	writer.WriteHeader(http.StatusNoContent)
}

// sharedInviteLinkAccept turns a bearer token into membership with the same
// begin → ACL grant → complete compensation shape as targeted invites.
func (s *Server) sharedInviteLinkAccept(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil || s.modules.SharedProjects == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if !decodeJSON(request, &input, 8*1024) || strings.TrimSpace(input.Token) == "" {
		writeError(writer, http.StatusNotFound, "shared_invite_link_not_found")
		return
	}
	member, err := s.modules.Collaboration.BeginInviteLinkAcceptance(request.Context(), input.Token, user.ID, user.SID)
	if errors.Is(err, collaboration.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "shared_invite_link_not_found")
		return
	}
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	if err := s.modules.SharedProjects.GrantProjectMember(request.Context(), member.ProjectID, member.SID); err != nil {
		_ = s.modules.Collaboration.AbortInviteLinkAcceptance(request.Context(), input.Token, user.ID)
		_ = s.modules.SharedProjects.GrantProjectMember(request.Context(), member.ProjectID, member.SID)
		s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationACLGrant, member.ProjectID, err, map[string]string{"member_sid": member.SID})
		writeError(writer, http.StatusServiceUnavailable, "shared_project_acl_failed")
		return
	}
	project, err := s.modules.Collaboration.CompleteInviteLinkAcceptance(request.Context(), input.Token, user.ID)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_invite_link_failed")
		return
	}
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationACLGrant, member.ProjectID, nil, map[string]string{"member_sid": member.SID})
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationInviteLinkAccept, member.ProjectID, nil, nil)
	if owner, lookupErr := s.store.UserByID(request.Context(), project.OwnerUserID); lookupErr == nil {
		s.publishNotification(request.Context(), contracts.NotificationInput{TargetSID: owner.SID, Kind: "shared_member", Title: "Project member joined", Message: user.DisplayName + " joined " + project.Name, DeepLink: "/"})
	}
	writeJSON(writer, http.StatusOK, map[string]any{"project": projectDTO(project)})
}

func (s *Server) sharedProjectMember(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil || s.modules.SharedProjects == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	targetUserID := user.ID
	var err error
	if request.PathValue("userID") != "me" {
		targetUserID, err = strconv.ParseInt(request.PathValue("userID"), 10, 64)
		if err != nil || targetUserID <= 0 {
			writeError(writer, http.StatusBadRequest, "invalid_shared_member")
			return
		}
	}
	member, err := s.modules.Collaboration.BeginMemberRemoval(request.Context(), request.PathValue("id"), user.ID, targetUserID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	if err := s.modules.SharedProjects.RevokeProjectMember(request.Context(), member.ProjectID, member.SID); err != nil {
		_ = s.modules.Collaboration.AbortMemberRemoval(request.Context(), member.ProjectID, user.ID, targetUserID)
		_ = s.modules.SharedProjects.RevokeProjectMember(request.Context(), member.ProjectID, member.SID)
		s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationACLRevoke, member.ProjectID, err, map[string]string{"member_sid": member.SID})
		writeError(writer, http.StatusServiceUnavailable, "shared_project_acl_failed")
		return
	}
	if err := s.modules.Collaboration.CompleteMemberRemoval(request.Context(), member.ProjectID, user.ID, targetUserID); err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_member_failed")
		return
	}
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationACLRevoke, member.ProjectID, nil, map[string]string{"member_sid": member.SID})
	s.publishNotification(request.Context(), contracts.NotificationInput{TargetSID: member.SID, Kind: "shared_member", Title: "Shared project access changed", Message: "Your access to a shared project was removed", DeepLink: "/"})
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) sharedProjectOwnership(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil || s.modules.SharedProjects == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	var input struct {
		TargetUsername string `json:"targetUsername"`
		TargetUserID   int64  `json:"targetUserId"`
	}
	if !decodeJSON(request, &input, 8*1024) {
		writeError(writer, http.StatusBadRequest, "invalid_ownership_transfer")
		return
	}
	var target store.User
	var err error
	if input.TargetUserID > 0 {
		target, err = s.store.UserByID(request.Context(), input.TargetUserID)
	} else {
		target, err = s.store.UserByUsername(request.Context(), input.TargetUsername)
	}
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
	// Once the transfer exists, every outcome is audited; the recovery loop
	// (RecoverOwnershipTransfers) records the deferred success if this
	// request cannot reach finalization.
	transferMetadata := map[string]string{"transfer_id": transfer.ID, "to_username": target.Username}
	if err := s.modules.SharedProjects.TransferProjectOwnership(request.Context(), transfer.ProjectID, user.SID, target.SID, memberSIDs); err != nil {
		_ = s.modules.Collaboration.AbortOwnershipTransfer(request.Context(), transfer.ID)
		s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationOwnershipTransfer, transfer.ProjectID, err, transferMetadata)
		writeError(writer, http.StatusServiceUnavailable, "shared_project_acl_failed")
		return
	}
	project, err := s.modules.Collaboration.CompleteOwnershipTransfer(request.Context(), transfer.ID)
	if err != nil {
		_ = s.modules.SharedProjects.FinalizeProjectOwnership(context.Background(), transfer.ProjectID, target.SID, false)
		_ = s.modules.Collaboration.AbortOwnershipTransfer(context.Background(), transfer.ID)
		s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationOwnershipTransfer, transfer.ProjectID, err, transferMetadata)
		writeError(writer, http.StatusInternalServerError, "ownership_transfer_failed")
		return
	}
	if err := s.modules.SharedProjects.FinalizeProjectOwnership(request.Context(), transfer.ProjectID, target.SID, true); err != nil {
		s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationOwnershipTransfer, transfer.ProjectID, err, transferMetadata)
		writeError(writer, http.StatusServiceUnavailable, "ownership_transfer_recovery_pending")
		return
	}
	if err := s.modules.Collaboration.FinalizeOwnershipTransfer(request.Context(), transfer.ID); err != nil {
		s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationOwnershipTransfer, transfer.ProjectID, err, transferMetadata)
		writeError(writer, http.StatusServiceUnavailable, "ownership_transfer_recovery_pending")
		return
	}
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionCollaborationOwnershipTransfer, transfer.ProjectID, nil, transferMetadata)
	s.publishNotification(request.Context(), contracts.NotificationInput{TargetSID: target.SID, Kind: "shared_ownership", Title: "Project ownership transferred", Message: "You are now the owner of " + project.Name, DeepLink: "/"})
	s.publishNotification(request.Context(), contracts.NotificationInput{TargetSID: user.SID, Kind: "shared_ownership", Title: "Project ownership transferred", Message: target.DisplayName + " is now the owner of " + project.Name, DeepLink: "/"})
	writeJSON(writer, http.StatusOK, map[string]any{"project": projectDTO(project)})
}

func (s *Server) publishNotification(ctx context.Context, input contracts.NotificationInput) {
	if s.modules.Notifications != nil {
		_, _ = s.modules.Notifications.Publish(ctx, input)
	}
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

func inviteLinkDTO(link collaboration.InviteLink) sharedInviteLinkDTO {
	return sharedInviteLinkDTO{Token: link.Token, ProjectID: link.ProjectID, SingleUse: link.MaxUses == 1, UseCount: link.UseCount, Status: link.Status, ExpiresAt: link.ExpiresAt, CreatedAt: link.CreatedAt}
}

func writeCollaborationError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, collaboration.ErrNotFound):
		writeError(writer, http.StatusNotFound, "shared_project_not_found")
	case errors.Is(err, collaboration.ErrForbidden):
		writeError(writer, http.StatusForbidden, "shared_project_forbidden")
	case errors.Is(err, collaboration.ErrInviteExpired):
		writeError(writer, http.StatusGone, "shared_invite_expired")
	case errors.Is(err, collaboration.ErrInvitePending):
		writeError(writer, http.StatusConflict, "shared_invite_already_pending")
	case errors.Is(err, collaboration.ErrMemberExists):
		writeError(writer, http.StatusConflict, "shared_member_already_exists")
	case errors.Is(err, collaboration.ErrInviteLinkRevoked):
		writeError(writer, http.StatusGone, "shared_invite_link_revoked")
	case errors.Is(err, collaboration.ErrInviteLinkExhausted):
		writeError(writer, http.StatusGone, "shared_invite_link_exhausted")
	case errors.Is(err, collaboration.ErrAssistantLocked):
		writeError(writer, http.StatusConflict, "shared_assistant_locked")
	case errors.Is(err, collaboration.ErrConflict), errors.Is(err, collaboration.ErrTransferPending):
		writeError(writer, http.StatusConflict, "shared_project_conflict")
	default:
		writeError(writer, http.StatusInternalServerError, "collaboration_failed")
	}
}
