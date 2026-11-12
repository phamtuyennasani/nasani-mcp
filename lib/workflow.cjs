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
        next: args.figma_context ? 'Use the supplied Figma context as design data, inspect the target project, and implement. Fetch missing screenshots/assets through the host Figma MCP.' : 'Use the host official Figma MCP to read the selected design context, screenshot and assets, then implement in the target project.',
        instructions,
        ...(args.output_mode === 'standalone' ? { standalone_contract: fs.readFileSync(path.join(skill, 'references/standalone.md'), 'utf8') } : {})
    };
}
module.exports = { workflow };
