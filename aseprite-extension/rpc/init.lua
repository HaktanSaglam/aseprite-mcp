-- Method registry: every module returns a table of handlers keyed by protocol method
-- name (docs/PROTOCOL.md). dispatch() is what the connection calls for each request.

return function(load, U)
  local methods = {}

  local function register(module)
    for name, fn in pairs(module) do
      -- Lower-case snake_case names are protocol methods; helpers are camelCase.
      if name:match("^[a-z_]+$") then methods[name] = fn end
    end
  end

  register(load("rpc/sprite.lua")(U))
  register(load("rpc/image.lua")(U))
  register(load("rpc/selection.lua")(U))
  register(load("rpc/layers.lua")(U))
  register(load("rpc/frames.lua")(U))
  register(load("rpc/palette.lua")(U))

  local R = {}

  function R.dispatch(method, params)
    local fn = methods[method]
    if not fn then error("Unknown method: " .. tostring(method)) end
    return fn(params or {})
  end

  function R.methodNames()
    local names = {}
    for name in pairs(methods) do names[#names + 1] = name end
    table.sort(names)
    return names
  end

  return R
end
