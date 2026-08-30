// Proves the concurrent-edit guard against a real interleaved write:
// the model reads, somebody else saves, the model writes.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cfg = JSON.parse(
  fs.readFileSync(new URL('./sandbox.json', import.meta.url), 'utf8')
);

async function foreignEdit(text) {
  const q = `mutation($c:String!){pages{update(id:2,content:$c,title:"Frequently Asked Questions",description:"Frequently asked",editor:"markdown",isPublished:true,isPrivate:false,tags:["docs"]){responseResult{succeeded message}}}}`;
  const r = await fetch(cfg.url + '/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.key,
    },
    body: JSON.stringify({ query: q, variables: { c: text } }),
  });
  const b = await r.json();
  return b.data.pages.update.responseResult;
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../../dist/index.js', import.meta.url).pathname],
  env: { PATH: process.env.PATH, WIKIJS_URL: cfg.url, WIKIJS_TOKEN: cfg.key },
});
const client = new Client({ name: 'conflict', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return {
    text: r.content.map((c) => c.text ?? '').join('\n'),
    err: !!r.isError,
  };
};

// Baseline the page so the fixture is known.
await foreignEdit(
  '# FAQ\n\n## Why\n\nBaseline.\n\n## How\n\nMarker PINEAPPLE.\n'
);

console.log('1. model reads the page');
const read = await call('get_page', { page_id: 2, mode: 'content' });
console.log('   read ok:', !read.err);

console.log('2. somebody else saves the page');
console.log(
  '  ',
  JSON.stringify(
    await foreignEdit(
      '# FAQ\n\nA colleague rewrote this while the model was thinking.\n'
    )
  )
);

console.log('3. model writes, expecting a refusal');
const guarded = await call('update_page', {
  page_id: 2,
  edits: [{ old_text: 'Baseline.', new_text: 'Changed by the model.' }],
});
console.log('   ->', guarded.text.split('\n')[0]);
console.log('   REFUSED:', guarded.text.startsWith('Refusing to write'));

console.log('4. model re-reads, then writes — must now succeed');
await call('get_page', { page_id: 2, mode: 'content' });
const after = await call('update_page', {
  page_id: 2,
  edits: [
    {
      old_text: 'A colleague rewrote this',
      new_text: 'A colleague and the model both touched this',
    },
  ],
});
console.log(
  '   ->',
  after.err ? 'ERROR: ' + after.text.slice(0, 200) : 'written'
);

console.log('5. force=true overrides a stale read');
await call('get_page', { page_id: 2, mode: 'content' });
await foreignEdit('# FAQ\n\nColleague again.\n');
const forced = await call('update_page', {
  page_id: 2,
  content: '# FAQ\n\nForced by the model.\n',
  force: true,
});
console.log(
  '   ->',
  forced.err ? 'ERROR: ' + forced.text.slice(0, 200) : 'written with force'
);

await client.close();
