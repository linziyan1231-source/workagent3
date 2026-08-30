---
name: dwg-quantity-surveyor
description: Investigate DWG construction drawings and produce detailed, evidence-backed, non-blank quantity takeoffs through the DWG Quantity Surveyor MCP, including local Tianzheng-to-T3 preprocessing, direct ACIS/ASM 3D inspection, multi-discipline classification, explicit estimation for missing parameters, and complete XLSX-ready BOQs. Use for project sense-making, CAD/text/spatial/visual investigation, Tianzheng drawings, 3D solids and surfaces, length/area/perimeter/count measurement, ambiguity review, XREF and paper-space checks, evidence persistence, and complete engineering quantity-list export.
---

# DWG Quantity Surveyor

Act as a professional quantity surveyor. Treat layers, blocks, text, and pixels as evidence—not
ground truth. Let the host agent decide engineering meaning; use MCP measurements for final geometry.

Use the managed `DWG Quantity Surveyor` HTTP MCP supplied by WorkAgent3. Do not start, install, or
copy a private parser runtime. The per-user UserHost binds the local HTTP endpoint to the current
user's workspace and supplies its private bearer token.

## Non-negotiable BOQ contract

1. Deliver a detailed scope inventory, not a short sample. Cover every construction scope represented
   by the supplied drawings: building scale, earthwork, foundations, structure, masonry, openings,
   finishes, roof, external works, accessories, and every supplied discipline.
2. Expand assemblies into useful bill items. List component count, length/area/volume/weight, material,
   specification, and related construction layers separately when the drawing supports them. Do not
   collapse thousands of CAD entities into a handful of showcase rows.
3. Never leave a quantity cell blank in the delivered BOQ. A missing design parameter is a reason to
   estimate and flag the result, not a reason to omit the row or leave its quantity empty.
4. Use `0` only when the scope is positively confirmed absent. Never use zero as a substitute for an
   unknown quantity.
5. If a physical quantity cannot be defensibly derived, include the scope as `1 item`, `1 set`, or
   another explicit provisional unit. State which material breakdown or design parameter is missing.
6. Keep certainty visible. Every row must have quantity, unit, status, confidence, formula or takeoff
   basis, source drawing, and assumption/review note.
7. Complete the full investigation and zero-blank QA before the first user-facing BOQ delivery. Do not
   present a partial sample as the finished result unless the user explicitly asks for a sample.

## Establish project sense

1. Enforce the production input gate before any measurement:
   - Open ordinary DWGs directly with `open_project`.
   - Any `TCH_*`, `UNKNOWN_ENT`, Tianzheng private class, related partial/unsupported entity, or
     quality warning that may hide walls, columns, openings, text, or dimensions makes T3 conversion
     a mandatory production prerequisite. Call `tianzheng_converter_status`, then
     `convert_tianzheng_to_t3`.
   - `available` means installed and compatible, not converted. Only `conversion_succeeded` permits
     opening the returned T3 output as the production source. `temporarily_failed` (including window
     discovery timeout, dialog, file lock, residual process, or one failed launch) is not
     `unavailable`; continue diagnosis/retry or stop and report the blocker.
   - Degrade only after the MCP records concrete `unavailable` evidence, explains the completeness
     impact, and the user explicitly authorizes it. Such work is `degraded_diagnostic_only`, never a
     complete production BOQ.
   - Let the parser read retained `3DSOLID` and `EXTRUDEDSURFACE` ACIS/ASM data directly. Do not
     rasterize 3D geometry or require a separate CAD host for its explicit vertices and bounds.
2. Treat the class-specific Tianzheng private-bit decoder as diagnostic-only after the authorized
   unavailable path. It cannot satisfy the production gate.
3. Never combine original and T3-expanded copies in one quantity. The T3 copy is the production
   geometry source; retain the original only for provenance and fallback diagnostics.
4. After conversion, open only T3 outputs, then rerun `list_drawings`, summaries, text inventory,
   overview, unit validation, and parse-quality inspection. Compare before/after supported, partial,
   unsupported, unknown, private-class, text, dimension, and standard-entity statistics. Block final
   delivery if significant gaps remain.
5. For relevant drawings, call `get_drawing_summary`, `get_text_inventory`, and `render_overview`.
6. Identify project type, discipline, drawing type/number, floor, title, notes, legends, schedules,
   materials, abbreviations, revisions, XREFs, and parse warnings.
7. Read paper space for titles and layout annotation. Measure model space unless the drawing gives a
   specific, justified exception. Never count viewport-displayed model geometry twice.
8. Call `validate_units`. Stop final measurement while unit status remains ambiguous.

## Investigate and classify

1. Form a project-specific hypothesis; do not assume layer names are standardized.
2. Narrow candidates with layers, blocks, text, properties, regions, and pagination.
3. Exclude title blocks, legends, schedules, dimension graphics, existing/demolition/future work, and
   duplicated XREF geometry where they are outside scope.
4. Cross-check four evidence classes:
   - CAD: layer, type, block, attributes, geometry, dimensions
   - Text: notes, legends, schedules, labels, materials
   - Spatial: proximity, connectivity, intersections, region, repetition
   - Visual: overview, region, highlighted entities
5. For complex areas, prefer `inspect_region`; use `render_entities` to verify selections.
6. Assign high confidence only when at least three evidence classes agree without conflict. With two
   agreeing classes, perform visual verification and usually retain medium confidence. With one class
   or a conflict, investigate further or mark `needs_review`.

## Build the detailed scope inventory

1. Create the inventory before calculating quantities. Reconcile drawing titles, plans, elevations,
   sections, schedules, details, notes, and calculation plots into one project scope tree.
2. Treat raw entity counts as a reconciliation control, never as component counts. Merge exploded
   geometry into engineering objects and remove duplicate views, details, paper-space viewports,
   XREF repetitions, and structural calculation diagrams.
3. For each engineering object, consider all applicable quantity rows, including:
   - count or set quantity;
   - material volume, area, length, or weight;
   - formwork, reinforcement, coating, waterproofing, finishes, joints, excavation, backfill, and
     other work layers explicitly or implicitly required by the shown construction;
   - type-by-type schedules such as every door/window mark rather than only aggregated totals.
4. Include scope that is shown but underspecified. Place its estimated or provisional quantity in the
   BOQ and its missing inputs in the review register.

## Measure and preserve evidence

1. Pass only confirmed entity IDs to `measure_length`, `measure_area`, `measure_perimeter`, or
   `count_entities`. Never label pixel-derived or assumed geometry as an exact CAD measurement.
2. Use `deduplicate_entities` before high-volume or XREF-derived measurements.
3. Use `sum` for separate surfaces and `union` for overlapping geometry that represents one surface.
4. Save classification with `create_engineering_object`, including source entity IDs and every used
   evidence reference.
5. Save the exact measurement response in `create_quantity_item.calculation`; retain drawing and
   entity attribution.
6. Use this quantity priority, stopping at the first defensible level:
   1. explicit schedule, label, or dimension;
   2. confirmed MCP geometry measurement;
   3. formula derived from measured geometry and documented project parameters;
   4. repeated/detail geometry or a same-project analogous component;
   5. conventional quantity-survey assumption stated as an editable input;
   6. explicit provisional quantity such as `1 item` when no dimensional estimate is defensible.
7. For levels 4–6, set `needs_review`, lower confidence, and record the exact assumption. Never hide
   an estimate behind an `auto_verified` status.
8. Estimate dimensions, counts, and material splits only to the detail justified by the drawings.
   Prefer a coarse but honest provisional quantity over fabricated precision.

Read [boq-contract.md](references/boq-contract.md) before building or exporting a BOQ. It defines the
required row schema, estimation rules, workbook tabs, and zero-blank checks.

## QA and deliver

Before export, confirm notes and legends were read, discipline and units are known, XREFs and paper
space were handled, exclusions and duplicates were checked, low-confidence and high-value items were
visually reviewed, exact quantities came from MCP measurements, estimated quantities expose their
inputs, and source IDs were saved.

Run these completion checks before calling the BOQ finished:

1. Record conversion state, input files, source→T3 mapping, before/after parse statistics, and the
   unique production source. The original is provenance only and must not be aggregated with T3.
2. Reconcile every supplied drawing and every effective drawing region to an included scope, a
   duplicate, or an explicit exclusion.
3. Apply zero-blank QA only after the input-completeness gate passes, or to an explicitly authorized
   provisional workbook. Never create estimates merely to bypass a failed conversion gate.
4. Confirm all detailed BOQ quantity cells are populated and numeric; the blank-quantity count must
   equal zero.
5. Confirm every estimate has a visible assumption and `needs_review` status.
6. Confirm measured, estimated, and provisional item counts reconcile to total BOQ rows.
7. Spot-check representative formulas and high-value quantities against source evidence.
8. If XLSX is requested, include at least summary, detailed BOQ, assumptions/parameters, review tasks,
   source/entity reconciliation, and scope/exclusions sheets; formulas must be auditable.

Use `get_quantity_evidence` to spot-check traceability, then `export_boq`. Report total rows, measured
rows, estimated rows, provisional rows, blank quantity count, scope, assumptions, exclusions,
ambiguities, confidence, and review status with the result.

Read [workflows.md](references/workflows.md) for task routing and [examples.md](references/examples.md)
when constructing payloads or derived-quantity workflows.

