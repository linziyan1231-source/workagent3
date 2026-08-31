# Vendored AionUi Renderer

This directory contains the current CLIENTNAME/AionUi Renderer snapshot chosen
as the WorkAgent3 frontend baseline.

- Source: `C:\projects\AionUi`
- Upstream repository: <https://github.com/iOfficeAI/AionUi>
- Upstream ref: `codex/clientname-latest-github-aionui-20260810`
- Commit: `1f41b9cbcece8599d3bdfd955553c24e42a308c3`
- Source subtree: `packages/desktop/src/renderer`
- License: Apache-2.0 (individual source files retain their license headers)

Do not restyle or independently reimplement these renderer components in the
WorkAgent3 application. Product integration belongs in the WorkAgent3 adapter
layer; refresh this snapshot mechanically from the pinned source repository.

The upstream placeholder logo is replaced by the production Puxin AI brand
asset at the Web host boundary. The other in-tree compatibility changes are
the event-neutral `onCancel`/`onOk`
wrappers in `renderer/components/base/AionModal.tsx`, the absolute hooks module
specifier in `renderer/pages/conversation/Messages/MessageList.tsx`, and the
optional `hiddenBuiltinIds` input on the settings sider. They preserve
visual/runtime behavior while allowing WorkAgent3's Web adapter to replace
desktop state and omit features excluded by `plan.md`. The guide action row
also accepts an optional browser-file callback so its unchanged picker can
hand selected `File` objects to the WorkAgent3 HTTP asset port. Other Web
integration remains in the adapter layer.
