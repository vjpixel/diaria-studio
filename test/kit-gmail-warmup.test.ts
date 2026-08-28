/**
 * kit-gmail-warmup.test.ts (#6504 item 2) — miolo puro da rampa de
 * aquecimento Gmail. Ver `scripts/lib/kit-gmail-warmup.ts` pro contexto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeGmailRejectedEmails,
  computeNextWaveSize,
  planNextWave,
  partitionByBeehiivActive,
  resolveWarmupBeehiivPartition,
  returnedEmails,
  lastPushedWaveSize,
  buildInitialState,
  buildWaveEntry,
  WARMUP_INITIAL_WAVE_SIZE,
  WARMUP_GROWTH_FACTOR,
  type KitGmailWarmupState,
} from "../scripts/lib/kit-gmail-warmup.ts";
import type { RampaVeredito } from "../scripts/lib/provider-split.ts";

const PODE_CRESCER: RampaVeredito = { podeCrescer: true, motivo: "PODE CRESCER — teste", avisos: [] };
const SEGURAR: RampaVeredito = { podeCrescer: false, motivo: "SEGURAR — entrega abaixo do piso", avisos: [] };

describe("computeGmailRejectedEmails", () => {
  it("devolve só Gmail que foi enviado mas não entregue", () => {
    const rejected = computeGmailRejectedEmails(
      ["a@gmail.com", "b@gmail.com", "c@outlook.com", "d@gmail.com"],
      ["b@gmail.com", "c@outlook.com"],
    );
    assert.deepEqual(rejected, ["a@gmail.com", "d@gmail.com"]);
  });

  it("normaliza (trim + caixa baixa) e deduplica", () => {
    const rejected = computeGmailRejectedEmails(
      ["A@GMAIL.com", " a@gmail.com ", "a@gmail.com"],
      [],
    );
    assert.deepEqual(rejected, ["a@gmail.com"]);
  });

  it("ordena alfabeticamente — seleção determinística onda a onda", () => {
    const rejected = computeGmailRejectedEmails(["z@gmail.com", "a@gmail.com", "m@gmail.com"], []);
    assert.deepEqual(rejected, ["a@gmail.com", "m@gmail.com", "z@gmail.com"]);
  });

  it("lista vazia quando não há Gmail recusado", () => {
    assert.deepEqual(computeGmailRejectedEmails(["a@gmail.com"], ["a@gmail.com"]), []);
    assert.deepEqual(computeGmailRejectedEmails(["a@outlook.com"], []), []);
  });

  it("#6504 apoiadores: patrono/mantenedor/apoiador/amigo furam a ordem alfabética, nessa ordem de prioridade", () => {
    const apoioNivelByEmail = new Map<string, "amigo" | "apoiador" | "mantenedor" | "patrono">([
      ["z@gmail.com", "patrono"],
      ["y@gmail.com", "mantenedor"],
      ["x@gmail.com", "apoiador"],
      ["w@gmail.com", "amigo"],
    ]);
    const rejected = computeGmailRejectedEmails(
      ["a@gmail.com", "z@gmail.com", "m@gmail.com", "y@gmail.com", "x@gmail.com", "w@gmail.com"],
      [],
      apoioNivelByEmail,
    );
    assert.deepEqual(rejected, ["z@gmail.com", "y@gmail.com", "x@gmail.com", "w@gmail.com", "a@gmail.com", "m@gmail.com"]);
  });

  it("#6504 apoiadores: empate de nível desempata alfabético", () => {
    const apoioNivelByEmail = new Map<string, "patrono">([
      ["z@gmail.com", "patrono"],
      ["a@gmail.com", "patrono"],
    ]);
    const rejected = computeGmailRejectedEmails(["z@gmail.com", "m@gmail.com", "a@gmail.com"], [], apoioNivelByEmail);
    assert.deepEqual(rejected, ["a@gmail.com", "z@gmail.com", "m@gmail.com"]);
  });

  it("#6504 apoiadores: mapa ausente preserva o comportamento puramente alfabético de sempre", () => {
    const rejected = computeGmailRejectedEmails(["z@gmail.com", "a@gmail.com", "m@gmail.com"], []);
    assert.deepEqual(rejected, ["a@gmail.com", "m@gmail.com", "z@gmail.com"]);
  });

  it("#6504 apoiadores: e-mail sem entrada no mapa cai pro grupo sem prioridade (fim da lista)", () => {
    const apoioNivelByEmail = new Map<string, "apoiador">([["m@gmail.com", "apoiador"]]);
    const rejected = computeGmailRejectedEmails(["z@gmail.com", "a@gmail.com", "m@gmail.com"], [], apoioNivelByEmail);
    assert.deepEqual(rejected, ["m@gmail.com", "a@gmail.com", "z@gmail.com"]);
  });
});

describe("computeNextWaveSize", () => {
  it("1ª onda (lastWaveSize null) usa WARMUP_INITIAL_WAVE_SIZE", () => {
    assert.equal(computeNextWaveSize(1000, null), WARMUP_INITIAL_WAVE_SIZE);
  });

  it("dobra a partir da última onda pushada", () => {
    assert.equal(computeNextWaveSize(1000, 20), 20 * WARMUP_GROWTH_FACTOR);
    assert.equal(computeNextWaveSize(1000, 40), 80);
  });

  it("capa pelo que resta — nunca propõe mais do que existe", () => {
    assert.equal(computeNextWaveSize(30, 40), 30);
    assert.equal(computeNextWaveSize(0, 40), 0);
  });

  it("remaining negativo (defensivo) também dá zero", () => {
    assert.equal(computeNextWaveSize(-5, 40), 0);
  });

  it("#6566: lastWaveSize 0 (onda anterior fechou com safeToTag vazio) NUNCA trava em zero — reinicia a progressão como se fosse a 1ª onda", () => {
    assert.equal(computeNextWaveSize(1000, 0), WARMUP_INITIAL_WAVE_SIZE);
    assert.notEqual(computeNextWaveSize(1000, 0), 0);
    // Estado absorvente pré-fix seria permanente: uma 2ª chamada encadeada
    // com o resultado da 1ª (simulando rodadas sucessivas) continuaria
    // crescendo normalmente, nunca voltando a travar em 0.
    const first = computeNextWaveSize(1000, 0);
    assert.equal(computeNextWaveSize(1000, first), first * WARMUP_GROWTH_FACTOR);
  });

  it("#6566: lastWaveSize negativo (defensivo) também é tratado como null", () => {
    assert.equal(computeNextWaveSize(1000, -5), WARMUP_INITIAL_WAVE_SIZE);
  });
});

describe("planNextWave", () => {
  const rejectedEmails = ["a@gmail.com", "b@gmail.com", "c@gmail.com"];

  it("SEGURA quando o gate manda segurar — nunca cresce às cegas", () => {
    const plan = planNextWave({ rejectedEmails, alreadyReturned: new Set(), lastWaveSize: null, gate: SEGURAR });
    assert.equal(plan.skipped, true);
    assert.equal(plan.size, 0);
    assert.deepEqual(plan.emails, []);
    assert.equal(plan.reason, SEGURAR.motivo);
  });

  it("gate OK, 1ª onda: seleciona min(WARMUP_INITIAL_WAVE_SIZE, pendentes)", () => {
    const plan = planNextWave({ rejectedEmails, alreadyReturned: new Set(), lastWaveSize: null, gate: PODE_CRESCER });
    assert.equal(plan.skipped, false);
    assert.equal(plan.size, 3); // só 3 no cohort de teste, menor que o floor de 20
    assert.deepEqual(plan.emails, rejectedEmails);
  });

  it("pula quem já foi devolvido — nunca repete endereço já pushado", () => {
    const plan = planNextWave({
      rejectedEmails,
      alreadyReturned: new Set(["a@gmail.com"]),
      lastWaveSize: 1,
      gate: PODE_CRESCER,
    });
    assert.deepEqual(plan.emails, ["b@gmail.com", "c@gmail.com"]);
  });

  it("todos já devolvidos → skipped com motivo próprio (não o do gate)", () => {
    const plan = planNextWave({
      rejectedEmails,
      alreadyReturned: new Set(rejectedEmails),
      lastWaveSize: 3,
      gate: PODE_CRESCER,
    });
    assert.equal(plan.skipped, true);
    assert.equal(plan.size, 0);
    assert.match(plan.reason, /já foram devolvidos/);
  });

  it("seleção é sempre um PREFIXO estável — 2 rodadas com o mesmo input escolhem o mesmo início", () => {
    const bigCohort = Array.from({ length: 50 }, (_, i) => `u${String(i).padStart(2, "0")}@gmail.com`);
    const plan1 = planNextWave({ rejectedEmails: bigCohort, alreadyReturned: new Set(), lastWaveSize: null, gate: PODE_CRESCER });
    const plan2 = planNextWave({ rejectedEmails: bigCohort, alreadyReturned: new Set(), lastWaveSize: null, gate: PODE_CRESCER });
    assert.deepEqual(plan1.emails, plan2.emails);
    assert.equal(plan1.size, WARMUP_INITIAL_WAVE_SIZE);
  });
});

describe("partitionByBeehiivActive", () => {
  it("separa quem está ativo na Beehiiv (precisa de desativação manual) de quem não está (seguro)", () => {
    const { safeToTag, needsBeehiivDeactivation } = partitionByBeehiivActive(
      ["a@gmail.com", "b@gmail.com", "c@gmail.com"],
      new Set(["b@gmail.com"]),
    );
    assert.deepEqual(safeToTag, ["a@gmail.com", "c@gmail.com"]);
    assert.deepEqual(needsBeehiivDeactivation, ["b@gmail.com"]);
  });

  it("normaliza antes de comparar (caixa/trim não deve produzir falso 'seguro')", () => {
    const { needsBeehiivDeactivation } = partitionByBeehiivActive(
      ["A@Gmail.com"],
      new Set(["a@gmail.com"]),
    );
    assert.deepEqual(needsBeehiivDeactivation, ["A@Gmail.com"]);
  });

  it("conjunto Beehiiv vazio → tudo seguro", () => {
    const { safeToTag, needsBeehiivDeactivation } = partitionByBeehiivActive(["a@gmail.com"], new Set());
    assert.deepEqual(safeToTag, ["a@gmail.com"]);
    assert.deepEqual(needsBeehiivDeactivation, []);
  });
});

describe("resolveWarmupBeehiivPartition (#6504 — fleet review: guard central contra envio duplicado)", () => {
  it("beehiivCfgOk=false → TODOS os e-mails viram needsBeehiivDeactivation, ninguém é seguro (falha segura)", () => {
    const { safeToTag, needsBeehiivDeactivation } = resolveWarmupBeehiivPartition(
      ["a@gmail.com", "b@gmail.com"],
      false, // config Beehiiv indisponível/checagem falhou
      new Set(), // mesmo que o conjunto de ativos esteja vazio (nunca deveria ser consultado aqui)
    );
    assert.deepEqual(safeToTag, [], "quando a checagem Beehiiv não pôde rodar, nada pode ser tagueado");
    assert.deepEqual(needsBeehiivDeactivation, ["a@gmail.com", "b@gmail.com"]);
  });

  it("beehiivCfgOk=true → delega pra partitionByBeehiivActive normalmente", () => {
    const { safeToTag, needsBeehiivDeactivation } = resolveWarmupBeehiivPartition(
      ["a@gmail.com", "b@gmail.com"],
      true,
      new Set(["b@gmail.com"]),
    );
    assert.deepEqual(safeToTag, ["a@gmail.com"]);
    assert.deepEqual(needsBeehiivDeactivation, ["b@gmail.com"]);
  });
});

describe("estado — returnedEmails / lastPushedWaveSize / buildInitialState / buildWaveEntry", () => {
  it("buildInitialState captura o cohort e começa sem ondas", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const state = buildInitialState(25622689, ["a@gmail.com", "b@gmail.com"], now);
    assert.equal(state.referenceBroadcastId, 25622689);
    assert.equal(state.capturedAt, "2026-08-28T12:00:00.000Z");
    assert.equal(state.totalRejected, 2);
    assert.deepEqual(state.waves, []);
  });

  it("returnedEmails ignora ondas não-pushadas (dry-run não conta)", () => {
    const state: KitGmailWarmupState = {
      referenceBroadcastId: 1,
      capturedAt: "x",
      totalRejected: 3,
      rejectedEmails: ["a@gmail.com", "b@gmail.com", "c@gmail.com"],
      waves: [
        { index: 0, decidedAt: "x", gateBroadcastId: 1, gateVerdict: "podeCrescer", gateMotivo: "x", size: 1, emails: ["a@gmail.com"], needsBeehiivDeactivation: [], pushed: true, unverifiedEmails: [] },
        { index: 1, decidedAt: "x", gateBroadcastId: 2, gateVerdict: "podeCrescer", gateMotivo: "x", size: 1, emails: ["b@gmail.com"], needsBeehiivDeactivation: [], pushed: false, unverifiedEmails: [] },
      ],
    };
    assert.deepEqual([...returnedEmails(state)], ["a@gmail.com"]);
  });

  it("lastPushedWaveSize ignora ondas não-pushadas e olha a última PUSHADA (não a última do array)", () => {
    const state: KitGmailWarmupState = {
      referenceBroadcastId: 1,
      capturedAt: "x",
      totalRejected: 3,
      rejectedEmails: [],
      waves: [
        { index: 0, decidedAt: "x", gateBroadcastId: 1, gateVerdict: "podeCrescer", gateMotivo: "x", size: 20, emails: [], needsBeehiivDeactivation: [], pushed: true, unverifiedEmails: [] },
        { index: 1, decidedAt: "x", gateBroadcastId: 2, gateVerdict: "segurar", gateMotivo: "x", size: 40, emails: [], needsBeehiivDeactivation: [], pushed: false, unverifiedEmails: [] },
      ],
    };
    assert.equal(lastPushedWaveSize(state), 20);
  });

  it("lastPushedWaveSize é null sem nenhuma onda pushada", () => {
    const state: KitGmailWarmupState = { referenceBroadcastId: 1, capturedAt: "x", totalRejected: 0, rejectedEmails: [], waves: [] };
    assert.equal(lastPushedWaveSize(state), null);
  });

  it("buildWaveEntry NUNCA inclui needsBeehiivDeactivation em 'emails' — quem precisa de desativação manual não pode contar como devolvido", () => {
    const state = buildInitialState(1, ["a@gmail.com", "b@gmail.com"]);
    const now = new Date("2026-08-29T06:00:00.000Z");
    const entry = buildWaveEntry(state, 1, PODE_CRESCER, ["a@gmail.com"], ["b@gmail.com"], true, now);
    assert.equal(entry.index, 0);
    assert.equal(entry.decidedAt, "2026-08-29T06:00:00.000Z");
    assert.equal(entry.gateVerdict, "podeCrescer");
    assert.equal(entry.size, 1);
    assert.deepEqual(entry.emails, ["a@gmail.com"]);
    assert.deepEqual(entry.needsBeehiivDeactivation, ["b@gmail.com"]);
    assert.equal(entry.pushed, true);
    assert.deepEqual(entry.unverifiedEmails, [], "default sem unverifiedEmails explícito");
  });

  it("buildWaveEntry aceita unverifiedEmails explícito (releitura pós-tagSubscriber não confirmou)", () => {
    const state = buildInitialState(1, ["a@gmail.com"]);
    const entry = buildWaveEntry(state, 1, PODE_CRESCER, ["a@gmail.com"], [], true, new Date(), ["a@gmail.com"]);
    assert.deepEqual(entry.unverifiedEmails, ["a@gmail.com"]);
  });

  it("buildWaveEntry index acompanha o número de ondas já em state.waves", () => {
    const state = buildInitialState(1, []);
    state.waves.push(buildWaveEntry(state, 1, PODE_CRESCER, [], [], true));
    const second = buildWaveEntry(state, 2, SEGURAR, [], [], false);
    assert.equal(second.index, 1);
    assert.equal(second.gateVerdict, "segurar");
  });
});
