/**
 * test/orchestrator-stage5-twitter-schedule.test.ts (#4103)
 *
 * O dispatch do X (Passo 5c-3b, `orchestrator-stage-5.md`) usava
 * `mode: "addToQueue"` (decisão do editor 260726: "a fila da Buffer respeita
 * os horários configurados no canal"). Caso real 260727: os slots da fila da
 * Buffer não têm relação com os horários editoriais dos demais canais —
 * Facebook/LinkedIn/Instagram/Threads saíram 10:00/12:30/17:30 enquanto o X
 * saiu 08:55/09:10/10:57 (dois destaques quase colados e fora de ordem de
 * divulgação). Decisão do editor no briefing 260727 (#4103, reverte 260726):
 * trocar para `mode: "customScheduled"` com `dueAt` = mesmo horário que
 * `publish-facebook.ts`/`publish-linkedin.ts`/`publish-instagram.ts`/
 * `publish-threads.ts` já calculam via `compute-social-schedule.ts`.
 *
 * Como orchestrator-stage-5.md é um prompt consumido por um agente LLM (não
 * código executado diretamente), o teste de regressão possível aqui é
 * estrutural (doc↔código) — mesmo padrão de
 * test/orchestrator-stage5-threads-schedule.test.ts /
 * test/orchestrator-stage5-instagram-schedule.test.ts. O cálculo do horário
 * em si (dueAt idêntico entre canais) é coberto com teste de unidade real em
 * test/prep-twitter-posts.test.ts (describe "#4103").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE5_PATH = resolve(ROOT, ".claude/agents/orchestrator-stage-5.md");

/** Bloco completo do Passo 5c-3b (dispatch do X via Buffer MCP), do início da
 * instrução até o início da próxima seção ("LinkedIn route"). */
function readTwitterDispatchBlock(): string {
  const src = readFileSync(STAGE5_PATH, "utf8");
  const blockStart = src.indexOf("**Passo 5c-3b:");
  assert.ok(blockStart >= 0, "Passo 5c-3b (dispatch do X via Buffer) não encontrado em orchestrator-stage-5.md");
  const blockEnd = src.indexOf("**LinkedIn route", blockStart);
  assert.ok(blockEnd > blockStart, "fim do bloco do Passo 5c-3b (marcador 'LinkedIn route') não encontrado");
  return src.slice(blockStart, blockEnd);
}

describe("#4103: dispatch do X no Stage 5 usa customScheduled (não addToQueue)", () => {
  it("create_post é chamado com mode: \"customScheduled\"", () => {
    const block = readTwitterDispatchBlock();
    assert.match(
      block,
      /mode:\s*"customScheduled"/,
      "#4103: o dispatch do X deve usar mode: \"customScheduled\", não a fila própria da Buffer",
    );
  });

  it("NÃO regride para mode: \"addToQueue\" (bug original — fila própria dessincronizada)", () => {
    const block = readTwitterDispatchBlock();
    assert.doesNotMatch(
      block,
      /mode:\s*"addToQueue"/,
      "#4103: addToQueue não tem relação com os horários editoriais dos demais canais — não deve reaparecer",
    );
  });

  it("dueAt é passado ao create_post, calculado no passo 1 (prep-twitter-posts.ts)", () => {
    const block = readTwitterDispatchBlock();
    assert.match(
      block,
      /dueAt/,
      "#4103: o bloco deve referenciar dueAt (calculado por prep-twitter-posts.ts) como o valor passado ao create_post",
    );
  });

  it("menciona o compute-social-schedule.ts compartilhado com os demais canais", () => {
    const block = readTwitterDispatchBlock();
    assert.match(
      block,
      /compute-social-schedule\.ts/,
      "#4103: o dispatch do X deve reusar o MESMO helper de horário que Facebook/LinkedIn/Instagram/Threads, não recalcular à parte",
    );
  });

  it("append-twitter-published.ts é chamado com --scheduled-at (paridade com os demais canais)", () => {
    const block = readTwitterDispatchBlock();
    assert.match(
      block,
      /append-twitter-published\.ts[^\n]*--scheduled-at/,
      "#4103: o registro do resultado deve gravar --scheduled-at, não deixar scheduled_at sempre null",
    );
  });
});
