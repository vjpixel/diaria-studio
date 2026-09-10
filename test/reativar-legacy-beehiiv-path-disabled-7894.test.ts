/**
 * test/reativar-legacy-beehiiv-path-disabled-7894.test.ts (#7894)
 *
 * `activateSubscription` (caminho Beehiiv legado, `SUBSCRIBE_BACKEND !==
 * "kit"`) continua fazendo DELETE+CREATE com `double_opt_override: "off"` e
 * ativando direto, sem confirmação nenhuma — o #7723 fechou esse risco só
 * no caminho Kit (DOI via designer form). Achado da Fase 1.5 (rodada
 * overnight 260909-260910): risco pré-existente, não regressão, mas exige
 * pelo menos um assert de config confirmando que o caminho legado está de
 * fato desativado hoje — é o "no mínimo" que a issue propõe como alternativa
 * a portar o guard de DOI inteiro pra um caminho sem tráfego real.
 *
 * Este teste é essa assert: lê `workers/reativar/wrangler.toml` (fonte de
 * verdade do ambiente de produção — único `[vars]`, sem `[env.*]` que
 * sobrescreva) e falha se `SUBSCRIBE_BACKEND` deixar de estar fixado em
 * `"kit"` — reintroduzir o caminho Beehiiv sem-DOI em produção, por
 * regressão de config (revert acidental, `.dev.vars` incompleto promovido a
 * `wrangler.toml`, etc.), passa a quebrar CI em vez de silenciosamente
 * reabrir o risco descrito no docblock de `workers/reativar/src/index.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_TOML_PATH = resolve(ROOT, "workers", "reativar", "wrangler.toml");

describe("workers/reativar/wrangler.toml — SUBSCRIBE_BACKEND fixo em kit (#7894)", () => {
  it("declara SUBSCRIBE_BACKEND = \"kit\" no [vars] de produção", () => {
    const toml = readFileSync(WRANGLER_TOML_PATH, "utf8");
    assert.match(
      toml,
      /^SUBSCRIBE_BACKEND\s*=\s*"kit"\s*$/m,
      "SUBSCRIBE_BACKEND precisa estar fixado em \"kit\" em produção — sem isso, " +
        "o caminho Beehiiv legado de activateSubscription (DELETE+CREATE + " +
        "double_opt_override:\"off\", sem confirmação) fica ATIVO em produção " +
        "(#7894, risco descrito no docblock de workers/reativar/src/index.ts)",
    );
  });

  it("não tem nenhum [env.*] que sobrescreva SUBSCRIBE_BACKEND pra um valor diferente de kit", () => {
    // Um bloco [env.X] no wrangler.toml pode redefinir vars só pra esse
    // ambiente — se algum dia existir um ambiente de staging/preview que
    // rode sem SUBSCRIBE_BACKEND="kit" (omitido ou explicitamente outro
    // valor), esse ambiente reativaria o caminho legado sem-DOI em produção
    // real caso seja promovido por engano.
    const toml = readFileSync(WRANGLER_TOML_PATH, "utf8");
    const envBlocks = [...toml.matchAll(/^\[env\.([^\]]+)\]([\s\S]*?)(?=^\[|\z)/gm)];
    for (const [, envName, body] of envBlocks) {
      const overridesBackend = /^SUBSCRIBE_BACKEND\s*=\s*"(?!kit")/m.test(body);
      assert.equal(
        overridesBackend,
        false,
        `[env.${envName}] sobrescreve SUBSCRIBE_BACKEND pra um valor diferente de "kit" — reabre o caminho ` +
          `Beehiiv legado sem-DOI nesse ambiente (#7894)`,
      );
    }
  });
});
