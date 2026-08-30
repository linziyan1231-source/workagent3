Record reusable guidance here only you think is necessary.

## Engineering Principles

- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Keep components modular and concerns clearly separated.
- Do not over-defend: defensive code should target failures that can actually happen. Skip guards for practically impossible cases — e.g. nil-checking a value the constructor guarantees, avoid using Hash and SHA256, or error-handling a `json.Marshal` of plain scalar structs. Such branches are dead code and only add noise.
