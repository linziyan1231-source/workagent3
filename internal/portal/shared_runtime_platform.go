package portal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"workagent3/internal/runtimeapi"
)

type sharedACLState interface {
	ACLState(context.Context, string) (string, []string, error)
	OwnerRootACLState(context.Context, string) ([]string, error)
}

// RuntimeSharedProjectPlatform keeps privileged filesystem work inside the
// owner UserHost. Portal sends only an authenticated desired-state projection
// to the loopback Runtime Gateway.
type RuntimeSharedProjectPlatform struct {
	runtimes runtimeapi.EmployeeRuntimeRouter
	state    sharedACLState
	client   *http.Client
}

func NewRuntimeSharedProjectPlatform(runtimes runtimeapi.EmployeeRuntimeRouter, state sharedACLState) (*RuntimeSharedProjectPlatform, error) {
	if runtimes == nil || state == nil {
		return nil, errors.New("runtime router and collaboration ACL state are required")
	}
	return &RuntimeSharedProjectPlatform{runtimes: runtimes, state: state, client: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (p *RuntimeSharedProjectPlatform) ProvisionProject(ctx context.Context, projectID, ownerSID string) error {
	rootMembers, err := p.state.OwnerRootACLState(ctx, ownerSID)
	if err != nil {
		return err
	}
	return p.apply(ctx, ownerSID, projectID, sharedRuntimeRequest{Action: "provision", OwnerSID: ownerSID, MemberSIDs: []string{}, RootMemberSIDs: rootMembers})
}

func (p *RuntimeSharedProjectPlatform) GrantProjectMember(ctx context.Context, projectID, _ string) error {
	return p.reconcile(ctx, projectID)
}

func (p *RuntimeSharedProjectPlatform) RevokeProjectMember(ctx context.Context, projectID, _ string) error {
	return p.reconcile(ctx, projectID)
}

func (p *RuntimeSharedProjectPlatform) reconcile(ctx context.Context, projectID string) error {
	ownerSID, members, err := p.state.ACLState(ctx, projectID)
	if err != nil {
		return err
	}
	rootMembers, err := p.state.OwnerRootACLState(ctx, ownerSID)
	if err != nil {
		return err
	}
	return p.apply(ctx, ownerSID, projectID, sharedRuntimeRequest{Action: "reconcile", OwnerSID: ownerSID, MemberSIDs: members, RootMemberSIDs: rootMembers})
}

func (p *RuntimeSharedProjectPlatform) TransferProjectOwnership(ctx context.Context, projectID, oldOwnerSID, newOwnerSID string, memberSIDs []string) error {
	return p.apply(ctx, newOwnerSID, projectID, sharedRuntimeRequest{Action: "transfer", OwnerSID: newOwnerSID, OldOwnerSID: oldOwnerSID, MemberSIDs: memberSIDs})
}

type sharedRuntimeRequest struct {
	Action         string   `json:"action"`
	OwnerSID       string   `json:"ownerSid"`
	OldOwnerSID    string   `json:"oldOwnerSid,omitempty"`
	MemberSIDs     []string `json:"memberSids"`
	RootMemberSIDs []string `json:"rootMemberSids"`
}

func (p *RuntimeSharedProjectPlatform) apply(ctx context.Context, sid, projectID string, input sharedRuntimeRequest) error {
	endpoint, err := p.runtimes.Resolve(ctx, sid)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/internal/shared-projects/" + url.PathEscape(projectID)})
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, target.String(), bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("call owner Runtime shared-project platform: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	message, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
	return fmt.Errorf("owner Runtime shared-project platform returned %d: %s", response.StatusCode, bytes.TrimSpace(message))
}
