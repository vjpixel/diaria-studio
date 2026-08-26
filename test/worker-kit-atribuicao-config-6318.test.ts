/**
 * test/worker-kit-atribuicao-config-6318.test.ts (#6318)
 *
 * Guard de CONFIG, não de código. O bug do #6318 não foi uma linha errada —
 * foi uma ausência: os 3 workers ganharam `SUBSCRIBE_BACKEND = "kit"` no
 * switchover (#6048) e ninguém setou os `KIT_UTM_*_FIELD`. O código de
 * gravação estava lá, correto, e o gate-por-ausência o desligou em silêncio.
 * Toda a base nova entrou sem atribuição entre 25/08 e 26/08 sem um único
 * erro em log.
 *
 * Mesma família do #6291 ("tornar o esquecimento de SUBSCRIBE_BACKEND
 * inexprimível"): a config permitia um estado de produção silenciosamente
 * cego, então a checagem tem que morar na config, não na revisão humana.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workers cujo cadastro pode apontar pro Kit. */
const SIGNUP_WORKERS = ["poll", "cursos", "reativar"] as const;

/** As 4 vars que o caminho `subscribeToKit`/`activateSubscriptionKit` lê. */
const REQUIRED_UTM_VARS = [
  "KIT_UTM_SOURCE_FIELD",
  "KIT_UTM_MEDIUM_FIELD",
  "KIT_UTM_CAMPAIGN_FIELD",
  "KIT_REFERRING_SITE_FIELD",
] as const;

function readWrangler(worker: string): string {
  return readFileSync(resolve(ROOT, "workers", worker, "wrangler.toml"), "utf8");
}

/** Linha `CHAVE = "valor"` não-comentada. Comentário citando a chave (que os
 *  3 arquivos têm de sobra) não pode contar como configuração. */
function declaraVar(toml: string, chave: string): boolean {
  return toml.split("\n").some((linha) => new RegExp(`^\\s*${chave}\\s*=`).test(linha));
}

function backendEhKit(toml: string): boolean {
  return toml.split("\n").some((linha) => /^\s*SUBSCRIBE_BACKEND\s*=\s*"kit"/.test(linha));
}

describe("config de atribuicao dos workers de cadastro (#6318)", () => {
  for (const worker of SIGNUP_WORKERS) {
    test(`${worker}: backend Kit exige os 4 KIT_UTM_*_FIELD`, () => {
      const toml = readWrangler(worker);
      if (!backendEhKit(toml)) return; // funil ainda na Beehiiv — nada a exigir
      const faltando = REQUIRED_UTM_VARS.filter((v) => !declaraVar(toml, v));
      assert.deepEqual(
        faltando,
        [],
        `workers/${worker}/wrangler.toml tem SUBSCRIBE_BACKEND="kit" mas nao declara ${faltando.join(", ")} — ` +
          `cadastro vai entrar no Kit SEM atribuicao, em silencio (foi o #6318).`,
      );
    });

    test(`${worker}: observability ligada (fonte de reconstrucao se a atribuicao falhar de novo)`, () => {
      const toml = readWrangler(worker);
      assert.ok(
        /^\s*\[observability\]/m.test(toml) && /^\s*enabled\s*=\s*true/m.test(toml),
        `workers/${worker}/wrangler.toml sem [observability] enabled=true — sem log retido, ` +
          `uma perda de atribuicao vira irrecuperavel (foi o caso do reativar no #6318).`,
      );
    });
  }

  test("comentario citando a var nao conta como declaracao", () => {
    assert.equal(declaraVar('# KIT_UTM_SOURCE_FIELD = "x"', "KIT_UTM_SOURCE_FIELD"), false);
    assert.equal(declaraVar('KIT_UTM_SOURCE_FIELD = "utm_source"', "KIT_UTM_SOURCE_FIELD"), true);
  });
});
