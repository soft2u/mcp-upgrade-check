/** Exact serialized catalog sizes, without estimating tokens or task efficiency. */

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function inventory(tools) {
  if (!Array.isArray(tools)) throw new TypeError('Catalog metrics require tools arrays.');
  const sizes = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || sizes.has(tool.name))
      throw new TypeError('Catalog metrics require uniquely named tool objects.');
    sizes.set(tool.name, bytes(tool));
  }
  return sizes;
}

export function measureCatalogPayloads(before, after) {
  const oldSizes = inventory(before), newSizes = inventory(after);
  const beforeBytes = bytes(before), afterBytes = bytes(after);
  const largestIncreases = [...newSizes].map(([tool, afterBytes]) => ({
    tool, beforeBytes: oldSizes.get(tool) ?? 0, afterBytes,
    deltaBytes: afterBytes - (oldSizes.get(tool) ?? 0),
  })).filter(item => item.deltaBytes > 0)
    .sort((a, b) => b.deltaBytes - a.deltaBytes || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0))
    .slice(0, 5);
  return {
    catalogPayload: {
      unit: 'utf8_bytes', representation: 'compact_json_tools_array',
      beforeBytes, afterBytes, deltaBytes: afterBytes - beforeBytes,
      // An empty inventory has only array punctuation, not a meaningful catalog baseline.
      deltaPercent: before.length ? Math.round((afterBytes - beforeBytes) / beforeBytes * 10000) / 100 : null,
      largestIncreases,
      interpretation: 'Serialized catalog size only; not tokens, latency, or task efficiency.',
    },
  };
}
