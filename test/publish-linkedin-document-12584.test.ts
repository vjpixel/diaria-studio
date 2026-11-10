/**
 * test/publish-linkedin-document-12584.test.ts (#12584)
 *
 * Documento PDF como formato padrão do LinkedIn na diária (D1/D2/D3). Cobre a
 * ordem de fallback documento → carrossel → imagem única em `dispatchEntry`,
 * o que vai no store (`format`, `document_fallback_reason`), a rota make_now
 * (Make não publica documento), o slide faltando (tudo-ou-nada), a falha
 * ambígua do Worker (propaga sem publicar por cima, #11106), o título do
 * documento e a geração/upload do PDF.
 *
 * In-process, com `globalThis.fetch` mockado (mesmo padrão de
 * `publish-linkedin-4xx-fallback.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  dispatchEntry,
  alarmLinkedInDocumentFallbacks,
  type DispatchContext,
  type DispatchInput,
  type LinkedInDocumentPlan,
} from "../scripts/publish-linkedin.ts";
import {
  isAlarmingDocumentFallback,
  linkedInDailyDocumentFallbackFingerprint,
  prepareDailyLinkedInDocument,
  resolveLinkedInDocumentTitle,
  LINKEDIN_DOCUMENT_TITLE_MAX,
} from "../scripts/lib/linkedin-daily-document.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const SLIDES = ["cover", "p1", "p2", "p3", "cta"].map((s) => `https://img.test/d1_${s}.jpg`);
const DOC = { url: "https://img.test/img-260999-linkedin-d1-carousel-abcd1234.pdf", title: "Título do D1" };

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "publish-linkedin-doc-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkCtx(dir: string, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    publishedPath: join(dir, "06-social-published.json"),
    webhookUrl: "https://hook.test/diaria",
    workerUrl: "https://worker.test",
    workerToken: "test-tok",
    useWorkerForScheduled: true,
    editionDate: "260999",
    rootDir: dir,
    ...over,
  };
}

function readyPlan(prepare: () => Promise<{ url: string; title: string }> = async () => DOC): LinkedInDocumentPlan & { calls: () => number } {
  let calls = 0;
  return {
    status: "ready",
    carouselImageUrls: SLIDES,
    prepareDocument: async () => {
      calls++;
      return prepare();
    },
    calls: () => calls,
  };
}

function mkInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    destaque: "d1",
    subtype: "main",
    text: "Post agendado",
    imageUrl: "https://img.test/d1_4x5.jpg",
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    webhookTarget: "diaria",
    action: "post",
    ...overrides,
  };
}

type Handler = (body: Record<string, unknown>) => Response;

/** Mock do fetch: `/queue` responde pela fila de handlers; o resto é o Make. */
function mockFetch(queueHandlers: Handler[]) {
  const queueBodies: Record<string, unknown>[] = [];
  let makeCalls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.includes("/queue")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      queueBodies.push(body);
      const h = queueHandlers[Math.min(queueBodies.length - 1, queueHandlers.length - 1)];
      return h(body);
    }
    makeCalls++;
    return new Response(JSON.stringify({ accepted: true, request_id: "make-req" }), { status: 200 });
  }) as typeof fetch;
  return {
    queueBodies,
    makeCalls: () => makeCalls,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

const ok = (key: string): Handler => (body) =>
  new Response(JSON.stringify({ queued: true, key, scheduled_at: body.scheduled_at, destaque: body.destaque }), { status: 200 });
const reject = (code: string): Handler => () =>
  new Response(JSON.stringify({ error: "recusado", code }), { status: 400, headers: { "Content-Type": "application/json" } });
const serverError: Handler = () => new Response("internal error", { status: 500 });

describe("#12584 dispatchEntry — documento PDF como padrão do LinkedIn", () => {
  it("caminho feliz: enfileira o documento com image_urls de fallback e grava format=document", async () => {
    const m = mockFetch([ok("q-doc")]);
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(mkInput({ linkedInDocument: readyPlan() }), mkCtx(dir));
      assert.equal(m.queueBodies.length, 1);
      const body = m.queueBodies[0];
      assert.equal(body.document_url, DOC.url);
      assert.equal(body.document_title, DOC.title);
      assert.deepEqual(body.image_urls, SLIDES, "o carrossel vai junto: fallback do próprio Worker no disparo");
      assert.equal(body.image_url, null);
      assert.equal(body.channel, "linkedin");
      assert.equal(entry.status, "scheduled");
      assert.equal(entry.format, "document");
      assert.equal(entry.document_url, DOC.url);
      assert.equal(entry.worker_queue_key, "q-doc");
      assert.equal(entry.document_fallback_reason, undefined);
      assert.equal(m.makeCalls(), 0, "documento nunca passa pelo Make");
      const stored = JSON.parse(readFileSync(join(dir, "06-social-published.json"), "utf8"));
      assert.equal(stored.posts[0].format, "document");
    } finally {
      cleanup();
      m.restore();
    }
  });

  it("falha do PDF → carrossel de imagens, com document_fallback_reason=pdf_failed:*", async () => {
    const m = mockFetch([ok("q-car")]);
    const { dir, cleanup } = tmpDir();
    try {
      const plan = readyPlan(async () => {
        throw new Error("GET https://img.test/d1_p2.jpg -> 404");
      });
      const entry = await dispatchEntry(mkInput({ linkedInDocument: plan }), mkCtx(dir));
      assert.equal(m.queueBodies.length, 1);
      assert.equal(m.queueBodies[0].document_url, undefined);
      assert.deepEqual(m.queueBodies[0].image_urls, SLIDES);
      assert.equal(entry.format, "carousel");
      assert.equal(entry.status, "scheduled");
      assert.match(String(entry.document_fallback_reason), /^pdf_failed:.*404/);
    } finally {
      cleanup();
      m.restore();
    }
  });

  it("Worker 4xx no documento E no carrossel → imagem única de sempre, motivos gravados", async () => {
    const m = mockFetch([reject("linkedin_creds_missing"), reject("linkedin_creds_missing"), ok("q-single")]);
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(mkInput({ linkedInDocument: readyPlan() }), mkCtx(dir));
      assert.equal(m.queueBodies.length, 3, "documento, carrossel, imagem única — 1 tentativa cada (4xx não retenta)");
      assert.equal(m.queueBodies[2].image_url, "https://img.test/d1_4x5.jpg");
      assert.equal(m.queueBodies[2].image_urls, undefined);
      assert.equal(m.queueBodies[2].document_url, undefined);
      assert.equal(entry.status, "scheduled");
      assert.equal(entry.format, "single_image");
      assert.equal(entry.document_fallback_reason, "document_rejected:linkedin_creds_missing");
      assert.equal(entry.carousel_fallback_reason, "carousel_rejected:linkedin_creds_missing");
      assert.equal(m.makeCalls(), 0);
    } finally {
      cleanup();
      m.restore();
    }
  });

  it("Worker 5xx no documento (ambíguo) → failed, SEM carrossel e SEM Make por cima (#11106)", async () => {
    const m = mockFetch([serverError]);
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(mkInput({ linkedInDocument: readyPlan() }), mkCtx(dir));
      assert.equal(entry.status, "failed");
      assert.ok(m.queueBodies.every((b) => b.document_url === DOC.url), "só tentativas do documento, nenhum outro formato por cima");
      assert.equal(m.makeCalls(), 0, "o fallback Make imediato do #887 não vale para o documento");
      assert.match(String(entry.reason), /falha ambígua/);
    } finally {
      cleanup();
      m.restore();
    }
  });

  it("slide faltando (plano skip) → imagem única direto, format=single_image + carousel_incomplete", async () => {
    const m = mockFetch([ok("q-single")]);
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(
        mkInput({ linkedInDocument: { status: "skip", reason: "carousel_incomplete" } }),
        mkCtx(dir),
      );
      assert.equal(m.queueBodies.length, 1);
      assert.equal(m.queueBodies[0].image_url, "https://img.test/d1_4x5.jpg");
      assert.equal(m.queueBodies[0].document_url, undefined);
      assert.equal(entry.format, "single_image");
      assert.equal(entry.document_fallback_reason, "carousel_incomplete");
    } finally {
      cleanup();
      m.restore();
    }
  });

  it("Worker ausente/rota make_now → imagem única pelo Make, PDF nem é gerado, motivo make_now_route", async () => {
    const m = mockFetch([ok("never")]);
    const { dir, cleanup } = tmpDir();
    try {
      const plan = readyPlan();
      const entry = await dispatchEntry(
        mkInput({ linkedInDocument: plan }),
        mkCtx(dir, { useWorkerForScheduled: false, workerUrl: "", workerToken: "" }),
      );
      assert.equal(plan.calls(), 0, "sem Worker não há documento: o PDF não é gerado à toa");
      assert.equal(m.queueBodies.length, 0);
      assert.equal(m.makeCalls(), 1);
      assert.equal(entry.format, "single_image");
      assert.equal(entry.document_fallback_reason, "make_now_route");
    } finally {
      cleanup();
      m.restore();
    }
  });

  it("sem plano (comments, 4º post, artigo especial) → comportamento anterior, sem campo format", async () => {
    const m = mockFetch([ok("q-plain")]);
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(mkInput(), mkCtx(dir));
      assert.equal(entry.status, "scheduled");
      assert.equal(entry.format, undefined);
      assert.equal(m.queueBodies[0].document_url, undefined);
    } finally {
      cleanup();
      m.restore();
    }
  });
});

describe("#12584 título do documento", () => {
  const REVIEWED = [
    "DESTAQUE 1 | NEGÓCIOS",
    "**OpenAI fecha acordo bilionário**",
    "https://exemplo.com/a",
    "",
    "Corpo.",
    "",
    "Por que isso importa:",
    "Porque sim.",
    "",
    "---",
    "DESTAQUE 2 | PESQUISA",
    "Modelo novo da Anthropic",
    "https://exemplo.com/b",
    "",
    "Corpo.",
  ].join("\n");

  it("usa o título escolhido do destaque em 02-reviewed.md, sem negrito", () => {
    assert.equal(resolveLinkedInDocumentTitle(REVIEWED, "d1", "260999"), "OpenAI fecha acordo bilionário");
    assert.equal(resolveLinkedInDocumentTitle(REVIEWED, "d2", "260999"), "Modelo novo da Anthropic");
  });

  it("sem arquivo ou sem o destaque → título genérico com a data, nunca vazio", () => {
    assert.equal(resolveLinkedInDocumentTitle(null, "d1", "260999"), "diar.ia.br 260999 — destaque 1");
    assert.equal(resolveLinkedInDocumentTitle(REVIEWED, "d3", "260999"), "diar.ia.br 260999 — destaque 3");
  });

  it("corta no teto do Worker (MAX_DOCUMENT_TITLE_LENGTH) e o teto bate com o fonte do Worker", () => {
    const long = `DESTAQUE 1 | X\n${"a".repeat(500)}\nhttps://x.com/a\n\nCorpo.`;
    const t = resolveLinkedInDocumentTitle(long, "d1", "260999");
    assert.ok(t.length <= LINKEDIN_DOCUMENT_TITLE_MAX);
    const src = readFileSync(resolve(import.meta.dirname, "..", "workers", "linkedin-cron", "src", "index.ts"), "utf8");
    const mm = src.match(/export const MAX_DOCUMENT_TITLE_LENGTH\s*=\s*(\d+)\s*;/);
    assert.ok(mm, "MAX_DOCUMENT_TITLE_LENGTH não encontrado no Worker — atualize este teste junto");
    assert.equal(Number(mm[1]), LINKEDIN_DOCUMENT_TITLE_MAX);
  });
});

describe("#12584 prepareDailyLinkedInDocument", () => {
  it("grava o PDF em _internal, sobe com chave img-{AAMMDD}-linkedin-{d}-carousel-{md5}.pdf", async () => {
    const root = mkdtempSync(join(tmpdir(), "li-doc-prep-"));
    const editionDir = join(root, "260999");
    mkdirSync(editionDir);
    try {
      let seenKey = "";
      let seenPath = "";
      const doc = await prepareDailyLinkedInDocument({
        editionDir,
        destaque: "d2",
        carouselImageUrls: SLIDES,
        title: "T",
        buildPdf: async (urls) => {
          assert.deepEqual(urls, SLIDES);
          return new TextEncoder().encode("%PDF-fake");
        },
        upload: async (p, k) => {
          seenPath = p;
          seenKey = k;
          return `https://img.test/img/${k}`;
        },
      });
      assert.match(seenKey, /^img-260999-linkedin-d2-carousel-[0-9a-f]{8}\.pdf$/);
      assert.ok(existsSync(seenPath) && seenPath.endsWith(join("_internal", "06-linkedin-d2-carousel.pdf")));
      assert.deepEqual(doc, { url: `https://img.test/img/${seenKey}`, title: "T" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("URL não-https do upload é recusada (o Worker baixa o PDF no disparo)", async () => {
    const root = mkdtempSync(join(tmpdir(), "li-doc-prep-"));
    try {
      await assert.rejects(
        () =>
          prepareDailyLinkedInDocument({
            editionDir: join(root, "260999"),
            destaque: "d1",
            carouselImageUrls: SLIDES,
            title: "T",
            buildPdf: async () => new Uint8Array([1]),
            upload: async () => "http://inseguro/x.pdf",
          }),
        /não é https/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#12584 alarme do fallback do documento", () => {
  it("fingerprint pelo código do motivo e só pdf_failed/document_rejected alarmam", () => {
    assert.equal(linkedInDailyDocumentFallbackFingerprint("pdf_failed:GET x -> 404"), "linkedin-daily-document-fallback:pdf_failed");
    assert.equal(
      linkedInDailyDocumentFallbackFingerprint("document_rejected:linkedin_creds_missing"),
      "linkedin-daily-document-fallback:document_rejected:linkedin_creds_missing",
    );
    assert.ok(isAlarmingDocumentFallback("pdf_failed:x"));
    assert.ok(isAlarmingDocumentFallback("document_rejected:400"));
    for (const r of ["carousel_incomplete", "opt_out", "make_now_route", undefined]) assert.ok(!isAlarmingDocumentFallback(r));
  });

  it("um alarme por motivo distinto, agrupando os destaques", async () => {
    const mk = (destaque: string, reason?: string): PostEntry => ({
      platform: "linkedin",
      destaque,
      subtype: "main",
      url: null,
      status: "scheduled",
      scheduled_at: null,
      format: reason ? "carousel" : "document",
      ...(reason ? { document_fallback_reason: reason } : {}),
    });
    const calls: { fingerprint: string; body: string }[] = [];
    const sent = await alarmLinkedInDocumentFallbacks(
      [mk("d1", "document_rejected:linkedin_creds_missing"), mk("d2", "document_rejected:linkedin_creds_missing"), mk("d3"), mk("um", "opt_out")],
      "260999",
      (async (f: { fingerprint: string; body: string }) => {
        calls.push(f);
        return {} as never;
      }) as never,
    );
    assert.equal(sent, 1);
    assert.equal(calls[0].fingerprint, "linkedin-daily-document-fallback:document_rejected:linkedin_creds_missing");
    assert.match(calls[0].body, /- d1:.*\n- d2:/);
  });

  it("sem notify (test runner) não faz nada", async () => {
    assert.equal(await alarmLinkedInDocumentFallbacks([], "260999", null), 0);
  });
});
