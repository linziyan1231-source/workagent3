#!/usr/bin/env python3
"""
Check bounding boxes in fields.json for intersections and minimum heights.

Usage: python check_bounding_boxes.py <fields.json>

Validates:
- No label and entry bounding boxes intersect
- Entry bounding boxes are tall enough for text (minimum 15px)
"""

import json
import sys
from typing import TextIO, Union


MAX_FAILURE_MESSAGES = 20


def boxes_intersect(box1: list, box2: list) -> bool:
    """Check if two bounding boxes [left, top, right, bottom] intersect."""
    if not box1 or not box2:
        return False

    left1, top1, right1, bottom1 = box1
    left2, top2, right2, bottom2 = box2

    # Check for no intersection
    if right1 <= left2 or right2 <= left1:
        return False
    if bottom1 <= top2 or bottom2 <= top1:
        return False

    return True


def get_bounding_box_messages(source: Union[str, TextIO]) -> list:
    """Return bounded validation messages for a fields.json path or stream."""
    if hasattr(source, "read"):
        data = json.load(source)
    else:
        with open(source, "r", encoding="utf-8") as stream:
            data = json.load(stream)

    failures = []
    page_boxes = {}
    for index, field in enumerate(data.get("form_fields", [])):
        description = field.get("description", f"Field {index}")
        page = field.get("page_number", 1)
        for kind in ("label", "entry"):
            box = field.get(f"{kind}_bounding_box")
            if box:
                page_boxes.setdefault(page, []).append((description, kind, box))

        entry_box = field.get("entry_bounding_box")
        if entry_box and "entry_text" in field:
            font_size = field.get("entry_text", {}).get("font_size", 14)
            height = entry_box[3] - entry_box[1]
            if height < font_size:
                failures.append(
                    f"FAILURE: Page {page} entry height {height}px is below "
                    f"font size {font_size}px for '{description}'"
                )

    for page, boxes in page_boxes.items():
        for left_index, (left_name, left_kind, left_box) in enumerate(boxes):
            for right_name, right_kind, right_box in boxes[left_index + 1:]:
                if boxes_intersect(left_box, right_box):
                    failures.append(
                        f"FAILURE: Page {page} bounding box intersection between "
                        f"'{left_name}' {left_kind} and '{right_name}' {right_kind}"
                    )
                if len(failures) >= MAX_FAILURE_MESSAGES:
                    return failures + [
                        f"Aborting after {MAX_FAILURE_MESSAGES} validation failures"
                    ]

    return failures or ["SUCCESS: All bounding boxes are valid"]


def check_bounding_boxes(json_path: str) -> bool:
    """Check bounding boxes for issues and print the retained messages."""
    messages = get_bounding_box_messages(json_path)
    for message in messages:
        print(message)
    return not any("FAILURE" in message for message in messages)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python check_bounding_boxes.py <fields.json>")
        sys.exit(1)

    valid = check_bounding_boxes(sys.argv[1])
    sys.exit(0 if valid else 1)
