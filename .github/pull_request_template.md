## What and why

<!-- What does this change and which problem does it solve? Link issues: "Fixes #123". -->

## How it was tested

- [ ] `cd bridge && npm run typecheck && npm test`
- [ ] Lua changes: headless tests with `aseprite -b ... --script tests/rpc_test.lua` (see CONTRIBUTING.md)
- [ ] Tried it in Aseprite: <!-- what did you draw / click? -->

## Checklist

- [ ] Bridge ↔ Aseprite protocol changes are reflected in `docs/PROTOCOL.md` and on both sides
- [ ] New or changed MCP tools have precise descriptions and `.describe()` on every parameter
- [ ] User-visible changes are listed under `## [Unreleased]` in `CHANGELOG.md`
- [ ] Screenshots or a short GIF for UI changes
