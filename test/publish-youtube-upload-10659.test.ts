/**
 * test/publish-youtube-upload-10659.test.ts (#10659)
 *
 * Upload REAL do `publish-youtube.ts --upload`, com `fetch` mockado — nenhum
 * teste toca rede nem a API. Cobre: sucesso (insert resumable + capa +
 * releitura), erro 4xx no insert, falha só na capa (vídeo segue), releitura
 * (#573: estado relido, nunca o pedido), canal errado, credencial ausente,
 * idempotência do registro em `_internal/` e que nenhum segredo vaza no log.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  YOUTUBE_PUBLISHED_FILE,
  YouTubeUploadError,
  describeYouTubeState,
  explainYouTubeUploadError,
  missingYouTubeCredentials,
  uploadYouTubeVideo,
  type YouTubeUploadDeps,
} from "../scripts/lib/diaria/youtube-upload.ts";
import { planYouTubePublish, runYouTubeUpload, type YouTubePublishPlan } from "../scripts/publish-youtube.ts";

const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
IA ladra? O cofre que o modelo abriu
https://fonte.exemplo.com/artigo

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa:
Porque sim.
`;

const SECRETS = {
  GOOGLE_CLIENT_ID: "client-id-xyz",
  GOOGLE_CLIENT_SECRET: "client-secret-SHOULD-NOT-LEAK",
  YOUTUBE_REFRESH_TOKEN: "refresh-SHOULD-NOT-LEAK",
  YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w",
};
const ACCESS = "access-SHOULD-NOT-LEAK";
const VIDEO_ID = "abc123XYZ_9";
const SESSION_URL = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=sess-1";
// Antes das 06:00 BRT de 261022 → modo agendado.
const NOW = new Date("2026-10-21T23:00:00Z");
const PUBLISH_AT = "2026-10-22T09:00:00.000Z";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => Response | undefined;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Rotas default de um upload bem-sucedido; `overrides` trocam uma etapa. */
function happyRoutes(overrides: Partial<Record<"token" | "channel" | "insert" | "put" | "thumb" | "reread", Route>> = {}): Route[] {
  const r: Record<string, Route> = {
    token: (c) => (c.url === "https://oauth2.googleapis.com/token" ? json(200, { access_token: ACCESS, expires_in: 3599 }) : undefined),
    channel: (c) => (c.url.includes("/youtube/v3/channels") ? json(200, { items: [{ id: SECRETS.YOUTUBE_CHANNEL_ID }] }) : undefined),
    insert: (c) =>
      c.url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable")
        ? new Response(null, { status: 200, headers: { Location: SESSION_URL } })
        : undefined,
    put: (c) =>
      c.url === SESSION_URL && c.method === "PUT"
        ? json(200, { id: VIDEO_ID, snippet: { channelId: SECRETS.YOUTUBE_CHANNEL_ID }, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT } })
        : undefined,
    thumb: (c) => (c.url.includes("/thumbnails/set") ? json(200, { items: [] }) : undefined),
    reread: (c) =>
      c.url.includes("/youtube/v3/videos?part=status")
        ? json(200, { items: [{ id: VIDEO_ID, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT } }] })
        : undefined,
  };
  for (const [k, v] of Object.entries(overrides)) r[k] = v as Route;
  return [r.token, r.channel, r.insert, r.put, r.thumb, r.reread];
}

function mockDeps(routes: Route[]): { deps: YouTubeUploadDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: YouTubeUploadDeps = {
    now: () => NOW,
    fetch: async (url, init) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const raw = init?.body;
      const body = typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : raw;
      const call: Call = { url, method: init?.method ?? "GET", headers, body };
      calls.push(call);
      for (const route of routes) {
        const res = route(call);
        if (res) return res;
      }
      throw new Error(`rota não mockada: ${call.method} ${url}`);
    },
  };
  return { deps, calls };
}

function buildPlan(dir: string, opts: { video?: boolean; thumb?: boolean } = {}): YouTubePublishPlan {
  const videoPath = join(dir, "diaria-comentada-261022.mp4");
  const thumbPath = join(dir, "04-youtube-thumb.jpg");
  if (opts.video !== false) writeFileSync(videoPath, Buffer.from("fake-mp4-bytes"));
  if (opts.thumb !== false) writeFileSync(thumbPath, Buffer.from("fake-jpeg"));
  return planYouTubePublish({
    aammdd: "261022",
    reviewedMd: REVIEWED_MD,
    now: NOW,
    episode: 2,
    editionUrl: "https://diar.ia.br/p/ia-ladra",
    video: { path: videoPath, exists: opts.video !== false, sizeBytes: opts.video !== false ? 14 : null },
    thumb: { path: thumbPath, exists: opts.thumb !== false },
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publish-youtube-upload-10659-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(deps: YouTubeUploadDeps, plan: YouTubePublishPlan, extra: { env?: Record<string, string>; force?: boolean } = {}) {
  const logs: string[] = [];
  return runYouTubeUpload(deps, {
    plan,
    editionDir: dir,
    env: extra.env ?? SECRETS,
    force: extra.force ?? false,
    readFile: (p) => readFileSync(p),
    log: (l) => logs.push(l),
  }).then((outcome) => ({ outcome, logs }));
}

function assertNoSecrets(text: string) {
  for (const s of [ACCESS, SECRETS.GOOGLE_CLIENT_SECRET, SECRETS.YOUTUBE_REFRESH_TOKEN]) {
    assert.ok(!text.includes(s), `segredo vazou: ${s}`);
  }
}

describe("upload real — sucesso (#10659)", () => {
  it("token → canal → insert resumable → PUT → capa → releitura; grava o registro em _internal/", async () => {
    const plan = buildPlan(dir);
    const { deps, calls } = mockDeps(happyRoutes());
    const { outcome, logs } = await run(deps, plan);

    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.skipped, false);
    assert.deepEqual(
      calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      [
        "POST /token",
        "GET /youtube/v3/channels",
        "POST /upload/youtube/v3/videos",
        "PUT /upload/youtube/v3/videos",
        "POST /upload/youtube/v3/thumbnails/set",
        "GET /youtube/v3/videos",
      ],
    );
    // Refresh token vai só pro endpoint de token, nunca pra API do YouTube.
    assert.match(String(calls[0].body), /grant_type=refresh_token/);
    for (const c of calls.slice(1)) assert.equal(c.headers.Authorization, `Bearer ${ACCESS}`);
    // O insert leva privacyStatus + publishAt do plano (06:00 BRT).
    const insertBody = JSON.parse(String(calls[2].body));
    assert.equal(insertBody.status.privacyStatus, "private");
    assert.equal(insertBody.status.publishAt, PUBLISH_AT);
    assert.equal(insertBody.snippet.title, plan.metadata.title);
    assert.equal(calls[2].headers["X-Upload-Content-Type"], "video/mp4");
    assert.ok(calls[4].url.endsWith(`?videoId=${VIDEO_ID}`));

    const rec = outcome.record!;
    assert.equal(rec.videoId, VIDEO_ID);
    assert.equal(rec.url, `https://youtu.be/${VIDEO_ID}`);
    assert.equal(rec.state, "scheduled");
    assert.deepEqual(rec.thumbnail, { attempted: true, ok: true, error: null });
    assert.equal(rec.requested.publishAt, PUBLISH_AT);

    const recordPath = join(dir, YOUTUBE_PUBLISHED_FILE);
    assert.ok(existsSync(recordPath));
    const onDisk = readFileSync(recordPath, "utf8");
    assert.equal(JSON.parse(onDisk).videoId, VIDEO_ID);
    assertNoSecrets(onDisk);
    assertNoSecrets(logs.join("\n"));
  });

  it("sem capa no disco não chama thumbnails.set", async () => {
    const plan = buildPlan(dir, { thumb: false });
    const { deps, calls } = mockDeps(happyRoutes());
    const { outcome } = await run(deps, plan);
    assert.equal(outcome.exitCode, 0);
    assert.equal(calls.some((c) => c.url.includes("thumbnails")), false);
    assert.deepEqual(outcome.record!.thumbnail, { attempted: false, ok: false, error: null });
  });
});

describe("upload real — falhas", () => {
  it("4xx no insert: exit 1, nenhum byte enviado, nada gravado, mensagem acionável", async () => {
    const plan = buildPlan(dir);
    const { deps, calls } = mockDeps(
      happyRoutes({
        insert: (c) =>
          c.url.includes("uploadType=resumable")
            ? json(403, { error: { errors: [{ reason: "quotaExceeded" }], message: "quota" } })
            : undefined,
      }),
    );
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.record, null);
    assert.equal(calls.some((c) => c.method === "PUT"), false);
    assert.equal(existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)), false);
    assert.match(logs.join("\n"), /quota diária/);
    assert.match(logs.join("\n"), /etapa insert/);
    assert.doesNotMatch(logs.join("\n"), /\n\s+at /); // sem stack trace
    assertNoSecrets(logs.join("\n"));
  });

  it("falha só na capa: vídeo segue enviado (exit 0), registro marca thumbnail.ok=false + aviso", async () => {
    const plan = buildPlan(dir);
    const { deps } = mockDeps(
      happyRoutes({ thumb: (c) => (c.url.includes("thumbnails/set") ? json(403, { error: { errors: [{ reason: "forbidden" }] } }) : undefined) }),
    );
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.record!.videoId, VIDEO_ID);
    assert.equal(outcome.record!.thumbnail.attempted, true);
    assert.equal(outcome.record!.thumbnail.ok, false);
    assert.match(outcome.record!.thumbnail.error ?? "", /verificado/);
    assert.ok(logs.some((l) => /^\[aviso\] vídeo enviado, mas a capa falhou/.test(l)));
    assert.equal(JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8")).thumbnail.ok, false);
  });

  it("refresh token expirado (invalid_grant): orienta refazer o OAuth, nada enviado", async () => {
    const plan = buildPlan(dir);
    const { deps, calls } = mockDeps(
      happyRoutes({ token: (c) => (c.url.includes("oauth2") ? json(400, { error: "invalid_grant" }) : undefined) }),
    );
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 1);
    assert.equal(calls.length, 1);
    assert.match(logs.join("\n"), /youtube-oauth-setup\.ts/);
  });

  it("token de outro canal: aborta antes do insert", async () => {
    const plan = buildPlan(dir);
    const { deps, calls } = mockDeps(
      happyRoutes({ channel: (c) => (c.url.includes("/channels") ? json(200, { items: [{ id: "UCoutro" }] }) : undefined) }),
    );
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 1);
    assert.equal(calls.some((c) => c.url.includes("/upload/")), false);
    assert.match(logs.join("\n"), /não é do canal esperado/);
  });

  it("credencial ausente: exit 1 sem nenhuma chamada de rede, só nomes das variáveis", async () => {
    const plan = buildPlan(dir);
    const { deps, calls } = mockDeps(happyRoutes());
    const { outcome, logs } = await run(deps, plan, { env: { GOOGLE_CLIENT_ID: "x" } });
    assert.equal(outcome.exitCode, 1);
    assert.equal(calls.length, 0);
    assert.match(logs.join("\n"), /GOOGLE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, YOUTUBE_CHANNEL_ID/);
    assert.deepEqual(missingYouTubeCredentials({ ...SECRETS, YOUTUBE_CHANNEL_ID: "  " }), ["YOUTUBE_CHANNEL_ID"]);
  });

  it("vídeo ausente: exit 1 sem chamar a API", async () => {
    const plan = buildPlan(dir, { video: false });
    const { deps, calls } = mockDeps(happyRoutes());
    const { outcome } = await run(deps, plan);
    assert.equal(outcome.exitCode, 1);
    assert.equal(calls.length, 0);
  });
});

describe("releitura do estado (#573)", () => {
  it("sem auditoria o YouTube trava em private sem publishAt → 'draft', nunca 'published'", async () => {
    const plan = buildPlan(dir);
    const { deps } = mockDeps(
      happyRoutes({
        reread: (c) =>
          c.url.includes("/videos?part=status")
            ? json(200, { items: [{ id: VIDEO_ID, status: { uploadStatus: "uploaded", privacyStatus: "private" } }] })
            : undefined,
      }),
    );
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.record!.state, "draft");
    assert.equal(outcome.record!.audit_blocked, true);
    assert.match(logs.join("\n"), /auditoria do YouTube API Services/);
  });

  it("releitura falhando vira 'unknown' + aviso, sem desfazer o registro", async () => {
    const plan = buildPlan(dir);
    const { deps } = mockDeps(happyRoutes({ reread: (c) => (c.url.includes("/videos?part=status") ? json(500, { error: "x" }) : undefined) }));
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.record!.state, "unknown");
    assert.match(outcome.record!.rereadError ?? "", /500/);
    assert.ok(logs.some((l) => /^\[aviso\] releitura/.test(l)));
  });

  it("o estado relatado é o RELIDO, não o que o PUT devolveu", async () => {
    const plan = buildPlan(dir);
    const { deps } = mockDeps(
      happyRoutes({
        reread: (c) =>
          c.url.includes("/videos?part=status")
            ? json(200, { items: [{ id: VIDEO_ID, status: { uploadStatus: "rejected", privacyStatus: "private", publishAt: PUBLISH_AT } }] })
            : undefined,
      }),
    );
    const { outcome } = await run(deps, plan);
    assert.equal(outcome.record!.state, "unknown");
  });

  for (const [uploadStatus, reasonField, reason] of [
    ["rejected", "rejectionReason", "duplicate"],
    ["failed", "failureReason", "codec"],
    ["deleted", null, null],
  ] as const) {
    it(`releitura com uploadStatus=${uploadStatus}: [erro] com status e motivo, exit 1, registro mantido`, async () => {
      const plan = buildPlan(dir);
      const status: Record<string, string> = { uploadStatus, privacyStatus: "private" };
      if (reasonField) status[reasonField] = reason!;
      const { deps } = mockDeps(
        happyRoutes({
          reread: (c) => (c.url.includes("/videos?part=status") ? json(200, { items: [{ id: VIDEO_ID, status }] }) : undefined),
        }),
      );
      const { outcome, logs } = await run(deps, plan);
      assert.equal(outcome.exitCode, 1);
      const err = logs.find((l) => l.startsWith("[erro]")) ?? "";
      assert.match(err, new RegExp(`uploadStatus=${uploadStatus}`));
      if (reason) assert.match(err, new RegExp(reason));
      assert.equal(logs.some((l) => l.startsWith("[ok]")), false);
      assert.equal(JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8")).videoId, VIDEO_ID);
    });
  }

  it("com audit_blocked, 'scheduled' avisa que o agendamento pode não tornar público", () => {
    assert.match(describeYouTubeState("scheduled", { auditBlocked: true }), /pode não tornar o vídeo público/);
    assert.doesNotMatch(describeYouTubeState("scheduled"), /pode não/);
  });
});

describe("estado incerto a partir do PUT (vídeo PODE existir)", () => {
  const cases: Array<[string, Route]> = [
    ["PUT 5xx", (c) => (c.method === "PUT" ? json(503, { error: "backend" }) : undefined)],
    [
      "PUT lança (rede caindo)",
      (c) => {
        if (c.method === "PUT") throw new Error("socket hang up");
        return undefined;
      },
    ],
    ["PUT 2xx sem id", (c) => (c.method === "PUT" ? json(200, {}) : undefined)],
    ["PUT 2xx corpo não-JSON", (c) => (c.method === "PUT" ? new Response("<html>ok</html>", { status: 200 }) : undefined)],
  ];
  for (const [name, put] of cases) {
    it(`${name}: exit 1, mensagem de estado incerto, marcador gravado, 2º --upload recusa sem --force`, async () => {
      const plan = buildPlan(dir);
      let markerDuringPut: unknown = null;
      const { deps } = mockDeps(
        happyRoutes({
          put: (c) => {
            if (c.method === "PUT") markerDuringPut = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
            return put(c);
          },
        }),
      );
      const { outcome, logs } = await run(deps, plan);
      const text = logs.join("\n");
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.record, null);
      assert.match(text, /PODE ter sido criado/);
      assert.match(text, /confira o canal antes de rodar de novo/);
      assert.doesNotMatch(text, /Nada foi publicado/);
      assertNoSecrets(text);
      // Marcador `in_progress` existia ANTES do PUT.
      assert.equal((markerDuringPut as { status?: string } | null)?.status, "in_progress");
      const onDisk = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
      assert.equal(onDisk.status, "upload_indeterminado");
      assert.equal(onDisk.aammdd, "261022");
      assert.equal(onDisk.step, "upload");
      assert.ok(onDisk.at);

      const again = mockDeps(happyRoutes());
      const second = await run(again.deps, plan);
      assert.equal(second.outcome.exitCode, 1);
      assert.equal(again.calls.length, 0);
      assert.match(second.logs.join("\n"), /estado incerto/);

      const forced = mockDeps(happyRoutes());
      const third = await run(forced.deps, plan, { force: true });
      assert.equal(third.outcome.exitCode, 0);
      assert.equal(third.outcome.record!.previous_uploads?.length, 1);
      assert.equal((third.outcome.record!.previous_uploads![0] as { status?: string }).status, "upload_indeterminado");
    });
  }

  it("falha antes dos bytes (insert) não grava marcador e diz 'Nada foi publicado'", async () => {
    const plan = buildPlan(dir);
    const { deps } = mockDeps(happyRoutes({ insert: (c) => (c.url.includes("uploadType=resumable") ? json(500, {}) : undefined) }));
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 1);
    assert.match(logs.join("\n"), /Nada foi publicado/);
    assert.equal(existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)), false);
  });

  it("rede caindo no channels.list / no início do insert: YouTubeUploadError com a etapa", async () => {
    const plan = buildPlan(dir);
    const boom: Route = () => {
      throw new Error("ECONNRESET");
    };
    const ch = mockDeps(happyRoutes({ channel: (c) => (c.url.includes("/channels") ? boom(c) : undefined) }));
    const r1 = await run(ch.deps, plan);
    assert.equal(r1.outcome.exitCode, 1);
    assert.match(r1.logs.join("\n"), /etapa channel/);
    assert.match(r1.logs.join("\n"), /Nada foi publicado/);

    const ins = mockDeps(happyRoutes({ insert: (c) => (c.url.includes("uploadType=resumable") ? boom(c) : undefined) }));
    const r2 = await run(ins.deps, plan);
    assert.match(r2.logs.join("\n"), /etapa insert/);
    assert.match(r2.logs.join("\n"), /Nada foi publicado/);
  });
});

describe("idempotência do registro", () => {
  it("registro existente da mesma edição: pula sem rede; --force sobe de novo", async () => {
    const plan = buildPlan(dir);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, YOUTUBE_PUBLISHED_FILE),
      JSON.stringify({ aammdd: "261022", videoId: "old1", url: "https://youtu.be/old1", state: "scheduled", rereadAt: "2026-10-21T22:00:00Z" }),
    );
    const first = mockDeps(happyRoutes());
    const skip = await run(first.deps, plan);
    assert.equal(skip.outcome.exitCode, 0);
    assert.equal(skip.outcome.skipped, true);
    assert.equal(first.calls.length, 0);

    const second = mockDeps(happyRoutes());
    const forced = await run(second.deps, plan, { force: true });
    assert.equal(forced.outcome.exitCode, 0);
    assert.equal(forced.outcome.record!.videoId, VIDEO_ID);
    // --force preserva o registro substituído em previous_uploads.
    const onDisk = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
    assert.deepEqual(onDisk.previous_uploads.map((p: { videoId: string }) => p.videoId), ["old1"]);

    // Um 2º --force empilha o histórico (mais antigo primeiro), sem aninhar.
    const third = mockDeps(happyRoutes());
    await run(third.deps, plan, { force: true });
    const after = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
    assert.deepEqual(after.previous_uploads.map((p: { videoId: string }) => p.videoId), ["old1", VIDEO_ID]);
    assert.equal(after.previous_uploads[1].previous_uploads, undefined);
  });

  for (const [name, content] of [
    ["de outra edição", JSON.stringify({ aammdd: "261021", videoId: "x1", url: "https://youtu.be/x1" })],
    ["sem videoId", JSON.stringify({ aammdd: "261022", url: "https://youtu.be/x1" })],
    ["null", "null"],
    ["{}", "{}"],
  ] as const) {
    it(`registro JSON válido mas ${name}: recusa como ilegível, sem rede`, async () => {
      const plan = buildPlan(dir);
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), content);
      const { deps, calls } = mockDeps(happyRoutes());
      const { outcome, logs } = await run(deps, plan);
      assert.equal(outcome.exitCode, 1);
      assert.equal(calls.length, 0);
      assert.match(logs.join("\n"), /ilegível/);
      assert.match(logs.join("\n"), /Nada foi enviado/);
    });
  }

  it("falha ao gravar o registro depois do upload ok: exit 1, record no outcome, [erro] mandando NÃO repetir", async () => {
    const plan = buildPlan(dir);
    const internal = join(dir, "_internal");
    const { deps } = mockDeps(
      happyRoutes({
        put: (c) => {
          if (c.method !== "PUT") return undefined;
          // O marcador in_progress já foi gravado; troca `_internal` por um ARQUIVO pra a gravação final falhar.
          rmSync(internal, { recursive: true, force: true });
          writeFileSync(internal, "não sou diretório");
          return json(200, { id: VIDEO_ID, status: { uploadStatus: "uploaded", privacyStatus: "private" } });
        },
      }),
    );
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.record!.videoId, VIDEO_ID);
    assert.ok(logs.some((l) => /^\[erro\] vídeo ENVIADO .*NÃO rode --upload de novo/.test(l)));
  });

  it("registro corrompido: recusa (não dá pra saber se já subiu)", async () => {
    const plan = buildPlan(dir);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "{ não é json");
    const { deps, calls } = mockDeps(happyRoutes());
    const { outcome, logs } = await run(deps, plan);
    assert.equal(outcome.exitCode, 1);
    assert.equal(calls.length, 0);
    assert.match(logs.join("\n"), /ilegível/);
  });
});

describe("CLI --upload", () => {
  const ROOT = join(import.meta.dirname, "..");
  const script = join(ROOT, "scripts", "publish-youtube.ts");
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, "261022", "--edition-dir", dir, ...args], { encoding: "utf8", cwd: ROOT });

  it("--dry-run e --upload juntos: exit 2", () => {
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD);
    const r = cli(["--dry-run", "--upload"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /exclusivos/);
  });

  it("--upload sem vídeo no disco: exit 1 antes de qualquer envio, sem stack trace", () => {
    // Sem vídeo o CLI para antes da rede, com ou sem credencial no ambiente da máquina.
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD);
    const r = cli(["--upload"]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /Nada foi enviado|nada foi enviado/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });
});

describe("miolo da lib", () => {
  it("uploadYouTubeVideo lança YouTubeUploadError com a etapa quando o PUT não devolve id", async () => {
    const plan = buildPlan(dir);
    const { deps } = mockDeps(happyRoutes({ put: (c) => (c.method === "PUT" ? json(200, {}) : undefined) }));
    await assert.rejects(
      uploadYouTubeVideo(deps, {
        creds: { clientId: "a", clientSecret: "b", refreshToken: "c", channelId: SECRETS.YOUTUBE_CHANNEL_ID },
        request: plan.request,
        video: Buffer.from("x"),
        thumbnail: null,
      }),
      (e: unknown) => e instanceof YouTubeUploadError && e.step === "upload" && /id do vídeo/.test(e.message),
    );
  });

  it("explainYouTubeUploadError cobre os motivos acionáveis", () => {
    assert.match(explainYouTubeUploadError(401, ""), /401/);
    assert.match(explainYouTubeUploadError(403, '{"reason":"uploadLimitExceeded"}'), /limite de uploads/);
    assert.match(explainYouTubeUploadError(403, "insufficientPermissions"), /youtube\.upload/);
    assert.match(explainYouTubeUploadError(418, "x"), /418/);
  });

  it("invalid_client/unauthorized_client aponta divergência do client no ambiente (#8237), sem mandar refazer consentimento", () => {
    for (const body of ['{"error":"invalid_client"}', '{"error":"unauthorized_client"}']) {
      const m = explainYouTubeUploadError(401, body, "token");
      assert.match(m, /GOOGLE_CLIENT_ID/);
      assert.match(m, /#8237/);
      assert.doesNotMatch(m, /refaça o consentimento/);
    }
  });

  it("403 forbidden só cita capa customizada na etapa thumbnail", () => {
    const body = '{"error":{"errors":[{"reason":"forbidden"}]}}';
    assert.match(explainYouTubeUploadError(403, body, "thumbnail"), /capa customizada/);
    assert.doesNotMatch(explainYouTubeUploadError(403, body, "insert"), /capa/);
    assert.match(explainYouTubeUploadError(403, body, "insert"), /etapa insert/);
    assert.doesNotMatch(explainYouTubeUploadError(403, body), /capa/);
  });

  it("quota: balde próprio do videos.insert (100 chamadas/dia), não os 1.600 antigos", () => {
    const m = explainYouTubeUploadError(403, "quotaExceeded");
    assert.match(m, /100 chamadas\/dia/);
    assert.doesNotMatch(m, /1\.600/);
  });

  it("channelId vazio na lib: lança na etapa channel sem chamar channels.list", async () => {
    const plan = buildPlan(dir);
    const { deps, calls } = mockDeps(happyRoutes());
    await assert.rejects(
      uploadYouTubeVideo(deps, {
        creds: { clientId: "a", clientSecret: "b", refreshToken: "c", channelId: "  " },
        request: plan.request,
        video: Buffer.from("x"),
        thumbnail: null,
      }),
      (e: unknown) => e instanceof YouTubeUploadError && e.step === "channel",
    );
    assert.equal(calls.some((c) => c.url.includes("/channels")), false);
  });

  it("corpo não-JSON em token/channel/releitura diz 'corpo não-JSON'", async () => {
    const plan = buildPlan(dir);
    const html = () => new Response("<html>proxy</html>", { status: 200 });
    const creds = { clientId: "a", clientSecret: "b", refreshToken: "c", channelId: SECRETS.YOUTUBE_CHANNEL_ID };
    const input = { creds, request: plan.request, video: Buffer.from("x"), thumbnail: null };

    const tok = mockDeps(happyRoutes({ token: (c) => (c.url.includes("oauth2") ? html() : undefined) }));
    await assert.rejects(uploadYouTubeVideo(tok.deps, input), (e: unknown) => e instanceof YouTubeUploadError && e.step === "token" && /não-JSON/.test(e.message));

    const ch = mockDeps(happyRoutes({ channel: (c) => (c.url.includes("/channels") ? html() : undefined) }));
    await assert.rejects(
      uploadYouTubeVideo(ch.deps, input),
      (e: unknown) => e instanceof YouTubeUploadError && e.step === "channel" && /não-JSON/.test(e.message) && !/nenhum canal/.test(e.message),
    );

    const rr = mockDeps(happyRoutes({ reread: (c) => (c.url.includes("/videos?part=status") ? html() : undefined) }));
    const res = await uploadYouTubeVideo(rr.deps, input);
    assert.match(res.rereadError ?? "", /não-JSON/);
    assert.doesNotMatch(res.rereadError ?? "", /indexado/);
  });

  it("bytes enviados no PUT e na capa são exatamente os do arquivo (inclusive Buffer com byteOffset≠0)", async () => {
    const plan = buildPlan(dir);
    const videoBytes = Buffer.from("conteudo-do-video-mp4");
    const thumbBytes = Buffer.from("jpeg-da-capa");
    // Fatias de um Buffer maior: byteOffset≠0, o caso em que `buf.buffer` inteiro vazaria.
    const video = Buffer.concat([Buffer.from("LIXO-ANTES"), videoBytes, Buffer.from("LIXO-DEPOIS")]).subarray(10, 10 + videoBytes.length);
    const thumb = Buffer.concat([Buffer.from("XX"), thumbBytes]).subarray(2);
    assert.notEqual(video.byteOffset, 0);
    assert.notEqual(thumb.byteOffset, 0);
    const { deps, calls } = mockDeps(happyRoutes());
    await uploadYouTubeVideo(deps, {
      creds: { clientId: "a", clientSecret: "b", refreshToken: "c", channelId: SECRETS.YOUTUBE_CHANNEL_ID },
      request: plan.request,
      video,
      thumbnail: thumb,
    });
    const put = calls.find((c) => c.method === "PUT")!;
    assert.ok(Buffer.from(put.body as Uint8Array).equals(videoBytes));
    assert.equal(put.headers["Content-Type"], "video/mp4");
    assert.equal(put.headers["Content-Length"], String(videoBytes.length));
    const th = calls.find((c) => c.url.includes("thumbnails/set"))!;
    assert.ok(Buffer.from(th.body as Uint8Array).equals(thumbBytes));
    assert.equal(th.headers["Content-Type"], "image/jpeg");
    assert.equal(th.headers["Content-Length"], String(thumbBytes.length));
  });

  it("aviso de vídeo ausente: 'fail-soft' só no dry-run; no --upload reflete o exit 1", () => {
    const base = { aammdd: "261022", reviewedMd: REVIEWED_MD, now: NOW, episode: 2, editionUrl: "https://diar.ia.br/p/x",
      video: { path: "/nao/existe.mp4", exists: false, sizeBytes: null }, thumb: { path: "/t.jpg", exists: true } };
    assert.ok(planYouTubePublish(base).warnings.some((w) => /fail-soft/.test(w)));
    const up = planYouTubePublish({ ...base, mode: "upload" }).warnings.find((w) => /vídeo ausente/.test(w)) ?? "";
    assert.match(up, /exit 1/);
    assert.doesNotMatch(up, /fail-soft/);
  });
});
