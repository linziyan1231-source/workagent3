# Workflow reference

## Routing

- Tianzheng gate: any `TCH_*`, `UNKNOWN_ENT`, Tianzheng private partial/unsupported entity, or quality
  signal that may hide walls, columns, openings, text, or dimensions requires
  `tianzheng_converter_status` → `convert_tianzheng_to_t3`. `available` is preflight only;
  `conversion_succeeded` is the sole production pass state. Open only returned T3 outputs and retain
  originals for provenance. Conversion is local, refuses unapproved versions, and never overwrites
  the source.
- State routing: `temporarily_failed` means diagnose/retry or stop; it never becomes `unavailable`
- Run DWGFastView with per-run `TEMP`/`TMP` under the T3 output location (normally the user's E: workspace), clean that directory after the owned process tree exits, and preflight both the system drive and output drive for at least 512 MiB free. A low-space dialog or preflight is `INSUFFICIENT_DISK_SPACE` / `temporarily_failed`, never `unavailable`.
  merely because of timeout, missing window, dialog, file lock, residual process, or one automation
  failure. `unavailable` requires explicit executable/version/dependency/platform evidence. Only that
  state plus an informed user authorization permits `degraded_diagnostic_only`, which cannot produce
  a complete BOQ.
- 3D solid/surface: open through the normal MCP path → inspect `vertices_3d`, `bbox_3d`, and projected
  geometry → use projection only when the quantity definition is genuinely two-dimensional → mark
  curved or unevaluated surfaces `needs_review`.
- Linear system: query candidates → nearby labels/blocks → trace connectivity → render highlights →
  deduplicate → measure length.
- Surface or room: find closed polylines/HATCH → inspect labels and exclusions → render region →
  measure area with deliberate `sum` or `union` mode.
- Devices/openings/equipment: inspect block names and attributes → compare legend/schedule → render a
  sample → count explicit IDs.
- Unclear symbol or exploded block: search nearby text → compare repeated spatial patterns → render
  multiple examples → store as extensible `custom` subtype if still project-specific.
- After conversion: rerun drawing list, summary, text, overview, units, and parse quality; compare
  supported/partial/unsupported/unknown, remaining `TCH_*`, and private-to-standard expansion. If
  significant gaps remain, isolate and diagnose them but block final production measurement. Never
  treat absent parsed objects as zero. The private-bit decoder remains diagnostic-only.

## XREF checks

Inspect each summary for resolved and missing XREFs. Preserve the main-to-child source chain. Avoid
aggregating the same child drawing both independently and through multiple insertions unless the
construction scope genuinely repeats it. Treat unresolved XREF scope as an explicit completeness gap.

## Derived quantities

Build derived quantities only from deterministic primitive results and cited project properties. For
example, derive wall area from measured wall length and documented height, then subtract measured
openings. Record the formula, primitive outputs, property sources, and conversions. Retain
`needs_review` when any input is ambiguous.

## Sampling

Visually sample every low-confidence class and each high-value/high-volume group. Sample distinct
drawing conventions, floors, layers, block variants, and edge cases rather than only adjacent objects.

