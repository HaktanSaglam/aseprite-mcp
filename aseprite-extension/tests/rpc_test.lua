-- Headless tests for the RPC layer. Run with:
--   aseprite -b --script-param root=<path to aseprite-extension> --script tests/rpc_test.lua
-- Params go through json.decode exactly like WebSocket requests do, because its
-- userdata results (float numbers, table-like arrays) are what broke things before.

local root = app.params.root or "."
local function load(file) return dofile(app.fs.joinPath(root, file)) end

local U = load("core/util.lua")
local rpc = load("rpc/init.lua")(load, U)

local passed, failed = 0, 0

local function call(method, params)
  return rpc.dispatch(method, json.decode(json.encode(params or {})))
end

local function test(name, fn)
  local ok, err = pcall(fn)
  if ok then
    passed = passed + 1
  else
    failed = failed + 1
    print("FAIL " .. name .. ": " .. tostring(err))
  end
end

local function eq(actual, expected, what)
  if actual ~= expected then
    error(string.format("%s: expected %s, got %s", what or "value", tostring(expected), tostring(actual)), 2)
  end
end

local function expectError(fn, pattern)
  local ok, err = pcall(fn)
  if ok then error("expected an error matching " .. pattern, 2) end
  if not tostring(err):find(pattern) then error("unexpected error: " .. tostring(err), 2) end
end

test("create_sprite and get_sprite_info", function()
  local info = call("create_sprite", { width = 8, height = 6, colorMode = "rgb", frames = 2 })
  eq(info.width, 8, "width")
  eq(#info.frames, 2, "frames")
  eq(info.colorMode, "rgb")
  local again = call("get_sprite_info", { sprite = info.id })
  eq(again.id, info.id, "id")
  eq(#again.layers, 1, "layers")
end)

test("write_image then read_image round trip (rgba)", function()
  local info = call("create_sprite", { width = 4, height = 4 })
  -- 2x1 red, half-transparent blue at (1, 2)
  call("write_image", { x = 1, y = 2, width = 2, height = 1, layer = "AI", format = "rgba", data = "ff0000ff0000ff80" })
  local r = call("read_image", { layer = "AI" })
  eq(r.width, 4)
  eq(r.format, "rgba")
  local px = r.data:sub(((2 * 4 + 1) * 8) + 1, ((2 * 4 + 1) * 8) + 8)
  eq(px, "ff0000ff", "pixel (1,2)")
  local px2 = r.data:sub(((2 * 4 + 2) * 8) + 1, ((2 * 4 + 2) * 8) + 8)
  eq(px2, "0000ff80", "pixel (2,2)")
  eq(r.data:sub(1, 8), "00000000", "pixel (0,0)")
  -- region read with offset outside the canvas is padded with transparency
  local r2 = call("read_image", { layer = "AI", x = 0, y = 1, width = 3, height = 2 })
  eq(#r2.data, 3 * 2 * 8, "region size")
  eq(r2.data:sub(25 + 8, 32 + 8), "ff0000ff", "offset pixel")
end)

test("write_image replaces transparent pixels and trims the cel", function()
  local info = call("create_sprite", { width = 4, height = 4 })
  call("write_image", { x = 0, y = 0, width = 2, height = 1, layer = "L", format = "rgba", data = "ff0000ffff0000ff" })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, layer = "L", format = "rgba", data = "00000000" })
  local sprite = U.sprite({ sprite = info.id })
  local cel = U.requireLayer(sprite, "L"):cel(1)
  eq(cel.position.x, 1, "trimmed cel x")
  eq(cel.image.width, 1, "trimmed cel width")
  -- erasing everything removes the cel
  call("write_image", { x = 0, y = 0, width = 4, height = 4, layer = "L", format = "rgba", data = string.rep("00", 64) })
  eq(U.requireLayer(sprite, "L"):cel(1), nil, "cel removed")
end)

test("flattened read composites visible layers", function()
  call("create_sprite", { width = 2, height = 1 })
  call("write_image", { x = 0, y = 0, width = 2, height = 1, layer = "Bottom", format = "rgba", data = "00ff00ff00ff00ff" })
  call("write_image", { x = 1, y = 0, width = 1, height = 1, layer = "Top", format = "rgba", data = "ff0000ff" })
  local r = call("read_image", { flattened = true })
  eq(r.data, "00ff00ffff0000ff", "flattened")
  call("layer_op", { op = "update", name = "Top", visible = false })
  eq(call("read_image", { flattened = true }).data, "00ff00ff00ff00ff", "hidden layer skipped")
end)

test("indexed sprites read and write palette indexes", function()
  local info = call("create_sprite", { width = 2, height = 1, colorMode = "indexed" })
  call("set_palette", { colors = { "00000000", "ff0000", "00ff00" } })
  call("write_image", { x = 0, y = 0, width = 2, height = 1, format = "indexed", data = "0102" })
  local r = call("read_image", {})
  eq(r.format, "indexed")
  eq(r.data, "0102", "indexes")
  eq(r.palette[2], "ff0000ff", "palette entry")
  expectError(function()
    call("write_image", { x = 0, y = 0, width = 1, height = 1, format = "rgba", data = "ff0000ff" })
  end, "does not match")
end)

test("grayscale sprites use 2 bytes per pixel", function()
  call("create_sprite", { width = 1, height = 1, colorMode = "grayscale" })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, format = "gray", data = "80ff" })
  eq(call("read_image", {}).data, "80ff", "gray pixel")
end)

test("write_images is one undo step", function()
  local info = call("create_sprite", { width = 2, height = 2, frames = 2 })
  call("write_images", { writes = {
    { x = 0, y = 0, width = 1, height = 1, frame = 1, layer = "Anim", format = "rgba", data = "ff0000ff" },
    { x = 1, y = 1, width = 1, height = 1, frame = 2, layer = "Anim", format = "rgba", data = "00ff00ff" },
  } })
  local sprite = U.sprite({ sprite = info.id })
  local layer = U.requireLayer(sprite, "Anim")
  eq(layer:cel(1) ~= nil and layer:cel(2) ~= nil, true, "both frames drawn")
  call("undo", {})
  local after = U.findLayer(sprite, "Anim")
  eq(after == nil or (after:cel(1) == nil and after:cel(2) == nil), true, "undone together")
end)

test("selection ops", function()
  call("create_sprite", { width = 8, height = 8 })
  local r = call("set_selection", { op = "replace", rects = { { 1, 1, 2, 2 } } })
  eq(r.bounds.width, 2, "replace")
  r = call("set_selection", { op = "add", rects = { { 5, 5, 1, 1 } } })
  eq(r.bounds.width, 5, "add")
  local read = call("read_selection", { x = 0, y = 0, width = 3, height = 1 })
  eq(read.mask, "000", "row 0 mask")
  read = call("read_selection", { x = 0, y = 1, width = 4, height = 1 })
  eq(read.mask, "0110", "row 1 mask")
  r = call("set_selection", { op = "invert" })
  eq(r.bounds.width, 8, "invert")
  r = call("set_selection", { op = "none" })
  eq(r.isEmpty, true, "none")
  eq(call("read_selection", {}).isEmpty, true, "empty read")
end)

test("set_selection with many rects (color masks) is exact and fast", function()
  call("create_sprite", { width = 64, height = 64 })
  -- checkerboard: the worst case for run merging, 2048 one-pixel rects
  local rects = {}
  for y = 0, 63 do
    for x = y % 2, 63, 2 do rects[#rects + 1] = { x, y, 1, 1 } end
  end
  local t0 = os.clock()
  local r = call("set_selection", { op = "replace", rects = rects })
  local ms = (os.clock() - t0) * 1000
  eq(r.bounds.width, 64, "bounds")
  local read = call("read_selection", { x = 0, y = 0, width = 4, height = 2 })
  eq(read.mask, "10100101", "checkerboard mask")
  if ms > 500 then error(string.format("set_selection took %.0f ms for %d rects", ms, #rects)) end
end)

test("layer ops", function()
  call("create_sprite", { width = 4, height = 4 })
  call("layer_op", { op = "add", name = "Group", isGroup = true })
  call("layer_op", { op = "add", name = "Child", group = "Group" })
  local info = call("get_sprite_info", {})
  local child
  for _, l in ipairs(info.layers) do if l.name == "Child" then child = l end end
  eq(child.parent, "Group", "parent")
  eq(child.path, "Group/Child", "path")
  call("layer_op", { op = "update", name = "Child", newName = "Kid", opacity = 128, blendMode = "multiply" })
  info = call("get_sprite_info", {})
  for _, l in ipairs(info.layers) do if l.name == "Kid" then child = l end end
  eq(child.opacity, 128, "opacity")
  eq(child.blendMode, "multiply", "blend")
  call("layer_op", { op = "move", name = "Kid", group = "" })
  call("layer_op", { op = "duplicate", name = "Kid", newName = "Kid 2" })
  call("layer_op", { op = "delete", name = "Group" })
  info = call("get_sprite_info", {})
  local names = {}
  for _, l in ipairs(info.layers) do names[#names + 1] = l.name end
  eq(table.concat(names, ","), "Layer 1,Kid,Kid 2", "layer order")
  expectError(function() call("layer_op", { op = "delete", name = "Nope" }) end, "not found")
end)

test("frame and tag ops", function()
  call("create_sprite", { width = 2, height = 2 })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, format = "rgba", data = "ff0000ff" })
  local r = call("frame_op", { op = "add", count = 3, copy = true, durationMs = 120 })
  eq(r.frames, 4, "frames added")
  local info = call("get_sprite_info", {})
  eq(info.frames[4].durationMs, 120, "duration")
  eq(call("read_image", { frame = 4 }).data:sub(1, 8), "ff0000ff", "copied cel")
  call("frame_op", { op = "duration", durationMs = 80 })
  eq(call("get_sprite_info", {}).frames[2].durationMs, 80, "all durations")
  call("tag_op", { op = "add", name = "walk", from = 1, to = 3, direction = "pingpong" })
  info = call("get_sprite_info", {})
  eq(info.tags[1].name, "walk")
  eq(info.tags[1].direction, "pingpong")
  call("tag_op", { op = "update", name = "walk", newName = "run", to = 4 })
  eq(call("get_sprite_info", {}).tags[1].to, 4, "tag to")
  call("frame_op", { op = "delete", from = 2, to = 3 })
  eq(#call("get_sprite_info", {}).frames, 2, "deleted")
  expectError(function() call("frame_op", { op = "delete", from = 1, to = 2 }) end, "every frame")
end)

test("sprite ops", function()
  call("create_sprite", { width = 4, height = 2 })
  local info = call("sprite_op", { op = "resize", width = 8, height = 4 })
  eq(info.width, 8, "resize")
  info = call("sprite_op", { op = "canvas", right = 2, bottom = 1 })
  eq(info.width, 10, "canvas w")
  eq(info.height, 5, "canvas h")
  info = call("sprite_op", { op = "crop", x = 0, y = 0, width = 6, height = 5 })
  eq(info.width, 6, "crop")
  info = call("sprite_op", { op = "rotate", angle = 90 })
  eq(info.width, 5, "rotate")
  info = call("sprite_op", { op = "color_mode", mode = "indexed" })
  eq(info.colorMode, "indexed", "color mode")
end)

test("targets a background sprite by id", function()
  local a = call("create_sprite", { width = 2, height = 2 })
  call("create_sprite", { width = 3, height = 3 })
  call("write_image", { sprite = a.id, x = 0, y = 0, width = 1, height = 1, format = "rgba", data = "ff0000ff" })
  eq(call("read_image", { sprite = a.id }).data:sub(1, 8), "ff0000ff", "wrote to sprite a")
  eq(call("get_sprite_info", {}).width, 3, "active sprite unchanged")
  expectError(function() call("get_sprite_info", { sprite = 999999 }) end, "not open")
end)

test("export png and gif", function()
  call("create_sprite", { width = 2, height = 2, frames = 2 })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, format = "rgba", data = "ff0000ff" })
  local tmp = app.fs.tempPath
  local png = app.fs.joinPath(tmp, "amcp_test_export.png")
  call("export_sprite", { path = png, kind = "png", scale = 3, frame = 1 })
  eq(app.fs.isFile(png), true, "png written")
  local img = Image{ fromFile = png }
  eq(img.width, 6, "scaled png")
  -- Nearest-neighbour scaling: pixel art must stay crisp, no blended edge colors.
  eq(app.pixelColor.rgbaA(img:getPixel(2, 0)), 255, "scaled pixel keeps its color")
  eq(app.pixelColor.rgbaA(img:getPixel(3, 0)), 0, "next source pixel stays transparent")
  local sheet = app.fs.joinPath(tmp, "amcp_test_sheet.png")
  call("export_sprite", { path = sheet, kind = "sheet" })
  eq(Image{ fromFile = sheet }.width, 4, "sheet width")
end)

test("export png writes the requested frame (1-based)", function()
  call("create_sprite", { width = 2, height = 1, frames = 2 })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, frame = 2, format = "rgba", data = "ff0000ff" })
  local png = app.fs.joinPath(app.fs.tempPath, "amcp_test_frame2.png")
  call("export_sprite", { path = png, kind = "png", frame = 2 })
  local img = Image{ fromFile = png }
  eq(app.pixelColor.rgbaR(img:getPixel(0, 0)), 255, "frame 2 pixel")
  call("create_sprite", { width = 2, height = 1 })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, format = "rgba", data = "00ff00ff" })
  local single = app.fs.joinPath(app.fs.tempPath, "amcp_test_single.png")
  call("export_sprite", { path = single, kind = "png", frame = 1 })
  eq(app.pixelColor.rgbaG(Image{ fromFile = single }:getPixel(0, 0)), 255, "single-frame pixel")
end)

test("background layers keep pixels under transparent writes", function()
  local info = call("create_sprite", { width = 2, height = 1, background = "0000ffff" })
  local sprite = U.sprite({ sprite = info.id })
  app.transaction("bg", function() app.command.BackgroundFromLayer() end)
  local bg = sprite.layers[1]
  eq(bg.isBackground, true, "is background")
  call("write_image", { x = 0, y = 0, width = 2, height = 1, layer = bg.name, format = "rgba", data = "00000000ff0000ff" })
  eq(call("read_image", { layer = bg.name }).data, "0000ffffff0000ff", "transparent kept the blue pixel")
end)

test("refuses to delete the only layer and to write inside a locked group", function()
  call("create_sprite", { width = 2, height = 2 })
  expectError(function() call("layer_op", { op = "delete", name = "Layer 1" }) end, "only layer")
  call("layer_op", { op = "add", name = "G", isGroup = true })
  call("layer_op", { op = "add", name = "Inner", group = "G" })
  call("layer_op", { op = "update", name = "G", editable = false })
  expectError(function()
    call("write_image", { x = 0, y = 0, width = 1, height = 1, layer = "Inner", format = "rgba", data = "ff0000ff" })
  end, "locked group")
end)

test("export frames writes one padded file per frame", function()
  call("create_sprite", { width = 2, height = 1, frames = 3 })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, frame = 3, format = "rgba", data = "ff0000ff" })
  local base = app.fs.joinPath(app.fs.tempPath, "amcp_seq.png")
  call("export_sprite", { path = base, kind = "frames" })
  for f = 1, 3 do
    eq(app.fs.isFile(app.fs.joinPath(app.fs.tempPath, "amcp_seq-" .. f .. ".png")), true, "frame file " .. f)
  end
  local third = Image{ fromFile = app.fs.joinPath(app.fs.tempPath, "amcp_seq-3.png") }
  eq(app.pixelColor.rgbaR(third:getPixel(0, 0)), 255, "frame 3 content")
end)

local function layerPaths(info)
  local paths = {}
  for _, l in ipairs(info.layers) do paths[#paths + 1] = l.path end
  return table.concat(paths, ",")
end

-- A layer with one opaque pixel so read_image results are easy to compare.
local RED, GREEN, BLUE, CLEAR = "ff0000ff", "00ff00ff", "0000ffff", "00000000"

test("activeLayer is the layer path, and passing it back hits that layer", function()
  call("create_sprite", { width = 1, height = 1 })
  for _, group in ipairs({ "Body", "Head" }) do
    call("layer_op", { op = "add", name = group, isGroup = true })
    call("layer_op", { op = "add", name = "Shade", group = group })
  end
  call("layer_op", { op = "activate", name = "Head/Shade" })
  local info = call("get_sprite_info", {})
  eq(info.activeLayer, "Head/Shade", "active layer path")
  eq(layerPaths(info):find("Head/Shade", 1, true) ~= nil, true, "listed under the same path")
  local r = call("write_image", { x = 0, y = 0, width = 1, height = 1, layer = info.activeLayer, format = "rgba", data = RED })
  eq(r.layer, "Head/Shade", "write reports the path")
  eq(call("read_image", { layer = "Head/Shade" }).data, RED, "drawn on Head/Shade")
  eq(call("read_image", { layer = "Body/Shade" }).data, CLEAR, "Body/Shade untouched")
end)

test("an active group keeps default reads and writes inside it", function()
  call("create_sprite", { width = 1, height = 1 })
  call("layer_op", { op = "add", name = "Hero", isGroup = true })
  call("layer_op", { op = "add", name = "Body", group = "Hero" })
  call("layer_op", { op = "add", name = "Props", isGroup = true })
  call("layer_op", { op = "add", name = "Sword", group = "Props" })
  call("layer_op", { op = "activate", name = "Hero" })
  local r = call("write_image", { x = 0, y = 0, width = 1, height = 1, format = "rgba", data = RED })
  eq(r.layer, "Hero/Body", "write went into the active group")
  eq(call("read_image", {}).data, RED, "default read is the same layer")
  eq(call("read_image", { layer = "Props/Sword" }).data, CLEAR, "other group untouched")
  call("layer_op", { op = "add", name = "Empty", isGroup = true })
  call("layer_op", { op = "activate", name = "Empty" })
  expectError(function()
    call("write_image", { x = 0, y = 0, width = 1, height = 1, format = "rgba", data = RED })
  end, "Active layer is a group; pass layer")
  expectError(function() call("read_image", {}) end, "Active layer is a group; pass layer")
end)

test("duplicate with newName is one undo step, also on a background sprite", function()
  call("create_sprite", { width = 2, height = 2 })
  call("layer_op", { op = "add", name = "A" })
  local r = call("layer_op", { op = "duplicate", name = "A", newName = "A2" })
  eq(r.layer, "A2", "copy")
  eq(layerPaths(call("get_sprite_info", {})), "Layer 1,A,A2", "after duplicate")
  call("undo", {})
  eq(layerPaths(call("get_sprite_info", {})), "Layer 1,A", "one undo removes copy and rename")

  local bg = call("create_sprite", { width = 2, height = 2 })
  local front = call("create_sprite", { width = 3, height = 3 })
  call("layer_op", { sprite = bg.id, op = "duplicate", name = "Layer 1", newName = "Copy" })
  eq(layerPaths(call("get_sprite_info", { sprite = bg.id })), "Layer 1,Copy", "background duplicate")
  eq(call("get_sprite_info", {}).id, front.id, "user's tab stays active")
  call("undo", { sprite = bg.id })
  eq(layerPaths(call("get_sprite_info", { sprite = bg.id })), "Layer 1", "background undo in one step")
end)

test("merge_down merges image layers and refuses groups and the bottom layer", function()
  call("create_sprite", { width = 2, height = 1 })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, layer = "Layer 1", format = "rgba", data = RED })
  call("write_image", { x = 1, y = 0, width = 1, height = 1, layer = "Top", format = "rgba", data = GREEN })
  local r = call("layer_op", { op = "merge_down", name = "Top" })
  eq(r.layer, "Layer 1", "merged into the layer below")
  eq(layerPaths(call("get_sprite_info", {})), "Layer 1", "source layer gone")
  eq(call("read_image", { layer = "Layer 1" }).data, RED .. GREEN, "pixels merged")

  expectError(function() call("layer_op", { op = "merge_down", name = "Layer 1" }) end, "no layer below")
  call("layer_op", { op = "add", name = "G", isGroup = true })
  call("layer_op", { op = "add", name = "Above" })
  expectError(function() call("layer_op", { op = "merge_down", name = "Above" }) end, "group")
  expectError(function() call("layer_op", { op = "merge_down", name = "G" }) end, "group")
  eq(layerPaths(call("get_sprite_info", {})), "Layer 1,G,Above", "nothing changed")
end)

test("create_sprite rejects a bad background before opening a tab", function()
  local before = #app.sprites
  for _, bad in ipairs({ "yellow", "zz00zz", "fff", "ff00ff0" }) do
    expectError(function() call("create_sprite", { width = 2, height = 2, background = bad }) end, "Invalid color")
  end
  eq(#app.sprites, before, "no orphan sprite tabs")
  local info = call("create_sprite", { width = 1, height = 1, background = "#ff000080" })
  eq(call("read_image", { sprite = info.id }).data, "ff000080", "rrggbbaa background")
  eq(#app.sprites, before + 1, "one new sprite")
end)

test("write_image keeps cel pixels outside the canvas", function()
  local info = call("create_sprite", { width = 4, height = 4 })
  local sprite = U.sprite({ sprite = info.id })
  local layer = sprite.layers[1]
  local blue = Image(4, 4, ColorMode.RGB)
  blue:clear(Color{ r = 0, g = 0, b = 255, a = 255 })
  -- Columns 4 and 5 of the cel are off-canvas, like art moved partly off-screen.
  app.transaction("setup", function() sprite:newCel(layer, 1, blue, Point(2, 0)) end)
  call("write_image", { x = 0, y = 3, width = 1, height = 1, layer = "Layer 1", format = "rgba", data = RED })
  local cel = layer:cel(1)
  eq(cel.position.x, 0, "cel grows left to the write")
  eq(cel.image.width, 6, "off-canvas columns kept")
  eq(app.pixelColor.rgbaB(cel.image:getPixel(5, 0)), 255, "hidden pixel still blue")
  eq(app.pixelColor.rgbaR(cel.image:getPixel(0, 3)), 255, "written pixel")
  -- Incoming pixels outside the canvas are still ignored.
  call("create_sprite", { width = 4, height = 1 })
  call("write_image", { x = 3, y = 0, width = 2, height = 1, layer = "Clip", format = "rgba", data = RED .. RED })
  local clipCel = U.requireLayer(app.sprite, "Clip"):cel(1)
  eq(clipCel.bounds.x, 3, "clipped cel x")
  eq(clipCel.bounds.width, 1, "nothing written past the canvas edge")
end)

test("writing one frame of linked cels leaves the other frames unchanged", function()
  local info = call("create_sprite", { width = 2, height = 1, frames = 3 })
  local sprite = U.sprite({ sprite = info.id })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, frame = 1, layer = "Layer 1", format = "rgba", data = RED })
  local layer = sprite.layers[1]
  app.range.layers = { layer }
  app.range.frames = { sprite.frames[1], sprite.frames[2], sprite.frames[3] }
  app.command.LinkCels()
  eq(layer:cel(1).image.id, layer:cel(3).image.id, "cels linked")

  call("write_image", { x = 1, y = 0, width = 1, height = 1, frame = 2, layer = "Layer 1", format = "rgba", data = GREEN })
  eq(call("read_image", { frame = 2, layer = "Layer 1" }).data, RED .. GREEN, "frame 2 written")
  eq(call("read_image", { frame = 1, layer = "Layer 1" }).data, RED .. CLEAR, "frame 1 unchanged")
  eq(call("read_image", { frame = 3, layer = "Layer 1" }).data, RED .. CLEAR, "frame 3 unchanged")
  eq(layer:cel(1).image.id, layer:cel(3).image.id, "frames 1 and 3 still linked")

  -- Erasing a linked frame removes only that frame's cel.
  call("write_image", { x = 0, y = 0, width = 2, height = 1, frame = 3, layer = "Layer 1", format = "rgba", data = CLEAR .. CLEAR })
  eq(layer:cel(3), nil, "frame 3 cel removed")
  eq(call("read_image", { frame = 1, layer = "Layer 1" }).data, RED .. CLEAR, "frame 1 still intact")
end)

test("Group/Layer paths create the layer inside the existing group", function()
  call("create_sprite", { width = 1, height = 1 })
  call("layer_op", { op = "add", name = "Body", isGroup = true })
  local r = call("write_image", { x = 0, y = 0, width = 1, height = 1, layer = "Body/Outline", format = "rgba", data = RED })
  eq(r.layer, "Body/Outline", "write result")
  call("layer_op", { op = "add", name = "Body/Shading" })
  local info = call("get_sprite_info", {})
  eq(layerPaths(info), "Layer 1,Body,Body/Outline,Body/Shading", "nested, not top-level")
  for _, l in ipairs(info.layers) do
    if l.path == "Body/Outline" then eq(l.name, "Outline", "leaf name") end
  end
  expectError(function()
    call("write_image", { x = 0, y = 0, width = 1, height = 1, layer = "Nope/Outline", format = "rgba", data = RED })
  end, 'Group not found: "Nope"')
  expectError(function() call("layer_op", { op = "add", name = "Layer 1/X" }) end, "Not a group")
  eq(layerPaths(call("get_sprite_info", {})), "Layer 1,Body,Body/Outline,Body/Shading", "no stray layers")
end)

test("partial group paths find the nested layer instead of creating it again", function()
  call("create_sprite", { width = 2, height = 2 })
  call("layer_op", { op = "add", name = "Hero", isGroup = true })
  call("layer_op", { op = "add", name = "Body", isGroup = true, group = "Hero" })
  call("write_image", { x = 0, y = 0, width = 1, height = 1, layer = "Body/Outline", format = "rgba", data = "ff0000ff" })
  call("write_image", { x = 1, y = 0, width = 1, height = 1, layer = "Body/Outline", format = "rgba", data = "00ff00ff" })
  local count = 0
  for _, l in ipairs(call("get_sprite_info", {}).layers) do
    if l.name == "Outline" then count = count + 1; eq(l.path, "Hero/Body/Outline", "nested path") end
  end
  eq(count, 1, "one Outline layer")
  eq(call("read_image", { layer = "Body/Outline", width = 2, height = 1 }).data, "ff0000ff00ff00ff", "both writes landed")
  expectError(function() call("layer_op", { op = "update", name = "Hero/Body/Outline", newName = "A/B" }) end, "can't contain")
end)

test("export gif keeps frames, durations and scale, and leaves no extra tab", function()
  local info = call("create_sprite", { width = 2, height = 2, frames = 3 })
  call("layer_op", { op = "add", name = "Top" })
  call("tag_op", { op = "add", name = "loop", from = 1, to = 3 })
  call("frame_op", { op = "duration", durationMs = 120 })
  local before = #app.sprites
  local gif = app.fs.joinPath(app.fs.tempPath, "amcp_anim.gif")
  call("export_sprite", { path = gif, kind = "gif", scale = 2 })
  eq(#app.sprites, before, "temporary sprite closed")
  eq(app.sprite.id, info.id, "user's sprite active again")
  local back = Sprite{ fromFile = gif }
  eq(#back.frames, 3, "frames")
  eq(back.width, 4, "scaled")
  eq(math.floor(back.frames[2].duration * 1000 + 0.5), 120, "duration")
  back:close()
end)

print(string.format("%d passed, %d failed", passed, failed))
-- os.exit is disabled in Aseprite's Lua; a raised error makes the run fail instead.
if failed > 0 then error(failed .. " test(s) failed") end
