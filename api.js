/*
 * api.js - REST client for the VP320/VP330 embedded API.
 *
 * Implements Digest access authentication (RFC 2617) in pure JS.
 * The player replies with a "WWW-Authenticate" (or "X-WWW-Authenticate" when the
 * request carries "X-Requested-With: XMLHttpRequest") challenge. We parse it,
 * compute the Authorization header and retry the request.
 *
 * Official endpoints (from the Waves System REST API doc):
 *   POST /api/auth/login
 *   POST /api/player/play|pause|stop|resume|play-folder?folder=N|set-volume?volume=N
 *   POST /api/power/standby|wakeup
 *   POST /api/display/standby|wakeup
 *   POST /api/videoprojector/poweron|poweroff
 *   POST /api/serial/send-frame
 *   WS   /api/events (WebSocket, JSON, filter param)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VPAPI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- MD5
  // Compact MD5 (RFC 1321). Uses arithmetic on 32-bit words.
  function md5(input) {
    function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
    function u32(a, b, c, d, x, s, t) {
      a = (a + b + x + t) >>> 0;
      return (rotl(a, s) + c) >>> 0;
    }
    function utf8(s) {
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      }
      return out;
    }
    const bytes = utf8(input);
    const bitLen = (bytes.length * 8) & 0xffffffff;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push((bitLen & 0xff), (bitLen >>> 8) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 24) & 0xff, 0, 0, 0, 0);
    // note: bit length above is length*8, we only pushed low 32 bits (fine for short strings)

    // little-endian words
    const words = [];
    for (let i = 0; i < bytes.length; i += 4) {
      words.push((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0);
    }

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
    const K = [
      0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
      0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
      0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
      0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
      0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
      0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
      0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
      0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    ];
    const S = [
      7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
      5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
      4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
      6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
    ];

    for (let i = 0; i < words.length; i += 16) {
      const X = words.slice(i, i + 16);
      let a = h0, b = h1, c = h2, d = h3;
      for (let j = 0; j < 64; j++) {
        let F, g;
        if (j < 16) { F = (b & c) | (~b & d); g = j; }
        else if (j < 32) { F = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
        else if (j < 48) { F = b ^ c ^ d; g = (3 * j + 5) % 16; }
        else { F = c ^ (b | ~d); g = (7 * j) % 16; }
        F = (F >>> 0);
        const tmp = d;
        d = c; c = b;
        b = (b + rotl((a + F + K[j] + X[g]) >>> 0, S[j])) >>> 0;
        a = tmp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    }
    return [h0, h1, h2, h3].map(w => {
      let hex = (w >>> 0).toString(16).padStart(8, '0');
      // each word is little-endian; output bytes LSB-first
      return hex.match(/../g).reverse().join('');
    }).join('');
  }

  // ------------------------------------------------------------ digest
  function parseChallenge(header) {
    // WWW-Authenticate: Digest realm="...", nonce="...", qop="auth", opaque="..."
    const m = /Digest\s+(.*)/i.exec(header || '');
    if (!m) return null;
    const c = {};
    const kv = /(\w+)\s*=\s*"([^"]*)"/g;
    let r;
    while ((r = kv.exec(m[1]))) c[r[1]] = r[2];
    return c;
  }

  function genCnonce() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function buildAuth(username, password, challenge, method, uri) {
    if (!challenge || !challenge.nonce) return null;
    const nc = '00000001';
    const cnonce = genCnonce();
    const qop = challenge.qop && challenge.qop.indexOf('auth') !== -1 ? 'auth' : '';
    const ha1 = md5(username + ':' + challenge.realm + ':' + password);
    const ha2 = md5(method.toUpperCase() + ':' + uri);
    let response;
    if (qop) response = md5(ha1 + ':' + challenge.nonce + ':' + nc + ':' + cnonce + ':' + qop + ':' + ha2);
    else response = md5(ha1 + ':' + challenge.nonce + ':' + ha2);

    let auth = 'Digest username="' + username + '", realm="' + challenge.realm + '", nonce="' + challenge.nonce + '"';
    auth += ', uri="' + uri + '", response="' + response + '"';
    if (challenge.opaque) auth += ', opaque="' + challenge.opaque + '"';
    if (qop) auth += ', qop=' + qop + ', nc=' + nc + ', cnonce="' + cnonce + '"';
    return auth;
  }

  // ------------------------------------------------------------- client
  function createClient(opts) {
    opts = opts || {};
    let username = opts.username || '';
    let password = opts.password || '';
    const base = opts.base || '';
    const challengeCache = {}; // uri -> challenge (per host)

    function setCredentials(u, p) { username = u; password = p; }

    async function request(path, method, query) {
      const queryStr = query ? '?' + new URLSearchParams(query).toString() : '';
      const uri = base + path + queryStr;

      // 1) first attempt WITHOUT auth header (probe) -> expect 401 challenge
      let res = await rawFetch(uri, method, null);
      if (res.status !== 401) return res;

      // 2) grab challenge
      let challengeHeader = res.headers.get('x-www-authenticate') || res.headers.get('www-authenticate');
      if (!challengeHeader) return res;
      const challenge = parseChallenge(challengeHeader);
      if (!challenge || !username || !password) return res;

      // 3) retry with Authorization. RFC 2617: the digest "uri" is the
      //    request-target (path + query), not the absolute URL.
      const auth = buildAuth(username, password, challenge, method, path + queryStr);
      return rawFetch(uri, method, auth);
    }

    async function rawFetch(uri, method, auth) {
      const headers = { 'X-Requested-With': 'XMLHttpRequest' };
      if (auth) headers['Authorization'] = auth;
      return fetch(uri, { method: method || 'GET', headers, credentials: 'include' });
    }

    // convenience: POST a command
    function cmd(path, query) { return request(path, 'POST', query); }

    return { request, cmd, setCredentials };
  }

  // -------------------------------------------------------------- helpers
  async function login(opts) {
    // POST /api/auth/login - the digest flow still applies; on 200 success.
    const client = createClient(opts);
    const res = await client.request('/api/auth/login', 'POST');
    return { ok: res.status === 200, client };
  }

  return {
    md5,
    createClient,
    login,
    parseChallenge,
    buildAuth
  };
});
