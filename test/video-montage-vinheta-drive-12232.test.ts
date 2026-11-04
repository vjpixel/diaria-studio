import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVinhetaForDrive, makeDriveSession } from '../scripts/video-montagem.ts';

test('API: baixa de _marca, mede no cache, preserva Neo e reutiliza cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vinheta-'));
  const neo = 'G:/Meu Drive/YouTube/_marca/logo.mov';
  let downloads = 0;
  const file = { id: 'logo', name: 'logo.mov', size: '3', modifiedTime: '2026-11-04T00:00:00Z' };
  const drive = makeDriveSession('261105', dir, {
    driveFetch: async (url) => {
      const u = new URL(url);
      if (u.searchParams.get('alt') === 'media') { downloads++; return new Response('mov', { headers: { 'Content-Type': 'video/quicktime' } }); }
      const q = u.searchParams.get('q') ?? '';
      if (q.includes("'root' in parents")) return Response.json({ files: [{ id: 'brand', name: '_marca', mimeType: 'application/vnd.google-apps.folder' }] });
      assert.match(q, /'brand' in parents/);
      return Response.json({ files: [file] });
    },
    uploadFetch: async () => { throw new Error('não sobe'); },
  }, () => 'root');
  try {
    const deps = {
      readConfig: () => ({ publishing: { video: { vinheta_logo: { path: neo } } } }),
      exists: () => false,
      probe: (p: string) => {
        assert.equal(p, join(dir, '_marca', 'logo.mov'));
        return JSON.stringify({ streams: [{ codec_type: 'video', width: 1920, height: 1080 }], format: { duration: '1.2' } });
      },
      warn: (m: string) => { throw new Error(m); },
    };
    const asset = await loadVinhetaForDrive(drive, deps);
    assert.equal(asset?.path, neo);
    assert.equal(asset?.localPath, join(dir, '_marca', 'logo.mov'));
    assert.equal(asset?.durationS, 1.2);
    await loadVinhetaForDrive(drive, deps);
    assert.equal(downloads, 1);
    const warnings: string[] = [];
    drive.deps.driveFetch = async () => Response.json({ files: [] });
    assert.equal(await loadVinhetaForDrive(drive, { ...deps, warn: m => warnings.push(m) }), null);
    assert.match(warnings[0], /0 pastas _marca/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
