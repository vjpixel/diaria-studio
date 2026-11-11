/**
 * test/linkedin-document-residuo-12584.test.ts (#12584 item 5)
 *
 * Resíduo do #12584 — o documento PDF como formato padrão do LinkedIn fora da
 * diária:
 *   - Retrospectiva mensal (página): plano de documento com os 5 slides da
 *     história, chave idempotente POR HISTÓRIA (as 3 usam o mesmo `destaque`;
 *     uma chave só juntaria os 3 posts numa entry do Worker);
 *   - anual (lotes `data/annual/{slug}/social/{AAMMDD}` rodando o
 *     `publish-linkedin.ts`): namespace próprio da chave, que não colide com a
 *     diária do mesmo dia (mesma chave = o Worker regrava a entry e apaga um
 *     dos dois posts, #10917);
 *   - Artigo Especial: sem carrossel, segue imagem única e registra o motivo
 *     no store, sem passar a mandar chave idempotente.
 *
 * In-process, `globalThis.fetch` mockado (mesmo padrão de
 * `publish-linkedin-document-12584.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchEntry, type DispatchContext, type DispatchInput } from "../scripts/publish-linkedin.ts";
import {
  linkedInDailyIdempotencyKey,
  linkedInIdempotencyNamespaceForDir,
  retrospectivaLinkedInIdempotencyKey,
  clampLinkedInDocumentTitle,
} from "../scripts/lib/linkedin-daily-document.ts";
import {
  retrospectivaLinkedInDispatchInput,
  RETROSPECTIVA_SOCIAL_DESTAQUE,
  type SocialDispatchInput,
} from "../scripts/publish-retrospectiva-social.ts";

const FUTURE = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const slides = (h: string) => ["cover", "p1", "p2", "p3", "cta"].map((s) => `https://img.test/${h}_${s}.jpg`);

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-doc-residuo-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkCtx(dir: string, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    publishedPath: join(dir, "published.json"),
    webhookUrl: "",
    workerUrl: "https://worker.test",
    workerToken: "test-tok",
    useWorkerForScheduled: true,
    editionDate: "retrospectiva-2610-11",
    rootDir: dir,
    ...over,
  };
}

function socialInput(h: "d1" | "d2" | "d3", over: Partial<SocialDispatchInput> = {}): SocialDispatchInput {
  return { historia: h, text: `texto ${h}`, imageUrls: [slides(h)[0]], carouselUrls: slides(h), scheduledAt: FUTURE(), ...over };
}

/** Mock do fetch: `/queue` responde ok com a key = idempotency_key (ou uuid). */
function mockQueue() {
  const bodies: Record<string, unknown>[] = [];
  let makeCalls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (String(u).includes("/queue")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const key = `q-${bodies.length}`;
      return new Response(JSON.stringify({ queued: true, key, scheduled_at: body.scheduled_at, destaque: body.destaque }), { status: 200 });
    }
    // `fetch("")` real rejeita (URL inválida): a Retrospectiva passa
    // `webhookUrl: ""` de propósito pra que o make_now falhe.
    if (String(u) === "") throw new TypeError("Failed to parse URL from ");
    makeCalls++;
    return new Response(JSON.stringify({ accepted: true, request_id: "make-req" }), { status: 200 });
  }) as typeof fetch;
  return { bodies, makeCalls: () => makeCalls, restore: () => void (globalThis.fetch = saved) };
}

const fakePdf = async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]);

describe("#12584 item 5 — chave idempotente fora da diária", () => {
  it("lote da anual ganha namespace próprio; diretório da diária fica no namespace de sempre", () => {
    assert.equal(linkedInIdempotencyNamespaceForDir("/repo/data/annual/2026-aniversario/social/260913"), "linkedin-annual-2026-aniversario");
    assert.equal(linkedInIdempotencyNamespaceForDir("C:\\repo\\data\\annual\\2027-janeiro\\social\\270105\\"), "linkedin-annual-2027-janeiro");
    assert.equal(linkedInIdempotencyNamespaceForDir("/repo/data/editions/2609/260913"), undefined);
    assert.equal(linkedInIdempotencyNamespaceForDir("/tmp/x/260913"), undefined);
  });

  it("o D1 do lote da anual e o D1 da diária do mesmo dia NÃO compartilham chave (regressão)", () => {
    const daily = linkedInDailyIdempotencyKey("260913", "d1");
    const ns = linkedInIdempotencyNamespaceForDir("/repo/data/annual/2026-aniversario/social/260913");
    const annual = linkedInDailyIdempotencyKey("260913", "d1", { namespace: ns });
    assert.equal(daily, "linkedin-daily:260913:d1:main"); // formato da diária intacto (#12661)
    assert.equal(annual, "linkedin-annual-2026-aniversario:260913:d1:main");
    assert.notEqual(annual, daily);
    assert.equal(linkedInDailyIdempotencyKey("260913", "d1", { namespace: ns, isTest: true }), "linkedin-annual-2026-aniversario-test:260913:d1:main");
  });

  it("Retrospectiva: uma chave por história, no formato aceito pelo Worker", () => {
    const keys = ["d1", "d2", "d3"].map((h) => retrospectivaLinkedInIdempotencyKey("2610-11", h));
    assert.equal(new Set(keys).size, 3);
    assert.equal(keys[0], "linkedin-retrospectiva:2610-11:d1:main");
    for (const k of keys) assert.match(k, /^[A-Za-z0-9._:-]{1,128}$/);
  });

  it("dispatchEntry repassa ctx.idempotencyNamespace à chave derivada", async () => {
    const m = mockQueue();
    const { dir, cleanup } = tmpDir();
    try {
      await dispatchEntry(
        {
          destaque: "d1",
          subtype: "main",
          text: "t",
          imageUrl: "https://img.test/c.jpg",
          scheduledAt: FUTURE(),
          webhookTarget: "diaria",
          action: "post",
          linkedInDocument: { status: "skip", reason: "carousel_incomplete" },
        },
        mkCtx(dir, { editionDate: "260913", idempotencyNamespace: "linkedin-annual-2026-aniversario" }),
      );
      assert.equal(m.bodies[0].idempotency_key, "linkedin-annual-2026-aniversario:260913:d1:main");
    } finally {
      m.restore();
      cleanup();
    }
  });
});

describe("#12584 item 5 — Retrospectiva mensal na página LinkedIn", () => {
  const base = { cycle: "2610-11", title: "Título da história", documentOptOut: false, upload: async () => "https://img.test/doc.pdf" };

  it("5 slides https → plano ready, capa como image_url, sem fallback imediato", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const input = retrospectivaLinkedInDispatchInput(socialInput("d2"), { ...base, cycleDir: dir });
      assert.equal(input.destaque, RETROSPECTIVA_SOCIAL_DESTAQUE);
      assert.equal(input.imageUrl, slides("d2")[0]);
      assert.equal(input.allowImmediateFallback, false);
      assert.equal(input.idempotencyKey, "linkedin-retrospectiva:2610-11:d2:main");
      assert.equal(input.linkedInDocument?.status, "ready");
      if (input.linkedInDocument?.status === "ready") assert.deepEqual(input.linkedInDocument.carouselImageUrls, slides("d2"));
    } finally {
      cleanup();
    }
  });

  it("slide faltando ou sem URL https (dry-run) → skip carousel_incomplete; --linkedin-format image → opt_out", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const short = retrospectivaLinkedInDispatchInput(socialInput("d1", { carouselUrls: slides("d1").slice(0, 4) }), { ...base, cycleDir: dir });
      assert.deepEqual(short.linkedInDocument, { status: "skip", reason: "carousel_incomplete" });
      const local = retrospectivaLinkedInDispatchInput(socialInput("d1", { carouselUrls: slides("d1").map((u, i) => (i === 2 ? "/tmp/p2.jpg" : u)) }), {
        ...base,
        cycleDir: dir,
      });
      assert.deepEqual(local.linkedInDocument, { status: "skip", reason: "carousel_incomplete" });
      const opt = retrospectivaLinkedInDispatchInput(socialInput("d1"), { ...base, cycleDir: dir, documentOptOut: true });
      assert.deepEqual(opt.linkedInDocument, { status: "skip", reason: "opt_out" });
    } finally {
      cleanup();
    }
  });

  it("prepareDocument grava o PDF no _internal do ciclo e sobe com chave img-{ciclo}-linkedin-{h}-carousel-{md5}.pdf", async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const uploads: Array<{ path: string; key: string }> = [];
      const input = retrospectivaLinkedInDispatchInput(socialInput("d3"), {
        ...base,
        cycleDir: dir,
        title: "  **Título** da   história ",
        buildPdf: fakePdf,
        upload: async (path, key) => {
          uploads.push({ path, key });
          return `https://img.test/${key}`;
        },
      });
      assert.equal(input.linkedInDocument?.status, "ready");
      if (input.linkedInDocument?.status !== "ready") return;
      const doc = await input.linkedInDocument.prepareDocument();
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].path, join(dir, "_internal", "divulgacao-linkedin-d3-carousel.pdf"));
      assert.ok(existsSync(uploads[0].path));
      assert.match(uploads[0].key, /^img-2610-11-linkedin-d3-carousel-[0-9a-f]{8}\.pdf$/);
      assert.match(uploads[0].key, /^img-[^:]+$/); // allowlist do Worker de imagens
      assert.equal(doc.title, "Título da história");
    } finally {
      cleanup();
    }
  });

  it("título ausente → genérico com o ciclo e a história, nunca vazio", async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const input = retrospectivaLinkedInDispatchInput(socialInput("d1"), { ...base, cycleDir: dir, title: null, buildPdf: fakePdf });
      if (input.linkedInDocument?.status !== "ready") throw new Error("plano deveria ser ready");
      const doc = await input.linkedInDocument.prepareDocument();
      assert.equal(doc.title, "Retrospectiva diar.ia.br 2610-11 — d1");
      assert.equal(clampLinkedInDocumentTitle("   "), "");
    } finally {
      cleanup();
    }
  });

  it("ponta a ponta: as 3 histórias saem como documento, cada uma com sua chave, e o store grava format=document", async () => {
    const m = mockQueue();
    const { dir, cleanup } = tmpDir();
    try {
      const upload = async (_p: string, key: string) => `https://img.test/${key}`;
      for (const h of ["d1", "d2", "d3"] as const) {
        const entry = await dispatchEntry(
          retrospectivaLinkedInDispatchInput(socialInput(h), { ...base, cycleDir: dir, buildPdf: fakePdf, upload }),
          mkCtx(dir),
        );
        assert.equal(entry.status, "scheduled");
        assert.equal(entry.format, "document");
      }
      assert.equal(m.bodies.length, 3);
      assert.deepEqual(
        m.bodies.map((b) => b.idempotency_key),
        ["d1", "d2", "d3"].map((h) => `linkedin-retrospectiva:2610-11:${h}:main`),
      );
      for (const b of m.bodies) {
        assert.equal(typeof b.document_url, "string");
        assert.equal((b.image_urls as string[]).length, 5); // fallback do próprio Worker
      }
      assert.equal(m.makeCalls(), 0);
    } finally {
      m.restore();
      cleanup();
    }
  });

  it("horário vencido (make_now) sem URL do Make → failed, nunca publica na hora", async () => {
    const m = mockQueue();
    const { dir, cleanup } = tmpDir();
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      const entry = await dispatchEntry(
        retrospectivaLinkedInDispatchInput(socialInput("d1", { scheduledAt: past }), { ...base, cycleDir: dir, buildPdf: fakePdf }),
        mkCtx(dir),
      );
      assert.equal(entry.status, "failed");
      assert.equal(m.bodies.length, 0);
    } finally {
      m.restore();
      cleanup();
    }
  });
});

describe("#12584 item 5 — plano sem chave", () => {
  const input = (over: Partial<DispatchInput>): DispatchInput => ({
    destaque: "especial-pagina",
    subtype: "main",
    text: "t",
    imageUrl: "https://img.test/og.jpg",
    scheduledAt: FUTURE(),
    webhookTarget: "diaria",
    action: "post",
    ...over,
  });

  it("Artigo Especial (skip no_carousel, chave null): imagem única, sem idempotency_key, motivo no store", async () => {
    const m = mockQueue();
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(
        input({ linkedInDocument: { status: "skip", reason: "no_carousel" }, idempotencyKey: null }),
        mkCtx(dir, { editionDate: "2026-slug" }),
      );
      assert.equal(entry.status, "scheduled");
      assert.equal(entry.format, "single_image");
      assert.equal(entry.document_fallback_reason, "no_carousel");
      assert.equal(m.bodies.length, 1);
      assert.equal("idempotency_key" in m.bodies[0], false);
      assert.equal(m.bodies[0].image_url, "https://img.test/og.jpg");
    } finally {
      m.restore();
      cleanup();
    }
  });

  it("plano ready com chave null → failed sem enfileirar (o documento precisa da chave)", async () => {
    const m = mockQueue();
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(
        input({
          linkedInDocument: { status: "ready", carouselImageUrls: slides("d1"), prepareDocument: async () => ({ url: "https://x/doc.pdf", title: "t" }) },
          idempotencyKey: null,
        }),
        mkCtx(dir),
      );
      assert.equal(entry.status, "failed");
      assert.equal(m.bodies.length, 0);
    } finally {
      m.restore();
      cleanup();
    }
  });
});
