/* Antigravity account-switcher panel daemon.
 * - injects a small panel into the Antigravity window via CDP
 * - shows Gemini limits for every saved account
 * - switches accounts in place (credential swap + language-server sync), no app restart
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile, execFileSync, spawn } = require('child_process');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const AG_DATA = path.join(APPDATA, 'Antigravity');
const SW_DATA = path.join(APPDATA, 'AntigravitySwitcher');
const ACCOUNTS_FILE = path.join(SW_DATA, 'accounts.json');
const CACHE_FILE = path.join(SW_DATA, 'panel_cache.json');
const IMAGE_QUOTA_FILE = path.join(SW_DATA, 'image_quota.json');
const LOG_FILE = path.join(SW_DATA, 'panel.log');
const LOCK_FILE = path.join(SW_DATA, 'panel.pid');
const UI_FILE = path.join(__dirname, 'ui.js');
const CRED_PS1 = path.join(__dirname, 'cred.ps1');
const PS_EXE = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const REPO = 'xRAYNERx/antigravity-auto-switcher';
const UPDATE_API = process.env.AG_UPDATE_API || 'https://api.github.com/repos/' + REPO + '/releases/latest';
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const VERSION = (readJson(path.join(__dirname, 'version.json'), { version: '0.0.0' }).version) || '0.0.0';

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const POLL_MS = 2500;
const SWITCH_TIMEOUT_MS = 95 * 1000;
const REFRESH_MS = 30 * 1000;
const AUTO_THRESHOLD_5H = 0.05;    // switch away when the 5h limit drops to 5%
const AUTO_THRESHOLD_WEEK = 0.01;  // switch away when the weekly limit drops to 1% (regardless of 5h)
const AUTO_CANDIDATE_MIN = 0.10;   // candidate must have at least 10% on both windows
const AUTO_COOLDOWN_MS = 120 * 1000;
const AUTO_DRY_RUN = false;        // set true to only log the chosen target

const state = {
  active: '',
  switching: null,
  error: '',
  warn: '',
  autoSwitching: '',
  accounts: [],
  update: null,
  updateBusy: false,
  updateProgress: 0,
  updateError: '',
  imageQuota: null,
  switchedAt: 0,
};

let cdp = null;
let cdpUrl = null;
let injecting = false;
let busy = false;
let lastSwitchAt = 0;
let imageQuotas = {};   // email -> { model, reset, at, dismissedAt }
let legacyQuota = null; // old single-account image_quota.json, bound to the active account later

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------
function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(String).join(' ');
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function loadCache() {
  const c = readJson(CACHE_FILE, { accounts: {} });
  if (!c.accounts) c.accounts = {};
  return c;
}

function loadImageQuotas() {
  const raw = readJson(IMAGE_QUOTA_FILE, null);
  const out = {};
  if (raw && raw.accounts && typeof raw.accounts === 'object') {
    for (const email of Object.keys(raw.accounts)) {
      const q = raw.accounts[email];
      if (q && q.reset) out[email] = q;
    }
  } else if (raw && raw.reset) {
    legacyQuota = raw; // account unknown: bind to the active one on first use
  }
  return out;
}

function saveImageQuotas() {
  try {
    const accounts = {};
    for (const email of Object.keys(imageQuotas)) accounts[email] = imageQuotas[email];
    if (Object.keys(accounts).length) writeJson(IMAGE_QUOTA_FILE, { accounts: accounts });
    else if (fs.existsSync(IMAGE_QUOTA_FILE)) fs.unlinkSync(IMAGE_QUOTA_FILE);
  } catch (e) { /* ignore */ }
}

/** Drop entries whose window ended long ago, so an old one never nags on start. */
function pruneImageQuotas() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  let changed = false;
  for (const email of Object.keys(imageQuotas)) {
    if (Date.parse(imageQuotas[email].reset) < cutoff) {
      delete imageQuotas[email];
      changed = true;
    }
  }
  if (changed) saveImageQuotas();
}

/** Quota entry for the account Antigravity is currently signed into. */
function activeQuota() {
  const email = state.active;
  if (!email) return null;
  if (!imageQuotas[email] && legacyQuota) {
    imageQuotas[email] = legacyQuota;
    legacyQuota = null;
    saveImageQuotas();
  }
  const q = imageQuotas[email];
  if (!q || !q.reset || q.dismissedAt) return null;
  return { model: q.model || '', reset: q.reset };
}

function saveCache(c) {
  writeJson(CACHE_FILE, c);
}

function loadAccounts() {
  const data = readJson(ACCOUNTS_FILE, { accounts: {} });
  const out = [];
  for (const email of Object.keys(data.accounts || {})) {
    const a = data.accounts[email];
    const tok = (a.cred_blob && a.cred_blob.token) || {};
    if (!tok.refresh_token) continue;
    out.push({
      email,
      label: a.label || email,
      refresh_token: tok.refresh_token,
      access_token: tok.access_token || '',
      expiry: tok.expiry || '',
      auth_method: (a.cred_blob && a.cred_blob.auth_method) || 'consumer',
    });
  }
  return { data, list: out };
}

function saveAccountTokens(email, access_token, expiryMs) {
  const data = readJson(ACCOUNTS_FILE, { accounts: {} });
  const a = data.accounts && data.accounts[email];
  if (!a) return;
  a.cred_blob = a.cred_blob || {};
  a.cred_blob.token = a.cred_blob.token || {};
  a.cred_blob.token.access_token = access_token;
  a.cred_blob.token.expiry = new Date(expiryMs).toISOString().replace('.000Z', 'Z');
  a.cred_blob.token.token_type = 'Bearer';
  a.cred_blob.id_token_email = email;
  writeJson(ACCOUNTS_FILE, data);
}

/** Remember the token that is currently live in the credential store (it may be rotated). */
function saveLiveToken(cred) {
  if (!cred || !cred.id_token_email || !cred.token) return;
  const data = readJson(ACCOUNTS_FILE, { accounts: {} });
  const a = data.accounts && data.accounts[cred.id_token_email];
  if (!a) return;
  a.cred_blob = a.cred_blob || {};
  a.cred_blob.token = Object.assign({}, a.cred_blob.token, cred.token);
  a.cred_blob.id_token_email = cred.id_token_email;
  writeJson(ACCOUNTS_FILE, data);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function requestJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.body != null ? Buffer.from(opts.body) : null;
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          opts.headers || {},
          body ? { 'Content-Length': body.length } : {}
        ),
        rejectUnauthorized: opts.insecure ? false : true,
        timeout: opts.timeout || 12000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* not json */ }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// antigravity language server
// ---------------------------------------------------------------------------
function devtoolsPort() {
  try {
    const txt = fs.readFileSync(path.join(AG_DATA, 'DevToolsActivePort'), 'utf8');
    return parseInt(txt.split(/\r?\n/)[0], 10) || 0;
  } catch (e) {
    return 0;
  }
}

async function findPage() {
  const port = devtoolsPort();
  if (!port) return null;
  try {
    const res = await requestJson('http://127.0.0.1:' + port + '/json/list', { timeout: 3000 });
    const list = Array.isArray(res.json) ? res.json : [];
    return list.find((t) => t.type === 'page' && String(t.url).startsWith('https://127.0.0.1')) || null;
  } catch (e) {
    return null;
  }
}

let lsOrigin = '';
let lsCsrf = '';

async function lsEnsureAuth() {
  if (!lsOrigin) {
    const page = await findPage();
    if (!page) return false;
    lsOrigin = new URL(page.url).origin;
  }
  if (!lsCsrf) {
    try {
      const res = await requestJson(lsOrigin + '/', { insecure: true, timeout: 4000 });
      const m = /"csrfToken":"([^"]+)"/.exec(res.text || '');
      if (m) lsCsrf = m[1];
    } catch (e) { /* ignore */ }
  }
  return !!(lsOrigin && lsCsrf);
}

async function lsRpc(method, body, timeout) {
  if (!(await lsEnsureAuth())) throw new Error('LS is not running');
  const res = await requestJson(
    lsOrigin + '/exa.language_server_pb.LanguageServerService/' + method,
    {
      method: 'POST',
      insecure: true,
      timeout: timeout || 12000,
      headers: { 'x-codeium-csrf-token': lsCsrf, 'x-host-client': 'antigravity' },
      body: JSON.stringify(body || {}),
    }
  );
  if (res.status === 403 || res.status === 401) {
    lsCsrf = '';
    throw new Error('LS auth rejected');
  }
  if (res.status !== 200) throw new Error('LS ' + method + ' HTTP ' + res.status);
  return res.json || {};
}

async function lsEmail() {
  try {
    const r = await lsRpc('GetUserStatus', {});
    return (r.userStatus && r.userStatus.email) || '';
  } catch (e) {
    return '';
  }
}

function parseQuota(obj) {
  const groups = (obj && (obj.groups || (obj.response && obj.response.groups))) || [];
  const out = { fiveh: null, weekly: null };
  for (const g of groups) {
    const name = String(g.displayName || '');
    if (!/gemini/i.test(name)) continue;
    for (const b of g.buckets || []) {
      const win = String(b.window || '').toLowerCase();
      const q = {
        pct: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
        reset: b.resetTime || '',
      };
      if (win === '5h') out.fiveh = q;
      else if (win === 'weekly') out.weekly = q;
    }
  }
  return out;
}

async function lsQuota(attempt) {
  const r = await lsRpc('RetrieveUserQuotaSummary', {});
  return parseQuota(r);
}

// ---------------------------------------------------------------------------
// google direct (works only when the network can reach Google, e.g. VPN on)
// ---------------------------------------------------------------------------
async function refreshAccessToken(acc) {
  const exp = Date.parse(acc.expiry || '') || 0;
  if (acc.access_token && exp - Date.now() > 5 * 60 * 1000) return acc.access_token;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: acc.refresh_token,
    grant_type: 'refresh_token',
  }).toString();
  const res = await requestJson(TOKEN_URL, {
    method: 'POST',
    timeout: 12000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    throw new Error('token refresh HTTP ' + res.status);
  }
  acc.access_token = res.json.access_token;
  acc.expiry = new Date(Date.now() + (res.json.expires_in || 3600) * 1000).toISOString();
  saveAccountTokens(acc.email, acc.access_token, Date.now() + (res.json.expires_in || 3600) * 1000);
  return acc.access_token;
}

async function directQuota(acc) {
  const token = await refreshAccessToken(acc);
  const res = await requestJson(QUOTA_URL, {
    method: 'POST',
    timeout: 9000,
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'antigravity/2.29.0' },
    body: '{}',
  });
  if (res.status !== 200) throw new Error('quota HTTP ' + res.status);
  return parseQuota(res.json || {});
}

// ---------------------------------------------------------------------------
// credential swap
// ---------------------------------------------------------------------------
function runCred(args, timeout) {
  return new Promise((resolve, reject) => {
    const full = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CRED_PS1].concat(args);
    execFile(PS_EXE, full, { windowsHide: true, timeout: timeout || 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim().slice(0, 300)));
      const text = String(stdout).replace(/^\uFEFF/, '').trim();
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('bad credential helper output: ' + text.slice(0, 200)));
      }
    });
  });
}

async function readCredential() {
  const r = await runCred(['read']);
  if (r && r.ok === false) throw new Error(r.error || 'cred read failed');
  return r;
}

async function switchAccount(email) {
  const { list } = loadAccounts();
  const acc = list.find((a) => a.email === email);
  if (!acc) throw new Error('аккаунт не сохранён');

  await refreshAccessToken(acc);
  const cur = await readCredential();
  saveLiveToken(cur); // keep the outgoing account's freshest refresh token
  const writer = cur.writer_id || '';
  const expiresIn = Math.max(60, Math.round((Date.parse(acc.expiry) - Date.now()) / 1000) || 3600);

  const blob = {
    token: {
      access_token: acc.access_token,
      token_type: 'Bearer',
      refresh_token: acc.refresh_token,
      expiry: new Date(acc.expiry).toISOString().replace('.000Z', 'Z'),
      expires_in: expiresIn,
    },
    auth_method: acc.auth_method || 'consumer',
    id_token_email: email,
    writer_id: writer,
  };
  const tmp = path.join(SW_DATA, 'tmp_blob.json');
  writeJson(tmp, blob);
  const w = await runCred(['write', tmp], 30000);
  if (w && w.ok === false) throw new Error(w.error || 'cred write failed');
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }

  // nudge the language server to notice the external token change
  lsRpc('GetAuthStatus', {}, 25000).catch(() => {});

  const deadline = Date.now() + SWITCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const now = await lsEmail();
    if (now && now.toLowerCase() === email.toLowerCase()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// state building
// ---------------------------------------------------------------------------
function cacheQuota(email, q) {
  const c = loadCache();
  c.accounts[email] = {
    fiveh: q.fiveh,
    weekly: q.weekly,
    updated: Date.now(),
  };
  saveCache(c);
}

function fromCache(email) {
  const c = loadCache();
  const v = c.accounts[email];
  if (!v) return { fiveh: null, weekly: null, updated: 0, source: 'none' };
  return { fiveh: v.fiveh, weekly: v.weekly, updated: v.updated, source: 'cache' };
}

async function buildStateBase() {
  const { list } = loadAccounts();
  const active = (await lsEmail()) || state.active || '';
  state.active = active;
  let lsOk = false;
  const out = [];
  for (const acc of list) {
    let q = null;
    if (acc.email === active) {
      try {
        q = await lsQuota();
        cacheQuota(acc.email, q);
        lsOk = true;
      } catch (e) {
        q = null;
      }
    }
    if (!q) {
      const c = fromCache(acc.email);
      q = { fiveh: c.fiveh, weekly: c.weekly, updated: c.updated };
    }
    out.push({
      email: acc.email,
      fiveh: q.fiveh,
      weekly: q.weekly,
      updated: q.updated || 0,
    });
  }
  state.accounts = out;
  return lsOk;
}

/** Live Google requests for every account (including the active one). Needs working network / VPN. */
async function tryOnlineQuotas() {
  const { list } = loadAccounts();
  let activeFresh = false;
  await Promise.all(
    list.map(async (acc) => {
      try {
        const q = await directQuota(acc);
        cacheQuota(acc.email, q);
        const row = state.accounts.find((x) => x.email === acc.email);
        if (row) {
          row.fiveh = q.fiveh;
          row.weekly = q.weekly;
          row.updated = Date.now();
        }
        if (acc.email === state.active) activeFresh = true;
      } catch (e) { /* offline or no VPN */ }
    })
  );
  return activeFresh;
}

// ---------------------------------------------------------------------------
// updates (GitHub releases)
// ---------------------------------------------------------------------------
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function checkUpdates() {
  try {
    const res = await requestJson(UPDATE_API, {
      timeout: 12000,
      headers: { 'User-Agent': 'Antigravity-Switcher', Accept: 'application/vnd.github+json' },
    });
    if (res.status !== 200 || !res.json) {
      log('update check: HTTP', res.status);
      return;
    }
    const remote = String(res.json.tag_name || res.json.name || '').replace(/^v/i, '');
    if (!remote || cmpVersion(remote, VERSION) <= 0) {
      if (state.update) {
        state.update = null;
        await pushState();
      }
      return;
    }
    const assets = res.json.assets || [];
    const asset = assets.find((a) => /\.zip$/i.test(String(a.name))) || assets[0];
    if (!asset) return;
    state.update = {
      version: remote,
      url: asset.browser_download_url,
      size: asset.size || 0,
    };
    log('update available:', remote, 'current', VERSION);
    await pushState();
  } catch (e) {
    log('update check failed:', e.message);
  }
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'Antigravity-Switcher' },
        rejectUnauthorized: false,
        timeout: 120000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total && onProgress) onProgress(Math.min(100, Math.round((got / total) * 100)));
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const cmd =
      "Expand-Archive -LiteralPath '" + String(zip).replace(/'/g, "''") + "' -DestinationPath '" +
      String(dest).replace(/'/g, "''") + "' -Force";
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, timeout: 180000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || '').trim().slice(0, 300)));
        else resolve();
      }
    );
  });
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function buildApplyScript(waitPid, target, stage, exe) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$WaitPid = ' + waitPid,
    '$Target = ' + psQuote(target),
    '$Stage = ' + psQuote(stage),
    '$Exe = ' + psQuote(exe),
    'try { Wait-Process -Id $WaitPid -Timeout 120 } catch { }',
    'Start-Sleep -Milliseconds 900',
    'robocopy $Stage $Target /E /COPY:DAT /R:5 /W:1 /NFL /NDL /NJH /NJS | Out-Null',
    'Start-Sleep -Milliseconds 400',
    'Start-Process -FilePath $Exe -WorkingDirectory $Target',
  ].join('\r\n');
}

/** Starts a fully detached process (survives the daemon exit) via the WMI process service. */
function startDetached(commandLine) {
  return new Promise((resolve, reject) => {
    const psCmd =
      'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=' +
      psQuote(commandLine) + '} | Out-Null';
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
      { windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || '').trim().slice(0, 300)));
        else resolve();
      }
    );
  });
}

async function doUpdate() {
  if (busy || !state.update) return;
  busy = true;
  state.updateBusy = true;
  state.updateProgress = 0;
  state.updateError = '';
  await pushState();
  try {
    const dir = path.join(SW_DATA, 'update');
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'update.zip');
    const stage = path.join(dir, 'new');
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    log('downloading update', state.update.version, state.update.url);
    let lastPushed = -10;
    await downloadFile(state.update.url, zip, (p) => {
      state.updateProgress = p;
      if (p - lastPushed >= 5 || p === 100) {
        lastPushed = p;
        pushState();
      }
    });
    log('extracting update');
    await extractZip(zip, stage);
    let root = stage;
    const entries = fs.readdirSync(stage);
    if (entries.length === 1 && fs.statSync(path.join(stage, entries[0])).isDirectory()) {
      root = path.join(stage, entries[0]);
    }
    const target = path.resolve(__dirname, '..');
    const exe = path.join(target, 'Antigravity Switcher.exe');
    const script = path.join(dir, 'apply_update.ps1');
    // PowerShell 5.1 reads BOM-less .ps1 as ANSI and breaks Cyrillic paths, so keep the BOM
    fs.writeFileSync(script, '\uFEFF' + buildApplyScript(process.pid, target, root, exe), 'utf8');
    fs.writeFileSync(path.join(SW_DATA, 'updated.flag'), state.update.version, 'utf8');
    log('spawning detached updater, target', target);
    await startDetached(
      'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + script + '"'
    );
    state.updateProgress = 100;
    await pushState();
    await sleep(800);
    process.exit(0);
  } catch (e) {
    state.updateError = 'Не удалось обновить: ' + e.message;
    state.updateBusy = false;
    state.updateProgress = 0;
    busy = false;
    log('update error:', e.message);
    await pushState();
  }
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------
class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.handlers = {};
    this.closed = false;
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const c = new Cdp(url);
      const ws = new WebSocket(url);
      c.ws = ws;
      const timer = setTimeout(() => reject(new Error('cdp connect timeout')), 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(c);
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error('cdp connect error'));
      };
      ws.onclose = () => {
        c.closed = true;
        if (c.onclose) c.onclose();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && c.pending.has(msg.id)) {
          const p = c.pending.get(msg.id);
          c.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method) {
          const h = c.handlers[msg.method];
          if (h) h(msg.params);
        }
      };
    });
  }

  on(method, fn) {
    this.handlers[method] = fn;
  }

  send(method, params) {
    if (this.closed) return Promise.reject(new Error('cdp closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('cdp timeout ' + method));
        }
      }, 60000);
    });
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
    this.closed = true;
  }
}

async function evaluate(expr) {
  if (!cdp || cdp.closed) return null;
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  return r.result ? r.result.value : null;
}

let uiSource = '';

async function injectPanel() {
  if (injecting || !cdp || cdp.closed) return;
  injecting = true;
  try {
    if (!uiSource) uiSource = fs.readFileSync(UI_FILE, 'utf8');
    await evaluate(uiSource);
    await pushState();
    log('panel injected');
  } catch (e) {
    log('inject failed:', e.message);
  } finally {
    injecting = false;
  }
}

/** The app shows a one-time "Security Notice & Data Use" dialog after an account change. */
async function ensureConsent() {
  for (let i = 0; i < 10; i++) {
    try {
      const clicked = await evaluate(
        "(()=>{const b=[...document.querySelectorAll('button')].find(e=>(e.innerText||'').trim()==='Accept and continue');" +
        "if(b){b.click();return true}return false})()"
      );
      if (clicked) {
        log('accepted security notice');
        return;
      }
    } catch (e) { /* ignore */ }
    await sleep(1500);
  }
}

async function pushState() {
  if (!cdp || cdp.closed) return;
  state.imageQuota = activeQuota();
  try {
    await evaluate('window.__agSwitcher && window.__agSwitcher.update(' + JSON.stringify(state) + ')');
  } catch (e) { /* ignore */ }
}

async function addCurrentAccount() {
  const cred = await readCredential();
  if (!cred || !cred.id_token_email || !cred.token || !cred.token.refresh_token) {
    throw new Error('не удалось прочитать текущий токен из хранилища');
  }
  const email = cred.id_token_email;
  const data = readJson(ACCOUNTS_FILE, { accounts: {} });
  data.accounts = data.accounts || {};
  data.accounts[email] = {
    email: email,
    label: email,
    added_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    cred_blob: {
      token: cred.token,
      auth_method: cred.auth_method || 'consumer',
      id_token_email: email,
    },
  };
  writeJson(ACCOUNTS_FILE, data);
  return email;
}

async function handleCommand(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.cmd === 'hello') {
    await pushState();
    if (!busy) refreshAll();
  } else if (msg.cmd === 'add') {
    if (busy) return;
    try {
      const email = await addCurrentAccount();
      log('added account', email);
      await refreshAll();
    } catch (e) {
      state.error = 'Не удалось добавить аккаунт: ' + e.message;
      await pushState();
    }
  } else if (msg.cmd === 'refresh') {
    if (busy) return;
    await refreshAll();
  } else if (msg.cmd === 'switch') {
    if (busy || !msg.email) return;
    await doSwitch(msg.email, false);
  } else if (msg.cmd === 'update') {
    await doUpdate();
  } else if (msg.cmd === 'imageQuota') {
    const reset = String(msg.reset || '');
    if (!reset || Date.parse(reset) <= Date.now()) return;
    const email = state.active;
    if (!email) return;
    // the same chat message is still on screen after an account switch:
    // never credit it to the account that was just signed in
    for (const other of Object.keys(imageQuotas)) {
      if (other !== email && imageQuotas[other].reset === reset) return;
    }
    const prev = imageQuotas[email];
    const same = prev && prev.reset === reset;
    imageQuotas[email] = {
      model: String(msg.model || ''),
      reset: reset,
      at: Date.now(),
      dismissedAt: same ? (prev.dismissedAt || 0) : 0,
    };
    saveImageQuotas();
    log('image quota exhausted for', imageQuotas[email].model, 'account', email, 'until', reset);
    await pushState();
  } else if (msg.cmd === 'quotaDismiss' || msg.cmd === 'quotaClear') {
    const email = state.active;
    if (!email) return;
    const q = imageQuotas[email];
    if (msg.cmd === 'quotaClear') {
      if (q && (!msg.reset || String(msg.reset) === q.reset)) {
        delete imageQuotas[email];
        saveImageQuotas();
        log('image quota notice cleared', email);
      }
    } else if (q && (!msg.reset || String(msg.reset) === q.reset)) {
      q.dismissedAt = Date.now();
      saveImageQuotas();
      log('image quota notice dismissed', email);
    }
    await pushState();
  }
}

function quotaScore(a) {
  const f = a.fiveh && a.fiveh.pct != null ? a.fiveh.pct : 0;
  const w = a.weekly && a.weekly.pct != null ? a.weekly.pct : 0;
  return Math.min(f, w);
}

/** Switch away before the active account hits zero (5h or weekly below 5%). */
async function maybeAutoSwitch(activeDataOk) {
  if (busy || !state.active || !activeDataOk) return;
  if (Date.now() - lastSwitchAt < AUTO_COOLDOWN_MS) return;
  const active = state.accounts.find((a) => a.email === state.active);
  if (!active) return;
  const fivehLow = active.fiveh && active.fiveh.pct != null && active.fiveh.pct <= AUTO_THRESHOLD_5H;
  const weekLow = active.weekly && active.weekly.pct != null && active.weekly.pct <= AUTO_THRESHOLD_WEEK;
  if (!fivehLow && !weekLow) {
    if (state.warn) {
      state.warn = '';
      await pushState();
    }
    return;
  }
  const candidates = state.accounts.filter((a) =>
    a.email !== state.active &&
    a.fiveh && a.fiveh.pct != null && a.fiveh.pct > AUTO_CANDIDATE_MIN &&
    a.weekly && a.weekly.pct != null && a.weekly.pct > AUTO_CANDIDATE_MIN
  );
  if (!candidates.length) {
    if (!state.warn) {
      state.warn = 'Лимит на исходе, но запасного аккаунта с нормальным остатком нет.';
      await pushState();
    }
    return;
  }
  candidates.sort((a, b) => quotaScore(b) - quotaScore(a));
  const target = candidates[0];
  if (AUTO_DRY_RUN) {
    log('auto switch (dry run): target', target.email, 'score', quotaScore(target).toFixed(3));
    return;
  }
  const reason = weekLow
    ? 'weekly ' + ((active.weekly.pct || 0) * 100).toFixed(1) + '%'
    : '5h ' + ((active.fiveh.pct || 0) * 100).toFixed(1) + '%';
  log('auto switch (' + reason + ' left): target', target.email, 'score', quotaScore(target).toFixed(3));
  await doSwitch(target.email, true);
}

async function doSwitch(email, auto) {
  if (busy) return;
  busy = true;
  state.switching = email;
  state.autoSwitching = auto ? email : '';
  state.error = '';
  state.warn = '';
  await pushState();
  log(auto ? 'auto switch ->' : 'switch ->', email);
  try {
    const ok = await switchAccount(email);
    if (!ok) {
      state.error = 'АГ не подхватил аккаунт за 95 секунд. Попробуй ещё раз или перезапусти АГ.';
      log('switch timeout');
    } else {
      state.active = email;
      state.switchedAt = Date.now();
      lastSwitchAt = Date.now();
      log('switched to', email);
      await buildStateBase();
      await pushState();
      await sleep(700);
      try { await cdp.send('Page.reload', { ignoreCache: true }); } catch (e) { /* ignore */ }
      return;
    }
  } catch (e) {
    let msg = e.message || 'неизвестная ошибка';
    if (/token refresh HTTP 400/.test(msg)) {
      msg = 'токен этого аккаунта устарел. Зайди в него вручную в АГ (Настройки → аккаунт) и попробуй снова.';
    }
    state.error = 'Ошибка: ' + msg;
    log('switch error:', e.message);
  } finally {
    state.switching = null;
    state.autoSwitching = '';
    busy = false;
    await pushState();
  }
}

async function refreshAll() {
  if (busy) return;
  if (state.imageQuota && Date.parse(state.imageQuota.reset) <= Date.now()) {
    pruneImageQuotas();
    await pushState();
  }
  try {
    const lsOk = await buildStateBase();
    await pushState();
    const onlineOk = await tryOnlineQuotas();
    await pushState();
    await maybeAutoSwitch(lsOk || onlineOk);
  } catch (e) {
    log('refresh error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// main loop: attach, inject, survive reloads
// ---------------------------------------------------------------------------
async function attach() {
  const page = await findPage();
  if (!page) return false;
  const origin = new URL(page.url).origin;
  if (origin !== lsOrigin) {
    lsOrigin = origin;
    lsCsrf = '';
  }
  if (cdp && !cdp.closed && cdpUrl === page.webSocketDebuggerUrl) return true;
  if (cdp) cdp.close();
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  cdpUrl = page.webSocketDebuggerUrl;
  cdp.onclose = () => { log('cdp closed'); cdp = null; cdpUrl = null; };
  cdp.on('Runtime.bindingCalled', (p) => {
    if (p.name === '__agSwitcherSend') handleCommand(p.payload);
  });
  cdp.on('Page.loadEventFired', () => {
    setTimeout(async () => {
      try {
        await cdp.send('Runtime.addBinding', { name: '__agSwitcherSend' });
      } catch (e) { /* ignore */ }
      await injectPanel();
      ensureConsent();
    }, 1200);
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: '__agSwitcherSend' });
  log('attached to', page.url.slice(0, 60));
  return true;
}

async function tick() {
  try {
    if (!(await attach())) return;
    const ok = await evaluate('!!window.__agSwitcher');
    if (!ok) await injectPanel();
  } catch (e) {
    log('tick error:', e.message);
  }
}

/** True when the given pid is a live node.exe process (used to validate the pid file). */
function isNodeProcess(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
    });
    return /node\.exe/i.test(String(out));
  } catch (e) {
    return false;
  }
}

async function main() {
  try {
    fs.mkdirSync(SW_DATA, { recursive: true });
  } catch (e) { /* ignore */ }
  // single instance: ignore a stale pid file left by a crash / reused pid
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (pid && pid !== process.pid && isNodeProcess(pid)) {
      log('already running as', pid);
      return;
    }
  } catch (e) { /* no lock or stale */ }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => {
    try {
      if (parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch (e) { /* ignore */ }
  });

  log('daemon start');
  imageQuotas = loadImageQuotas();
  pruneImageQuotas();
  await tick();

  // after a self-update the window still runs the old UI; reload it once
  const flag = path.join(SW_DATA, 'updated.flag');
  if (fs.existsSync(flag)) {
    try { fs.unlinkSync(flag); } catch (e) { /* ignore */ }
    setTimeout(async () => {
      try { await cdp.send('Page.reload', { ignoreCache: true }); } catch (e) { /* ignore */ }
    }, 2000);
  }

  setTimeout(checkUpdates, 4000);
  setInterval(checkUpdates, UPDATE_CHECK_MS);
  setInterval(tick, 5000);
  setInterval(() => { if (!busy) refreshAll(); }, REFRESH_MS);
}

main().catch((e) => log('fatal:', e.message));

