/**
 * test/stage-4-kit-fixture-audit-invariant.test.ts (#6336)
 *
 * Cobre a integração do check no registry de Stage 4 e o mapeamento de exit
 * code → severity. O caminho `spawnSync` real é exercitado só para o exit 2
 * (KIT_API_KEY ausente) — determinístico e offline: sem a credencial,
 * `audit-kit-fixtures.ts` falha em `resolveKitConfig()` ANTES de qualquer
 * chamada de rede, então rodar isto neste teste nunca toca a base Kit real
 * (mesma garantia que `test/audit-kit-fixtures.test.ts` cobre via deps
 * injetadas). Os caminhos 0/1 (limpo / fixture ativo) já são cobertos sem
 * subprocesso em `test/audit-kit-fixtures.test.ts` — não duplicados aqui via
 * spawn real, que exigiria mockar fetch através da fronteira do processo.
 *
 * **#6387 — apagar `KIT_API_KEY` só do `process.env` do processo PAI não
 * garante offline.** `checkKitFixtureAudit` faz `spawnSync`; o subprocesso
 * roda `audit-kit-fixtures.ts`, que chama `loadProjectEnv()` e recarrega
 * `.env` do DISCO. Se a máquina tiver `KIT_API_KEY` real no `.env` (variável
 * documentada em `.env.example`, sincronizada via Doppler), o filho a
 * repopula sozinho e o teste dispara uma leitura real contra a base Kit de
 * produção. A correção passa um `env` explícito pro `spawnSync` (2º
 * argumento, injetável, default `process.env` em produção — ver docstring
 * de `checkKitFixtureAudit`) com `KIT_API_KEY: ""` — presente mas vazia, não
 * ausente. `dotenv` (`override:false`) só popula uma var que não existe no
 * `target` (`hasOwnProperty`); uma var já presente, mesmo vazia, nunca é
 * sobrescrita — então o subprocesso nunca reidrata a credencial real, e
 * `resolveKitConfig` trata string vazia como ausente (falsy) de qualquer
 * forma, preservando o exit code 2 determinístico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { checkKitFixtureAudit } from "../scripts/lib/invariant-checks/stage-4.ts";

describe("kit-fixture-audit invariant registration (#6336)", () => {
  it("está registrado em STAGE_4_RULES com source_issue #6336", () => {
    const rule = getRulesForStage(4).find((r) => r.id === "kit-fixture-audit");
    assert.ok(rule, "esperava entry 'kit-fixture-audit' em STAGE_4_RULES");
    assert.equal(rule!.source_issue, "#6336");
    assert.equal(rule!.stage, 4);
  });

  it("KIT_API_KEY ausente → warning, não error (fail-soft, nunca bloqueia sem credencial)", () => {
    // #6387: env explícito com KIT_API_KEY presente-mas-vazia, nunca deletada
    // do process.env do pai — deletar não impede o subprocesso de recarregar
    // a chave real do .env via loadProjectEnv() (ver docstring do arquivo).
    const envSemKitKey: NodeJS.ProcessEnv = { ...process.env, KIT_API_KEY: "" };
    const violations = checkKitFixtureAudit("/tmp/irrelevante-nao-usado-6336", envSemKitKey);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "kit-fixture-audit-unavailable");
    assert.equal(violations[0].severity, "warning");
    assert.equal(violations[0].source_issue, "#6336");
  });
});
