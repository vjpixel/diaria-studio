/**
 * test/verify-social-worker-dispatch.test.ts (#5766)
 *
 * Cobertura das funções puras de verify-social-worker-dispatch.ts —
 * reconciliação de LinkedIn/Instagram/Threads contra o Worker Cloudflare
 * `diaria-linkedin-cron` (`/list` + `/dlq`). NENHUM teste aqui faz chamada de
 * rede real: `verifyWorkerDispatch` recebe um `fetchJson` stub em memória.
 *
 * O bloco "main() CLI — fail-soft" (#5783) roda o script real via spawnSync
 * (sem stub de rede — a leitura/parse do JSON corrompido é o que precisa ser
 * exercitado, e isso acontece ANTES de qualquer chamada de rede).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  reconcileWorkerEntry,
  verifyWorkerDispatch,
  WORKER_RECONCILABLE_PLATFORMS,
  DLQ_REASON_PLACEHOLDER,
  type PostEntry,
  type SocialPublished,
  type FetchJsonFn,
} from "../scripts/verify-social-worker-dispatch.ts";

const NOW = new Date("2026-08-20T20:00:00Z");

function entry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "instagram",
    destaque: "d1",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-08-20T10:00:00Z",
    worker_queue_key: "queue:2026-08-20T10:00:00.000Z:uuid-1",
    ...overrides,
  };
}

describe("reconcileWorkerEntry — canais fora de escopo/estado não mudam", () => {
  it("ignora platform fora de WORKER_RECONCILABLE_PLATFORMS (twitter)", () => {
    const e = entry({ platform: "twitter" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, false);
    assert.deepEqual(r.updated, e);
  });

  it("ignora entry já não-scheduled (published)", () => {
    const e = entry({ status: "published" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, false);
  });

  it("ignora entry sem worker_queue_key (legacy / fallback_used)", () => {
    const e = entry({ worker_queue_key: undefined });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, false);
  });

  it("WORKER_RECONCILABLE_PLATFORMS é exatamente linkedin/instagram/threads", () => {
    assert.deepEqual([...WORKER_RECONCILABLE_PLATFORMS].sort(), ["instagram", "linkedin", "threads"]);
  });
});

describe("reconcileWorkerEntry — ainda na fila", () => {
  it("key presente em queueKeys: nada muda, mesmo vencido", () => {
    const key = "queue:2026-08-20T10:00:00.000Z:uuid-1";
    const e = entry({ worker_queue_key: key });
    const r = reconcileWorkerEntry(e, new Set([key]), new Set(), NOW);
    assert.equal(r.changed, false);
    assert.equal(r.updated.status, "scheduled");
  });
});

describe("reconcileWorkerEntry — DLQ (falha real, qualquer canal)", () => {
  for (const platform of ["linkedin", "instagram", "threads"]) {
    it(`${platform}: key em dlqKeys → failed com motivo genérico documentado`, () => {
      const key = "dlq:2026-08-20T10:00:00.000Z:uuid-1";
      const e = entry({ platform, worker_queue_key: key });
      const r = reconcileWorkerEntry(e, new Set(), new Set([key]), NOW);
      assert.equal(r.changed, true);
      assert.equal(r.updated.status, "failed");
      assert.equal(r.updated.failure_reason, DLQ_REASON_PLACEHOLDER);
      assert.equal(r.updated.verification_note, undefined);
    });
  }
});

describe("reconcileWorkerEntry — nem fila nem DLQ (fired)", () => {
  it("instagram: vira published com verification_note de ALTA confiança (entrega real)", () => {
    const e = entry({ platform: "instagram" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "published");
    assert.equal(r.updated.published_at, NOW.toISOString());
    assert.match(r.updated.verification_note as string, /confirmed_by_worker_high_confidence/);
    assert.equal(r.updated.failure_reason, undefined);
  });

  it("threads: mesmo caminho de alta confiança do instagram", () => {
    const e = entry({ platform: "threads" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "published");
    assert.match(r.updated.verification_note as string, /confirmed_by_worker_high_confidence/);
  });

  it("linkedin: vira published mas com verification_note de confiança MAIS FRACA (sem confirmação da plataforma)", () => {
    const e = entry({ platform: "linkedin" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "published");
    assert.match(
      r.updated.verification_note as string,
      /make_webhook_accepted_no_platform_delivery_confirmation/,
    );
    // Nunca a mesma nota de alta confiança do Instagram/Threads.
    assert.doesNotMatch(r.updated.verification_note as string, /confirmed_by_worker_high_confidence/);
  });
});

describe("verifyWorkerDispatch — orquestra list+dlq+reconcile sem rede real", () => {
  it("aplica DLQ, fired e still-queued em uma edição mista, conta changes corretamente", async () => {
    const published: SocialPublished = {
      posts: [
        entry({ platform: "instagram", destaque: "d1", worker_queue_key: "queue:t1" }), // vira published
        entry({ platform: "linkedin", destaque: "d2", worker_queue_key: "queue:t2" }), // vira published (fraco)
        entry({ platform: "threads", destaque: "d3", worker_queue_key: "queue:t3" }), // ainda na fila
        entry({ platform: "instagram", destaque: "d1", worker_queue_key: "queue:t4", subtype: "main" }), // dlq → failed
        entry({ platform: "facebook", destaque: "d1", worker_queue_key: undefined }), // fora de escopo
      ],
    };
    // Ajusta a 4a entry pra usar dlq
    published.posts[3] = { ...published.posts[3], worker_queue_key: "queue:t4" };

    const fetchJson: FetchJsonFn = async (url: string) => {
      if (url.endsWith("/list")) {
        return { count: 1, items: [{ key: "queue:t3" }] };
      }
      if (url.endsWith("/dlq")) {
        return { count: 1, items: [{ key: "queue:t4" }] };
      }
      throw new Error(`unexpected url ${url}`);
    };

    const { updated, changes } = await verifyWorkerDispatch(
      published,
      "https://worker.example/",
      "tok",
      fetchJson,
      NOW,
    );

    assert.equal(changes, 3); // t1 fired, t2 fired, t4 dlq — t3 still queued, facebook untouched
    const byKey = new Map(updated.posts.map((p) => [p.worker_queue_key as string | undefined, p]));
    assert.equal(byKey.get("queue:t1")?.status, "published");
    assert.equal(byKey.get("queue:t2")?.status, "published");
    assert.equal(byKey.get("queue:t3")?.status, "scheduled");
    assert.equal(byKey.get("queue:t4")?.status, "failed");
  });

  it("#6016 item 3: KV lag — retry com backoff até a key aparecer na fila antes de reconciliar", async () => {
    let listCalls = 0;
    const sleeps: number[] = [];
    const fetchJson: FetchJsonFn = async (url: string) => {
      if (url.endsWith("/dlq")) return { count: 0, items: [] };
      if (url.endsWith("/list")) {
        listCalls++;
        // tentativas 1 e 2: KV ainda não propagou; tentativa 3: apareceu
        return listCalls < 3
          ? { count: 0, items: [] }
          : { count: 1, items: [{ key: "queue:t1" }] };
      }
      throw new Error(`unexpected url ${url}`);
    };
    const published: SocialPublished = {
      posts: [entry({ platform: "linkedin", destaque: "d1", worker_queue_key: "queue:t1" })],
    };
    const { updated, changes } = await verifyWorkerDispatch(
      published,
      "https://worker.example/",
      "tok",
      fetchJson,
      NOW,
      { maxAttempts: 3, backoffMs: 7, sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.equal(listCalls, 3);
    assert.deepEqual(sleeps, [7, 7]);
    // SEM o retry, a ausência transitória viraria "published" (falso negativo
    // que induz re-dispatch). COM a key encontrada na 3ª tentativa, segue `scheduled`.
    assert.equal(changes, 0);
    assert.equal(updated.posts[0].status, "scheduled");
  });

  it("#6016 item 3: sem retry configurado além do default, esgotadas as tentativas reconcilia pelo último fetch", async () => {
    let listCalls = 0;
    const fetchJson: FetchJsonFn = async (url: string) => {
      if (url.endsWith("/dlq")) return { count: 0, items: [] };
      if (url.endsWith("/list")) {
        listCalls++;
        return { count: 0, items: [] }; // nunca propaga
      }
      throw new Error(`unexpected url ${url}`);
    };
    const published: SocialPublished = {
      posts: [entry({ platform: "linkedin", destaque: "d1", worker_queue_key: "queue:x" })],
    };
    const { changes } = await verifyWorkerDispatch(
      published,
      "https://worker.example/",
      "tok",
      fetchJson,
      NOW,
      { maxAttempts: 2, backoffMs: 1, sleep: async () => {} },
    );
    assert.equal(listCalls, 2);
    // comportamento final preservado (ausente = fired) — mas só após esgotar retries
    assert.equal(changes, 1);
  });

  it("edição sem nenhuma entry reconciliável: 0 changes, nenhuma chamada extra falha", async () => {
    const published: SocialPublished = {
      posts: [entry({ platform: "facebook", worker_queue_key: undefined, status: "published" })],
    };
    const fetchJson: FetchJsonFn = async (url: string) =>
      url.endsWith("/list") ? { count: 0, items: [] } : { count: 0, items: [] };
    const { changes } = await verifyWorkerDispatch(published, "https://worker.example/", "tok", fetchJson, NOW);
    assert.equal(changes, 0);
  });
});

describe("main() CLI — fail-soft (#5783)", () => {
  const PROJECT_ROOT = join(import.meta.dirname, "..");
  const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "verify-social-worker-dispatch.ts");

  function runCli(editionDir: string, env: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT_PATH, "--edition-dir", editionDir],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          // Credenciais presentes o bastante pra passar do early-return de
          // #738/#5783 e chegar no bloco try que lê o JSON — sem elas, o
          // script sai antes de sequer tentar ler o arquivo.
          DIARIA_LINKEDIN_CRON_URL: "https://worker.example/",
          DIARIA_LINKEDIN_CRON_TOKEN: "fake-token",
          ...env,
        },
      },
    );
  }

  it("JSON corrompido/truncado em 06-social-published.json → warning + exit 0, nunca exit 1/stack trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-social-worker-corrupt-"));
    try {
      const editionDir = join(dir, "260820");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      // JSON truncado — simula corrupção de sync do OneDrive citada no header.
      writeFileSync(join(internalDir, "06-social-published.json"), '{"posts": [ { "platform": "instagr', "utf8");

      const r = runCli(editionDir);

      assert.equal(r.status, 0, `esperado exit 0 (fail-soft), obtido ${r.status}. stderr: ${r.stderr}`);
      assert.match(r.stderr, /falhou \(non-fatal\)/);
      // Nunca deveria escapar até main().catch() (stack trace + exit 1).
      assert.doesNotMatch(r.stderr, /at main /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("06-social-published.json ausente → skip limpo, exit 0 (comportamento pré-existente, não deve regredir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-social-worker-missing-"));
    try {
      const editionDir = join(dir, "260820");
      mkdirSync(editionDir, { recursive: true });

      const r = runCli(editionDir);

      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /nenhum 06-social-published\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
