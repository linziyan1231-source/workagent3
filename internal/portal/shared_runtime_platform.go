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
	"strings"
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
	actualOwner, oldMembers, err := p.state.ACLState(ctx, projectID)
	if err != nil {
		return err
	}
	if actualOwner != oldOwnerSID {
		return errors.New("shared-project transfer owner changed")
	}
	previousRootMembers, err := p.state.OwnerRootACLState(ctx, newOwnerSID)
	if err != nil {
		return err
	}
	newMembers := withoutSID(memberSIDs, newOwnerSID)
	rootMembers := unionSIDs(previousRootMembers, newMembers)
	return p.apply(ctx, newOwnerSID, projectID, sharedRuntimeRequest{Action: "transfer", OwnerSID: newOwnerSID, OldOwnerSID: oldOwnerSID, MemberSIDs: newMembers, OldMemberSIDs: oldMembers, RootMemberSIDs: rootMembers, PreviousRootMemberSIDs: previousRootMembers})
}

func (p *RuntimeSharedProjectPlatform) FinalizeProjectOwnership(ctx context.Context, projectID, ownerSID string, commit bool) error {
	action := "transfer_rollback"
	if commit {
		action = "transfer_commit"
	}
	return p.apply(ctx, ownerSID, projectID, sharedRuntimeRequest{Action: action, OwnerSID: ownerSID, MemberSIDs: []string{}, RootMemberSIDs: []string{}})
}

type sharedRuntimeRequest struct {
	Action                 string   `json:"action"`
	OwnerSID               string   `json:"ownerSid"`
	OldOwnerSID            string   `json:"oldOwnerSid,omitempty"`
	MemberSIDs             []string `json:"memberSids"`
	RootMemberSIDs         []string `json:"rootMemberSids"`
	OldMemberSIDs          []string `json:"oldMemberSids,omitempty"`
	PreviousRootMemberSIDs []string `json:"previousRootMemberSids,omitempty"`
}

func withoutSID(values []string, excluded string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !strings.EqualFold(value, excluded) {
			result = append(result, value)
		}
	}
	return result
}

func unionSIDs(left, right []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, values := range [][]string{left, right} {
		for _, value := range values {
			key := strings.ToUpper(value)
			if !seen[key] {
				seen[key] = true
				result = append(result, value)
			}
		}
	}
	return result
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
