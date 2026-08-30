package winutil

import "errors"

func ValidateLocalUsername(username string) error {
	if len(username) < 1 || len(username) > 20 {
		return errors.New("Windows username must be between 1 and 20 ASCII characters")
	}
	for index, character := range username {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') ||
			(index > 0 && (character == '.' || character == '_' || character == '-')) {
			continue
		}
		return errors.New("invalid Windows local username")
	}
	return nil
}
