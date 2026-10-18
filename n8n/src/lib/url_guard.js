// Server-side request forgery guard (backend spec 15.4, platform P12, D-111): a workflow that fetches a URL taken
// from data (knowledge-base sources) refuses addresses inside the stack or the local network before any request.
// Refused: schemes other than http and https, user:password@ in the URL, localhost and *.localhost, *.local,
// *.internal, names without a dot (Docker service names such as postgres, n8n, garage), and IP literals that are
// loopback, private, link-local, carrier-grade NAT, unspecified, multicast or reserved, in IPv4 or IPv6 (including
// IPv4-mapped IPv6 and the decimal/hex/octal forms of IPv4). Not covered here: a public name whose DNS answer is a
// private address, and redirects (D-111 says how far this goes).

function ipv4Parts(host) {
  // dotted with 1 to 4 parts, each decimal, 0x hex or 0-led octal, as inet_aton accepts them
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255)) return null;
  const width = 4 - nums.length;
  if (last >= 256 ** width) return null;
  const out = [...nums];
  for (let i = width - 1; i >= 0; i--) out.push(Math.floor(last / 256 ** i) % 256);
  return out;
}

function ipv4Blocked([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Blocked(h) {
  const s = h.toLowerCase();
  if (s === '::' || s === '::1') return true;
  const mapped = /^::ffff:(?:0:)?([0-9.]+)$/.exec(s) || /^::([0-9.]+)$/.exec(s);
  if (mapped) { const p = ipv4Parts(mapped[1]); return !p || ipv4Blocked(p); }
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return ipv4Blocked([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || s.startsWith('2001:db8:');
}

/** null when the URL may be fetched, else the reason (a short code). */
function urlRefusal(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(String(url || '').trim());
  if (!m) return 'not_a_url';
  if (!/^https?$/i.test(m[1])) return 'scheme';
  let auth = m[2];
  if (auth.includes('@')) return 'credentials_in_url';
  let host;
  if (auth.startsWith('[')) {
    const e = auth.indexOf(']');
    if (e < 0) return 'not_a_url';
    host = auth.slice(1, e).replace(/%.*$/, '');
    return ipv6Blocked(host) ? 'internal_address' : null;
  }
  host = auth.replace(/:\d*$/, '').replace(/\.$/, '').toLowerCase();
  if (!host) return 'not_a_url';
  const v4 = ipv4Parts(host);
  if (v4) return ipv4Blocked(v4) ? 'internal_address' : null;
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return 'internal_address';   // a number that is not a valid address
  if (!host.includes('.')) return 'internal_name';
  if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) return 'internal_name';
  return null;
}

if (typeof module !== 'undefined') module.exports = { urlRefusal };
