package modelgateway

import (
	"strings"
	"testing"
)

func TestManagementKeyACLCheck(t *testing.T) {
	allowed := []string{"S-1-5-21-100-200-300-500", "S-1-5-18", "S-1-5-32-544"}
	cases := []struct {
		name       string
		principals []string
		wantErr    string
	}{
		{name: "service account, SYSTEM and Administrators only", principals: allowed},
		{name: "no allow ACEs", principals: nil},
		{name: "duplicate allowed principals", principals: []string{"S-1-5-18", "S-1-5-18"}},
		{name: "case-insensitive SID match", principals: []string{"s-1-5-18", "S-1-5-32-544"}},
		{name: "Users group rejected", principals: []string{"S-1-5-18", "S-1-5-32-545"}, wantErr: "S-1-5-32-545"},
		{name: "employee SID rejected", principals: []string{"S-1-5-21-100-200-300-1017"}, wantErr: "S-1-5-21-100-200-300-1017"},
		{name: "Everyone rejected", principals: []string{"S-1-1-0"}, wantErr: "S-1-1-0"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := managementKeyACLCheck(test.principals, allowed)
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("principals %v rejected: %v", test.principals, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("principals %v: expected error naming %s, got %v", test.principals, test.wantErr, err)
			}
		})
	}
}
