//go:build !windows

package credentialbroker

type unavailableProtector struct{}

func NewUserProtector() Protector { return unavailableProtector{} }

func (unavailableProtector) Seal([]byte) ([]byte, error) {
	return nil, ErrUserProtectionUnavailable
}

func (unavailableProtector) Open([]byte) ([]byte, error) {
	return nil, ErrUserProtectionUnavailable
}
