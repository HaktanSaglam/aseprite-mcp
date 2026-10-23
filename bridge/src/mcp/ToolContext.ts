import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IAsepriteGateway } from "../aseprite/AsepriteGateway.js";
import type { CanvasService } from "../canvas/CanvasService.js";
import type { IScriptRunner } from "../script/ScriptRunner.js";

/** Everything a tool may use. Built once per MCP server in the composition root. */
export interface ToolContext {
  gateway: IAsepriteGateway;
  canvas: CanvasService;
  scripts: IScriptRunner;
}

/** Each tools/*.ts file exports one of these; registering a new file is one line in tools/index.ts. */
export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;
