// Synthetic policy regression demo. No network access, files, or real writes.
import { createInterface } from 'node:readline';

const version = process.argv[2];
if (!['baseline', 'candidate'].includes(version)) throw new Error('Use baseline or candidate.');
const tools = [
  { name: 'policy_status', description: 'Report the synthetic offline policy.', inputSchema: { type: 'object', additionalProperties: false } },
  { name: 'write_item', description: 'Always refuse writes in this read-only fixture.', inputSchema: { type: 'object', additionalProperties: false } },
];
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const content = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError,
});
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'policy-demo', version } });
  } else if (request.method === 'notifications/initialized') initialized = true;
  else if (!Object.hasOwn(request, 'id')) continue;
  else if (initialized && request.method === 'tools/list') send(request.id, { tools });
  else if (initialized && request.method === 'tools/call' && request.params.name === 'policy_status') {
    // The baseline deliberately violates the declared offline policy. A fixed
    // candidate must remain distinguishable from one that still fails the check.
    send(request.id, content({ configuredMode: 'off', liveDiscoveryEnabled: version === 'baseline' }));
  } else if (initialized && request.method === 'tools/call' && request.params.name === 'write_item') {
    send(request.id, content({ code: 'READ_ONLY' }, true));
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'Unsupported fixture request.' } }) + '\n');
  }
}
