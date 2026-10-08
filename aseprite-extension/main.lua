-- Entry point: wires modules together and registers menu commands.

local connection

local DEFAULT_PORT = 7801

local function load(plugin, file)
  return dofile(app.fs.joinPath(plugin.path, file))
end

local function bridgeUrl(plugin)
  return "ws://127.0.0.1:" .. tostring(plugin.preferences.port)
end

function init(plugin)
  plugin.preferences.port = plugin.preferences.port or DEFAULT_PORT

  connection = load(plugin, "connection.lua")
  local pixels = load(plugin, "pixels.lua")
  local handlers = load(plugin, "handlers.lua")(pixels)
  local textRender = load(plugin, "text_render.lua")
  local chat = load(plugin, "chat_dialog.lua")(connection, plugin.preferences, textRender)

  connection.start(bridgeUrl(plugin), handlers.dispatch)

  plugin:newMenuGroup{
    id = "claude_ai_group",
    title = "Claude AI",
    group = "edit_fx",
  }

  -- The chat window also shows the bridge status; a modal alert would block
  -- incoming bridge requests for as long as it stays open.
  plugin:newCommand{
    id = "ClaudeChat",
    title = "Claude Chat...",
    group = "claude_ai_group",
    onclick = function() chat.open() end,
  }

  plugin:newCommand{
    id = "ClaudeBridgeReconnect",
    title = "Reconnect Bridge",
    group = "claude_ai_group",
    onclick = function()
      connection.start(bridgeUrl(plugin), handlers.dispatch)
    end,
  }
end

function exit(plugin)
  if connection then connection.stop() end
end
