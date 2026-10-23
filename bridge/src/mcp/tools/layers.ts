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

// "/" separates group and layer in every path argument, so a name containing it could never be addressed.
function requireNameWithoutSlash(name: string, action: string): void {
  if (!name.includes("/")) return;
  throw new Error(
    `Layer names cannot contain "/" ("${name}"): it separates group and layer in paths like "Group/Layer". ` +
      `'${action}' keeps the layer where it is; to put it into a group use action 'move' with group.`,
  );
}

/**
 * Where an add puts the new layer. Every tool addresses nested layers as "Group/Layer",
 * so add accepts that form too: the last part names the new layer, the rest is an
 * existing group.
 */
function newLayerPlace(args: ManageLayersArgs, layers: LayerInfo[]): { name: string; group?: string } {
  const slash = args.name.lastIndexOf("/");
  if (slash < 0) return { name: args.name, group: args.group ? requireGroup(layers, args.group).path : undefined };

  const parent = args.name.slice(0, slash);
  const name = args.name.slice(slash + 1);
  if (!parent || !name) throw new Error(`"${args.name}" is not a layer path; use "Group/Layer" or a plain name`);
  if (args.group) throw new Error(`Name the group either in name ("${args.name}") or in group ("${args.group}"), not both`);
  if (!findLayer(layers, parent)) {
    throw new Error(`Group "${parent}" does not exist. Create it first: action 'add', name "${parent}", isGroup: true.`);
  }
  return { name, group: requireGroup(layers, parent).path };
}

/** The sibling directly below, which merge_down merges into. */
function layerBelow(layers: LayerInfo[], layer: LayerInfo): LayerInfo | undefined {
  return layers.find((l) => l.parent === layer.parent && l.stackIndex === layer.stackIndex - 1);
}

// Aseprite's Merge Down silently does nothing for groups, so explain it before trying.
function requireMergeable(layers: LayerInfo[], layer: LayerInfo): void {
  if (layer.stackIndex <= 1) {
    const where = layer.parent ? ` of group "${layer.parent}"` : "";
    throw new Error(`"${layer.path}" is the bottom layer${where}; there is nothing below it to merge into`);
  }
  if (layer.isGroup) {
    throw new Error(`"${layer.path}" is a group; merge_down only merges an image layer into the image layer below it`);
  }
  const below = layerBelow(layers, layer);
  if (below?.isGroup) {
    throw new Error(
      `The layer below "${layer.path}" is the group "${below.path}"; merge_down only merges into an image layer. ` +
        "Move the layer first (action 'move' with above, below or group).",
    );
  }
}

/**
 * Validates one manage_layers call against the current layers and builds the protocol
 * layer_op. Existing layers are passed on by full path so nested names are unambiguous.
 */
export function toLayerOp(args: ManageLayersArgs, layers: LayerInfo[]): LayerOp {
  rejectUnusedArgs(args.action, args, LAYER_PARAMS[args.action]);
  switch (args.action) {
    case "add": {
      const { name, group } = newLayerPlace(args, layers);
      requireFreeName(layers, name);
      const above = args.above ? requireLayer(layers, args.above).path : undefined;
      return { op: "add", name, group, above, isGroup: args.isGroup };
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
      if (newName !== undefined && newName !== layer.name) {
        requireNameWithoutSlash(newName, "update");
        requireFreeName(layers, newName);
      }
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
      if (args.newName !== undefined) {
        requireNameWithoutSlash(args.newName, "duplicate");
        requireFreeName(layers, args.newName);
      }
      return { op: "duplicate", name: layer.path, newName: args.newName };
    }
    case "merge_down": {
      const layer = requireLayer(layers, args.name);
      requireMergeable(layers, layer);
      return { op: "merge_down", name: layer.path };
    }
    case "activate":
      return { op: "activate", name: requireLayer(layers, args.name).path };
  }
}

/**
 * Aseprite refuses some merges without an error (tilemaps, reference layers, ...). A merge
 * that happened always removes one layer, so an unchanged count means nothing was merged.
 */
function checkMerged(name: string, before: SpriteInfo, after: SpriteInfo): void {
  if (after.layers.length < before.layers.length) return;
  const layer = requireLayer(before.layers, name);
  const below = layerBelow(before.layers, layer)?.path ?? "the layer below";
  throw new Error(
    `Aseprite did not merge "${layer.path}" into "${below}"; nothing changed. It only merges a plain image ` +
      "layer into the plain image layer directly below it (no groups, tilemaps or reference layers).",
  );
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
        "- add: name (\"Group/Name\" creates it inside that existing group), optional group, above (right above that layer), isGroup\n" +
        "- update: newName, visible, opacity (0-255), blendMode, editable (false = locked)\n" +
        "- move: above or below another layer, or group (\"\" = top level)\n" +
        "- duplicate: optional newName; merge_down: into the layer below; delete; activate\n" +
        "Returns the resulting layer stack, bottom to top.",
      inputSchema: {
        action: z.enum(LAYER_ACTIONS).describe("What to do; each action uses only the arguments listed above."),
        name: z
          .string()
          .min(1)
          .describe('The layer to act on (add: the new layer\'s name, or "Group/Name" inside an existing group).'),
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
      if (op.op === "merge_down") checkMerged(op.name, before, after);
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
