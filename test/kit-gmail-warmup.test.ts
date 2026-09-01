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
  computeOutOfBandReturned,
  buildOutOfBandWaveEntry,
  partitionByConfirmedTag,
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

describe("computeOutOfBandReturned (#6964)", () => {
  const cohort = ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com"];

  it("acha quem está na tag do Kit sem nenhuma onda ter registrado", () => {
    const drift = computeOutOfBandReturned(cohort, new Set(["a@gmail.com"]), [
      "a@gmail.com",
      "c@gmail.com",
      "d@gmail.com",
    ]);
    assert.deepEqual(drift, ["c@gmail.com", "d@gmail.com"]);
  });

  it("ignora membro da tag que não pertence ao cohort recusado", () => {
    // A tag `rampa-kit` tem as ondas 0/1 da migração (feitas à mão, nunca
    // recusadas pelo Gmail): 179 membros pra 93 do cohort na medição de
    // 01/09. Sem o filtro, gente de fora do aquecimento contaria como
    // devolvida e encolheria o cohort pendente sem motivo.
    const drift = computeOutOfBandReturned(cohort, new Set(), [
      "b@gmail.com",
      "forade@outlook.com",
      "outro@gmail.com",
    ]);
    assert.deepEqual(drift, ["b@gmail.com"]);
  });

  it("normaliza os dois lados e devolve na ordem estável do cohort", () => {
    const drift = computeOutOfBandReturned(cohort, new Set([" A@GMAIL.COM "]), [
      "D@Gmail.com",
      " b@gmail.com ",
      "a@gmail.com",
    ]);
    assert.deepEqual(drift, ["b@gmail.com", "d@gmail.com"]);
  });

  it("devolve vazio quando estado e tag concordam", () => {
    assert.deepEqual(
      computeOutOfBandReturned(cohort, new Set(["a@gmail.com", "b@gmail.com"]), ["a@gmail.com", "b@gmail.com"]),
      [],
    );
  });
});

describe("regressão #6964 — onda size:0 + aplicação out-of-band", () => {
  /**
   * O cenário exato de 01/09/2026, reduzido: a rampa propôs a onda 4 e
   * tagueou ZERO (todos ainda ativos na Beehiiv ⇒ caíram inteiros em
   * `needsBeehiivDeactivation`, guard funcionando como desenhado). Em
   * seguida `kit-ramp-cohort.ts` migrou esses mesmos endereços por fora, sem
   * escrever no estado da rampa. Antes do fix, a rodada seguinte (a)
   * re-propunha quem já tinha migrado — alcance novo zero — e (b) reiniciava
   * a progressão em WARMUP_INITIAL_WAVE_SIZE por causa do `size: 0`.
   */
  const cohort = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, "0")}@gmail.com`);
  const migratedOutOfBand = cohort.slice(0, 4);

  function stateComOndaZerada(): KitGmailWarmupState {
    const base = buildInitialState(999, [...cohort]);
    const zerada = buildWaveEntry(base, 999, PODE_CRESCER, [], [...migratedOutOfBand], true);
    return { ...base, waves: [zerada] };
  }

  it("sem absorver, a rodada seguinte re-propõe quem já migrou (o bug)", () => {
    const state = stateComOndaZerada();
    const plan = planNextWave({
      rejectedEmails: state.rejectedEmails,
      alreadyReturned: returnedEmails(state),
      lastWaveSize: lastPushedWaveSize(state),
      gate: PODE_CRESCER,
    });
    // Prova do sintoma: os já migrados voltam na proposta, e o tamanho
    // reinicia no inicial em vez de dobrar.
    assert.ok(migratedOutOfBand.every((e) => plan.emails.includes(e)));
    assert.equal(plan.size, WARMUP_INITIAL_WAVE_SIZE);
  });

  it("absorvendo a migração out-of-band, ninguém já migrado é re-proposto e a progressão dobra", () => {
    const state = stateComOndaZerada();
    const drift = computeOutOfBandReturned(state.rejectedEmails, returnedEmails(state), [...migratedOutOfBand]);
    assert.deepEqual(drift, migratedOutOfBand);

    const absorbed = buildOutOfBandWaveEntry(state, 999, PODE_CRESCER, drift);
    assert.equal(absorbed.outOfBand, true);
    assert.equal(absorbed.pushed, true);
    assert.equal(absorbed.size, migratedOutOfBand.length);

    const reconciled: KitGmailWarmupState = { ...state, waves: [...state.waves, absorbed] };
    const plan = planNextWave({
      rejectedEmails: reconciled.rejectedEmails,
      alreadyReturned: returnedEmails(reconciled),
      lastWaveSize: lastPushedWaveSize(reconciled),
      gate: PODE_CRESCER,
    });

    for (const email of migratedOutOfBand) {
      assert.ok(!plan.emails.includes(email), `${email} já migrou — não pode ser re-proposto`);
    }
    assert.equal(plan.size, migratedOutOfBand.length * WARMUP_GROWTH_FACTOR);
  });

  it("absorver é idempotente — na rodada seguinte não há mais divergência", () => {
    const state = stateComOndaZerada();
    const drift = computeOutOfBandReturned(state.rejectedEmails, returnedEmails(state), [...migratedOutOfBand]);
    const reconciled: KitGmailWarmupState = {
      ...state,
      waves: [...state.waves, buildOutOfBandWaveEntry(state, 999, PODE_CRESCER, drift)],
    };
    assert.deepEqual(
      computeOutOfBandReturned(reconciled.rejectedEmails, returnedEmails(reconciled), [...migratedOutOfBand]),
      [],
    );
  });

  it("o gate continua soberano — absorção não faz a rampa crescer com entrega ruim", () => {
    const state = stateComOndaZerada();
    const drift = computeOutOfBandReturned(state.rejectedEmails, returnedEmails(state), [...migratedOutOfBand]);
    const reconciled: KitGmailWarmupState = {
      ...state,
      waves: [...state.waves, buildOutOfBandWaveEntry(state, 999, SEGURAR, drift)],
    };
    const plan = planNextWave({
      rejectedEmails: reconciled.rejectedEmails,
      alreadyReturned: returnedEmails(reconciled),
      lastWaveSize: lastPushedWaveSize(reconciled),
      gate: SEGURAR,
    });
    assert.equal(plan.skipped, true);
    assert.equal(plan.size, 0);
  });
});

describe("partitionByConfirmedTag (#6984 finding 1)", () => {
  it("separa quem a releitura confirmou na tag de quem segue pendente", () => {
    const { alreadyTagged, stillPending } = partitionByConfirmedTag(
      ["a@gmail.com", "b@gmail.com", "c@gmail.com"],
      new Set(["b@gmail.com"]),
    );
    assert.deepEqual(alreadyTagged, ["b@gmail.com"]);
    assert.deepEqual(stillPending, ["a@gmail.com", "c@gmail.com"]);
  });

  it("normaliza antes de comparar", () => {
    const { alreadyTagged } = partitionByConfirmedTag([" A@Gmail.COM "], new Set(["a@gmail.com"]));
    assert.deepEqual(alreadyTagged, [" A@Gmail.COM "]);
  });

  it("conjunto vazio de confirmados deixa tudo pendente", () => {
    const { alreadyTagged, stillPending } = partitionByConfirmedTag(["a@gmail.com"], new Set());
    assert.deepEqual(alreadyTagged, []);
    assert.deepEqual(stillPending, ["a@gmail.com"]);
  });
});

describe("regressão #6984 finding 1 — listagem em massa defasada não faz re-propor quem já migrou", () => {
  /**
   * `GET /v4/tags/{id}/subscribers` mente por ~180s depois de uma escrita
   * (armadilha 5 de `kit-client.ts`): devolve `has_next_page: false` como se
   * a lista estivesse completa. A sequência operacional NORMAL do #6964 é
   * justamente "aplicar por kit-ramp-cohort.ts e rodar a rampa em seguida" —
   * dentro da janela em que a listagem ainda não reflete.
   */
  const cohort = Array.from({ length: 30 }, (_, i) => `q${String(i).padStart(2, "0")}@gmail.com`);
  const migradosAgora = cohort.slice(0, 3);

  it("a listagem em massa defasada sozinha deixaria a onda com quem acabou de migrar", () => {
    const state = buildInitialState(1, [...cohort]);
    // Listagem defasada: não devolve ninguém, embora 3 já estejam tagueados.
    const driftPelaListagem = computeOutOfBandReturned(state.rejectedEmails, returnedEmails(state), []);
    assert.deepEqual(driftPelaListagem, [], "a listagem defasada não acusa nada — é o piso mentindo");

    const plan = planNextWave({
      rejectedEmails: state.rejectedEmails,
      alreadyReturned: returnedEmails(state),
      lastWaveSize: null,
      gate: PODE_CRESCER,
    });
    assert.ok(migradosAgora.every((e) => plan.emails.includes(e)), "sem o passo 2, os recém-migrados entram na onda");
  });

  it("a releitura da onda (direção confiável) tira os recém-migrados antes de propor", () => {
    const state = buildInitialState(1, [...cohort]);
    const plan = planNextWave({
      rejectedEmails: state.rejectedEmails,
      alreadyReturned: returnedEmails(state),
      lastWaveSize: null,
      gate: PODE_CRESCER,
    });

    const { alreadyTagged, stillPending } = partitionByConfirmedTag(plan.emails, new Set(migradosAgora));
    assert.deepEqual(alreadyTagged, migradosAgora);
    for (const email of migradosAgora) {
      assert.ok(!stillPending.includes(email), `${email} acabou de migrar — não pode ser proposto`);
    }
    // A onda sai MENOR que o planejado — preferível a propor quem já migrou.
    assert.equal(stillPending.length, plan.size - migradosAgora.length);
  });
});

describe("regressão #6984 finding 2 — absorção não engole violação de envio em dobro", () => {
  it("registra em needsBeehiivDeactivation quem foi absorvido mas continua ativo na Beehiiv", () => {
    const state = buildInitialState(1, ["a@gmail.com", "b@gmail.com"]);
    const absorbed = buildOutOfBandWaveEntry(state, 1, PODE_CRESCER, ["a@gmail.com", "b@gmail.com"], ["b@gmail.com"]);
    // Os dois seguem absorvidos (migraram de fato no lado do Kit)...
    assert.deepEqual(absorbed.emails, ["a@gmail.com", "b@gmail.com"]);
    assert.equal(absorbed.size, 2);
    // ...mas a violação fica gravada em vez de sumir.
    assert.deepEqual(absorbed.needsBeehiivDeactivation, ["b@gmail.com"]);
  });

  it("sem ninguém ativo na Beehiiv, a absorção não inventa pendência", () => {
    const state = buildInitialState(1, ["a@gmail.com"]);
    const absorbed = buildOutOfBandWaveEntry(state, 1, PODE_CRESCER, ["a@gmail.com"]);
    assert.deepEqual(absorbed.needsBeehiivDeactivation, []);
  });
});
