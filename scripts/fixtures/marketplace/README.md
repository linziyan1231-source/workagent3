# Marketplace smoke fixture

Build with `go build -o marketplace-fixture.exe ./scripts/fixtures/marketplace`.
Run on the dedicated test server against its existing marketplace database:

```text
marketplace-fixture.exe <market-db> <unique-entry-id> <publisher-username>
```

Supply that entry ID as `WORKAGENT_SMOKE_MARKET_SEED_ID` for
`scripts/smoke-dsh-experience.mjs`. The smoke also needs the standard smoke
URL/username/password and `WORKAGENT_SMOKE_SECOND_USERNAME` /
`WORKAGENT_SMOKE_SECOND_PASSWORD`, read from the server-side secret store.
The publisher must be an administrator for the admin overview assertions.

The fixture contains only a short SKILL.md. The browser smoke installs it,
creates a temporary HTTP MCP configuration without connecting to it, publishes
an assistant with both dependencies, and verifies installation into the second
account and retry idempotence. It deletes its installed resources and unpublishes
its listings in `finally`.

After the smoke, unpublish the seed using the same command with a final `remove`
argument. Immutable installation snapshots remain in the marketplace database;
the cleanup does not delete unrelated resources or persistent account data.
