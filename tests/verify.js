// tests/verify.js: node tests for src/deskEngine.js, the same file the page loads. Run: node tests/verify.js
const E = require('../src/deskEngine.js');
const RAW = require('../data/desk.json');

let pass = 0, fail = 0;
function sec(t) { console.log('\n' + t); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function fresh(mut) { const d = JSON.parse(JSON.stringify(RAW)); if (mut) mut(d); return E.newState(E.prepare(d).data); }
function loaded() { const s = fresh(); E.intakeAll(s); return s; }
function opp(s, id) { return s.opps.find(o => o.id === id); }
const R = E.DEFAULT_RULES, T = E.pt;

sec('1. Data check: bad rows are skipped and reported, never a crash');
{
  const p = E.prepare(RAW);
  ok('sample data loads with no problems', p.problems.length === 0, p.problems);
  const bad = JSON.parse(JSON.stringify(RAW));
  bad.ams.push({ id: 'x', name: 'No Email' });
  bad.ams.push({ id: 'maya', name: 'Copy', email: 'copy@cedarridge.example' });
  bad.customers.push({ company: 'Orphan Ltd', domain: 'orphan.example', am: 'nobody' });
  bad.inbox.push({ id: 'E1', receivedAt: '2026-10-26 09:00', body: 'dupe id' });
  bad.inbox.push({ id: 'E99', receivedAt: 'yesterday', body: 'bad time' });
  delete bad.now;
  const q = E.prepare(bad);
  ok('account manager with no email skipped and reported', q.problems.some(t => /Account manager row 5/.test(t)));
  ok('duplicate account manager id skipped', q.problems.some(t => /Account manager row 6/.test(t)) && q.data.ams.length === 4);
  ok('customer pointing at an unknown account manager skipped', q.problems.some(t => /Customer row 4/.test(t)) && q.data.customers.length === 3);
  ok('duplicate inbox id and bad timestamp skipped', q.data.inbox.length === 6 && q.problems.filter(t => /Inbox row/.test(t)).length === 2);
  ok('missing "now" falls back and says so', q.data.now === '2026-10-26 09:00' && q.problems.some(t => /now/.test(t)));
}

sec('2. Business hours (8:00 to 17:00, Monday to Friday)');
{
  ok('4 business hours from Sunday 21:14 lands Monday 12:00', E.ft(E.addBiz(T('2026-10-25 21:14'), 240, R)) === '2026-10-26 12:00');
  ok('4 business hours from Monday 15:00 carries to Tuesday 10:00', E.ft(E.addBiz(T('2026-10-26 15:00'), 240, R)) === '2026-10-27 10:00');
  ok('1 business day from Friday 15:00 lands Monday 15:00', E.ft(E.addBiz(T('2026-10-30 15:00'), 540, R)) === '2026-11-02 15:00');
  ok('Friday 16:00 to Monday 09:00 is 2 business hours', E.bizBetween(T('2026-10-30 16:00'), T('2026-11-02 09:00'), R) === 120);
}

sec('3. Reading forwarded inquiries');
{
  const s = fresh();
  const x1 = E.extract(s, s.inbox[0]);
  ok('E1: name, email, phone, type, town and budget range all found', x1.missing.length === 0 && x1.fields.name === 'Sarah Boudreau' && x1.fields.phone === '902-555-0148' && x1.fields.type === 'Renovation' && x1.fields.town === 'Dartmouth' && x1.fields.budget === '$85,000 to $110,000', x1.fields);
  ok('E1: value is the middle of the range ($97,500)', x1.value === 97500);
  const x3 = E.extract(s, s.inbox[2]);
  ok('E3: company line read, retail fit-out typed as commercial', x3.fields.company === 'Northshore Property Group' && x3.fields.type === 'Commercial fit-out' && x3.value === 240000);
  const x5 = E.extract(s, s.inbox[4]);
  ok('E5: the website form address is skipped and the visitor email used', x5.fields.email === 'ben.lowe@mail.example' && x5.fields.name === 'Ben Lowe');
  ok('E5: missing phone, town and budget are flagged', x5.missing.join() === 'phone,town,budget', x5.missing);
  const x6 = E.extract(s, s.inbox[5]);
  ok('E6: "$15k" reads as $15,000 and a leak is a repair', x6.value === 15000 && x6.fields.type === 'Repair');
}

sec('4. Intake: records, existing customers, duplicates, notifications');
{
  const s = fresh(), res = E.intakeAll(s);
  const out = Object.fromEntries(res.map(r => [r.email, r.outcome]));
  ok('outcomes: 4 new, 1 existing customer, 1 duplicate', out.E1 === 'new' && out.E2 === 'existing' && out.E3 === 'new' && out.E4 === 'duplicate' && out.E5 === 'new' && out.E6 === 'new', out);
  const o5 = opp(s, 'OPP-1005');
  ok('Harbourview Dental goes straight to Liam with no claiming', o5.status === 'Assigned' && o5.owner === 'liam' && o5.how === 'existing');
  ok('the existing-customer notice goes to Liam only', s.notices.filter(n => n.opp === 'OPP-1005').map(n => n.to).join() === 'liam');
  const o4 = opp(s, 'OPP-1004');
  ok('the second forward of Sarah\'s inquiry becomes a note on OPP-1004, not a new record', o4.notes.length === 1 && /tom@cedarridge/.test(o4.notes[0].text) && s.opps.length === 8);
  const newNotices = s.notices.filter(n => n.opp === 'OPP-1006' && n.kind === 'new');
  ok('a new opportunity notifies every active account manager at once (Owen is away)', newNotices.map(n => n.to).sort().join() === 'liam,maya,priya');
  ok('timers set: reminder Mon 12:05 and rotation Tue 08:05 for OPP-1006', E.ft(opp(s, 'OPP-1006').remindT) === '2026-10-26 12:05' && E.ft(opp(s, 'OPP-1006').autoT) === '2026-10-27 08:05');
  ok('processing an email twice changes nothing', E.intake(s, 'E3').repeat === true && s.opps.length === 8);
  const f = E.forward(s, { forwardedBy: 'nadia@cedarridge.example', subject: 'Fwd: Deck', body: 'From: Ella Grant <ella.grant@mail.example>\nWe would like a new deck and a garage at our place in Windsor, about $30,000. 902-555-0111' });
  ok('a visitor-written inquiry is read and created', f.ok && f.result.outcome === 'new' && opp(s, f.result.opp).town === 'Windsor' && opp(s, f.result.opp).value === 30000);
  ok('forwarding from outside the company is refused', /staff/.test(E.forward(s, { forwardedBy: 'someone@gmail.com', body: 'Please call me about a renovation in Halifax' }).problems.join()));
  ok('an empty forward is refused', /inquiry text/.test(E.forward(s, { forwardedBy: 'nadia@cedarridge.example', body: 'hi' }).problems.join()));
}

sec('5. Claiming: first valid claim wins');
{
  const s = loaded();
  const race = E.claimRace(s, 'OPP-1006', [{ am: 'priya', ms: 31 }, { am: 'maya', ms: 0 }]);
  ok('two taps 31 ms apart: exactly one winner, the earlier tap', race.winners === 1 && race.winner === 'maya');
  ok('the later tap is refused and told who has it', race.results[1].ok === false && /Already claimed by Maya Thibodeau/.test(race.results[1].message));
  ok('the record shows one owner and one version bump', opp(s, 'OPP-1006').owner === 'maya' && opp(s, 'OPP-1006').version === 1);
  const r3 = E.claimRace(s, 'OPP-1008', [{ am: 'liam', ms: 0 }, { am: 'priya', ms: 0 }, { am: 'maya', ms: 2 }]);
  ok('three taps, two of them at the same millisecond: still one winner', r3.winners === 1 && r3.results.filter(x => !x.ok).length === 2);
  ok('an away account manager cannot claim', /away/.test(E.claim(s, 'OPP-1004', 'owen').problems[0]));
  ok('someone not on the authorized list cannot claim', /authorized list/.test(E.claim(s, 'OPP-1004', 'jake').problems[0]));
  ok('an existing-customer opportunity cannot be claimed away', /routed to Liam/.test(E.claim(s, 'OPP-1005', 'maya').problems[0]));
  ok('the others are told it is taken', s.notices.some(n => n.kind === 'taken' && n.to === 'liam' && /Maya Thibodeau claimed OPP-1006/.test(n.text)));
}

sec('6. Time passing: reminders, rotation, follow-ups, escalations');
{
  const s = loaded();
  E.claim(s, 'OPP-1006', 'maya');
  const a = E.advance(s, 'bizhours');
  ok('after 4 business hours the unclaimed ones get a reminder (3), the claimed one does not', a.fired.filter(f => f.kind === 'remind').map(f => f.opp).join() === 'OPP-1004,OPP-1007,OPP-1008', a.fired);
  const b = E.advance(s, 'morning');
  const autos = b.fired.filter(f => f.kind === 'auto');
  ok('after 1 business day the rotation assigns them: Liam, Priya, then Maya (Owen is away)', autos.map(f => opp(s, f.opp).owner).join() === 'liam,priya,maya', autos.map(f => f.text));
  ok('auto-assigned records are marked as such', autos.every(f => opp(s, f.opp).status === 'Auto-assigned' && opp(s, f.opp).how === 'auto'));
  ok('the admin is told about each rotation assignment', s.notices.filter(n => n.to === 'admin' && /by rotation/.test(n.text)).length === 3);
  ok('Liam missed his 1-business-day follow-up on OPP-1005: overdue reminder', b.fired.some(f => f.kind === 'overdue' && f.opp === 'OPP-1005'));
  const c = E.tick(s, T('2026-10-27 12:00'));
  ok('4 business hours later the overdue follow-up is escalated to the admin', c.some(f => f.kind === 'escalate' && f.opp === 'OPP-1005') && s.notices.some(n => n.to === 'admin' && n.kind === 'escalate' && /OPP-1005/.test(n.text)));
  const s2 = loaded();
  E.claim(s2, 'OPP-1006', 'maya'); E.logContact(s2, 'OPP-1006');
  E.tick(s2, T('2026-10-28 17:00'));
  ok('a follow-up logged on time is never chased', !s2.notices.some(n => n.opp === 'OPP-1006' && (n.kind === 'overdue' || n.kind === 'escalate')));
  ok('logging contact twice is refused', !E.logContact(s2, 'OPP-1006').ok);
}

sec('7. The team list: changes apply without rebuilding anything');
{
  const s = loaded();
  E.setActive(s, 'liam', false);
  E.advance(s, 'morning');
  const owners = ['OPP-1004', 'OPP-1006', 'OPP-1007', 'OPP-1008'].map(id => opp(s, id).owner);
  ok('with Liam marked away the rotation skips him: Priya, Maya, Priya, Maya', owners.join() === 'priya,maya,priya,maya', owners);
  const a = E.addAm(s, { name: 'Noah Comeau', email: 'noah@cedarridge.example' });
  ok('a new account manager is added to the list and the rotation', a.ok && s.rotation.order.includes('noah'));
  const f = E.forward(s, { forwardedBy: 'jake@cedarridge.example', body: 'From: Lee Ward <lee.ward@mail.example>\nBathroom renovation in Halifax, budget $25,000. 902-555-0150' });
  ok('and is notified about the next new opportunity', s.notices.some(n => n.to === 'noah' && n.opp === f.result.opp && n.kind === 'new'));
  ok('a duplicate email is refused', /already on the team/.test(E.addAm(s, { name: 'Maya Two', email: 'maya@cedarridge.example' }).problems.join()));
  ok('a one-word name is refused', /first and last/.test(E.addAm(s, { name: 'Noah', email: 'n2@cedarridge.example' }).problems.join()));
  const r = E.removeAm(s, 'priya');
  ok('removing someone takes them off the list and out of the rotation', r.ok && !s.ams.some(x => x.id === 'priya') && !s.rotation.order.includes('priya'));
  ok('removing an unknown person is refused', !E.removeAm(s, 'nobody').ok);
}

sec('8. QuickBooks estimate number and quote status');
{
  const s = loaded();
  E.claim(s, 'OPP-1006', 'maya');
  ok('a bad estimate number is refused', /EST-2051/.test(E.setQuote(s, 'OPP-1006', 'abc', 'Sent').problems.join()));
  ok('an unknown status is refused', /must be one of/.test(E.setQuote(s, 'OPP-1006', '2051', 'Maybe').problems.join()));
  ok('recording a quote on an unclaimed opportunity is refused', /before recording a quote/.test(E.setQuote(s, 'OPP-1004', '2052', 'Sent').problems.join()));
  const q = E.setQuote(s, 'OPP-1006', '2051', 'Sent');
  ok('"2051" is stored as EST-2051 and the opportunity is Quoted', q.ok && opp(s, 'OPP-1006').estimateNo === 'EST-2051' && opp(s, 'OPP-1006').status === 'Quoted');
  E.setQuote(s, 'OPP-1006', 'EST-2051', 'Accepted');
  ok('Accepted marks it Won with the win time', opp(s, 'OPP-1006').status === 'Won' && opp(s, 'OPP-1006').wonT === s.now);
}

sec('9. The Friday report everyone can see');
{
  const s = loaded();
  E.claim(s, 'OPP-1006', 'maya');
  E.setQuote(s, 'OPP-1006', '2051', 'Sent');
  const f = E.advance(s, 'friday');
  ok('the report is built on Friday at 16:00 and sent to the team and the admin', f.fired.some(x => x.kind === 'report') && E.ft(s.reports[0].at) === '2026-10-30 16:00' && s.notices.filter(n => n.kind === 'report').length === 4);
  const rep = s.reports[0];
  ok('new this week: 4 (Sunday night\'s email counts in last week)', rep.created === 4, rep);
  ok('claimed 1 vs auto-assigned 3, plus 1 existing customer', rep.claimed === 1 && rep.auto === 3 && rep.existing === 1);
  ok('quotes sent this week: 2 (OPP-1003 Monday morning and OPP-1006)', rep.quotes === 2);
  ok('projects won this week: 1, worth $72,000', rep.won === 1 && rep.wonValue === 72000);
  const maya = rep.rows.find(r => r.am === 'maya');
  ok('Maya\'s row: 1 claimed, 1 auto-assigned, 1 quote, 1 win', maya.claimed === 1 && maya.auto === 1 && maya.quotes === 1 && maya.won === 1, maya);
  ok('every account manager has a row, so all see each other\'s results', rep.rows.length === 4);
}

console.log('\n' + (pass + fail) + ' checks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
