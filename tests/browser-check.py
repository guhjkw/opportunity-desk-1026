"""
tests/browser-check.py: drives the real page in Chromium (Playwright) and checks that it computes on input.
Run:  python3 tests/browser-check.py
It serves this folder on a free local port, opens index.html?fast (no step-by-step animation, same engine),
clicks through every feature, refuses bad input, and fails on any console or page error. Screenshots go to tests/.
"""
import asyncio, functools, http.server, pathlib, socketserver, threading
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
passed = failed = 0


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS', name)
    else:
        failed += 1
        print('  FAIL', name, detail)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


async def main():
    srv, port = serve()
    base = f'http://127.0.0.1:{port}/index.html'
    errors = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={'width': 1440, 'height': 1000})
        pg = await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        state = lambda js: pg.evaluate('() => { const S = window.__demo.state(); return ' + js + '; }')
        metric = lambda k: pg.locator(f'[data-m={k}] b').inner_text()

        print('\n1. Page loads on the engine with the sample company')
        await pg.goto(base + '?fast')
        await pg.wait_for_selector('#ox tbody tr')
        ok('3 earlier opportunities and 6 emails waiting', await pg.locator('#ox tbody tr').count() == 3 and (await metric('wait')).strip() == '6')
        ok('the clock shows Monday 26 Oct, 09:00', 'Mon 26 Oct, 09:00' in await pg.inner_text('#clock'))

        print('\n2. Reading the forwarded emails')
        await pg.click('#readAll')
        await pg.wait_for_function('() => Object.keys(window.__demo.state().processed).length === 6')
        ok('5 new records (8 in total), one email was a duplicate', await pg.locator('#ox tbody tr').count() == 8)
        ok('E4 is marked as a duplicate of OPP-1004', 'Duplicate of OPP-1004' in await pg.inner_text('[data-mail=E4] .st'))
        ok('E2 went straight to Liam (existing customer)', 'to Liam' in await pg.inner_text('[data-mail=E2] .st'))
        ok('4 opportunities unclaimed', (await metric('un')).strip() == '4')
        await pg.click('[data-phone=maya]')
        ok("Maya's phone shows Claim buttons for new opportunities", await pg.locator('#phone [data-claim]').count() >= 3)
        await pg.click('[data-phone=owen]')
        ok("Owen is away: no alerts and no Claim buttons on his phone", await pg.locator('#phone [data-claim]').count() == 0 and 'marked away' in await pg.inner_text('#phone'))

        print('\n3. Two managers tap Claim together')
        await pg.click('#raceBtn')
        race = await pg.inner_text('#trace')
        ok('exactly one winner and one refusal', race.count(' wins') == 1 and race.count(' refused') == 1, race)
        ok('the refused manager is told who has it', 'Already claimed by' in race)
        ok('the record has one owner', await state('S.opps.find(o => o.id === "OPP-1006").owner') is not None and await state('S.opps.find(o => o.id === "OPP-1006").version') == 1)
        await pg.click('[data-phone=priya]')
        btn = pg.locator('#phone [data-claim="OPP-1004"]').first
        await btn.click()
        ok("Priya claims OPP-1004 from her phone", await state('S.opps.find(o => o.id === "OPP-1004").owner') == 'priya')
        ok('claiming it again from another phone is refused', await pg.evaluate('() => window.__demo.engine.claim(window.__demo.state(), "OPP-1004", "maya").ok') is False)

        print('\n4. Moving the clock')
        await pg.click('[data-adv=bizhours]')
        ok('after 4 business hours the unclaimed ones are reminded', 'Reminder' in await pg.inner_text('#trace'))
        await pg.click('[data-adv=morning]')
        ok('next morning the rotation assigns what is left', 'by rotation' in (await pg.inner_text('#trace')).lower() and await pg.locator('#ox tbody >> text=(rotation)').count() >= 1)
        ok('overdue follow-ups show up', int((await metric('od')).strip()) >= 1)

        print('\n5. The team list')
        await pg.click('#tAdd')
        ok('adding with no name or email is refused with reasons', 'first and last name' in await pg.inner_text('#tErr'))
        await pg.fill('#tName', 'Noah Comeau')
        await pg.fill('#tEmail', 'noah@cedarridge.example')
        await pg.click('#tAdd')
        ok('a new manager joins the list and the rotation', await state('S.rotation.order.includes("noah")') and await pg.locator('[data-phone=noah]').count() == 1)
        await pg.click('[data-toggle=liam]')
        ok('Liam marked away', await state('S.ams.find(a => a.id === "liam").active') is False)
        await pg.click('[data-remove=noah]')
        ok('removing Noah takes him out again', not await state('S.rotation.order.includes("noah")'))

        print('\n6. Forwarding your own inquiry')
        await pg.click('#fwdBtn')
        await pg.select_option('#fBy', 'someone@gmail.com')
        await pg.click('#fRun')
        ok('a forward from outside the company is refused', 'staff' in await pg.inner_text('#fErr'))
        await pg.select_option('#fBy', 'nadia@cedarridge.example')
        await pg.select_option('#fSample', 'existing')
        await pg.click('#fRun')
        ok("a Maritime Freight inquiry goes straight to Priya", await state('S.opps[S.opps.length - 1].owner') == 'priya' and await state('S.opps[S.opps.length - 1].how') == 'existing')

        print('\n7. QuickBooks estimate and quote status')
        await pg.click('#ox tr[data-opp="OPP-1004"]')
        await pg.fill('#qNo', 'abc')
        await pg.click('[data-quote="OPP-1004"]')
        ok('a bad estimate number is refused', 'EST-2051' in await pg.inner_text('#dErr'))
        await pg.fill('#qNo', '2051')
        await pg.select_option('#qSt', 'Sent')
        await pg.click('[data-quote="OPP-1004"]')
        ok('2051 is stored as EST-2051 and the record is Quoted', await state('S.opps.find(o => o.id === "OPP-1004").estimateNo') == 'EST-2051' and await state('S.opps.find(o => o.id === "OPP-1004").status') == 'Quoted')

        print('\n8. The Friday report')
        await pg.click('[data-adv=friday]')
        ok('the report is sent on Friday at 16:00', 'friday report sent' in (await pg.inner_text('#report')).lower() and 'Fri 30 Oct, 16:00' in await pg.inner_text('#clock'))
        ok('it has a row for every manager', await pg.locator('#report tbody tr').count() == await state('S.ams.length'))
        await pg.click('#resetBtn')
        await pg.click('#readAll')
        await pg.wait_for_function('() => Object.keys(window.__demo.state().processed).length === 6')
        await pg.click('#raceBtn')
        await pg.locator('#console').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop.png'))
        await pg.locator('#detail').scroll_into_view_if_needed()
        await pg.screenshot(path=str(ROOT / 'tests' / 'shot-desktop-lower.png'))

        print('\n9. Animated mode and phone layout')
        pg2 = await ctx.new_page()
        pg2.on('pageerror', lambda e: errors.append(str(e)))
        await pg2.goto(base)
        await pg2.wait_for_selector('#ox tbody tr')
        await pg2.click('[data-mail=E3]')
        await pg2.wait_for_function('() => !!window.__demo.state().processed.E3', timeout=8000)
        await pg2.wait_for_timeout(1500)
        ok('one email animates through and is created', 'OPP-1004 created' in await pg2.inner_text('[data-mail=E3] .st'))
        mob = await br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pm = await mob.new_page()
        pm.on('pageerror', lambda e: errors.append(str(e)))
        await pm.goto(base + '?fast')
        await pm.wait_for_selector('#ox tbody tr')
        await pm.click('#readAll')
        await pm.wait_for_function('() => Object.keys(window.__demo.state().processed).length === 6')
        ok('no sideways scrolling at 390px wide', await pm.evaluate('document.documentElement.scrollWidth') <= 390, await pm.evaluate('document.documentElement.scrollWidth'))
        await pm.screenshot(path=str(ROOT / 'tests' / 'shot-mobile.png'))

        ok('zero console or page errors', not errors, errors)
        await br.close()
    srv.shutdown()
    print(f'\n{passed + failed} browser checks: {passed} passed, {failed} failed')
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    asyncio.run(main())
