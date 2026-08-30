# Vendored AionUi Renderer

This directory is a source snapshot from the CLIENTNAME AionUi Renderer chosen
as the WorkAgent3 frontend baseline.

- Source: `C:\projects\AionUi`
- Upstream repository: <https://github.com/iOfficeAI/AionUi>
- Upstream ref: `codex/clientname-latest-github-aionui-20260810`
- Commit: `1f41b9cbcece8599d3bdfd955553c24e42a308c3`
- Release: `2.1.0-beta.editfork.72`
- Source subtree: `packages/desktop/src`
- License: Apache-2.0 (individual source files retain their license headers)

Do not restyle or independently reimplement these renderer components in the
WorkAgent3 application. Product integration belongs in the WorkAgent3 adapter
layer; refresh this snapshot mechanically from the pinned source repository.

The only in-tree compatibility changes are the event-neutral `onCancel`/`onOk`
wrappers in `renderer/components/base/AionModal.tsx`; they preserve runtime
behavior and allow the upstream component to compile under WorkAgent3's
stricter TypeScript configuration.
