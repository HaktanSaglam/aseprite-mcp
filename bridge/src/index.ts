import { AsepriteSocket } from "./aseprite/AsepriteSocket.js";
import { RpcAsepriteGateway } from "./aseprite/RpcAsepriteGateway.js";
import { CanvasService } from "./canvas/CanvasService.js";
import { ChatService } from "./chat/ChatService.js";
import { loadConfig } from "./config.js";
import { ClaudeCliRunner } from "./llm/ClaudeCliRunner.js";
import { createMcpServer } from "./mcp/createMcpServer.js";
import { startMcpHttpServer } from "./mcp/httpServer.js";
import { QuickJsScriptRunner } from "./script/QuickJsScriptRunner.js";

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

  // One runner for all requests: it caches the compiled QuickJS WebAssembly module.
  const tools = { gateway, canvas: new CanvasService(gateway), scripts: new QuickJsScriptRunner() };
  const http = await startMcpHttpServer({ host: config.host, port: config.mcpPort }, () =>
    createMcpServer(tools),
  );

  const runner = new ClaudeCliRunner({ claudePath: config.claudePath, workDir: config.claudeWorkDir });
  new ChatService(socket, runner, mcpUrl).attach();

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
