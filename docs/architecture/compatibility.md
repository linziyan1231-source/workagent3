# Runtime compatibility baseline

Baseline date: 2026-08-30

| Runtime                                   | Pinned version                        | Integration boundary                   |
| ----------------------------------------- | ------------------------------------- | -------------------------------------- |
| Node.js                                   | 25.9.0 development / >=24 supported   | Web and Harness plugins                |
| Go                                        | 1.26.5 development / >=1.26 supported | Portal, manager, and UserHost          |
| DeepSeek Harness CLI and built-in bundles | 0.1.1-rc.2                            | `workagent` profile                    |
| `@deepseek-ai/dsh-subagent-codex`         | 0.0.1-rc.1                            | Reference and one-shot delegation only |
| `@deepseek-ai/dsh-subagent-acp`           | 0.0.1-rc.1                            | Reference and one-shot delegation only |

Codex app-server and Kimi Code/ACP are native external runtimes. Their executable versions are probed and recorded by deployment tooling rather than linked into the application. A release must rerun protocol contract tests before changing any version in this table.
