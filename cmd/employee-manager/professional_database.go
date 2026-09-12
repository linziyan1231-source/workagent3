package main

import (
	"errors"
	"path/filepath"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/employeemanager"
	"workagent3/internal/professionaldb"
	"workagent3/internal/userhost"
)

type professionalDatabaseConfig struct {
	Endpoint       string `json:"endpoint"`
	DatabasePath   string `json:"databasePath"`
	CredentialPath string `json:"credentialPath"`
	OAuthHost      string `json:"oauthHost,omitempty"`
	APIURL         string `json:"apiUrl,omitempty"`
	OutboundProxy  string `json:"outboundProxyUrl,omitempty"`
}

func configureProfessionalDatabase(cfg *professionalDatabaseConfig, service *employeemanager.Service) (func() error, error) {
	if cfg == nil {
		return func() error { return nil }, nil
	}
	if err := validateProfessionalDatabaseConfig(cfg); err != nil {
		return nil, err
	}
	data, err := professionaldb.Open(cfg.DatabasePath, credentialbroker.NewUserProtector())
	if err != nil {
		return nil, err
	}
	server, err := professionaldb.NewServer(professionaldb.Config{CredentialPath: cfg.CredentialPath, OAuthHost: cfg.OAuthHost, APIURL: cfg.APIURL, OutboundProxy: cfg.OutboundProxy}, data, service.ProfessionalDatabaseEnabled)
	if err != nil {
		data.Close()
		return nil, err
	}
	service.ProfessionalDatabase = data
	service.ProfessionalDatabaseURL = cfg.Endpoint
	service.ProfessionalDatabaseHandler = server.Handler()
	service.ProfessionalDatabaseReady = server.Ready
	return data.Close, nil
}

func professionalDatabaseURL(cfg *professionalDatabaseConfig) string {
	if cfg == nil {
		return ""
	}
	return cfg.Endpoint
}

func validateProfessionalDatabaseConfig(cfg *professionalDatabaseConfig) error {
	if cfg == nil {
		return nil
	}
	if !filepath.IsAbs(cfg.DatabasePath) || !filepath.IsAbs(cfg.CredentialPath) {
		return errors.New("professional database databasePath and credentialPath must be absolute")
	}
	if cfg.Endpoint == "" {
		return errors.New("professional database endpoint is required")
	}
	return userhost.ValidateProfessionalDatabaseURL(cfg.Endpoint)
}
