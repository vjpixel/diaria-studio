/**
 * test/publish-newsletter-kit.test.ts (#464)
 *
 * Cobre as funções puras (`buildKitSubject`/`buildKitPreviewText`/
 * `checkSubjectNotEmpty`/`checkKitBackendEnabled`/`buildKitHtml`) e um
 * teste de integração de ponta a ponta de `main()` (mesmo padrão de
 * `publish-daily-brevo-integration-4532.test.ts`: fixtures em disco +
 * `fetch` mockado, sem tocar `data/`/rede reais).
 */
import { describe, it, after, beforeEach, afterEach, mock } from "node:test";
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
  kitBroadcastDraftUrl,
  markUiTestSent,
  assessBroadcastStillDraft,
  resolveMarkUiTestSent,
  resolveUiTestSentAt,
  resolveVerifyUiTestDraft,
  type KitNewsletterPublished,
} from "../scripts/publish-newsletter-kit.ts";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import type { KitBroadcastDetail } from "../scripts/lib/kit-client.ts";
import { checkKitDraftFresh } from "../scripts/lib/invariant-checks/stage-6.ts"; // #9428
import { kitContentHash } from "../scripts/lib/kit-draft-freshness.ts"; // #9428
import { scheduleNewsletterKit } from "../scripts/schedule-newsletter-kit.ts"; // #9428

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
  // REGRESSÃO #11225: Beehiiv é só arquivo histórico — chave ausente é Kit.
  it("backend ausente (default kit, #11225): ok:true", () => {
    assert.deepEqual(checkKitBackendEnabled({}), { ok: true });
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

  it("#9428: grava content_hash no publish; edição posterior do 02-reviewed.md vira kit-draft-fresh; re-run limpa", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260997");
      const opts = { backend: "kit", rootDir: root };
      mockFetch((call) => {
        if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
          return jsonRes(201, { broadcast: { id: 9428, status: "draft", public_url: "https://news.diar.ia.br/p/9428" } });
        }
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/9428") {
          return jsonRes(200, { broadcast: { id: 9428, status: "draft", public_url: "https://news.diar.ia.br/p/9428" } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);

      const state = readPublishedState(editionDir);
      assert.match(state?.content_hash ?? "", /^[0-9a-f]{64}$/, "estado do publish precisa carregar content_hash (#9428)");
      const sent = calls[0].body as { subject: string; preview_text: string; content: string };
      assert.equal(
        state!.content_hash,
        kitContentHash(sent.subject, sent.preview_text, sent.content),
        "content_hash é do payload EXATO enviado ao Kit",
      );
      assert.match(state!.source_hashes?.["02-reviewed.md"] ?? "", /^[0-9a-f]{64}$/);
      assert.ok(state!.source_hashed_at);
      assert.deepEqual(checkKitDraftFresh(editionDir, opts), [], "logo após o publish não há divergência (render determinístico)");

      // Mudança que não chega ao e-mail (entrada só-social em 06-public-images.json) não acusa.
      writeFileSync(
        join(editionDir, "06-public-images.json"),
        JSON.stringify({ images: { d1_1x1: { url: "https://x/d1-1x1.jpg", file: "04-d1-1x1.jpg" } } }),
        "utf8",
      );
      assert.deepEqual(checkKitDraftFresh(editionDir, opts), [], "sem falso positivo por insumo que não vai pro e-mail");

      // Cenário da 261002: editor corrige o 02-reviewed.md depois do publish.
      const reviewedPath = join(editionDir, "02-reviewed.md");
      writeFileSync(reviewedPath, readFileSync(reviewedPath, "utf8").replace("Corpo dois.", "Corpo dois, corrigido."), "utf8");
      const v = checkKitDraftFresh(editionDir, opts);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "kit-draft-fresh");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /02-reviewed\.md/);
      assert.ok(v[0].message.includes(`publish-newsletter-kit.ts ${editionDir} --send-test`), "comando copiável, com o path real");

      // Broadcast já enviado: mensagem não manda re-publicar.
      writePublishedState(editionDir, { ...readPublishedState(editionDir)!, status: "scheduled", scheduled_at: "2026-01-01T09:00:00Z" });
      const sentV = checkKitDraftFresh(editionDir, opts);
      assert.equal(sentV.length, 1);
      assert.match(sentV[0].message, /já saiu/);
      assert.ok(!sentV[0].message.includes("--send-test"));
      const { scheduled_at: _drop, ...unscheduled } = readPublishedState(editionDir)!;
      writePublishedState(editionDir, { ...unscheduled, status: "draft" });

      // Re-rodar o publisher (PATCH idempotente) atualiza o baseline.
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      await main(root);
      assert.equal(process.exitCode, undefined);
      assert.equal(calls.at(-1)?.method, "PATCH");
      assert.deepEqual(checkKitDraftFresh(editionDir, opts), [], "re-publicar reseta o baseline");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#9428: publish que falha (exit 10) preserva o baseline antigo — o aviso continua de pé", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260996");
      writePublishedState(editionDir, {
        broadcast_id: 31,
        subject: "s",
        preview_text: "p",
        status: "draft",
        content_hash: "hash-antigo",
      });
      mockFetch(() => jsonRes(422, { errors: ["boom"] }));
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 10);
      assert.equal(readPublishedState(editionDir)?.content_hash, "hash-antigo");
      assert.equal(checkKitDraftFresh(editionDir, { backend: "kit", rootDir: root }).length, 1);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#9428: schedule-newsletter-kit preserva content_hash/source_hashes ao gravar scheduled_at", async () => {
    // #11689 — relógio fixo: o guard "não agendar no passado" compararia 2026-10-03 com o relógio real.
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") });
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      const editionDir = writeEdition(root, "260995");
      writePublishedState(editionDir, {
        broadcast_id: 32,
        subject: "s",
        preview_text: "p",
        status: "draft",
        content_hash: "h",
        source_hashes: { "02-reviewed.md": "x" },
        source_hashed_at: "2026-10-01T22:42:00Z",
      });
      let written: Record<string, unknown> | undefined;
      const result = await scheduleNewsletterKit(editionDir, "2026-10-03T09:00:00Z", {
        readPublished: (d) => readPublishedState(d),
        writePublished: (_d, s) => {
          written = s as unknown as Record<string, unknown>;
        },
        patchSchedule: async () => undefined,
        getBroadcastStatus: async () => ({ status: "scheduled", sendAt: "2026-10-03T09:00:00Z" }),
      }, { allowOtherDate: true });
      assert.equal(result.ok, true);
      assert.equal(written?.content_hash, "h");
      assert.deepEqual(written?.source_hashes, { "02-reviewed.md": "x" });
      assert.equal(written?.source_hashed_at, "2026-10-01T22:42:00Z");
    } finally {
      mock.timers.reset();
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
        test_sent_at: "2026-10-08T03:00:00.000Z",
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
      assert.equal(
        state?.test_sent_at,
        "2026-10-08T03:00:00.000Z",
        "#9906: re-run sem --send-test não pode apagar a âncora do --sent-after do §5f",
      );
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
      assert.equal(state?.test_sent_at, testBody.send_at, "#9901: âncora do --sent-after do §5f");
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

// ── #10395: Send test da UI do Kit, sem broadcast descartável ─────────

describe("#10395: helpers do teste pela UI", () => {
  const base: KitNewsletterPublished = {
    broadcast_id: 321,
    subject: "S",
    preview_text: "P",
    status: "draft",
    test_mode: "ui",
  };

  it("kitBroadcastDraftUrl aponta pro editor do rascunho", () => {
    assert.equal(kitBroadcastDraftUrl(321), "https://app.kit.com/campaigns/321/draft");
  });

  it("markUiTestSent: draft vira test_sent com âncora, modo ui e URL, sem tocar test_broadcast_ids", () => {
    const r = markUiTestSent({ ...base, test_broadcast_ids: [9] }, "2026-10-18T22:00:00.000Z");
    assert.ok(r.ok);
    assert.equal(r.state.status, "test_sent");
    assert.equal(r.state.test_sent_at, "2026-10-18T22:00:00.000Z");
    assert.equal(r.state.test_mode, "ui");
    assert.equal(r.state.ui_test_url, "https://app.kit.com/campaigns/321/draft");
    assert.deepEqual(r.state.test_broadcast_ids, [9]);
  });

  it("markUiTestSent recusa sem draft registrado, com broadcast já agendado e sem test_mode ui", () => {
    assert.equal(markUiTestSent(null, "2026-10-18T22:00:00.000Z").ok, false);
    assert.equal(markUiTestSent({ ...base, status: "scheduled" }, "2026-10-18T22:00:00.000Z").ok, false);
    const semUi = markUiTestSent({ ...base, test_mode: undefined }, "2026-10-18T22:00:00.000Z");
    assert.equal(semUi.ok, false);
    assert.match(!semUi.ok ? semUi.reason : "", /--draft-only-for-ui-test/);
    assert.equal(markUiTestSent({ ...base, test_mode: "broadcast" }, "2026-10-18T22:00:00.000Z").ok, false);
  });

  it("assessBroadcastStillDraft (#10410): só rascunho inequívoco passa", () => {
    assert.deepEqual(assessBroadcastStillDraft({ status: "draft", send_at: null, published_at: null }), { ok: true });
    for (const b of [
      { status: "scheduled", send_at: "2026-10-19T09:00:00Z", published_at: null },
      { status: "draft", send_at: "2026-10-19T09:00:00Z", published_at: null },
      { status: "draft", send_at: null, published_at: "2026-10-18T22:00:00Z" },
      { status: "completed", send_at: null, published_at: null },
      { status: "aborted", send_at: null, published_at: null },
    ]) {
      const r = assessBroadcastStillDraft(b);
      assert.equal(r.ok, false, JSON.stringify(b));
      assert.match(!r.ok ? r.reason : "", /ENVIADA ou AGENDADA/);
    }
    const semStatus = assessBroadcastStillDraft({ send_at: null, published_at: null });
    assert.ok(semStatus.ok && semStatus.warning, "status ausente: passa com aviso, decide por send_at/published_at");
  });

  it("resolveMarkUiTestSent (#10410): valida --at/estado ANTES de ler o Kit; GET só depois", async () => {
    let gets = 0;
    const deps = {
      getBroadcast: async () => {
        gets++;
        return { status: "draft", send_at: null, published_at: null };
      },
    };
    const now = Date.UTC(2026, 9, 18, 22, 0);
    const semAt = await resolveMarkUiTestSent(base, undefined, now, deps);
    assert.ok(!semAt.ok && semAt.exitCode === 1);
    const semEstado = await resolveMarkUiTestSent(null, "2026-10-18T21:59:00Z", now, deps);
    assert.ok(!semEstado.ok && semEstado.exitCode === 1);
    assert.equal(gets, 0, "nenhuma leitura quando a validação local já recusa");
    const ok = await resolveMarkUiTestSent(base, "2026-10-18T21:59:00Z", now, deps);
    assert.ok(ok.ok);
    assert.equal(ok.state.status, "test_sent");
    assert.equal(ok.state.test_sent_at, "2026-10-18T21:59:00.000Z");
    assert.equal(gets, 1);
  });

  it("resolveUiTestSentAt: --at é obrigatório (ausente/vazio = erro, nunca 'agora')", () => {
    const now = Date.UTC(2026, 9, 18, 22, 0);
    assert.equal(resolveUiTestSentAt(undefined, now).ok, false);
    assert.equal(resolveUiTestSentAt("", now).ok, false);
  });

  it("resolveUiTestSentAt: ISO com fuso é normalizado; sem fuso ou lixo é erro", () => {
    const now = Date.UTC(2026, 9, 18, 22, 0);
    assert.deepEqual(resolveUiTestSentAt("2026-10-18T19:00:00-03:00", now), { ok: true, iso: "2026-10-18T22:00:00.000Z" });
    assert.deepEqual(resolveUiTestSentAt("2026-10-18T21:59:30.123Z", now), { ok: true, iso: "2026-10-18T21:59:30.123Z" });
    assert.equal(resolveUiTestSentAt("2026-10-18T19:00:00", now).ok, false, "sem fuso = hora local da máquina");
    assert.equal(resolveUiTestSentAt("2026-10-18", now).ok, false);
    assert.equal(resolveUiTestSentAt("agora", now).ok, false);
  });

  it("resolveUiTestSentAt: futuro só até a folga de 2 min", () => {
    const now = Date.UTC(2026, 9, 18, 22, 0);
    assert.equal(resolveUiTestSentAt("2026-10-18T22:01:30Z", now).ok, true);
    assert.equal(resolveUiTestSentAt("2026-10-18T22:03:00Z", now).ok, false);
  });

  it("resolveUiTestSentAt: anterior ao source_hashed_at do draft é recusado", () => {
    const now = Date.UTC(2026, 9, 18, 22, 0);
    const draftAt = "2026-10-18T21:50:00.000Z";
    assert.equal(resolveUiTestSentAt("2026-10-18T21:49:59Z", now, draftAt).ok, false);
    assert.equal(resolveUiTestSentAt("2026-10-18T21:50:00Z", now, draftAt).ok, true);
  });
});

describe("#10395: main() com --draft-only-for-ui-test / --mark-ui-test-sent", () => {
  it("--draft-only-for-ui-test: só o draft real (1 POST), nenhum broadcast de teste nem lookup de tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      mockFetch((call) => {
        if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
          return jsonRes(201, { broadcast: { id: 555, status: "draft", public_url: "https://news.diar.ia.br/p/555" } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--draft-only-for-ui-test"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      assert.equal(calls.length, 1, "nenhum broadcast descartável — só o draft real");
      assert.equal((calls[0].body as { send_at: string | null }).send_at, null);
      const state = readPublishedState(editionDir);
      assert.equal(state?.broadcast_id, 555);
      assert.equal(state?.status, "draft", "o teste ainda não saiu — status não muda");
      assert.equal(state?.test_mode, "ui");
      assert.equal(state?.ui_test_url, "https://app.kit.com/campaigns/555/draft");
      assert.deepEqual(state?.test_broadcast_ids, []);
      assert.equal(state?.test_sent_at, undefined);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--mark-ui-test-sent --at: só o GET de leitura, grava test_sent + test_sent_at (âncora do --sent-after)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    const atIso = new Date(Date.now() - 60_000).toISOString();
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      writePublishedState(editionDir, {
        broadcast_id: 555,
        subject: "S",
        preview_text: "P",
        status: "draft",
        test_broadcast_ids: [],
        test_mode: "ui",
        ui_test_url: "https://app.kit.com/campaigns/555/draft",
      });
      mockFetch((call) => {
        // #10410: única rede permitida é a releitura (GET) do broadcast real.
        if (call.method === "GET" && call.pathname === "/v4/broadcasts/555") {
          return jsonRes(200, { broadcast: { id: 555, status: "draft", send_at: null, published_at: null } });
        }
        throw new Error(`--mark-ui-test-sent só pode ler o broadcast: ${call.method} ${call.pathname}`);
      });
      process.argv = [
        "node",
        "publish-newsletter-kit.ts",
        editionDir,
        "--mark-ui-test-sent",
        "--at",
        atIso,
      ];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      assert.deepEqual(
        calls.map((c) => `${c.method} ${c.pathname}`),
        ["GET /v4/broadcasts/555"],
        "nenhuma escrita no Kit",
      );
      const state = readPublishedState(editionDir);
      assert.equal(state?.status, "test_sent");
      assert.equal(state?.test_sent_at, atIso);
      assert.equal(state?.test_mode, "ui");
      assert.deepEqual(state?.test_broadcast_ids, [], "nenhum broadcast de teste registrado");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--mark-ui-test-sent sem draft registrado: exit 1, nada gravado", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      process.argv = [
        "node",
        "publish-newsletter-kit.ts",
        editionDir,
        "--mark-ui-test-sent",
        "--at",
        new Date(Date.now() - 60_000).toISOString(),
      ];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 1);
      assert.equal(readPublishedState(editionDir), null);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #10410: o Send test da UI opera no broadcast REAL (base inteira). Um clique
  // errado em Send/Schedule/Continue o envia ou agenda — o --mark-ui-test-sent
  // relê o broadcast e nunca grava test_sent se ele saiu do rascunho.
  const uiDraftState = (): KitNewsletterPublished => ({
    broadcast_id: 555,
    subject: "S",
    preview_text: "P",
    status: "draft",
    test_broadcast_ids: [],
    test_mode: "ui",
    ui_test_url: "https://app.kit.com/campaigns/555/draft",
  });
  const runMark = async (root: string, editionDir: string) => {
    process.argv = [
      "node",
      "publish-newsletter-kit.ts",
      editionDir,
      "--mark-ui-test-sent",
      "--at",
      new Date(Date.now() - 60_000).toISOString(),
    ];
    process.exitCode = undefined;
    await main(root);
  };

  for (const [label, remote] of [
    ["agendado pela UI (status scheduled + send_at)", { status: "scheduled", send_at: "2026-10-19T09:00:00Z", published_at: null }],
    ["enviado pela UI (status completed + published_at)", { status: "completed", send_at: "2026-10-18T22:00:00Z", published_at: "2026-10-18T22:00:05Z" }],
    ["sending sem send_at", { status: "sending", send_at: null, published_at: null }],
    ["status ausente mas send_at preenchido", { send_at: "2026-10-19T09:00:00Z", published_at: null }],
  ] as const) {
    it(`REGRESSÃO #10410: broadcast real ${label} → exit 11, test_sent NUNCA gravado`, async () => {
      const root = mkdtempSync(join(tmpdir(), "kit-main-"));
      try {
        writePlatformConfig(root, "kit");
        const editionDir = writeEdition(root, "260998");
        writePublishedState(editionDir, uiDraftState());
        mockFetch((call) => {
          if (call.method === "GET" && call.pathname === "/v4/broadcasts/555") {
            return jsonRes(200, { broadcast: { id: 555, ...remote } });
          }
          throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
        });
        await runMark(root, editionDir);
        assert.equal(process.exitCode, 11);
        assert.equal(calls.length, 1, "só a leitura — nenhuma escrita no Kit");
        const state = readPublishedState(editionDir);
        assert.equal(state?.status, "draft", "estado local intocado");
        assert.equal(state?.test_sent_at, undefined);
      } finally {
        process.exitCode = undefined;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("#10410: releitura do broadcast falha → exit 12, nada gravado (nunca marca sem confirmar)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      writePublishedState(editionDir, uiDraftState());
      mockFetch(() => jsonRes(401, { errors: ["unauthorized"] }));
      await runMark(root, editionDir);
      assert.equal(process.exitCode, 12);
      assert.equal(readPublishedState(editionDir)?.status, "draft");
      assert.equal(readPublishedState(editionDir)?.test_sent_at, undefined);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--send-test junto com --draft-only-for-ui-test: exit 1 antes de qualquer rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--send-test", "--draft-only-for-ui-test"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 1);
      assert.equal(calls.length, 0);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-run só de conteúdo depois do teste pela UI preserva test_mode/ui_test_url/test_sent_at", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      writePublishedState(editionDir, {
        broadcast_id: 777,
        subject: "S",
        preview_text: "P",
        status: "test_sent",
        test_broadcast_ids: [],
        test_sent_at: "2026-10-18T22:00:00.000Z",
        test_mode: "ui",
        ui_test_url: "https://app.kit.com/campaigns/777/draft",
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
      assert.equal(state?.status, "test_sent");
      assert.equal(state?.test_mode, "ui");
      assert.equal(state?.ui_test_url, "https://app.kit.com/campaigns/777/draft");
      assert.equal(state?.test_sent_at, "2026-10-18T22:00:00.000Z");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--send-test (fallback) continua criando o descartável e marca test_mode broadcast", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-"));
    try {
      writePlatformConfig(root, "kit");
      const editionDir = writeEdition(root, "260998");
      let posts = 0;
      mockFetch((call) => {
        if (call.method === "GET" && call.pathname === "/v4/tags") {
          return jsonRes(200, {
            tags: [{ id: 42, name: "diaria-test-email", created_at: "x" }],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          });
        }
        if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
          posts++;
          return jsonRes(201, { broadcast: { id: 550 + posts, status: "draft", public_url: "https://news.diar.ia.br/p/x" } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--send-test"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      assert.equal(posts, 2);
      const state = readPublishedState(editionDir);
      assert.equal(state?.test_mode, "broadcast");
      assert.deepEqual(state?.test_broadcast_ids, [552]);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── #10395 (fleet review): contratos endurecidos dos dois modos ─────────

describe("#10395: --draft-only-for-ui-test e --mark-ui-test-sent — recusas e encadeamento", () => {
  const uiDraft = (extra: Partial<KitNewsletterPublished> = {}): KitNewsletterPublished => ({
    broadcast_id: 555,
    subject: "S",
    preview_text: "P",
    status: "draft",
    test_broadcast_ids: [],
    test_mode: "ui",
    ui_test_url: "https://app.kit.com/campaigns/555/draft",
    ...extra,
  });

  async function runMain(root: string, editionDir: string, ...flags: string[]): Promise<void> {
    process.argv = ["node", "publish-newsletter-kit.ts", editionDir, ...flags];
    process.exitCode = undefined;
    await main(root);
  }

  function withEdition(fn: (root: string, editionDir: string) => Promise<void>): () => Promise<void> {
    return async () => {
      const root = mkdtempSync(join(tmpdir(), "kit-main-"));
      try {
        writePlatformConfig(root, "kit");
        await fn(root, writeEdition(root, "260998"));
      } finally {
        process.exitCode = undefined;
        rmSync(root, { recursive: true, force: true });
      }
    };
  }

  it(
    "--draft-only-for-ui-test depois de um teste anterior (test_sent, T1): volta pra draft e apaga test_sent_at",
    withEdition(async (root, editionDir) => {
      writePublishedState(editionDir, {
        broadcast_id: 555,
        subject: "S",
        preview_text: "P",
        status: "test_sent",
        test_broadcast_ids: [900],
        test_sent_at: "2026-10-18T10:00:00.000Z",
        test_mode: "broadcast",
      });
      mockFetch((call) => {
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/555") {
          return jsonRes(200, { broadcast: { id: 555, status: "draft", public_url: "https://news.diar.ia.br/p/555" } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      await runMain(root, editionDir, "--draft-only-for-ui-test");
      assert.equal(process.exitCode, undefined);
      const state = readPublishedState(editionDir);
      assert.equal(state?.status, "draft", "o teste novo ainda não saiu");
      assert.equal(state?.test_sent_at, undefined, "a âncora T1 não pode sobreviver — o --sent-after leria o teste antigo");
      assert.equal(state?.test_mode, "ui");
      assert.equal(state?.ui_test_url, "https://app.kit.com/campaigns/555/draft");
      assert.deepEqual(state?.test_broadcast_ids, [900], "histórico de descartáveis preservado");
    }),
  );

  it(
    "--draft-only-for-ui-test com broadcast já agendado: exit 1, sem rede, estado intacto",
    withEdition(async (root, editionDir) => {
      const scheduled = uiDraft({ status: "scheduled", scheduled_at: "2026-10-19T09:00:00.000Z" });
      writePublishedState(editionDir, scheduled);
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      await runMain(root, editionDir, "--draft-only-for-ui-test");
      assert.equal(process.exitCode, 1);
      assert.equal(calls.length, 0);
      assert.deepEqual(readPublishedState(editionDir), scheduled);
    }),
  );

  it(
    "--mark-ui-test-sent sem --at: exit 1, nada gravado",
    withEdition(async (root, editionDir) => {
      writePublishedState(editionDir, uiDraft());
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      await runMain(root, editionDir, "--mark-ui-test-sent");
      assert.equal(process.exitCode, 1);
      assert.equal(readPublishedState(editionDir)?.status, "draft");
      assert.equal(readPublishedState(editionDir)?.test_sent_at, undefined);
    }),
  );

  it(
    "--mark-ui-test-sent com --at sem valor (seguido de outra flag ou no fim): exit 1",
    withEdition(async (root, editionDir) => {
      writePublishedState(editionDir, uiDraft());
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      await runMain(root, editionDir, "--mark-ui-test-sent", "--at");
      assert.equal(process.exitCode, 1);
      await runMain(root, editionDir, "--at", "--mark-ui-test-sent");
      assert.equal(process.exitCode, 1);
      assert.equal(readPublishedState(editionDir)?.test_sent_at, undefined);
    }),
  );

  it(
    "--mark-ui-test-sent com --at anterior ao source_hashed_at do draft: exit 1",
    withEdition(async (root, editionDir) => {
      const draftAt = new Date(Date.now() - 60_000).toISOString();
      writePublishedState(editionDir, uiDraft({ source_hashed_at: draftAt }));
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      await runMain(root, editionDir, "--mark-ui-test-sent", "--at", new Date(Date.now() - 3_600_000).toISOString());
      assert.equal(process.exitCode, 1);
      assert.equal(readPublishedState(editionDir)?.test_sent_at, undefined);
    }),
  );

  it(
    "--mark-ui-test-sent sem test_mode ui no estado: exit 1 pedindo --draft-only-for-ui-test",
    withEdition(async (root, editionDir) => {
      writePublishedState(editionDir, uiDraft({ test_mode: undefined, ui_test_url: undefined }));
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      await runMain(root, editionDir, "--mark-ui-test-sent", "--at", new Date(Date.now() - 60_000).toISOString());
      assert.equal(process.exitCode, 1);
      assert.equal(readPublishedState(editionDir)?.status, "draft");
    }),
  );

  for (const mode of ["--draft-only-for-ui-test", "--mark-ui-test-sent"]) {
    it(
      `--dry-run com ${mode}: exit 1, sem rede, estado intacto`,
      withEdition(async (root, editionDir) => {
        const before = uiDraft();
        writePublishedState(editionDir, before);
        mockFetch(() => {
          throw new Error("não deveria chamar fetch");
        });
        const extra = mode === "--mark-ui-test-sent" ? ["--at", new Date(Date.now() - 60_000).toISOString()] : [];
        await runMain(root, editionDir, "--dry-run", mode, ...extra);
        assert.equal(process.exitCode, 1);
        assert.equal(calls.length, 0);
        assert.deepEqual(readPublishedState(editionDir), before);
      }),
    );
  }

  it(
    "--draft-only-for-ui-test seguido de --send-test (fallback): PATCH no mesmo draft, modo broadcast, âncora nova",
    withEdition(async (root, editionDir) => {
      let posts = 0;
      const patched: string[] = [];
      mockFetch((call) => {
        if (call.method === "GET" && call.pathname === "/v4/tags") {
          return jsonRes(200, {
            tags: [{ id: 42, name: "diaria-test-email", created_at: "x" }],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          });
        }
        if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
          posts++;
          return jsonRes(201, { broadcast: { id: 554 + posts, status: "draft", public_url: "https://news.diar.ia.br/p/x" } });
        }
        if (call.method === "PATCH") {
          patched.push(call.pathname);
          return jsonRes(200, { broadcast: { id: 555, status: "draft", public_url: "https://news.diar.ia.br/p/555" } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });

      await runMain(root, editionDir, "--draft-only-for-ui-test");
      assert.equal(process.exitCode, undefined);
      const afterUi = readPublishedState(editionDir);
      assert.equal(afterUi?.broadcast_id, 555);
      assert.equal(afterUi?.test_mode, "ui");
      assert.equal(afterUi?.test_sent_at, undefined);

      const before = Date.now();
      await runMain(root, editionDir, "--send-test");
      assert.equal(process.exitCode, undefined);
      assert.deepEqual(patched, ["/v4/broadcasts/555"], "o draft real é reaproveitado, nunca recriado");
      assert.equal(posts, 2, "1 draft real (1ª rodada) + 1 descartável (2ª)");
      const state = readPublishedState(editionDir);
      assert.equal(state?.broadcast_id, 555);
      assert.equal(state?.status, "test_sent");
      assert.equal(state?.test_mode, "broadcast");
      assert.deepEqual(state?.test_broadcast_ids, [556]);
      assert.ok(state?.test_sent_at && Date.parse(state.test_sent_at) >= before, "âncora nova do --send-test");
    }),
  );
});

// #10465: o --mark-ui-test-sent só relê o broadcast real se o agente do Chrome
// chegar ao passo 4. Se ele errar o clique e pular a marcação, nada relia o
// broadcast — o --verify-ui-test-draft é a releitura só-leitura que os
// playbooks dos Stages 5 e 6 rodam incondicionalmente.
describe("#10465: --verify-ui-test-draft (só leitura, sem --mark-ui-test-sent)", () => {
  const uiDraft = (extra: Partial<KitNewsletterPublished> = {}): KitNewsletterPublished => ({
    broadcast_id: 555,
    subject: "S",
    preview_text: "P",
    status: "draft",
    test_broadcast_ids: [],
    test_mode: "ui",
    ui_test_url: "https://app.kit.com/campaigns/555/draft",
    ...extra,
  });

  async function runVerify(root: string, editionDir: string, ...extra: string[]): Promise<string> {
    process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--verify-ui-test-draft", ...extra];
    process.exitCode = undefined;
    const origWrite = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await main(root);
    } finally {
      process.stdout.write = origWrite;
    }
    return out;
  }

  function withEdition(fn: (root: string, editionDir: string) => Promise<void>): () => Promise<void> {
    return async () => {
      const root = mkdtempSync(join(tmpdir(), "kit-verify-"));
      try {
        writePlatformConfig(root, "kit");
        await fn(root, writeEdition(root, "260997"));
      } finally {
        process.exitCode = undefined;
        rmSync(root, { recursive: true, force: true });
      }
    };
  }

  for (const [label, remote] of [
    ["agendado pela UI", { status: "scheduled", send_at: "2026-10-19T09:00:00Z", published_at: null }],
    ["enviado pela UI", { status: "completed", send_at: "2026-10-18T22:00:00Z", published_at: "2026-10-18T22:00:05Z" }],
  ] as const) {
    it(
      `REGRESSÃO #10465: passo 4 pulado (estado ui SEM test_sent_at) e broadcast real ${label} → exit 11, nada gravado`,
      withEdition(async (root, editionDir) => {
        const before = uiDraft();
        writePublishedState(editionDir, before);
        mockFetch((call) => {
          if (call.method === "GET" && call.pathname === "/v4/broadcasts/555") {
            return jsonRes(200, { broadcast: { id: 555, ...remote } });
          }
          throw new Error(`--verify-ui-test-draft só pode ler: ${call.method} ${call.pathname}`);
        });
        const out = await runVerify(root, editionDir);
        assert.equal(process.exitCode, 11);
        assert.equal(calls.length, 1, "só o GET");
        const summary = JSON.parse(out.trim());
        assert.equal(summary.ok, false);
        assert.equal(summary.exitCode, 11);
        assert.equal(summary.broadcast_id, 555);
        assert.deepEqual(readPublishedState(editionDir), before, "estado local intocado");
      }),
    );
  }

  it(
    "broadcast real em rascunho → exit 0, checked:true, nada gravado (test_sent_at segue ausente)",
    withEdition(async (root, editionDir) => {
      const before = uiDraft();
      writePublishedState(editionDir, before);
      mockFetch(() => jsonRes(200, { broadcast: { id: 555, status: "draft", send_at: null, published_at: null } }));
      const out = await runVerify(root, editionDir);
      assert.equal(process.exitCode, undefined);
      assert.deepEqual(JSON.parse(out.trim()), { ok: true, checked: true, broadcast_id: 555 });
      assert.deepEqual(readPublishedState(editionDir), before);
    }),
  );

  it(
    "também roda depois do --mark-ui-test-sent (status test_sent) — releitura idempotente",
    withEdition(async (root, editionDir) => {
      writePublishedState(editionDir, uiDraft({ status: "test_sent", test_sent_at: "2026-10-18T20:00:00.000Z" }));
      mockFetch(() => jsonRes(200, { broadcast: { id: 555, status: "scheduled", send_at: "2026-10-19T09:00:00Z" } }));
      await runVerify(root, editionDir);
      assert.equal(process.exitCode, 11);
    }),
  );

  it(
    "releitura falha → exit 12, nada gravado",
    withEdition(async (root, editionDir) => {
      const before = uiDraft();
      writePublishedState(editionDir, before);
      mockFetch(() => jsonRes(401, { errors: ["unauthorized"] }));
      await runVerify(root, editionDir);
      assert.equal(process.exitCode, 12);
      assert.deepEqual(readPublishedState(editionDir), before);
    }),
  );

  const sendTestOnly: KitNewsletterPublished = {
    broadcast_id: 555,
    subject: "S",
    preview_text: "P",
    status: "test_sent",
    test_broadcast_ids: [556],
    test_mode: "broadcast",
  };
  for (const [label, state] of [
    ["sem estado", null],
    [
      "test_mode broadcast sem ui_test_url (--send-test puro, UI nunca usada)",
      sendTestOnly,
    ],
    ["status scheduled (agendamento legítimo da Etapa 6)", uiDraft({ status: "scheduled", scheduled_at: "2026-10-19T09:00:00Z" })],
  ] as const) {
    it(
      `não se aplica — ${label}: exit 0, checked:false, ZERO rede`,
      withEdition(async (root, editionDir) => {
        if (state) writePublishedState(editionDir, state);
        mockFetch((call) => {
          throw new Error(`rede inesperada: ${call.method} ${call.pathname}`);
        });
        const out = await runVerify(root, editionDir);
        assert.equal(process.exitCode, undefined);
        assert.equal(calls.length, 0);
        const summary = JSON.parse(out.trim());
        assert.equal(summary.checked, false);
        assert.deepEqual(readPublishedState(editionDir), state, "nada gravado");
      }),
    );
  }

  // #10538: o fallback --send-test (playbook do Stage 5, "tela inesperada" na
  // UI) sobrescreve test_mode pra "broadcast". Antes do fix, o verify olhava
  // só o test_mode atual e respondia checked:false — desligando a releitura
  // justamente no cenário de clique errado em Send/Schedule no broadcast real.
  for (const [label, remote] of [
    ["enviado por clique errado na UI", { status: "completed", send_at: "2026-10-18T22:00:00Z", published_at: "2026-10-18T22:00:05Z" }],
    ["agendado por clique errado na UI", { status: "scheduled", send_at: "2026-10-19T09:00:00Z", published_at: null }],
  ] as const) {
    it(
      `REGRESSÃO #10538: --draft-only-for-ui-test → --send-test (fallback) → verify relê o real ${label} → exit 11`,
      withEdition(async (root, editionDir) => {
        let posts = 0;
        mockFetch((call) => {
          if (call.method === "GET" && call.pathname === "/v4/tags") {
            return jsonRes(200, {
              tags: [{ id: 42, name: "diaria-test-email", created_at: "x" }],
              pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
            });
          }
          if (call.method === "POST" && call.pathname === "/v4/broadcasts") {
            posts++;
            return jsonRes(201, { broadcast: { id: 554 + posts, status: "draft", public_url: "https://news.diar.ia.br/p/x" } });
          }
          if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/555") {
            return jsonRes(200, { broadcast: { id: 555, status: "draft", public_url: "https://news.diar.ia.br/p/555" } });
          }
          throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
        });
        process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--draft-only-for-ui-test"];
        process.exitCode = undefined;
        await main(root);
        process.argv = ["node", "publish-newsletter-kit.ts", editionDir, "--send-test"];
        await main(root);
        assert.equal(process.exitCode, undefined);
        const afterFallback = readPublishedState(editionDir);
        assert.equal(afterFallback?.test_mode, "broadcast", "pré-condição: o fallback trocou o modo");
        assert.equal(afterFallback?.ui_test_url, "https://app.kit.com/campaigns/555/draft", "ui_test_url sobrevive ao fallback");

        mockFetch((call) => {
          if (call.method === "GET" && call.pathname === "/v4/broadcasts/555") {
            return jsonRes(200, { broadcast: { id: 555, ...remote } });
          }
          throw new Error(`--verify-ui-test-draft só pode ler: ${call.method} ${call.pathname}`);
        });
        const out = await runVerify(root, editionDir);
        assert.equal(process.exitCode, 11);
        const summary = JSON.parse(out.trim());
        assert.equal(summary.ok, false);
        assert.equal(summary.broadcast_id, 555);
        assert.deepEqual(readPublishedState(editionDir), afterFallback, "verify nunca grava");
      }),
    );
  }

  it("REGRESSÃO #10538 (pure): test_mode broadcast + ui_test_url gravado → relê (checked:true)", async () => {
    let gets = 0;
    const r = await resolveVerifyUiTestDraft(uiDraft({ test_mode: "broadcast", status: "test_sent" }), {
      getBroadcast: async () => {
        gets++;
        return { status: "draft", send_at: null, published_at: null };
      },
    });
    assert.equal(gets, 1);
    assert.deepEqual(r, { ok: true, checked: true, broadcast_id: 555 });
  });

  it(
    "mutuamente exclusivo com --mark-ui-test-sent: exit 1 antes de qualquer rede",
    withEdition(async (root, editionDir) => {
      writePublishedState(editionDir, uiDraft());
      mockFetch((call) => {
        throw new Error(`rede inesperada: ${call.method} ${call.pathname}`);
      });
      await runVerify(root, editionDir, "--mark-ui-test-sent", "--at", new Date().toISOString());
      assert.equal(process.exitCode, 1);
      assert.equal(calls.length, 0);
    }),
  );

  it("pure: status ausente com send_at/published_at nulos → ok com warning", async () => {
    const r = await resolveVerifyUiTestDraft(uiDraft(), { getBroadcast: async () => ({ send_at: null, published_at: null }) });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.checked && r.warning !== undefined, true);
  });
});

// ── #10437: wiring da audiência por segmento no main() ────────────────

describe("main() — audiência da diária por segmento (#10437)", () => {
  function writeConfigWithSegment(root: string, segment: { enabled: boolean; segment_id: number | null }): void {
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ publishing: { newsletter: { backend: "kit" } }, kit: { diaria_exclusion_segment: segment } }),
      "utf8",
    );
  }

  it("segmento ligado mas ausente da conta: exit 13, nenhum broadcast criado", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-10437-"));
    try {
      writeConfigWithSegment(root, { enabled: true, segment_id: 99 });
      const editionDir = writeEdition(root, "260998");
      mockFetch((call) => {
        if (call.method === "GET" && call.pathname === "/v4/segments") {
          return jsonRes(200, { segments: [{ id: 1, name: "outro" }], pagination: { has_next_page: false, end_cursor: null } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 13);
      assert.ok(!calls.some((c) => c.pathname === "/v4/broadcasts" && c.method === "POST"));
      assert.equal(readPublishedState(editionDir), null);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("segmento desligado com contatos kit-sem-abertura: em in_brevo no store: exit 13, nenhuma rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-10437-"));
    try {
      writeConfigWithSegment(root, { enabled: false, segment_id: null });
      const editionDir = writeEdition(root, "260998");
      mkdirSync(join(root, "data/brevo-diaria"), { recursive: true });
      writeFileSync(
        join(root, "data/brevo-diaria/contacts.json"),
        JSON.stringify({ contacts: [{ email: "m@x.com", beehiiv_subscription_id: "kit-sem-abertura:42", status: "in_brevo" }] }),
        "utf8",
      );
      mockFetch(() => {
        throw new Error("não deveria chamar fetch");
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 13);
      assert.equal(calls.length, 0);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("draft existente + segmento ligado: o PATCH leva subscriber_filter do segmento e a releitura confirma", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-10437-"));
    try {
      writeConfigWithSegment(root, { enabled: true, segment_id: 99 });
      const editionDir = writeEdition(root, "260998");
      writePublishedState(editionDir, { broadcast_id: 777, subject: "a", preview_text: "b", status: "draft", test_broadcast_ids: [] });
      const segmentFilter = [{ all: [{ type: "segment", ids: [99] }] }];
      mockFetch((call) => {
        if (call.method === "GET" && call.pathname === "/v4/segments") {
          return jsonRes(200, { segments: [{ id: 99, name: "ativos sem envio-brevo" }], pagination: { has_next_page: false, end_cursor: null } });
        }
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/777") {
          return jsonRes(200, { broadcast: { id: 777, status: "draft", public_url: "https://news.diar.ia.br/p/777" } });
        }
        if (call.method === "GET" && call.pathname === "/v4/broadcasts/777") {
          return jsonRes(200, { broadcast: { id: 777, status: "draft", send_at: null, subscriber_filter: segmentFilter } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, undefined);
      const patch = calls.find((c) => c.method === "PATCH");
      assert.deepEqual((patch!.body as { subscriber_filter: unknown }).subscriber_filter, segmentFilter);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-run sobre broadcast JÁ agendado com a releitura divergente: desagenda, estado local vira draft, exit 13", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-10437-"));
    try {
      writeConfigWithSegment(root, { enabled: true, segment_id: 99 });
      const editionDir = writeEdition(root, "260998");
      writePublishedState(editionDir, {
        broadcast_id: 777,
        subject: "a",
        preview_text: "b",
        status: "scheduled",
        scheduled_at: "2026-10-20T09:00:00.000Z",
        test_broadcast_ids: [],
      });
      let sendAt: string | null = "2026-10-20T09:00:00.000Z";
      mockFetch((call) => {
        if (call.method === "GET" && call.pathname === "/v4/segments") {
          return jsonRes(200, { segments: [{ id: 99, name: "s" }], pagination: { has_next_page: false, end_cursor: null } });
        }
        if (call.method === "PATCH" && call.pathname === "/v4/broadcasts/777") {
          const body = call.body as { send_at?: string | null };
          if ("send_at" in body) sendAt = body.send_at ?? null;
          return jsonRes(200, { broadcast: { id: 777, status: sendAt ? "scheduled" : "draft", send_at: sendAt, public_url: "u" } });
        }
        if (call.method === "GET" && call.pathname === "/v4/broadcasts/777") {
          // O Kit "perdeu" o filtro: devolve a base inteira.
          return jsonRes(200, { broadcast: { id: 777, status: sendAt ? "scheduled" : "draft", send_at: sendAt, subscriber_filter: [] } });
        }
        throw new Error(`chamada inesperada: ${call.method} ${call.pathname}`);
      });
      process.argv = ["node", "publish-newsletter-kit.ts", editionDir];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 13);
      assert.equal(sendAt, null, "agendamento desfeito");
      const state = readPublishedState(editionDir);
      assert.equal(state?.status, "draft");
      assert.equal(state?.scheduled_at, undefined);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
