# WorkAgent appearance plugin

`@workagent/dsh-appearance` owns the five visual themes and shades only the
`settings.general.item` cell with id `appearance`. It depends on the existing
WorkAgent client and the upstream theme/settings plugins; disabling it restores
the upstream Appearance row. Business components and their slots stay in their
own plugins.

The five palettes and component treatments live in `tokens.css`. Both the
application and settings thumbnails use those definitions. Upstream alias tokens
are mapped through the official theme service so other frontend plugins inherit
the same palette. The stylesheet's shell adapters target the DSH version pinned
by this repository and preserve the existing layout.

The browser stores `{ mode, daylight }` in `workagent.appearance.v1`. A fixed
theme sets the upstream light/dark preference. System mode keeps upstream
`system`, resolves daylight to the selected porcelain/glacier/paper/jade palette,
and always resolves dark to graphite. The upstream theme service owns the OS
media listener; the appearance plugin consumes `theme/change`. Refreshes and
same-origin browser tabs preserve the choice. Existing light/dark/system
preferences are adopted until the user explicitly selects a new appearance.

Run `pnpm --filter @workagent/dsh-appearance test` and the authenticated
`scripts/smoke-dsh-appearance.mjs` check when changing this plugin.
