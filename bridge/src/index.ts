import { AsepriteSocket } from "./aseprite/AsepriteSocket.js";
import { RpcAsepriteGateway } from "./aseprite/RpcAsepriteGateway.js";
import { SpriteActivity } from "./aseprite/SpriteActivity.js";
import { TrackingAsepriteGateway } from "./aseprite/TrackingAsepriteGateway.js";
import { CanvasService } from "./canvas/CanvasService.js";
import { ChatService } from "./chat/ChatService.js";
import { GenerationService } from "./chat/GenerationService.js";
import { InstantToolService } from "./chat/InstantToolService.js";
import { SessionStore } from "./chat/SessionStore.js";
import { SingleRunService } from "./chat/SingleRunService.js";
import { loadConfig } from "./config.js";
import { startDevServer } from "./dev/devServer.js";
import { TappedEvents } from "./dev/TappedEvents.js";
import { createProviderRegistry } from "./llm/ProviderRegistry.js";
import { createMcpServer, scopeToolContext } from "./mcp/createMcpServer.js";
import { mcpUrls, startMcpHttpServer } from "./mcp/httpServer.js";
import type { ToolContext } from "./mcp/ToolContext.js";
import { QuickJsScriptRunner } from "./script/QuickJsScriptRunner.js";

// Composition root: the only place that knows which concrete classes are used.
async function main(): Promise<void> {
  const config = loadConfig();
  const urls = mcpUrls(config.host, config.mcpPort);

  const socket = new AsepriteSocket({
    host: config.host,
    port: config.asepritePort,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  await socket.start();
  // Every change that reaches Aseprite with a sprite id is recorded, so a run knows its
  // undo steps and drawn cels whether the model or the bridge made them.
  const activity = new SpriteActivity();
  const gateway = new TrackingAsepriteGateway(new RpcAsepriteGateway(socket), activity);

  // One script runner for all requests: it caches the compiled QuickJS WebAssembly module.
  const baseContext: ToolContext = { gateway, canvas: new CanvasService(gateway), scripts: new QuickJsScriptRunner() };
  const contextFor = (sprite?: number) => (sprite === undefined ? baseContext : scopeToolContext(baseContext, sprite));
  const serverFor = (sprite?: number) => createMcpServer(contextFor(sprite));

  const http = await startMcpHttpServer({ host: config.host, port: config.mcpPort }, (scope) => serverFor(scope.sprite));

  const sessions = new SessionStore();
  const registry = createProviderRegistry(config);
  const tapped = config.devPort !== undefined ? new TappedEvents(socket) : undefined;
  new ChatService({
    events: tapped ?? socket,
    registry,
    singleRun: new SingleRunService({ gateway, mcpUrls: urls, sessions, activity }),
    generation: new GenerationService({
      gateway,
      mcpUrlFor: urls.forSprite,
      sessions,
      maxParallelRuns: config.maxParallelRuns,
      activity,
    }),
    instantTools: new InstantToolService(serverFor),
    sessions,
    version: config.version,
  }).attach();

  console.error(`[bridge] v${config.version} MCP endpoint: ${urls.unscoped}`);
  console.error(`[bridge] Waiting for Aseprite on ws://${config.host}:${config.asepritePort}`);
  const dev =
    tapped && config.devPort !== undefined
      ? await startDevServer({ host: config.host, port: config.devPort }, tapped)
      : undefined;
  if (dev) console.error(`[bridge] Dev endpoint: http://${config.host}:${config.devPort}`);

  const shutdown = () => {
    registry.dispose?.();
    socket.stop();
    http.close();
    dev?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[bridge] Failed to start:", error);
  process.exit(1);
});
