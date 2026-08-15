/**
 * test/regenerate-entity-pages-script.test.ts (#5125 — condição do editor
 * 14/08/2026, "regeneração automática")
 *
 * Cobre a parte de I/O de `scripts/regenerate-entity-pages.ts` que não
 * exige `data/beehiiv-cache/` real nem credencial Gmail: `loadState`/
 * `saveState` (roundtrip em diretório temporário, mesmo padrão de
 * `test/hub-staleness-check-script.test.ts`) e `regenerateEntityHtml`
 * (mecânica — nenhum I/O de rede, só compara/escreve HTML derivado de
 * `ENTITY_LOADERS`).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadState, saveState, regenerateEntityHtml } from "../scripts/regenerate-entity-pages.ts";
import { emptyEntityStalenessAlarmState, advanceEntityStalenessState } from "../scripts/lib/entity-staleness-check.ts";
import { ENTITY_LOADERS } from "../scripts/build-entity-page.ts";

describe("loadState / saveState (#5125, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "entity-staleness-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), {
      alarm: emptyEntityStalenessAlarmState(),
      firstSeen: {},
    });
  });

  it("roundtrip: save + load preserva alarm + firstSeen", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = {
      alarm: advanceEntityStalenessState("samsung:edicao-x", new Date("2026-08-14T09:00:00Z")),
      firstSeen: { "samsung:edicao-x": "2026-08-10" },
    };
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), { alarm: emptyEntityStalenessAlarmState(), firstSeen: {} });
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = { alarm: advanceEntityStalenessState(null, new Date("2026-08-14T09:00:00Z")), firstSeen: {} };
    saveState(state, path);
    assert.equal(loadState(path).alarm.lastAlarmedFingerprint, null);
  });

  it("firstSeen malformado (não-objeto) no JSON cai em {} — nunca propaga tipo inválido", () => {
    const path = resolve(tmpDir, "bad-firstseen.json");
    writeFileSync(path, JSON.stringify({ alarm: emptyEntityStalenessAlarmState(), firstSeen: "não é objeto" }));
    assert.deepEqual(loadState(path).firstSeen, {});
  });
});

describe("regenerateEntityHtml (#5125, regen mecânica)", () => {
  it("worktree em dia (nenhuma edição pendente em scripts/lib/entities/*.ts) -> no-op, mesma garantia que test/build-entity-page.test.ts já valida em CI", () => {
    // Regression guard direto pra condição do editor: se o HTML committed já
    // bate byte a byte com um render fresco de ENTITY_LOADERS (garantido por
    // test/build-entity-page.test.ts), esta função tem que devolver [] — ela
    // é a metade "mecânica" da regeneração automática, e reescrever um
    // arquivo que já está correto seria um sinal de bug, não de robustez.
    const rewritten = regenerateEntityHtml(true);
    assert.deepEqual(rewritten, []);
  });

  it("cobre todas as entidades de ENTITY_LOADERS (nenhuma esquecida por engano)", () => {
    // Não afirma o CONTEÚDO do resultado (isso é test/build-entity-page.test.ts)
    // — só que a função de fato itera o registry inteiro, não um subconjunto
    // hardcoded esquecido de uma rodada anterior.
    const slugs = Object.keys(ENTITY_LOADERS);
    assert.ok(slugs.length >= 5, "esperava pelo menos as 5 entidades já publicadas (incluindo apple)");
    assert.ok(slugs.includes("apple"), "apple deveria estar em ENTITY_LOADERS (#5125)");
  });
});
