/**
 * test/publish-monthly-apoiadores-kit.test.ts (#7633)
 *
 * Cobre `scripts/publish-monthly-apoiadores-kit.ts` — o Passo 2 da skill
 * `/diaria-mensal-apoiadores` no canal atual (Kit), sucessor do publisher
 * Brevo (#4593, que nunca chegou a criar uma campanha real).
 *
 * O que os testes travam, e por que cada um importa:
 *
 *   - **Payload sempre rascunho e sempre com filtro de tag.** `send_at`
 *     presente agenda um envio real; `subscriber_filter` ausente/vazio no Kit
 *     significa BASE INTEIRA (#6126) — o conteúdo exclusivo de apoiador indo
 *     pra todo mundo. Os dois são verificados por chave, não por substring.
 *   - **`public: false`.** A anual e a diária passam `public: true` pra ganhar
 *     `public_url` (#6323); aqui isso publicaria na web a recompensa paga.
 *   - **Guards de audiência antes de criar.** Tag não resolvida ou vazia =>
 *     exit(2) e NENHUMA criação.
 *   - **Idempotência.** `kitBroadcastId` já gravado ou ciclo `sent` bloqueiam
 *     sem `--force`; após criar, o id vai pro state.
 *
 * `main()` recebe todos os deps injetados (render, state, ops do Kit) —
 * `monthlyDir()` resolve sempre contra `data/monthly/` REAL e não é
 * fixture-ável, mesma limitação aceita pelos testes do publisher Brevo.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApoiadoresKitBroadcastInput,
  buildApoiadoresKitDescription,
  main,
  verifyAudienceFilter,
  type ApoiadoresKitDeps,
  type ApoiadoresKitEmailContent,
} from "../scripts/publish-monthly-apoiadores-kit.ts";
import type { RenderedMonthlyApoiadoresKitEmail } from "../scripts/render-monthly-apoiadores-kit.ts";
import type { ApoiadoresState } from "../scripts/lib/mensal/monthly-apoiadores-state.ts";
import { buildTagFilter, type CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import { resolveApoiadoresAudience } from "../scripts/lib/mensal/apoiadores-kit-channel.ts";

const CONTENT: ApoiadoresKitEmailContent = {
  subject: "Assunto de teste",
  previewText: "Preview de teste",
  html: "<html><body>oi</body></html>",
};

const FAKE_RENDERED: RenderedMonthlyApoiadoresKitEmail = {
  cycle: "2607-08",
  yymm: "2607",
  subject: CONTENT.subject,
  previewText: CONTENT.previewText,
  html: CONTENT.html,
  htmlPath: "/fake/path/apoiadores-kit-preview.html",
};

/**
 * #7651: o builder passou a exigir `ResolvedAudienceTag` — prova de tipo de que
 * os 3 guards de audiência rodaram. Os testes constroem a prova pelo caminho
 * REAL (`resolveApoiadoresAudience` sobre os 3 resultados), não por cast: se
 * amanhã a função exigir um 4º guard, estes testes quebram, que é o ponto.
 */
const AUDIENCIA = resolveApoiadoresAudience(
  { ok: true, tagName: "apoio-mensal" },
  { ok: true, tagId: 42 },
  { ok: true, memberCount: 8 }, // #7681: o guard devolve o tamanho que validou
)!;

describe("#7633 — buildApoiadoresKitBroadcastInput", () => {
  it("monta subject/content/preview_text/description a partir do render e do ciclo", () => {
    const input = buildApoiadoresKitBroadcastInput(CONTENT, "2607-08", AUDIENCIA);
    assert.equal(input.subject, CONTENT.subject);
    assert.equal(input.content, CONTENT.html);
    assert.equal(input.preview_text, CONTENT.previewText);
    assert.equal(input.description, "diar.ia.br mensal apoiadores — 2607-08");
  });

  it("send_at é SEMPRE null — rascunho, nunca agenda", () => {
    const input = buildApoiadoresKitBroadcastInput(CONTENT, "2607-08", AUDIENCIA);
    assert.equal(input.send_at, null);
  });

  it("subscriber_filter é SEMPRE a tag resolvida — nunca vazio (vazio = base inteira, #6126)", () => {
    const input = buildApoiadoresKitBroadcastInput(CONTENT, "2607-08", AUDIENCIA);
    assert.deepEqual(input.subscriber_filter, [{ all: [{ type: "tag", ids: [42] }] }]);
  });

  it("public: false — a recompensa de apoiador não vira página pública (diferente da anual/diária)", () => {
    assert.equal(buildApoiadoresKitBroadcastInput(CONTENT, "2607-08", AUDIENCIA).public, false);
  });

  it("buildApoiadoresKitDescription inclui o ciclo pra rastreabilidade no painel", () => {
    assert.equal(buildApoiadoresKitDescription("2607-08"), "diar.ia.br mensal apoiadores — 2607-08");
  });
});

// ── main() — deps injetados ────────────────────────────────────────────────

const originalExit = process.exit;
const originalArgv = process.argv;
let exitCode: number | null = null;

function mockProcessExit(): void {
  exitCode = null;
  // Sem `@ts-expect-error`: o corpo sempre lança, então o retorno infere
  // `never` e a atribuição já bate com `process.exit` — a diretiva ficaria
  // "não usada" e o typecheck-ratchet trataria isso como erro novo.
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__mocked_exit__");
  };
}

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "publish-monthly-apoiadores-kit-test-"));
}

function writePlatformConfig(root: string, audienceTag: string | null): void {
  const cfg = audienceTag === null ? {} : { kit_apoiadores: { audience_tag: audienceTag } };
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg), "utf8");
}

interface Spy {
  deps: ApoiadoresKitDeps;
  created: CreateBroadcastInput[];
  written: { dir: string; state: ApoiadoresState }[];
  renderCalls: string[];
}

/** Deps felizes por padrão; cada teste sobrescreve só o que quer estressar. */
function makeSpy(overrides: Partial<ApoiadoresKitDeps> = {}, existing: ApoiadoresState | null = null): Spy {
  const created: CreateBroadcastInput[] = [];
  const written: { dir: string; state: ApoiadoresState }[] = [];
  const renderCalls: string[] = [];
  const deps: ApoiadoresKitDeps = {
    renderEmail: (cycle) => {
      renderCalls.push(cycle);
      return FAKE_RENDERED;
    },
    readState: () => existing,
    writeState: (dir, state) => written.push({ dir, state }),
    findTagId: async () => 42,
    countTagMembers: async () => 7,
    createBroadcast: async (input) => {
      created.push(input);
      return { id: 999 };
    },
    // Default do caminho feliz: a releitura ecoa exatamente o filtro enviado.
    getBroadcast: async () => ({ subscriber_filter: [{ all: [{ type: "tag", ids: [42] }] }] }),
    ...overrides,
  };
  return { deps, created, written, renderCalls };
}

function silenceStderr(): () => void {
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stderr.write = real;
  };
}

describe("#7633 — main()", () => {
  afterEach(() => {
    process.exit = originalExit;
    process.argv = originalArgv;
    delete process.env.KIT_API_KEY;
  });

  it("cria o broadcast como rascunho e grava o kitBroadcastId no state", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const spy = makeSpy();
      await main(root, spy.deps);

      assert.equal(exitCode, null, "não deveria ter chamado process.exit");
      assert.deepEqual(spy.renderCalls, ["2607-08"]);
      assert.equal(spy.created.length, 1);
      assert.equal(spy.created[0].send_at, null);
      assert.deepEqual(spy.created[0].subscriber_filter, [{ all: [{ type: "tag", ids: [42] }] }]);
      assert.equal(spy.written.length, 1);
      assert.equal(spy.written[0].state.kitBroadcastId, 999);
      assert.equal(spy.written[0].state.status, "draft_prepared");
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("audience_tag ausente na config: exit(2), sem render e sem criação — vale até em --dry-run", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, null);
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08", "--dry-run"];
      mockProcessExit();

      const spy = makeSpy();
      await assert.rejects(() => main(root, spy.deps), /__mocked_exit__/);
      assert.equal(exitCode, 2);
      assert.deepEqual(spy.renderCalls, [], "sem audiência configurada não faz sentido nem renderizar");
      assert.equal(spy.created.length, 0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tag não existe no Kit (findTagId -> null): exit(2), NENHUM broadcast criado", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const spy = makeSpy({ findTagId: async () => null });
      await assert.rejects(() => main(root, spy.deps), /__mocked_exit__/);
      assert.equal(exitCode, 2);
      assert.equal(spy.created.length, 0, "tag não resolvida NUNCA pode virar broadcast (filtro vazio = base inteira)");
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tag resolvida mas VAZIA: exit(2), NENHUM broadcast criado", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const spy = makeSpy({ countTagMembers: async () => 0 });
      await assert.rejects(() => main(root, spy.deps), /__mocked_exit__/);
      assert.equal(exitCode, 2);
      assert.equal(spy.created.length, 0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("KIT_API_KEY ausente: exit(2) sem criar nada", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      delete process.env.KIT_API_KEY;
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const spy = makeSpy();
      await assert.rejects(() => main(root, spy.deps), /__mocked_exit__/);
      assert.equal(exitCode, 2);
      assert.equal(spy.created.length, 0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run: renderiza e reporta, mas NUNCA toca o Kit nem o state", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      // Sem KIT_API_KEY de propósito: dry-run não pode exigir credencial.
      delete process.env.KIT_API_KEY;
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08", "--dry-run"];
      mockProcessExit();

      let readStateCalls = 0;
      const spy = makeSpy({
        readState: () => {
          readStateCalls++;
          return null;
        },
      });
      await main(root, spy.deps);

      assert.equal(exitCode, null);
      assert.deepEqual(spy.renderCalls, ["2607-08"]);
      assert.equal(spy.created.length, 0, "dry-run nunca cria broadcast");
      assert.equal(spy.written.length, 0, "dry-run nunca grava state");
      assert.equal(readStateCalls, 0, "dry-run nunca lê o state — preview local é sempre seguro de repetir");
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("idempotência: kitBroadcastId já gravado bloqueia com exit(2) e não cria um 2º rascunho", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const existing: ApoiadoresState = {
        cycle: "2607-08",
        status: "draft_prepared",
        preparedAt: "2026-08-04T10:00:00.000Z",
        sentAt: null,
        htmlPath: "/x/y.html",
        subject: "Assunto",
        segments: [],
        brevoCampaignId: null,
        kitBroadcastId: 111,
        kitAudienceVerified: null,
      };
      const spy = makeSpy({}, existing);
      await assert.rejects(() => main(root, spy.deps), /__mocked_exit__/);
      assert.equal(exitCode, 2);
      assert.equal(spy.created.length, 0);
      assert.deepEqual(spy.renderCalls, [], "guard de idempotência roda ANTES do render");
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--force ignora a idempotência e cria outro rascunho", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08", "--force"];
      mockProcessExit();

      const existing: ApoiadoresState = {
        cycle: "2607-08",
        status: "draft_prepared",
        preparedAt: "2026-08-04T10:00:00.000Z",
        sentAt: null,
        htmlPath: "/x/y.html",
        subject: "Assunto",
        segments: [],
        brevoCampaignId: null,
        kitBroadcastId: 111,
        kitAudienceVerified: null,
      };
      const spy = makeSpy({}, existing);
      await main(root, spy.deps);

      assert.equal(spy.created.length, 1);
      assert.equal(spy.written[0].state.kitBroadcastId, 999, "o id novo substitui o anterior no registro");
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TOCTOU: ciclo marcado 'sent' durante a criação -> lança e NÃO sobrescreve o state", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const sentLater: ApoiadoresState = {
        cycle: "2607-08",
        status: "sent",
        preparedAt: "2026-08-04T10:00:00.000Z",
        sentAt: "2026-08-04T11:00:00.000Z",
        htmlPath: "/x/y.html",
        subject: "Assunto",
        segments: [],
        brevoCampaignId: null,
        kitBroadcastId: null,
        kitAudienceVerified: null,
      };
      let readCount = 0;
      const spy = makeSpy({
        // 1ª leitura (guard) devolve "nada ainda"; a 2ª (pré-escrita) já vê o
        // --mark-sent concorrente.
        readState: () => (readCount++ === 0 ? null : sentLater),
      });

      await assert.rejects(() => main(root, spy.deps), /race de idempotência/);
      assert.equal(spy.created.length, 1, "o broadcast chegou a ser criado — é justamente o cenário do aviso");
      assert.equal(spy.written.length, 0, "o state 'sent' NUNCA pode ser sobrescrito de volta pra draft_prepared");
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── verificação de audiência pós-criação (#7633) ───────────────────────────
//
// O 2xx da criação não prova que o `subscriber_filter` pegou. Este bloco é a
// tradução direta do achado do silent-failure-hunter: sem releitura, um Kit
// que aceitasse a chamada e ignorasse o filtro produziria um rascunho mirando
// a base INTEIRA, e o script reportaria sucesso.

describe("#7633 — verifyAudienceFilter", () => {
  const expected = buildTagFilter(42);

  it("filtro relido idêntico -> verified true", () => {
    assert.deepEqual(verifyAudienceFilter([{ all: [{ type: "tag", ids: [42] }] }], expected), { verified: true });
  });

  it("filtro relido DIFERENTE -> verified false, com o esperado e o recebido na razão", () => {
    const r = verifyAudienceFilter([{ all: [{ type: "tag", ids: [7] }] }], expected);
    assert.equal(r.verified, false);
    if (r.verified === false) {
      assert.match(r.reason, /DIVERGENTE/);
      assert.match(r.reason, /42/);
      assert.match(r.reason, /7/);
    }
  });

  it("filtro VAZIO relido -> verified false (vazio no Kit = base inteira, o pior caso)", () => {
    const r = verifyAudienceFilter([], expected);
    assert.equal(r.verified, false);
  });

  it("campo ausente na releitura -> verified null (não confirmável), nunca true", () => {
    const r = verifyAudienceFilter(undefined, expected);
    assert.equal(r.verified, null);
    if (r.verified === null) assert.match(r.reason, /NÃO confirmada/);
  });
});

describe("#7633 — main(): audiência divergente na releitura", () => {
  afterEach(() => {
    process.exit = originalExit;
    process.argv = originalArgv;
    delete process.env.KIT_API_KEY;
  });

  it("aborta ALTO, mas grava o kitBroadcastId com kitAudienceVerified:false antes (senão a reexecução duplica)", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const spy = makeSpy({
        // A API respondeu 2xx na criação, mas aplicou um filtro diferente.
        getBroadcast: async () => ({ subscriber_filter: [] }),
      });
      await assert.rejects(() => main(root, spy.deps), /AUDIÊNCIA NÃO CONFERE/);

      assert.equal(spy.created.length, 1, "o broadcast chegou a ser criado — é o cenário do alerta");
      assert.equal(spy.written.length, 1, "o id precisa ficar gravado, senão o guard não bloqueia a reexecução");
      assert.equal(spy.written[0].state.kitBroadcastId, 999);
      assert.equal(spy.written[0].state.kitAudienceVerified, false);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releitura que FALHA (rede) é fail-soft: grava kitAudienceVerified null e não aborta", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const spy = makeSpy({
        getBroadcast: async () => {
          throw new Error("ECONNRESET");
        },
      });
      await main(root, spy.deps);

      // O broadcast já existe independente da releitura — derrubar o comando
      // aqui não desfaria nada e ainda deixaria o operador sem o registro.
      assert.equal(spy.written.length, 1);
      assert.equal(spy.written[0].state.kitAudienceVerified, null);
      assert.equal(spy.written[0].state.kitBroadcastId, 999);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caminho feliz grava kitAudienceVerified:true", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const spy = makeSpy();
      await main(root, spy.deps);
      assert.equal(spy.written[0].state.kitAudienceVerified, true);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#7633 — main(): corrida de dois publishers", () => {
  afterEach(() => {
    process.exit = originalExit;
    process.argv = originalArgv;
    delete process.env.KIT_API_KEY;
  });

  it("outra invocação gravou um kitBroadcastId diferente durante a criação -> lança e NÃO sobrescreve", async () => {
    const root = mkTmpRoot();
    const restore = silenceStderr();
    try {
      writePlatformConfig(root, "apoio-mensal");
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2607-08"];
      mockProcessExit();

      const doOutro: ApoiadoresState = {
        cycle: "2607-08",
        status: "draft_prepared",
        preparedAt: "2026-08-04T10:00:00.000Z",
        sentAt: null,
        htmlPath: "/x/y.html",
        subject: "Assunto",
        segments: [],
        brevoCampaignId: null,
        kitBroadcastId: 555,
        kitAudienceVerified: true,
      };
      let readCount = 0;
      // 1ª leitura (guard de idempotência) não vê nada; a 2ª (pré-escrita) já
      // vê o rascunho que o outro processo criou em paralelo.
      const spy = makeSpy({ readState: () => (readCount++ === 0 ? null : doOutro) });

      await assert.rejects(() => main(root, spy.deps), /race de idempotência/);
      assert.equal(spy.created.length, 1, "os dois processos criaram rascunho — é justamente o que o erro relata");
      assert.equal(spy.written.length, 0, "não pode sobrescrever o id do outro processo em silêncio");
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
