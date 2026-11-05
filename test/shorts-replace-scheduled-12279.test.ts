import { runFetchDriveVideo } from '../scripts/fetch-drive-video.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planScheduledReplacements, shortVideoChangeWarnings, newerShortVersionWarnings } from '../scripts/lib/diaria/short-scheduled-replace.ts';
import { deleteFacebookScheduledVideo, parseShortsCliArgs, type GraphDeps } from '../scripts/publish-shorts.ts';
import { deleteScheduledYouTubeVideo } from '../scripts/lib/diaria/youtube-upload.ts';
import { persistShortEntry, readShortsRegistry, recordShortReplacementDeletion, readShortReplacementHistory } from '../scripts/lib/diaria/shorts-published-store.ts';
import type { ShortPublishedEntry } from '../scripts/lib/diaria/short-video.ts';
import type { ResolvedFacebookPage } from '../scripts/lib/facebook-pages.ts';

const now = new Date('2026-11-05T03:00:00Z');
const entry = (destination = 'youtube_shorts', extra: Partial<ShortPublishedEntry> = {}): ShortPublishedEntry => ({ destination, id: 'old', status: 'scheduled', at: now.toISOString(), scheduled_at: '2026-11-05T12:00:00Z', ...extra });
const page = { slug: 'diaria', pageId: 'page', token: 'fake' } as ResolvedFacebookPage;
const graph = (fetch: GraphDeps['fetch']): GraphDeps => ({ fetch, now: () => now, sleep: async () => {}, log: () => {} });

describe('#12279 replacement planning and registry', () => {
  it('parses the flag with either placement of the edition', () => {
    for (const args of [['261105', '--replace-scheduled'], ['--replace-scheduled', '261105']]) {
      const parsed = parseShortsCliArgs(args);
      assert.ok(parsed.ok);
      assert.ok(parsed.flags.has('replace-scheduled'));
      assert.equal(parsed.aammdd, '261105');
    }
  });
  it('excludes published, ambiguous, overdue, malformed and unsupported destinations', () => {
    const items = planScheduledReplacements([
      entry(), entry('facebook:diaria'), entry('x', { id: 'buffer:b' }), entry('tiktok', { id: 'buffer:t' }),
      entry('published', { status: 'published' }), entry('unknown', { status: 'send_unknown' }),
      entry('past', { scheduled_at: now.toISOString() }), entry('bad-date', { scheduled_at: 'invalid' }),
      entry('missing', { scheduled_at: null }), entry('instagram'),
      entry('soon', { scheduled_at: '2026-11-05T03:05:00Z' }),
    ], now);
    assert.deepEqual(items.map(i => i.action), ['replace', 'replace', 'buffer', 'buffer', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip']);
    assert.throws(() => planScheduledReplacements([entry()], now, ['typo']));
    assert.equal(planScheduledReplacements([entry(), entry('x')], now, ['x']).length, 1);
  });
  it('warns when bytes change, including a re-export under the same filename', () => {
    assert.equal(shortVideoChangeWarnings([entry('x', { video_sha256: 'v1' })], 'v2').length, 1);
    assert.deepEqual(shortVideoChangeWarnings([entry('x', { video_sha256: 'v1' }), entry()], 'v1'), []);
  });
  it('warns for V2 in Drive after V1 was scheduled, without warning for the same or older export', () => {
    const entries = [entry('youtube_shorts', { video_source_name: 'Diaria comentada_Vertical_V1.mp4' })];
    assert.equal(newerShortVersionWarnings(entries, 'Diaria comentada_Vertical_V2.mp4').length, 1);
    assert.equal(newerShortVersionWarnings(entries, 'Diaria comentada_Vertical_V1.mp4').length, 0);
    assert.equal(newerShortVersionWarnings([entry()], 'Diaria comentada_Vertical_V2.mp4').length, 0);
  });
  it('retry skips destinations that already have the replacement bytes', () => {
    const items = planScheduledReplacements([entry('youtube_shorts', { video_sha256: 'v2' }), entry('facebook:diaria', { video_sha256: 'v1' })], now, null, 'v2');
    assert.deepEqual(items.map(i => i.action), ['skip', 'replace']);
  });
  it('fetch dry-run warns about V2 while preserving the local file and registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shorts-version-'));
    try {
      persistShortEntry(dir, '261105', 'main', entry('youtube_shorts', { video_source_name: 'Diaria comentada_Outras redes_V1.mp4' }));
      writeFileSync(join(dir, 'diaria-comentada-261105-short.mp4'), 'local-v1');
      const logs: string[] = [];
      const out = await runFetchDriveVideo({ driveFetch: async (url, init) => {
        assert.ok(!init?.method || init.method === 'GET');
        const u = new URL(url);
        if (!u.pathname.endsWith('/files')) return Response.json({ mimeType: 'application/vnd.google-apps.folder' });
        const q = u.searchParams.get('q') ?? '';
        if (q.includes("'root'")) return Response.json({ files: [{ id: 'edition', name: '261105', mimeType: 'application/vnd.google-apps.folder' }] });
        if (q.includes("'edition'")) return Response.json({ files: [{ id: 'final', name: 'Final', mimeType: 'application/vnd.google-apps.folder' }] });
        return Response.json({ files: [{ id: 'v2', name: 'Diaria comentada_Outras redes_V2.mp4', mimeType: 'video/mp4', size: '5', videoMediaMetadata: { width: 1080, height: 1920 } }] });
      } }, { aammdd: '261105', orientation: 'vertical', folderId: 'root', editionDir: dir, now, windowHours: 36, dryRun: true, force: false }, line => logs.push(line));
      assert.equal(out.exitCode, 0);
      assert.ok(logs.some(l => l.includes('mais novo') && l.includes('V2')));
      assert.equal(readShortsRegistry(dir, '261105').entries[0].id, 'old');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('archives deleted IDs and ignores stale copies without clearing unrelated or new posts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shorts-replace-'));
    try {
      persistShortEntry(dir, '261105', 'main', entry());
      persistShortEntry(dir, '261105', 'threads-timer', entry('threads_profile', { status: 'published' }));
      recordShortReplacementDeletion(dir, '261105', entry());
      mkdirSync(join(dir, '_internal'), { recursive: true });
      writeFileSync(join(dir, '_internal/06-shorts-published-Neo.json'), JSON.stringify({ aammdd: '261105', entries: [entry()] }));
      assert.deepEqual(readShortsRegistry(dir, '261105').entries.map(e => e.destination), ['threads_profile']);
      assert.equal(readShortReplacementHistory(dir, '261105').entries[0].id, 'old');
      persistShortEntry(dir, '261105', 'main', entry('youtube_shorts', { id: 'new', video_sha256: 'v2', at: '2026-11-05T02:00:00Z' }));
      assert.equal(readShortsRegistry(dir, '261105').entries.find(e => e.destination === 'youtube_shorts')?.id, 'new');
      writeFileSync(join(dir, '_internal/shorts-replacement-history.json'), '{');
      assert.throws(() => readShortsRegistry(dir, '261105'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('#12279 remote deletion guards (mock network only)', () => {
  for (const state of [{ published: true, scheduled_publish_time: 1793880000 }, {}, { published: false, scheduled_publish_time: 0 }, { published: false, scheduled_publish_time: 'invalid' }]) {
    it(`Facebook refuses unsafe state ${JSON.stringify(state)}`, async () => {
      const calls: string[] = [];
      await assert.rejects(deleteFacebookScheduledVideo(graph(async (_url, init) => {
        calls.push(init?.method ?? 'GET');
        return Response.json(state);
      }), page, 'v24.0', 'old'));
      assert.deepEqual(calls, ['GET']);
    });
  }
  it('Facebook requires a positive deletion acknowledgement', async () => {
    const calls: string[] = [];
    await deleteFacebookScheduledVideo(graph(async (_url, init) => {
      calls.push(init?.method ?? 'GET');
      return Response.json(init?.method === 'DELETE' ? { success: true } : { published: false, scheduled_publish_time: Date.parse('2026-11-05T12:00:00Z') / 1000 });
    }), page, 'v24.0', 'old');
    assert.deepEqual(calls, ['GET', 'DELETE']);
  });
  for (const status of [{ privacyStatus: 'public', publishAt: '2026-11-05T12:00:00Z' }, { privacyStatus: 'private' }, { privacyStatus: 'private', publishAt: 'bad' }, { privacyStatus: 'private', publishAt: '2026-11-05T02:00:00Z' }]) {
    it(`YouTube refuses unsafe status ${JSON.stringify(status)}`, async () => {
      const calls: string[] = [];
      await assert.rejects(deleteScheduledYouTubeVideo({ now: () => now, fetch: async (url, init) => {
        calls.push(init?.method ?? 'GET');
        if (url.includes('oauth2')) return Response.json({ access_token: 'fake' });
        if (url.includes('/channels')) return Response.json({ items: [{ id: 'channel' }] });
        return Response.json({ items: [{ id: 'old', snippet: { channelId: 'channel' }, status }] });
      } }, { clientId: 'fake', clientSecret: 'fake', refreshToken: 'fake', channelId: 'channel' }, 'old'));
      assert.ok(!calls.includes('DELETE'));
    });
  }
  it('YouTube checks ownership and private future schedule before DELETE', async () => {
    const calls: string[] = [];
    await deleteScheduledYouTubeVideo({ now: () => now, fetch: async (url, init) => {
      calls.push(init?.method ?? 'GET');
      if (url.includes('oauth2')) return Response.json({ access_token: 'fake' });
      if (url.includes('/channels')) return Response.json({ items: [{ id: 'channel' }] });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ items: [{ id: 'old', snippet: { channelId: 'channel' }, status: { privacyStatus: 'private', publishAt: '2026-11-05T12:00:00Z' } }] });
    } }, { clientId: 'fake', clientSecret: 'fake', refreshToken: 'fake', channelId: 'channel' }, 'old');
    assert.deepEqual(calls, ['POST', 'GET', 'GET', 'DELETE']);
  });
});
