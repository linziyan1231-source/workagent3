import {
  adminJson,
  baseURL,
  json,
  killSmokeProcess,
  openDshAfterRestart,
  rememberedSmokeProcessSID,
  resolveRemoteSmokeProcess,
  restartSmokeRuntime,
  smokeUsername,
  smokeProcessSID,
  uniqueName,
  withPage,
} from "./smoke-dsh-helpers.mjs";

const userHostPid = Number(process.env.WORKAGENT_SMOKE_USERHOST_PID);
if (
  !Number.isSafeInteger(userHostPid) ||
  userHostPid <= 0 ||
  userHostPid === process.pid
)
  throw new Error(
    "WORKAGENT_SMOKE_USERHOST_PID must identify the supervised UserHost process",
  );

await withPage(async (page) => {
  const workspace = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("team-project"), scope: "team" }),
  });
  const presets = await json(page, "/api/runtime/v1/presets");
  const preset =
    presets.find((row) => row.enabled && row.engine === "harness") ||
    presets[0];
  if (!preset) throw new Error("team smoke requires an enabled preset");
  const name = uniqueName("dsh-team");
  let team;
  let codexPreset;
  try {
    codexPreset = await json(page, "/api/runtime/v1/presets", {
      method: "POST",
      body: JSON.stringify({
        name: uniqueName("codex-team-preset"),
        engine: "codex",
        enabled: true,
        description: "",
        avatar: null,
        modelId: null,
        systemPrompt: "",
        workspacePolicy: "optional",
        skillIds: [],
        mcpServerIds: [],
        toolAllowlist: [],
        approvalPolicy: "on_risk",
      }),
    });
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.getByRole("checkbox", { name: "团队模式" }).check();
    await page
      .getByRole("combobox", { name: "团队项目" })
      .selectOption(workspace.id);
    for (const label of ["模型", "思考级别", "权限"])
      await page.getByRole("combobox", { name: label }).waitFor();
    if (await page.getByLabel("Workspace ID").count())
      throw new Error("team mode exposed an internal workspace ID field");

    team = await json(page, "/api/runtime/v1/teams", {
      method: "POST",
      body: JSON.stringify({
        name,
        workspaceId: workspace.id,
        lead: {
          name: "Harness lead",
          engine: preset.engine,
          presetId: preset.id,
          modelId: "harness-default",
          thinkingEffort: "high",
          permissionMode: "workspace_write",
        },
      }),
    });
    team = await json(
      page,
      `/api/runtime/v1/teams/${encodeURIComponent(team.id)}/members`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Codex reviewer",
          engine: "codex",
          presetId: codexPreset.id,
        }),
      },
    );
    await json(
      page,
      `/api/runtime/v1/teams/${encodeURIComponent(team.id)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          fromMemberId: team.members[0].id,
          toMemberId: team.members[1].id,
          body: `Review ${name}`,
        }),
      },
    );
    await json(
      page,
      `/api/runtime/v1/teams/${encodeURIComponent(team.id)}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          memberId: team.members[0].id,
          title: `Investigate ${name}`,
          input: `Investigate ${name}`,
        }),
      },
    );
    await page.waitForFunction(
      async (id) =>
        (
          await (
            await fetch(
              `/api/runtime/v1/teams/${encodeURIComponent(id)}/events`,
            )
          ).json()
        ).some(
          (event) =>
            event.type === "task.started" || event.type === "task.completed",
        ),
      team.id,
      { timeout: 120_000 },
    );
    const cancellation = await json(
      page,
      `/api/runtime/v1/teams/${encodeURIComponent(team.id)}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          memberId: team.members[0].id,
          title: `Cancel ${name}`,
          input: `Cancel ${name}`,
        }),
      },
    );
    await json(
      page,
      `/api/runtime/v1/teams/${encodeURIComponent(team.id)}/tasks/${encodeURIComponent(cancellation.id)}/cancel`,
      { method: "POST" },
    );
    const managedUsers = await adminJson(page, "/api/portal/admin/users");
    const managedUser = managedUsers.users?.find(
      (entry) => entry.username === smokeUsername,
    );
    let sid = managedUser?.windows_sid;
    if (!sid) {
      try {
        sid = await smokeProcessSID(userHostPid);
      } catch {
        sid = rememberedSmokeProcessSID();
      }
    }
    const currentUserHostPid = await resolveRemoteSmokeProcess(
      userHostPid,
      "userhost.exe",
      sid,
    );
    await killSmokeProcess(currentUserHostPid);
    await page.waitForFunction(async () => {
      try {
        return !(await fetch("/api/runtime/v1/teams")).ok;
      } catch {
        return true;
      }
    });
    await restartSmokeRuntime(page);
    await page.waitForFunction(
      async (id) => {
        try {
          const response = await fetch("/api/runtime/v1/teams");
          return (
            response.ok && (await response.json()).some((row) => row.id === id)
          );
        } catch {
          return false;
        }
      },
      team.id,
      { timeout: 120_000, polling: 500 },
    );
    await openDshAfterRestart(page, "/?frontend=dsh");
    await page.getByRole("checkbox", { name: "团队模式" }).check();
    await page
      .getByRole("combobox", { name: "团队项目" })
      .selectOption(workspace.id);
    if (
      !(await json(page, "/api/runtime/v1/teams")).some(
        (row) => row.id === team.id,
      )
    )
      throw new Error("team was not recovered after restart");
  } finally {
    if (team)
      await json(page, `/api/runtime/v1/teams/${encodeURIComponent(team.id)}`, {
        method: "DELETE",
      }).catch(() => {});
    if (codexPreset)
      await json(
        page,
        `/api/runtime/v1/presets/${encodeURIComponent(codexPreset.id)}`,
        { method: "DELETE" },
      ).catch(() => {});
  }
});

console.log("dsh team smoke passed");
