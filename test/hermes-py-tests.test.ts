/**
 * test/hermes-py-tests.test.ts (#6968)
 *
 * O wrapper que DESCOBRE (opção 2 da #6968) — varre `hermes/scripts/**`
 * recursivamente (`findHermesPyTestFiles`, `scripts/lib/hermes-py-test-discovery.ts`)
 * e executa CADA `.test.py` achado via `node --test`, falhando por arquivo.
 * Fecha a classe inteira de "teste `.test.py` que só roda se alguém
 * invocar à mão" de uma vez, em vez de exigir um wrapper manual novo a
 * cada `.test.py` futuro (padrão anterior:
 * `test/hermes-model-cost-report-py.test.ts`/#6963).
 *
 * Substitui `test/hermes-model-cost-report-py.test.ts` — este wrapper
 * genérico já cobre aquele arquivo (e os outros 2 que ainda não tinham
 * wrapper nenhum: `monitor-cron-model-rotation.test.py`,
 * `pause-cron-on-ratelimit.test.py`), então manter os dois rodaria o
 * mesmo `.test.py` duas vezes por run de CI sem ganho nenhum.
 *
 * Guard de propriedade (pedido explícito da issue, "senão a opção 1 volta
 * a divergir no próximo arquivo" — vale igual pra garantir que a opção 2
 * não silencie sozinha): a suíte FALHA se a varredura real do repo vier
 * vazia — um diretório renomeado, uma extensão que mudasse de
 * `.test.py` pra outra coisa, ou um bug no discovery em si precisam
 * quebrar CI, não reduzir silenciosamente pra "nenhum teste python pra
 * rodar".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { findHermesPyTestFiles } from "../scripts/lib/hermes-py-test-discovery.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HERMES_SCRIPTS_DIR = join(ROOT, "hermes", "scripts");

const discovered = findHermesPyTestFiles(HERMES_SCRIPTS_DIR);

describe("descoberta de .test.py sob hermes/scripts/ (#6968)", () => {
  it("encontra pelo menos 1 arquivo — lista vazia é suspeita, não 'nada a rodar'", () => {
    assert.ok(
      discovered.length > 0,
      "findHermesPyTestFiles não achou nenhum .test.py sob hermes/scripts/ — " +
        "diretório renomeado, extensão mudou, ou bug no discovery. Isto precisa " +
        "quebrar CI, não silenciar pra 'nenhum teste python'.",
    );
  });

  it("inclui os 3 arquivos conhecidos no momento desta issue (#6968) — regressão de cobertura", () => {
    const relPaths = discovered.map((p) => relative(HERMES_SCRIPTS_DIR, p));
    for (const expected of ["hermes-model-cost-report.test.py", "monitor-cron-model-rotation.test.py", "pause-cron-on-ratelimit.test.py"]) {
      assert.ok(relPaths.includes(expected), `esperava achar ${expected}, achou: ${relPaths.join(", ")}`);
    }
  });
});

for (const scriptPath of discovered) {
  const label = relative(ROOT, scriptPath);
  describe(`${label} roda em CI (#6968)`, () => {
    it(`python3 ${label} sai com exit 0`, () => {
      // Cada `.test.py` tem seu próprio marcador de sucesso em texto livre
      // ("TODOS OS TESTES PASSARAM", "OK — todos os asserts passaram", ...)
      // — não há um formato único entre eles. O sinal confiável e comum a
      // TODOS é o exit code: cada script já termina com assert/`sys.exit`
      // != 0 em caso de falha (ver os próprios arquivos). `execFileSync`
      // lança em exit != 0, então isto já falha o teste sem depender de
      // casar uma string específica por arquivo.
      try {
        execFileSync("python3", [scriptPath], { encoding: "utf8" });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        assert.fail(`${label} falhou — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`);
      }
    });
  });
}
