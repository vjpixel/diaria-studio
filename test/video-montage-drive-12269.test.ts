import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, closeSync, ftruncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadToFolder, UPLOAD_CHUNK_BYTES as CHUNK, UPLOAD_CHUNK_THRESHOLD as LIMIT } from '../scripts/lib/diaria/video-montage-drive.ts';

for (const failure of ['network', '503', '429', 'lost-final', 'none']) {
  it(`#12269 bounded disk chunks and Range recovery: ${failure}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-chunks-'));
    const path = join(dir, 'large.mp4');
    const size = LIMIT + 17;
    const fd = openSync(path, 'w');
    ftruncateSync(fd, size); // sparse: no large fixture in memory
    closeSync(fd);
    let received = 0, sessions = 0, probes = 0;
    let failed = false;
    const done = () => Response.json({ id: 'video', name: 'large.mp4' });
    try {
      const result = await uploadToFolder({
        async driveFetch(url, init) {
          if (!init?.method) return Response.json({ files: [] });
          sessions++;
          assert.equal((init.headers as Record<string, string>)['X-Upload-Content-Length'], String(size));
          return new Response(null, { headers: { location: 'https://upload/session' } });
        },
        async uploadFetch(url, init) {
          const range = (init!.headers as Record<string, string>)['Content-Range'];
          if (range === `bytes */${size}`) {
            probes++;
            if (received === size) return done();
            return new Response(null, { status: 308, headers: received ? { Range: `bytes=0-${received - 1}` } : {} });
          }
          const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/)!;
          assert.ok(match);
          assert.equal(Number(match[1]), received);
          const body = init!.body as Buffer;
          assert.ok(body.length <= CHUNK);
          assert.equal(body.length, Number(match[2]) - received + 1);
          assert.equal(body[0], 0);
          if (Number(match[2]) + 1 < size) assert.equal(body.length % (256 * 1024), 0);
          if (!failed && failure !== 'none' && (failure !== 'lost-final' || received + body.length === size)) {
            failed = true;
            received += failure === 'lost-final' ? body.length : 256 * 1024;
            if (failure === 'network' || failure === 'lost-final') throw new Error('connection lost');
            return new Response(null, { status: Number(failure) });
          }
          received += body.length;
          return received === size ? done() : new Response(null, { status: 308, headers: { Range: `bytes=0-${received - 1}` } });
        },
      }, 'folder', path);
      assert.equal(result.id, 'video');
      assert.equal(received, size);
      assert.equal(sessions, 1);
      assert.equal(probes, failure === 'none' ? 0 : 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
