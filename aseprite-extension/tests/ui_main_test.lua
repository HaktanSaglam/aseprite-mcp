-- Smoke test for main.lua's wiring: menu commands, the window, reconnecting with a new
-- port and saving on exit. connection.lua is swapped for a fake so nothing touches the
-- network. Run with:
--   aseprite -b --script-param root=<path to aseprite-extension> --script tests/ui_main_test.lua

local root = app.params.root or "."
local function load(file) return dofile(app.fs.joinPath(root, file)) end

local Fakes = load("tests/ui_fakes.lua")
local restore = Fakes.install()

local passed, failed = 0, 0

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

local conn = Fakes.connection()
local starts = {}
local stopped = 0
function conn.start(url, dispatch, hello)
  starts[#starts + 1] = { url = url, dispatch = dispatch, hello = hello }
end
function conn.stop() stopped = stopped + 1 end

local realDofile = dofile
dofile = function(path)
  if path:match("connection%.lua$") then return conn end
  return realDofile(path)
end

local commands, groups = {}, {}
local plugin = {
  path = root,
  preferences = {},
  newMenuGroup = function(_, spec) groups[spec.id] = spec end,
  newCommand = function(_, spec) commands[spec.id] = spec end,
}

realDofile(app.fs.joinPath(root, "main.lua"))

test("init connects with the hello fields and registers the menu", function()
  init(plugin)
  eq(#starts, 1)
  eq(starts[1].url, "ws://127.0.0.1:7801")
  eq(starts[1].hello.protocol, 2)
  eq(type(starts[1].dispatch), "function")
  eq(plugin.preferences.port, 7801)
  eq(groups.aseprite_mcp_group.title, "Aseprite MCP")
  for _, id in ipairs({ "AsepriteMcpAssistant", "AsepriteMcpGenerate", "AsepriteMcpTools", "AsepriteMcpReconnect" }) do
    eq(commands[id].group, "aseprite_mcp_group", id)
  end
end)

test("menu commands open the window on the right tab", function()
  commands.AsepriteMcpGenerate.onclick()
  local dlg = Fakes.instances[#Fakes.instances]
  eq(dlg.shown, true)
  eq(dlg.data.tabs, "tab_generate")
  commands.AsepriteMcpTools.onclick()
  eq(Fakes.instances[#Fakes.instances], dlg, "same window")
  eq(dlg.data.tabs, "tab_tools")
end)

test("Settings > Reconnect uses the new port", function()
  local dlg = Fakes.instances[#Fakes.instances]
  dlg:_type("settingsPort", "7911")
  dlg:_click("settingsReconnect")
  eq(starts[#starts].url, "ws://127.0.0.1:7911")
  commands.AsepriteMcpReconnect.onclick()
  eq(starts[#starts].url, "ws://127.0.0.1:7911", "menu reconnect keeps it")
end)

test("exit closes the window, saving its place, and stops the connection", function()
  local dlg = Fakes.instances[#Fakes.instances]
  dlg._bounds = Rectangle(11, 22, 480, 590)
  exit(plugin)
  eq(dlg.closed, true)
  eq(plugin.preferences.ui_x, 11)
  eq(plugin.preferences.ui_w, 480)
  eq(plugin.preferences.tab, "tools")
  eq(stopped >= 1, true)
end)

dofile = realDofile
restore()
print(string.format("%d passed, %d failed", passed, failed))
-- os.exit is disabled in Aseprite's Lua; an error makes the run fail instead.
if failed > 0 then error(failed .. " main test(s) failed", 0) end
