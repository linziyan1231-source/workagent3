//go:build windows

package winutil

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows"
)

func CurrentSID() (string, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return "", fmt.Errorf("open current process token: %w", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("read current token user: %w", err)
	}
	return user.User.Sid.String(), nil
}

func RequireSID(expected string) error {
	actual, err := CurrentSID()
	if err != nil {
		return err
	}
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("current process SID %s does not match configured SID %s", actual, expected)
	}
	return nil
}

func LookupAccount(account string) (sid, canonical string, err error) {
	requested := account
	if strings.HasPrefix(account, `.\`) {
		computer, err := windows.ComputerName()
		if err != nil {
			return "", "", err
		}
		account = computer + account[1:]
	}
	parsed, domain, accountType, err := windows.LookupSID("", account)
	if err != nil {
		return "", "", fmt.Errorf("resolve Windows account %q: %w", requested, err)
	}
	if accountType != windows.SidTypeUser {
		return "", "", fmt.Errorf("Windows account %q is not a user", requested)
	}
	name, resolvedDomain, _, err := parsed.LookupAccount("")
	if err != nil {
		return "", "", err
	}
	if resolvedDomain == "" {
		resolvedDomain = domain
	}
	canonical = name
	if resolvedDomain != "" {
		canonical = resolvedDomain + `\` + name
	}
	return parsed.String(), canonical, nil
}
