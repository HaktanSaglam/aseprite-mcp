-- WebSocket client to the bridge.
--   bridge -> Aseprite requests: {id, method, params}; we reply {id, result} or {id, error}
--   either side may also send {event, ...} without an id (chat traffic, status).

local M = {}

local socket = nil
local listeners = {}
M.status = "disconnected"

local function emit(kind, payload)
  for _, fn in ipairs(listeners) do
    -- A broken listener (e.g. a closed dialog) must not break the connection.
    pcall(fn, kind, payload)
  end
end

local function setStatus(status)
  M.status = status
  emit("status", status)
end

-- Returns false instead of raising when not connected, so UI code can just report it.
function M.send(tbl)
  if not socket then return false end
  return pcall(function() socket:sendText(json.encode(tbl)) end)
end

-- fn(kind, payload): kind is "status" (payload = status string) or "event" (payload = message).
-- Returns a function that removes the listener.
function M.subscribe(fn)
  listeners[#listeners + 1] = fn
  return function()
    for i, f in ipairs(listeners) do
      if f == fn then table.remove(listeners, i) return end
    end
  end
end

local function handleText(data, dispatch)
  -- Aseprite's json.decode returns a table-like userdata, not a plain Lua table.
  local okDecode, msg = pcall(json.decode, data)
  if not okDecode or msg == nil then return end

  if msg.id == nil then
    if msg.event ~= nil then emit("event", msg) end
    return
  end

  local ok, result = pcall(dispatch, msg.method, msg.params)
  if ok then
    M.send({ id = msg.id, result = result })
  else
    -- "…/rpc/image.lua:42: Layer not found" → "Layer not found": the model reads these.
    M.send({ id = msg.id, error = (tostring(result):gsub("^[^\n]-%.lua:%d+: ", "")) })
  end
end

-- hello: extra fields sent on every (re)connect so the bridge knows who it talks to.
function M.start(url, dispatch, hello)
  M.stop()
  socket = WebSocket{
    url = url,
    deflate = false,
    -- The bridge may start after Aseprite; keep retrying quietly.
    minreconnectwait = 2,
    maxreconnectwait = 10,
    onreceive = function(messageType, data, errorInfo)
      if messageType == WebSocketMessageType.OPEN then
        setStatus("connected")
        local msg = { event = "hello", asepriteVersion = tostring(app.version) }
        for k, v in pairs(hello or {}) do msg[k] = v end
        M.send(msg)
      elseif messageType == WebSocketMessageType.CLOSE then
        setStatus("disconnected")
      elseif messageType == WebSocketMessageType.ERROR then
        setStatus("error: " .. tostring(errorInfo or data))
      elseif messageType == WebSocketMessageType.TEXT then
        handleText(data, dispatch)
      end
    end,
  }
  socket:connect()
end

function M.stop()
  if socket then
    socket:close()
    socket = nil
  end
  setStatus("disconnected")
end

return M
