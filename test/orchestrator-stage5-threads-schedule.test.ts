/**
 * test/orchestrator-stage5-threads-schedule.test.ts (#3944 Parte B)
 *
 * Mesmo padrão de test/orchestrator-stage5-instagram-schedule.test.ts
 * (#3944 Parte A): garante que o Stage 5 dispara `publish-threads.ts` COM
 * `--schedule` (agendado, não imediato) — mesma classe de bug que afetou o
 * Instagram no incidente 260723 (posts saindo todos juntos no instante do
 * dispatch, em vez de escalonados nos horários editoriais).
 *
 * O mecanismo de agendamento do Threads foi construído nesta mesma leva
 * (#3944 Parte B, enfileira no Worker `diaria-linkedin-cron` com
 * `channel: "threads"`; coberto exaustivamente em test/publish-threads.test.ts
 * e workers/linkedin-cron/test/threads-channel.test.ts) — este teste cobre
 * só o WIRING do orchestrator: garantir que o texto do prompt instrui
 * `--schedule`, espelhando o padrão já usado para Facebook/LinkedIn/Instagram.
 *
 * Como orchestrator-stage-5.md é um prompt consumido por um agente LLM (não
 * código executado diretamente), o teste de regressão possível aqui é
 * estrutural (doc↔código), mesmo padrão de
 * test/orchestrator-stage5-instagram-schedule.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE5_PATH = resolve(ROOT, ".claude/agents/orchestrator-stage-5.md");

/** Bloco completo do dispatch paralelo (§5c-3) — do início da instrução até
 * "Aguardar todos retornarem", sem tamanho fixo (cresce com o texto real). */
function readStage5DispatchBlock(): string {
  const src = readFileSync(STAGE5_PATH, "utf8");
  const blockStart = src.indexOf("**Em uma unica mensagem, disparar simultaneamente**");
  assert.ok(blockStart >= 0, "bloco de dispatch paralelo (§5c-3) não encontrado em orchestrator-stage-5.md");
  const blockEnd = src.indexOf("Aguardar todos retornarem", blockStart);
  assert.ok(blockEnd > blockStart, "fim do bloco de dispatch (marcador 'Aguardar todos retornarem') não encontrado");
  return src.slice(blockStart, blockEnd);
}

describe("#3944 Parte B: dispatch do Threads no Stage 5 usa --schedule (não imediato)", () => {
  it("publish-threads.ts é invocado com --schedule no bloco de dispatch paralelo", () => {
    const block = readStage5DispatchBlock();
    assert.match(
      block,
      /npx tsx scripts\/publish-threads\.ts --edition-dir \{EDITION_DIR\}\/ --schedule/,
      "#3944 Parte B: publish-threads.ts deve ser chamado com --schedule (enfileira no Worker) — sem isso, Threads publica imediato",
    );
  });

  it("não regride para a invocação antiga sem --schedule (publicação imediata)", () => {
    const block = readStage5DispatchBlock();
    // A forma antiga (pré-Parte B) era exatamente esta invocação sem --schedule.
    assert.doesNotMatch(
      block,
      /npx tsx scripts\/publish-threads\.ts --edition-dir \{EDITION_DIR\}\/"\)/,
      "#3944 Parte B: não deve haver invocação de publish-threads.ts sem --schedule",
    );
  });

  it("dispatch do Threads menciona o mesmo Worker/canal usado pelo LinkedIn/Instagram (#3944 Parte B)", () => {
    const block = readStage5DispatchBlock();
    assert.match(
      block,
      /diaria-linkedin-cron/,
      "#3944 Parte B: nota do Threads deve referenciar o Worker diaria-linkedin-cron (mesma infra do LinkedIn/Instagram)",
    );
    assert.match(
      block,
      /channel:\s*"threads"/,
      '#3944 Parte B: nota do Threads deve mencionar channel:"threads"',
    );
  });

  it("dispatch do Threads documenta o limite de 1 chunk (≤500 chars) suportado por --schedule", () => {
    const block = readStage5DispatchBlock();
    assert.match(
      block,
      /1 chunk/,
      "#3944 Parte B: nota do Threads deve avisar que --schedule só suporta posts de 1 chunk",
    );
  });

  it("resumo pós-Stage-5 reflete 'agendado' para Threads", () => {
    const src = readFileSync(STAGE5_PATH, "utf8");
    assert.match(
      src,
      /Threads: agendado/,
      "#3944 Parte B: resumo apresentado ao editor deve dizer 'agendado' para Threads",
    );
  });
});
