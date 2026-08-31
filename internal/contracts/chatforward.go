package contracts

// ChatForwardDelegation is the complete identity surface delegated by Portal.
// The upstream service never receives a Portal cookie, password, or Windows SID.
type ChatForwardDelegation struct {
	UserID  string
	NowUnix int64
}
