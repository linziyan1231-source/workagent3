# Detailed BOQ delivery contract

## Required row schema

Each delivered BOQ row must contain:

- stable item ID;
- discipline, division, and subsection;
- item name and detailed specification/features;
- numeric quantity and explicit unit;
- status: `auto_verified`, `needs_review`, or `provisional_item`;
- confidence;
- visible formula, measurement response, or takeoff basis;
- source drawing and evidence identifiers where available;
- assumption, exclusion, or required follow-up.

Do not use blank quantities, `N/A`, `TBD`, dashes, or text such as “待补” in the numeric quantity
column. Keep missing information in specification and review-note fields.

## Estimation rules

Use project evidence before generic assumptions. Keep every assumption editable and auditable.

- Missing excavation limits: use documented foundation level plus cushion, and an explicit working
  space and slope assumption.
- Missing reinforcement details: derive theoretical weight from shown bars, spacing, member length,
  cover, hooks, anchorage, laps, and a stated waste factor. If even bar sizes are absent, use a clearly
  labeled kg/m³ or kg/m² project-stage allowance.
- Missing wall or finish splits: calculate the total surface first, then apply an explicit percentage
  split that sums to 100%.
- Missing opening/lintel details: group openings by span, apply the drawing's general-detail table; if
  unreadable, use stated span bands and support lengths.
- Missing proprietary assembly materials: count the assembly as a set and add a provisional structure
  or material-system row as `1 item`; never invent a precise steel weight without a defensible section.
- Missing professional drawings: record the discipline as an explicit scope exclusion. Do not create
  fictitious pipes, cables, or equipment quantities.

Round display values to sensible precision, but preserve formula precision. Avoid false precision in
low-confidence estimates.

## Minimum workbook structure

For an XLSX BOQ, provide:

1. `汇总`: total rows, measured, estimated, provisional, and blank quantity count.
2. `完整工程量清单`: every detailed bill item, with filters and frozen headers.
3. `计量参数`: all drawing inputs and editable estimation assumptions.
4. Discipline/detail sheets when they materially aid review, such as doors/windows or structures.
5. `暂估与复核`: every non-verified row, its assumption, and replacement input needed.
6. `实体核对`: raw entities versus complete/partial/unsupported parsing and deduplication treatment.
7. `范围与排除`: included scope, duplicate representations, missing disciplines, and exclusions.

## Completion gate

Do not export or describe the workbook as complete until all checks pass:

- every Tianzheng-triggered input has state `conversion_succeeded`; the only permitted production
  source is its validated T3 output;
- the delivery records conversion state, inputs, source→output mapping, before/after parse statistics,
  remaining gaps, and production sources;
- every supplied drawing has been inventoried;
- every construction scope maps to at least one BOQ row or an explicit exclusion;
- detailed BOQ blank quantity count is zero;
- zero quantities are evidence-backed absences;
- every estimate has status, confidence, source, formula/basis, and assumption;
- duplicate views and calculation diagrams are not double-counted;
- formula-error scan is clear;
- key totals reconcile to schedules and drawing summaries;
- every workbook sheet has been visually checked.

`temporarily_failed` blocks production measurement and export. A documented `unavailable` state plus
explicit user authorization permits only a diagnostic/provisional workbook and must be labelled as
such. The zero-blank rule applies to a formal BOQ only after input completeness passes; it must never
be used as a reason to fill over a failed conversion gate. An explicitly authorized provisional
workbook may also be zero-blank, but every assumed quantity must remain visible and reviewable.

If exact design information is later supplied, replace the assumption input and retain the same item
ID so the workbook updates without restructuring the BOQ.

