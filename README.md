# Opportunity desk (Airtable + Make.com sales inquiry demo)

A live, working demo built for an Upwork job post: a building company that wants forwarded project inquiries turned into Airtable opportunities, claimed first-come-first-served by authorized account managers with no double claims, reminded after 4 business hours, assigned by rotation after 1 business day, chased for follow-up, tracked against QuickBooks estimates and reported every Friday.

It is a real tool, not a video. **Everything here is invented:** Cedar Ridge Builders, its staff, customers, inquiries, emails (reserved `.example` domain) and phone numbers (555-01xx). No real client data.

## Try it

Open `index.html` (works straight off disk) or the live link, then:

- **Read forwarded emails**: six inquiries become records. One is a duplicate (becomes a note), one is an existing customer (goes straight to their manager).
- **Two managers tap Claim**: two claims 31 ms apart. Exactly one wins; the other is told who has it.
- **+4 business hours / Next morning / Friday 4 pm**: reminders, rotation assignments, overdue follow-ups, escalations and the Friday report fire on their own.
- Mark someone away or add a manager: notifications, claiming and the rotation change with no rebuild.

## Files

```
opportunity-desk-1026/
├── index.html              the page (built from index.src.html with the data embedded)
├── index.src.html          page source
├── build.py                embeds data/desk.json into index.html for the file:// case
├── src/deskEngine.js       ALL the logic, one file, loaded by the page AND the tests
├── data/desk.json          invented builder: 4 managers, 3 customers, 6 forwarded inquiries
├── tests/verify.js         61 engine checks (node)
├── tests/test-output.txt   the saved passing run
├── tests/browser-check.py  29 Playwright checks driving the real page
└── README.md
```

## Run the tests

```
node tests/verify.js            # 61 checks: 61 passed, 0 failed
python3 tests/browser-check.py  # 29 browser checks: 29 passed, 0 failed (needs: pip install playwright && playwright install chromium)
```

## How the logic works

| Step | What the engine does |
|---|---|
| Intake | Reads the forwarded "From:" line (skipping company and no-reply addresses), name, email, phone, company, project type, town, budget (ranges and "$15k") and timeline. Missing fields are flagged, not guessed. |
| Duplicates | An open opportunity with the same email or phone in the last 14 days gets a note instead of a second record. |
| Existing customers | Email domain or company name matches the customer list: the record goes straight to that account manager, no claiming. |
| Notify and claim | Every active authorized manager is notified at once. Claims are processed one at a time in arrival order and re-check the record before writing, so a second simultaneous claim is refused with the owner's name. |
| Timers | Business hours 8:00 to 17:00, Monday to Friday. Reminder after 4 business hours; rotation assignment after 1 business day, skipping managers marked away. |
| Follow-up | First contact due 1 business day after claim or assignment; overdue reminder to the owner, then escalation to the admin 4 business hours later. |
| QuickBooks | Estimate number (stored as EST-nnnn) and quote status (Draft, Sent, Accepted, Declined); Accepted marks the opportunity Won. |
| Friday report | New, claimed, rotation, existing-customer, quotes sent and won (with value), plus a row per manager so everyone sees each other's results. |

## What the delivered version adds

The demo reads emails with rules so it needs no API key. The delivered build runs as Make.com scenarios in the client's own accounts: an AI module reads each forwarded email, Airtable holds opportunities, managers, customers and settings, the claim webhook runs with sequential processing, a scheduled scenario handles timers, and the Friday report is emailed to the team.

Built by Taiwo, Pathfinder Automation Solutions.
