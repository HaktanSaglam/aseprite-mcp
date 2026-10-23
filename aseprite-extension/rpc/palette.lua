-- Palette read/write. In indexed sprites pixels keep their indexes, so setting a
-- palette recolors the art (a palette swap).

return function(U)
  local M = {}

  function M.get_palette(p)
    local sprite = U.sprite(p)
    return { colors = U.paletteHex(sprite), transparentIndex = sprite.transparentColor }
  end

  function M.set_palette(p)
    local sprite = U.sprite(p)
    local colors = p.colors
    if not colors or #colors == 0 then error("colors must not be empty") end
    if #colors > 256 then error("A palette holds at most 256 colors") end
    U.transaction(sprite, "AI: palette", function()
      local palette = sprite.palettes[1]
      palette:resize(#colors)
      for i, hex in ipairs(colors) do
        palette:setColor(i - 1, U.hexToColor(hex))
      end
    end)
    app.refresh()
    return { ok = true, size = #colors }
  end

  return M
end
