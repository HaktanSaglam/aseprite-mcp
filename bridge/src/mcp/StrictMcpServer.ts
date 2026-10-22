import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

interface ToolConfig<InputArgs, OutputArgs> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

function isSchemaInstance(schema: object): boolean {
  return "_zod" in schema || "_def" in schema;
}

/**
 * The model reads this after "Invalid arguments for tool <name>:", so it names the
 * offending keys and every argument the tool does take.
 */
export function unknownArgumentsMessage(keys: readonly PropertyKey[], accepted: readonly string[]): string {
  const unknown = keys.map((key) => `"${String(key)}"`).join(", ");
  const takes = accepted.length > 0 ? `It takes: ${accepted.join(", ")}.` : "It takes no arguments.";
  return `Unknown argument${keys.length === 1 ? "" : "s"} ${unknown}. ${takes}`;
}

function strictSchema(shape: ZodRawShapeCompat) {
  const accepted = Object.keys(shape);
  return z.strictObject(shape as z.ZodRawShape, {
    error: (issue) => (issue.code === "unrecognized_keys" ? unknownArgumentsMessage(issue.keys, accepted) : undefined),
  });
}

/**
 * The SDK turns a raw zod shape into a plain object schema, and a plain object silently
 * drops keys it does not know: write_pixels {frames: [1, 2, 3]} then "succeeds" on the
 * active frame only. Every tool registered here gets a strict schema instead, so a
 * misspelled or unsupported argument fails with the list of arguments the tool takes
 * (and clients see additionalProperties: false in the tool list).
 */
export class StrictMcpServer extends McpServer {
  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(name: string, config: ToolConfig<InputArgs, OutputArgs>, cb: ToolCallback<InputArgs>): RegisteredTool {
    const { inputSchema } = config;
    if (inputSchema === undefined) {
      // The SDK calls an argument-less tool with `extra` only; keep that calling convention.
      const withoutArgs = cb as ToolCallback;
      return super.registerTool(name, { ...config, inputSchema: strictSchema({}) }, (_args, extra) => withoutArgs(extra));
    }
    // A full schema (union, refinement, ...) was built on purpose; it decides about extra keys itself.
    if (isSchemaInstance(inputSchema)) return super.registerTool(name, config, cb);
    const strict = strictSchema(inputSchema as ZodRawShapeCompat);
    return super.registerTool(name, { ...config, inputSchema: strict }, cb as unknown as ToolCallback<typeof strict>);
  }
}
