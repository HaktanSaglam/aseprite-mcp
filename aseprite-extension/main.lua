-- Entry point: wires modules together and registers menu commands.

local VERSION = "1.0.0"
local PROTOCOL = 2
local DEFAULT_PORT = 7801

local connection
local window

local function bridgeUrl(prefs)
  return "ws://127.0.0.1:" .. tostring(prefs.port)
end

function init(plugin)
  local prefs = plugin.preferences
  prefs.port = prefs.port or DEFAULT_PORT

  local function load(file)
    return dofile(app.fs.joinPath(plugin.path, file))
  end

  local U = load("core/util.lua")
  connection = load("connection.lua")
  local rpc = load("rpc/init.lua")(load, U)

  local hello = { extensionVersion = VERSION, protocol = PROTOCOL }
  local function connect()
    connection.start(bridgeUrl(prefs), rpc.dispatch, hello)
  end

  window = load("ui/main_window.lua")({
    connection = connection,
    prefs = prefs,
    load = load,
    version = VERSION,
    -- The Settings tab changes prefs.port and reconnects through this.
    reconnect = connect,
  })
  connect()

  plugin:newMenuGroup{
    id = "aseprite_mcp_group",
    title = "Aseprite MCP",
    group = "edit_fx",
  }

  -- The window also shows the bridge status; a modal alert would block incoming
  -- bridge requests for as long as it stays open.
  plugin:newCommand{
    id = "AsepriteMcpAssistant",
    title = "AI Assistant...",
    group = "aseprite_mcp_group",
    onclick = function() window.open() end,
  }

  plugin:newCommand{
    id = "AsepriteMcpGenerate",
    title = "Generate Sprite...",
    group = "aseprite_mcp_group",
    onclick = function() window.open("generate") end,
  }

  plugin:newCommand{
    id = "AsepriteMcpTools",
    title = "Pixel Tools...",
    group = "aseprite_mcp_group",
    onclick = function() window.open("tools") end,
  }

  plugin:newCommand{
    id = "AsepriteMcpReconnect",
    title = "Reconnect Bridge",
    group = "aseprite_mcp_group",
    onclick = connect,
  }
end

function exit(plugin)
  -- Closing first stores the window position and the last choices in the prefs.
  if window then pcall(window.close) end
  if connection then connection.stop() end
end
