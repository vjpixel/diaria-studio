import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentDomain, referrerDomain, engagement, safeAttribution } from '../scripts/report-kit-agent-domains.ts';
test('matches only explicit domain, including case normalization', () => {
  assert.equal(agentDomain('private@MAIL.GROKBOT.COM'), 'mail.grokbot.com');
  for (const email of ['x@evilmail.grokbot.com', 'x@mail.grokbot.com.evil', 'x@example.com', 'x@y@mail.grokbot.com']) assert.equal(agentDomain(email), null);
});
test('stats preserve missing as unknown and zero as zero', () => {
  assert.deepEqual(engagement(null), { sent: null, opened: null, clicked: null });
  assert.deepEqual(engagement({ subscriber: { stats: { sent: 7, opened: 0, clicked: 0 } } }), { sent: 7, opened: 0, clicked: 0 });
  assert.equal(engagement({ subscriber: { stats: { opened: -1 } } }).opened, null);
});
test('attribution exposes domains/presence only', () => {
  const privateValue = 'secret@example.com';
  const result = safeAttribution({ id: 123, email_address: privateValue, state: 'active', created_at: 'private', fields: { utm_source: privateValue, referring_site: 'https://example.org/private?q=secret' } });
  assert.equal(result.stored_referrer_domain, 'example.org');
  assert.equal(result.stored_utm_present, true);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(referrerDomain('javascript:secret'), null);
});
test('report uses GET only, paginates all statuses and omits identities', async () => {
  const { main } = await import('../scripts/report-kit-agent-domains.ts');
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousKey = process.env.KIT_API_KEY;
  const calls: URL[] = [];
  let output = '';
  process.env.KIT_API_KEY = 'test-key';
  console.log = value => { output += String(value); };
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    const url = new URL(String(input));
    calls.push(url);
    const sub = { id: 321, email_address: 'private@mail.grokbot.com', state: 'active', created_at: 'private' };
    const body = url.pathname.endsWith('/stats') ? { subscriber: { stats: { sent: 2, opened: 0, clicked: 0 } } }
      : url.pathname.includes('/forms/') ? { subscribers: [sub], pagination: { has_next_page: false } }
      : { subscribers: url.searchParams.has('after') ? [sub] : [], pagination: { has_next_page: !url.searchParams.has('after'), end_cursor: 'next' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    await main();
    const report = JSON.parse(output);
    assert.equal(report.matched_count, 1);
    assert.equal(report.rows[0].configured_doi_form_member, true);
    assert.equal(report.rows[0].opened, 0);
    assert.equal(calls.filter(u => u.pathname === '/v4/subscribers').length, 2);
    for (const u of calls.filter(u => u.pathname.endsWith('/subscribers'))) assert.equal(u.searchParams.get('status'), 'all');
    assert.ok(!output.includes('private'));
    assert.equal(report.rows[0].id, undefined);
    assert.equal(report.rows[0].email_address, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    if (previousKey === undefined) delete process.env.KIT_API_KEY; else process.env.KIT_API_KEY = previousKey;
  }
});
