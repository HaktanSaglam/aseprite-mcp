import { z } from "zod";
import { BLEND_MODES, type BlendMode, type LayerInfo, type LayerOp, type SpriteInfo } from "../../aseprite/protocol.js";
import { rejectUnusedArgs } from "../actionArgs.js";
import type { ToolRegistrar } from "../ToolContext.js";
import { jsonResult } from "../toolResult.js";

export const LAYER_ACTIONS = ["add", "delete", "update", "move", "duplicate", "merge_down", "activate"] as const;
type LayerAction = (typeof LAYER_ACTIONS)[number];

export interface ManageLayersArgs {
  action: LayerAction;
  name: string;
  newName?: string;
  group?: string;
  above?: string;
  below?: string;
  isGroup?: boolean;
  visible?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  editable?: boolean;
}

const LAYER_PARAMS: Record<LayerAction, string[]> = {
  add: ["name", "group", "above", "isGroup"],
  delete: ["name"],
  update: ["name", "newName", "visible", "opacity", "blendMode", "editable"],
  move: ["name", "above", "below", "group"],
  duplicate: ["name", "newName"],
  merge_down: ["name"],
  activate: ["name"],
};

/** Group path first, then plain name: the same lookup order as the Lua side. */
function findLayer(layers: LayerInfo[], name: string): LayerInfo | undefined {
  return layers.find((l) => l.path === name) ?? layers.find((l) => l.name === name);
}

function requireLayer(layers: LayerInfo[], name: string): LayerInfo {
  const layer = findLayer(layers, name);
  if (!layer) {
    throw new Error(`Layer "${name}" not found. Layers: ${layers.map((l) => l.path).join(", ") || "none"}`);
  }
  return layer;
}

function requireGroup(layers: LayerInfo[], name: string): LayerInfo {
  const group = requireLayer(layers, name);
  if (!group.isGroup) throw new Error(`"${name}" is not a group; create one with action 'add' and isGroup: true`);
  return group;
}

// Duplicate names make every later "name" argument ambiguous, so refuse them up front.
function requireFreeName(layers: LayerInfo[], name: string): void {
  if (layers.some((l) => l.name === name)) throw new Error(`A layer named "${name}" already exists; choose another name`);
}

/**
 * Validates one manage_layers call against the current layers and builds the protocol
 * layer_op. Existing layers are passed on by full path so nested names are unambiguous.
 */
export function toLayerOp(args: ManageLayersArgs, layers: LayerInfo[]): LayerOp {
  rejectUnusedArgs(args.action, args, LAYER_PARAMS[args.action]);
  switch (args.action) {
    case "add": {
      requireFreeName(layers, args.name);
      const group = args.group ? requireGroup(layers, args.group).path : undefined;
      const above = args.above ? requireLayer(layers, args.above).path : undefined;
      return { op: "add", name: args.name, group, above, isGroup: args.isGroup };
    }
    case "delete": {
      const layer = requireLayer(layers, args.name);
      if (layers.length === 1) throw new Error(`Cannot delete "${layer.path}": a sprite needs at least one layer`);
      return { op: "delete", name: layer.path };
    }
    case "update": {
      const layer = requireLayer(layers, args.name);
      const { newName, visible, opacity, blendMode, editable } = args;
      if ([newName, visible, opacity, blendMode, editable].every((v) => v === undefined)) {
        throw new Error("update needs at least one of newName, visible, opacity, blendMode, editable");
      }
      if (newName !== undefined && newName !== layer.name) requireFreeName(layers, newName);
      return { op: "update", name: layer.path, newName, visible, opacity, blendMode, editable };
    }
    case "move": {
      const layer = requireLayer(layers, args.name);
      if (args.above === undefined && args.below === undefined && args.group === undefined) {
        throw new Error('move needs above, below or group (group "" moves it to the top level)');
      }
      if (args.above !== undefined && args.below !== undefined) throw new Error("move takes either above or below, not both");
      const anchorName = args.above ?? args.below;
      const anchor = anchorName === undefined ? undefined : requireLayer(layers, anchorName);
      if (anchor?.path === layer.path) throw new Error("A layer cannot be moved relative to itself");
      let group: string | undefined;
      if (args.group !== undefined && args.group !== "") {
        group = requireGroup(layers, args.group).path;
        if (group === layer.path || group.startsWith(`${layer.path}/`)) {
          throw new Error(`Cannot move "${layer.path}" into itself`);
        }
      } else if (args.group === "") {
        group = "";
      }
      return {
        op: "move",
        name: layer.path,
        group,
        above: args.above !== undefined ? anchor?.path : undefined,
        below: args.below !== undefined ? anchor?.path : undefined,
      };
    }
    case "duplicate": {
      const layer = requireLayer(layers, args.name);
      if (args.newName !== undefined) requireFreeName(layers, args.newName);
      return { op: "duplicate", name: layer.path, newName: args.newName };
    }
    case "merge_down": {
      const layer = requireLayer(layers, args.name);
      if (layer.stackIndex <= 1) {
        const where = layer.parent ? ` of group "${layer.parent}"` : "";
        throw new Error(`"${layer.path}" is the bottom layer${where}; there is nothing below it to merge into`);
      }
      return { op: "merge_down", name: layer.path };
    }
    case "activate":
      return { op: "activate", name: requireLayer(layers, args.name).path };
  }
}

/** Compact view of the layer stack so the model sees the effect of its change. */
export function layerSummary(info: SpriteInfo) {
  return info.layers.map((l) => ({
    name: l.name,
    ...(l.parent ? { path: l.path } : {}),
    ...(l.isGroup ? { group: true } : {}),
    visible: l.isVisible,
    opacity: l.opacity,
    blendMode: l.blendMode,
    ...(l.isEditable ? {} : { locked: true }),
  }));
}

export const registerLayerTools: ToolRegistrar = (server, { gateway }) => {
  server.registerTool(
    "manage_layers",
    {
      title: "Manage layers",
      description:
        "Add, delete, change, reorder, duplicate, merge down or activate a layer (one undo step). " +
        "Keep your work on its own layer (e.g. add \"AI\" or \"Shading\") so the user's layers stay " +
        "intact; drawing tools also create a missing layer on first write. Layers are addressed by " +
        "name or \"Group/Layer\" path. Actions:\n" +
        "- add: name, optional group (inside it), above (right above that layer), isGroup\n" +
        "- update: newName, visible, opacity (0-255), blendMode, editable (false = locked)\n" +
        "- move: above or below another layer, or group (\"\" = top level)\n" +
        "- duplicate: optional newName; merge_down: into the layer below; delete; activate\n" +
        "Returns the resulting layer stack, bottom to top.",
      inputSchema: {
        action: z.enum(LAYER_ACTIONS).describe("What to do; each action uses only the arguments listed above."),
        name: z.string().min(1).describe("The layer to act on (add: the new layer's name)."),
        newName: z.string().min(1).optional().describe("update: rename to this; duplicate: name of the copy."),
        group: z.string().optional().describe('add/move: put the layer inside this group; move with "" = top level.'),
        above: z.string().optional().describe("add/move: place directly above this layer."),
        below: z.string().optional().describe("move: place directly below this layer."),
        isGroup: z.boolean().optional().describe("add: create a group instead of an image layer."),
        visible: z.boolean().optional().describe("update: show or hide."),
        opacity: z.number().int().min(0).max(255).optional().describe("update: 0 (invisible) to 255 (opaque)."),
        blendMode: z.enum(BLEND_MODES).optional().describe("update: layer blend mode."),
        editable: z.boolean().optional().describe("update: false locks the layer against edits."),
      },
    },
    async (args) => {
      const before = await gateway.getSpriteInfo();
      const op = toLayerOp(args, before.layers);
      const { layer } = await gateway.layerOp(op);
      const after = await gateway.getSpriteInfo();
      return jsonResult({
        ok: true,
        action: args.action,
        ...(layer ? { layer } : {}),
        ...(after.activeLayer ? { activeLayer: after.activeLayer } : {}),
        layers: layerSummary(after),
        order: "bottom to top",
      });
    },
  );
};
