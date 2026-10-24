'use strict';
// Panel klubu (właściciel siłowni / klubu, trenerzy). Klucz poniżej to publiczny klucz "anon" — dostęp pilnuje
// serwer (RLS i funkcje z migracji 009 i 012): admin klubu widzi wszystko, trener tylko swoje grupy.
// Liczniki (saldo, wejścia) zmieniamy tylko różnicą (apply_student_deltas) — tak jak aplikacja, żeby
// telefon i panel nie nadpisywały sobie zmian. Strona nie ma ciasteczek ani analityki.
// Bez danych zdrowotnych i notatek prywatnych — te zostają tylko w telefonie trenera.

const SUPABASE_URL = 'https://opnxkasrzuepgbimwndz.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnhrYXNyenVlcGdiaW13bmR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0MzQ1NDIsImV4cCI6MjEwODAxMDU0Mn0.07KQDYvpmzZuPK4aMW9vRZovB0qPYNzJdW2eXExtSpo';
const sb = supabase.createClient(SUPABASE_URL, ANON, {
  auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, storageKey: 'nt-klub-auth' },
});

const app = document.getElementById('app');
const dlg = document.getElementById('dlg');
const dlgBody = document.getElementById('dlgBody');
const spaceSel = document.getElementById('space');
const posterEl = document.getElementById('poster');

let me = null;
/** Bieżąca przestrzeń: { id, name, role, club } — club=false to prywatny notatnik trenera. */
let space = null;
let spaces = [];
/** Dane podstawowe przestrzeni (ładowane raz, odświeżane po zmianach). */
let core = null;

// ---------- Pomocnicze (zawsze textContent — dane klientów nigdy nie trafiają do HTML) ----------
function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
  return e;
}
const badge = (text, tone) => h('span', { class: 'badge' + (tone ? ' ' + tone : '') }, text);
const note = (text, tone) => h('div', { class: 'note ' + (tone || 'info') }, text);
const render = (...nodes) => app.replaceChildren(...nodes);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pad = (n) => String(n).padStart(2, '0');
const zl = (n) => `${Number(n || 0).toLocaleString('pl-PL')} zł`;
const plural = (n, one, few, many) => {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
};
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayKey = (d) => isoDay(d).replace(/-/g, '');
const fmtDay = (v) => { if (!v) return '—'; const [y, m, d] = String(v).slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const parseDay = (v) => { const [y, m, d] = String(v).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const monthLabel = (d) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const WEEKDAYS = [[1, 'pon'], [2, 'wt'], [3, 'śr'], [4, 'czw'], [5, 'pt'], [6, 'sob'], [0, 'nd']];
const KIND = { group: 'Grupa', individual: 'Indywidualny', open: 'Wolne wejścia' };
const PASS = { single: 'Za wejście', entries: 'Karnet na wejścia', monthly: 'Miesięczny' };
const PAY_KIND = { entries: 'Za wejścia', pass: 'Karnet', other: 'Inne' };
const PAY_METHOD = { cash: 'Gotówka', transfer: 'Przelew' };
const DISCIPLINES = ['Siłownia', 'Open gym', 'Fitness', 'Boks', 'Kickboxing', 'MMA', 'Muay Thai', 'BJJ'];
const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const isAdmin = () => !space || space.role === 'admin';
const norm = (t) => String(t || '').trim().toLowerCase();

function storeGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* tryb prywatny */ } }

// ---------- Serwer: każde zapytanie w imieniu wybranej przestrzeni (nagłówek x-space dla klubu) ----------
function scoped(builder) { return space && space.club ? builder.setHeader('x-space', space.id) : builder; }
const T = (table) => ({
  select: (cols, opts) => scoped(sb.from(table).select(cols, opts)),
  insert: (rows) => scoped(sb.from(table).insert(rows)),
  update: (vals) => scoped(sb.from(table).update(vals)),
  del: () => scoped(sb.from(table).delete()),
});
async function ok(p) {
  const { data, error } = await p;
  if (error) throw new Error(friendly(error.message));
  return data;
}
function friendly(msg) {
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Brak połączenia z internetem. Spróbuj ponownie.';
  if (/check_in|checkin_token|self_check_in/.test(msg) && /function|does not exist/i.test(msg)) return 'Serwer nie ma jeszcze funkcji wejść — trzeba uruchomić migrację 012 w Supabase.';
  if (/groups_kind_check/.test(msg)) return 'Serwer nie zna jeszcze grup „Wolne wejścia” — trzeba uruchomić migrację 012 w Supabase.';
  if (/row-level security/i.test(msg)) return 'Brak uprawnień do tej zmiany (trener widzi tylko swoje grupy).';
  return msg;
}
const rpc = (name, args) => ok(scoped(sb.rpc(name, args || {})));
/** Wszystkie wiersze (serwer oddaje po 1000). */
async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await ok(build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
/** Zmiana salda / wejść o różnicę — paczka z identyfikatorem, więc ponowienie nie nalicza drugi raz. */
async function delta(id, d) {
  const item = { id, balance: d.balance || 0, entries: d.entries || 0 };
  if (!item.balance && !item.entries) return;
  await rpc('apply_student_deltas', { p_deltas: [item], p_batch: crypto.randomUUID() });
}

async function loadCore() {
  const [groups, students, members, schedule, coaches] = await Promise.all([
    all(() => T('groups').select('id,name,discipline,kind,schedule,archived,created_at').order('created_at')),
    all(() => T('students').select('id,name,pass_type,entries_left,valid_until,price,balance,archived,user_id,created_at').order('name')),
    all(() => T('group_members').select('group_id,student_id')),
    all(() => T('group_schedule').select('id,group_id,weekday,time,duration_min')),
    space.club ? all(() => T('group_coaches').select('group_id,user_id')).catch(() => []) : Promise.resolve([]),
  ]);
  const byStudent = new Map();
  for (const m of members) {
    if (!byStudent.has(m.student_id)) byStudent.set(m.student_id, []);
    byStudent.get(m.student_id).push(m.group_id);
  }
  core = { groups, students, members, schedule, coaches, byStudent, loadedAt: Date.now() };
  return core;
}
async function getCore(force) {
  if (!core || force || Date.now() - core.loadedAt > 60000) await loadCore();
  return core;
}
const groupName = (id) => (core.groups.find((g) => g.id === id) || {}).name || '—';
const studentById = (id) => core.students.find((x) => x.id === id);
const activeGroups = () => core.groups.filter((g) => !g.archived);
const openGroups = () => activeGroups().filter((g) => g.kind === 'open');

// ---------- Karnety (te same zasady co w aplikacji: src/logic/checkin.ts) ----------
function daysUntil(v, today) {
  return Math.round((parseDay(v) - startOfDay(today)) / 864e5);
}
function passLabel(st) {
  if (st.pass_type === 'entries') { const n = st.entries_left; return `${n} ${plural(n, 'wejście', 'wejścia', 'wejść')}`; }
  if (st.pass_type === 'monthly') return st.valid_until ? `do ${fmtDay(st.valid_until)}` : 'miesięczny bez daty';
  return st.price > 0 ? `za wejście ${zl(st.price)}` : 'za wejście';
}
function expiring(students, today, recent) {
  const out = [];
  for (const st of students) {
    if (st.archived) continue;
    if (st.pass_type === 'monthly' && st.valid_until) {
      const days = daysUntil(st.valid_until, today);
      if (days <= 3 && days >= -14) out.push({ ...st, reason: days < 0 ? 'expired' : 'expires_soon', days });
    } else if (st.pass_type === 'entries' && st.entries_left <= 1 && (!recent || recent.has(st.id))) {
      out.push({ ...st, reason: st.entries_left <= 0 ? 'no_entries' : 'last_entries', days: null });
    }
  }
  return out.sort((a, b) => (a.days || 0) - (b.days || 0) || a.name.localeCompare(b.name, 'pl'));
}
function reasonLabel(p) {
  if (p.reason === 'expires_soon') return p.days === 0 ? 'kończy się dziś' : p.days === 1 ? 'kończy się jutro' : `do ${fmtDay(p.valid_until)}`;
  if (p.reason === 'expired') return `wygasł ${fmtDay(p.valid_until)}`;
  return p.reason === 'last_entries' ? 'ostatnie wejście' : 'brak wejść';
}
function warningText(w, r) {
  return {
    last_entries: 'Zostało ostatnie wejście na karnecie.',
    no_entries: 'Karnet się skończył — wejście zapisane bez naliczenia.',
    expires_soon: `Karnet ważny do ${fmtDay(r.valid_until)}.`,
    expired: r.valid_until ? `Karnet wygasł ${fmtDay(r.valid_until)}.` : 'Karnet nie ma daty ważności.',
  }[w] || '';
}

/** Obecności z zakresu dat (z datą treningu). */
async function attendanceBetween(from, to, cols) {
  return all(() => T('attendance')
    .select(`student_id,status,charged,training_id,trainings!inner(starts_at,group_id)${cols ? ',' + cols : ''}`)
    .gte('trainings.starts_at', from.toISOString())
    .lt('trainings.starts_at', to.toISOString()));
}

// ---------- CSV dla polskiego Excela (średnik, przecinek dziesiętny, BOM, CRLF, ochrona przed formułami) ----------
function cell(v) {
  let t = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
const line = (...cells) => cells.map(cell).join(';');
const money = (n) => Number(n || 0).toFixed(2).replace('.', ',');
function download(name, rows) {
  const blob = new Blob([`﻿${rows.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Okna i przyciski ----------
function runBtn(label, cls, fn, out) {
  const b = h('button', { type: 'button', class: cls }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const msg = await fn();
      if (msg && out) out.replaceChildren(msg instanceof Node ? msg : note(msg, 'ok'));
    } catch (e) {
      if (out) out.replaceChildren(note(e.message, 'err')); else alert(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function openDialog(...nodes) { dlgBody.replaceChildren(...nodes); if (!dlg.open) dlg.showModal(); }
function dlgHead(title, sub) {
  return h('div', { class: 'dlg-head' },
    h('div', {}, h('h2', {}, title), sub ? h('div', { class: 'muted small' }, sub) : null),
    h('button', { type: 'button', onclick: () => dlg.close() }, 'Zamknij'));
}
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
const field = (label, input) => h('label', { class: 'f' }, label, input);
function select(options, value) {
  return h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
}
function tile(value, label, warn) { return h('div', { class: 'card tile' + (warn ? ' warn' : '') }, h('b', {}, value), h('span', {}, label)); }
function table(head, rows, foot) {
  return h('div', { class: 'card tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, head.map((t) => (Array.isArray(t) ? h('th', { class: t[1] }, t[0]) : h('th', {}, t))))),
    h('tbody', {}, rows),
    foot ? h('tfoot', {}, foot) : null));
}
const td = (v, cls) => h('td', { class: cls }, v);

/** Wybór klienta z wyszukiwaniem (lista podpowiedzi). */
function studentPicker(initialId) {
  const listId = 'st-' + Math.random().toString(36).slice(2);
  const active = core.students.filter((x) => !x.archived);
  const label = (x) => `${x.name} · ${passLabel(x)}`;
  const input = h('input', { list: listId, placeholder: 'Zacznij pisać imię…', autocomplete: 'off', value: initialId ? (studentById(initialId) || {}).name : '' });
  const dl = h('datalist', { id: listId }, active.map((x) => h('option', { value: x.name }, label(x))));
  return {
    el: h('div', {}, input, dl),
    get id() {
      const v = norm(input.value);
      const exact = active.filter((x) => norm(x.name) === v);
      return exact.length === 1 ? exact[0].id : initialId && norm((studentById(initialId) || {}).name) === v ? initialId : null;
    },
  };
}

// ---------- Logowanie ----------
function loginView(message) {
  document.getElementById('header').hidden = true;
  const emailIn = h('input', { type: 'email', placeholder: 'twoj@email.pl', autocomplete: 'email' });
  const codeIn = h('input', { inputmode: 'numeric', placeholder: '123456', maxlength: 6, autocomplete: 'one-time-code' });
  const out = h('div', {});
  const codeBox = h('div', { class: 'row', hidden: true }, codeIn,
    runBtn('Zaloguj', 'primary', async () => {
      const { error } = await sb.auth.verifyOtp({ email: emailIn.value.trim().toLowerCase(), token: codeIn.value.trim(), type: 'email' });
      if (error) throw new Error(error.message);
      await boot();
    }, out));
  const oauth = (provider) => async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: location.origin + location.pathname } });
    if (error) throw new Error(/not enabled|Unsupported provider/i.test(error.message) ? 'To logowanie nie jest jeszcze włączone na serwerze.' : error.message);
  };
  render(h('div', { class: 'center' },
    h('h1', {}, 'Panel klubu'),
    h('p', { class: 'muted' }, 'Klienci, karnety, wejścia i wpłaty Twojego klubu — to samo konto co w aplikacji Notatnik Trenera.'),
    message ? note(message, 'err') : null,
    h('div', { class: 'card stack' },
      runBtn('Zaloguj przez Google', 'primary', oauth('google'), out),
      runBtn('Zaloguj przez Apple', 'dark', oauth('apple'), out),
      h('div', { class: 'muted small' }, 'albo kodem z e-maila (konto musi już istnieć — załóż je w aplikacji):'),
      h('div', { class: 'row' }, emailIn,
        runBtn('Wyślij kod', '', async () => {
          const email = emailIn.value.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Wpisz poprawny e-mail.');
          const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
          if (error) throw new Error(/Signups not allowed/i.test(error.message) ? 'Nie ma konta z tym e-mailem. Zaloguj się tak jak w aplikacji (Google / Apple).' : error.message);
          codeBox.hidden = false;
          codeIn.focus();
          return 'Kod wysłany. Sprawdź skrzynkę (i spam).';
        }, out)),
      codeBox,
      out),
    h('p', { class: 'muted small' }, 'Logując się z konta „Ukryj mój e-mail” (Apple), użyj przycisku Apple.')));
}

// ---------- Pulpit ----------
async function pulpit() {
  render(h('h1', {}, 'Pulpit'), h('p', { class: 'muted' }, 'Ładowanie…'));
  await getCore(true);
  const now = new Date();
  const mFrom = startOfMonth(now), mTo = addMonths(mFrom, 1);
  const from30 = new Date(now.getTime() - 30 * 864e5);
  const [pays, att] = await Promise.all([
    all(() => T('payments').select('amount,kind,method,paid_at').gte('paid_at', mFrom.toISOString()).lt('paid_at', mTo.toISOString())),
    attendanceBetween(from30 < mFrom ? from30 : mFrom, mTo),
  ]);
  const present = att.filter((a) => a.status === 'present');
  const inMonth = present.filter((a) => new Date(a.trainings.starts_at) >= mFrom);
  const today0 = startOfDay(now).getTime();
  const today = present.filter((a) => { const t = new Date(a.trainings.starts_at).getTime(); return t >= today0 && t < today0 + 864e5; });
  const recent = new Set(present.filter((a) => new Date(a.trainings.starts_at) >= from30).map((a) => a.student_id));
  const active = core.students.filter((x) => !x.archived);
  const debt = active.filter((x) => x.balance > 0).sort((a, b) => b.balance - a.balance);
  const exp = expiring(active, now, recent);
  const revenue = pays.reduce((a, p) => a + p.amount, 0);

  // wejścia dzień po dniu w bieżącym miesiącu
  const days = new Date(mFrom.getFullYear(), mFrom.getMonth() + 1, 0).getDate();
  const perDay = Array.from({ length: days }, () => 0);
  for (const a of inMonth) perDay[new Date(a.trainings.starts_at).getDate() - 1]++;

  const listCard = (title, items, empty, right) => h('div', { class: 'card stack' }, h('h2', {}, title),
    items.length ? h('div', { class: 'list' }, items.slice(0, 8).map((x) => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, x.name), h('div', { class: 'muted small' }, passLabel(x))),
      right(x),
      h('button', { type: 'button', onclick: () => clientDialog(x.id, () => route()) }, 'Otwórz')))) : h('p', { class: 'muted' }, empty),
    items.length > 8 ? h('a', { href: '#klienci', class: 'small' }, `Wszystkie (${items.length}) →`) : null);

  render(
    h('div', { class: 'row' }, h('h1', {}, 'Pulpit'), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, monthLabel(now))),
    h('div', { class: 'tiles' },
      tile(zl(revenue), `przychód (${MONTHS[now.getMonth()]})`),
      tile(String(today.length), 'wejść dziś'),
      tile(String(inMonth.length), 'wejść w tym miesiącu'),
      tile(String(recent.size), 'klientów aktywnych (30 dni)'),
      tile(String(active.length), 'klientów w bazie'),
      tile(zl(debt.reduce((a, x) => a + x.balance, 0)), `zaległości (${debt.length} ${plural(debt.length, 'osoba', 'osoby', 'osób')})`, debt.length > 0),
      tile(String(exp.length), 'kończących się karnetów', exp.length > 0)),
    h('div', { class: 'card stack' },
      h('h2', {}, `Wejścia dziennie — ${monthLabel(now)}`),
      barChart(perDay.map((v, i) => ({ label: String(i + 1), value: v, title: `${i + 1} ${MONTHS[now.getMonth()]}: ${v} ${plural(v, 'wejście', 'wejścia', 'wejść')}`, dim: i + 1 > now.getDate() })))),
    h('div', { class: 'cols' },
      listCard('Kończą się karnety', exp, 'Nic się nie kończy w najbliższych dniach.', (x) => badge(reasonLabel(x), x.reason === 'expired' || x.reason === 'no_entries' ? 'accent' : '')),
      listCard('Zaległości', debt, 'Nikt nie zalega z płatnością.', (x) => badge(zl(x.balance), 'accent'))),
    note('Przypomnienia o karnetach klienci z aplikacją dostają sami (powiadomienie w telefonie). Wiadomość WhatsApp/SMS wyślesz z aplikacji trenera — numery telefonów są tylko w telefonie.'));
}

/** Wykres słupkowy jednej serii z podpowiedzią po najechaniu (tabela wartości w atrybucie aria). */
function barChart(points) {
  const W = 720, H = 180, top = 12, bottom = 22, left = 28;
  const max = Math.max(4, ...points.map((p) => p.value));
  const step = Math.ceil(max / 4);
  const yMax = step * 4;
  const plotH = H - top - bottom;
  const bw = (W - left) / points.length;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': points.map((p) => p.title).join('; ') });
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH - (plotH * i) / 4;
    svg.append(s('line', { x1: left, x2: W, y1: y, y2: y, class: 'gridline' }));
    const t = s('text', { x: left - 6, y: y + 4, 'text-anchor': 'end', class: 'axis' });
    t.textContent = String(step * i);
    svg.append(t);
  }
  const wrap = h('div', { class: 'chart' });
  const tip = h('div', { class: 'tip', hidden: true });
  points.forEach((p, i) => {
    const x = left + i * bw;
    const barW = Math.max(3, Math.min(14, bw - 4));
    const hgt = (plotH * p.value) / yMax;
    const cx = x + bw / 2;
    if (p.value > 0) {
      const r = Math.min(4, barW / 2, hgt);
      const y0 = top + plotH, y1 = y0 - hgt, xl = cx - barW / 2, xr = cx + barW / 2;
      svg.append(s('path', { class: 'bar' + (p.dim ? ' dim' : ''), d: `M${xl},${y0}V${y1 + r}Q${xl},${y1} ${xl + r},${y1}H${xr - r}Q${xr},${y1} ${xr},${y1 + r}V${y0}Z` }));
    }
    if (points.length <= 31 && (i === 0 || (i + 1) % 5 === 0)) {
      const t = s('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis' });
      t.textContent = p.label;
      svg.append(t);
    }
    const hit = s('rect', { x, y: top, width: bw, height: plotH, class: 'bar-hit' });
    hit.addEventListener('mouseenter', () => {
      tip.textContent = p.title;
      tip.hidden = false;
      const box = svg.getBoundingClientRect();
      tip.style.left = `${(cx / W) * box.width}px`;
      tip.style.top = `${((top + plotH - hgt) / H) * box.height}px`;
    });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.append(hit);
  });
  wrap.append(svg, tip);
  return wrap;
}

// ---------- Recepcja ----------
let receptionGroup = null;
let lastEntry = null;
async function recepcja() {
  render(h('h1', {}, 'Recepcja'), h('p', { class: 'muted' }, 'Ładowanie…'));
  await getCore(true);
  const groups = openGroups();
  if (!groups.length) {
    render(h('h1', {}, 'Recepcja'),
      h('div', { class: 'card stack' },
        h('p', {}, 'Recepcja działa dla grup „Wolne wejścia” (siłownia, open gym): klient przychodzi, kiedy chce, a wejście rozlicza się z karnetu.'),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => groupDialog(null, 'open') }, 'Załóż grupę wolnych wejść'))));
    return;
  }
  if (!groups.find((g) => g.id === receptionGroup)) receptionGroup = groups[0].id;
  const gid = receptionGroup;
  const tid = `open-${gid}-${dayKey(new Date())}`;
  const todayRows = await all(() => T('attendance').select('student_id,status,charged').eq('training_id', tid));
  const inToday = new Set(todayRows.filter((r) => r.status === 'present').map((r) => r.student_id));
  const members = new Set(core.members.filter((m) => m.group_id === gid).map((m) => m.student_id));

  const search = h('input', { type: 'search', class: 'big', placeholder: 'Szukaj klienta (imię)…', autocomplete: 'off', 'aria-label': 'Szukaj klienta' });
  const results = h('div', {});
  const banner = h('div', {});
  const showBanner = () => {
    if (!lastEntry) return banner.replaceChildren();
    const r = lastEntry.result;
    const warn = !!r.warning;
    banner.replaceChildren(h('div', { class: 'banner ' + (warn ? 'warn' : 'ok'), 'aria-live': 'polite' },
      h('div', { class: 'grow', style: 'flex:1' },
        h('b', {}, `${r.name} — ${r.status === 'already' ? 'już dziś było' : 'wejście zapisane'}`),
        h('div', {}, passLabel(r) + (r.pass_type === 'single' && r.balance > 0 ? ` · do zapłaty ${zl(r.balance)}` : '')),
        warn ? h('div', {}, warningText(r.warning, r)) : null),
      r.status === 'ok' ? runBtn('Cofnij', '', async () => { await undoEntry(gid, lastEntry.id); lastEntry = null; await recepcja(); }) : null));
  };
  const draw = () => {
    const q = norm(search.value);
    const list = core.students.filter((x) => !x.archived && (q ? norm(x.name).includes(q) : members.has(x.id) || inToday.has(x.id)))
      .sort((a, b) => (members.has(b.id) - members.has(a.id)) || a.name.localeCompare(b.name, 'pl')).slice(0, 60);
    results.replaceChildren(...(list.length ? list.map((x) => {
      const isIn = inToday.has(x.id);
      return h('button', {
        type: 'button', class: 'pick' + (isIn ? ' in' : ''),
        onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try {
            if (isIn) {
              if (confirm(`${x.name}: wejście z dzisiaj jest już zapisane. Cofnąć je?`)) { await undoEntry(gid, x.id); lastEntry = null; await recepcja(); }
              return;
            }
            const result = await rpc('check_in', { p_student_id: x.id, p_group_id: gid });
            lastEntry = { id: x.id, result };
            await recepcja();
          } catch (err) { alert(err.message); } finally { b.disabled = false; }
        },
      },
      h('div', { class: 'grow' }, h('div', { class: 'name', style: 'font-weight:700' }, x.name),
        h('div', { class: 'muted small' }, passLabel(x) + (x.balance > 0 ? ` · zaległość ${zl(x.balance)}` : ''))),
      h('span', { class: 'go' }, isIn ? '✓ dziś' : 'Wejście'));
    }) : [h('p', { class: 'muted' }, q ? 'Nikogo takiego — dodaj klienta w zakładce „Klienci”.' : 'Brak stałych klientów tej grupy. Wyszukaj klienta po imieniu.')]));
  };
  search.addEventListener('input', debounce(draw, 120));
  showBanner();
  draw();

  const todayList = todayRows.filter((r) => r.status === 'present').map((r) => studentById(r.student_id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  render(
    h('div', { class: 'row' }, h('h1', {}, 'Recepcja'), h('span', { class: 'spacer' }),
      groups.length > 1 ? (() => { const sel = select(groups.map((g) => [g.id, g.name]), gid); sel.addEventListener('change', () => { receptionGroup = sel.value; lastEntry = null; recepcja(); }); return sel; })() : badge(groups[0].name),
      isAdmin() ? h('button', { type: 'button', onclick: () => qrDialog() }, 'Kod QR przy wejściu') : null),
    h('div', { class: 'cols wide' },
      h('div', { class: 'stack' }, banner, search, h('p', { class: 'muted small', style: 'margin:0' }, 'Kliknij klienta, żeby zapisać wejście. Jedno wejście dziennie — drugie kliknięcie nic nie nalicza.'), results),
      h('div', { class: 'card stack' },
        h('h2', {}, `Dziś: ${todayList.length} ${plural(todayList.length, 'wejście', 'wejścia', 'wejść')}`),
        todayList.length ? h('div', { class: 'list' }, todayList.map((x) => h('div', { class: 'item' },
          h('div', { class: 'grow' }, h('div', { class: 'name' }, x.name), h('div', { class: 'muted small' }, passLabel(x))),
          h('button', { type: 'button', class: 'link', onclick: async () => { if (confirm(`Cofnąć dzisiejsze wejście: ${x.name}?`)) { await undoEntry(gid, x.id).catch((e) => alert(e.message)); await recepcja(); } } }, 'Cofnij')))) : h('p', { class: 'muted' }, 'Jeszcze nikt nie wszedł.'),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Wejścia ze skanowania kodu QR i z aplikacji trenera też tu trafiają.'))));
  search.focus();
}

/** Cofnięcie dzisiejszego wejścia: zwrot wejścia z karnetu / zdjęcie ceny z zaległości. */
async function undoEntry(gid, studentId) {
  const tid = `open-${gid}-${dayKey(new Date())}`;
  const rows = await ok(T('attendance').select('charged').eq('training_id', tid).eq('student_id', studentId));
  if (!rows.length) return;
  await ok(T('attendance').del().eq('training_id', tid).eq('student_id', studentId));
  const st = (await ok(T('students').select('id,pass_type,price').eq('id', studentId)))[0];
  if (rows[0].charged && st) {
    if (st.pass_type === 'entries') await delta(st.id, { entries: 1 });
    else if (st.pass_type === 'single' && st.price > 0) await delta(st.id, { balance: -st.price });
  }
}

/** Plakat z kodem QR: klient skanuje aparatem telefonu → aplikacja zapisuje wejście. */
async function qrDialog(rotate) {
  const out = h('div', {});
  openDialog(dlgHead('Kod QR przy wejściu', space.name), h('p', { class: 'muted' }, 'Ładowanie…'));
  let token;
  try { token = await rpc('checkin_token', { p_space: space.id, p_rotate: !!rotate }); } catch (e) { openDialog(dlgHead('Kod QR przy wejściu'), note(e.message, 'err')); return; }
  const url = `notatniktrenera://wejscie?k=${token}`;
  const makePoster = () => {
    posterEl.replaceChildren(h('h1', {}, space.name), qrSvg(url), h('p', {}, 'Zeskanuj aparatem telefonu i otwórz w aplikacji Notatnik Trenera — wejście zapisze się samo.'),
      h('p', { class: 'small' }, 'Nie masz aplikacji? Podejdź do recepcji.'));
  };
  openDialog(dlgHead('Kod QR przy wejściu', space.name),
    h('div', { style: 'display:flex;justify-content:center' }, h('div', { style: 'width:260px;height:260px' }, qrSvg(url))),
    note('Wydrukuj i powieś przy wejściu. Działa dla klientów z aplikacją, połączonych ze swoją kartą (dołączyli kodem zaproszenia). Jedno wejście dziennie; karnet rozlicza się sam.'),
    h('div', { class: 'actions row' },
      h('button', { type: 'button', class: 'primary', onclick: () => { makePoster(); window.print(); } }, 'Drukuj plakat'),
      runBtn('Nowy kod (stary przestanie działać)', 'danger', async () => {
        if (!confirm('Wygenerować nowy kod? Stary plakat przestanie działać.')) return null;
        await qrDialog(true);
        return null;
      }, out)),
    out);
}
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 2;
  const svg = s('svg', { viewBox: `0 0 ${n + q * 2} ${n + q * 2}`, width: '100%', height: '100%', role: 'img', 'aria-label': 'Kod QR wejścia', 'shape-rendering': 'crispEdges' });
  svg.append(s('rect', { width: n + q * 2, height: n + q * 2, fill: '#fff' }));
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q},${r + q}h1v1h-1z`;
  svg.append(s('path', { d, fill: '#000' }));
  return svg;
}

// ---------- Klienci ----------
let clientsQuery = '';
let clientsFilter = 'active';
async function klienci() {
  render(h('h1', {}, 'Klienci'), h('p', { class: 'muted' }, 'Ładowanie…'));
  await getCore(true);
  const now = new Date();
  const att = await attendanceBetween(new Date(now.getTime() - 30 * 864e5), new Date(now.getTime() + 864e5));
  const visits = new Map();
  for (const a of att) if (a.status === 'present') visits.set(a.student_id, (visits.get(a.student_id) || 0) + 1);
  const exp = new Map(expiring(core.students, now, new Set(visits.keys())).map((p) => [p.id, p]));

  const search = h('input', { type: 'search', placeholder: 'Szukaj po imieniu', value: clientsQuery, 'aria-label': 'Szukaj klienta' });
  const filter = select([['active', 'Aktywni'], ['expiring', 'Kończące się karnety'], ['debt', 'Z zaległością'], ['archived', 'Archiwum']], clientsFilter);
  const box = h('div', {});
  const filtered = () => core.students.filter((x) => {
    if (clientsFilter === 'archived' ? !x.archived : x.archived) return false;
    if (clientsFilter === 'expiring' && !exp.has(x.id)) return false;
    if (clientsFilter === 'debt' && !(x.balance > 0)) return false;
    return !clientsQuery || norm(x.name).includes(norm(clientsQuery));
  });
  const draw = () => {
    const list = filtered();
    box.replaceChildren(list.length ? table(
      ['Klient', 'Karnet', ['Zaległość', 'num'], 'Grupy', ['Wejścia (30 dni)', 'num']],
      list.map((x) => h('tr', { class: 'click', onclick: () => clientDialog(x.id, () => klienci()) },
        td(h('div', {}, h('div', { style: 'font-weight:700' }, x.name), x.user_id ? h('div', { class: 'muted small' }, 'ma aplikację') : null)),
        td(h('div', {}, h('div', {}, PASS[x.pass_type] || x.pass_type), h('div', { class: 'muted small' }, passLabel(x)), exp.has(x.id) ? badge(reasonLabel(exp.get(x.id)), 'accent') : null)),
        td(x.balance > 0 ? badge(zl(x.balance), 'accent') : '—', 'num'),
        td((core.byStudent.get(x.id) || []).map(groupName).join(', ') || '—', 'small'),
        td(String(visits.get(x.id) || 0), 'num')))) : h('div', { class: 'card empty' }, 'Brak klientów w tym widoku.'));
  };
  search.addEventListener('input', debounce(() => { clientsQuery = search.value; draw(); }, 200));
  filter.addEventListener('change', () => { clientsFilter = filter.value; draw(); });
  render(
    h('div', { class: 'row' }, h('h1', {}, 'Klienci'), h('span', { class: 'muted' }, `${core.students.filter((x) => !x.archived).length} aktywnych`)),
    h('div', { class: 'toolbar' }, search, filter,
      h('button', { type: 'button', class: 'primary', onclick: () => newClientDialog() }, '+ Nowy klient'),
      h('button', { type: 'button', onclick: () => importDialog() }, 'Import listy'),
      h('button', { type: 'button', onclick: () => exportClients(filtered()) }, 'Eksport CSV')),
    box);
  draw();
}

function exportClients(list) {
  download(`klienci-${isoDay(new Date())}.csv`, [
    line('Imię', 'Karnet', 'Wejścia', 'Ważny do', 'Cena za wejście (zł)', 'Zaległość (zł)', 'Grupy', 'Aplikacja'),
    ...list.map((x) => line(x.name, PASS[x.pass_type] || x.pass_type, x.pass_type === 'entries' ? x.entries_left : '', x.valid_until || '',
      money(x.price), money(x.balance), (core.byStudent.get(x.id) || []).map(groupName).join(', '), x.user_id ? 'tak' : 'nie')),
  ]);
}

function groupChecks(selected) {
  const set = new Set(selected || []);
  const boxes = activeGroups().map((g) => {
    const c = h('input', { type: 'checkbox', checked: set.has(g.id) });
    c.dataset.id = g.id;
    return h('label', { class: 'chk' }, c, `${g.name}${g.kind === 'open' ? ' (wolne wejścia)' : ''}`);
  });
  return { el: h('div', {}, boxes.length ? boxes : h('span', { class: 'muted small' }, 'Brak grup — załóż je w zakładce „Grupy”.')), get ids() { return boxes.map((b) => b.firstChild).filter((c) => c.checked).map((c) => c.dataset.id); } };
}

function passInputs(st) {
  const type = select(Object.entries(PASS), st ? st.pass_type : 'entries');
  const entries = h('input', { type: 'number', min: 0, max: 1000, value: st ? st.entries_left : 10 });
  const until = h('input', { type: 'date', value: st && st.valid_until ? String(st.valid_until).slice(0, 10) : '' });
  const price = h('input', { type: 'number', min: 0, max: 100000, value: st ? st.price : 0 });
  const fEntries = field('Wejść na karnecie', entries);
  const fUntil = field('Ważny do', until);
  const fPrice = field('Cena za wejście (zł)', price);
  const sync = () => { fEntries.hidden = type.value !== 'entries'; fUntil.hidden = type.value !== 'monthly'; fPrice.hidden = type.value !== 'single'; };
  type.addEventListener('change', sync);
  sync();
  return {
    el: h('div', { class: 'form' }, field('Rodzaj karnetu', type), fEntries, fUntil, fPrice),
    get value() {
      const n = (el, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(el.value) || 0)));
      return { pass_type: type.value, entries_left: n(entries, 0, 1000), valid_until: until.value || null, price: n(price, 0, 100000) };
    },
  };
}

function newClientDialog(defaultGroup) {
  const name = h('input', { placeholder: 'Imię lub ksywka', maxlength: 60 });
  const pass = passInputs(null);
  const groups = groupChecks(defaultGroup ? [defaultGroup] : openGroups().slice(0, 1).map((g) => g.id));
  const out = h('div', {});
  openDialog(dlgHead('Nowy klient', 'Tylko imię lub ksywka — bez nazwiska i kontaktu (minimum danych).'),
    field('Imię', name), pass.el, h('div', { class: 'section' }, h('h3', {}, 'Grupy'), groups.el),
    h('div', { class: 'row' }, runBtn('Dodaj klienta', 'primary', async () => {
      const nm = name.value.trim();
      if (!nm) throw new Error('Podaj imię.');
      const id = newId();
      await ok(T('students').insert({ id, name: nm.slice(0, 60), ...pass.value }));
      const gids = groups.ids;
      if (gids.length) await ok(T('group_members').insert(gids.map((g) => ({ group_id: g, student_id: id }))));
      dlg.close();
      core = null;
      route();
      return null;
    }, out)), out);
  name.focus();
}

async function clientDialog(id, after) {
  openDialog(dlgHead('Klient'), h('p', { class: 'muted' }, 'Ładowanie…'));
  const [st] = await ok(T('students').select('id,name,pass_type,entries_left,valid_until,price,balance,archived,user_id,created_at').eq('id', id));
  if (!st) { openDialog(dlgHead('Klient'), note('Nie znaleziono klienta (może został usunięty w aplikacji).', 'err')); return; }
  const [hist, pays] = await Promise.all([
    all(() => T('attendance').select('status,charged,trainings!inner(starts_at,group_id)').eq('student_id', id)),
    ok(T('payments').select('id,amount,kind,method,paid_at,note').eq('student_id', id).order('paid_at', { ascending: false }).limit(15)),
  ]);
  hist.sort((a, b) => (a.trainings.starts_at < b.trainings.starts_at ? 1 : -1));
  const done = () => { core = null; dlg.close(); (after || route)(); };
  const out = h('div', {});
  const name = h('input', { value: st.name, maxlength: 60 });
  const pass = passInputs(st);
  const groups = groupChecks(core.byStudent.get(id) || []);

  // Przedłużenie karnetu miesięcznego / dokupienie wejść, opcjonalnie z wpłatą
  const extAmount = h('input', { type: 'number', min: 0, max: 100000, placeholder: 'kwota (opcjonalnie)' });
  const extMethod = select(Object.entries(PAY_METHOD), 'cash');
  const addN = h('input', { type: 'number', min: 1, max: 1000, value: 10 });
  const payIfAny = async (amount, label) => {
    const a = Math.round(Number(amount) || 0);
    if (a > 0) await ok(T('payments').insert({ id: newId(), student_id: id, amount: a, kind: 'pass', method: extMethod.value, paid_at: new Date().toISOString(), note: label }));
  };

  openDialog(
    dlgHead(st.name, `${PASS[st.pass_type]} · ${passLabel(st)}${st.balance > 0 ? ` · zaległość ${zl(st.balance)}` : ''}${st.user_id ? ' · ma aplikację' : ''}`),
    h('div', { class: 'form' }, field('Imię', name)),
    pass.el,
    h('div', { class: 'row' }, runBtn('Zapisz', 'primary', async () => {
      const v = pass.value;
      const nm = name.value.trim();
      if (!nm) throw new Error('Podaj imię.');
      // świeży stan licznika, żeby zmienić wejścia o różnicę (aplikacja mogła je zmienić w międzyczasie)
      const [fresh] = await ok(T('students').select('entries_left').eq('id', id));
      await ok(T('students').update({ name: nm.slice(0, 60), pass_type: v.pass_type, valid_until: v.valid_until, price: v.price }).eq('id', id));
      if (v.pass_type === 'entries' && fresh) await delta(id, { entries: v.entries_left - fresh.entries_left });
      await saveGroups(id, groups.ids);
      done();
      return null;
    }, out)),
    h('div', { class: 'section' },
      h('h3', {}, 'Szybko'),
      h('div', { class: 'row' }, field('Wpłata za karnet', extAmount), field('Forma', extMethod)),
      h('div', { class: 'row' },
        runBtn('Przedłuż miesięczny o miesiąc', '', async () => {
          const today = startOfDay(new Date());
          // ważny jeszcze: +1 miesiąc od końca; po terminie / bez daty: od dziś na miesiąc (do dnia przed tym samym dniem)
          const stillValid = st.valid_until && daysUntil(st.valid_until, today) >= 0;
          const next = addMonths(stillValid ? parseDay(st.valid_until) : today, 1);
          if (!stillValid) next.setDate(next.getDate() - 1);
          await ok(T('students').update({ pass_type: 'monthly', valid_until: isoDay(next) }).eq('id', id));
          await payIfAny(extAmount.value, `Karnet do ${fmtDay(isoDay(next))}`);
          done();
          return null;
        }, out),
        h('span', { class: 'muted small' }, 'albo'),
        addN,
        runBtn('Dodaj wejścia', '', async () => {
          const n = Math.max(1, Math.min(1000, Math.round(Number(addN.value) || 0)));
          if (st.pass_type !== 'entries') await ok(T('students').update({ pass_type: 'entries' }).eq('id', id));
          await delta(id, { entries: n });
          await payIfAny(extAmount.value, `Karnet: ${n} ${plural(n, 'wejście', 'wejścia', 'wejść')}`);
          done();
          return null;
        }, out)),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => paymentDialog(id, done) }, 'Inna wpłata…'),
        st.balance > 0 ? runBtn(`Zapłacił całość (${zl(st.balance)})`, '', async () => {
          await ok(T('payments').insert({ id: newId(), student_id: id, amount: st.balance, kind: 'entries', method: extMethod.value, paid_at: new Date().toISOString(), note: '' }));
          await delta(id, { balance: -st.balance });
          done();
          return null;
        }, out) : null)),
    h('div', { class: 'section' }, h('h3', {}, 'Grupy'), groups.el),
    h('div', { class: 'section' },
      h('h3', {}, `Ostatnie wejścia (${hist.filter((x) => x.status === 'present').length})`),
      hist.length ? h('div', { class: 'small' }, hist.slice(0, 12).map((a) => h('div', {},
        `${fmtDT(a.trainings.starts_at)} · ${groupName(a.trainings.group_id)} · `,
        a.status === 'present' ? 'obecny' : a.status === 'absent' ? 'nieobecny' : 'odwołał'))) : h('p', { class: 'muted small', style: 'margin:0' }, 'Jeszcze nie był.')),
    h('div', { class: 'section' },
      h('h3', {}, 'Wpłaty'),
      pays.length ? h('div', { class: 'small' }, pays.map((p) => h('div', {}, `${fmtDay(p.paid_at.slice(0, 10))} · ${zl(p.amount)} · ${PAY_KIND[p.kind]} · ${PAY_METHOD[p.method]}${p.note ? ' · ' + p.note : ''}`))) : h('p', { class: 'muted small', style: 'margin:0' }, 'Brak wpłat.')),
    h('div', { class: 'section' }, h('div', { class: 'row' },
      st.archived
        ? runBtn('Przywróć klienta', '', async () => { await ok(T('students').update({ archived: false }).eq('id', id)); done(); return null; }, out)
        : runBtn('Archiwizuj', 'danger', async () => {
          if (!confirm(`Zarchiwizować: ${st.name}? Zniknie z list; historia i wpłaty zostaną.`)) return null;
          await ok(T('students').update({ archived: true }).eq('id', id));
          done();
          return null;
        }, out))),
    out);
}

async function saveGroups(studentId, ids) {
  const cur = new Set(core.byStudent.get(studentId) || []);
  const want = new Set(ids);
  const add = [...want].filter((g) => !cur.has(g));
  const remove = [...cur].filter((g) => !want.has(g));
  if (add.length) await ok(T('group_members').insert(add.map((g) => ({ group_id: g, student_id: studentId }))));
  for (const g of remove) await ok(T('group_members').del().eq('group_id', g).eq('student_id', studentId));
}

function importDialog() {
  const area = h('textarea', { placeholder: 'Jedno imię w linii, np.\nMarek N.\nOla\nKuba' });
  const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain' });
  const pass = passInputs(null);
  const groups = groupChecks(openGroups().slice(0, 1).map((g) => g.id));
  const preview = h('div', { class: 'small muted' });
  const out = h('div', {});
  const parse = () => {
    const existing = new Set(core.students.filter((x) => !x.archived).map((x) => norm(x.name)));
    const seen = new Set();
    const rows = [];
    for (const raw of area.value.split(/\r?\n/)) {
      let t = raw.split(/[;,\t]/)[0].replace(/^\s*(\d+[.)]|[-•*☐])\s*/, '').replace(/^"|"$/g, '').trim();
      t = t.replace(/\+?\d[\d\s-]{6,}\d/g, '').trim(); // bez numerów telefonów — na serwer trafia tylko imię
      if (!t || /^\d+$/.test(t) || /^imi[eę]$/i.test(t)) continue;
      const k = norm(t);
      rows.push({ name: t.slice(0, 60), dup: existing.has(k) || seen.has(k) });
      seen.add(k);
    }
    return rows;
  };
  const show = () => { const r = parse(); preview.textContent = r.length ? `${r.filter((x) => !x.dup).length} nowych, ${r.filter((x) => x.dup).length} już jest (pominiemy).` : ''; };
  area.addEventListener('input', debounce(show, 200));
  file.addEventListener('change', async () => { if (file.files[0]) { area.value = await file.files[0].text(); show(); } });
  openDialog(dlgHead('Import listy klientów', 'Wklej listę albo wybierz plik CSV (bierzemy pierwszą kolumnę — samo imię).'),
    area, file, preview, pass.el, h('div', { class: 'section' }, h('h3', {}, 'Dopisz do grup'), groups.el),
    h('div', { class: 'row' }, runBtn('Importuj', 'primary', async () => {
      const rows = parse().filter((x) => !x.dup);
      if (!rows.length) throw new Error('Nie ma nowych imion do dodania.');
      if (rows.length > 2000) throw new Error('Najwyżej 2000 osób naraz.');
      const v = pass.value;
      const students = rows.map((x) => ({ id: newId(), name: x.name, ...v }));
      for (let i = 0; i < students.length; i += 200) await ok(T('students').insert(students.slice(i, i + 200)));
      const gids = groups.ids;
      const links = students.flatMap((x) => gids.map((g) => ({ group_id: g, student_id: x.id })));
      for (let i = 0; i < links.length; i += 500) await ok(T('group_members').insert(links.slice(i, i + 500)));
      dlg.close();
      core = null;
      route();
      return null;
    }, out)), out);
}

// ---------- Wpłaty ----------
let payMonth = startOfMonth(new Date());
function paymentDialog(studentId, after) {
  const picker = studentPicker(studentId);
  const amount = h('input', { type: 'number', min: 1, max: 100000, placeholder: 'zł' });
  const kind = select(Object.entries(PAY_KIND), 'pass');
  const method = select(Object.entries(PAY_METHOD), 'cash');
  const date = h('input', { type: 'date', value: isoDay(new Date()) });
  const memo = h('input', { maxlength: 200, placeholder: 'np. karnet listopad' });
  const out = h('div', {});
  openDialog(dlgHead('Nowa wpłata', '„Za wejścia” zmniejsza zaległość klienta. Karnet ustawiasz na karcie klienta.'),
    h('div', { class: 'form' }, field('Klient', picker.el), field('Kwota (zł)', amount), field('Za co', kind), field('Forma', method), field('Data', date), field('Uwagi', memo)),
    h('div', { class: 'row' }, runBtn('Zapisz wpłatę', 'primary', async () => {
      const sid = picker.id;
      if (!sid) throw new Error('Wybierz klienta z listy podpowiedzi.');
      const a = Math.round(Number(amount.value) || 0);
      if (!(a > 0 && a <= 100000)) throw new Error('Kwota musi być od 1 do 100 000 zł.');
      const d = date.value ? new Date(`${date.value}T12:00:00`) : new Date();
      const paidAt = isoDay(d) === isoDay(new Date()) ? new Date() : d;
      await ok(T('payments').insert({ id: newId(), student_id: sid, amount: a, kind: kind.value, method: method.value, paid_at: paidAt.toISOString(), note: memo.value.trim().slice(0, 200) }));
      if (kind.value === 'entries') await delta(sid, { balance: -a });
      core = null;
      dlg.close();
      (after || route)();
      return null;
    }, out)), out);
}

async function wplaty() {
  render(h('h1', {}, 'Wpłaty'), h('p', { class: 'muted' }, 'Ładowanie…'));
  await getCore();
  const to = addMonths(payMonth, 1);
  const pays = await all(() => T('payments').select('id,student_id,amount,kind,method,paid_at,note').gte('paid_at', payMonth.toISOString()).lt('paid_at', to.toISOString()).order('paid_at'));
  const sum = (f) => pays.filter(f).reduce((a, p) => a + p.amount, 0);
  const nav = (n) => () => { payMonth = addMonths(payMonth, n); wplaty(); };
  render(
    h('div', { class: 'row' }, h('h1', {}, 'Wpłaty'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: nav(-1), 'aria-label': 'Poprzedni miesiąc' }, '‹'),
      h('b', {}, monthLabel(payMonth)),
      h('button', { type: 'button', onclick: nav(1), 'aria-label': 'Następny miesiąc' }, '›'),
      h('button', { type: 'button', class: 'primary', onclick: () => paymentDialog(null) }, '+ Wpłata'),
      h('button', { type: 'button', onclick: () => raportCsv(payMonth) }, 'Raport CSV')),
    h('div', { class: 'tiles' },
      tile(zl(sum(() => true)), `razem (${pays.length} ${plural(pays.length, 'wpłata', 'wpłaty', 'wpłat')})`),
      tile(zl(sum((p) => p.method === 'cash')), 'gotówka'), tile(zl(sum((p) => p.method === 'transfer')), 'przelew'),
      tile(zl(sum((p) => p.kind === 'pass')), 'karnety'), tile(zl(sum((p) => p.kind === 'entries')), 'za wejścia')),
    pays.length ? table(['Data', 'Klient', ['Kwota', 'num'], 'Za co', 'Forma', 'Uwagi', ''],
      pays.map((p) => h('tr', {},
        td(fmtDT(p.paid_at), 'small'), td((studentById(p.student_id) || { name: '(usunięty)' }).name), td(zl(p.amount), 'num'),
        td(PAY_KIND[p.kind]), td(PAY_METHOD[p.method]), td(p.note, 'small'),
        td(runBtn('Usuń', 'link', async () => {
          if (!confirm(`Usunąć wpłatę ${zl(p.amount)}?${p.kind === 'entries' ? ' Kwota wróci do zaległości klienta.' : ''}`)) return null;
          await ok(T('payments').del().eq('id', p.id));
          if (p.kind === 'entries') await delta(p.student_id, { balance: p.amount });
          core = null;
          await wplaty();
          return null;
        })))),
      h('tr', {}, td('Razem'), td(''), td(zl(sum(() => true)), 'num'), td(''), td(''), td(''), td('')))
      : h('div', { class: 'card empty' }, 'Brak wpłat w tym miesiącu.'));
}

// ---------- Raport miesięczny (ten sam układ CSV co w aplikacji) ----------
let reportMonth = startOfMonth(new Date());
async function reportData(month) {
  await getCore(true);
  const to = addMonths(month, 1);
  const [pays, att] = await Promise.all([
    all(() => T('payments').select('student_id,amount,kind,method,paid_at,note').gte('paid_at', month.toISOString()).lt('paid_at', to.toISOString()).order('paid_at')),
    attendanceBetween(month, to),
  ]);
  const trainings = new Map();
  const groups = new Map();
  const students = new Map();
  for (const a of att) {
    trainings.set(a.training_id, a.trainings.group_id);
    const g = groups.get(a.trainings.group_id) || { trainings: new Set(), present: 0, absent: 0, cancelled: 0 };
    g.trainings.add(a.training_id);
    if (a.status === 'present') g.present++; else if (a.status === 'absent') g.absent++; else g.cancelled++;
    groups.set(a.trainings.group_id, g);
    const st = students.get(a.student_id) || { present: 0, missed: 0, charged: 0 };
    if (a.status === 'present') st.present++; else st.missed++;
    if (a.charged) st.charged++;
    students.set(a.student_id, st);
  }
  const debtors = core.students.filter((x) => !x.archived && x.balance > 0).sort((a, b) => b.balance - a.balance);
  return { pays, groups, students, debtors };
}
async function raportCsv(month) {
  const d = await reportData(month);
  const sum = (f) => d.pays.filter(f).reduce((a, p) => a + p.amount, 0);
  const total = sum(() => true);
  const groupRows = [...d.groups.entries()].map(([id, g]) => ({ name: groupName(id), ...g, trainings: g.trainings.size }));
  const tr = groupRows.reduce((a, g) => a + g.trainings, 0), pr = groupRows.reduce((a, g) => a + g.present, 0), all2 = groupRows.reduce((a, g) => a + g.present + g.absent + g.cancelled, 0);
  const today = isoDay(new Date());
  const rows = [
    line(`Notatnik Trenera – raport: ${monthLabel(month)}${space.club ? ` – ${space.name}` : ''}`),
    line(`Wygenerowano: ${today}`), '',
    line('WPŁATY'),
    line('Data', 'Uczeń', 'Kwota (zł)', 'Za co', 'Forma płatności', 'Uwagi'),
    ...d.pays.map((p) => line(isoDay(new Date(p.paid_at)), (studentById(p.student_id) || { name: '' }).name, money(p.amount), PAY_KIND[p.kind], PAY_METHOD[p.method], p.note)),
    line('Razem', '', money(total)), '',
    line('PODSUMOWANIE'),
    line('Przychód razem (zł)', money(total)),
    line('Gotówka (zł)', money(sum((p) => p.method === 'cash'))),
    line('Przelew (zł)', money(sum((p) => p.method === 'transfer'))),
    line('Za wejścia (zł)', money(sum((p) => p.kind === 'entries'))),
    line('Karnety (zł)', money(sum((p) => p.kind === 'pass'))),
    line('Inne (zł)', money(sum((p) => p.kind === 'other'))),
    line('Liczba wpłat', d.pays.length), '',
    line(`ZALEGŁOŚCI (stan na ${today})`),
    line('Uczeń', 'Do zapłaty (zł)'),
    ...d.debtors.map((x) => line(x.name, money(x.balance))),
    line('Razem', money(d.debtors.reduce((a, x) => a + x.balance, 0))), '',
    line('FREKWENCJA'),
    line('Grupa', 'Treningi', 'Obecności', 'Nieobecności', 'Odwołania', 'Średnio na treningu'),
    ...groupRows.map((g) => line(g.name, g.trainings, g.present, g.absent, g.cancelled, g.trainings ? (g.present / g.trainings).toFixed(1).replace('.', ',') : '0')),
    line('Razem', tr, pr, '', '', tr ? (Math.round((pr / tr) * 10) / 10).toString().replace('.', ',') : '0'),
    line('Frekwencja (%)', all2 ? Math.round((pr / all2) * 100) : 0), '',
    line('OBECNOŚCI UCZNIÓW'),
    line('Uczeń', 'Obecny', 'Nieobecny / odwołał', 'Naliczone wejścia'),
    ...[...d.students.entries()].map(([id, x]) => ({ name: (studentById(id) || { name: '' }).name, ...x })).sort((a, b) => a.name.localeCompare(b.name, 'pl'))
      .map((x) => line(x.name, x.present, x.missed, x.charged)),
  ];
  download(`raport-${month.getFullYear()}-${pad(month.getMonth() + 1)}.csv`, rows);
}
async function raport() {
  render(h('h1', {}, 'Raport'), h('p', { class: 'muted' }, 'Ładowanie…'));
  const d = await reportData(reportMonth);
  const sum = (f) => d.pays.filter(f).reduce((a, p) => a + p.amount, 0);
  const nav = (n) => () => { reportMonth = addMonths(reportMonth, n); raport(); };
  const groupRows = [...d.groups.entries()].map(([id, g]) => ({ id, name: groupName(id), present: g.present, absent: g.absent, cancelled: g.cancelled, trainings: g.trainings.size }))
    .sort((a, b) => b.present - a.present);
  const top = [...d.students.entries()].map(([id, x]) => ({ name: (studentById(id) || { name: '(usunięty)' }).name, ...x })).sort((a, b) => b.present - a.present).slice(0, 10);
  render(
    h('div', { class: 'row' }, h('h1', {}, 'Raport'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: nav(-1), 'aria-label': 'Poprzedni miesiąc' }, '‹'), h('b', {}, monthLabel(reportMonth)),
      h('button', { type: 'button', onclick: nav(1), 'aria-label': 'Następny miesiąc' }, '›'),
      h('button', { type: 'button', class: 'primary', onclick: () => raportCsv(reportMonth).catch((e) => alert(e.message)) }, 'Pobierz CSV dla księgowej')),
    h('div', { class: 'tiles' },
      tile(zl(sum(() => true)), 'przychód'), tile(zl(sum((p) => p.method === 'cash')), 'gotówka'), tile(zl(sum((p) => p.method === 'transfer')), 'przelew'),
      tile(String(groupRows.reduce((a, g) => a + g.present, 0)), 'obecności / wejść'),
      tile(String([...d.students.values()].filter((x) => x.present > 0).length), 'różnych klientów'),
      tile(zl(d.debtors.reduce((a, x) => a + x.balance, 0)), 'zaległości (dziś)', d.debtors.length > 0)),
    h('div', { class: 'cols' },
      h('div', { class: 'stack' }, h('h2', {}, 'Grupy'),
        groupRows.length ? table(['Grupa', ['Treningi / dni', 'num'], ['Obecności', 'num'], ['Średnio', 'num']],
          groupRows.map((g) => h('tr', {}, td(g.name), td(String(g.trainings), 'num'), td(String(g.present), 'num'), td(g.trainings ? (g.present / g.trainings).toFixed(1).replace('.', ',') : '0', 'num'))))
          : h('div', { class: 'card empty' }, 'Brak obecności w tym miesiącu.')),
      h('div', { class: 'stack' }, h('h2', {}, 'Najczęściej przychodzą'),
        top.length ? table(['Klient', ['Obecności', 'num']], top.map((x) => h('tr', {}, td(x.name), td(String(x.present), 'num'))))
          : h('div', { class: 'card empty' }, 'Brak danych.'))),
    note('CSV otworzysz w Excelu (polski format: średnik, przecinek dziesiętny). Zawiera wpłaty, podsumowanie, zaległości i frekwencję.'));
}

// ---------- Grupy ----------
async function grupy() {
  render(h('h1', {}, 'Grupy'), h('p', { class: 'muted' }, 'Ładowanie…'));
  await getCore(true);
  const members = space.club && isAdmin() ? await rpc('club_members', { p_space: space.id }).catch(() => []) : [];
  const coachName = (uid) => (members.find((m) => m.user_id === uid) || {}).name || 'trener';
  const count = (gid) => core.members.filter((m) => m.group_id === gid && studentById(m.student_id) && !studentById(m.student_id).archived).length;
  const list = activeGroups();
  render(
    h('div', { class: 'row' }, h('h1', {}, 'Grupy'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'primary', onclick: () => groupDialog(null, 'group', members) }, '+ Nowa grupa'),
      h('button', { type: 'button', onclick: () => groupDialog(null, 'open', members) }, '+ Wolne wejścia')),
    list.length ? table(['Nazwa', 'Rodzaj', 'Dyscyplina', ['Klientów', 'num'], 'Grafik', space.club ? 'Prowadzący' : ''],
      list.map((g) => h('tr', { class: 'click', onclick: () => groupDialog(g, g.kind, members) },
        td(h('b', {}, g.name)), td(badge(KIND[g.kind] || g.kind, g.kind === 'open' ? 'blue' : '')), td(g.discipline), td(String(count(g.id)), 'num'),
        td(g.kind === 'open' ? 'codziennie' : g.schedule || '—', 'small'),
        td(space.club ? core.coaches.filter((c) => c.group_id === g.id).map((c) => coachName(c.user_id)).join(', ') || '—' : '', 'small'))))
      : h('div', { class: 'card empty' }, 'Brak grup. Dodaj pierwszą.'));
}

function groupDialog(g, kind, members) {
  const name = h('input', { value: g ? g.name : '', maxlength: 60, placeholder: kind === 'open' ? 'Siłownia' : 'Początkujący' });
  const listId = 'disc-' + Math.random().toString(36).slice(2);
  const disc = h('input', { list: listId, value: g ? g.discipline : kind === 'open' ? 'Siłownia' : 'Boks', maxlength: 40 });
  const kindSel = select(Object.entries(KIND), g ? g.kind : kind);
  const slots = h('div', { class: 'stack' });
  const addSlot = (sl) => {
    const day = select(WEEKDAYS.map(([v, t]) => [String(v), t]), String(sl ? sl.weekday : 1));
    const time = h('input', { type: 'time', value: sl ? sl.time : '17:00' });
    const dur = select([['45', '45 min'], ['60', '60 min'], ['75', '75 min'], ['90', '90 min'], ['120', '120 min']], String(sl ? sl.duration_min : 60));
    const row = h('div', { class: 'row' }, day, time, dur, h('button', { type: 'button', class: 'link', onclick: () => row.remove() }, 'Usuń'));
    row.read = () => ({ weekday: Number(day.value), time: time.value || '17:00', duration_min: Number(dur.value) });
    slots.append(row);
  };
  if (g) core.schedule.filter((x) => x.group_id === g.id).sort((a, b) => a.weekday - b.weekday).forEach(addSlot);
  const schedSection = h('div', { class: 'section' }, h('h3', {}, 'Grafik (co tydzień)'), slots,
    h('div', {}, h('button', { type: 'button', onclick: () => addSlot(null) }, '+ Dzień i godzina')));
  const syncKind = () => { schedSection.hidden = kindSel.value === 'open'; };
  kindSel.addEventListener('change', syncKind);
  syncKind();
  const assigned = new Set(g ? core.coaches.filter((c) => c.group_id === g.id).map((c) => c.user_id) : []);
  const coachBoxes = (members || []).map((m) => { const c = h('input', { type: 'checkbox', checked: assigned.has(m.user_id) }); c.dataset.id = m.user_id; return h('label', { class: 'chk' }, c, m.is_me ? `${m.name} (Ty)` : m.name); });
  const out = h('div', {});
  openDialog(dlgHead(g ? g.name : kind === 'open' ? 'Nowe wolne wejścia' : 'Nowa grupa', kind === 'open' ? 'Klient przychodzi, kiedy chce; wejście zapisujesz w Recepcji albo klient skanuje kod QR.' : ''),
    h('div', { class: 'form' }, field('Nazwa', name), field('Dyscyplina', h('div', {}, disc, h('datalist', { id: listId }, DISCIPLINES.map((d) => h('option', { value: d }))))), field('Rodzaj', kindSel)),
    schedSection,
    space.club && isAdmin() && coachBoxes.length ? h('div', { class: 'section' }, h('h3', {}, 'Prowadzący'), h('div', {}, coachBoxes),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Trener widzi tylko grupy, które prowadzi, i ich klientów. Admin widzi wszystko.')) : null,
    h('div', { class: 'row' },
      runBtn(g ? 'Zapisz' : 'Utwórz', 'primary', async () => {
        const nm = name.value.trim();
        if (!nm) throw new Error('Podaj nazwę.');
        const k = kindSel.value;
        const sl = k === 'open' ? [] : [...slots.children].map((r) => r.read());
        const times = [...new Set(sl.map((x) => x.time))];
        const text = sl.length ? `${WEEKDAYS.filter(([v]) => sl.some((x) => x.weekday === v)).map(([, t]) => t).join(', ')} ${times.length === 1 ? times[0] : times.join('/')}` : '';
        const row = { name: nm.slice(0, 60), discipline: disc.value.trim().slice(0, 40) || 'Siłownia', kind: k, schedule: text };
        const id = g ? g.id : newId();
        if (g) await ok(T('groups').update(row).eq('id', id));
        else await ok(T('groups').insert({ id, ...row }));
        await ok(T('group_schedule').del().eq('group_id', id));
        if (sl.length) await ok(T('group_schedule').insert(sl.map((x) => ({ id: newId(), group_id: id, ...x }))));
        if (space.club && isAdmin() && coachBoxes.length) {
          const want = new Set(coachBoxes.map((b) => b.firstChild).filter((c) => c.checked).map((c) => c.dataset.id));
          for (const uid of want) if (!assigned.has(uid)) await ok(T('group_coaches').insert({ group_id: id, user_id: uid }));
          for (const uid of assigned) if (!want.has(uid)) await ok(T('group_coaches').del().eq('group_id', id).eq('user_id', uid));
        }
        dlg.close();
        core = null;
        route();
        return null;
      }, out),
      g ? runBtn('Archiwizuj grupę', 'danger', async () => {
        if (!confirm(`Zarchiwizować „${g.name}”? Zniknie z list i grafiku. Historia i klienci zostaną.`)) return null;
        await ok(T('groups').update({ archived: true }).eq('id', g.id));
        dlg.close();
        core = null;
        route();
        return null;
      }, out) : null),
    out);
  name.focus();
}

// ---------- Trenerzy (admin klubu) ----------
async function trenerzy() {
  if (!space.club) {
    render(h('h1', {}, 'Trenerzy'), note('To jest Twój prywatny notatnik. Trenerów dodaje się w klubie — załóż klub w aplikacji (Ustawienia → Klub) i wybierz go u góry.'));
    return;
  }
  if (!isAdmin()) { render(h('h1', {}, 'Trenerzy'), note('Trenerami zarządza admin klubu.')); return; }
  render(h('h1', {}, 'Trenerzy'), h('p', { class: 'muted' }, 'Ładowanie…'));
  const [members, clubs] = await Promise.all([rpc('club_members', { p_space: space.id }), rpc('my_clubs')]);
  const club = clubs.find((c) => c.id === space.id) || {};
  const out = h('div', {});
  const codeBox = h('div', {});
  const nameIn = h('input', { value: club.name || space.name, maxlength: 60 });
  const hoursIn = h('input', { type: 'number', min: 0, max: 72, value: club.cancel_hours ?? 12 });
  render(
    h('h1', {}, 'Trenerzy'),
    table(['Trener', 'Rola', ''], members.map((m) => {
      const role = select([['coach', 'Trener'], ['admin', 'Admin']], m.role);
      role.disabled = m.is_me;
      role.addEventListener('change', async () => {
        try { await rpc('set_member_role', { p_space: space.id, p_user: m.user_id, p_role: role.value }); out.replaceChildren(note(`${m.name}: rola zmieniona.`, 'ok')); } catch (e) { out.replaceChildren(note(e.message, 'err')); role.value = m.role; }
      });
      return h('tr', {}, td(h('b', {}, m.is_me ? `${m.name} (Ty)` : m.name)), td(role),
        td(m.is_me ? '' : runBtn('Usuń z klubu', 'danger', async () => {
          if (!confirm(`Usunąć ${m.name} z klubu? Dane, które dodał, zostają w klubie.`)) return null;
          await rpc('remove_member', { p_space: space.id, p_user: m.user_id });
          await trenerzy();
          return null;
        }, out)));
    })),
    out,
    h('div', { class: 'card stack' }, h('h2', {}, 'Nowy trener'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Wygeneruj kod. Trener wpisuje go w aplikacji: Ustawienia → Klub → Dołącz kodem. Kod działa 7 dni.'),
      h('div', { class: 'row' }, runBtn('Kod dla trenera', 'primary', async () => {
        const code = await rpc('club_invite', { p_space: space.id, p_role: 'coach' });
        codeBox.replaceChildren(h('div', { class: 'code' }, code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code));
        return null;
      }, out)), codeBox),
    h('div', { class: 'card stack' }, h('h2', {}, 'Ustawienia klubu'),
      h('div', { class: 'form' }, field('Nazwa klubu', nameIn), field('Odwołanie bez kosztów (godz. przed)', hoursIn)),
      h('div', { class: 'row' }, runBtn('Zapisz', '', async () => {
        await rpc('update_club', { p_space: space.id, p_name: nameIn.value.trim(), p_cancel_hours: Math.round(Number(hoursIn.value) || 0) });
        await loadSpaces();
        return 'Zapisano.';
      }, out))));
}

// ---------- Nawigacja i przestrzenie ----------
const TABS = { pulpit, recepcja, klienci, wplaty, grupy, trenerzy, raport };
async function route() {
  if (!me || !space) return;
  const tab = location.hash.slice(1) || 'pulpit';
  const fn = TABS[tab] || pulpit;
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('on', a.dataset.tab === tab);
    if (a.hasAttribute('data-admin')) a.hidden = !(space.club && isAdmin());
  }
  try { await fn(); } catch (e) { render(h('h1', {}, ''), note(friendly(e.message || String(e)), 'err')); }
}
window.addEventListener('hashchange', route);

async function loadSpaces() {
  const clubs = await ok(sb.rpc('my_clubs')).catch(() => []);
  spaces = [...clubs.map((c) => ({ id: c.id, name: c.name, role: c.role, club: true })), { id: me.id, name: 'Mój notatnik (prywatny)', role: 'admin', club: false }];
  const saved = storeGet('nt-klub-space');
  space = spaces.find((x) => x.id === saved) || spaces.find((x) => x.club && x.role === 'admin') || spaces[0];
  spaceSel.replaceChildren(...spaces.map((x) => h('option', { value: x.id, selected: x.id === space.id }, x.club ? `${x.name}${x.role === 'admin' ? '' : ' (trener)'}` : x.name)));
}
spaceSel.addEventListener('change', () => {
  space = spaces.find((x) => x.id === spaceSel.value) || spaces[0];
  storeSet('nt-klub-space', space.id);
  core = null;
  receptionGroup = null;
  lastEntry = null;
  route();
});
document.getElementById('logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  me = null;
  core = null;
  loginView();
});

async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return loginView();
  me = data.session.user;
  if (location.search.includes('code=')) history.replaceState(null, '', location.pathname + location.hash);
  document.getElementById('who').textContent = me.email || '';
  document.getElementById('header').hidden = false;
  await loadSpaces();
  route();
}
boot();
