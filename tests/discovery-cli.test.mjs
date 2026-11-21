import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check.mjs');
const fake = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [version, trace] = process.argv.slice(2);
const tools = ['search_actions', 'execute_action'].map(name => ({name,inputSchema:{type:'object'}}));
const send = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'nested-fixture',version}});
 if(m.method==='tools/list') send(m.id,{tools});
 if(m.method==='tools/call') {
  appendFileSync(trace,JSON.stringify({version,name:m.params.name})+'\n');
  send(m.id,m.params.name==='search_actions'
    ? {content:[],structuredContent:{actions:[{name:'lookup',description:'PRIVATE-DESCRIPTOR',input_schema:{type:'object',properties:{id:{type:version==='1'?'string':'integer'}},required:['id']}}]}}
    : {content:[],structuredContent:{value:'stable',private:'PRIVATE-RESULT'}});
 }
});
`;
const manifest = { sources: [{ id: 'nested', discoveryTool: 'search_actions', executionTool: 'execute_action', arguments: {},
  actionsPath: '/structuredContent/actions', fields: { name: 'name', description: 'description', inputSchema: 'input_schema' },
  completeness: { mode: 'unpaginated', allActionsRequested: true } }] };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-discovery-cli-'));
  t.after(async () => {
    const sub = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(sub.startsWith('mcp-discovery-cli-') && !sub.startsWith('..') && !isAbsolute(sub));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const save = (name, data) => writeFile(join(dir, name), JSON.stringify(data));
  await writeFile(join(dir, 'server.mjs'), fake);
  for (const v of ['1', '2']) await save(`${v}.json`, {command:process.execPath,args:[join(dir,'server.mjs'),v,join(dir,'trace.jsonl')],cwd:dir});
  await save('discovery.json', manifest);
  await save('cases.json', {cases:[{id:'known',tool:'execute_action',arguments:{action:'lookup',id:'PRIVATE-INPUT'},comparePaths:['/structuredContent/value']}]});
  const args = ['--before-config',join(dir,'1.json'),'--after-config',join(dir,'2.json'),'--discovery',join(dir,'discovery.json'),'--out',join(dir,'out.json')];
  return {dir,args};
}
function run(args) {
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
    child.on('error',reject); child.on('close',code=>done({code,stdout,stderr}));
  });
}

test('discovery CLI requires its execution gate and never invokes advertised actions',async t=>{
  const {dir,args}=await setup(t);
  const refused=await run(['discover',...args]);
  assert.equal(refused.code,2); await assert.rejects(readFile(join(dir,'trace.jsonl')),{code:'ENOENT'});
  const result=await run(['discover',...args,'--execute-discovery']);
  assert.equal(result.code,1,result.stderr);
  const report=JSON.parse(await readFile(join(dir,'out.json'),'utf8'));
  assert.equal(report.verdict,'contract_risk_detected');
  assert.equal(report.discovery.counts.before,1); assert.equal(report.discovery.counts.after,1);
  assert.ok(report.findings.some(f=>f.severity==='breaking'));
  const calls=(await readFile(join(dir,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.name),['search_actions','search_actions']);
  assert.doesNotMatch(JSON.stringify(report)+result.stdout+result.stderr,/PRIVATE-/);
});

test('combined replay discovers in the same sessions and preserves behavioral results',async t=>{
  const {dir,args}=await setup(t);
  const result=await run(['replay',...args,'--cases',join(dir,'cases.json'),'--execute-cases']);
  assert.equal(result.code,1,result.stderr);
  const report=JSON.parse(await readFile(join(dir,'out.json'),'utf8'));
  assert.equal(report.cases[0].status,'pass');
  assert.equal(report.verdict,'contract_risk_detected');
  const calls=(await readFile(join(dir,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls,[{version:'1',name:'search_actions'},{version:'1',name:'execute_action'},{version:'2',name:'search_actions'},{version:'2',name:'execute_action'}]);
  assert.doesNotMatch(JSON.stringify(report)+await readFile(join(dir,'out.md'),'utf8'),/PRIVATE-/);
});

test('offline action metadata comparison requires review and keeps values out of both reports', async t => {
  const {dir} = await setup(t);
  const metadataManifest = structuredClone(manifest);
  metadataManifest.sources[0].fields.metadata = { description: 'executionPolicy', read_only: 'readOnly' };
  await writeFile(join(dir, 'discovery.json'), JSON.stringify(metadataManifest));
  for (const version of ['before', 'after']) {
    const response = { nested: { content: [], structuredContent: { actions: [{
      name: 'lookup', input_schema: { type: 'object' },
      executionPolicy: `PRIVATE-${version}`, readOnly: version === 'before',
    }] } } };
    await writeFile(join(dir, `${version}-capture.json`), JSON.stringify(response));
  }
  const result = await run(['compare-actions', '--before', join(dir, 'before-capture.json'),
    '--after', join(dir, 'after-capture.json'), '--discovery', join(dir, 'discovery.json'),
    '--out', join(dir, 'out.json')]);
  assert.equal(result.code, 3, result.stderr);
  const report = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
  const markdown = await readFile(join(dir, 'out.md'), 'utf8');
  assert.equal(report.verdict, 'review_required');
  assert.equal(report.findings.length, 2);
  assert.ok(report.findings.every(f => f.code === 'action_metadata_changed' && f.severity === 'review'));
  assert.match(markdown, /Mapped action metadata changed/);
  assert.doesNotMatch(JSON.stringify(report) + markdown + result.stdout + result.stderr, /PRIVATE-/);
  await assert.rejects(readFile(join(dir, 'trace.jsonl')), {code: 'ENOENT'});
});
