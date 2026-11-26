/**
 * test/linkedin-use-melhor-document-13847.test.ts (#13847)
 *
 * O 4º post (USE MELHOR, `um`) do LinkedIn saía sempre como imagem única: o
 * ramo do `um` em `publish-linkedin.ts` despachava só `imageUrl`, sem o plano
 * de documento que o #12584 deu ao loop dos destaques (D1-D3). Aqui o post do
 * `um` passa pelo mesmo caminho: documento PDF → carrossel → imagem única,
 * com `format` no store, `idempotency_key` (#12661) e alarme de fallback
 * (#12372).
 *
 * O Worker é falso (fetch stub): nenhuma chamada sai da máquina.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  alarmLinkedInDocumentFallbacks,
  buildUseMelhorLinkedInPost,
  dispatchEntry,
  useMelhorLinkedInDispatchInput,
  useMelhorLinkedInDocumentPlan,
  type DispatchContext,
} from "../scripts/publish-linkedin.ts";
import type { UseMelhorReadyPlan } from "../scripts/lib/use-melhor-dispatch.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLOTS = ["cover", "p1", "p2", "p3", "cta"];
const SLIDE_URLS = SLOTS.map((s) => `https://cdn.test/um-${s}.jpg`);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function images(missing?: string): Record<string, { url?: string }> {
  const out: Record<string, { url?: string }> = {};
  for (const s of SLOTS) if (s !== missing) out[useMelhorSlideImageKey(s)] = { url: `https://cdn.test/um-${s}.jpg` };
  return out;
}

const PLAN: UseMelhorReadyPlan = {
  status: "ready",
  time: "07:45",
  item: { title: "Planilhas com IA", url: "https://exemplo.test/guia", summary: "Guia.", score: 80 },
  slots: SLOTS,
  captionTitle: "Planilhas com IA",
};

const SOCIAL_MD = ["# Social", "", "## d1", "", "Texto do d1.", "", "## um", "", "Um guia prático para planilhas.", ""].join("\n");

function ctx(dir: string, over: Partial<DispatchContext> = {}): DispatchContext {
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

/** Worker falso: responde cada POST /queue com o status da lista (default 202). */
function fakeWorker(statuses: number[] = []) {
  const bodies: Record<string, unknown>[] = [];
  let makeCalls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (!String(u).includes("/queue")) {
      makeCalls++;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const status = statuses[bodies.length - 1] ?? 202;
    if (status >= 400) {
      return new Response(JSON.stringify({ error: "recusado" }), { status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ queued: true, key: `queue:${String(body.idempotency_key)}`, scheduled_at: body.scheduled_at, destaque: body.destaque }), { status });
  }) as typeof fetch;
  return { bodies, makeCalls: () => makeCalls, restore: () => (globalThis.fetch = saved) };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-um-13847-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function umInput(dir: string, opts: { missing?: string; optOut?: boolean } = {}) {
  const built = buildUseMelhorLinkedInPost({ socialMd: SOCIAL_MD, plan: PLAN, images: images(opts.missing) });
  assert.ok(built.ok, JSON.stringify(built));
  if (!built.ok) throw new Error("unreachable");
  return useMelhorLinkedInDispatchInput({
    built,
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    optOut: opts.optOut === true,
    captionTitle: PLAN.captionTitle,
    editionDir: dir,
    editionDate: "260999",
    upload: async (_file, kvKey) => `https://img.test/${kvKey}`,
    buildPdf: async () => PDF_BYTES,
  });
}

describe("#13847 4º post (USE MELHOR) do LinkedIn como documento PDF", () => {
  it("buildUseMelhorLinkedInPost devolve os slides do carrossel (tudo-ou-nada)", () => {
    const full = buildUseMelhorLinkedInPost({ socialMd: SOCIAL_MD, plan: PLAN, images: images() });
    assert.ok(full.ok);
    if (full.ok) assert.deepEqual(full.carouselUrls, SLIDE_URLS);
    const partial = buildUseMelhorLinkedInPost({ socialMd: SOCIAL_MD, plan: PLAN, images: images("p2") });
    assert.ok(partial.ok, "a capa existe: o post sai, só sem carrossel");
    if (partial.ok) assert.equal(partial.carouselUrls, null);
  });

  it("o input do 4º post leva plano de documento `ready` com os slides", async () => {
    await withDir(async (dir) => {
      const input = umInput(dir);
      assert.equal(input.destaque, "um");
      assert.equal(input.linkedInDocument?.status, "ready", "sem plano o post saía sempre como imagem única (bug #13847)");
      if (input.linkedInDocument?.status === "ready") assert.deepEqual(input.linkedInDocument.carouselImageUrls, SLIDE_URLS);
    });
  });

  it("sai como documento PDF na fila do Worker, com chave idempotente e format no store", async () => {
    const w = fakeWorker();
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(umInput(dir), ctx(dir));
        assert.equal(w.bodies.length, 1);
        const body = w.bodies[0];
        assert.equal(body.destaque, "um");
        assert.match(String(body.document_url), /^https:\/\/img\.test\/.*linkedin-um-carousel/);
        assert.equal(body.document_title, "Planilhas com IA");
        assert.equal(body.idempotency_key, "linkedin-daily:260999:um:main");
        assert.equal(entry.status, "scheduled");
        assert.equal(entry.format, "document");
        assert.equal(w.makeCalls(), 0);
        const store = JSON.parse(readFileSync(join(dir, "06-social-published.json"), "utf8")) as { posts: Array<Record<string, unknown>> };
        const um = store.posts.find((p) => p.destaque === "um");
        assert.equal(um?.format, "document");
      });
    } finally {
      w.restore();
    }
  });

  it("documento recusado (4xx) desce pro carrossel; carrossel recusado desce pra imagem única", async () => {
    const w = fakeWorker([422, 202]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(umInput(dir), ctx(dir));
        assert.equal(entry.format, "carousel");
        assert.deepEqual(w.bodies[1].image_urls, SLIDE_URLS);
        assert.equal(w.bodies[1].idempotency_key, w.bodies[0].idempotency_key, "mesma chave nos degraus");
        assert.match(String(entry.document_fallback_reason), /^document_rejected/);
      });
    } finally {
      w.restore();
    }
    const w2 = fakeWorker([422, 422, 202]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(umInput(dir), ctx(dir));
        assert.equal(entry.format, "single_image");
        assert.equal(w2.bodies[2].image_url, "https://cdn.test/um-cover.jpg");
        assert.equal(w2.bodies[2].idempotency_key, "linkedin-daily:260999:um:main");
      });
    } finally {
      w2.restore();
    }
  });

  it("carrossel incompleto ou --linkedin-format image: imagem única com o motivo no store", async () => {
    for (const [opts, reason] of [[{ missing: "cta" }, "carousel_incomplete"], [{ optOut: true }, "opt_out"]] as const) {
      const w = fakeWorker();
      try {
        await withDir(async (dir) => {
          const entry = await dispatchEntry(umInput(dir, opts), ctx(dir));
          assert.equal(w.bodies.length, 1);
          assert.equal(w.bodies[0].document_url, undefined);
          assert.equal(w.bodies[0].image_url, "https://cdn.test/um-cover.jpg");
          assert.equal(entry.format, "single_image");
          assert.equal(entry.document_fallback_reason, reason);
        });
      } finally {
        w.restore();
      }
    }
  });

  it("falha do PDF no 4º post desce pro carrossel e abre o alarme de fallback (#12372)", async () => {
    const w = fakeWorker();
    try {
      await withDir(async (dir) => {
        const plan = useMelhorLinkedInDocumentPlan({
          carouselUrls: SLIDE_URLS,
          optOut: false,
          captionTitle: undefined,
          editionDir: dir,
          editionDate: "260999",
          upload: async () => {
            throw new Error("kv fora");
          },
          buildPdf: async () => PDF_BYTES,
        });
        assert.equal(plan.status, "ready");
        const entry = await dispatchEntry({ ...umInput(dir), linkedInDocument: plan }, ctx(dir));
        assert.equal(entry.format, "carousel");
        assert.match(String(entry.document_fallback_reason), /^pdf_failed/);
        const sent: string[] = [];
        const notify = (async (a: { subject: string }) => {
          sent.push(a.subject);
        }) as unknown as Parameters<typeof alarmLinkedInDocumentFallbacks>[2];
        const n = await alarmLinkedInDocumentFallbacks([entry], "260999", notify);
        assert.equal(n, 1);
        assert.match(sent[0], /260999/);
      });
    } finally {
      w.restore();
    }
  });

  it("título genérico quando o plano não traz captionTitle", async () => {
    await withDir(async (dir) => {
      const plan = useMelhorLinkedInDocumentPlan({
        carouselUrls: SLIDE_URLS,
        optOut: false,
        captionTitle: "  ",
        editionDir: dir,
        editionDate: "260999",
        upload: async (_f, k) => `https://img.test/${k}`,
        buildPdf: async () => PDF_BYTES,
      });
      assert.equal(plan.status, "ready");
      if (plan.status === "ready") assert.equal((await plan.prepareDocument()).title, "diar.ia.br 260999 — Use melhor");
    });
  });

  it("título só de markdown (`**`) recai no genérico em vez de sair vazio", async () => {
    await withDir(async (dir) => {
      const plan = useMelhorLinkedInDocumentPlan({
        carouselUrls: SLIDE_URLS,
        optOut: false,
        captionTitle: "** **",
        editionDir: dir,
        editionDate: "260999",
        upload: async (_f, k) => `https://img.test/${k}`,
        buildPdf: async () => PDF_BYTES,
      });
      assert.equal(plan.status, "ready");
      if (plan.status === "ready") assert.equal((await plan.prepareDocument()).title, "diar.ia.br 260999 — Use melhor");
    });
  });

  it("5xx/timeout no degrau do documento vira `failed`, sem outro formato por cima (#11106)", async () => {
    // Worker sempre 503: o cliente esgota os retries no documento e não pode
    // descer pro carrossel nem pra imagem única (a entry pode ter sido gravada).
    const w = fakeWorker(Array(20).fill(503));
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(umInput(dir), ctx(dir));
        assert.equal(entry.status, "failed");
        assert.ok(w.bodies.length >= 1);
        for (const b of w.bodies) assert.ok(b.document_url !== undefined, "só o degrau do documento foi tentado");
        assert.equal(w.makeCalls(), 0, "sem fallback Make por cima");
      });
    } finally {
      w.restore();
    }
  });

  it("carrossel do 4º post com 10 slides (capa + 8 parágrafos + CTA) sai inteiro no documento e no carrossel", async () => {
    const slots = ["cover", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "cta"];
    const imgs: Record<string, { url?: string }> = {};
    for (const s of slots) imgs[useMelhorSlideImageKey(s)] = { url: `https://cdn.test/um-${s}.jpg` };
    const urls = slots.map((s) => `https://cdn.test/um-${s}.jpg`);
    const built = buildUseMelhorLinkedInPost({ socialMd: SOCIAL_MD, plan: { ...PLAN, slots }, images: imgs });
    assert.ok(built.ok);
    if (!built.ok) return;
    assert.deepEqual(built.carouselUrls, urls);
    let pdfUrls: readonly string[] = [];
    const w = fakeWorker([422, 202]);
    try {
      await withDir(async (dir) => {
        const input = useMelhorLinkedInDispatchInput({
          built,
          scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          optOut: false,
          captionTitle: PLAN.captionTitle,
          editionDir: dir,
          editionDate: "260999",
          upload: async (_f, k) => `https://img.test/${k}`,
          buildPdf: async (u) => {
            pdfUrls = u;
            return PDF_BYTES;
          },
        });
        const entry = await dispatchEntry(input, ctx(dir));
        assert.deepEqual(pdfUrls, urls, "o PDF leva os 10 slides");
        assert.equal(entry.format, "carousel");
        assert.deepEqual(w.bodies[1].image_urls, urls, "o carrossel leva os 10 slides");
      });
    } finally {
      w.restore();
    }
  });

  it("main() despacha o 4º post pelo builder com plano de documento", () => {
    // Guard estrutural do call site: o bug foi o ramo do `um` montar o
    // DispatchInput à mão, sem `linkedInDocument`.
    const src = readFileSync(resolve(ROOT, "scripts/publish-linkedin.ts"), "utf8");
    const main = src.slice(src.indexOf("async function main("));
    assert.match(main, /dispatchEntry\(useMelhorLinkedInDispatchInput\(/);
    assert.doesNotMatch(main, /dispatchEntry\(\{\s*destaque: "um"/);
  });
});
