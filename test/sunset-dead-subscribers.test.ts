/**
 * test/sunset-dead-subscribers.test.ts (#5807)
 *
 * Cobre: (a) o critério de seleção (abertura <=10% E clique zero — e o
 * guard "tem clique mas abertura baixa" NUNCA entra), (b) dry-run não faz
 * chamada de rede/escrita, (c) guard de blast radius, (d) modo push (com
 * fetch mockado) chama unsubscribe + ingere no funil + grava jsonl de
 * auditoria.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUNSET_THRESHOLDS,
  BLAST_RADIUS_THRESHOLD,
  SNAPSHOT_MAX_AGE_DAYS,
  computeOpenRatePct,
  daysSinceSubscribed,
  isDeadSubscriber,
  sunsetInputFromBeehiivSubscriber,
  selectDeadSubscribers,
  evaluateBlastRadiusGuard,
  applyQueueCapGate,
  excludeAlreadyInStore,
  computeSnapshotAgeDays,
  ensureFreshSnapshot,
  appendSunsetRoundLog,
  unsubscribeFromBeehiiv,
  appendSunsetLog,
  applySunsetOne,
  formatDryRunReport,
  type SunsetInput,
  type SunsetRoundLogEntry,
} from "../scripts/sunset-dead-subscribers.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Data de referência fixa pros testes (não usa relógio real — mesma
// disciplina do resto do repo). `OLD_SUBSCRIBED_AT` é bem mais que
// `subscribedMinDays` (60) antes dela, então os testes que não são sobre
// idade de cadastro continuam exercitando só o que testavam antes do #5849.
const REFERENCE_DATE = "2026-08-16";
const OLD_SUBSCRIBED_AT = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);

function sub(overrides: Partial<SunsetInput> = {}): SunsetInput {
  return {
    email: "a@b.com",
    status: "active",
    totalReceived: 30,
    totalUniqueOpened: 1,
    totalUniqueClicked: 0,
    subscribedAt: OLD_SUBSCRIBED_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeOpenRatePct
// ---------------------------------------------------------------------------

describe("computeOpenRatePct", () => {
  it("calcula aberturas/recebidas × 100", () => {
    assert.equal(computeOpenRatePct(3, 30), 10);
  });

  it("received <= 0 retorna 0, não NaN/Infinity", () => {
    assert.equal(computeOpenRatePct(5, 0), 0);
    assert.equal(computeOpenRatePct(0, 0), 0);
    assert.equal(computeOpenRatePct(5, -1), 0);
  });

  it("opened inválido/negativo retorna 0", () => {
    assert.equal(computeOpenRatePct(-1, 100), 0);
    assert.equal(computeOpenRatePct(NaN, 100), 0);
  });
});

// ---------------------------------------------------------------------------
// isDeadSubscriber — critério de seleção (guard crítico da issue)
// ---------------------------------------------------------------------------

describe("isDeadSubscriber", () => {
  it("seleciona: active, >=20 recebidas, cadastro maduro, abertura <=10%, zero cliques", () => {
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 20, totalUniqueOpened: 2, totalUniqueClicked: 0 }), REFERENCE_DATE),
      true,
    );
  });

  it("GUARD CRÍTICO: abertura baixa MAS com clique NUNCA é sunset (leitor real com pixel bloqueado)", () => {
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 1, totalUniqueClicked: 1 }), REFERENCE_DATE),
      false,
      "1 clique já basta pra excluir, mesmo com abertura de 3%",
    );
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 100, totalUniqueOpened: 0, totalUniqueClicked: 5 }), REFERENCE_DATE),
      false,
      "zero abertura mas cliques reais — nunca sunset",
    );
  });

  it("status diferente de active nunca é sunset", () => {
    assert.equal(isDeadSubscriber(sub({ status: "inactive", totalUniqueOpened: 0 }), REFERENCE_DATE), false);
    assert.equal(isDeadSubscriber(sub({ status: "pending", totalUniqueOpened: 0 }), REFERENCE_DATE), false);
  });

  it("recebidas abaixo do piso (20) nunca é sunset, mesmo com abertura/clique zerados", () => {
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 19, totalUniqueOpened: 0, totalUniqueClicked: 0 }), REFERENCE_DATE),
      false,
    );
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 5, totalUniqueOpened: 0, totalUniqueClicked: 0 }), REFERENCE_DATE),
      false,
    );
  });

  it("abertura acima de 10% nunca é sunset, mesmo com zero cliques", () => {
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 4, totalUniqueClicked: 0 }), REFERENCE_DATE),
      false,
    ); // 13.3%
  });

  it("abertura exatamente no limiar (10%) É sunset — <=, não <", () => {
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 3, totalUniqueClicked: 0 }), REFERENCE_DATE),
      true,
    ); // 10.0%
  });

  it("respeita thresholds customizados (parâmetro, não hardcoded)", () => {
    const custom = { receivedMin: 10, openRateMaxPct: 5, subscribedMinDays: 30 };
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 10, totalUniqueOpened: 0, totalUniqueClicked: 0 }), REFERENCE_DATE, custom),
      true,
    );
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 2, totalUniqueClicked: 0 }), REFERENCE_DATE, custom),
      false,
      "6.6% > 5% no threshold customizado",
    );
  });

  // #5849: piso combinado (recebidas E idade de cadastro) — decisão do
  // editor pra separar assinante morto de verdade de recém-chegado dentro
  // da janela de formação de hábito / medição de campanha (#5734/#4556).
  describe("piso de idade de cadastro (#5849)", () => {
    it("recém-chegado (< subscribedMinDays) nunca é sunset, mesmo com received/abertura/clique batendo", () => {
      const subscribedAt30DaysAgo = Math.floor(Date.parse(`${REFERENCE_DATE}T00:00:00Z`) / 1000) - 30 * 86400;
      assert.equal(
        isDeadSubscriber(
          sub({ totalReceived: 30, totalUniqueOpened: 0, totalUniqueClicked: 0, subscribedAt: subscribedAt30DaysAgo }),
          REFERENCE_DATE,
        ),
        false,
        "30 dias de cadastro < subscribedMinDays (60) — nunca sunset, mesmo morto por todo o resto",
      );
    });

    it("cadastro exatamente no limiar (subscribedMinDays) É sunset — >=, não >", () => {
      const subscribedAtExactly60DaysAgo = Math.floor(Date.parse(`${REFERENCE_DATE}T00:00:00Z`) / 1000) - 60 * 86400;
      assert.equal(
        isDeadSubscriber(
          sub({
            totalReceived: 30,
            totalUniqueOpened: 0,
            totalUniqueClicked: 0,
            subscribedAt: subscribedAtExactly60DaysAgo,
          }),
          REFERENCE_DATE,
        ),
        true,
      );
    });

    it("cadastro maduro (>= subscribedMinDays) segue elegível se o resto bater", () => {
      assert.equal(
        isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 0, totalUniqueClicked: 0 }), REFERENCE_DATE),
        true,
        "sub() default já usa OLD_SUBSCRIBED_AT, bem além do piso",
      );
    });
  });
});

describe("daysSinceSubscribed", () => {
  it("calcula dias corridos entre subscribedAt (epoch segundos) e referenceDate", () => {
    const thirtyDaysAgo = Math.floor(Date.parse(`${REFERENCE_DATE}T00:00:00Z`) / 1000) - 30 * 86400;
    assert.equal(daysSinceSubscribed(thirtyDaysAgo, REFERENCE_DATE), 30);
  });

  it("subscribedAt inválido (0, negativo, NaN) retorna 0 — fail-soft, nunca NaN/Infinity", () => {
    assert.equal(daysSinceSubscribed(0, REFERENCE_DATE), 0);
    assert.equal(daysSinceSubscribed(-1, REFERENCE_DATE), 0);
    assert.equal(daysSinceSubscribed(NaN, REFERENCE_DATE), 0);
  });

  it("referenceDate inválido retorna 0 — fail-soft (mesma disciplina do lado subscribedAt)", () => {
    assert.equal(daysSinceSubscribed(OLD_SUBSCRIBED_AT, "not-a-date"), 0);
    assert.equal(daysSinceSubscribed(OLD_SUBSCRIBED_AT, ""), 0);
  });
});

describe("sunsetInputFromBeehiivSubscriber", () => {
  it("narrow com fallback 0 pra stats ausente/campos ausentes", () => {
    const raw: BeehiivBackupSubscriber = {
      email: "x@y.com",
      status: "active",
      created: 0,
      utm_source: "",
      utm_medium: "",
      utm_campaign: "",
      referring_site: "",
      stats: null,
    };
    assert.deepEqual(sunsetInputFromBeehiivSubscriber(raw), {
      email: "x@y.com",
      status: "active",
      totalReceived: 0,
      totalUniqueOpened: 0,
      subscribedAt: 0,
      totalUniqueClicked: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// selectDeadSubscribers — projeção de open rate + composição
// ---------------------------------------------------------------------------

describe("selectDeadSubscribers", () => {
  function backupSub(overrides: Partial<BeehiivBackupSubscriber> & { email: string }): BeehiivBackupSubscriber {
    return {
      status: "active",
      created: OLD_SUBSCRIBED_AT, // bem além de subscribedMinDays (60) pra qualquer snapshot usado nos testes abaixo
      utm_source: "",
      utm_medium: "",
      utm_campaign: "",
      referring_site: "",
      ...overrides,
    };
  }

  it("seleciona só os mortos de verdade e projeta open rate melhorado", () => {
    const subscribers: BeehiivBackupSubscriber[] = [
      // leitor real, alta abertura — nunca selecionado
      backupSub({ email: "reader@a.com", stats: { total_received: 30, total_unique_opened: 20, total_unique_clicked: 5 } }),
      // morto de verdade — selecionado
      backupSub({ email: "dead@a.com", stats: { total_received: 30, total_unique_opened: 1, total_unique_clicked: 0 } }),
      // pixel bloqueado (abertura baixa, clique real) — NUNCA selecionado
      backupSub({ email: "mpp@a.com", stats: { total_received: 30, total_unique_opened: 0, total_unique_clicked: 3 } }),
      // imaturo (< 20 recebidas) — fora do denominador inteiro
      backupSub({ email: "new@a.com", stats: { total_received: 5, total_unique_opened: 0, total_unique_clicked: 0 } }),
      // inativo — fora do denominador
      backupSub({ email: "gone@a.com", status: "inactive", stats: { total_received: 30, total_unique_opened: 0, total_unique_clicked: 0 } }),
    ];

    const result = selectDeadSubscribers(subscribers, SUNSET_THRESHOLDS, "2026-08-16");

    assert.equal(result.mature_active_count, 3); // reader, dead, mpp (new e gone ficam fora)
    assert.deepEqual(result.selected.map((s) => s.email), ["dead@a.com"]);
    assert.ok(result.open_rate_projected > result.open_rate_before, "remover o morto deve melhorar o open rate projetado");
  });

  it("nenhum candidato → seleção vazia, open rate projetado igual ao atual", () => {
    const subscribers: BeehiivBackupSubscriber[] = [
      backupSub({ email: "reader@a.com", stats: { total_received: 30, total_unique_opened: 20, total_unique_clicked: 5 } }),
    ];
    const result = selectDeadSubscribers(subscribers, SUNSET_THRESHOLDS, "2026-08-16");
    assert.equal(result.selected.length, 0);
    assert.equal(result.open_rate_projected, result.open_rate_before);
  });

  // #5849, achado ao vivo em 20/08/2026: piso de recebidas sozinho misturava
  // assinantes mortos de verdade com recém-chegados dentro da janela de
  // formação de hábito / medição de campanha (#5734/#4556) — regressão que
  // este teste trava (#633).
  it("#5849: recém-chegado maduro por recebidas MAS ainda na janela de idade não é selecionado", () => {
    const snapshotDate = "2026-08-21";
    const subscribedAt30DaysAgo = Math.floor(Date.parse(`${snapshotDate}T00:00:00Z`) / 1000) - 30 * 86400;
    const subscribers: BeehiivBackupSubscriber[] = [
      // mesmo perfil de received/abertura/clique do "morto de verdade" da
      // 1ª descrição acima, mas cadastrado há só 30 dias.
      backupSub({
        email: "newcomer@a.com",
        created: subscribedAt30DaysAgo,
        stats: { total_received: 22, total_unique_opened: 1, total_unique_clicked: 0 },
      }),
      // morto de verdade, cadastro antigo (default do helper) — continua selecionado.
      backupSub({ email: "dead@a.com", stats: { total_received: 30, total_unique_opened: 1, total_unique_clicked: 0 } }),
    ];
    const result = selectDeadSubscribers(subscribers, SUNSET_THRESHOLDS, snapshotDate);
    assert.deepEqual(result.selected.map((s) => s.email), ["dead@a.com"]);
    // O piso de idade filtra só a SELEÇÃO (quem vira sunset), não o
    // denominador de maturidade — de propósito (mesma leitura do docstring
    // de `mature_active_count`: "denominador do guard de blast radius", que
    // quer o universo ANTES do filtro de "morto", não depois). O newcomer
    // continua contando como maduro por volume; travar isso aqui evita que
    // um refactor futuro funda o piso de idade no filtro `mature` em
    // silêncio, mudando o denominador do blast radius sem nenhum teste
    // acusar.
    assert.equal(result.mature_active_count, 2, "newcomer + dead — ambos maduros por recebidas");
  });
});

// ---------------------------------------------------------------------------
// evaluateBlastRadiusGuard
// ---------------------------------------------------------------------------

describe("evaluateBlastRadiusGuard", () => {
  it("bloqueia quando a razão excede o limiar (20%)", () => {
    const guard = evaluateBlastRadiusGuard(21, 100, false);
    assert.equal(guard.blocked, true);
    assert.equal(guard.ratio, 0.21);
  });

  it("não bloqueia exatamente no limiar (estrito, > não >=)", () => {
    const guard = evaluateBlastRadiusGuard(20, 100, false);
    assert.equal(guard.blocked, false);
    assert.equal(guard.ratio, BLAST_RADIUS_THRESHOLD);
  });

  it("não bloqueia abaixo do limiar", () => {
    assert.equal(evaluateBlastRadiusGuard(5, 100, false).blocked, false);
  });

  it("force ignora o limiar", () => {
    assert.equal(evaluateBlastRadiusGuard(90, 100, true).blocked, false);
  });

  it("denominador 0 → ratio 0, nunca bloqueia (nada pra dividir)", () => {
    const guard = evaluateBlastRadiusGuard(0, 0, false);
    assert.equal(guard.blocked, false);
    assert.equal(guard.ratio, 0);
  });
});

// ---------------------------------------------------------------------------
// applyQueueCapGate — cap da fila compartilhada com sync-pending-to-brevo.ts
// ---------------------------------------------------------------------------

describe("applyQueueCapGate", () => {
  it("sem slots disponíveis → nenhum candidato aplicado", () => {
    assert.deepEqual(applyQueueCapGate([sub({ email: "a@b.com" })], 0), []);
  });

  it("slots suficientes → todos aplicados", () => {
    const candidates = [sub({ email: "a@b.com" }), sub({ email: "c@d.com" })];
    const out = applyQueueCapGate(candidates, 5);
    assert.equal(out.length, 2);
  });

  it("slots insuficientes → prioriza open rate mais baixo (mais inequivocamente morto) primeiro", () => {
    const candidates = [
      sub({ email: "less-dead@b.com", totalReceived: 30, totalUniqueOpened: 3, totalUniqueClicked: 0 }), // 10%
      sub({ email: "very-dead@a.com", totalReceived: 30, totalUniqueOpened: 0, totalUniqueClicked: 0 }), // 0%
    ];
    const out = applyQueueCapGate(candidates, 1);
    assert.deepEqual(
      out.map((s) => s.email),
      ["very-dead@a.com"],
    );
  });

  it("empate no open rate desempata por mais recebidas (mais dado, mais confiança)", () => {
    const candidates = [
      sub({ email: "less-data@a.com", totalReceived: 20, totalUniqueOpened: 0, totalUniqueClicked: 0 }), // 0%
      sub({ email: "more-data@b.com", totalReceived: 100, totalUniqueOpened: 0, totalUniqueClicked: 0 }), // 0%
    ];
    const out = applyQueueCapGate(candidates, 1);
    assert.deepEqual(
      out.map((s) => s.email),
      ["more-data@b.com"],
    );
  });
});

// ---------------------------------------------------------------------------
// formatDryRunReport — smoke test de formatação
// ---------------------------------------------------------------------------

describe("formatDryRunReport", () => {
  it("menciona dry-run e nenhuma escrita", () => {
    const report = formatDryRunReport({
      snapshot_date: "2026-08-16",
      thresholds: SUNSET_THRESHOLDS,
      total_subscribers: 10,
      mature_active_count: 5,
      selected: [sub({ email: "dead@a.com" })],
      open_rate_before: 0.3,
      open_rate_projected: 0.35,
    });
    assert.match(report, /dry-run/);
    assert.match(report, /nenhuma escrita/);
    assert.match(report, /dead@a\.com/);
  });

  // #5849: o piso de idade precisa aparecer no relatório que o editor lê
  // antes de decidir rodar --push — texto não verificado antes travava só
  // por coincidência (nenhum teste cobria as strings novas).
  it("#5849: menciona o piso de idade e a idade de cadastro de cada candidato", () => {
    const snapshotDate = "2026-08-16";
    const subscribedAt90DaysAgo = Math.floor(Date.parse(`${snapshotDate}T00:00:00Z`) / 1000) - 90 * 86400;
    const report = formatDryRunReport({
      snapshot_date: snapshotDate,
      thresholds: SUNSET_THRESHOLDS,
      total_subscribers: 10,
      mature_active_count: 5,
      selected: [sub({ email: "dead@a.com", subscribedAt: subscribedAt90DaysAgo })],
      open_rate_before: 0.3,
      open_rate_projected: 0.35,
    });
    assert.match(report, /cadastro >= 60 dias/);
    assert.match(report, /cadastro há 90d/);
  });
});

// ---------------------------------------------------------------------------
// unsubscribeFromBeehiiv — I/O mockado
// ---------------------------------------------------------------------------

describe("unsubscribeFromBeehiiv", () => {
  it("faz PUT com unsubscribe:true", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      return jsonRes(200, { data: { status: "inactive" } });
    }) as typeof fetch;
    await unsubscribeFromBeehiiv("pub_1", "key", "a@b.com", fetchImpl);
    assert.match(capturedUrl, /subscriptions\/by_email\/a%40b\.com/);
    assert.deepEqual(JSON.parse(capturedBody), { unsubscribe: true });
  });

  it("lança em resposta não-ok", async () => {
    const fetchImpl = (async () => jsonRes(500, { message: "boom" })) as typeof fetch;
    await assert.rejects(() => unsubscribeFromBeehiiv("pub_1", "key", "a@b.com", fetchImpl), /HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// appendSunsetLog + applySunsetOne — I/O em tmpdir (nunca data/ real)
// ---------------------------------------------------------------------------

describe("appendSunsetLog + applySunsetOne (push mockado)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sunset-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appendSunsetLog grava jsonl append-only", () => {
    const logPath = join(dir, "sunset-log.jsonl");
    appendSunsetLog(
      {
        email: "a@b.com",
        sunset_at: "2026-08-20T00:00:00.000Z",
        snapshot_date: "2026-08-16",
        total_received: 30,
        total_unique_opened: 1,
        total_unique_clicked: 0,
        open_rate_pct: 3.33,
        origem: "sunset",
      },
      logPath,
    );
    appendSunsetLog(
      {
        email: "c@d.com",
        sunset_at: "2026-08-20T00:00:01.000Z",
        snapshot_date: "2026-08-16",
        total_received: 40,
        total_unique_opened: 2,
        total_unique_clicked: 0,
        open_rate_pct: 5,
        origem: "sunset",
      },
      logPath,
    );
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).email, "a@b.com");
    assert.equal(JSON.parse(lines[1]).email, "c@d.com");
  });

  it("applySunsetOne ingere na Brevo + chama unsubscribe + ingere no store + grava log", async () => {
    let unsubscribeCalled = false;
    const fetchImpl = (async (url: string | URL) => {
      assert.match(String(url), /subscriptions\/by_email/);
      unsubscribeCalled = true;
      return jsonRes(200, { data: { status: "inactive" } });
    }) as typeof fetch;
    const ingestCalls: Array<{ apiKey: string; listId: number; email: string }> = [];

    const logPath = join(dir, "sunset-log.jsonl");
    const emptyStore: BrevoDiariaStore = { contacts: [] };
    const { result, nextStore } = await applySunsetOne({
      input: sub({ email: "dead@a.com", totalReceived: 30, totalUniqueOpened: 1, totalUniqueClicked: 0 }),
      snapshotDate: "2026-08-16",
      publicationId: "pub_1",
      beehiivApiKey: "key",
      brevoApiKey: "brevo-key",
      brevoListId: 7,
      store: emptyStore,
      fetchImpl,
      logPath,
      now: "2026-08-20T00:00:00.000Z",
      ingest: async (apiKey, listId, email) => {
        ingestCalls.push({ apiKey, listId, email });
      },
    });

    // #5843: a asserção que faltava — o store ser mutado NÃO prova que o
    // contato entrou na lista Brevo (`upsertIngested` é puro).
    assert.deepEqual(ingestCalls, [{ apiKey: "brevo-key", listId: 7, email: "dead@a.com" }]);
    assert.equal(unsubscribeCalled, true);
    assert.equal(result.ok, true);
    assert.equal(nextStore.contacts.length, 1);
    assert.equal(nextStore.contacts[0].email, "dead@a.com");
    assert.equal(nextStore.contacts[0].status, "in_brevo");

    assert.ok(existsSync(logPath));
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.equal(entry.email, "dead@a.com");
    assert.equal(entry.origem, "sunset");
  });

  it("#5843: falha na ingestão Brevo NÃO descadastra na Beehiiv nem toca o store", async () => {
    let unsubscribeCalled = false;
    const fetchImpl = (async () => {
      unsubscribeCalled = true;
      return jsonRes(200, { data: { status: "inactive" } });
    }) as typeof fetch;

    const logPath = join(dir, "sunset-log.jsonl");
    const emptyStore: BrevoDiariaStore = { contacts: [] };
    const { result, nextStore } = await applySunsetOne({
      input: sub({ email: "dead@a.com" }),
      snapshotDate: "2026-08-16",
      publicationId: "pub_1",
      beehiivApiKey: "key",
      brevoApiKey: "brevo-key",
      brevoListId: 7,
      store: emptyStore,
      fetchImpl,
      logPath,
      ingest: async () => {
        throw new Error("brevo 500");
      },
    });

    // Ordem deliberada (#5843): ingestão primeiro. Se ela falha, a pessoa
    // continua recebendo a diária — nunca fica sem nenhum dos dois canais.
    assert.equal(result.ok, false);
    assert.match(String(result.error), /brevo 500/);
    assert.equal(unsubscribeCalled, false, "não pode descadastrar se a ingestão Brevo falhou");
    assert.equal(nextStore.contacts.length, 0);
    assert.equal(existsSync(logPath), false, "log não deve ser gravado em falha");
  });

  it("#5843: ingestão OK + unsubscribe Beehiiv falho NÃO descarta a mutação real — store registra e o aviso aparece", async () => {
    // Cenário que o fix original deixava passar: a ingestão na Brevo acontece
    // de verdade (confirmada por releitura), a Beehiiv falha, e o catch antigo
    // devolvia `nextStore: store` — o contato ficava na lista Brevo, fora do
    // store, invisível pro dedup e pro evaluate. Órfão permanente, porque o
    // unsubscribe ter falhado não o traz de volta como candidato... e mesmo
    // quando traz, a divergência já existiu.
    const fetchImpl = (async () => jsonRes(500, { message: "beehiiv fora do ar" })) as typeof fetch;
    const logPath = join(dir, "sunset-log.jsonl");
    const emptyStore: BrevoDiariaStore = { contacts: [] };
    const { result, nextStore } = await applySunsetOne({
      input: sub({ email: "dead@a.com" }),
      snapshotDate: "2026-08-16",
      publicationId: "pub_1",
      beehiivApiKey: "key",
      brevoApiKey: "brevo-key",
      brevoListId: 7,
      store: emptyStore,
      fetchImpl,
      logPath,
      ingest: async () => {},
    });

    assert.equal(result.ok, true, "a mutação que define sucesso (ingestão Brevo) aconteceu");
    assert.equal(nextStore.contacts.length, 1, "store PRECISA registrar — o contato está na lista Brevo");
    assert.equal(nextStore.contacts[0].status, "in_brevo");
    assert.ok(result.ok && result.warnings, "pendência precisa ser visível");
    assert.match(String(result.ok && result.warnings?.join(" ")), /unsubscribe Beehiiv falhou/);
  });

  it("#5843: falha só no log de auditoria não reverte ingestão nem unsubscribe já feitos", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "inactive" } })) as typeof fetch;
    // Diretório inexistente com um ARQUIVO no lugar do pai força o appendFileSync a lançar.
    const bloqueado = join(dir, "arquivo-nao-diretorio");
    writeFileSync(bloqueado, "x");
    const logPath = join(bloqueado, "sunset-log.jsonl");
    const emptyStore: BrevoDiariaStore = { contacts: [] };

    const { result, nextStore } = await applySunsetOne({
      input: sub({ email: "dead@a.com" }),
      snapshotDate: "2026-08-16",
      publicationId: "pub_1",
      beehiivApiKey: "key",
      brevoApiKey: "brevo-key",
      brevoListId: 7,
      store: emptyStore,
      fetchImpl,
      logPath,
      ingest: async () => {},
    });

    assert.equal(result.ok, true, "log é auditoria — sua falha não desfaz mutação real");
    assert.equal(nextStore.contacts.length, 1);
    assert.match(String(result.ok && result.warnings?.join(" ")), /log de auditoria falhou/);
  });

  it("applySunsetOne devolve ok:false e não muda o store quando a INGESTÃO falha", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "inactive" } })) as typeof fetch;
    const logPath = join(dir, "sunset-log.jsonl");
    const emptyStore: BrevoDiariaStore = { contacts: [] };
    const { result, nextStore } = await applySunsetOne({
      input: sub({ email: "dead@a.com" }),
      snapshotDate: "2026-08-16",
      publicationId: "pub_1",
      beehiivApiKey: "key",
      brevoApiKey: "brevo-key",
      brevoListId: 7,
      store: emptyStore,
      fetchImpl,
      logPath,
      ingest: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error);
    assert.equal(nextStore.contacts.length, 0);
    assert.equal(existsSync(logPath), false, "log não deve ser gravado em falha");
  });
});

// ---------------------------------------------------------------------------
// dry-run não toca rede nem disco de escrita — smoke test via selectDeadSubscribers
// (a própria função de seleção é pure/sync, sem fetch — dry-run do CLI só
// chama leitura local de snapshot + esta função + stdout; nenhum caminho de
// código de dry-run importa unsubscribeFromBeehiiv/applySunsetOne/writeStore)
// ---------------------------------------------------------------------------

describe("dry-run não faz I/O de rede/escrita", () => {
  it("selectDeadSubscribers é pura — mesma entrada produz mesma saída, sem side-effects", () => {
    const subscribers: BeehiivBackupSubscriber[] = [
      {
        email: "dead@a.com",
        status: "active",
        created: 0,
        utm_source: "",
        utm_medium: "",
        utm_campaign: "",
        referring_site: "",
        stats: { total_received: 30, total_unique_opened: 1, total_unique_clicked: 0 },
      },
    ];
    const r1 = selectDeadSubscribers(subscribers, SUNSET_THRESHOLDS, "2026-08-16");
    const r2 = selectDeadSubscribers(subscribers, SUNSET_THRESHOLDS, "2026-08-16");
    assert.deepEqual(r1, r2);
  });
});

// ---------------------------------------------------------------------------
// excludeAlreadyInStore — item (c) do reescopo #5807 (rodada semanal)
// ---------------------------------------------------------------------------

describe("excludeAlreadyInStore", () => {
  it("exclui candidato já presente no store, qualquer status", () => {
    const store: BrevoDiariaStore = {
      contacts: [
        {
          email: "already@a.com",
          beehiiv_subscription_id: "x",
          status: "suppressed",
          opens_count: 0,
          sends_count: 5,
          last_open_rate: 0,
          added_at: "2026-01-01T00:00:00Z",
          last_evaluated_at: null,
        },
      ],
    };
    const selected = [sub({ email: "already@a.com" }), sub({ email: "novo@b.com" })];
    const { toConsider, excludedEmails } = excludeAlreadyInStore(selected, store);
    assert.deepEqual(
      toConsider.map((s) => s.email),
      ["novo@b.com"],
    );
    assert.deepEqual(excludedEmails, ["already@a.com"]);
  });

  it("store vazio não exclui ninguém", () => {
    const emptyStore: BrevoDiariaStore = { contacts: [] };
    const selected = [sub({ email: "a@a.com" }), sub({ email: "b@b.com" })];
    const { toConsider, excludedEmails } = excludeAlreadyInStore(selected, emptyStore);
    assert.equal(toConsider.length, 2);
    assert.equal(excludedEmails.length, 0);
  });

  it("compara e-mail normalizado (case-insensitive)", () => {
    const store: BrevoDiariaStore = {
      contacts: [
        {
          email: "Already@A.com",
          beehiiv_subscription_id: "x",
          status: "in_brevo",
          opens_count: 0,
          sends_count: 5,
          last_open_rate: 0,
          added_at: "2026-01-01T00:00:00Z",
          last_evaluated_at: null,
        },
      ],
    };
    const selected = [sub({ email: "already@a.com" })];
    const { toConsider, excludedEmails } = excludeAlreadyInStore(selected, store);
    assert.equal(toConsider.length, 0);
    assert.deepEqual(excludedEmails, ["already@a.com"]);
  });
});

// ---------------------------------------------------------------------------
// computeSnapshotAgeDays + ensureFreshSnapshot — item (a) do reescopo #5807
// ---------------------------------------------------------------------------

describe("computeSnapshotAgeDays", () => {
  it("calcula idade em dias entre snapshot e now", () => {
    assert.equal(computeSnapshotAgeDays("2026-08-14", new Date("2026-08-21T00:00:00Z")), 7);
    assert.equal(computeSnapshotAgeDays("2026-08-21", new Date("2026-08-21T12:00:00Z")), 0.5);
  });

  it("data inválida retorna Infinity, nunca NaN", () => {
    assert.equal(computeSnapshotAgeDays("not-a-date", new Date("2026-08-21T00:00:00Z")), Infinity);
  });
});

describe("ensureFreshSnapshot", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sunset-fresh-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("snapshot recente (dentro do limite) NÃO dispara runBackup", async () => {
    mkdirSync(join(tmpRoot, "2026-08-20"), { recursive: true });
    let called = false;
    const result = await ensureFreshSnapshot({
      root: tmpRoot,
      runBackup: () => {
        called = true;
      },
      now: new Date("2026-08-21T00:00:00Z"),
    });
    assert.equal(called, false);
    assert.equal(result.triggered, false);
    assert.equal(result.snapshotDateBefore, "2026-08-20");
  });

  it("snapshot velho demais (> SNAPSHOT_MAX_AGE_DAYS) dispara runBackup", async () => {
    mkdirSync(join(tmpRoot, "2026-08-01"), { recursive: true });
    let called = false;
    const result = await ensureFreshSnapshot({
      root: tmpRoot,
      runBackup: async () => {
        called = true;
        mkdirSync(join(tmpRoot, "2026-08-21"), { recursive: true });
      },
      now: new Date("2026-08-21T00:00:00Z"),
    });
    assert.equal(called, true);
    assert.equal(result.triggered, true);
    assert.equal(result.snapshotDateBefore, "2026-08-01");
    assert.equal(result.snapshotDateAfter, "2026-08-21");
  });

  it("nenhum snapshot existente dispara runBackup", async () => {
    let called = false;
    const result = await ensureFreshSnapshot({
      root: tmpRoot,
      runBackup: () => {
        called = true;
      },
      now: new Date("2026-08-21T00:00:00Z"),
    });
    assert.equal(called, true);
    assert.equal(result.triggered, true);
    assert.equal(result.snapshotDateBefore, null);
  });

  it("exatamente no limiar (SNAPSHOT_MAX_AGE_DAYS) NÃO dispara — <=, não <", async () => {
    const snapshotDate = "2026-08-14"; // 7 dias antes de 2026-08-21
    mkdirSync(join(tmpRoot, snapshotDate), { recursive: true });
    let called = false;
    const result = await ensureFreshSnapshot({
      root: tmpRoot,
      maxAgeDays: SNAPSHOT_MAX_AGE_DAYS,
      runBackup: () => {
        called = true;
      },
      now: new Date("2026-08-21T00:00:00Z"),
    });
    assert.equal(called, false);
    assert.equal(result.triggered, false);
  });
});

// ---------------------------------------------------------------------------
// appendSunsetRoundLog — item (e) do reescopo #5807
// ---------------------------------------------------------------------------

describe("appendSunsetRoundLog", () => {
  it("grava jsonl append-only com avaliados/elegíveis/movidos/pulados", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sunset-round-log-"));
    const logPath = join(tmpDir, "sunset-rounds.jsonl");
    try {
      const entry: SunsetRoundLogEntry = {
        round_at: "2026-08-23T09:20:00.000Z",
        push: true,
        snapshot_date: "2026-08-23",
        snapshot_refresh: null,
        mature_active_count: 1000,
        eligible_count: 40,
        already_in_store_count: 5,
        considered_count: 35,
        blast_radius: { blocked: false, ratio: 0.035, threshold: BLAST_RADIUS_THRESHOLD },
        queue: { current_active: 100, cap: 300, available_slots: 200 },
        applied_count: 30,
        failed_count: 0,
        warned_count: 0,
        skipped: [
          { email: "a@a.com", reason: "already_in_store" },
          { email: "b@b.com", reason: "queue_cap" },
        ],
      };
      appendSunsetRoundLog(entry, logPath);
      appendSunsetRoundLog({ ...entry, round_at: "2026-08-30T09:20:00.000Z" }, logPath);
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 2, "append-only — 2 chamadas, 2 linhas");
      const parsed = JSON.parse(lines[0]) as SunsetRoundLogEntry;
      assert.equal(parsed.applied_count, 30);
      assert.equal(parsed.skipped.length, 2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
