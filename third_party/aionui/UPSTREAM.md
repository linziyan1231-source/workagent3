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

The host compatibility changes are the event-neutral `onCancel`/`onOk`
wrappers in `renderer/components/base/AionModal.tsx`, the Portal notification
Port, the absolute hooks module specifier in
`renderer/pages/conversation/Messages/MessageList.tsx`, and the optional
browser-file callback in the guide action row. They preserve visual/runtime
behavior while allowing WorkAgent3's Web adapter to replace desktop state.

The formal Web 78 administrator page has one scoped WorkAgent3 product
extension: its existing account table, status tags, forms and Modal primitives
also expose the lifecycle actions required by `plan.md` (capacity, repair,
Windows rename, retained offboarding and separately confirmed deletion). No
parallel administrator page or replacement visual system is maintained.
Other Web integration remains in the adapter layer.
