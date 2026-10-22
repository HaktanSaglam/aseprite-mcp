-- Which AI providers/models/efforts the window offers. The bridge announces them in
-- bridge_info; until then (or with an older bridge that never does) the built-in Claude
-- list is used, so the window always has something sensible to show.

return function(C)
  local P = {}

  local function str(v)
    if type(v) == "string" then return v end
    if type(v) == "number" then return tostring(v) end
    return nil
  end

  local function copyProvider(p)
    local models, efforts = {}, {}
    for i, m in ipairs(p.models) do models[i] = { id = m.id, label = m.label } end
    for i, e in ipairs(p.efforts) do efforts[i] = e end
    return {
      id = p.id, label = p.label, models = models, efforts = efforts, defaultModel = p.defaultModel,
      available = p.available, note = p.note, supportsImages = p.supportsImages,
    }
  end

  -- json.decode returns userdata on which only field access, # and ipairs are safe, so
  -- copy the known fields into plain tables instead of keeping the userdata around.
  local function toProvider(raw)
    local id = str(raw.id)
    if not id or id == "" then return nil end
    local models = {}
    if raw.models ~= nil then
      for _, m in ipairs(raw.models) do
        local mid = str(m.id)
        if mid and mid ~= "" then models[#models + 1] = { id = mid, label = str(m.label) or mid } end
      end
    end
    local efforts = {}
    if raw.efforts ~= nil then
      for _, e in ipairs(raw.efforts) do
        local eid = str(e)
        if eid and eid ~= "" then efforts[#efforts + 1] = eid end
      end
    end
    return {
      id = id,
      label = str(raw.label) or id,
      models = models,
      efforts = efforts,
      defaultModel = str(raw.defaultModel),
      available = raw.available ~= false,
      note = str(raw.note),
      supportsImages = raw.supportsImages ~= false,
    }
  end

  function P.new()
    local list = {}
    for i, p in ipairs(C.FALLBACK_PROVIDERS) do list[i] = copyProvider(p) end
    return { list = list, defaultId = list[1].id, fromBridge = false, bridgeVersion = nil }
  end

  -- Returns true when the list changed. A malformed message keeps the previous list.
  function P.update(state, info)
    local ok, list = pcall(function()
      local out = {}
      if info == nil or info.providers == nil then return out end
      for _, raw in ipairs(info.providers) do
        local p = toProvider(raw)
        if p then out[#out + 1] = p end
      end
      return out
    end)
    if not ok or #list == 0 then return false end
    state.list = list
    state.fromBridge = true
    state.bridgeVersion = str(info.version)
    local default = str(info.defaultProvider)
    state.defaultId = (default and P.find(state, default)) and default or list[1].id
    return true
  end

  function P.find(state, id)
    if id == nil then return nil end
    for _, p in ipairs(state.list) do
      if p.id == id then return p end
    end
    return nil
  end

  local function firstAvailable(state)
    for _, p in ipairs(state.list) do
      if p.available then return p end
    end
    return state.list[1]
  end

  local function contains(list, value)
    for _, v in ipairs(list) do
      if v == value then return true end
    end
    return false
  end

  -- An effort the provider doesn't list falls back to "medium" (or its middle option),
  -- i.e. the balanced choice rather than the cheapest or the slowest.
  local function pickEffort(efforts, wanted)
    if #efforts == 0 then return nil end
    if wanted and contains(efforts, wanted) then return wanted end
    if contains(efforts, "medium") then return "medium" end
    return efforts[math.ceil(#efforts / 2)]
  end

  local function hasModel(provider, id)
    if id == nil then return false end
    for _, m in ipairs(provider.models) do
      if m.id == id then return true end
    end
    return false
  end

  -- The user's saved model while this provider still offers it, else the provider's
  -- own default: the list is ordered newest first, and the newest model is often the
  -- slowest and most expensive one.
  local function pickModel(provider, wanted)
    if #provider.models == 0 then return nil end
    if hasModel(provider, wanted) then return wanted end
    if hasModel(provider, provider.defaultModel) then return provider.defaultModel end
    return provider.models[1].id
  end

  -- sel = {provider?, model?, effort?} as stored in prefs; returns valid ids for them.
  function P.resolve(state, sel)
    sel = sel or {}
    local provider = P.find(state, sel.provider) or P.find(state, state.defaultId) or firstAvailable(state)
    return {
      provider = provider,
      model = pickModel(provider, sel.model),
      effort = pickEffort(provider.efforts, sel.effort),
    }
  end

  function P.providerOptions(state)
    local out = {}
    for i, p in ipairs(state.list) do
      out[i] = { id = p.id, label = p.available and p.label or (p.label .. " (not set up)") }
    end
    return out
  end

  function P.modelOptions(provider)
    if #provider.models == 0 then return { { id = nil, label = C.DEFAULT_LABEL } } end
    local out = {}
    for i, m in ipairs(provider.models) do out[i] = { id = m.id, label = m.label } end
    return out
  end

  function P.effortOptions(provider)
    if #provider.efforts == 0 then return { { id = nil, label = C.DEFAULT_LABEL } } end
    local out = {}
    for i, e in ipairs(provider.efforts) do out[i] = { id = e, label = C.effortLabel(e) } end
    return out
  end

  function P.modelLabel(provider, modelId)
    for _, m in ipairs(provider.models) do
      if m.id == modelId then return m.label end
    end
    return C.DEFAULT_LABEL
  end

  return P
end
