/**
 * test/youtube-upload-resume-10875.test.ts (#10875)
 *
 * 1. O PUT dos bytes do `--upload` do YouTube é RETOMÁVEL: em falha
 *    transitória (rede caindo, 5xx) consulta a mesma sessão resumable com
 *    `Content-Range: bytes` + `*` + `/N` e reenvia só do último byte confirmado.
 * 2. O `publishAt` ganha folga: faltando menos de 15 min para o horário-alvo,
 *    publica na hora em vez de agendar um instante que o upload vai atravessar.
 *
 * Tudo com `fetch` mockado — nenhum teste toca a rede nem a API do YouTube.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  YOUTUBE_UPLOAD_MAX_RESUMES,
  YouTubeUploadError,
  isIndeterminateUploadFailure,
  parseUploadedRange,
  putVideoBytes,
  resumeBackoffMs,
  type YouTubeUploadDeps,
} from "../scripts/lib/diaria/youtube-upload.ts";
import { YOUTUBE_SCHEDULE_MIN_LEAD_MS, resolveYouTubeSchedule } from "../scripts/lib/diaria/youtube-video.ts";

const SESSION_URL = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=sess-1";
const VIDEO = Buffer.from("0123456789abcdefghij"); // 20 bytes
const OK_RESOURCE = { id: "vid123", status: { uploadStatus: "uploaded" } };

interface Call {
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  redirect: string | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function resumeIncomplete(lastByte: number | null): Response {
  return new Response(null, { status: 308, headers: lastByte === null ? {} : { Range: `bytes=0-${lastByte}` } });
}

/** Cada chamada consome a próxima resposta da fila (função = pode lançar). */
function mockDeps(script: Array<Response | (() => Response)>): { deps: YouTubeUploadDeps; calls: Call[]; sleeps: number[] } {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const deps: YouTubeUploadDeps = {
    now: () => new Date("2026-10-21T23:00:00Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async (url, init) => {
      assert.equal(url, SESSION_URL);
      const raw = init?.body as Uint8Array | undefined;
      calls.push({
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string>) },
        body: raw ? Buffer.from(raw) : null,
        redirect: init?.redirect,
      });
      const next = script.shift();
      if (!next) throw new Error("chamada não prevista no roteiro");
      return typeof next === "function" ? next() : next;
    },
  };
  return { deps, calls, sleeps };
}

describe("PUT retomável na mesma sessão (#10875)", () => {
  it("rede cai no meio: consulta a sessão e reenvia SÓ do último byte confirmado", async () => {
    const { deps, calls, sleeps } = mockDeps([
      () => {
        throw new Error("socket hang up");
      },
      resumeIncomplete(7), // servidor confirmou bytes 0..7
      json(200, OK_RESOURCE),
    ]);
    const res = await putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4");
    assert.equal(res.id, "vid123");
    assert.equal(calls.length, 3);

    // 1ª: PUT inteiro, sem Content-Range (igual ao upload sem falha).
    assert.equal(calls[0].headers["Content-Range"], undefined);
    assert.equal(calls[0].headers["Content-Length"], "20");
    assert.deepEqual(calls[0].body, VIDEO);

    // 2ª: consulta de status, corpo vazio.
    assert.equal(calls[1].method, "PUT");
    assert.equal(calls[1].headers["Content-Range"], "bytes */20");
    assert.equal(calls[1].headers["Content-Length"], "0");
    assert.equal(calls[1].body, null);

    // 3ª: retomada a partir do byte 8.
    assert.equal(calls[2].headers["Content-Range"], "bytes 8-19/20");
    assert.equal(calls[2].headers["Content-Length"], "12");
    assert.deepEqual(calls[2].body, VIDEO.subarray(8));
    assert.equal(calls[2].headers.Authorization, "Bearer tok");

    // 308 não pode ser seguido como redirect pelo fetch.
    for (const c of calls) assert.equal(c.redirect, "manual");
    assert.deepEqual(sleeps, [1000]);
  });

  it("5xx no PUT: consulta, sessão sem Range (nada recebido) → reenvia do zero", async () => {
    const { deps, calls } = mockDeps([json(503, { error: "backend" }), resumeIncomplete(null), json(201, OK_RESOURCE)]);
    const res = await putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4");
    assert.equal(res.id, "vid123");
    assert.equal(calls[2].headers["Content-Range"], undefined);
    assert.deepEqual(calls[2].body, VIDEO);
  });

  it("a consulta revela que o upload JÁ terminou: devolve o resource sem reenviar bytes", async () => {
    const { deps, calls } = mockDeps([
      () => {
        throw new Error("ECONNRESET");
      },
      json(200, OK_RESOURCE),
    ]);
    const res = await putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4");
    assert.equal(res.id, "vid123");
    assert.equal(calls.length, 2);
  });

  it("PUT devolve 308 parcial: retoma do Range sem consulta extra", async () => {
    const { deps, calls } = mockDeps([resumeIncomplete(4), json(200, OK_RESOURCE)]);
    await putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers["Content-Range"], "bytes 5-19/20");
  });

  it("consulta também falhando: tenta consultar de novo, nunca reenvia de offset desconhecido", async () => {
    const { deps, calls } = mockDeps([
      json(502, {}),
      json(503, {}), // consulta falha
      resumeIncomplete(9), // 2ª consulta responde
      json(200, OK_RESOURCE),
    ]);
    await putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4");
    assert.equal(calls[1].headers["Content-Range"], "bytes */20");
    assert.equal(calls[2].headers["Content-Range"], "bytes */20");
    assert.equal(calls[3].headers["Content-Range"], "bytes 10-19/20");
  });

  it("esgota as retomadas: lança na etapa upload (estado incerto), com a causa e o nº de retomadas", async () => {
    const script: Array<Response | (() => Response)> = [];
    for (let i = 0; i < 2 * (YOUTUBE_UPLOAD_MAX_RESUMES + 1); i++) script.push(json(503, { error: "backend" }));
    const { deps, sleeps } = mockDeps(script);
    await assert.rejects(putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4"), (e: unknown) => {
      assert.ok(e instanceof YouTubeUploadError);
      assert.equal(e.step, "upload");
      assert.ok(isIndeterminateUploadFailure(e));
      assert.match(e.message, /503/);
      assert.match(e.message, new RegExp(`após ${YOUTUBE_UPLOAD_MAX_RESUMES} retomadas`));
      return true;
    });
    assert.equal(sleeps.length, YOUTUBE_UPLOAD_MAX_RESUMES);
  });

  it("4xx no PUT não é retomado (erro definitivo, sem consulta)", async () => {
    const { deps, calls } = mockDeps([json(403, { error: { errors: [{ reason: "quotaExceeded" }] } })]);
    await assert.rejects(putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4"), /quota/);
    assert.equal(calls.length, 1);
  });

  it("sessão expirada (404) na consulta: lança sem tentar de novo", async () => {
    const { deps, calls } = mockDeps([json(500, {}), json(404, {})]);
    await assert.rejects(putVideoBytes(deps, "tok", SESSION_URL, VIDEO, "video/mp4"), (e: unknown) => {
      assert.ok(e instanceof YouTubeUploadError);
      assert.equal(e.step, "upload");
      assert.match(e.message, /sessão de upload expirou/);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it("parseUploadedRange: ausente = 0, bytes=0-N = N+1, malformado ou além do total lança", () => {
    assert.equal(parseUploadedRange(null, 20), 0);
    assert.equal(parseUploadedRange("bytes=0-19", 20), 20);
    assert.throws(() => parseUploadedRange("bytes=5-9", 20), YouTubeUploadError);
    assert.throws(() => parseUploadedRange("bytes=0-20", 20), YouTubeUploadError);
  });

  it("backoff exponencial com teto de 30s", () => {
    assert.deepEqual([1, 2, 3, 6, 10].map(resumeBackoffMs), [1000, 2000, 4000, 30_000, 30_000]);
  });
});

describe("publishAt com folga mínima antes das 06:00 BRT (#10875)", () => {
  // 06:00 BRT de 261022 = 09:00Z.
  it("faltando 5 min: publica na hora, premissa cita a folga", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-22T08:55:00Z"));
    assert.equal(s.mode, "immediate");
    assert.equal(s.publishAt, null);
    assert.equal(s.privacyStatus, "public");
    assert.match(s.premise, /#10875/);
    assert.match(s.premise, /5 min/);
  });

  it("faltando exatamente a folga ou mais: segue agendado", () => {
    const atLimit = new Date(Date.parse("2026-10-22T09:00:00Z") - YOUTUBE_SCHEDULE_MIN_LEAD_MS);
    assert.equal(resolveYouTubeSchedule("261022", atLimit).mode, "scheduled");
    assert.equal(resolveYouTubeSchedule("261022", new Date("2026-10-22T08:30:00Z")).mode, "scheduled");
  });

  it("--publish-at explícito perto demais também vira publicação na hora", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-22T11:50:00Z"), "2026-10-22T12:00:00Z");
    assert.equal(s.mode, "immediate");
  });

  it("folga configurável (0 = comportamento antigo)", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-22T08:55:00Z"), null, 0);
    assert.equal(s.mode, "scheduled");
  });

  it("horário já passado continua publicando na hora com a premissa antiga", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-22T15:00:00Z"));
    assert.equal(s.mode, "immediate");
    assert.match(s.premise, /já passou/);
  });
});
