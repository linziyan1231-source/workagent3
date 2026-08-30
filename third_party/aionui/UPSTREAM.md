# Vendored AionUi Renderer

This directory is an exact source snapshot from the latest formal AionUi
Renderer requested as the WorkAgent3 frontend baseline.

- Source: `C:\projects\AionUi`
- Upstream repository: <https://github.com/iOfficeAI/AionUi>
- Upstream ref: `origin/main`
- Commit: `18022a49684d5a2b54b0a47f904e76b17f758b3b`
- Release: `2.2.0`
- Source subtree: `packages/desktop/src`
- License: Apache-2.0 (individual source files retain their license headers)

Do not restyle or independently reimplement these renderer components in the
WorkAgent3 application. Product integration belongs in the WorkAgent3 adapter
layer; refresh this snapshot mechanically from the pinned source repository.

The only in-tree compatibility changes are the event-neutral `onCancel`/`onOk` wrappers
in `renderer/components/base/AionModal.tsx`; they preserve runtime behavior and
allows the upstream component to compile under WorkAgent3's stricter TypeScript
configuration.
