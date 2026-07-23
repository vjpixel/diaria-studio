/**
 * test/orchestrator-stage5-instagram-schedule.test.ts (#3944 Parte A)
 *
 * Regression guard: incidente 260723 — o Stage 5 disparava
 * `publish-instagram.ts` SEM `--schedule`, publicando os 3 posts do
 * Instagram imediatamente (todos na mesma hora do dispatch) em vez de
 * escalonados nos horários editoriais (d1 10:00/d2 12:30/d3 17:30 BRT),
 * como já acontecia com Facebook e LinkedIn.
 *
 * O mecanismo de agendamento do Instagram já existia (#3817/#3818,
 * enfileira no Worker `diaria-linkedin-cron` com `channel: "instagram"`;
 * coberto exaustivamente em test/publish-instagram.test.ts) — o gap era
 * puramente de wiring: o orchestrator nunca passava a flag.
 *
 * Como orchestrator-stage-5.md é um prompt consumido por um agente LLM (não
 * código executado diretamente), o teste de regressão possível aqui é
 * estrutural: garantir que o texto do prompt instrui `--schedule` no dispatch
 * do Instagram, espelhando o padrão já usado para Facebook/LinkedIn — mesmo
 * padrão de teste doc↔código usado em test/beehiiv-playbook-exit-codes.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE5_PATH = resolve(ROOT, ".claude/agents/orchestrator-stage-5.md");

function readStage5DispatchBlock(): string {
  const src = readFileSync(STAGE5_PATH, "utf8");
  const blockStart = src.indexOf("**Em uma unica mensagem, disparar simultaneamente**");
  assert.ok(blockStart >= 0, "bloco de dispatch paralelo (§5c-3) não encontrado em orchestrator-stage-5.md");
  // Bloco cobre os 4 itens numerados (facebook/linkedin/instagram/threads) + notas — 2000 chars é folga suficiente.
  return src.slice(blockStart, blockStart + 2000);
}

describe("#3944 Parte A: dispatch do Instagram no Stage 5 usa --schedule (não imediato)", () => {
  it("publish-instagram.ts é invocado com --schedule no bloco de dispatch paralelo", () => {
    const block = readStage5DispatchBlock();
    assert.match(
      block,
      /npx tsx scripts\/publish-instagram\.ts --edition-dir \{EDITION_DIR\}\/ --schedule/,
      "#3944: publish-instagram.ts deve ser chamado com --schedule (enfileira no Worker) — sem isso, IG publica imediato (incidente 260723)",
    );
  });

  it("não regride para a invocação antiga sem --schedule (publicação imediata)", () => {
    const block = readStage5DispatchBlock();
    // A forma antiga (bug) era exatamente esta invocação sem --schedule.
    // Usamos negative lookahead pra garantir que NENHUMA ocorrência de
    // "publish-instagram.ts --edition-dir {EDITION_DIR}/" seja seguida
    // imediatamente pelo fechamento de aspas/parênteses sem --schedule antes.
    assert.doesNotMatch(
      block,
      /npx tsx scripts\/publish-instagram\.ts --edition-dir \{EDITION_DIR\}\/"\)/,
      "#3944: não deve haver invocação de publish-instagram.ts sem --schedule (regressão do incidente 260723)",
    );
  });

  it("dispatch do Instagram menciona o mesmo Worker/canal usado pelo LinkedIn (#3817/#3818)", () => {
    const block = readStage5DispatchBlock();
    assert.match(
      block,
      /diaria-linkedin-cron/,
      "#3944: nota do Instagram deve referenciar o Worker diaria-linkedin-cron (mesma infra do LinkedIn)",
    );
    assert.match(
      block,
      /channel:\s*"instagram"/,
      "#3944: nota do Instagram deve mencionar channel:\"instagram\" (#3817)",
    );
  });

  it("resumo pós-Stage-5 reflete 'agendado', não 'publicado', para Instagram", () => {
    const src = readFileSync(STAGE5_PATH, "utf8");
    assert.match(
      src,
      /Instagram: agendado x 3/,
      "#3944: resumo apresentado ao editor deve dizer 'agendado', não 'publicado', para Instagram",
    );
    assert.doesNotMatch(
      src,
      /Instagram: publicado x 3/,
      "#3944: resumo não deve mais afirmar publicação imediata do Instagram",
    );
  });
});
