/**
 * test/onboarding-kit-transport-run-lock-7922.test.ts (#7922, self-review)
 *
 * Trava a FIAÇÃO de exclusão mútua de `claimLot`/`persistLotUpdate`
 * (`scripts/onboarding-kit-transport-run.ts`) contra um store REAL em disco
 * — o que os testes puros de `decideLotReconciliation`
 * (`test/onboarding-kit-transport-7922.test.ts`) não alcançam: aquele
 * arquivo prova que a DECISÃO está certa dado um snapshot; este prova que
 * duas chamadas concorrentes nunca criam DOIS lotes/broadcasts pra mesma
 * chave, porque cada uma relê o disco sob lock em vez de confiar numa cópia
 * em memória capturada antes.
 *
 * Achado do self-review desta PR: a 1ª versão do script decidia "existe
 * lote?" sobre o `store` capturado uma vez no topo de `main()` — duas
 * invocações concorrentes do processo podiam ambas concluir "não existe,
 * crio" sem nunca verem a criação uma da outra. `claimLot` fecha isso lendo
 * o disco DENTRO do lock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { claimLot, persistLotUpdate } from "../scripts/onboarding-kit-transport-run.ts";
import { readStore } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLot, OnboardingKitLotPlan } from "../scripts/lib/onboarding-kit-transport.ts";

function tmpStorePath(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  const storePath = resolve(dir, "store.json");
  writeFileSync(
    storePath,
    JSON.stringify({ version: 1, last_detection_cursor: 1, last_detection_backend: "kit", d10_brevo_list_id: null, entries: {} }),
  );
  return storePath;
}

function lotPlan(over: Partial<OnboardingKitLotPlan> = {}): OnboardingKitLotPlan {
  return {
    lot_id: "email1-2026-09-15-01",
    kind: "email1",
    dateIso: "2026-09-15",
    tag_name: "onboarding-email1-2026-09-15-01",
    recipient_subscription_ids: ["1", "2"],
    recipient_emails: ["a@x.com", "b@x.com"],
    ...over,
  };
}

describe("claimLot — exclusão mútua entre rodadas concorrentes (#7922)", () => {
  it("1ª chamada cria (pending), persiste no disco antes de devolver", () => {
    const storePath = tmpStorePath("diaria-7922-lock-create-");
    try {
      const claim = claimLot(storePath, lotPlan(), Date.now());
      assert.equal(claim.decision.action, "create");
      assert.ok(claim.lot);
      assert.equal(claim.lot?.status, "pending");
      const { store } = readStore(storePath);
      assert.ok(store.kit_transport?.lots[claim.lot!.lot_id], "lote pending já está no disco, não só em memória");
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("2ª chamada (mesma chave, logo em seguida) vê o pending recém-criado e É BLOQUEADA — nunca duplica", () => {
    const storePath = tmpStorePath("diaria-7922-lock-race-");
    try {
      const plan = lotPlan();
      const first = claimLot(storePath, plan, Date.now());
      assert.equal(first.decision.action, "create");

      // Simula uma 2ª invocação CONCORRENTE do script — chama de novo com a
      // MESMA chave de lote, sem saber que a 1ª acabou de criar. Como
      // `claimLot` relê o disco (não uma cópia em memória capturada antes
      // das duas chamadas), ela VÊ o pending da 1ª e recusa duplicar.
      const second = claimLot(storePath, plan, Date.now());
      assert.equal(second.decision.action, "blocked_concurrent");
      assert.equal(second.lot, null);

      // Só 1 lote no disco, nunca 2.
      const { store } = readStore(storePath);
      assert.equal(Object.keys(store.kit_transport?.lots ?? {}).length, 1);
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("depois que o 1º broadcast é confirmado (persistLotUpdate), uma nova chamada REUSA — nunca recria", () => {
    const storePath = tmpStorePath("diaria-7922-lock-reuse-");
    try {
      const plan = lotPlan();
      const claim = claimLot(storePath, plan, Date.now());
      const lot = claim.lot!;
      lot.broadcast_id = 999;
      lot.status = "created";
      persistLotUpdate(storePath, lot);

      const retry = claimLot(storePath, plan, Date.now());
      assert.equal(retry.decision.action, "reuse");
      assert.equal(retry.lot?.broadcast_id, 999);
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("lote pending VELHO (timeout) permite recriar — não trava para sempre num crash", () => {
    const storePath = tmpStorePath("diaria-7922-lock-timeout-");
    try {
      const plan = lotPlan();
      const longAgoMs = Date.now() - 20 * 60_000; // > LOT_STALE_AFTER_MS (15min)
      const first = claimLot(storePath, plan, longAgoMs);
      assert.equal(first.decision.action, "create");
      // `first.lot.created_at` foi carimbado com `longAgoMs` — agora, "agora"
      // de verdade, o registro já é velho o bastante pra estar stale.
      const second = claimLot(storePath, plan, Date.now());
      assert.equal(second.decision.action, "recreate_after_timeout");
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("gap #1/#4 (#7922, audit pós-merge): recriar SEM broadcast_id nunca reusa lot_id/tag_name — ganha seq novo, preserva o registro velho", () => {
    // Cenário central do gap #1 (risco residual documentado na docstring de
    // `decideLotReconciliation`): o lote velho NUNCA teve `broadcast_id`
    // persistido — é exatamente o caso onde um `POST /broadcasts` anterior
    // pode ter tido SUCESSO no Kit, mas o processo local morreu antes de
    // aprender o `broadcast_id` (resposta perdida). Não há capacidade de
    // busca por nome/tag no Kit (ver docstring do módulo) pra confirmar isso
    // — este teste documenta e trava o que o CÓDIGO faz nesse caso: nunca
    // sobrescreve a identidade velha (preserva evidência de auditoria) e
    // nunca reusa a MESMA tag pro novo lote (reduz, não elimina, a chance de
    // colisão com um broadcast órfão).
    const storePath = tmpStorePath("diaria-7922-lock-recreate-identity-");
    try {
      const plan = lotPlan();
      const longAgoMs = Date.now() - 20 * 60_000;
      const first = claimLot(storePath, plan, longAgoMs);
      assert.equal(first.decision.action, "create");
      assert.equal(first.lot?.broadcast_id, null, "pré-condição do cenário: broadcast_id NUNCA foi persistido pro lote velho");
      const staleLotId = first.lot!.lot_id;

      const second = claimLot(storePath, plan, Date.now());
      assert.equal(second.decision.action, "recreate_after_timeout");
      assert.ok(second.lot, "recreate_after_timeout sempre devolve um novo lote pending");

      // Identidade NOVA — nunca a mesma do lote velho.
      assert.notEqual(second.lot!.lot_id, staleLotId, "recriar precisa de um lot_id novo, não o reaproveitado do lote velho");
      assert.equal(second.lot!.lot_id, "email1-2026-09-15-02", "seq sobe pra 02 — 01 já está ocupado pelo lote velho");
      assert.equal(second.lot!.tag_name, "onboarding-email1-2026-09-15-02");
      assert.notEqual(second.lot!.tag_name, first.lot!.tag_name, "tag nova — nunca reusa a tag do lote velho (possível colisão com broadcast órfão)");

      // O registro VELHO continua no disco, intocado — nunca sobrescrito.
      const { store } = readStore(storePath);
      const lots = store.kit_transport?.lots ?? {};
      assert.equal(Object.keys(lots).length, 2, "2 lotes no disco: o velho (evidência) + o novo (pending)");
      assert.ok(lots[staleLotId], "lote velho preservado — auditoria posterior ainda consegue ver a tentativa original");
      assert.equal((lots[staleLotId] as OnboardingKitLot).broadcast_id, null);
      assert.ok(lots[second.lot!.lot_id], "lote novo já está persistido no disco");
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("gap #4: 2ª recriação em sequência (mesmo dia/etapa) soma +1 sobre o MAIOR seq existente, não sobre o lote que originou a decisão", () => {
    const storePath = tmpStorePath("diaria-7922-lock-recreate-multi-");
    try {
      const plan = lotPlan();
      const t0 = Date.now() - 40 * 60_000; // bem velho
      const first = claimLot(storePath, plan, t0); // seq 01, cria em t0
      assert.equal(first.lot!.lot_id, "email1-2026-09-15-01");

      // t1 é bem depois de t0 (seq 01 fica stale) — 1ª recriação, seq 02,
      // registrada como criada em t1.
      const t1 = t0 + 30 * 60_000;
      const second = claimLot(storePath, plan, t1);
      assert.equal(second.decision.action, "recreate_after_timeout");
      assert.equal(second.lot!.lot_id, "email1-2026-09-15-02");

      // `plan` continua sendo o plano ORIGINAL (seq 01, imutável) — mesmo
      // assim, a 3ª chamada (#7922 gap #4: `claimLot` agora olha pro lote
      // MAIS NOVO da chave, `findLatestLotForKindDate`, nunca fixo no seq 01)
      // precisa enxergar o seq 02 (stale relativamente a t2, bem depois de
      // t1) e pular pro seq 03 — não recriar em cima do seq 01 de novo, nem
      // colidir/sobrescrever o lote da 1ª recriação.
      const t2 = t1 + 30 * 60_000;
      const third = claimLot(storePath, plan, t2);
      assert.equal(third.decision.action, "recreate_after_timeout");
      assert.equal(third.lot!.lot_id, "email1-2026-09-15-03");

      const { store } = readStore(storePath);
      assert.equal(Object.keys(store.kit_transport?.lots ?? {}).length, 3, "3 lotes distintos no disco — nenhuma sobrescrita entre recriações");
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("gap #4: depois que o lote RECRIADO (seq 02) tem broadcast confirmado, a próxima chamada REUSA — nunca fica presa olhando pro seq 01 morto", () => {
    // Fecha o loop que o gap #4 abre: não basta criar uma identidade nova UMA
    // vez — a PRÓXIMA reconciliação precisa enxergar esse lote novo como o
    // estado atual da chave, senão toda chamada seguinte recriaria de novo
    // pra sempre (o seq 01 nunca deixa de estar stale — nada nunca o
    // atualiza).
    const storePath = tmpStorePath("diaria-7922-lock-recreate-then-reuse-");
    try {
      const plan = lotPlan();
      const t0 = Date.now() - 40 * 60_000;
      claimLot(storePath, plan, t0); // seq 01, stale

      const t1 = t0 + 30 * 60_000;
      const recreated = claimLot(storePath, plan, t1); // recreate_after_timeout → seq 02
      assert.equal(recreated.lot!.lot_id, "email1-2026-09-15-02");

      // Simula o broadcast do lote recriado sendo confirmado (mesmo passo
      // que o executor faz depois de `createBroadcast`).
      recreated.lot!.broadcast_id = 777;
      recreated.lot!.status = "created";
      persistLotUpdate(storePath, recreated.lot!);

      // Mesmo com o seq 01 ainda parado no store (velho, sem broadcast, pra
      // sempre "stale" se alguém olhasse pra ele), a próxima chamada — a
      // QUALQUER momento depois — precisa REUSAR o seq 02 confirmado, nunca
      // criar um seq 03.
      const next = claimLot(storePath, plan, t1 + 60 * 60_000);
      assert.equal(next.decision.action, "reuse");
      assert.equal(next.lot?.lot_id, "email1-2026-09-15-02");
      assert.equal(next.lot?.broadcast_id, 777);

      const { store } = readStore(storePath);
      assert.equal(Object.keys(store.kit_transport?.lots ?? {}).length, 2, "só 2 lotes no disco — reuse nunca cria um 3º");
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("store CORROMPIDO — claimLot lança em vez de decidir/escrever sobre um snapshot esvaziado silenciosamente", () => {
    // #7922 (gap #2, audit pós-merge): `readStore` engolia JSON ilegível
    // devolvendo `{ store: emptyStore(), corrupted: true }` sem lançar. A
    // versão anterior de `claimLot` destructurava só `{ store }` — o
    // `corrupted` era descartado, então esta função (que ESCREVE de volta
    // via `writeStore`) teria persistido o vazio por cima do arquivo bom.
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-7922-lock-corrupted-claim-"));
    const storePath = resolve(dir, "store.json");
    writeFileSync(storePath, "{ isto não é json válido");
    try {
      assert.throws(() => claimLot(storePath, lotPlan(), Date.now()), /corrompido/i);
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("store CORROMPIDO — persistLotUpdate lança em vez de sobrescrever o arquivo bom com um store vazio", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-7922-lock-corrupted-persist-"));
    const storePath = resolve(dir, "store.json");
    writeFileSync(storePath, "{ isto não é json válido");
    try {
      const fakeLot: OnboardingKitLot = {
        lot_id: "email1-2026-09-15-01",
        kind: "email1",
        tag_name: "onboarding-email1-2026-09-15-01",
        tag_id: 1,
        broadcast_id: 999,
        recipient_subscription_ids: ["1"],
        recipient_emails: ["a@x.com"],
        status: "created",
        created_at: new Date().toISOString(),
        send_at: null,
        last_reconciled_at: null,
        last_error: null,
      };
      assert.throws(() => persistLotUpdate(storePath, fakeLot), /corrompido/i);
      // O arquivo no disco continua exatamente como estava — nunca foi
      // sobrescrito por um store vazio.
      const raw = readFileSync(storePath, "utf8");
      assert.equal(raw, "{ isto não é json válido");
    } finally {
      rmSync(storePath, { force: true });
    }
  });

  it("persistLotUpdate nunca apaga OUTRO lote já presente no disco (relê fresco antes de escrever)", () => {
    const storePath = tmpStorePath("diaria-7922-lock-merge-");
    try {
      const planA = lotPlan({ lot_id: "email1-2026-09-15-01" });
      const planB = lotPlan({ lot_id: "email2-2026-09-15-01", kind: "email2" });
      const claimA = claimLot(storePath, planA, Date.now());
      const claimB = claimLot(storePath, planB, Date.now());
      claimA.lot!.broadcast_id = 111;
      persistLotUpdate(storePath, claimA.lot!);

      const { store } = readStore(storePath);
      assert.equal(store.kit_transport?.lots[claimA.lot!.lot_id]?.broadcast_id, 111);
      assert.ok(store.kit_transport?.lots[claimB.lot!.lot_id], "lote B, criado por outra chamada, continua no disco");
    } finally {
      rmSync(storePath, { force: true });
    }
  });
});
