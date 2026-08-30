package employee

import "workagent3/internal/auth"

type RandomSecrets struct{}

func (RandomSecrets) WindowsPassword() ([]byte, error) {
	value, err := auth.RandomToken(32)
	if err != nil {
		return nil, err
	}
	return []byte("Wa3!" + value), nil
}

func (RandomSecrets) RegistrationCredential() (string, error) {
	return auth.RandomToken(32)
}
