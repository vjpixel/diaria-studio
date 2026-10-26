/**
 * test/drive-download-11082.test.ts (#11082)
 *
 * O download do Drive por id virou um helper só (`scripts/lib/drive-download.ts`),
 * com as proteções do `fetch-drive-video.ts`. O `publish-shorts.ts --from-drive`
 * tinha a própria cópia, que lia o arquivo inteiro na memória sem timeout nem
 * conferência de tamanho. Fetch mockado: nada de rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadDriveFileById, type DriveDownloadDeps } from "../scripts/lib/drive-download.ts";
import { downloadDriveFile as reexported } from "../scripts/fetch-drive-video.ts";
import { downloadDriveFile } from "../scripts/lib/drive-download.ts";

const ID = "1AbCdEfGhIjKlMnOp";
const FAST = { metadataMs: 1_000, downloadMs: 5_000, idleMs: 80 };

function deps(opts: {
  meta?: { status?: number; name?: string; size?: string };
  body?: Uint8Array | ReadableStream<Uint8Array>;
  contentType?: string;
}): { deps: DriveDownloadDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      async driveFetch(url) {
        calls.push(url);
        const u = new URL(url);
        if (u.searchParams.get("alt") !== "media") {
          const m = opts.meta ?? {};
          if (m.status && m.status !== 200) return new Response("nope", { status: m.status });
          return Response.json({ id: ID, name: m.name ?? "short final.mp4", mimeType: "video/mp4", ...(m.size !== undefined ? { size: m.size } : {}) });
        }
        return new Response((opts.body ?? new Uint8Array([1, 2, 3, 4])) as BodyInit, {
          status: 200,
          headers: { "content-type": opts.contentType ?? "video/mp4" },
        });
      },
    },
  };
}

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-download-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("fetch-drive-video re-exporta o MESMO downloadDriveFile do helper", () => {
  assert.equal(reexported, downloadDriveFile);
});

test(
  "downloadDriveFileById: lê o metadado (nome/tamanho) e grava o arquivo, sem .part",
  withDir(async (dir) => {
    const dest = join(dir, "diaria-comentada-261026-short.mp4");
    const { deps: d, calls } = deps({ meta: { size: "4" } });
    const r = await downloadDriveFileById(d, ID, dest, FAST);
    assert.equal(r.bytes, 4);
    assert.equal(r.name, "short final.mp4");
    assert.deepEqual([...readFileSync(dest)], [1, 2, 3, 4]);
    assert.deepEqual(readdirSync(dir), ["diaria-comentada-261026-short.mp4"]);
    assert.match(calls[0], /fields=id%2Cname%2Csize%2CmimeType/);
    assert.match(calls[1], /alt=media/);
  }),
);

test(
  "tamanho divergente do metadado: recusa e não deixa arquivo nem .part",
  withDir(async (dir) => {
    const dest = join(dir, "v.mp4");
    const { deps: d } = deps({ meta: { size: "999" } });
    await assert.rejects(downloadDriveFileById(d, ID, dest, FAST), /download incompleto \(4 de 999 bytes/);
    assert.deepEqual(readdirSync(dir), []);
  }),
);

test(
  "content-type que não é mp4 (antes: qualquer video/* passava): recusa",
  withDir(async (dir) => {
    const dest = join(dir, "v.mp4");
    const { deps: d } = deps({ meta: { name: "short.mov" }, contentType: "video/quicktime" });
    await assert.rejects(downloadDriveFileById(d, ID, dest, FAST), /não é \.mp4/);
    assert.equal(existsSync(dest), false);
  }),
);

test(
  "ociosidade: corpo que para de mandar bytes aborta pelo watchdog, sem .part",
  withDir(async (dir) => {
    const dest = join(dir, "v.mp4");
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        // nunca fecha nem manda mais nada
      },
    });
    const { deps: d } = deps({ body: stalled });
    await assert.rejects(downloadDriveFileById(d, ID, dest, FAST), /ocioso por 0.08s/);
    assert.deepEqual(readdirSync(dir), []);
  }),
);

test(
  "metadado 404: erro nomeando a conta OAuth, sem tentar o download",
  withDir(async (dir) => {
    const { deps: d, calls } = deps({ meta: { status: 404 } });
    await assert.rejects(downloadDriveFileById(d, ID, join(dir, "v.mp4"), FAST), /inacessível pela conta OAuth do projeto.*HTTP 404/);
    assert.equal(calls.length, 1);
  }),
);

test("publish-shorts.ts --from-drive usa o helper (não volta a ter download próprio)", () => {
  const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
  assert.match(src, /downloadDriveFileById\(/);
  assert.doesNotMatch(src, /alt=media/);
  assert.doesNotMatch(src, /arrayBuffer\(\)/);
});
