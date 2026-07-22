/**
 * test/studio-server-env-loading.test.ts (#3867)
 *
 * Regression test para o endurecimento defensivo do #3867: `server.ts` deve
 * chamar `loadProjectEnv()` EXPLICITAMENTE no próprio topo, em vez de
 * depender apenas do efeito colateral transitivo de importar
 * `dashboard-clarice.ts` (que já chama `loadProjectEnv()` no próprio topo,
 * #3563).
 *
 * Por que um teste ESTÁTICO (regex sobre o source), e não um teste
 * comportamental via HTTP: `loadProjectEnv()` (scripts/lib/env-loader.ts)
 * resolve a raiz do projeto a partir do PRÓPRIO `import.meta.url` do
 * arquivo, sem override — `server.ts` (mesmo padrão de dashboard-clarice.ts
 * e studio-integrations.ts) chama a versão SEM argumento, então não há
 * como redirecionar o carregamento pra um `.env.local` de fixture isolado
 * sem escrever no `.env.local` REAL do projeto (anti-padrão já documentado
 * em scripts/check-invariants.ts: "DIARIA_PROJECT_ROOT permite override pra
 * teste e2e sem hijack do .env.local real do projeto", #1010 item 4). E
 * mesmo que escrevêssemos lá, a garantia de ordenação de execução de módulos
 * ESM (todo módulo estaticamente importado termina de rodar ANTES do corpo
 * do módulo importador, independente de onde a chamada aparece no arquivo)
 * faria o cenário "sem depender do import de dashboard-clarice.ts" aparentar
 * funcionar de qualquer forma — o que estaria testando o
 * comportamento ATUAL (já correto, #3563), não a garantia NOVA que #3867
 * adiciona (código explícito que sobrevive à REMOÇÃO do import
 * transitivo). O invariante real que #3867 pede é sintático: "existe uma
 * chamada própria, no topo, que não depende de outro módulo trazer o
 * loader" — exatamente o que `upload-images-public.test.ts` ("regression
 * #1157") já estabelece como padrão pra este mesmo tipo de guard nesta
 * base.
 *
 * `test/studio-apoios-page.test.ts` e `test/studio-dashboard-panels.test.ts`
 * seguem cobrindo o caminho comportamental (limpando as env vars
 * deliberadamente pra testar o fail-soft) — não duplicado aqui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = resolve(ROOT, "scripts/studio-ui/server.ts");

describe("studio-ui/server.ts — loadProjectEnv() explícito (#3867)", () => {
  const src = readFileSync(SERVER_PATH, "utf8");

  it("importa loadProjectEnv de lib/env-loader.ts", () => {
    assert.match(
      src,
      /import\s+\{\s*loadProjectEnv\s*\}\s+from\s+["']\.\.\/lib\/env-loader\.ts["']/,
      "scripts/studio-ui/server.ts deve importar loadProjectEnv de ../lib/env-loader.ts",
    );
  });

  it("chama loadProjectEnv() em scope top-level (não dentro de função/handler)", () => {
    assert.match(
      src,
      /^loadProjectEnv\(\);?\s*$/m,
      "scripts/studio-ui/server.ts deve chamar loadProjectEnv() em scope top-level — guarda contra " +
        "remoção acidental (ex: mover pra dentro de uma função, ou apagar achando redundante).",
    );
  });

  it("a chamada explícita aparece ANTES do import de dashboard-clarice.ts — não depende dele pra existir", () => {
    const callMatch = src.match(/^loadProjectEnv\(\);?\s*$/m);
    const importMatch = src.match(/import\s*\{\s*buildClariceDashboardHtml\s*\}\s*from\s*["']\.\/dashboard-clarice\.ts["']/);
    assert.ok(callMatch, "chamada explícita loadProjectEnv() não encontrada");
    assert.ok(importMatch, "import de dashboard-clarice.ts não encontrado (arquivo mudou de forma inesperada?)");
    assert.ok(
      (callMatch!.index as number) < (importMatch!.index as number),
      "loadProjectEnv() explícito deve vir ANTES do import de dashboard-clarice.ts no arquivo — " +
        "prova que a chamada não foi só colada logo depois dele (o que leria como 'só reforça o mesmo " +
        "import', não como uma garantia própria e independente).",
    );
  });

  it("regressão: se o import de dashboard-clarice.ts for removido/lazy-import no futuro, a chamada " +
    "explícita permanece no arquivo (checagem sintática, não depende do import transitivo pra passar)", () => {
    // Esta asserção é deliberadamente independente da anterior: mesmo que o
    // import de dashboard-clarice.ts deixe de existir, a suite ainda cobra
    // a presença da chamada própria — é exatamente esse cenário (reorg
    // remove o import transitivo, env quebra em silêncio) que #3867 existe
    // pra prevenir.
    assert.match(src, /loadProjectEnv\(\)/);
  });
});
