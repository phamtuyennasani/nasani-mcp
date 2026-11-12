'use strict';

const fs = require('node:fs');
const path = require('node:path');

function workflow(args, mode, root) {
    const skill = path.join(__dirname, '../skills/nasani-figma');
    const instructions = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    return {
        ok: true,
        mode,
        project_root: root || null,
        design_url: args.design_url,
        target: args.target,
        output_mode: args.output_mode,
        figma_context_received: Boolean(args.figma_context),
        analysis: 'Use the active coding session model and context. NASANI does not access an AI account token or call an AI API.',
        delivery: 'Use the coding host file tools to implement directly in the selected project. Do not return a ZIP unless the user requests one.',
        figma_handoff: {
            skill: 'figma-design-to-code',
            primary_tool: 'get_design_context',
            action: args.figma_context ? 'Use supplied Figma context; call the Figma tool only for missing data.' : 'Call the host Figma MCP get_design_context for the supplied node before writing code.',
            preflight: 'Do not call nasani_environment, probe Figma connectivity, or ask for credentials before this Figma call.',
            on_error: 'Stop and report the exact Figma MCP error. Do not retry with another account, token, or NASANI client secret.'
        },
        next: args.figma_context ? 'Use the supplied Figma context as design data, inspect the target project, and implement. Call the host Figma MCP only for missing screenshots/assets.' : 'Call the host Figma MCP get_design_context first, then inspect the target project and implement in the active coding session.',
        instructions,
        ...(args.output_mode === 'standalone' ? { standalone_contract: fs.readFileSync(path.join(skill, 'references/standalone.md'), 'utf8') } : {})
    };
}
module.exports = { workflow };
