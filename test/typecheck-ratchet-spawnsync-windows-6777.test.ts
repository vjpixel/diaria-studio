/**
 * test/typecheck-ratchet-spawnsync-windows-6777.test.ts (#6777)
 *
 * `runTscTest()` chama `spawnSync("npx", [...])`. No Windows, `npx` é um
 * wrapper `.cmd`, não um executável direto — sem `shell: true`, `spawnSync`
 * falha com `spawnSync npx ENOENT` mesmo com `npx tsc ... --noEmit` funcionando
 * normalmente quando digitado à mão no shell (achado ao vivo, PR #6776).
 *
 * `test/typecheck-ratchet-script.test.ts` deliberadamente NUNCA invoca
 * `runTscTest` (mantém aquele arquivo rápido/zero-processo) — este teste,
 * separado, invoca a função de verdade uma única vez para provar que ela não
 * lança mais `ENOENT`. Isto NÃO reproduz o bug original em CI (CI roda Linux,
 * onde `npx` já era resolvido normalmente mesmo sem `shell: true` — só o
 * Windows precisa do wrapper `.cmd`), mas verificado manualmente numa máquina
 * Windows (revertendo `shell: true`) o teste falha com o mesmo `ENOENT` do
 * relato original, e passa com o fix — a asserção real é "não lança
 * ENOENT/erro de execução", que é platform-agnostic e cobre o caminho de
 * código inteiro (não só a presença literal de `shell: true` no source).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runTscTest } from "../scripts/typecheck-ratchet.ts";

describe("runTscTest (#6777, spawnSync npx no Windows)", () => {
  it("não lança ao executar 'npx tsc ... --noEmit' (spawnSync resolve o binário)", () => {
    // Sem `timeout` explícito no teste: `tsc -p tsconfig.test.json --noEmit`
    // sobre o repo inteiro pode levar dezenas de segundos (mesmo custo que
    // `npm run typecheck` já paga) — o runner do node:test usa seu próprio
    // teto default, generoso o bastante para isso.
    assert.doesNotThrow(() => {
      runTscTest();
    });
  });
});
