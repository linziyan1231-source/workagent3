package imgateway

import (
	"errors"
	"sort"
	"sync"
)

type Registry struct {
	mu         sync.RWMutex
	connectors map[string]ChannelConnector
}

func NewRegistry(connectors ...ChannelConnector) (*Registry, error) {
	registry := &Registry{connectors: make(map[string]ChannelConnector, len(connectors))}
	for _, connector := range connectors {
		if connector == nil {
			return nil, errors.New("nil channel connector")
		}
		descriptor := connector.Descriptor()
		if descriptor.ID == "" || descriptor.DisplayName == "" || descriptor.Version == "" {
			return nil, errors.New("channel connector descriptor is incomplete")
		}
		if _, exists := registry.connectors[descriptor.ID]; exists {
			return nil, errors.New("duplicate channel connector: " + descriptor.ID)
		}
		registry.connectors[descriptor.ID] = connector
	}
	return registry, nil
}

func (r *Registry) Get(id string) (ChannelConnector, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	connector, ok := r.connectors[id]
	return connector, ok
}

func (r *Registry) List() []ConnectorDescriptor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]ConnectorDescriptor, 0, len(r.connectors))
	for _, connector := range r.connectors {
		result = append(result, connector.Descriptor())
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
