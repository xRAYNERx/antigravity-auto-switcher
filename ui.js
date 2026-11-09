/* Antigravity account switcher panel (injected into the AG window).
 * - shows 5h / weekly limits with the time until reset inside the bars
 * - active account is always on top, list can be sorted by remaining limit or reset time
 * - switching asks for a second click; auto-switch happens in the daemon
 * - colours come from the app's own theme variables
 */
(function () {
  if (window.__agSwitcherInstalled) return;
  window.__agSwitcherInstalled = true;

  var HOST_ID = 'ag-switcher-host';
  var old = document.getElementById(HOST_ID);
  if (old) old.remove();

  var host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;left:303px;bottom:12px;z-index:4000;';
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  /* ---------- theme ---------- */
  function pick(name, fallback) {
    var v = getComputedStyle(document.body).getPropertyValue(name);
    if (!v) v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || '').trim();
    return v || fallback;
  }

  function applyTheme() {
    var bg = pick('--background', '#282A36');
    var fg = pick('--foreground', '#F8F8F2');
    var card = pick('--card', 'color-mix(in srgb, #ffffff 5%, #282A36)');
    var border = pick('--border', 'rgba(255,255,255,.06)');
    var muted = pick('--muted-foreground', 'rgba(248,248,242,.55)');
    var primary = pick('--primary', '#BD93F9');
    var font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    host.style.setProperty('--agp-card', card);
    host.style.setProperty('--agp-bg', bg);
    host.style.setProperty('--agp-fg', fg);
    host.style.setProperty('--agp-border', border);
    host.style.setProperty('--agp-muted', muted);
    host.style.setProperty('--agp-primary', primary);
    host.style.setProperty('--agp-font', font);
    host.style.setProperty('--agp-track', 'color-mix(in srgb, ' + fg + ' 10%, transparent)');
    host.style.setProperty('--agp-soft', 'color-mix(in srgb, ' + fg + ' 7%, transparent)');
    host.style.setProperty('--agp-hover', 'color-mix(in srgb, ' + fg + ' 6%, transparent)');
  }
  applyTheme();
  try {
    var themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  } catch (e) { /* ignore */ }

  /* ---------- persisted ui prefs ---------- */
  var LS_COLLAPSED = 'agp2-collapsed';
  var LS_SORT = 'agp2-sort';
  var LS_HIDE = 'agp2-hide';

  var collapsed = localStorage.getItem(LS_COLLAPSED) !== '0'; // collapsed by default
  var sortMode = localStorage.getItem(LS_SORT) || 'fiveh';
  var hideEmails = localStorage.getItem(LS_HIDE) === '1';

  var SORTS = [
    { id: 'fiveh', label: 'Остаток 5ч', short: '5ч' },
    { id: 'weekly', label: 'Остаток недели', short: 'нед' },
    { id: 'reset5h', label: 'Сброс 5ч', short: '5ч ↻' },
    { id: 'resetweek', label: 'Сброс недели', short: 'нед ↻' },
  ];

  var current = { active: '', accounts: [], switching: null, error: '', warn: '', autoSwitching: '' };
  var pendingEmail = '';
  var pendingTimer = null;
  var noteOverride = '';
  var noteTimer = null;
  var expandedForUpdate = '';

  var EYE_ON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z"/>' +
    '<circle cx="8" cy="8" r="1.8"/></svg>';
  var EYE_OFF =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z"/>' +
    '<circle cx="8" cy="8" r="1.8"/><path d="m2.6 13.4 10.8-10.8"/></svg>';

  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:var(--agp-font)}',
    '.wrap{position:relative;display:flex;flex-direction:column;align-items:flex-start}',
    '.card{width:460px;background:var(--agp-card);border:1px solid var(--agp-border);border-radius:12px;',
    ' box-shadow:0 18px 44px rgba(0,0,0,.5);overflow:hidden}',
    '.head{display:flex;align-items:center;gap:5px;height:34px;padding:0 8px 0 12px;',
    ' border-bottom:1px solid var(--agp-border)}',
    '.title{font-size:10px;font-weight:700;letter-spacing:.09em;color:var(--agp-muted);text-transform:uppercase}',
    '.spacer{flex:1}',
    '.update{display:none;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--agp-border);',
    ' background:color-mix(in srgb, var(--agp-primary) 10%, transparent)}',
    '.update.show{display:flex}',
    '.update .ut{flex:1;font-size:11px;line-height:1.35;color:var(--agp-fg)}',
    '.update .ut b{color:var(--agp-primary);font-weight:600}',
    '.update .ub{flex:0 0 auto;height:24px;padding:0 10px;border-radius:7px;font-size:11px;cursor:pointer;',
    ' border:1px solid color-mix(in srgb, var(--agp-primary) 50%, transparent);',
    ' background:color-mix(in srgb, var(--agp-primary) 16%, transparent);color:var(--agp-primary)}',
    '.update .ub:hover{background:color-mix(in srgb, var(--agp-primary) 26%, transparent)}',
    '.update .ub:disabled{opacity:.7;cursor:default}',
    '.update .ue{font-size:10px;color:#FF6E6E;margin-top:3px}',
    '.qbar{display:none;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--agp-border);',
    ' background:color-mix(in srgb, #F1FA8C 8%, transparent);font-size:11px;line-height:1.35;color:var(--agp-fg)}',
    '.qbar.show{display:flex}',
    '.qbar b{color:var(--agp-fg);font-weight:600}',
    '.qbar .qi{flex:0 0 auto;font-size:13px;line-height:1;opacity:.85}',
    '.sortbtn{display:flex;align-items:center;gap:3px;height:21px;padding:0 6px;border-radius:6px;',
    ' border:1px solid var(--agp-border);background:transparent;color:var(--agp-muted);font-size:10px;cursor:pointer}',
    '.sortbtn:hover{color:var(--agp-fg);background:var(--agp-hover)}',
    '.sortbtn svg{opacity:.7}',
    '.ic{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:var(--agp-muted);',
    ' font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '.ic:hover{background:var(--agp-hover);color:var(--agp-fg)}',
    '.list{max-height:min(52vh,430px);overflow-y:auto;overflow-x:hidden}',
    '.list::-webkit-scrollbar{width:8px}',
    '.list::-webkit-scrollbar-thumb{background:var(--agp-soft);border-radius:4px}',
    '.row{display:flex;gap:10px;padding:9px 12px 10px;border-top:1px solid var(--agp-border)}',
    '.row:first-child{border-top:0}',
    '.row.active{background:color-mix(in srgb, var(--agp-primary) 4.5%, transparent)}',
    '.ava{width:26px;height:26px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;',
    ' justify-content:center;font-size:11px;font-weight:600;background:var(--agp-soft);',
    ' color:var(--agp-muted);margin-top:1px}',
    '.row.active .ava{background:color-mix(in srgb, var(--agp-primary) 20%, transparent);color:var(--agp-primary)}',
    '.body{flex:1;min-width:0}',
    '.l1{display:flex;align-items:center;gap:8px;min-height:20px}',
    '.email{font-size:12.5px;font-weight:500;color:var(--agp-fg);white-space:nowrap;overflow:hidden;',
    ' text-overflow:ellipsis;letter-spacing:.005em}',
    '.chip,.sw{margin-left:auto;flex:0 0 auto;font-size:11px;padding:3px 10px;border-radius:7px;line-height:1.2}',
    '.chip{color:var(--agp-primary);border:1px solid color-mix(in srgb, var(--agp-primary) 45%, transparent);',
    ' background:color-mix(in srgb, var(--agp-primary) 10%, transparent)}',
    '.sw{color:color-mix(in srgb, var(--agp-fg) 72%, transparent);background:transparent;',
    ' border:1px solid var(--agp-border);cursor:pointer}',
    '.sw:hover{color:var(--agp-primary);border-color:color-mix(in srgb, var(--agp-primary) 45%, transparent);',
    ' background:color-mix(in srgb, var(--agp-primary) 10%, transparent)}',
    '.sw:disabled{opacity:.6;cursor:default}',
    '.meters{display:flex;gap:14px;margin-top:5px}',
    '.meter{display:flex;flex-direction:column;gap:3px;width:188px}',
    '.mhead{display:flex;align-items:baseline;gap:3px;font-size:9.5px;color:var(--agp-muted);line-height:1.2}',
    '.mhead i{font-style:normal;flex:0 0 auto}',
    '.mhead u{text-decoration:none;color:var(--agp-muted);white-space:nowrap}',
    '.mrow{display:flex;align-items:center;gap:4px}',
    '.bar{position:relative;flex:1;height:8px;border-radius:4px;background:var(--agp-track);overflow:hidden}',
    '.bar s{position:absolute;left:0;top:0;bottom:0;border-radius:4px;display:block;transition:width .35s ease}',
    '.mrow em{font-style:normal;font-size:10px;color:var(--agp-muted);width:30px;text-align:left;flex:0 0 auto}',
    '.note{margin:0 12px 9px;padding:6px 8px;border-radius:7px;font-size:10.5px;line-height:1.35;',
    ' display:none;align-items:flex-start;gap:8px}',
    '.note.show{display:flex}',
    '.note .ntext{flex:1;color:var(--agp-fg)}',
    '.note .nx{border:0;background:transparent;color:var(--agp-muted);font-size:14px;line-height:1;',
    ' cursor:pointer;padding:0 2px;border-radius:4px;flex:0 0 auto}',
    '.note .nx:hover{color:var(--agp-fg);background:var(--agp-hover)}',
    '.note.info{background:color-mix(in srgb, var(--agp-primary) 9%, transparent);',
    ' border:1px solid color-mix(in srgb, var(--agp-primary) 26%, transparent)}',
    '.note.warn{background:color-mix(in srgb, #F1FA8C 9%, transparent);border:1px solid color-mix(in srgb, #F1FA8C 26%, transparent)}',
    '.note.err{background:color-mix(in srgb, #FF5555 9%, transparent);border:1px solid color-mix(in srgb, #FF5555 28%, transparent)}',
    '.empty{padding:12px;font-size:11px;color:var(--agp-muted)}',
    '.menu{position:absolute;top:36px;right:8px;min-width:150px;padding:4px;border-radius:8px;',
    ' background:var(--agp-card);border:1px solid var(--agp-border);box-shadow:0 14px 34px rgba(0,0,0,.55);',
    ' display:none;z-index:5}',
    '.menu.show{display:block}',
    '.menu button{display:flex;align-items:center;width:100%;border:0;background:transparent;',
    ' color:var(--agp-fg);font-size:11px;padding:6px 8px;border-radius:6px;cursor:pointer;text-align:left}',
    '.menu button:hover{background:var(--agp-hover)}',
    '.menu button .tick{margin-left:auto;color:var(--agp-primary);opacity:0;font-size:10px}',
    '.menu button.on .tick{opacity:1}',
    '.pill{display:none;align-items:center;gap:7px;height:30px;padding:0 11px;border-radius:999px;',
    ' background:var(--agp-card);border:1px solid var(--agp-border);color:var(--agp-fg);',
    ' font-size:11px;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.45);max-width:520px}',
    '.pill:hover{border-color:color-mix(in srgb, var(--agp-primary) 35%, var(--agp-border))}',
    '.pill .pdot{width:6px;height:6px;border-radius:50%;background:var(--agp-primary);flex:0 0 auto}',
    '.pill b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px}',
    '.pill .pv{color:var(--agp-muted);white-space:nowrap}',
    '.pill .pchev{color:var(--agp-muted);margin-left:2px;display:flex;flex:0 0 auto}',
    '.wrap.collapsed .pill{display:flex}',
    '.wrap.collapsed .card{display:none}'
  ].join('');

  var wrap = document.createElement('div');
  wrap.className = 'wrap' + (collapsed ? ' collapsed' : '');

  var pill = document.createElement('button');
  pill.className = 'pill';

  var card = document.createElement('div');
  card.className = 'card';

  var head = document.createElement('div');
  head.className = 'head';
  head.innerHTML =
    '<span class="title">Аккаунты</span>' +
    '<span class="spacer"></span>' +
    '<button class="sortbtn" id="sortbtn" title="Сортировка">' +
      '<span id="sortlabel">5ч</span>' +
      '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.2 8 10l4-3.8"/></svg>' +
    '</button>' +
    '<button class="ic" id="eye" title="Скрыть почты"></button>' +
    '<button class="ic" id="add" title="Сохранить текущий аккаунт">' +
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>' +
    '</button>' +
    '<button class="ic" id="refresh" title="Обновить лимиты">' +
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7"/>' +
      '<path d="M13.4 2.8v3.4h-3.4"/></svg>' +
    '</button>' +
    '<button class="ic" id="collapse" title="Свернуть">' +
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.2 8 10.4l4.5-4.2"/></svg>' +
    '</button>';

  var eyeBtn = head.querySelector('#eye');
  eyeBtn.innerHTML = hideEmails ? EYE_OFF : EYE_ON;

  var updateBar = document.createElement('div');
  updateBar.className = 'update';
  updateBar.innerHTML = '<div class="ut" id="ut"></div><button class="ub" id="ub">Обновить</button>';

  var quotaBar = document.createElement('div');
  quotaBar.className = 'qbar';
  quotaBar.innerHTML =
    '<svg class="qi" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/>' +
    '<circle cx="5.4" cy="6.2" r="1.1"/>' +
    '<path d="M2.6 11.6l3.4-3.1 2.5 2.2 2.3-1.9 2.6 2.4"/></svg>' +
    '<span id="qt"></span>';

  var list = document.createElement('div');
  list.className = 'list';

  var note = document.createElement('div');
  note.className = 'note';

  var menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = SORTS.map(function (s) {
    return '<button data-sort="' + s.id + '">' + s.label + '<span class="tick">✓</span></button>';
  }).join('');

  card.appendChild(head);
  card.appendChild(updateBar);
  card.appendChild(quotaBar);
  card.appendChild(list);
  card.appendChild(note);
  wrap.appendChild(card);
  wrap.appendChild(menu);
  wrap.appendChild(pill);
  root.appendChild(style);
  root.appendChild(wrap);

  function send(payload) {
    try {
      if (typeof window.__agSwitcherSend === 'function') window.__agSwitcherSend(JSON.stringify(payload));
    } catch (e) { /* noop */ }
  }

  function fmtPct(v) {
    if (v == null || isNaN(v)) return '—';
    var p = v * 100;
    return (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + '%';
  }

  function barColor(v) {
    if (v == null) return 'var(--agp-track)';
    if (v >= 0.5) return '#50FA7B';
    if (v >= 0.2) return '#F1FA8C';
    return '#FF5555';
  }

  function timeLeft(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var m = Math.round((t - Date.now()) / 60000);
    if (m <= 0) return '0м';
    if (m < 60) return m + 'м';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'ч ' + (m % 60) + 'м';
    var d = Math.floor(h / 24);
    return d + 'д ' + (h % 24) + 'ч';
  }

  function pctOf(q) {
    return q && q.pct != null ? q.pct : -1;
  }

  function resetOf(q) {
    var t = q && q.reset ? Date.parse(q.reset) : NaN;
    return isNaN(t) ? Infinity : t;
  }

  function compare(a, b) {
    if (sortMode === 'weekly') return pctOf(b.weekly) - pctOf(a.weekly);
    if (sortMode === 'reset5h') return resetOf(a.fiveh) - resetOf(b.fiveh);
    if (sortMode === 'resetweek') return resetOf(a.weekly) - resetOf(b.weekly);
    return pctOf(b.fiveh) - pctOf(a.fiveh);
  }

  function sortedAccounts() {
    var accounts = (current.accounts || []).slice();
    var active = accounts.filter(function (a) { return a.email === current.active; });
    var rest = accounts.filter(function (a) { return a.email !== current.active; });
    rest.sort(compare);
    return active.concat(rest);
  }

  function maskEmail(email) {
    if (!hideEmails || !email) return email;
    var at = email.indexOf('@');
    if (at < 0) return '•••';
    return email.charAt(0) + '•••' + email.slice(at);
  }

  function meter(label, q) {
    var v = q && q.pct != null ? q.pct : null;
    var w = v == null ? 0 : Math.max(2, Math.min(100, v * 100));
    var time = q && q.reset ? timeLeft(q.reset) : '';
    var tip = q && q.reset ? 'сброс через ' + timeLeft(q.reset) : 'нет данных';
    return '<span class="meter" title="' + tip + '">' +
      '<span class="mhead"><i>' + label + '</i>' + (time ? '<u>(' + time + ')</u>' : '') + '</span>' +
      '<span class="mrow">' +
        '<b class="bar"><s style="width:' + w + '%;background:' + barColor(v) + '"></s></b>' +
        '<em>' + fmtPct(v) + '</em>' +
      '</span></span>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function paintNote(text, kind) {
    note.className = 'note' + (text ? ' show ' + (kind || 'info') : '');
    if (!text) {
      note.innerHTML = '';
      return;
    }
    var close = kind === 'info' ? '<button class="nx" title="Закрыть">×</button>' : '';
    note.innerHTML = '<span class="ntext">' + escapeHtml(text) + '</span>' + close;
  }

  function clearPending() {
    pendingEmail = '';
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  }

  function render() {
    root.getElementById('sortlabel').textContent =
      (SORTS.filter(function (s) { return s.id === sortMode; })[0] || SORTS[0]).short;

    menu.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-sort') === sortMode);
    });

    var accounts = sortedAccounts();
    var html = '';
    if (!accounts.length) {
      html = '<div class="empty">Нет сохранённых аккаунтов. Войди в аккаунт в АГ и нажми «+».</div>';
    }
    accounts.forEach(function (a) {
      var active = a.email === current.active;
      var switching = current.switching === a.email;
      var confirmed = pendingEmail === a.email;
      var letter = (a.email || '?').charAt(0).toUpperCase();
      html += '<div class="row' + (active ? ' active' : '') + '">' +
        '<div class="ava">' + letter + '</div>' +
        '<div class="body">' +
          '<div class="l1">' +
            '<span class="email" title="' + (hideEmails ? 'почта скрыта' : a.email) + '">' +
              maskEmail(a.email) + '</span>' +
            (active
              ? '<span class="chip">Активен</span>'
              : '<button class="sw" data-switch="' + a.email + '"' + (current.switching ? ' disabled' : '') + '>' +
                (switching ? 'переключаю…' : (confirmed ? 'Точно?' : 'Переключить')) + '</button>') +
          '</div>' +
          '<div class="meters">' + meter('5ч', a.fiveh) + meter('нед', a.weekly) + '</div>' +
        '</div>' +
      '</div>';
    });
    list.innerHTML = html;

    // collapsed pill: only the active account
    var act = (current.accounts || []).filter(function (a) { return a.email === current.active; })[0];
    if (act) {
      var five = act.fiveh && act.fiveh.pct != null ? fmtPct(act.fiveh.pct) : '—';
      var week = act.weekly && act.weekly.pct != null ? fmtPct(act.weekly.pct) : '—';
      pill.innerHTML = '<span class="pdot"></span><b>' + maskEmail(act.email) + '</b>' +
        '<span class="pv">5ч ' + five + ' · нед ' + week + '</span>' +
        '<svg class="pchev" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10 8 5.8l4.5 4.2"/></svg>';
    } else {
      pill.innerHTML = '<span class="pdot"></span><b>Нет активного аккаунта</b>' +
        '<svg class="pchev" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10 8 5.8l4.5 4.2"/></svg>';
    }

    // note area: error > warn > confirmation > auto-switch info
    var text = '';
    var kind = 'info';
    if (current.error) { text = current.error; kind = 'err'; }
    else if (current.warn) { text = current.warn; kind = 'warn'; }
    else if (noteOverride) { text = noteOverride; kind = 'info'; }
    paintNote(text, kind);

    var ut = root.getElementById('ut');
    var ub = root.getElementById('ub');
    if (current.update) {
      updateBar.classList.add('show');
      if (current.updateBusy) {
        ut.innerHTML = 'Скачиваю обновление <b>' + escapeHtml(current.update.version) + '</b>… ' +
          (current.updateProgress || 0) + '%';
        ub.disabled = true;
        ub.textContent = 'Обновляю…';
      } else {
        ut.innerHTML = 'Вышло обновление <b>' + escapeHtml(current.update.version) + '</b>';
        ub.disabled = false;
        ub.textContent = 'Обновить';
      }
      if (current.updateError) {
        ut.innerHTML += '<div class="ue">' + escapeHtml(current.updateError) + '</div>';
      }
    } else {
      updateBar.classList.remove('show');
    }

    var qt = root.getElementById('qt');
    var iq = current.imageQuota;
    if (iq && iq.reset && Date.parse(iq.reset) > Date.now()) {
      quotaBar.classList.add('show');
      var leftMin = Math.max(0, Math.round((Date.parse(iq.reset) - Date.now()) / 60000));
      var hh = Math.floor(leftMin / 60);
      var mm = leftMin % 60;
      var leftTxt = hh > 0 ? hh + 'ч' + (mm ? ' ' + mm + 'м' : '') : mm + 'м';
      var d = new Date(iq.reset);
      var clock = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      qt.innerHTML = 'Картинки: лимит исчерпан · восстановится через <b>' + leftTxt + '</b> (' + clock + ')';
    } else {
      quotaBar.classList.remove('show');
    }
  }

  function update(next) {
    current = next || current;
    if (current.update && current.update.version !== expandedForUpdate) {
      expandedForUpdate = current.update.version;
      collapsed = false;
      wrap.classList.remove('collapsed');
    }
    render();
  }

  list.addEventListener('click', function (e) {
    var b = e.target.closest('[data-switch]');
    if (!b || b.disabled) return;
    var email = b.getAttribute('data-switch');
    if (pendingEmail === email) {
      clearPending();
      noteOverride = '';
      send({ cmd: 'switch', email: email });
      render();
      return;
    }
    clearPending();
    pendingEmail = email;
    noteOverride = 'Нажми «Точно?» ещё раз, чтобы сменить аккаунт.';
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () {
      pendingEmail = '';
      noteOverride = '';
      render();
    }, 15000);
    render();
  });

  note.addEventListener('click', function (e) {
    if (!e.target.closest('.nx')) return;
    clearPending();
    noteOverride = '';
    render();
  });

  head.querySelector('#refresh').addEventListener('click', function () { send({ cmd: 'refresh' }); });
  root.getElementById('ub').addEventListener('click', function () { send({ cmd: 'update' }); });
  head.querySelector('#add').addEventListener('click', function () { send({ cmd: 'add' }); });
  head.querySelector('#collapse').addEventListener('click', function () {
    collapsed = true;
    localStorage.setItem(LS_COLLAPSED, '1');
    wrap.classList.add('collapsed');
  });
  pill.addEventListener('click', function () {
    collapsed = false;
    localStorage.setItem(LS_COLLAPSED, '0');
    wrap.classList.remove('collapsed');
  });
  head.querySelector('#eye').addEventListener('click', function () {
    hideEmails = !hideEmails;
    localStorage.setItem(LS_HIDE, hideEmails ? '1' : '0');
    this.innerHTML = hideEmails ? EYE_OFF : EYE_ON;
    this.title = hideEmails ? 'Показать почты' : 'Скрыть почты';
    render();
  });
  head.querySelector('#sortbtn').addEventListener('click', function (e) {
    e.stopPropagation();
    menu.classList.toggle('show');
  });
  menu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-sort]');
    if (!b) return;
    sortMode = b.getAttribute('data-sort');
    localStorage.setItem(LS_SORT, sortMode);
    menu.classList.remove('show');
    render();
  });
  wrap.addEventListener('click', function (e) {
    if (!e.target.closest('#sortbtn') && !e.target.closest('.menu')) menu.classList.remove('show');
  });

  window.__agSwitcher = {
    update: update,
    destroy: function () { host.remove(); }
  };

  render();
  window.__agSwitcherQuotaHit = function (model, reset) {
    send({ cmd: 'imageQuota', model: model, reset: reset });
  };

  (function () {
    if (window.__agQuotaHooks) return;
    window.__agQuotaHooks = true;

    function scan(txt) {
      if (!txt || txt.indexOf('quotaResetTimeStamp') === -1) return;
      var re = /"metadata"\s*:\s*\{[^}]*\}/g;
      var m;
      while ((m = re.exec(txt))) {
        var block = m[0];
        var model = (block.match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || '';
        var reset = (block.match(/"quotaResetTimeStamp"\s*:\s*"([^"]+)"/) || [])[1] || '';
        if (model && reset && /image/i.test(model)) {
          try { window.__agSwitcherQuotaHit(model, reset); } catch (e) { /* ignore */ }
        }
      }
    }

    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function () {
        var p = origFetch.apply(this, arguments);
        try {
          p.then(function (res) {
            try {
              var url = String(res.url || '');
              if (url.indexOf('LanguageServerService') === -1) return res;
              if (!/Cascade|Stream|Agent/i.test(url)) return res;
              var clone = res.clone();
              if (!clone.body) return res;
              var reader = clone.body.getReader();
              var dec = new TextDecoder();
              var buf = '';
              var total = 0;
              (function pump() {
                reader.read().then(function (r) {
                  if (r.done) return;
                  total += r.value.length;
                  if (total > 3 * 1024 * 1024) {
                    try { reader.cancel(); } catch (e) { /* ignore */ }
                    return;
                  }
                  buf += dec.decode(r.value, { stream: true });
                  scan(buf);
                  if (buf.length > 120000) buf = buf.slice(-60000);
                  pump();
                }).catch(function () {});
              })();
            } catch (e) { /* ignore */ }
            return res;
          }).catch(function () {});
        } catch (e) { /* ignore */ }
        return p;
      };
    }

    var OrigWS = window.WebSocket;
    if (OrigWS) {
      function PatchedWS(url, protocols) {
        var ws = new OrigWS(url, protocols);
        try {
          ws.addEventListener('message', function (ev) {
            if (typeof ev.data === 'string') scan(ev.data);
          });
        } catch (e) { /* ignore */ }
        return ws;
      }
      PatchedWS.prototype = OrigWS.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
        try { PatchedWS[k] = OrigWS[k]; } catch (e) { /* ignore */ }
      });
      window.WebSocket = PatchedWS;
    }
  })();

  send({ cmd: 'hello' });
})();
