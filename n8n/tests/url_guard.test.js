// Server-side request forgery guard (backend spec 15.4, D-111): n8n/src/lib/url_guard.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { urlRefusal } = require('../src/lib/url_guard.js');

test('public sources pass', () => {
  for (const u of ['https://www.legislation.gov.uk/ukpga/1985/70/section/4', 'http://www.jurisitetunisie.com/tunisie/codes/coc/menu.html',
    'https://8.8.8.8/x', 'https://[2606:4700::1111]/', 'https://example.org:8443/a?b#c']) {
    assert.equal(urlRefusal(u), null, u);
  }
});

test('addresses inside the stack or the local network are refused', () => {
  const cases = {
    'http://localhost:5678/webhook/x': 'internal_name', 'http://n8n:5678/': 'internal_name', 'http://postgres/': 'internal_name',
    'http://garage:3900/flatshare-media/x': 'internal_name', 'http://api.localhost/': 'internal_name', 'http://printer.local/': 'internal_name',
    'http://metadata.google.internal/': 'internal_name', 'http://127.0.0.1/': 'internal_address', 'http://127.1/': 'internal_address',
    'http://2130706433/': 'internal_address', 'http://0x7f000001/': 'internal_address', 'http://0177.0.0.1/': 'internal_address',
    'http://10.0.0.5/': 'internal_address', 'http://172.20.0.3:8080/': 'internal_address', 'http://192.168.1.1/': 'internal_address',
    'http://169.254.169.254/latest/meta-data/': 'internal_address', 'http://100.64.0.1/': 'internal_address', 'http://0.0.0.0/': 'internal_address',
    'http://[::1]/': 'internal_address', 'http://[::ffff:127.0.0.1]/': 'internal_address', 'http://[::ffff:7f00:1]/': 'internal_address',
    'http://[fd00::1]/': 'internal_address', 'http://[fe80::1%25eth0]/': 'internal_address', 'http://999.1.1.1/': 'internal_address',
    'http://LOCALHOST./': 'internal_name',
  };
  for (const [u, why] of Object.entries(cases)) assert.equal(urlRefusal(u), why, u);
});

test('other schemes, credentials and junk are refused', () => {
  assert.equal(urlRefusal('file:///etc/passwd'), 'scheme');
  assert.equal(urlRefusal('gopher://example.org/'), 'scheme');
  assert.equal(urlRefusal('https://user:pw@example.org/'), 'credentials_in_url');
  assert.equal(urlRefusal('https://example.org@127.0.0.1/'), 'credentials_in_url');
  assert.equal(urlRefusal('not a url'), 'not_a_url');
  assert.equal(urlRefusal(''), 'not_a_url');
});
