/**
 * test/vertical-download-race-11432.test.ts (#11432)
 *
 * Os timers do LinkedIn (#10982) e do Threads pessoal (#11410) baixam o MESMO
 * vertical do Drive. Antes do #11432: só o do Threads recuava; o do LinkedIn
 * truncava o `.part` do outro (`createWriteStream` com flag `w`), o Threads
 * renomeava um arquivo de tamanho certo e começo zerado, subia pro R2, e o
 * `reuseOrUploadToR2` reaproveitava o objeto corrompido (mesmo tamanho) em
 * toda retentativa. Fetch mockado, nada de rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPartFile, downloadDriveFile, DriveDownloadInProgressError, PART_STALE_MIN_MS, type DriveDownloadDeps } from "../scripts/lib/drive-download.ts";
import { etagMatchesBody } from "../scripts/lib/r2-object-upload.ts";
import { linkedinVerticalDownloadBusy, TIMER_LOCK_FILE as LINKEDIN_LOCK, TIMER_LOCK_STALE_MS } from "../scripts/shorts-linkedin-profile-timer.ts";
import { THREADS_TIMER_LOCK_FILE, verticalDownloadInProgress } from "../scripts/shorts-threads-profile-timer.ts";
import { SHORTS_LINKEDIN_TIMER_LOCK_FILE, SHORTS_THREADS_TIMER_LOCK_FILE, SHORTS_TIMER_LOCK_STALE_MS } from "../scripts/lib/diaria/vertical-download-guard.ts";

const FAST = { downloadMs: 5_000, idleMs: 80 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vertical-race-11432-"));
}

function deps(body: Uint8Array): DriveDownloadDeps {
  return {
    async driveFetch() {
      return new Response(body as BodyInit, { status: 200, headers: { "content-type": "video/mp4" } });
    },
  };
}

describe("#11432 lado LinkedIn recua com o download do Threads em curso", () => {
  it("lock do timer do Threads de pé → recua, citando o Threads", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const video = join(dir, "v.mp4");
      assert.equal(linkedinVerticalDownloadBusy(dir, video), null);
      writeFileSync(join(dir, THREADS_TIMER_LOCK_FILE), "");
      assert.match(linkedinVerticalDownloadBusy(dir, video)!, /Threads pessoal.*\.shorts-threads-timer\.lock/);
      // Lock velho (processo morto) não segura o LinkedIn pra sempre.
      const old = (Date.now() - TIMER_LOCK_STALE_MS - 60_000) / 1000;
      utimesSync(join(dir, THREADS_TIMER_LOCK_FILE), old, old);
      assert.equal(linkedinVerticalDownloadBusy(dir, video), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it(".part fresco do vertical → recua", () => {
    const dir = tmp();
    try {
      const video = join(dir, "v.mp4");
      writeFileSync(`${video}.part`, "abc");
      assert.match(linkedinVerticalDownloadBusy(dir, video)!, /\.part recente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("o guard do Threads continua olhando o lock do LinkedIn", () => {
    const now = Date.now();
    assert.match(verticalDownloadInProgress({ partMtimeMs: null, linkedinLockMtimeMs: now - 1000, nowMs: now })!, /LinkedIn/);
  });
  it("os nomes dos locks são os mesmos de antes (um timer enxerga o lock do outro)", () => {
    assert.equal(LINKEDIN_LOCK, "_internal/.shorts-linkedin-timer.lock");
    assert.equal(THREADS_TIMER_LOCK_FILE, "_internal/.shorts-threads-timer.lock");
    assert.equal(LINKEDIN_LOCK, SHORTS_LINKEDIN_TIMER_LOCK_FILE);
    assert.equal(THREADS_TIMER_LOCK_FILE, SHORTS_THREADS_TIMER_LOCK_FILE);
    assert.equal(TIMER_LOCK_STALE_MS, SHORTS_TIMER_LOCK_STALE_MS);
  });
  it("o main() do timer do LinkedIn chama o guard antes do --from-drive", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "shorts-linkedin-profile-timer.ts"), "utf8");
    const guard = src.indexOf("linkedinVerticalDownloadBusy(dir, videoPath)");
    const fetch = src.indexOf('"scripts/fetch-drive-video.ts"');
    assert.ok(guard > 0 && fetch > guard, "guard tem que vir antes da consulta ao Drive");
  });
});

describe("#11432 .part exclusivo (O_EXCL) no drive-download", () => {
  it("2º download com .part fresco de outro processo: recusa e NÃO trunca nem apaga o .part dele", async () => {
    const dir = tmp();
    try {
      const dest = join(dir, "v.mp4");
      writeFileSync(`${dest}.part`, "conteudo-do-outro");
      await assert.rejects(downloadDriveFile(deps(new Uint8Array([1, 2, 3])), { id: "x", name: "v.mp4" }, dest, FAST), DriveDownloadInProgressError);
      assert.equal(readFileSync(`${dest}.part`, "utf8"), "conteudo-do-outro");
      assert.equal(existsSync(dest), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it(".part velho (processo morto): toma o lugar e baixa", async () => {
    const dir = tmp();
    try {
      const dest = join(dir, "v.mp4");
      writeFileSync(`${dest}.part`, "resto");
      const old = (Date.now() - PART_STALE_MIN_MS - 60_000) / 1000;
      utimesSync(`${dest}.part`, old, old);
      const bytes = await downloadDriveFile(deps(new Uint8Array([9, 8, 7, 6])), { id: "x", name: "v.mp4", size: "4" }, dest, FAST);
      assert.equal(bytes, 4);
      assert.deepEqual([...readFileSync(dest)], [9, 8, 7, 6]);
      assert.equal(existsSync(`${dest}.part`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("dois downloads concorrentes do mesmo arquivo: um baixa íntegro, o outro recusa", async () => {
    const dir = tmp();
    try {
      const dest = join(dir, "v.mp4");
      const payload = new Uint8Array(64 * 1024).map((_, i) => (i % 251) + 1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow: DriveDownloadDeps = {
        async driveFetch() {
          const stream = new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(payload.slice(0, 1024));
              await gate;
              c.enqueue(payload.slice(1024));
              c.close();
            },
          });
          return new Response(stream as BodyInit, { status: 200, headers: { "content-type": "video/mp4" } });
        },
      };
      const a = downloadDriveFile(slow, { id: "x", name: "v.mp4", size: String(payload.length) }, dest, { downloadMs: 5_000, idleMs: 2_000 });
      await new Promise((r) => setTimeout(r, 30));
      await assert.rejects(downloadDriveFile(deps(new Uint8Array(payload.length)), { id: "x", name: "v.mp4" }, dest, FAST), DriveDownloadInProgressError);
      release();
      assert.equal(await a, payload.length);
      assert.deepEqual(readFileSync(dest), Buffer.from(payload));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("falha do próprio download apaga só o próprio .part", async () => {
    const dir = tmp();
    try {
      const dest = join(dir, "v.mp4");
      await assert.rejects(downloadDriveFile(deps(new Uint8Array([1, 2])), { id: "x", name: "v.mp4", size: "99" }, dest, FAST), /download incompleto/);
      assert.equal(existsSync(`${dest}.part`), false);
      // e o claim seguinte funciona (fd anterior fechado, nada sobrou)
      closeSync(claimPartFile(`${dest}.part`, 1_000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11432 R2: ETag (MD5) tem que bater, tamanho não basta", () => {
  const body = Buffer.from("0123456789");
  const md5 = createHash("md5").update(body).digest("hex");
  it("aceita o MD5 do corpo, com aspas e com W/", () => {
    assert.equal(etagMatchesBody(`"${md5}"`, body), true);
    assert.equal(etagMatchesBody(`W/"${md5}"`, body), true);
    assert.equal(etagMatchesBody(md5.toUpperCase(), body), true);
  });
  it("recusa conteúdo diferente de mesmo tamanho, ETag ausente e ETag de multipart", () => {
    assert.equal(etagMatchesBody(`"${createHash("md5").update(Buffer.from("XXXXXXXXXX")).digest("hex")}"`, body), false);
    assert.equal(etagMatchesBody(null, body), false);
    assert.equal(etagMatchesBody(`"${md5}-2"`, body), false);
  });
});
