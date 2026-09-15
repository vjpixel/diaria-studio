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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { claimLot, persistLotUpdate } from "../scripts/onboarding-kit-transport-run.ts";
import { readStore } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLotPlan } from "../scripts/lib/onboarding-kit-transport.ts";

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
