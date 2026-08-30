package auth

import "testing"

func TestPasswordRoundTrip(t *testing.T) {
	password := []byte("correct horse battery staple")
	encoded, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(encoded, password) {
		t.Fatal("password did not verify")
	}
	if VerifyPassword(encoded, []byte("incorrect password")) {
		t.Fatal("incorrect password verified")
	}
}

func TestUsernameValidation(t *testing.T) {
	for _, value := range []string{"alice", "Alice-2", "employee.one"} {
		if err := ValidateUsername(value); err != nil {
			t.Fatalf("%q should be valid: %v", value, err)
		}
	}
	for _, value := range []string{"", "_alice", "employee one", "用户"} {
		if err := ValidateUsername(value); err == nil {
			t.Fatalf("%q should be invalid", value)
		}
	}
}
