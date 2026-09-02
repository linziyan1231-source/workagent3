package audit

// Business audit event catalog (W5). Every action follows the
// "<domain>.<object>.<verb>" shape. Producers write through the Sink port and
// must include actor, target, action, result and correlation ID; metadata
// carries only small, already-redacted details (IDs, counts, versions) —
// never passwords, tokens, or plain key material.
//
//   - Employee lifecycle: actor is the administering Portal username, or the
//     "employee-manager" subsystem for CLI-driven actions; target is the
//     employee username. employee.provision is emitted when the asynchronous
//     provision job reaches a terminal state.
//   - Model gateway keys: actor is the calling subsystem; target is the
//     opaque managed key ID (plain keys are never recorded).
//   - Quota: actor is the paying SID (for shared runs the frozen payer, i.e.
//     the member who triggered the run); target is the run ID, which also
//     serves as the correlation ID linking reserve and settle; metadata holds
//     model_id and unit counts.
//   - Collaboration: actor is the acting Portal username; target is the
//     shared project ID; metadata identifies the affected member / new owner.
//   - Skill market: actor is the acting Portal username; target is the
//     package ID.
//   - Skill/MCP runtime: events are emitted by the employee UserHost over the
//     loopback runtime audit endpoint; actor is the owning SID; target is the
//     skill or MCP server ID.
//   - Backup/restore and release: actor is the operating CLI subsystem name;
//     metadata carries version/activation IDs.
//   - Model gateway keys: actor is the calling subsystem; target is the
//     opaque managed key ID (plain keys are never recorded).
const (
	ActionModelGatewayKeyProvision = "modelgateway.key.provision"
	ActionModelGatewayKeyRotate    = "modelgateway.key.rotate"
	ActionModelGatewayKeyEnable    = "modelgateway.key.enable"
	ActionModelGatewayKeyDisable   = "modelgateway.key.disable"
	ActionModelGatewayKeyRevoke    = "modelgateway.key.revoke"
)

const (
	ActionEmployeeProvision      = "employee.provision"
	ActionEmployeeEnable         = "employee.enable"
	ActionEmployeeDisable        = "employee.disable"
	ActionEmployeePasswordReset  = "employee.password.reset"
	ActionEmployeeAdminGrant     = "employee.admin.grant"
	ActionEmployeeAdminRevoke    = "employee.admin.revoke"
	ActionEmployeeLimitsUpdate   = "employee.limits.update"
	ActionEmployeeOffboardRetain = "employee.offboard.retain"
	ActionEmployeeOffboardDelete = "employee.offboard.delete"
	ActionEmployeeRepair         = "employee.repair"
	ActionEmployeeRename         = "employee.rename"

	ActionQuotaReserve = "quota.reserve"
	ActionQuotaSettle  = "quota.settle"

	ActionCollaborationACLGrant          = "collaboration.acl.grant"
	ActionCollaborationACLRevoke         = "collaboration.acl.revoke"
	ActionCollaborationOwnershipTransfer = "collaboration.ownership.transfer"
	ActionCollaborationInviteLinkCreate  = "collaboration.invite_link.create"
	ActionCollaborationInviteLinkRevoke  = "collaboration.invite_link.revoke"
	ActionCollaborationInviteLinkAccept  = "collaboration.invite_link.accept"

	ActionSkillMarketPublish = "skillmarket.skill.publish"
	ActionSkillMarketInstall = "skillmarket.skill.install"
	ActionSkillMarketDelete  = "skillmarket.skill.delete"

	ActionSkillInstall   = "skill.install"
	ActionSkillEnable    = "skill.enable"
	ActionSkillDisable   = "skill.disable"
	ActionSkillUninstall = "skill.uninstall"

	ActionMCPInstall        = "mcp.install"
	ActionMCPUpdate         = "mcp.update"
	ActionMCPEnable         = "mcp.enable"
	ActionMCPDisable        = "mcp.disable"
	ActionMCPUninstall      = "mcp.uninstall"
	ActionMCPOAuthAuthorize = "mcp.oauth.authorize"
	ActionMCPOAuthRevoke    = "mcp.oauth.revoke"

	ActionBackupCreate  = "backup.create"
	ActionBackupRestore = "backup.restore"

	// Migration disposition: actor is the administering Portal username; target
	// is "<sid>:<migration source ID>"; metadata carries the journal kind.
	ActionMigrationDispositionRetry       = "migration.disposition.retry"
	ActionMigrationDispositionResolve     = "migration.disposition.resolve"
	ActionMigrationDispositionReauthorize = "migration.disposition.reauthorize"

	ActionReleaseInstall   = "release.install"
	ActionReleasePublish   = "release.publish"
	ActionReleaseReadiness = "release.readiness"
	ActionReleaseActivate  = "release.activate"
	ActionReleaseRollback  = "release.rollback"
)
