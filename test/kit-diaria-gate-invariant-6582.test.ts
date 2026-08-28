/**
 * test/kit-diaria-gate-invariant-6582.test.ts (#6582)
 *
 * Cobre `checkKitDiariaExclusiveAudienceDispatched` em STAGE_5_RULES — o
 * guard que fecha a lacuna descrita na issue: o playbook antigo tratava
 * "skipped"/"failed" do dispatch do canal Kit paralelo como WARNING não-
 * bloqueante e o Stage 6 aprovava normal, mesmo quando a tag `rampa-kit`
 * (audiência EXCLUSIVA desde a migração das ondas 0/1, #6504) ficava sem
 * ninguém recebendo a edição.
 *
 * O cenário concreto da issue: `resolveAudienceTagId` falha a resolver a
 * tag → dispatch devolve `skipped` → orchestrator loga WARNING → gate 6
 * segue sem menção ao Kit → editor aprova → ninguém na tag recebe. Esta
 * regra é o que passa a bloquear esse caminho mecanicamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkKitDiariaExclusiveAudienceDispatched,
  STAGE_5_RULES,
} from "../scripts/lib/invariant-checks/stage-5.ts";
import { makeEditionDir } from "./_helpers/make-edition-dir.ts";

const ENABLED_CFG = { kit_diaria: { enabled: true, audience_tag: "rampa-kit" } };
const DISABLED_CFG = { kit_diaria: { enabled: false } };

describe("kit-diaria-exclusive-audience-dispatched registrado em STAGE_5_RULES (#6582)", () => {
  it("rule presente, severity error (BLOQUEIA — não é mais warning-only), postDispatchOnly", () => {
    const rule = STAGE_5_RULES.find((r) => r.id === "kit-diaria-exclusive-audience-dispatched");
    assert.ok(rule, "kit-diaria-exclusive-audience-dispatched deve estar em STAGE_5_RULES");
    assert.equal(rule?.stage, 5);
    // Só existe DEPOIS que o dispatch da Etapa 5 rodou.
    assert.equal(rule?.postDispatchOnly, true);
  });
});

describe("checkKitDiariaExclusiveAudienceDispatched (#6582)", () => {
  it("canal DESLIGADO ⇒ [] — nada a checar", () => {
    const dir = makeEditionDir("kit-diaria-gate-6582-");
    try {
      assert.deepEqual(checkKitDiariaExclusiveAudienceDispatched(dir, DISABLED_CFG), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO #6582: canal LIGADO + estado AUSENTE (o cenário 'skipped' da issue) ⇒ error, GATE-BLOCKING", () => {
    const dir = makeEditionDir("kit-diaria-gate-6582-");
    try {
      const violations = checkKitDiariaExclusiveAudienceDispatched(dir, ENABLED_CFG);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "error");
      assert.equal(violations[0].rule, "kit-diaria-exclusive-audience-dispatched");
      assert.match(violations[0].message, /ausente/);
      assert.match(violations[0].message, /rampa-kit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canal LIGADO + estado presente mas SEM broadcast_id (dispatch failed) ⇒ error", () => {
    const dir = makeEditionDir("kit-diaria-gate-6582-");
    try {
      writeFileSync(
        resolve(dir, "_internal", "kit-diaria-published.json"),
        JSON.stringify({ status: "failed" }),
      );
      const violations = checkKitDiariaExclusiveAudienceDispatched(dir, ENABLED_CFG);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "error");
      assert.match(violations[0].message, /broadcast_id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("estado ILEGÍVEL (JSON malformado) ⇒ error, não crash", () => {
    const dir = makeEditionDir("kit-diaria-gate-6582-");
    try {
      writeFileSync(resolve(dir, "_internal", "kit-diaria-published.json"), "{ not json");
      const violations = checkKitDiariaExclusiveAudienceDispatched(dir, ENABLED_CFG);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canal LIGADO + estado com broadcast_id numérico ⇒ [] — dispatch completou (caminho feliz)", () => {
    const dir = makeEditionDir("kit-diaria-gate-6582-");
    try {
      writeFileSync(
        resolve(dir, "_internal", "kit-diaria-published.json"),
        JSON.stringify({ broadcast_id: 12345, status: "draft" }),
      );
      assert.deepEqual(checkKitDiariaExclusiveAudienceDispatched(dir, ENABLED_CFG), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem configOverride, lê platform.config.json REAL do repo — nunca lança", () => {
    const dir = makeEditionDir("kit-diaria-gate-6582-");
    try {
      // Sem configOverride e sem mockar o filesystem: exercita o branch de
      // leitura do platform.config.json REAL do repo — só confirma que a
      // função não lança, qualquer que seja o estado real de kit_diaria.
      assert.doesNotThrow(() => checkKitDiariaExclusiveAudienceDispatched(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
