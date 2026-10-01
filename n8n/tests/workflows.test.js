// Static checks on the generated workflow JSON (n8n/workflows*).
//  - every Code node compiles (as the body of an async function, like n8n runs it)
//  - no two top-level declarations collide inside one Code node after inlining
//  - every node referenced with $('Name') exists in the same workflow
//  - parameterised webhook ids match the Caddyfile rewrites
// Run: node --test n8n/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const files = ['workflows', 'workflows-test'].flatMap((d) =>
  fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.json')).map((f) => path.join(root, d, f)));

for (const file of files) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = new Set(wf.nodes.map((n) => n.name));
  test(`${path.basename(file)}: Code nodes compile and node references resolve`, () => {
    for (const n of wf.nodes) {
      const js = n.parameters && n.parameters.jsCode;
      if (js) {
        assert.doesNotThrow(() => new vm.Script(`(async function () {\n${js}\n})`, { filename: `${wf.name}/${n.name}` }),
          `${n.name} does not compile`);
        assert.ok(!/^\/\* @include /m.test(js), `${n.name}: include marker left`);
        assert.ok(!/__[A-Z]+__/.test(js), `${n.name}: placeholder left`);
        // Globals that n8n's JS task runner does not provide (it provides Buffer, TextDecoder,
        // timers, btoa/atob, FormData; see @n8n/task-runner getNativeVariables)
        for (const re of [/\bnew URL\(/, /\bURLSearchParams\b/, /\brequire\(/, /\bprocess\./, /\bfetch\(/]) {
          assert.ok(!re.test(js), `${n.name}: uses ${re} which the task runner does not provide`);
        }
      }
      const text = JSON.stringify(n.parameters);
      for (const m of text.matchAll(/\$\('([^']+)'\)/g)) {
        assert.ok(names.has(m[1]), `${n.name} references missing node '${m[1]}'`);
      }
    }
    for (const src of Object.keys(wf.connections)) assert.ok(names.has(src), `connection from missing node ${src}`);
    for (const outs of Object.values(wf.connections)) {
      for (const list of outs.main) for (const c of list) assert.ok(names.has(c.node), `connection to missing node ${c.node}`);
    }
  });
}

test('parameterised routes: Caddyfile rewrites use the webhook ids of the workflows', () => {
  const caddy = fs.readFileSync(path.join(root, '..', 'infra', 'caddy', 'Caddyfile'), 'utf8');
  for (const file of files) {
    const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.webhook')) {
      if (!n.parameters.path.includes(':')) continue;
      assert.ok(caddy.includes(`/webhook/${n.webhookId}{uri}`), `${wf.name}: no Caddyfile rewrite for webhook ${n.webhookId}`);
    }
  }
});
