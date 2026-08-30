package credentialbroker

import "errors"

var ErrUserProtectionUnavailable = errors.New("current-user credential protection is unavailable on this platform")
