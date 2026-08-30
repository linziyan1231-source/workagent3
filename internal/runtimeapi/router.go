package runtimeapi

import (
	"context"
	"net/url"
)

type Endpoint struct {
	BaseURL *url.URL
	Token   string
}

type EmployeeRuntimeRouter interface {
	Resolve(ctx context.Context, sid string) (Endpoint, error)
}
