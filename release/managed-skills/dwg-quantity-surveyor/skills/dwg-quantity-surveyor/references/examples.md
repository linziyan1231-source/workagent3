# Payload examples

## Engineering object

```json
{
  "object_id": "OBJ-001",
  "drawing_id": "D-123",
  "discipline": "plumbing",
  "category": "pipe",
  "subtype": "cold_water_pipe",
  "properties": {"material": "PPR", "diameter_mm": 25},
  "source_entities": ["D-123-E-7A4C"],
  "classification": {"confidence": 0.95, "status": "verified"},
  "evidence": {
    "cad": [{"entity_id": "D-123-E-7A4C", "layer": "W-CW-DN25"}],
    "text": [{"text_id": "D-123-E-9B", "text": "PPR冷水管 DN25"}],
    "spatial": [{"kind": "connected_network", "trace_start": "D-123-E-7A4C"}],
    "visual": [{"image_path": ".cache/.../selections/selection.png"}]
  }
}
```

## Quantity item

```json
{
  "item_id": "Q-001",
  "engineering_object_ids": ["OBJ-001"],
  "name": "PPR冷水给水管",
  "specification": "DN25",
  "discipline": "plumbing",
  "category": "pipe",
  "unit": "m",
  "quantity": 18.324,
  "calculation": {
    "method": "length",
    "raw_quantity": 18324,
    "raw_unit": "mm",
    "conversion": "0.001",
    "breakdown": [{"entity_id": "D-123-E-7A4C", "raw": 18324}]
  },
  "source": {"drawing_ids": ["D-123"], "entity_ids": ["D-123-E-7A4C"]},
  "confidence": 0.95,
  "review_status": "auto_verified",
  "evidence": {"measurement_tool": "measure_length"}
}
```


