# Vendored AionUi Renderer

This directory is the Puxin/WorkAgent2 managed Web 78 Renderer snapshot chosen
as the WorkAgent3 frontend baseline.

- Source: `C:\projects\WorkAgent2\.tools\worktrees\runtime-auth-deploy-ui`
- Upstream repository: <https://github.com/iOfficeAI/AionUi>
- Upstream ref: `codex/dwg-managed-mcp-web77`
- Commit: `0a5e806e9e495323368fb3b5b5f359c5ff8a9f4b`
- Release: WorkAgent2 managed Web 78
- Source subtree: `packages/desktop/src/renderer`
- License: Apache-2.0 (individual source files retain their license headers)

Do not restyle or independently reimplement these renderer components in the
WorkAgent3 application. Product integration belongs in the WorkAgent3 adapter
layer; refresh this snapshot mechanically from the pinned source repository.

The only in-tree compatibility changes are the event-neutral `onCancel`/`onOk`
wrappers in `renderer/components/base/AionModal.tsx`, the absolute hooks module
specifier in `renderer/pages/conversation/Messages/MessageList.tsx`, and the
optional `hiddenBuiltinIds` input on the settings sider. They preserve
visual/runtime behavior while allowing WorkAgent3's Web adapter to replace
desktop state and omit features excluded by `plan.md`. The guide action row
also accepts an optional browser-file callback so its unchanged picker can
hand selected `File` objects to the WorkAgent3 HTTP asset port. Other Web
integration remains in the adapter layer.
