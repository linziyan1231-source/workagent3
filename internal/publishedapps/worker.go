package publishedapps

import (
	"encoding/json"
	"errors"
	"os"
)

// Worker is entered before UserHost configuration or credentials are loaded.
// Only trusted snapshot/broker workers receive config paths; the static worker
// receives a frozen package and loopback address in its AppContainer token.
func Worker(arguments []string) (bool, error) {
	if len(arguments) == 0 {
		return false, nil
	}
	switch arguments[0] {
	case "--published-app-snapshot":
		if len(arguments) != 2 {
			return true, ErrInvalid
		}
		raw, err := os.ReadFile(arguments[1])
		if err != nil {
			return true, err
		}
		var input SnapshotInput
		if json.Unmarshal(raw, &input) != nil {
			return true, ErrInvalid
		}
		return true, RunSnapshot(input)
	case "--published-app-broker":
		if len(arguments) != 2 {
			return true, ErrInvalid
		}
		raw, err := os.ReadFile(arguments[1])
		if err != nil {
			return true, err
		}
		var input BrokerConfig
		if json.Unmarshal(raw, &input) != nil {
			return true, ErrInvalid
		}
		return true, RunBroker(input)
	case "--published-app-static":
		if len(arguments) != 4 {
			return true, ErrInvalid
		}
		return true, RunStatic(arguments[1], arguments[2], arguments[3])
	}
	if len(arguments[0]) > 15 && arguments[0][:15] == "--published-app" {
		return true, errors.New("unknown published application worker")
	}
	return false, nil
}
