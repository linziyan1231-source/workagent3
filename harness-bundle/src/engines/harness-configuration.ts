import type { Context } from "@deepseek-ai/cordis";

// Register on the Agent's scoped context: the official registry owns cleanup
// and shadows only this agent's deployment persona. Variable substitution is
// one pass, so user-authored {{...}} remains literal assistant instructions.
export function installHarnessPrompt(
  agentContext: Context,
  systemPrompt: string,
): void {
  if (!systemPrompt) return;
  agentContext.systemPrompt.variable(
    "workagent_assistant_prompt",
    () => systemPrompt,
  );
  agentContext.systemPrompt.section({
    name: "deployment:persona",
    order: 0,
    text: "{{workagent_assistant_prompt}}",
  });
}
