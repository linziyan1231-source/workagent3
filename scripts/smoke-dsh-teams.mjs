import {
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
    body: JSON.stringify({ name: uniqueName("team-workspace") }),
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
    await page.goto(`${baseURL}/?workagent=teams`);
    const dialog = page.getByRole("dialog", { name: "teams" });
    await dialog.getByLabel("Team name").fill(name);
    await dialog.getByLabel("Workspace ID").fill(workspace.id);
    await dialog.getByLabel("Lead name").fill("Harness lead");
    await dialog.getByLabel("Preset ID").fill(preset.id);
    await dialog.getByLabel("Lead engine").selectOption("harness");
    await dialog.getByRole("button", { name: "Create team" }).click();
    await dialog.getByText(name, { exact: true }).waitFor();
    team = (await json(page, "/api/runtime/v1/teams")).find(
      (row) => row.name === name,
    );
    if (!team) throw new Error("team was not persisted");
    const card = dialog.locator("article", { hasText: name });
    await card.getByRole("button", { name: "Add member" }).click();
    await dialog.getByLabel("Team action value").fill("Codex reviewer");
    await dialog.getByLabel("Member engine").selectOption("codex");
    await dialog.getByLabel("Member preset ID").fill(codexPreset.id);
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await page.waitForFunction(
      async (id) =>
        (await (await fetch("/api/runtime/v1/teams")).json()).find(
          (row) => row.id === id,
        )?.members.length >= 2,
      team.id,
    );
    await card.getByRole("button", { name: "Dispatch task" }).click();
    await dialog.getByLabel("Team action value").fill(`Investigate ${name}`);
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await card.getByRole("button", { name: "Mailbox and events" }).click();
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
    const managedUsers = await json(page, "/api/portal/admin/users");
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
    await openDshAfterRestart(page, "/?workagent=teams&frontend=dsh");
    await page
      .getByRole("dialog", { name: "teams" })
      .getByText(name, { exact: true })
      .waitFor();
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
