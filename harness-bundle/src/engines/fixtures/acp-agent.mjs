import { createInterface } from "node:readline";
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let promptId;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === "permission" && !message.method) {
    send({
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: message.result.outcome.optionId },
        },
      },
    });
    send({ id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { fork: {}, resume: {} },
        },
      });
      break;
    case "session/new":
      send({
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "review",
                description: "Review project",
                input: { hint: "path" },
              },
            ],
          },
        },
      });
      reply({ sessionId: "s1" });
      break;
    case "session/resume":
      reply({});
      break;
    case "session/prompt":
      if (message.params.prompt[0]?.text === "inspect-test-environment") {
        send({
          method: "session/update",
          params: {
            sessionId: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: JSON.stringify({
                  key: process.env.ACP_TEST_KEY,
                  undeclared: process.env.ACP_TEST_UNDECLARED,
                  internal: process.env.WORKAGENT_TEST_TOKEN,
                  home: process.env.ACP_HOME,
                }),
              },
            },
          },
        });
        reply({ stopReason: "end_turn" });
        break;
      }
      promptId = message.id;
      send({
        id: "permission",
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "tool1", title: "Read" },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            {
              optionId: "session",
              name: "Allow for session",
              kind: "allow_always",
            },
            { optionId: "deny", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined)
        send({
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
  }
});
