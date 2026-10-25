// Imported first by the server entry point so these flags are set before any
// CopilotKit module reads them. The runtime also reports the flag to the
// browser client, which then skips its own telemetry.
process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
process.env.DO_NOT_TRACK = '1';

// Secret redaction for text a Dot keeps (notes and saved memories). The patterns live in
// redaction.ts so the stores can use them without this file's startup side effects.
export { redactForStorage } from './redaction.js';
