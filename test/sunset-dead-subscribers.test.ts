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
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUNSET_THRESHOLDS,
  BLAST_RADIUS_THRESHOLD,
  computeOpenRatePct,
  isDeadSubscriber,
  sunsetInputFromBeehiivSubscriber,
  selectDeadSubscribers,
  evaluateBlastRadiusGuard,
  applyQueueCapGate,
  unsubscribeFromBeehiiv,
  appendSunsetLog,
  applySunsetOne,
  formatDryRunReport,
  type SunsetInput,
} from "../scripts/sunset-dead-subscribers.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sub(overrides: Partial<SunsetInput> = {}): SunsetInput {
  return {
    email: "a@b.com",
    status: "active",
    totalReceived: 30,
    totalUniqueOpened: 1,
    totalUniqueClicked: 0,
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
  it("seleciona: active, >=20 recebidas, abertura <=10%, zero cliques", () => {
    assert.equal(isDeadSubscriber(sub({ totalReceived: 20, totalUniqueOpened: 2, totalUniqueClicked: 0 })), true);
  });

  it("GUARD CRÍTICO: abertura baixa MAS com clique NUNCA é sunset (leitor real com pixel bloqueado)", () => {
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 1, totalUniqueClicked: 1 })),
      false,
      "1 clique já basta pra excluir, mesmo com abertura de 3%",
    );
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 100, totalUniqueOpened: 0, totalUniqueClicked: 5 })),
      false,
      "zero abertura mas cliques reais — nunca sunset",
    );
  });

  it("status diferente de active nunca é sunset", () => {
    assert.equal(isDeadSubscriber(sub({ status: "inactive", totalUniqueOpened: 0 })), false);
    assert.equal(isDeadSubscriber(sub({ status: "pending", totalUniqueOpened: 0 })), false);
  });

  it("recebidas abaixo do piso (20) nunca é sunset, mesmo com abertura/clique zerados", () => {
    assert.equal(isDeadSubscriber(sub({ totalReceived: 19, totalUniqueOpened: 0, totalUniqueClicked: 0 })), false);
    assert.equal(isDeadSubscriber(sub({ totalReceived: 5, totalUniqueOpened: 0, totalUniqueClicked: 0 })), false);
  });

  it("abertura acima de 10% nunca é sunset, mesmo com zero cliques", () => {
    assert.equal(isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 4, totalUniqueClicked: 0 })), false); // 13.3%
  });

  it("abertura exatamente no limiar (10%) É sunset — <=, não <", () => {
    assert.equal(isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 3, totalUniqueClicked: 0 })), true); // 10.0%
  });

  it("respeita thresholds customizados (parâmetro, não hardcoded)", () => {
    const custom = { receivedMin: 10, openRateMaxPct: 5 };
    assert.equal(isDeadSubscriber(sub({ totalReceived: 10, totalUniqueOpened: 0, totalUniqueClicked: 0 }), custom), true);
    assert.equal(
      isDeadSubscriber(sub({ totalReceived: 30, totalUniqueOpened: 2, totalUniqueClicked: 0 }), custom),
      false,
      "6.6% > 5% no threshold customizado",
    );
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
      created: 0,
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

  it("applySunsetOne chama unsubscribe + ingere no store + grava log", async () => {
    let unsubscribeCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/subscriptions/by_email/")) {
        unsubscribeCalled = true;
        return jsonRes(200, { data: { status: "inactive" } });
      }
      // Brevo POST /contacts → 201 Created
      if (u.includes("api.brevo.com/v3/contacts") && u.endsWith("/contacts")) {
        return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } });
      }
      // Brevo GET /contacts/{email} → 200 com listIds incluindo 7
      if (u.includes("api.brevo.com/v3/contacts/")) {
        return jsonRes(200, { listIds: [7], email: "dead@a.com" });
      }
      return jsonRes(200, {});
    }) as typeof fetch;

    try {
      const logPath = join(dir, "sunset-log.jsonl");
      const emptyStore: BrevoDiariaStore = { contacts: [] };
      const { result, nextStore } = await applySunsetOne(
        sub({ email: "dead@a.com", totalReceived: 30, totalUniqueOpened: 1, totalUniqueClicked: 0 }),
        "2026-08-16",
        "pub_1",
        "key",
        emptyStore,
        globalThis.fetch,
        logPath,
        "brevo_key",
        7,
        "2026-08-20T00:00:00.000Z",
      );

      assert.equal(unsubscribeCalled, true);
      assert.equal(result.ok, true);
      assert.equal(nextStore.contacts.length, 1);
      assert.equal(nextStore.contacts[0].email, "dead@a.com");
      assert.equal(nextStore.contacts[0].status, "in_brevo");

      assert.ok(existsSync(logPath));
      const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
      assert.equal(entry.email, "dead@a.com");
      assert.equal(entry.origem, "sunset");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("applySunsetOne devolve ok:false e não muda o store em falha de rede", async () => {
    const fetchImpl = (async () => jsonRes(500, { message: "boom" })) as typeof fetch;
    const logPath = join(dir, "sunset-log.jsonl");
    const emptyStore: BrevoDiariaStore = { contacts: [] };
    const { result, nextStore } = await applySunsetOne(
      sub({ email: "dead@a.com" }),
      "2026-08-16",
      "pub_1",
      "key",
      emptyStore,
      fetchImpl,
      logPath,
      "brevo_key",
      7,
    );
    assert.equal(result.ok, false);
    assert.ok(result.error);
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
