//go:build windows

package employee

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"workagent3/internal/credentialbroker"
	"workagent3/internal/employeesecrets"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

type brokerRecovery struct {
	ID     string
	Secret []byte
}

func (p *WindowsPlatform) InspectWindowsCredentialMigration(ctx context.Context, user store.User, pid uint32) (int, error) {
	if _, err := p.vault(); err != nil {
		return 0, err
	}
	token, err := winutil.ProcessUserToken(pid, user.SID)
	if err != nil {
		return 0, err
	}
	defer token.Close()
	if err := inspectExternalSecrets(token, filepath.Join(p.config.DataRootBase, user.SID)); err != nil {
		return 0, err
	}
	data, err := readBrokerRecovery(ctx, filepath.Join(p.config.DataRootBase, user.SID, "runtime", "credential-broker.db"), token)
	if err != nil {
		return 0, err
	}
	defer clear(data)
	var records []brokerRecovery
	if err := json.Unmarshal(data, &records); err != nil {
		return 0, err
	}
	for _, r := range records {
		clear(r.Secret)
	}
	return len(records), nil
}

// Restore a lost vault record after restoring the original Windows SID/profile.
// A live record is never overwritten by this operation.
func (p *WindowsPlatform) RestoreWindowsCredential(user store.User, pass []byte, path string) error {
	vault, err := p.vault()
	if err != nil {
		return err
	}
	record, err := vault.Read(user.SID)
	record.Clear()
	if !errors.Is(err, employeesecrets.ErrMissing) {
		return errors.New("restore requires a missing managed credential record")
	}
	sid, _, err := winutil.LookupAccount(`.\` + localWindowsUsername(user))
	if err != nil {
		return err
	}
	if sid != user.SID {
		return errors.New("restore requires the original Windows SID")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return vault.Import(user.SID, pass, data)
}

func (p *WindowsPlatform) BackupWindowsCredential(user store.User, pass []byte, path string) error {
	vault, err := p.vault()
	if err != nil {
		return err
	}
	data, err := vault.Export(user.SID, pass)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(path) {
		return errors.New("recovery backup path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := winutil.ProtectServiceFile(path); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	return file.Sync()
}

func readBrokerRecovery(ctx context.Context, path string, token windows.Token) ([]byte, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return json.Marshal([]brokerRecovery{})
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, "SELECT id,sealed_value FROM credentials WHERE length(sealed_value)>0 ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []brokerRecovery{}
	defer func() {
		for _, r := range records {
			clear(r.Secret)
		}
	}()
	for rows.Next() {
		var id string
		var sealed []byte
		if err := rows.Scan(&id, &sealed); err != nil {
			return nil, err
		}
		var plain []byte
		err := winutil.WithUserToken(token, func() error { var err error; plain, err = credentialbroker.NewUserProtector().Open(sealed); return err })
		if err != nil {
			return nil, fmt.Errorf("credential migration preflight cannot decrypt broker record: %w", err)
		}
		records = append(records, brokerRecovery{id, plain})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return json.Marshal(records)
}

func restoreBrokerRecovery(ctx context.Context, path string, token windows.Token, backup []byte) error {
	var records []brokerRecovery
	if err := json.Unmarshal(backup, &records); err != nil {
		return err
	}
	defer func() {
		for _, r := range records {
			clear(r.Secret)
		}
	}()
	if len(records) == 0 {
		return nil
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, r := range records {
		var sealed []byte
		err := winutil.WithUserToken(token, func() error {
			var err error
			sealed, err = credentialbroker.NewUserProtector().Seal(r.Secret)
			return err
		})
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, "UPDATE credentials SET sealed_value=? WHERE id=?", sealed, r.ID)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return errors.New("broker record disappeared during migration")
		}
	}
	return tx.Commit()
}

// Unknown user-scope secrets cannot safely be recovered by resetting a password.
// Block before mutation when Windows Credential Manager, browser login stores,
// private key files, or EFS files need a separate migration procedure.
func inspectExternalSecrets(token windows.Token, dataRoot string) error {
	profile, err := token.GetUserProfileDirectory()
	if err != nil {
		return err
	}
	for _, relative := range []string{`AppData\Local\Microsoft\Credentials`, `AppData\Roaming\Microsoft\Credentials`, `AppData\Local\Microsoft\Vault`, `AppData\Roaming\Microsoft\Crypto\RSA`, `AppData\Roaming\Microsoft\Crypto\Keys`, `AppData\Local\Google\Chrome\User Data`, `AppData\Local\Microsoft\Edge\User Data`} {
		path := filepath.Join(profile, relative)
		found := false
		err := filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if !d.IsDir() {
				found = true
			}
			return nil
		})
		if err != nil {
			return err
		}
		if found {
			return fmt.Errorf("external encrypted credential material requires migration before password reset: %s", relative)
		}
	}
	for _, root := range []string{profile, dataRoot} {
		if err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			attr, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(path))
			if err != nil {
				return err
			}
			if attr&windows.FILE_ATTRIBUTE_ENCRYPTED != 0 {
				return errors.New("EFS-encrypted files require recovery before password reset")
			}
			// Complete Harness package projections and their rollback copies are
			// rebuildable release code, not employee credential/data stores.
			if strings.EqualFold(filepath.Clean(path), filepath.Join(dataRoot, "dsh-home", "profiles")) {
				return filepath.SkipDir
			}
			if attr&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

type profileInfo struct {
	Size, Flags                                                uint32
	Username, ProfilePath, DefaultPath, ServerName, PolicyPath *uint16
	Profile                                                    windows.Handle
}

func loadMaintenanceProfile(token windows.Token, username string) (func(), error) {
	info := profileInfo{Flags: 1, Username: windows.StringToUTF16Ptr(username)}
	info.Size = uint32(unsafe.Sizeof(info))
	dll := windows.NewLazySystemDLL("userenv.dll")
	ok, _, err := dll.NewProc("LoadUserProfileW").Call(uintptr(token), uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return nil, fmt.Errorf("load employee profile: %w", err)
	}
	return func() { dll.NewProc("UnloadUserProfile").Call(uintptr(token), uintptr(info.Profile)) }, nil
}

// MaintainWindowsCredential is an offline SYSTEM-only operation. Callers pause
// ingress and the manager first. A repeated call resumes the durable journal;
// changing a password can never be rolled back by restoring release directories.
func (p *WindowsPlatform) MaintainWindowsCredential(ctx context.Context, user store.User, sourcePID uint32, adopt bool) error {
	return p.maintainWindowsCredential(ctx, user, sourcePID, adopt, func() error { return nil })
}

func (p *WindowsPlatform) maintainWindowsCredential(ctx context.Context, user store.User, sourcePID uint32, adopt bool, afterPasswordChange func() error) error {
	lock, err := winutil.AcquireInstanceLock("WorkAgent3-maintenance-" + user.SID)
	if err != nil {
		return err
	}
	defer lock.Close()
	vault, err := p.vault()
	if err != nil {
		return err
	}
	saved, err := vault.Read(user.SID)
	if errors.Is(err, employeesecrets.ErrMissing) && adopt {
		saved = employeesecrets.Record{Username: user.WindowsUsername, SID: user.SID}
		err = nil
	}
	if err != nil {
		return err
	}
	defer saved.Clear()
	name := localWindowsUsername(user)
	brokerPath := filepath.Join(p.config.DataRootBase, user.SID, "runtime", "credential-broker.db")
	if saved.Phase == "" {
		if adopt && len(saved.Password) > 0 {
			return errors.New("credential already managed; use explicit rotation")
		}
		var token windows.Token
		if adopt {
			token, err = winutil.ProcessUserToken(sourcePID, user.SID)
		} else {
			token, err = winutil.LogonManagedUser(name, saved.Password)
		}
		if err != nil {
			return err
		}
		if adopt {
			err = inspectExternalSecrets(token, filepath.Join(p.config.DataRootBase, user.SID))
		}
		// Keep the old profile loaded while stopping writers. The broker snapshot
		// must be taken after the runtime stops, including scheduled/background work.
		var unload func()
		if err == nil {
			unload, err = loadMaintenanceProfile(token, name)
		}
		if err == nil {
			err = p.StopInstalledRuntime(ctx, user.SID)
		}
		if err == nil {
			saved.BrokerBackup, err = readBrokerRecovery(ctx, brokerPath, token)
		}
		if unload != nil {
			unload()
		}
		token.Close()
		if err != nil {
			return err
		}
		saved.Pending, err = (RandomSecrets{}).WindowsPassword()
		if err != nil {
			return err
		}
		saved.Phase = "prepared"
		if err := vault.Write(user.SID, saved); err != nil {
			return err
		}
	}
	if err := p.StopInstalledRuntime(ctx, user.SID); err != nil {
		return err
	}
	// Recheck Windows after a crash between changing the password and saving the
	// next phase. A successful logon proves the pending credential is already live.
	token, logonErr := winutil.LogonManagedUser(name, saved.Pending)
	if logonErr != nil {
		if len(saved.Password) == 0 {
			err = winutil.ResetManagedPassword(name, user.SID, saved.Pending)
		} else {
			err = winutil.ChangeManagedPassword(name, saved.Password, saved.Pending)
		}
		if err != nil {
			return err
		}
		token, err = winutil.LogonManagedUser(name, saved.Pending)
		if err != nil {
			return err
		}
	}
	defer token.Close()
	if err := afterPasswordChange(); err != nil {
		return err
	}
	saved.Phase = "password-changed"
	if err := vault.Write(user.SID, saved); err != nil {
		return err
	}
	unload, err := loadMaintenanceProfile(token, name)
	if err != nil {
		return err
	}
	defer unload()
	if err := restoreBrokerRecovery(ctx, brokerPath, token, saved.BrokerBackup); err != nil {
		return err
	}
	// Verify all broker values with the new logon before marking recovery complete.
	verified, err := readBrokerRecovery(ctx, brokerPath, token)
	clear(verified)
	if err != nil {
		return err
	}
	configPath := filepath.Join(p.config.DataRootBase, user.SID, "runtime", "userhost.json")
	if err := p.registerLauncher(ctx, user.SID, user.WindowsUsername, configPath, saved.Pending); err != nil {
		return err
	}
	saved.Password = append(saved.Password[:0], saved.Pending...)
	clear(saved.Pending)
	saved.Pending = nil
	saved.Phase = ""
	// Keep the encrypted broker recovery snapshot for disaster recovery.
	return vault.Write(user.SID, saved)
}
