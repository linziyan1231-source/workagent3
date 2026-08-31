package imgateway

import (
	"context"
	"errors"
	"sort"
	"sync"
)

type ConnectorFactory func() (ChannelConnector, error)
type LoginEmitter func(name string, data any) error
type ConnectorLogin func(ctx context.Context, ownerSID string, emit LoginEmitter) (ConnectorConfig, error)

type ConnectorRegistration struct {
	Descriptor ConnectorDescriptor
	New        ConnectorFactory
	Login      ConnectorLogin
}

type Registry struct {
	mu            sync.RWMutex
	registrations map[string]ConnectorRegistration
}

// NewRegistry remains convenient for tests and single-instance adapters. The
// production composition root uses NewFactoryRegistry so every employee
// account receives an isolated connector lifecycle.
func NewRegistry(connectors ...ChannelConnector) (*Registry, error) {
	registrations := make([]ConnectorRegistration, 0, len(connectors))
	for _, connector := range connectors {
		if connector == nil {
			return nil, errors.New("nil channel connector")
		}
		value := connector
		registrations = append(registrations, ConnectorRegistration{
			Descriptor: value.Descriptor(),
			New: func() (ChannelConnector, error) {
				return value, nil
			},
		})
	}
	return NewFactoryRegistry(registrations...)
}

func NewFactoryRegistry(registrations ...ConnectorRegistration) (*Registry, error) {
	registry := &Registry{registrations: make(map[string]ConnectorRegistration, len(registrations))}
	for _, registration := range registrations {
		descriptor := registration.Descriptor
		if descriptor.ID == "" || descriptor.DisplayName == "" || descriptor.Version == "" || registration.New == nil {
			return nil, errors.New("channel connector registration is incomplete")
		}
		if _, exists := registry.registrations[descriptor.ID]; exists {
			return nil, errors.New("duplicate channel connector: " + descriptor.ID)
		}
		registry.registrations[descriptor.ID] = registration
	}
	return registry, nil
}

func (r *Registry) Has(id string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.registrations[id]
	return ok
}

func (r *Registry) Create(id string) (ChannelConnector, bool, error) {
	r.mu.RLock()
	registration, ok := r.registrations[id]
	r.mu.RUnlock()
	if !ok {
		return nil, false, nil
	}
	connector, err := registration.New()
	if err != nil {
		return nil, true, err
	}
	if connector == nil || connector.Descriptor().ID != id {
		return nil, true, errors.New("channel connector factory returned an invalid connector")
	}
	return connector, true, nil
}

func (r *Registry) Login(id string) (ConnectorLogin, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	registration, ok := r.registrations[id]
	return registration.Login, ok && registration.Login != nil
}

func (r *Registry) List() []ConnectorDescriptor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]ConnectorDescriptor, 0, len(r.registrations))
	for _, registration := range r.registrations {
		result = append(result, registration.Descriptor)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
