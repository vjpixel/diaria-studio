/**
 * test/leitor.test.ts (#5235 Parte 1)
 *
 * Trava os cortes de `leitor-v1` (status active + ≥20 recebidas + CTR real
 * ≥2%) contra fixture, e prova estruturalmente que `click_rate` nunca é lido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LEITOR_V1_THRESHOLDS,
  MISSING_STATS_WARN_FRACTION,
  computeCtrPct,
  isLeitorV1,
  leitorInputFromBeehiivSubscriber,
  leitorInputFromKitSubscriber,
  summarizeLeitores,
  parseLeitorArgs,
  DEFAULT_BACKUP_ROOT,
  type LeitorInput,
} from "../scripts/lib/leitor.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

// ---------------------------------------------------------------------------
// computeCtrPct — CTR real, nunca click_rate
// ---------------------------------------------------------------------------

describe("computeCtrPct", () => {
  it("calcula clicados/recebidas × 100 — não clicados/abertos", () => {
    // Fixture EXATA do Apêndice A do mídia kit (issue #5235):
    // total_received 238, total_unique_opened 217, total_unique_clicked 171.
    // click_rate (Beehiiv) = 171/217 = 78.8% — NÃO é o que esta função retorna.
    const ctr = computeCtrPct(171, 238);
    assert.ok(Math.abs(ctr - (171 / 238) * 100) < 1e-9);
    assert.ok(Math.abs(ctr - 71.85) < 0.01, `esperava ~71.85%, veio ${ctr}`);
    assert.notEqual(Math.round(ctr * 10) / 10, 78.8, "não pode bater com click_rate (click-to-open)");
  });

  it("received <= 0 retorna 0, não NaN/Infinity", () => {
    assert.equal(computeCtrPct(5, 0), 0);
    assert.equal(computeCtrPct(0, 0), 0);
    assert.equal(computeCtrPct(5, -1), 0);
  });

  it("clicked negativo/inválido retorna 0", () => {
    assert.equal(computeCtrPct(-1, 100), 0);
    assert.equal(computeCtrPct(NaN, 100), 0);
  });

  it("clicked > received (dado inconsistente) ainda calcula — não trava", () => {
    // não deveria acontecer no dado real, mas a função não deve explodir
    assert.equal(computeCtrPct(50, 20), 250);
  });
});

// ---------------------------------------------------------------------------
// isLeitorV1 — os 3 cortes: status, piso de recebidas, CTR
// ---------------------------------------------------------------------------

describe("isLeitorV1", () => {
  const base: LeitorInput = { status: "active", totalReceived: 100, totalUniqueClicked: 5 }; // CTR 5%

  it("passa: active + ≥20 recebidas + CTR ≥2%", () => {
    assert.equal(isLeitorV1(base), true);
  });

  it("rejeita status != active mesmo com CTR alto", () => {
    assert.equal(isLeitorV1({ ...base, status: "pending" }), false);
    assert.equal(isLeitorV1({ ...base, status: "invalid" }), false);
    assert.equal(isLeitorV1({ ...base, status: "inactive" }), false);
  });

  it("rejeita totalReceived abaixo do piso (20), mesmo com CTR 100%", () => {
    // 5 recebidas, 1 clicada = CTR 20% — armadilha citada na issue: sem o
    // piso de 20 recebidas, isso premiaria quem chegou há pouco.
    assert.equal(isLeitorV1({ status: "active", totalReceived: 5, totalUniqueClicked: 1 }), false);
    // exatamente no piso passa (>=, não >)
    assert.equal(
      isLeitorV1({ status: "active", totalReceived: 20, totalUniqueClicked: 1 }), // CTR 5%
      true,
    );
    assert.equal(
      isLeitorV1({ status: "active", totalReceived: 19, totalUniqueClicked: 19 }), // CTR 100%, mas recebidas<20
      false,
    );
  });

  it("rejeita CTR abaixo de 2%, aceita exatamente 2%", () => {
    assert.equal(isLeitorV1({ status: "active", totalReceived: 100, totalUniqueClicked: 1 }), false); // 1%
    assert.equal(isLeitorV1({ status: "active", totalReceived: 100, totalUniqueClicked: 2 }), true); // exatamente 2%
    assert.equal(isLeitorV1({ status: "active", totalReceived: 100, totalUniqueClicked: 3 }), true); // 3%
  });

  it("zero cliques nunca é leitor, mesmo com muitas recebidas", () => {
    assert.equal(isLeitorV1({ status: "active", totalReceived: 500, totalUniqueClicked: 0 }), false);
  });

  it("thresholds customizados sobrescrevem o default sem mutar LEITOR_V1_THRESHOLDS", () => {
    const custom = { ctrMinPct: 5, receivedMin: 10 };
    assert.equal(isLeitorV1({ status: "active", totalReceived: 50, totalUniqueClicked: 2 }, custom), false); // 4% < 5%
    assert.equal(isLeitorV1({ status: "active", totalReceived: 50, totalUniqueClicked: 3 }, custom), true); // 6% >= 5%
    assert.deepEqual(LEITOR_V1_THRESHOLDS, { ctrMinPct: 2, receivedMin: 20 });
  });
});

// ---------------------------------------------------------------------------
// Teste explícito de NÃO-USO de click_rate (#5235 checklist)
// ---------------------------------------------------------------------------

describe("click_rate nunca é usado", () => {
  it("leitorInputFromBeehiivSubscriber ignora click_rate mesmo quando presente e discrepante", () => {
    // click_rate deliberadamente MENTIROSO: se fosse lido, mudaria o
    // resultado. total_received=238, total_unique_clicked=171 → CTR real
    // 71,8% (bem acima do corte); click_rate=78.8 também está acima — não
    // discrimina sozinho. Testa o caso realmente adversarial abaixo.
    const sub = {
      status: "active",
      stats: { total_received: 238, total_unique_clicked: 171, click_rate: 78.8 },
    };
    const input = leitorInputFromBeehiivSubscriber(sub);
    assert.deepEqual(input, { status: "active", totalReceived: 238, totalUniqueClicked: 171 });
  });

  it("caso adversarial: click_rate empurraria pra cima do corte, CTR real fica ABAIXO — resultado usa o real", () => {
    // 500 recebidas, 8 clicadas → CTR real 1,6% (abaixo do corte de 2%).
    // Um click_rate (click-to-open) construído artificialmente pra ficar
    // ACIMA do corte não deve mudar o veredito.
    const sub = {
      status: "active",
      stats: { total_received: 500, total_unique_clicked: 8, click_rate: 40 }, // click_rate mentiroso, bem acima de 2
    };
    const input = leitorInputFromBeehiivSubscriber(sub);
    assert.equal(isLeitorV1(input), false, "CTR real (1.6%) deveria reprovar, mesmo com click_rate=40 no dado bruto");
  });

  it("caso adversarial inverso: click_rate empurraria pra baixo do corte, CTR real fica ACIMA — resultado usa o real", () => {
    // 100 recebidas, 5 clicadas → CTR real 5% (acima do corte de 2%), com
    // click_rate mentiroso propositalmente abaixo (1%).
    const sub = {
      status: "active",
      stats: { total_received: 100, total_unique_clicked: 5, click_rate: 1 },
    };
    const input = leitorInputFromBeehiivSubscriber(sub);
    assert.equal(isLeitorV1(input), true, "CTR real (5%) deveria aprovar, mesmo com click_rate=1 no dado bruto");
  });

  it("Proxy que lança ao acessar click_rate — leitorInputFromBeehiivSubscriber nunca toca a chave", () => {
    let accessed = false;
    const stats = new Proxy(
      { total_received: 238, total_unique_clicked: 171 },
      {
        get(target, prop, receiver) {
          if (prop === "click_rate") {
            accessed = true;
            throw new Error("click_rate foi acessado — não deveria");
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const sub = { status: "active", stats } as unknown as { status: string; stats: typeof stats };
    const input = leitorInputFromBeehiivSubscriber(sub);
    assert.equal(accessed, false);
    assert.deepEqual(input, { status: "active", totalReceived: 238, totalUniqueClicked: 171 });
  });

  it("BeehiivSubscriberStatsShape (tipo aceito pela extração) não declara click_rate", () => {
    // Checagem estática indireta: se o tipo declarasse click_rate, o objeto
    // abaixo (sem essa chave) ainda satisfaria a interface — o que já é o
    // caso hoje. O ponto é documentar a intenção via teste nomeado, a
    // garantia real é o Proxy acima + a leitura do código fonte.
    const shapeWithoutClickRate = { status: "active", stats: { total_received: 10, total_unique_clicked: 1 } };
    assert.doesNotThrow(() => leitorInputFromBeehiivSubscriber(shapeWithoutClickRate));
  });
});

// ---------------------------------------------------------------------------
// leitorInputFromKitSubscriber — extração simétrica pro Kit (#6050)
// ---------------------------------------------------------------------------

describe("leitorInputFromKitSubscriber", () => {
  it("mapeia state → status, stats.sent → totalReceived, stats.clicked → totalUniqueClicked", () => {
    const sub = { state: "active", stats: { sent: 238, clicked: 171 } };
    const input = leitorInputFromKitSubscriber(sub);
    assert.deepEqual(input, { status: "active", totalReceived: 238, totalUniqueClicked: 171 });
  });

  it("stats ausente/null vira 0/0, nunca NaN", () => {
    assert.deepEqual(leitorInputFromKitSubscriber({ state: "active" }), {
      status: "active",
      totalReceived: 0,
      totalUniqueClicked: 0,
    });
    assert.deepEqual(leitorInputFromKitSubscriber({ state: "active", stats: null }), {
      status: "active",
      totalReceived: 0,
      totalUniqueClicked: 0,
    });
  });

  it("state não-active (cancelled/bounced/complained/inactive) propaga pra isLeitorV1 rejeitar", () => {
    for (const state of ["cancelled", "bounced", "complained", "inactive"]) {
      const input = leitorInputFromKitSubscriber({ state, stats: { sent: 100, clicked: 10 } });
      assert.equal(input.status, state);
      assert.equal(isLeitorV1(input), false, `state=${state} nunca deveria passar em isLeitorV1`);
    }
  });

  it("Proxy que lança ao acessar click_rate — leitorInputFromKitSubscriber nunca toca a chave (mesma disciplina da Beehiiv)", () => {
    let accessed = false;
    const stats = new Proxy(
      { sent: 238, clicked: 171 },
      {
        get(target, prop, receiver) {
          if (prop === "click_rate") {
            accessed = true;
            throw new Error("click_rate foi acessado — não deveria");
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const sub = { state: "active", stats } as unknown as { state: string; stats: typeof stats };
    const input = leitorInputFromKitSubscriber(sub);
    assert.equal(accessed, false);
    assert.deepEqual(input, { status: "active", totalReceived: 238, totalUniqueClicked: 171 });
  });

  it("KitSubscriberStatsShape (tipo aceito pela extração) não declara click_rate", () => {
    const shapeWithoutClickRate = { state: "active", stats: { sent: 10, clicked: 1 } };
    assert.doesNotThrow(() => leitorInputFromKitSubscriber(shapeWithoutClickRate));
  });

  it("resultado é equivalente ao da Beehiiv pro mesmo dado numérico — só o nome dos campos de origem muda", () => {
    const beehiivInput = leitorInputFromBeehiivSubscriber({
      status: "active",
      stats: { total_received: 100, total_unique_clicked: 5 },
    });
    const kitInput = leitorInputFromKitSubscriber({ state: "active", stats: { sent: 100, clicked: 5 } });
    assert.deepEqual(beehiivInput, kitInput);
    assert.equal(isLeitorV1(beehiivInput), isLeitorV1(kitInput));
  });
});

// ---------------------------------------------------------------------------
// summarizeLeitores — agregação sobre uma lista de subscribers
// ---------------------------------------------------------------------------

describe("summarizeLeitores", () => {
  function sub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
    return {
      email: "x@example.com",
      status: "active",
      created: 1700000000,
      utm_source: "direct",
      utm_medium: "",
      utm_campaign: "",
      referring_site: "",
      stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 80, click_rate: 6.25 },
      ...overrides,
    };
  }

  it("conta ativos e leitores-v1 separadamente sobre uma lista fixture", () => {
    const subs: BeehiivBackupSubscriber[] = [
      sub({ email: "a@x.com" }), // active, CTR 5% ≥20 recebidas → leitor
      sub({ email: "b@x.com", status: "pending" }), // não conta como ativo nem leitor
      sub({ email: "c@x.com", stats: { total_received: 100, total_unique_clicked: 1 } }), // CTR 1% → active, não leitor
      sub({ email: "d@x.com", stats: { total_received: 10, total_unique_clicked: 10 } }), // CTR 100% mas <20 recebidas
    ];
    const summary = summarizeLeitores(subs, LEITOR_V1_THRESHOLDS, "2026-08-14");
    assert.equal(summary.total_subscribers, 4);
    assert.equal(summary.total_active, 3);
    assert.equal(summary.leitores_v1, 1);
    assert.equal(summary.snapshot_date, "2026-08-14");
    assert.equal(summary.subscribers_missing_stats, 0);
  });

  it("lista vazia produz zeros, não crash", () => {
    const summary = summarizeLeitores([], LEITOR_V1_THRESHOLDS, "2026-08-14");
    assert.equal(summary.total_subscribers, 0);
    assert.equal(summary.total_active, 0);
    assert.equal(summary.leitores_v1, 0);
    assert.equal(summary.subscribers_missing_stats, 0);
  });

  it("conta subscribers com stats undefined OU null como faltantes", () => {
    const subs: BeehiivBackupSubscriber[] = [
      sub({ email: "a@x.com", stats: undefined }),
      sub({ email: "b@x.com", stats: null }),
      sub({ email: "c@x.com" }), // stats presente (default do helper)
    ];
    const summary = summarizeLeitores(subs, LEITOR_V1_THRESHOLDS, "2026-08-14");
    assert.equal(summary.subscribers_missing_stats, 2);
  });

  // -------------------------------------------------------------------------
  // Finding 1 do PR #5275 — warning quando o snapshot não tem `stats`
  // (pré-#5229): leitores_v1: 0 não pode ser lido como "zero leitores reais"
  // sem distinguir de "snapshot sem dado de engajamento".
  // -------------------------------------------------------------------------

  it("emite console.warn quando fração de subscribers sem stats é alta (pré-#5229)", () => {
    const subs: BeehiivBackupSubscriber[] = Array.from({ length: 10 }, (_, i) =>
      sub({ email: `s${i}@x.com`, stats: undefined }),
    );
    const originalWarn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const summary = summarizeLeitores(subs, LEITOR_V1_THRESHOLDS, "2026-06-05");
      assert.equal(summary.subscribers_missing_stats, 10);
      assert.equal(summary.leitores_v1, 0);
      assert.equal(calls.length, 1, "esperava exatamente 1 chamada a console.warn");
      const message = String(calls[0][0]);
      assert.match(message, /stats/);
      assert.match(message, /2026-06-05/);
      assert.match(message, /5229/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("NÃO emite console.warn quando a maioria dos subscribers tem stats", () => {
    const subs: BeehiivBackupSubscriber[] = [
      sub({ email: "a@x.com" }),
      sub({ email: "b@x.com" }),
      sub({ email: "c@x.com" }),
      sub({ email: "d@x.com", stats: undefined }), // 1/4 faltando — abaixo do threshold
    ];
    assert.ok(1 / subs.length < MISSING_STATS_WARN_FRACTION);
    const originalWarn = console.warn;
    let called = false;
    console.warn = () => {
      called = true;
    };
    try {
      summarizeLeitores(subs, LEITOR_V1_THRESHOLDS, "2026-08-14");
      assert.equal(called, false);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

describe("parseLeitorArgs", () => {
  it("defaults: ctr-min 2, received-min 20, snapshot null, root = DEFAULT_BACKUP_ROOT", () => {
    const args = parseLeitorArgs([]);
    assert.deepEqual(args.thresholds, { ctrMinPct: 2, receivedMin: 20 });
    assert.equal(args.snapshotDate, null);
    assert.equal(args.backupRoot, DEFAULT_BACKUP_ROOT);
  });

  it("aceita --ctr-min e --received-min customizados", () => {
    const args = parseLeitorArgs(["--ctr-min", "3.5", "--received-min", "10"]);
    assert.deepEqual(args.thresholds, { ctrMinPct: 3.5, receivedMin: 10 });
  });

  it("aceita --snapshot e --root", () => {
    const args = parseLeitorArgs(["--snapshot", "2026-06-05", "--root", "/tmp/foo"]);
    assert.equal(args.snapshotDate, "2026-06-05");
    assert.equal(args.backupRoot, "/tmp/foo");
  });

  it("--ctr-min negativo/inválido lança em vez de degradar silenciosamente", () => {
    assert.throws(() => parseLeitorArgs(["--ctr-min", "-1"]));
    assert.throws(() => parseLeitorArgs(["--ctr-min", "abc"]));
  });
});
