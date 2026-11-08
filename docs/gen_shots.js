/* Generates standalone panel screenshots for the GitHub README. */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
const out = path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });

const THEMES = [
  { id: 'dracula', label: 'Dracula', bg: '#282A36', fg: '#F8F8F2', primary: '#BD93F9', light: false },
  { id: 'default-dark', label: 'Default Dark', bg: '#101010', fg: '#CCCCCC', primary: '#007ACC', light: false },
  { id: 'catppuccin', label: 'Catppuccin', bg: '#24273A', fg: '#CAD3F5', primary: '#C6A0F6', light: false },
  { id: 'solarized-light', label: 'Solarized Light', bg: '#FAF4E5', fg: '#435155', primary: '#CB4B16', light: true },
];

function iso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString();
}

const ACCOUNTS = [
  { email: 'design@tenebro.net', fiveh: [0.94, 4.7], weekly: [0.98, 160] },
  { email: 'hello@tenebro.net', fiveh: [0.63, 2.2], weekly: [0.12, 120] },
  { email: 'studio@tenebro.net', fiveh: [0.38, 1.1], weekly: [0.71, 96] },
  { email: 'backup@tenebro.net', fiveh: [0.08, 3.6], weekly: [0.44, 140] },
  { email: 'demo.account@gmail.com', fiveh: [0.01, 0.3], weekly: [0.26, 88] },
];

const state = {
  active: ACCOUNTS[0].email,
  accounts: ACCOUNTS.map((a) => ({
    email: a.email,
    fiveh: { pct: a.fiveh[0], reset: iso(a.fiveh[1]) },
    weekly: { pct: a.weekly[0], reset: iso(a.weekly[1]) },
  })),
  switching: null,
  error: '',
  warn: '',
  update: null,
  updateBusy: false,
  updateProgress: 0,
  updateError: '',
};

function html(theme, collapsed) {
  const card = theme.light
    ? `color-mix(in srgb, #000 4%, ${theme.bg})`
    : `color-mix(in srgb, #fff 4.8%, ${theme.bg})`;
  const border = theme.light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.07)';
  const muted = `color-mix(in srgb, ${theme.fg} 55%, ${theme.bg})`;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;}
  body{
    --background:${theme.bg}; --foreground:${theme.fg};
    --card:${card}; --border:${border};
    --muted-foreground:${muted}; --primary:${theme.primary};
    background:${theme.bg}; color:${theme.fg};
    font-family:"Segoe UI",system-ui,sans-serif;
    overflow:hidden;
  }
</style></head>
<body>
<script>localStorage.setItem('agp2-collapsed','${collapsed ? '1' : '0'}');localStorage.setItem('agp2-hide','0');localStorage.setItem('agp2-sort','fiveh');</script>
<script>window.__agSwitcherSend=function(){};</script>
<script>${ui}</script>
<script>
  window.__agSwitcher.update(${JSON.stringify(state)});
  (function(){
    var h=document.getElementById('ag-switcher-host');
    if(h){h.style.left='26px';h.style.top='24px';h.style.bottom='auto';}
  })();
  setTimeout(function(){
    var h=document.getElementById('ag-switcher-host');
    if(h){h.style.left='26px';h.style.top='24px';h.style.bottom='auto';}
  },50);
</script>
</body></html>`;
}

for (const t of THEMES) {
  fs.writeFileSync(path.join(out, `panel_${t.id}.html`), html(t, false), 'utf8');
  fs.writeFileSync(path.join(out, `pill_${t.id}.html`), html(t, true), 'utf8');
}
console.log('harness files written to', out);
