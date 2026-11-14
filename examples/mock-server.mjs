// Local demonstration only. No external connections or state-changing tools.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const version = process.argv[2];
if (!['baseline', 'candidate'].includes(version)) throw new Error('Use baseline or candidate.');
const { tools } = JSON.parse(await readFile(new URL(`./${version}.json`, import.meta.url), 'utf8'));
let initialized = false;
const result = (id, value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: value }) + '\n');
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    result(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'upgrade-check-demo', version } });
  } else if (request.method === 'notifications/initialized') initialized = true;
  else if (!Object.hasOwn(request, 'id')) continue;
  else if (!initialized) error(request.id, -32000, 'Initialize the session first.');
  else if (request.method === 'tools/list') {
    const offset = request.params?.cursor === 'page-2' ? 2 : 0;
    result(request.id, { tools: tools.slice(offset, offset + 2), ...(offset === 0 ? { nextCursor: 'page-2' } : {}) });
  } else if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params;
    if (!tools.some(t => t.name === name)) { error(request.id, -32602, 'Unknown tool.'); continue; }
    if (name === 'lookup_item') {
      result(request.id, content({ id: args.id, name: 'Demo item', price: version === 'baseline' ? 19.99 : 1999, currency: 'EUR' }));
    } else if (name === 'search_items') {
      if (version === 'candidate' && (!Number.isInteger(args.limit) || args.mode === 'prefix'))
        result(request.id, { content: [{ type: 'text', text: 'A positive limit and exact mode are now required.' }], isError: true });
      else result(request.id, content({ items: [{ id: 'demo-1' }] }));
    } else result(request.id, content({ status: 'ok', checkedAt: new Date().toISOString() }));
  } else error(request.id, -32601, 'Unknown method.');
}
