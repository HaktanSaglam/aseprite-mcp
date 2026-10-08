import { AsepriteSocket } from "./aseprite/AsepriteSocket.js";
import { RpcAsepriteGateway } from "./aseprite/RpcAsepriteGateway.js";
import { ChatService } from "./chat/ChatService.js";
import { CHAT_SYSTEM_PROMPT } from "./chat/promptBuilder.js";
import { loadConfig } from "./config.js";
import { ClaudeCliRunner } from "./llm/ClaudeCliRunner.js";
import { createMcpServer } from "./mcp/createMcpServer.js";
import { startMcpHttpServer } from "./mcp/httpServer.js";

// Composition root: the only place that knows which concrete classes are used.
async function main(): Promise<void> {
  const config = loadConfig();
  const mcpUrl = `http://${config.host}:${config.mcpPort}/mcp`;

  const socket = new AsepriteSocket({
    host: config.host,
    port: config.asepritePort,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  await socket.start();
  const gateway = new RpcAsepriteGateway(socket);

  const http = await startMcpHttpServer({ host: config.host, port: config.mcpPort }, () =>
    createMcpServer(gateway),
  );

  const runner = new ClaudeCliRunner({
    claudePath: config.claudePath,
    mcpUrl,
    workDir: config.claudeWorkDir,
    systemPrompt: CHAT_SYSTEM_PROMPT,
  });
  new ChatService(socket, runner).attach();

  console.error(`[bridge] MCP endpoint:      ${mcpUrl}`);
  console.error(`[bridge] Waiting for Aseprite on ws://${config.host}:${config.asepritePort}`);

  const shutdown = () => {
    socket.stop();
    http.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[bridge] Failed to start:", error);
  process.exit(1);
});
