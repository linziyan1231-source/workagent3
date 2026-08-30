package credentialbroker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testProtector struct{}

func (testProtector) Seal(value []byte) ([]byte, error) {
	result := append([]byte("sealed:"), value...)
	for index := len("sealed:"); index < len(result); index++ {
		result[index] ^= 0xff
	}
	return result, nil
}

func (testProtector) Open(value []byte) ([]byte, error) {
	if !bytes.HasPrefix(value, []byte("sealed:")) {
		return nil, errors.New("invalid sealed value")
	}
	result := append([]byte(nil), value[len("sealed:"):]...)
	for index := range result {
		result[index] ^= 0xff
	}
	return result, nil
}

func TestStoreSealsSecretsAndExposesOnlyMetadata(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "credentials.db")
	store, err := Open(databasePath, testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.now = func() time.Time { return time.Date(2026, 8, 31, 8, 30, 0, 0, time.UTC) }
	secret := []byte("uniquely-private-token")
	metadata, err := store.Put(context.Background(), Input{
		ID: "oauth-1", Kind: KindMCPOAuth, Label: "Design MCP", Secret: secret, State: StateReady,
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.ID != "oauth-1" || metadata.Kind != KindMCPOAuth || metadata.State != StateReady {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
	if string(secret) != "uniquely-private-token" {
		t.Fatal("Put mutated caller-owned secret")
	}
	serialized, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(serialized, secret) || bytes.Contains(serialized, []byte("sealed_value")) {
		t.Fatalf("metadata leaked secret material: %s", serialized)
	}
	resolved, err := store.Resolve(context.Background(), "oauth-1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(resolved, secret) {
		t.Fatalf("resolved %q, want %q", resolved, secret)
	}
	resolved[0] = 'X'
	again, err := store.Resolve(context.Background(), "oauth-1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(again, secret) {
		t.Fatal("Resolve did not return independent plaintext")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	databaseBytes, err := os.ReadFile(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(databaseBytes, secret) {
		t.Fatal("SQLite file contains plaintext credential")
	}
}

func TestExpiredAndRevokedCredentialsCannotResolve(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "credentials.db"), testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 31, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	expiresAt := now.Add(-time.Minute)
	_, err = store.Put(context.Background(), Input{
		ID: "expired", Kind: KindProvider, Label: "Expired", Secret: []byte("secret"), State: StateReady, ExpiresAt: &expiresAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := store.Metadata(context.Background(), "expired")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.State != StateExpired {
		t.Fatalf("state = %q, want expired", metadata.State)
	}
	if _, err := store.Resolve(context.Background(), "expired"); !errors.Is(err, ErrCredentialExpired) {
		t.Fatalf("Resolve error = %v, want ErrCredentialExpired", err)
	}
	_, err = store.Put(context.Background(), Input{
		ID: "revoke", Kind: KindMCPHeader, Label: "Header", Secret: []byte("secret"), State: StateReady,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Revoke(context.Background(), "revoke"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(context.Background(), "revoke"); !errors.Is(err, ErrCredentialExpired) {
		t.Fatalf("Resolve revoked error = %v, want ErrCredentialExpired", err)
	}
}

func TestStoreRejectsInvalidCredential(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "credentials.db"), testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, err = store.Put(context.Background(), Input{ID: "missing", Kind: KindProvider, Label: "Missing", State: StateReady})
	if err == nil {
		t.Fatal("Put accepted an empty credential")
	}
}

func TestOAuthTokenStoresRefreshMaterialButProjectsOnlyBearer(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "credentials.db")
	store, err := Open(databasePath, testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().Add(time.Hour)
	_, err = store.PutOAuth(context.Background(), "oauth", "Remote MCP", OAuthToken{
		AccessToken: "access-private", RefreshToken: "refresh-private", TokenType: "Bearer", ExpiresAt: &expiresAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	projected, err := store.ResolveMCPValue(context.Background(), "oauth")
	if err != nil || string(projected) != "Bearer access-private" || bytes.Contains(projected, []byte("refresh-private")) {
		t.Fatalf("unexpected MCP projection %q: %v", projected, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := os.ReadFile(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(database, []byte("access-private")) || bytes.Contains(database, []byte("refresh-private")) {
		t.Fatal("SQLite contains OAuth plaintext")
	}
}
