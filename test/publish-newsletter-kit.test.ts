/**
 * test/publish-newsletter-kit.test.ts (#464)
 *
 * Cobre as funções puras (`buildKitSubject`/`buildKitPreviewText`/
 * `checkSubjectNotEmpty`/`checkKitBackendEnabled`/`buildKitHtml`) e um
 * teste de integração de ponta a ponta de `main()` (mesmo padrão de
 * `publish-daily-brevo-integration-4532.test.ts`: fixtures em disco +
 * `fetch` mockado, sem tocar `data/`/rede reais).
 */
import { describe, it, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKitSubject,
  buildKitPreviewText,
  checkSubjectNotEmpty,
  checkKitBackendEnabled,
  buildKitHtml,
  resolvePublishedStatePath,
  readPublishedState,
  writePublishedState,
  updateExistingKitBroadcast,
  main,
  type KitNewsletterPublished,
} from "../scripts/publish-newsletter-kit.ts";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import type { KitBroadcastDetail } from "../scripts/lib/kit-client.ts";

describe("buildKitSubject / buildKitPreviewText", () => {
  it("subject é content.title, preview é content.subtitle — sem transformação", () => {
    assert.equal(buildKitSubject({ title: "Assunto X" }), "Assunto X");
    assert.equal(buildKitPreviewText({ subtitle: "Preview Y" }), "Preview Y");
  });
});

describe("checkSubjectNotEmpty", () => {
  it("assunto vazio ou só espaço: ok:false", () => {
    assert.equal(checkSubjectNotEmpty("").ok, false);
    assert.equal(checkSubjectNotEmpty("   ").ok, false);
  });
  it("assunto presente: ok:true", () => {
    assert.deepEqual(checkSubjectNotEmpty("Título"), { ok: true });
  });
});

describe("checkKitBackendEnabled", () => {
  it("backend ausente (default beehiiv): ok:false", () => {
    const result = checkKitBackendEnabled({});
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /"beehiiv"/);
  });
  it('backend explícito "beehiiv": ok:false', () => {
    const result = checkKitBackendEnabled({ publishing: { newsletter: { backend: "beehiiv" } } });
    assert.equal(result.ok, false);
  });
  it('backend "kit": ok:true', () => {
    assert.deepEqual(checkKitBackendEnabled({ publishing: { newsletter: { backend: "kit" } } }), { ok: true });
  });
});

describe("readPublishedState / writePublishedState", () => {
  it("ausente: null", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-pub-state-"));
    try {
      assert.equal(readPublishedState(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write então read: round-trip idêntico", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-pub-state-"));
    try {
      const state: KitNewsletterPublished = {
        broadcast_id: 42,
        subject: "Assunto",
        preview_text: "Preview",
        status: "draft",
        test_broadcast_ids: [],
      };
      writePublishedState(dir, state);
      assert.ok(existsSync(resolvePublishedStatePath(dir)));
      assert.deepEqual(readPublishedState(dir), state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const REVIEWED_MD = [
  "TÍTULO",
  "",
  "Modelos se replicam sozinhos",
  "",
  "SUBTÍTULO",
  "",
  "Segundo destaque | Terceiro destaque",
  "",
  "---",
  "",
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[Modelos se replicam sozinhos](https://example.com/1)**",
  "",
  "Corpo do destaque um com contexto suficiente pra render.",
  "",
  "Por que isso importa: razão um.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | RADAR**",
  "",
  "**[Segundo destaque](https://example.com/2)**",
  "",
  "Corpo dois.",
  "",
  "Por que isso importa: razão dois.",
  "",
].join("\n");

function writeEdition(root: string, date: string): string {
  const dir = join(root, "data/editions", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  return dir;
}

describe("buildKitHtml", () => {
  it("fragmento (fullDocument:false), sem placeholder de imagem não resolvido quando não há {{IMG:}}", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-html-"));
    try {
      const editionDir = writeEdition(root, "260999");
      const content = extractContent(editionDir);
      const { html, unresolvedImages } = buildKitHtml(content, {});
      assert.ok(!html.includes("<!doctype"), "fragmento não deve ter doctype (fullDocument:false)");
      assert.match(html, /Modelos se replicam sozinhos/);
      // Sem 06-public-images.json (publicImages: {}), todo {{IMG:...}} fica
      // sem URL pra substituir — comportamento esperado, não um bug desta
      // função (a substituição real depende do upload já ter rodado, Stage 3).
      assert.ok(unresolvedImages.length > 0, "sem publicImages, placeholders ficam não-resolvidos (esperado)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── updateExistingKitBroadcast (#8208) ──────────────────────────────────
//
// Reproduz o bug real da edição 260917: PATCH de conteúdo num broadcast já
// agendado (Stage 6) zera `send_at` mesmo sem o campo aparecer no corpo do
// PATCH. Cobre as duas camadas de defesa: reforço explícito no corpo do
// PATCH, e releitura + reagendamento automático quando o reforço não basta.

const SCHEDULED_EXISTING: KitNewsletterPublished = {
  broadcast_id: 25955349,
  subject: "Assunto agendado",
  preview_text: "Preview agendado",
  status: "scheduled",
  test_broadcast_ids: [],
  scheduled_at: "2026-09-18T09:00:00.000Z",
};

const DRAFT_PATCH_FIELDS = {
  subject: "Assunto novo",
  preview_text: "Preview novo",
  content: "<p>conteúdo</p>",
  public: true,
};

function fakeBroadcast(overrides: Partial<KitBroadcastDetail>): KitBroadcastDetail {
  return {
    id: 25955349,
    subject: "x",
    send_at: null,
    status: "draft",
    public: true,
    published_at: null,
    created_at: "2026-09-17T00:00:00.000Z",
    preview_text: null,
    description: null,
    thumbnail_alt: null,
    thumbnail_url: null,
    publication_id: 1,
    content: null,
    public_url: undefined,
    email_address: "x@example.com",
    email_template: { id: 1, name: "x" },
    ...overrides,
  };
}

describe("updateExistingKitBroadcast (#8208)", () => {
  it("existing.status !== 'scheduled': PATCH sem send_at reforçado, sem GET de verificação", async () => {
    const draftExisting: KitNewsletterPublished = {
      broadcast_id: 777,
      subject: "x",
      preview_text: "x",
      status: "draft",
      test_broadcast_ids: [],
    };
    const patchCalls: unknown[] = [];
    let getCalled = false;
    const result = await updateExistingKitBroadcast(draftExisting, DRAFT_PATCH_FIELDS, () => {}, {
      updateBroadcast: async (id, input) => {
        patchCalls.push(input);
        return fakeBroadcast({ id, send_at: null, status: "draft" });
      },
      getBroadcast: async (id) => {
        getCalled = true;
        return fakeBroadcast({ id });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(getCalled, false, "sem agendamento prévio, não há motivo pra reler send_at");
    assert.equal((patchCalls[0] as { send_at?: string }).send_at, undefined, "PATCH não reforça send_at quando não estava agendado");
  });

  it("existing.status === 'scheduled': PATCH já sai com send_at reforçado explicitamente (defesa 1)", async () => {
    const patchCalls: { id: number; input: unknown }[] = [];
    const result = await updateExistingKitBroadcast(SCHEDULED_EXISTING, DRAFT_PATCH_FIELDS, () => {}, {
      updateBroadcast: async (id, input) => {
        patchCalls.push({ id, input });
        // Kit real: mesmo reforçando, devolve send_at intacto desta vez.
        return fakeBroadcast({ id, send_at: SCHEDULED_EXISTING.scheduled_at!, status: "scheduled" });
      },
      getBroadcast: async (id) => fakeBroadcast({ id, send_at: SCHEDULED_EXISTING.scheduled_at!, status: "scheduled" }),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.sendAtRescued, false, "send_at sobreviveu — nenhum reagendamento necessário");
    assert.equal(patchCalls.length, 1, "só 1 PATCH — não precisou reagendar");
    assert.equal(
      (patchCalls[0].input as { send_at?: string }).send_at,
      SCHEDULED_EXISTING.scheduled_at,
      "#8208 defesa 1: send_at vai explícito no PATCH quando já estava agendado",
    );
  });

  it("#8208 reprodução do bug real: PATCH zera send_at mesmo reforçado — reagenda automaticamente (defesa 2)", async () => {
    const logs: string[] = [];
    const patchCalls: { id: number; input: unknown }[] = [];
    let getCalls = 0;
    const result = await updateExistingKitBroadcast(SCHEDULED_EXISTING, DRAFT_PATCH_FIELDS, (msg) => logs.push(msg), {
      updateBroadcast: async (id, input) => {
        patchCalls.push({ id, input });
        if (patchCalls.length === 1) {
          // Reproduz o bug: mesmo com send_at no corpo do 1º PATCH, o Kit
          // devolve send_at:null (achado ao vivo #8208, edição 260917).
          return fakeBroadcast({ id, send_at: null, status: "draft" });
        }
        // 2º PATCH (reagendamento automático) — desta vez pega.
        return fakeBroadcast({ id, send_at: SCHEDULED_EXISTING.scheduled_at!, status: "scheduled" });
      },
      getBroadcast: async (id) => {
        getCalls += 1;
        // GET pós-1º-PATCH confirma que send_at de fato zerou (não é só o
        // retorno do PATCH mentindo) — 2xx não é prova, #573.
        return fakeBroadcast({ id, send_at: null, status: "draft" });
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sendAtRescued, true, "reagendamento automático precisou acontecer");
      assert.equal(result.broadcastId, SCHEDULED_EXISTING.broadcast_id);
    }
    assert.equal(patchCalls.length, 2, "1º PATCH de conteúdo + 2º PATCH de reagendamento");
    assert.equal(
      (patchCalls[1].input as { send_at?: string }).send_at,
      SCHEDULED_EXISTING.scheduled_at,
      "2º PATCH (reagendamento) leva só send_at, igual a schedule-newsletter-kit.ts",
    );
    assert.equal(getCalls, 1, "1 releitura pós-PATCH pra confirmar o zeramento antes de reagendar");
    assert.ok(
      logs.some((l) => l.includes("[#8208]") && l.includes("ALERTA")),
      "alerta visível no stdout — nunca falha em silêncio (era o bug original)",
    );
    assert.ok(
      logs.some((l) => l.includes("[#8208]") && l.includes("reagendamento automático confirmado")),
      "confirmação do reagendamento também logada",
    );
  });

  it("#8208: reagendamento automático falha (send_at continua null) — ok:false com instrução de intervenção manual, nunca silencioso", async () => {
    const result = await updateExistingKitBroadcast(SCHEDULED_EXISTING, DRAFT_PATCH_FIELDS, () => {}, {
      updateBroadcast: async (id) => fakeBroadcast({ id, send_at: null, status: "draft" }),
      getBroadcast: async (id) => fakeBroadcast({ id, send_at: null, status: "draft" }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /INTERVENÇÃO MANUAL/);
      assert.match(result.reason, /schedule-newsletter-kit\.ts/);
    }
  });

  it("#8208: GET de verificação pós-PATCH falha (rede) — ok:false, nunca assume sucesso", async () => {
    const result = await updateExistingKitBroadcast(SCHEDULED_EXISTING, DRAFT_PATCH_FIELDS, () => {}, {
      updateBroadcast: async (id) => fakeBroadcast({ id, send_at: null, status: "draft" }),
      getBroadcast: async () => {
        throw new Error("rede indisponível");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /GET .*falhou/);
  });
});

// ── main() — integração de ponta a ponta ──────────────────────────────

function jsonRes(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

interface Call {
  method: string;
  pathname: string;
  body: unknown;
}

let calls: Call[] = [];
let originalFetch: typeof fetch;
let originalArgv: string[];
const API_KEY_ENV_ORIG = process.env.KIT_API_KEY;

function mockFetch(router: (call: Call) => Response): void {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init?.method ?? "GET",
      pathname: u.pathname,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    return router(call);
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.KIT_API_KEY = "kit_test_key_464";
  originalArgv = process.argv;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.argv = originalArgv;
});

after(() => {
  if (API_KEY_ENV_ORIG === undefined) delete process.env.KIT_API_KEY;
  else process.env.KIT_API_KEY = API_KEY_ENV_ORIG;
});

function writePlatformConfig(root: string, backend: string): void {
  writeFileSync(
    join(root, "platform.config.json"),
    JSON.stringify({ publishing: { newsletter: { backend } } }),
    "utf8",
  );
}

describe("main() — integração", () => {
  it("backend != kit: exitCode 2, nenhuma chamada de rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "beehiiv");
      const editionDir = writeEdition(root, "260998");
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 2);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run: nenhuma chamada de rede, sem estado escrito", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      mockFetch(() => {
        throw new Error("não deveria chamar fetch em --dry-run");
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--dry-run"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      assert.equal(readPublishedState(editionDir), null);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("1ª invocação: cria draft (POST /broadcasts), grava estado", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      mockFetch((call) => {
        if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
          return jsonRes(201, {
            broadcast: {
              id: 555,
              subject: (call.body as { subject: string }).subject,
              status: "draft",
              public_url: "https://news.diar.ia.br/p/555",
            },
          });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      const state = readPublishedState(editionDir);
      assert.equal(state?.broadcast_id, 555);
      assert.equal(state?.status, "draft");
      assert.equal(calls.length, 1);
      assert.deepEqual((calls[0].body as { subscriber_filter: unknown[] }).subscriber_filter, []);
      assert.equal((calls[0].body as { send_at: string | null }).send_at, null, "draft real é sempre send_at:null");
      assert.equal(
        (calls[0].body as { public: boolean }).public,
        true,
        "#6323: sem public:true o Kit nunca gera public_url com slug (confirmado ao vivo, doc oficial)",
      );
      assert.equal(
        readFileSync(join(editionDir, "_internal", "05-edition-url.txt"), "utf8"),
        "https://diar.ia.br/p/modelos-se-replicam-sozinhos",
        "#7420: 05-edition-url.txt usa a URL PRÓPRIA derivada do título do D1 " +
          "(mesma que o bloco WhatsApp já crava no e-mail), nunca o public_url do Kit " +
          "— diar.ia.br é nosso desde o cutover do apex (#467), não domínio de terceiro.",
      );
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("2ª invocação (draft já existe): PATCH em vez de criar 2º draft", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      writePublishedState(editionDir, {
        broadcast_id: 777,
        subject: "Assunto antigo",
        preview_text: "Preview antigo",
        status: "draft",
        test_broadcast_ids: [],
      });
      mockFetch((call) => {
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/777") {
          return jsonRes(200, { broadcast: { id: 777, status: "draft", public_url: "https://news.diar.ia.br/p/777" } });
        }
        throw new Error(`chamada inesperada (esperava só PATCH /broadcasts/777): ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      assert.equal(calls.length, 1);
      // Achado do review (#6080): o PATCH precisa levar o conteúdo FRESCO
      // derivado da edição atual, não os valores antigos do estado — senão
      // uma atualização de conteúdo silenciosamente não atualiza nada de
      // verdade no Kit.
      const patchBody = calls[0].body as { subject: string; preview_text: string; content: string; public: boolean };
      assert.equal(patchBody.subject, "Modelos se replicam sozinhos");
      assert.match(patchBody.content, /Modelos se replicam sozinhos/);
      assert.notEqual(patchBody.subject, "Assunto antigo");
      assert.equal(patchBody.public, true, "#6323: PATCH também precisa forçar public:true (draft antigo pode ter sido criado sem)");
      const state = readPublishedState(editionDir);
      assert.equal(state?.broadcast_id, 777);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("2ª invocação SEM --send-test após test-send anterior: status permanece test_sent, não regride pra draft (achado do review, #6080)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      writePublishedState(editionDir, {
        broadcast_id: 777,
        subject: "Assunto antigo",
        preview_text: "Preview antigo",
        status: "test_sent",
        test_broadcast_ids: [900],
      });
      mockFetch((call) => {
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/777") {
          return jsonRes(200, { broadcast: { id: 777, status: "draft", public_url: "https://news.diar.ia.br/p/777" } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      const state = readPublishedState(editionDir);
      assert.equal(state?.status, "test_sent", "atualizar conteúdo não pode apagar o fato de que um teste já foi enviado");
      assert.deepEqual(state?.test_broadcast_ids, [900], "histórico de test-sends preservado");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--send-test: cria broadcast SEPARADO escopado à tag, nunca reusa/muta o draft real (achado #464)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      const createdBroadcasts: unknown[] = [];
      mockFetch((call) => {
        if (call.method === "GET" && call.pathname === "/v4/tags") {
          return jsonRes(200, {
            tags: [{ id: 42, name: "diaria-test-email", created_at: "x" }],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          });
        }
        if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
          createdBroadcasts.push(call.body);
          const id = createdBroadcasts.length === 1 ? 555 : 556;
          return jsonRes(201, { broadcast: { id, status: "draft", public_url: `https://news.diar.ia.br/p/${id}` } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--send-test"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      assert.equal(createdBroadcasts.length, 2, "1 draft real + 1 test-send descartável");
      const testBody = createdBroadcasts[1] as { subscriber_filter: unknown[]; send_at: string };
      assert.deepEqual(testBody.subscriber_filter, [{ all: [{ type: "tag", ids: [42] }] }]);
      assert.ok(testBody.send_at, "test-send tem send_at setado — dispara de verdade");
      const realBody = createdBroadcasts[0] as { send_at: string | null };
      assert.equal(realBody.send_at, null, "draft real NUNCA leva send_at, mesmo com --send-test (senão vira completed pra sempre)");
      const state = readPublishedState(editionDir);
      assert.equal(state?.broadcast_id, 555, "estado rastreia o draft REAL, não o de teste");
      assert.deepEqual(state?.test_broadcast_ids, [556]);
      assert.equal(state?.status, "test_sent");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#7420: broadcast SEM public_url ainda grava 05-edition-url.txt (URL própria não depende do Kit)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      mockFetch((call) => {
        if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
          // public_url ausente da resposta — nunca confirmado ao vivo que o
          // Kit sempre popula este campo (ver docstring do #464 na main()).
          // Desde #7420 isso não importa mais pra 05-edition-url.txt: a URL
          // vem só do título do D1, sem depender de nenhum campo do Kit.
          return jsonRes(201, { broadcast: { id: 555, status: "draft" } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined, "public_url ausente não deve virar exitCode de erro");
      const state = readPublishedState(editionDir);
      assert.equal(state?.broadcast_id, 555, "draft real ainda é criado e rastreado normalmente");
      assert.equal(
        readFileSync(join(editionDir, "_internal", "05-edition-url.txt"), "utf8"),
        "https://diar.ia.br/p/modelos-se-replicam-sozinhos",
        "05-edition-url.txt gravado normalmente — deriva do título do D1, não do public_url",
      );
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#8208: PATCH pós-Stage-6 zera send_at do broadcast REAL já agendado — main() reagenda sozinho e preserva scheduled_at no estado", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      const scheduledAt = "2026-09-18T09:00:00.000Z";
      writePublishedState(editionDir, {
        broadcast_id: 25955349,
        subject: "Assunto antigo",
        preview_text: "Preview antigo",
        status: "scheduled",
        test_broadcast_ids: [],
        scheduled_at: scheduledAt,
      });
      let patchCount = 0;
      mockFetch((call) => {
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/25955349") {
          patchCount += 1;
          if (patchCount === 1) {
            // Reproduz o bug ao vivo (#8208, edição 260917): mesmo com
            // send_at reforçado no corpo (defesa 1), o Kit devolve o
            // broadcast como se tivesse voltado a rascunho.
            assert.equal((call.body as { send_at?: string }).send_at, scheduledAt, "defesa 1: PATCH de conteúdo já reforça send_at");
            return jsonRes(200, { broadcast: { id: 25955349, status: "draft", send_at: null } });
          }
          // 2º PATCH — reagendamento automático (defesa 2).
          assert.deepEqual(call.body, { send_at: scheduledAt }, "PATCH de reagendamento leva só send_at");
          return jsonRes(200, { broadcast: { id: 25955349, status: "scheduled", send_at: scheduledAt } });
        }
        if (call.method === "GET" && call.pathname === "/v4/broadcasts/25955349") {
          // Releitura pós-1º-PATCH confirma o zeramento (2xx da mutação não
          // é prova, #573) — dispara o reagendamento automático.
          return jsonRes(200, { broadcast: { id: 25955349, status: "draft", send_at: null } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined, "reagendamento automático bem-sucedido não é erro");
      assert.equal(patchCount, 2, "1 PATCH de conteúdo + 1 PATCH de reagendamento");
      const state = readPublishedState(editionDir);
      assert.equal(state?.broadcast_id, 25955349);
      assert.equal(state?.status, "scheduled", "status local continua scheduled");
      assert.equal(
        state?.scheduled_at,
        scheduledAt,
        "#8208: scheduled_at PRESERVADO no estado local — sem isso, a PRÓXIMA " +
          "invocação perderia existing.scheduled_at e a defesa nunca mais dispararia",
      );
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#8208: reagendamento automático também falha — main() sai com exitCode 10, nunca finge sucesso", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      const scheduledAt = "2026-09-18T09:00:00.000Z";
      writePublishedState(editionDir, {
        broadcast_id: 25955349,
        subject: "Assunto antigo",
        preview_text: "Preview antigo",
        status: "scheduled",
        test_broadcast_ids: [],
        scheduled_at: scheduledAt,
      });
      mockFetch((call) => {
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/25955349") {
          return jsonRes(200, { broadcast: { id: 25955349, status: "draft", send_at: null } });
        }
        if (call.method === "GET" && call.pathname === "/v4/broadcasts/25955349") {
          return jsonRes(200, { broadcast: { id: 25955349, status: "draft", send_at: null } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 10, "falha real de agendamento nunca deve sair como sucesso silencioso");
      // Estado NÃO deve ter sido reescrito com um broadcast_id/estado que
      // sugira sucesso — main() retorna antes de writePublishedState.
      const state = readPublishedState(editionDir);
      assert.equal(state?.scheduled_at, scheduledAt, "estado local não foi corrompido pela falha");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Nota: o exit(7) (assunto vazio) não tem teste de integração dedicado —
// `extractContent` exige 2-3 destaques reconhecíveis pra sequer devolver um
// `NewsletterContent`, então "assunto vazio" nessa camada é um estado
// inatingível sem antes falhar em `extractContent` por outro motivo (mesma
// lacuna em `publish-daily-brevo-4266.test.ts`, que também só cobre
// `checkSubjectNotEmpty` isoladamente, nunca via `main()` de ponta a ponta).
// A função pura já está coberta acima (`describe("checkSubjectNotEmpty")`).
