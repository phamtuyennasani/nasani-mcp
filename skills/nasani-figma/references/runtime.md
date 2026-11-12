# Use the helper only when native NASANI tools are missing

`npx skills add phamtuyennasani/nasani-mcp -g` installs the skill and helper, not a running MCP server. For the first requested NASANI operation, the helper installs a persistent local runtime and registers project MCP. Later calls reuse it and check configuration without rerunning setup. Requires Git, Node.js >=22 and host shell approval.

Resolve the actual directory containing this skill; do not assume a username or install path. Call the needed operation directly with the selected absolute project path, tool name and JSON on stdin:

```sh
node "/absolute/path/to/nasani-figma/scripts/nasani.cjs" --project "/absolute/target-project" --client codex nasani_format <<'JSON'
{"directory":".nasani/hero","content_width":1200}
JSON
```

Use `--client claude` in Claude Code. Substitute the actual project-relative output directory and design-derived width. Supported operations: `nasani_environment`, `nasani_workflow`, `nasani_validate`, `nasani_format`, `nasani_assets`, `nasani_swiper_scripts`. Pass `{}` for an environment diagnostic; no environment call is required before format. The helper selects local mode and validates the requested root/configuration itself.

The runtime lives under `~/.local/share/nasani-mcp/runtime/`; calls use real MCP over STDIO. Native tools may need a client reload; continue the current task through this helper, then prefer native tools when available. JSON includes `isError`; nonzero exit indicates failure. It does not simulate validation or expose native tools in an already-running client.

Report actual dependency/install/configuration errors. Preserve custom config, bridge/remote connections and unrelated settings. Never bypass denied tools or change trust/approval settings. Only bootstrap for a requested NASANI operation. Figma uses the host's separate official connection and the developer's own account.
