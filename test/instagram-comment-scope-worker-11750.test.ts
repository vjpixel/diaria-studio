/**
 * test/instagram-comment-scope-worker-11750.test.ts (#11750)
 *
 * Follow-up do #11731. Três pontas soltas:
 *  1. No `--schedule` quem comenta é o Worker, com o PRÓPRIO token — a decisão
 *     "comentário sim/não" passa a vir do Worker (`GET /instagram/comment-scope`),
 *     não do token do `.env`.
 *  2. O preview do Stage 4 mostrava "Link da edição no primeiro comentário."
 *     mesmo quando o publish ia sair com a linha da bio. Agora lê o registro
 *     `_internal/instagram-comment-scope.json` (sem rede); sem registro, bio.
 *  3. Com legenda de TESTE (`_internal/instagram-test.json`), o `first_comment`
 *     continuava indo — agora não há comentário nesse caso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTAGRAM_CTA_LINE,
  INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE,
} from "../scripts/lib/social-cta-lines.ts";
import { toSocialPostText } from "../scripts/lib/social-post-text.ts";
import { buildUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";
import type { UseMelhorReadyPlan } from "../scripts/lib/use-melhor-dispatch.ts";
import {
  INSTAGRAM_COMMENT_SCOPE_FILE,
  parseWorkerCommentScope,
  probeWorkerInstagramCommentScope,
  readInstagramCommentScopeGranted,
  resolveInstagramWorkerUrl,
  writeInstagramCommentScopeRecord,
  type InstagramCommentScopeProbe,
} from "../scripts/lib/instagram-comment-scope.ts";
import {
  buildUseMelhorInstagramPost,
  gateEditionUrlOnCommentScope,
  resolveUseMelhorCommentEditionUrl,
} from "../scripts/publish-instagram.ts";
import {
  groupByDestaque,
  parsePlatforms,
  publishAdditionsFor,
  PREVIEW_EDITION_URL_PLACEHOLDER,
  type GroupedBlock,
} from "../scripts/render-social-html.ts";
import { probeCommentScope } from "../scripts/probe-instagram-comment-scope.ts";

const WORKER_URL = "https://diaria-linkedin-cron.test/";
const WORKER_TOKEN = "worker-queue-secret-11750";
const EDITION_URL = "https://diar.ia.br/p/um-titulo";

function jsonFetch(body: string, status = 200, calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
}

function tmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "ig-scope-11750-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("#11750 — sonda no Worker (cliente)", () => {
  it("pergunta GET /instagram/comment-scope com o X-Diaria-Token, sem barra dupla", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const r = await probeWorkerInstagramCommentScope(WORKER_URL, WORKER_TOKEN, jsonFetch('{"ok":true,"granted":true}', 200, calls));
    assert.deepEqual(r, { ok: true, granted: true });
    assert.equal(calls[0].url, "https://diaria-linkedin-cron.test/instagram/comment-scope");
    assert.equal(calls[0].init?.method, "GET");
    assert.equal((calls[0].init?.headers as Record<string, string>)["X-Diaria-Token"], WORKER_TOKEN);
  });

  it("Worker antigo (404), 401, não-JSON, rede caída → ok: false sem vazar o token", async () => {
    const cases: typeof fetch[] = [
      jsonFetch('{"error":"not found"}', 404),
      jsonFetch('{"error":"unauthorized"}', 401),
      jsonFetch("<html>", 200),
      (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    ];
    for (const f of cases) {
      const r = await probeWorkerInstagramCommentScope(WORKER_URL, WORKER_TOKEN, f);
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(!r.reason.includes(WORKER_TOKEN), r.reason);
    }
  });

  it("parseWorkerCommentScope: só { ok: true, granted: boolean } vale; o resto é fail-closed", () => {
    assert.deepEqual(parseWorkerCommentScope({ ok: true, granted: false }), { ok: true, granted: false });
    assert.deepEqual(parseWorkerCommentScope({ ok: false, reason: "token expirado" }), { ok: false, reason: "worker: token expirado" });
    for (const bad of [null, "x", {}, { ok: true }, { ok: true, granted: "true" }, { granted: true }]) {
      assert.equal(parseWorkerCommentScope(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("resolveInstagramWorkerUrl: env > config instagram > config linkedin", () => {
    const cfg = {
      publishing: { social: { instagram: { cloudflare_worker_url: "https://ig" }, linkedin: { cloudflare_worker_url: "https://li" } } },
    };
    assert.equal(resolveInstagramWorkerUrl(cfg, { DIARIA_LINKEDIN_CRON_URL: "https://env" }), "https://env");
    assert.equal(resolveInstagramWorkerUrl(cfg, {}), "https://ig");
    assert.equal(resolveInstagramWorkerUrl({ publishing: { social: { linkedin: { cloudflare_worker_url: "https://li" } } } }, {}), "https://li");
    assert.equal(resolveInstagramWorkerUrl(null, {}), "");
  });
});

describe("#11750 — publish decide pela fonte certa", () => {
  const granted: InstagramCommentScopeProbe = { ok: true, granted: true };
  const denied: InstagramCommentScopeProbe = { ok: true, granted: false };

  function run(opts: { schedule: boolean; testOverride?: boolean; worker: InstagramCommentScopeProbe; local: InstagramCommentScopeProbe }) {
    const called: string[] = [];
    const written: Array<{ source: string; probe: InstagramCommentScopeProbe }> = [];
    return resolveUseMelhorCommentEditionUrl({
      editionDir: "x",
      schedule: opts.schedule,
      hasTestCaptionOverride: opts.testOverride ?? false,
      readEditionUrl: () => EDITION_URL,
      probeWorker: async () => {
        called.push("worker");
        return opts.worker;
      },
      probeLocal: async () => {
        called.push("local");
        return opts.local;
      },
      writeRecord: (_dir, probe, source) => {
        written.push({ source, probe });
        return { granted: probe.ok && probe.granted, source, checked_at: "t" };
      },
    }).then((r) => ({ ...r, called, written }));
  }

  it("--schedule: token do Worker SEM escopo e .env COM escopo → linha da bio (antes prometia o comentário)", async () => {
    const r = await run({ schedule: true, worker: denied, local: granted });
    assert.equal(r.editionUrl, null);
    assert.deepEqual(r.called, ["worker"], "não consulta o .env no --schedule");
    assert.match(r.warning ?? "", /token do Worker/);
    assert.deepEqual(r.written.map((w) => w.source), ["worker"]);
  });

  it("--schedule: token do Worker COM escopo e .env SEM escopo → comentário (antes desligava à toa)", async () => {
    const r = await run({ schedule: true, worker: granted, local: denied });
    assert.equal(r.editionUrl, EDITION_URL);
    assert.equal(r.warning, null);
  });

  it("publicação imediata: decide pelo token do .env", async () => {
    const r = await run({ schedule: false, worker: granted, local: denied });
    assert.equal(r.editionUrl, null);
    assert.deepEqual(r.called, ["local"]);
    assert.match(r.warning ?? "", /token do \.env/);
  });

  it("legenda de TESTE: sem permalink, sem comentário, sem sonda", async () => {
    const r = await run({ schedule: true, testOverride: true, worker: granted, local: granted });
    assert.equal(r.editionUrl, null);
    assert.deepEqual(r.called, []);
    assert.deepEqual(r.written, []);
  });

  it("legenda de teste → buildUseMelhorInstagramPost sai com firstComment null (first_comment não vai ao Worker)", async () => {
    const r = await run({ schedule: true, testOverride: true, worker: granted, local: granted });
    const TITLE = "Seis usos";
    const UM = "1) **Um** a.\n\n2) **Dois** b.\n\n#IA";
    const MD = ["# Social", "", "## um", "", UM, ""].join("\n");
    const slots = buildUseMelhorSlides(UM, TITLE).map((s) => s.slot);
    const plan: UseMelhorReadyPlan = {
      status: "ready",
      time: "07:45",
      item: { url: "https://example.com/guia", title: TITLE, summary: "S", score: 80 },
      slots,
      captionTitle: TITLE,
    };
    const images: Record<string, { url?: string }> = {};
    for (const s of slots) images[useMelhorSlideImageKey(s)] = { url: `https://cdn/um-${s}.jpg` };
    const post = buildUseMelhorInstagramPost({ socialMd: MD, plan, images, editionDir: "x", editionUrl: r.editionUrl, fileExists: () => true });
    assert.ok(post.ok);
    if (post.ok) assert.equal(post.firstComment, null);
  });

  it("gate sem permalink não sonda nem avisa", async () => {
    let probed = false;
    const r = await resolveUseMelhorCommentEditionUrl({
      editionDir: "x",
      schedule: true,
      hasTestCaptionOverride: false,
      readEditionUrl: () => null,
      probeWorker: async () => {
        probed = true;
        return granted;
      },
      probeLocal: async () => granted,
      writeRecord: () => {
        throw new Error("não deveria gravar");
      },
    });
    assert.deepEqual(r, { editionUrl: null, warning: null });
    assert.equal(probed, false);
  });

  it("gateEditionUrlOnCommentScope mantém o default local (compat #11731)", () => {
    assert.match(gateEditionUrlOnCommentScope(EDITION_URL, denied).warning ?? "", /token do \.env/);
  });
});

describe("#11750 — registro de escopo para o preview", () => {
  it("ausente, ilegível ou granted != true → false; granted true → true", () => {
    const dir = tmpEdition();
    assert.equal(readInstagramCommentScopeGranted(dir), false, "sem registro");
    writeFileSync(join(dir, INSTAGRAM_COMMENT_SCOPE_FILE), "{quebrado");
    assert.equal(readInstagramCommentScopeGranted(dir), false, "JSON inválido");
    writeFileSync(join(dir, INSTAGRAM_COMMENT_SCOPE_FILE), JSON.stringify({ granted: "true" }));
    assert.equal(readInstagramCommentScopeGranted(dir), false, "string não conta");
    writeInstagramCommentScopeRecord(dir, { ok: true, granted: true }, "worker", new Date("2026-11-01T12:00:00Z"));
    assert.equal(readInstagramCommentScopeGranted(dir), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, INSTAGRAM_COMMENT_SCOPE_FILE), "utf8")), {
      granted: true,
      source: "worker",
      checked_at: "2026-11-01T12:00:00.000Z",
    });
  });

  it("sonda com falha grava granted: false com o motivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "ig-scope-11750-nointernal-"));
    const rec = writeInstagramCommentScopeRecord(dir, { ok: false, reason: "worker: HTTP 404" }, "worker");
    assert.equal(rec.granted, false);
    assert.equal(rec.reason, "worker: HTTP 404");
    assert.equal(readInstagramCommentScopeGranted(dir), false);
  });

  it("CLI do Stage 4: sem Worker configurado ou sem token local → ok: false, sem rede", async () => {
    const noNet = (async () => {
      throw new Error("não deveria chamar a rede");
    }) as typeof fetch;
    const w = await probeCommentScope("worker", { platformConfig: null, env: {}, fetchImpl: noNet });
    assert.equal(w.ok, false);
    const l = await probeCommentScope("local", { platformConfig: null, env: {}, fetchImpl: noNet });
    assert.equal(l.ok, false);
    const ok = await probeCommentScope("worker", {
      platformConfig: null,
      env: { DIARIA_LINKEDIN_CRON_URL: WORKER_URL, DIARIA_LINKEDIN_CRON_TOKEN: WORKER_TOKEN },
      fetchImpl: jsonFetch('{"ok":true,"granted":true}'),
    });
    assert.deepEqual(ok, { ok: true, granted: true });
  });
});

describe("#11750 — preview do Stage 4 alinhado ao publish", () => {
  const TITLE = "Seis usos do assistente no trabalho";
  const UM = [
    "1) **Peça o primeiro rascunho** de e-mails.\n2) **Resuma documentos longos** pedindo os pontos.",
    "3) **Prepare reuniões** pedindo a pauta.",
    "#Produtividade #IA",
  ].join("\n\n");
  const MD = ["# Social", "", "## d1", "", "Texto.", "", "#Tag", "", "## um", "", UM, ""].join("\n");
  const slots = buildUseMelhorSlides(UM, TITLE).map((s) => s.slot);
  const plan: UseMelhorReadyPlan = {
    status: "ready",
    time: "07:45",
    item: { url: "https://example.com/guia", title: TITLE, summary: "S", score: 80 },
    slots,
    captionTitle: TITLE,
  };
  const images: Record<string, { url?: string }> = {};
  for (const s of slots) images[useMelhorSlideImageKey(s)] = { url: `https://cdn/um-${s}.jpg` };

  function igBlock(scope: boolean | undefined): GroupedBlock {
    const g = groupByDestaque(parsePlatforms(MD), {}, "1", TITLE, scope === undefined ? undefined : { instagramCommentScope: scope }).find(
      (x) => x.key === "um",
    );
    const b = g?.blocks.find((x) => x.channels.includes("Instagram"));
    assert.ok(b);
    return b;
  }
  function igLines(b: GroupedBlock): string[] {
    return b.publishAdditions?.find((a) => a.channel.includes("Instagram"))?.lines ?? [];
  }

  it("sem registro de escopo (default): linha da bio, NÃO a do comentário", () => {
    for (const scope of [undefined, false]) {
      const lines = igLines(igBlock(scope));
      assert.ok(lines.includes(INSTAGRAM_CTA_LINE), JSON.stringify(lines));
      assert.ok(!lines.includes(INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE));
    }
  });

  it("com escopo: linha do comentário — e o texto bate com o que o publish monta", () => {
    const b = igBlock(true);
    assert.ok(igLines(b).includes(INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE));
    const post = buildUseMelhorInstagramPost({
      socialMd: MD,
      plan,
      images,
      editionDir: "x",
      editionUrl: PREVIEW_EDITION_URL_PLACEHOLDER,
      fileExists: () => true,
    });
    assert.ok(post.ok);
    if (post.ok) {
      const preview = [toSocialPostText(b.post.main), ...igLines(b), b.post.hashtags].filter(Boolean).join("\n\n");
      assert.equal(preview, post.caption);
    }
  });

  it("Facebook não depende do escopo do Instagram: permalink nos dois casos", () => {
    const off = publishAdditionsFor("Social", "um", ["facebook"], { instagramCommentScope: false });
    const on = publishAdditionsFor("Social", "um", ["facebook"], { instagramCommentScope: true });
    assert.deepEqual(off, on);
    assert.ok(off[0].lines.some((l) => l.includes(PREVIEW_EDITION_URL_PLACEHOLDER)));
  });

  it("d1 não muda com o escopo", () => {
    assert.deepEqual(
      publishAdditionsFor("Social", "d1", undefined, { instagramCommentScope: true }),
      publishAdditionsFor("Social", "d1"),
    );
  });
});
