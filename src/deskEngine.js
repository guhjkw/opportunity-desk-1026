/*
 * src/deskEngine.js
 * The logic behind the opportunity desk demo for a building company. Forwarded project inquiries become opportunity
 * records; every authorised account manager is notified at once; the first valid claim wins and simultaneous claims
 * are handled one at a time, so a second tap is refused; existing customers go straight to their account manager;
 * unclaimed opportunities get a reminder after 4 business hours and are assigned by rotation after 1 business day;
 * overdue follow-ups are chased and escalated; QuickBooks estimate numbers and quote status are recorded; and a
 * shared weekly report is built every Friday. The page (index.html) and the tests (tests/verify.js) load this file.
 *
 * Extraction is rule-based on purpose, so the demo runs with no API key. In the delivered Make.com build an AI step
 * reads each forwarded email, and every rule after it (matching, claiming, timers, rotation, reports) stays as here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DeskEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 1440;
  var DEFAULT_RULES = { dayStart: 8, dayEnd: 17, remindAfterHours: 4, autoAssignAfterDays: 1, followUpDays: 1, escalateAfterHours: 4, reportDay: 5, reportHour: 16, duplicateWindowDays: 14 };
  var QUOTE = ['Draft', 'Sent', 'Accepted', 'Declined'];
  var OPEN = ['Claimed', 'Assigned', 'Auto-assigned'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function copy(x) { return JSON.parse(JSON.stringify(x)); }

  // ---------------------------------------------------------------- time (minutes; business hours Mon to Fri)
  function pt(s) { var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : NaN; }
  function ft(t) { return new Date(t * 60000).toISOString().slice(0, 16).replace('T', ' '); }
  function dow(t) { return new Date(t * 60000).getUTCDay(); }
  function dayOf(t) { return Math.floor(t / DAY) * DAY; }
  function isBizDay(t) { var w = dow(t); return w >= 1 && w <= 5; }
  function nextStart(d, r) { while (!isBizDay(d)) d += DAY; return d + r.dayStart * 60; }
  function snap(t, r) {
    var d = dayOf(t);
    if (!isBizDay(d)) return nextStart(d, r);
    if (t < d + r.dayStart * 60) return d + r.dayStart * 60;
    if (t >= d + r.dayEnd * 60) return nextStart(d + DAY, r);
    return t;
  }
  function addBiz(t, mins, r) {
    t = snap(t, r);
    while (mins > 0) {
      var avail = dayOf(t) + r.dayEnd * 60 - t;
      if (mins <= avail) return t + mins;
      mins -= avail;
      t = nextStart(dayOf(t) + DAY, r);
    }
    return t;
  }
  function bizBetween(a, b, r) {
    var total = 0;
    for (var d = dayOf(a); d <= b; d += DAY) {
      if (!isBizDay(d)) continue;
      var s = Math.max(a, d + r.dayStart * 60), e = Math.min(b, d + r.dayEnd * 60);
      if (e > s) total += e - s;
    }
    return total;
  }
  function clock(t) { var d = new Date(t * 60000); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); }
  function nice(t) { var d = new Date(t * 60000); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ', ' + clock(t); }
  function bizDayMins(r) { return (r.dayEnd - r.dayStart) * 60; }
  function money(n) { return n == null ? 'value unknown' : '$' + Math.round(n).toLocaleString('en-US'); }

  // ---------------------------------------------------------------- data check: bad rows are skipped and reported
  function prepare(raw) {
    var p = [], d = copy(raw || {}), emails = {}, ids = {};
    d.ams = (d.ams || []).filter(function (a, i) {
      var ok = a && a.id && !ids[a.id] && a.name && EMAIL.test(a.email || '') && !emails[String(a.email).toLowerCase()];
      if (!ok) p.push('Account manager row ' + (i + 1) + ' skipped: needs a unique id, a name and their own valid email');
      else { ids[a.id] = 1; emails[a.email.toLowerCase()] = 1; }
      return ok;
    });
    d.customers = (d.customers || []).filter(function (c, i) {
      var ok = c && c.company && c.domain && ids[c.am];
      if (!ok) p.push('Customer row ' + (i + 1) + ' skipped: needs a company, an email domain and an account manager on the list');
      return ok;
    });
    var seen = {};
    d.inbox = (d.inbox || []).filter(function (m, i) {
      var ok = m && m.id && !seen[m.id] && !isNaN(pt(m.receivedAt)) && (m.body || m.subject);
      if (!ok) p.push('Inbox row ' + (i + 1) + ' skipped: needs a unique id, a received time and some text');
      else seen[m.id] = 1;
      return ok;
    });
    d.history = (d.history || []).filter(function (h, i) {
      var ok = h && /^OPP-\d+$/.test(h.id || '') && !isNaN(pt(h.createdAt)) && (!h.owner || ids[h.owner]);
      if (!ok) p.push('History row ' + (i + 1) + ' skipped: needs an OPP id, a created time and a known owner');
      return ok;
    });
    if (isNaN(pt(d.now))) { p.push('"now" is missing, so 2026-10-26 09:00 is used'); d.now = '2026-10-26 09:00'; }
    var r = Object.assign({}, DEFAULT_RULES, d.rules || {});
    if (!(r.dayStart >= 0 && r.dayEnd <= 24 && r.dayStart < r.dayEnd)) { p.push('Business hours ignored, 8:00 to 17:00 used'); r.dayStart = 8; r.dayEnd = 17; }
    d.rules = r;
    return { data: d, problems: p };
  }

  // ---------------------------------------------------------------- state
  function newState(data) {
    var d = copy(data), seq = 1000;
    var st = { company: d.company, rules: Object.assign({}, DEFAULT_RULES, d.rules), now: pt(d.now), ams: d.ams, customers: d.customers, inbox: d.inbox,
      towns: d.towns || [], projectTypes: d.projectTypes || {}, rotation: d.rotation || { order: d.ams.map(function (a) { return a.id; }), next: d.ams[0] && d.ams[0].id },
      opps: [], notices: [], log: [], reports: [], processed: {}, reportCursor: null };
    (d.history || []).forEach(function (h) {
      seq = Math.max(seq, +h.id.slice(4));
      st.opps.push({ id: h.id, title: h.title, prospect: h.prospect, company: h.company || null, email: h.email || null, phone: h.phone || null, type: h.type || null, town: h.town || null,
        value: h.value == null ? null : h.value, budget: h.value ? money(h.value) : null, timeline: null, missing: [], createdT: pt(h.createdAt), source: 'earlier', forwardedBy: null,
        status: h.status, owner: h.owner || null, how: h.how || null, claimedT: h.claimedAt ? pt(h.claimedAt) : null, contactedT: h.contactedAt ? pt(h.contactedAt) : null,
        followUpT: h.claimedAt ? addBiz(pt(h.claimedAt), bizDayMins(st.rules) * st.rules.followUpDays, st.rules) : null, remindT: null, autoT: null,
        estimateNo: h.estimateNo || null, quoteStatus: h.quoteStatus || null, quoteSentT: h.quoteSentAt ? pt(h.quoteSentAt) : null, wonT: h.wonAt ? pt(h.wonAt) : null,
        version: 1, notes: [], reminded: null, overdueSent: null, escalated: null });
    });
    st.seq = seq;
    st.reportCursor = st.now;
    return st;
  }
  function am(st, id) { return st.ams.filter(function (a) { return a.id === id; })[0] || null; }
  function opp(st, id) { return st.opps.filter(function (o) { return o.id === id; })[0] || null; }
  function eligible(st) { return st.ams.filter(function (a) { return a.active; }); }
  function amName(st, id) { var a = am(st, id); return a ? a.name : (id === 'admin' ? st.company.admin.name : id); }
  function notify(st, at, to, kind, text, oppId) { to.forEach(function (who) { st.notices.push({ at: at, to: who, kind: kind, text: text, opp: oppId || null }); }); }
  function log(st, at, text) { st.log.push({ at: at, text: text }); }

  // ---------------------------------------------------------------- reading a forwarded inquiry
  function parseBudget(text) {
    var m = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b(?:\s*(?:-|to|–)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b)?/i.exec(text);
    if (!m) return null;
    function n(s, k) { var v = parseFloat(s.replace(/,/g, '')); return Math.round(k ? v * 1000 : v); }
    var min = n(m[1], m[2]), max = m[3] ? n(m[3], m[4] || m[2]) : null;
    return { min: min, max: max, text: max ? money(min) + ' to ' + money(max) : money(min) };
  }
  function extract(st, mail) {
    var body = String(mail.body || ''), subject = String(mail.subject || ''), text = subject + '\n' + body, lower = text.toLowerCase(), own = st.company.domain, m;
    function isOurs(addr) { return addr.split('@')[1] === own || /^no-?reply/i.test(addr); }
    var name = null, email = null, fromRe = /From:\s*([^<\n]*?)\s*<([^>\s]+@[^>\s]+)>/gi;
    while ((m = fromRe.exec(body))) { var a = m[2].toLowerCase(); if (!isOurs(a)) { name = m[1].trim() || null; email = a; break; } }
    if (!email && (m = /Email:\s*([^\s<>]+@[^\s<>]+)/i.exec(body))) email = m[1].toLowerCase().replace(/[.,;]$/, '');
    if (!email) email = (body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(function (x) { return x.toLowerCase(); }).filter(function (x) { return !isOurs(x); })[0] || null;
    if (!name && (m = /^\s*Name:\s*(.+)$/im.exec(body))) name = m[1].trim();
    var company = (m = /^\s*Company:\s*(.+)$/im.exec(body)) ? m[1].trim() : null;
    var phone = (m = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-](\d{3})[\s.-](\d{4})\b/.exec(body)) ? m[1] + '-' + m[2] + '-' + m[3] : null;
    var type = null;
    Object.keys(st.projectTypes).some(function (t) { if (st.projectTypes[t].some(function (k) { return lower.indexOf(k) >= 0; })) { type = t; return true; } return false; });
    var town = st.towns.filter(function (t) { return new RegExp('\\b' + t + '\\b', 'i').test(text); })[0] || null;
    var budget = parseBudget(text);
    var timeline = (m = /\b(asap|as soon as possible|spring|summer|fall|autumn|winter|christmas closure|christmas|by (?:january|february|march|april|may|june|july|august|september|october|november|december))\b/i.exec(text)) ? m[1] : null;
    var fields = { name: name, email: email, phone: phone, company: company, type: type, town: town, budget: budget ? budget.text : null, timeline: timeline };
    var need = ['name', 'email', 'phone', 'type', 'town', 'budget'];
    var missing = need.filter(function (k) { return !fields[k]; });
    return { fields: fields, missing: missing, value: budget ? (budget.max ? Math.round((budget.min + budget.max) / 2) : budget.min) : null,
      confidence: Math.round((need.length - missing.length) / need.length * 100) / 100, title: subject.replace(/^\s*(fwd?|fw):\s*/i, '').trim() || (type || 'Project') + (town ? ', ' + town : '') };
  }
  function matchCustomer(st, f) {
    var dom = f.email ? f.email.split('@')[1] : null;
    return st.customers.filter(function (c) { return (dom && c.domain === dom) || (f.company && c.company.toLowerCase() === f.company.toLowerCase()); })[0] || null;
  }

  // ---------------------------------------------------------------- intake (one Make.com run per forwarded email)
  function intake(st, id) {
    var mail = st.inbox.filter(function (x) { return x.id === id; })[0];
    if (!mail) return { ok: false, problems: ['There is no email ' + id + ' in the intake inbox'] };
    if (st.processed[id]) return Object.assign({ repeat: true }, st.processed[id]);
    var r = st.rules, at = pt(mail.receivedAt), trace = [];
    function step(name, out, extra) { trace.push(Object.assign({ name: name, out: out }, extra || {})); }
    step('Gmail', 'Forwarded by ' + mail.forwardedBy + ' to ' + st.company.intake + ', ' + nice(at));
    var x = extract(st, mail), f = x.fields;
    step('Extract', [f.name || f.company || 'No name', f.type || 'type unknown', f.town || 'town unknown', f.budget || 'no budget'].join(' · '), { fields: f, missing: x.missing, confidence: x.confidence });
    var res = { email: id, subject: mail.subject, trace: trace, fields: f, missing: x.missing };
    var dup = st.opps.filter(function (o) {
      return o.status !== 'Won' && o.status !== 'Lost' && at - o.createdT <= r.duplicateWindowDays * DAY && ((f.email && o.email === f.email) || (f.phone && o.phone === f.phone));
    })[0];
    if (dup) {
      dup.notes.push({ at: at, text: 'Also forwarded by ' + mail.forwardedBy + ': "' + x.title + '"' });
      step('Check', 'Same prospect as ' + dup.id + ' (' + dup.prospect + '): added as a note, no second record');
      step('Log', 'Duplicate, not created');
      res.outcome = 'duplicate'; res.opp = dup.id;
      log(st, at, mail.subject + ': duplicate of ' + dup.id);
      st.processed[id] = res;
      return res;
    }
    step('Check', 'Not a duplicate (no open opportunity with the same email or phone in ' + r.duplicateWindowDays + ' days)');
    var cust = matchCustomer(st, f);
    var o = { id: 'OPP-' + (++st.seq), title: x.title, prospect: f.name || f.company || f.email || 'Unknown sender', company: f.company || (cust ? cust.company : null), email: f.email, phone: f.phone,
      type: f.type, town: f.town, value: x.value, budget: f.budget, timeline: f.timeline, missing: x.missing, createdT: at, source: id, forwardedBy: mail.forwardedBy,
      status: 'Unclaimed', owner: null, how: null, claimedT: null, contactedT: null, followUpT: null, remindT: null, autoT: null,
      estimateNo: null, quoteStatus: null, quoteSentT: null, wonT: null, version: 0, notes: [], reminded: null, overdueSent: null, escalated: null };
    if (cust) {
      o.status = 'Assigned'; o.owner = cust.am; o.how = 'existing'; o.claimedT = at; o.followUpT = addBiz(at, bizDayMins(r) * r.followUpDays, r);
      step('Match', 'Existing customer ' + cust.company + ': stays with ' + amName(st, cust.am) + ', no claiming');
    } else {
      o.remindT = addBiz(at, r.remindAfterHours * 60, r); o.autoT = addBiz(at, bizDayMins(r) * r.autoAssignAfterDays, r);
      step('Match', 'New prospect, not an existing customer');
    }
    st.opps.push(o);
    step('Airtable', 'Created ' + o.id + ' (' + (o.type || 'type unknown') + ', ' + money(o.value) + ')' + (x.missing.length ? ', flagged: missing ' + x.missing.join(', ') : ''));
    if (cust) {
      notify(st, at, [cust.am], 'assigned', 'Your customer ' + cust.company + ' sent a new inquiry: ' + o.id + ' ' + o.title, o.id);
      step('Notify', 'Told ' + amName(st, cust.am) + ' only. First contact due ' + nice(o.followUpT));
    } else {
      var who = eligible(st);
      notify(st, at, who.map(function (a) { return a.id; }), 'new', 'New opportunity ' + o.id + ': ' + o.title + ' (' + money(o.value) + '). First to claim it gets it.', o.id);
      step('Notify', 'Sent to all ' + who.length + ' authorized account managers at once: ' + who.map(function (a) { return a.name.split(' ')[0]; }).join(', '));
      step('Timers', 'Reminder ' + nice(o.remindT) + ' if unclaimed; rotation assigns it ' + nice(o.autoT));
    }
    step('Log', cust ? 'Routed to the existing account manager' : 'Waiting for a claim');
    res.outcome = cust ? 'existing' : 'new'; res.opp = o.id;
    log(st, at, o.id + ' created from ' + id + (cust ? ' and routed to ' + amName(st, cust.am) : ', all account managers notified'));
    st.processed[id] = res;
    return res;
  }
  function intakeAll(st) { return st.inbox.filter(function (m) { return !st.processed[m.id]; }).map(function (m) { return intake(st, m.id); }); }

  // A message the visitor writes, so the reading and routing run on text nobody prepared.
  function forward(st, f) {
    var p = [], body = String(f.body || '').trim(), by = String(f.forwardedBy || '').trim().toLowerCase();
    if (body.length < 15) p.push('Paste the inquiry text (at least a sentence)');
    if (!EMAIL.test(by)) p.push('The forwarding employee needs a valid email address');
    else if (by.split('@')[1] !== st.company.domain) p.push('Only ' + st.company.short + ' staff (@' + st.company.domain + ') can forward to the intake address');
    if (p.length) return { ok: false, problems: p };
    var n = st.inbox.length + 1;
    while (st.inbox.some(function (x) { return x.id === 'E' + n; })) n++;
    var m = { id: 'E' + n, receivedAt: ft(st.now), forwardedBy: by, subject: String(f.subject || 'Fwd: New inquiry').trim(), body: body, custom: true };
    st.inbox.push(m);
    return { ok: true, email: m, result: intake(st, m.id) };
  }

  // ---------------------------------------------------------------- claiming: first valid claim wins
  function claim(st, oppId, amId, at) {
    at = at == null ? st.now : at;
    var o = opp(st, oppId), a = am(st, amId);
    if (!o) return { ok: false, problems: ['There is no opportunity ' + oppId] };
    if (!a) return { ok: false, problems: ['Only account managers on the authorized list can claim'] };
    if (!a.active) return { ok: false, problems: [a.name + ' is marked away, so cannot claim right now'] };
    if (o.status !== 'Unclaimed') {
      var verb = o.how === 'auto' ? 'assigned by rotation to ' : o.how === 'existing' ? 'routed to ' : 'claimed by ';
      return { ok: false, problems: ['Already ' + verb + amName(st, o.owner) + ' at ' + clock(o.claimedT) + '. Nothing changed.'], owner: o.owner };
    }
    o.status = 'Claimed'; o.owner = a.id; o.how = 'claimed'; o.claimedT = at; o.version++;
    o.followUpT = addBiz(at, bizDayMins(st.rules) * st.rules.followUpDays, st.rules);
    notify(st, at, eligible(st).filter(function (x) { return x.id !== a.id; }).map(function (x) { return x.id; }), 'taken', a.name + ' claimed ' + o.id + ' ' + o.title, o.id);
    log(st, at, a.name + ' claimed ' + o.id);
    return { ok: true, opp: o, message: a.name + ' claimed ' + o.id + '. First contact due ' + nice(o.followUpT) };
  }
  // Two or more taps at nearly the same moment. Make.com's sequential processing hands the claim webhook one request
  // at a time, in arrival order, and each run re-reads the record before writing; that is exactly what this does.
  function claimRace(st, oppId, attempts) {
    var o = opp(st, oppId), before = o ? o.status : null;
    var order = attempts.slice().sort(function (x, y) { return x.ms - y.ms; });
    var results = order.map(function (x, i) {
      var r = claim(st, oppId, x.am, st.now);
      return { am: x.am, name: amName(st, x.am), ms: x.ms, position: i + 1, ok: r.ok, message: r.ok ? r.message : r.problems[0] };
    });
    var winners = results.filter(function (x) { return x.ok; });
    return { opp: oppId, statusBefore: before, results: results, winner: winners.length ? winners[0].am : null, winners: winners.length };
  }

  // ---------------------------------------------------------------- time passing: reminders, rotation, follow-ups, report
  function nextReportT(st, from) {
    var r = st.rules;
    for (var d = dayOf(from); d < from + 9 * DAY; d += DAY) { var t = d + r.reportHour * 60; if (dow(d) === r.reportDay && t > from) return t; }
    return Infinity;
  }
  function pending(st) {
    var r = st.rules, ev = [];
    st.opps.forEach(function (o) {
      if (o.status === 'Unclaimed') {
        if (!o.reminded && o.remindT != null) ev.push({ t: o.remindT, kind: 'remind', o: o });
        if (o.autoT != null) ev.push({ t: o.autoT, kind: 'auto', o: o });
      }
      if (o.owner && !o.contactedT && OPEN.indexOf(o.status) >= 0 && o.followUpT != null) {
        if (!o.overdueSent) ev.push({ t: o.followUpT, kind: 'overdue', o: o });
        else if (!o.escalated) ev.push({ t: addBiz(o.followUpT, r.escalateAfterHours * 60, r), kind: 'escalate', o: o });
      }
    });
    ev.push({ t: nextReportT(st, st.reportCursor), kind: 'report' });
    var rank = { remind: 1, auto: 2, overdue: 3, escalate: 4, report: 5 };
    return ev.sort(function (a, b) { return a.t - b.t || rank[a.kind] - rank[b.kind]; });
  }
  function rotate(st) {
    var order = st.rotation.order.filter(function (id) { return am(st, id); });
    if (!order.length) return null;
    var start = Math.max(0, order.indexOf(st.rotation.next));
    for (var i = 0; i < order.length; i++) {
      var a = am(st, order[(start + i) % order.length]);
      if (a.active) { st.rotation.next = order[(start + i + 1) % order.length]; return a; }
    }
    return null;
  }
  function fire(st, e) {
    var o = e.o, r = st.rules, admin = st.company.admin.name;
    if (e.kind === 'remind') {
      o.reminded = e.t;
      notify(st, e.t, eligible(st).map(function (a) { return a.id; }), 'remind', 'Still unclaimed after ' + r.remindAfterHours + ' business hours: ' + o.id + ' ' + o.title, o.id);
      return 'Reminder to all account managers: ' + o.id + ' still unclaimed';
    }
    if (e.kind === 'auto') {
      var a = rotate(st);
      if (!a) { o.autoT = null; notify(st, e.t, ['admin'], 'escalate', 'Nobody is available to take ' + o.id + ': assign it by hand', o.id); return o.id + ': nobody available, sent to ' + admin; }
      o.status = 'Auto-assigned'; o.owner = a.id; o.how = 'auto'; o.claimedT = e.t; o.version++;
      o.followUpT = addBiz(e.t, bizDayMins(r) * r.followUpDays, r);
      notify(st, e.t, [a.id], 'assigned', o.id + ' ' + o.title + ' was not claimed in 1 business day and is now yours (rotation)', o.id);
      notify(st, e.t, ['admin'], 'info', o.id + ' auto-assigned to ' + a.name + ' by rotation', o.id);
      return o.id + ' auto-assigned to ' + a.name + ' by rotation';
    }
    if (e.kind === 'overdue') {
      o.overdueSent = e.t;
      notify(st, e.t, [o.owner], 'overdue', 'Follow-up overdue: contact ' + o.prospect + ' about ' + o.id + ' today', o.id);
      return o.id + ': follow-up overdue, reminder to ' + amName(st, o.owner);
    }
    if (e.kind === 'escalate') {
      o.escalated = e.t;
      notify(st, e.t, ['admin'], 'escalate', 'Escalation: ' + amName(st, o.owner) + ' has not contacted ' + o.prospect + ' (' + o.id + '), due ' + nice(o.followUpT), o.id);
      return o.id + ': escalated to ' + admin;
    }
    var rep = weeklyReport(st, e.t);
    st.reports.push(rep); st.reportCursor = e.t;
    notify(st, e.t, eligible(st).map(function (a) { return a.id; }).concat(['admin']), 'report', 'Weekly opportunity report for the week of ' + rep.weekLabel + ' is ready', null);
    return 'Weekly report sent to the team';
  }
  function tick(st, to) {
    var fired = [], guard = 0;
    while (guard++ < 1000) {
      var e = pending(st)[0];
      if (!e || e.t > to) break;
      var text = fire(st, e);
      fired.push({ t: e.t, kind: e.kind, opp: e.o ? e.o.id : null, text: text });
      log(st, e.t, text);
    }
    st.now = Math.max(st.now, to);
    return fired;
  }
  function advance(st, kind) {
    var r = st.rules, to;
    if (kind === 'hour') to = st.now + 60;
    else if (kind === 'bizhours') to = addBiz(st.now, r.remindAfterHours * 60, r);
    else if (kind === 'morning') to = nextStart(dayOf(st.now) + DAY, r) + 60;
    else if (kind === 'friday') to = nextReportT(st, st.now);
    else return { ok: false, problems: ['Unknown time step'] };
    return { ok: true, to: to, fired: tick(st, to) };
  }
  function upcoming(st, n) {
    return pending(st).filter(function (e) { return e.t > st.now && e.t < Infinity; }).slice(0, n || 6).map(function (e) {
      return { t: e.t, when: nice(e.t), kind: e.kind, opp: e.o ? e.o.id : null };
    });
  }

  // ---------------------------------------------------------------- follow-ups and QuickBooks quote status
  function logContact(st, oppId) {
    var o = opp(st, oppId);
    if (!o) return { ok: false, problems: ['There is no opportunity ' + oppId] };
    if (!o.owner) return { ok: false, problems: ['Claim or assign ' + oppId + ' first'] };
    if (o.contactedT) return { ok: false, problems: ['First contact already logged at ' + nice(o.contactedT)] };
    o.contactedT = st.now;
    if (OPEN.indexOf(o.status) >= 0) o.status = 'Contacted';
    log(st, st.now, amName(st, o.owner) + ' logged first contact on ' + o.id + (st.now > o.followUpT ? ' (late)' : ' (on time)'));
    return { ok: true, onTime: st.now <= o.followUpT };
  }
  function setQuote(st, oppId, estimateNo, status) {
    var o = opp(st, oppId), p = [];
    if (!o) return { ok: false, problems: ['There is no opportunity ' + oppId] };
    if (!o.owner) p.push('Claim or assign ' + oppId + ' before recording a quote');
    var m = /^(?:EST-?)?(\d{3,6})$/i.exec(String(estimateNo || '').trim());
    if (!m) p.push('QuickBooks estimate numbers look like EST-2051 or 2051');
    if (QUOTE.indexOf(status) < 0) p.push('Quote status must be one of ' + QUOTE.join(', '));
    if (p.length) return { ok: false, problems: p };
    o.estimateNo = 'EST-' + m[1]; o.quoteStatus = status;
    if ((status === 'Sent' || status === 'Accepted') && !o.quoteSentT) o.quoteSentT = st.now;
    if (!o.contactedT) o.contactedT = st.now;
    o.status = status === 'Accepted' ? 'Won' : status === 'Declined' ? 'Lost' : status === 'Sent' ? 'Quoted' : o.status === 'Unclaimed' ? o.status : 'Contacted';
    if (status === 'Accepted') o.wonT = st.now;
    log(st, st.now, o.id + ': ' + o.estimateNo + ' ' + status.toLowerCase());
    return { ok: true, opp: o };
  }

  // ---------------------------------------------------------------- the team: who may claim, who is away
  function addAm(st, f) {
    var p = [], name = String(f.name || '').trim(), email = String(f.email || '').trim().toLowerCase();
    if (name.split(/\s+/).length < 2) p.push('Add a first and last name');
    if (!EMAIL.test(email)) p.push('That email address does not look right');
    else if (st.ams.some(function (a) { return a.email.toLowerCase() === email; })) p.push('That email is already on the team');
    if (p.length) return { ok: false, problems: p };
    var base = name.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '') || 'am', id = base, k = 2;
    while (am(st, id)) id = base + (k++);
    var a = { id: id, name: name, email: email, active: true };
    st.ams.push(a); st.rotation.order.push(id);
    log(st, st.now, name + ' added to the authorized list and the rotation');
    return { ok: true, am: a };
  }
  function removeAm(st, id) {
    var a = am(st, id);
    if (!a) return { ok: false, problems: ['Nobody with that id is on the list'] };
    if (st.ams.length <= 1) return { ok: false, problems: ['Keep at least one account manager on the list'] };
    var order = st.rotation.order, i = order.indexOf(id);
    if (st.rotation.next === id) st.rotation.next = order[(i + 1) % order.length];
    st.ams = st.ams.filter(function (x) { return x.id !== id; });
    st.rotation.order = order.filter(function (x) { return x !== id; });
    if (st.rotation.next === id) st.rotation.next = st.rotation.order[0];
    log(st, st.now, a.name + ' removed from the authorized list');
    return { ok: true, removed: a.name };
  }
  function setActive(st, id, active) {
    var a = am(st, id);
    if (!a) return { ok: false, problems: ['Nobody with that id is on the list'] };
    a.active = !!active; if (active) delete a.away;
    log(st, st.now, a.name + (active ? ' is back' : ' marked away'));
    return { ok: true, am: a };
  }

  // ---------------------------------------------------------------- the Friday report and the live board
  function weeklyReport(st, at) {
    var weekStart = dayOf(at) - ((dow(at) + 6) % 7) * DAY;
    function inWeek(t) { return t != null && t >= weekStart && t <= at; }
    var o = st.opps;
    var created = o.filter(function (x) { return inWeek(x.createdT); });
    var claimed = o.filter(function (x) { return x.how === 'claimed' && inWeek(x.claimedT); });
    var auto = o.filter(function (x) { return x.how === 'auto' && inWeek(x.claimedT); });
    var existing = o.filter(function (x) { return x.how === 'existing' && inWeek(x.claimedT); });
    var quotes = o.filter(function (x) { return inWeek(x.quoteSentT); });
    var won = o.filter(function (x) { return inWeek(x.wonT); });
    var rows = st.ams.map(function (a) {
      var mine = o.filter(function (x) { return x.owner === a.id; });
      var due = mine.filter(function (x) { return inWeek(x.claimedT); });
      var onTime = due.filter(function (x) { return x.contactedT != null && x.contactedT <= x.followUpT; }).length;
      return { am: a.id, name: a.name, claimed: claimed.filter(function (x) { return x.owner === a.id; }).length, auto: auto.filter(function (x) { return x.owner === a.id; }).length,
        existing: existing.filter(function (x) { return x.owner === a.id; }).length, quotes: quotes.filter(function (x) { return x.owner === a.id; }).length,
        won: won.filter(function (x) { return x.owner === a.id; }).length, wonValue: won.filter(function (x) { return x.owner === a.id; }).reduce(function (s, x) { return s + (x.value || 0); }, 0),
        onTime: onTime, owned: due.length };
    });
    var d = new Date(weekStart * 60000);
    return { at: at, weekLabel: d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()], created: created.length, claimed: claimed.length, auto: auto.length, existing: existing.length,
      quotes: quotes.length, won: won.length, wonValue: won.reduce(function (s, x) { return s + (x.value || 0); }, 0), rows: rows };
  }
  function board(st) {
    var now = st.now;
    return {
      now: now, when: nice(now), unclaimed: st.opps.filter(function (o) { return o.status === 'Unclaimed'; }).length,
      overdue: st.opps.filter(function (o) { return o.owner && !o.contactedT && OPEN.indexOf(o.status) >= 0 && o.followUpT < now; }).length,
      escalations: st.notices.filter(function (n) { return n.to === 'admin' && n.kind === 'escalate'; }).length,
      waitingEmails: st.inbox.filter(function (m) { return !st.processed[m.id]; }).length,
      week: weeklyReport(st, now), next: upcoming(st, 5), active: eligible(st).length, rotationNext: amName(st, st.rotation.next)
    };
  }

  return {
    DEFAULT_RULES: DEFAULT_RULES, QUOTE: QUOTE,
    prepare: prepare, newState: newState, extract: extract, intake: intake, intakeAll: intakeAll, forward: forward,
    claim: claim, claimRace: claimRace, tick: tick, advance: advance, upcoming: upcoming, logContact: logContact, setQuote: setQuote,
    addAm: addAm, removeAm: removeAm, setActive: setActive, weeklyReport: weeklyReport, board: board,
    pt: pt, ft: ft, nice: nice, clock: clock, addBiz: addBiz, bizBetween: bizBetween, money: money
  };
});
