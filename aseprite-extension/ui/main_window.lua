-- Temporary adapter: the redesigned window replaces this file.
return function(ctx)
  local textRender = ctx.load("ui/text_render.lua")
  return ctx.load("ui/chat_dialog.lua")(ctx.connection, ctx.prefs, textRender)
end
