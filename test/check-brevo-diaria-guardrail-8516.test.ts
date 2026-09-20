/**
 * test/check-brevo-diaria-guardrail-8516.test.ts (#8516)
 *
 * O #8436 acrescentou um guard de seed blacklisted/inexistente que faz
 * `process.exit(2)` — posicionado, na época, ANTES da checagem de conta
 * Brevo suspensa do #6146. Como o `test_email` configurado (`brevo_diaria.
 * test_email`) já estava de fato `emailBlacklisted: true` em produção (o
 * próprio estado que o #8436 documenta), o `exit(2)` do guard de seed
 * disparava em toda execução ANTES do alarme de conta suspensa rodar —
 * silenciando o alarme de maior blast radius enquanto a decisão editorial
 * do #8436 (trocar o seed vs. remover o blacklist) ficasse pendente.
 *
 * O fix (#8516) reordena `main()` em `scripts/check-brevo-diaria-guardrail.ts`
 * para rodar `handleSuspendedCampaigns` (o alarme do #6146) ANTES do guard
 * de seed blacklisted — preservando o `exit(2)` existente, só não deixando
 * ele mascarar o alarme de conta suspensa.
 *
 * `main()` não é exportado nem estruturado para injeção de dependências
 * (faz `process.exit` e chamadas de rede reais) — refatorá-lo para isso
 * seria bem além do escopo deste bugfix de reordenação. Este teste guarda
 * a ordem das duas checagens diretamente no código-fonte de `main()`: a
 * chamada a `handleSuspendedCampaigns(` precisa aparecer ANTES da chamada a
 * `checkSeedEmailsBlacklisted(` no texto do arquivo — regressão simples e
 * determinística contra a reintrodução do bug (reordenar de volta).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/check-brevo-diaria-guardrail.ts",
);

test("main() — checagem de conta suspensa (#6146) roda ANTES do guard de seed blacklisted (#8436), não depois (#8516)", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");

  // Isola o corpo de main() do resto do arquivo (docstrings/outras funções
  // podem mencionar as duas issues fora de ordem sem que isso seja o bug).
  const mainStart = source.indexOf("async function main(): Promise<void> {");
  assert.ok(mainStart >= 0, "main() não encontrada no arquivo — script foi renomeado/reestruturado?");
  const mainBody = source.slice(mainStart);

  const suspendedCallIdx = mainBody.indexOf("await handleSuspendedCampaigns({");
  const seedCheckCallIdx = mainBody.indexOf("await checkSeedEmailsBlacklisted(");

  assert.ok(suspendedCallIdx >= 0, "chamada a handleSuspendedCampaigns não encontrada em main()");
  assert.ok(seedCheckCallIdx >= 0, "chamada a checkSeedEmailsBlacklisted não encontrada em main()");
  assert.ok(
    suspendedCallIdx < seedCheckCallIdx,
    "handleSuspendedCampaigns (alarme de conta suspensa, #6146) precisa rodar ANTES de " +
      "checkSeedEmailsBlacklisted (guard de seed, #8436) — do contrário, um seed já " +
      "blacklisted em produção faz exit(2) antes do alarme de maior blast radius rodar (#8516).",
  );
});
