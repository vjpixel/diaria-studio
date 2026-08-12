#!/usr/bin/env npx tsx
/**
 * overnight-session-marker.ts (#3322, campo `phase` adicionado em #4450)
 *
 * Escreve/remove o marker determinístico que `.claude/hooks/pr-create-review.mjs`
 * (`isOvernightRoundActive`) usa pra detectar uma rodada `/diaria-overnight`
 * genuinamente em progresso NESTA máquina, independente de como PRs da rodada
 * nomeiam suas branches (#3321: convenção de naming `overnight/*` documentada em
 * SKILL.md mas nunca de fato instruída ao dispatch — o gating por branch nunca
 * disparou `low` numa rodada inteira). Path: `data/overnight/.active-session-{tag}.json`,
 * onde `{tag}` é o hostname sanitizado — cada máquina escreve/lê SÓ o próprio
 * arquivo, sem risco de colisão de escrita entre máquinas sincronizadas pelo
 * mesmo junction OneDrive `data/`.
 *
 * **Campo `phase` (#4450):** guard MECÂNICO contra o incidente da rodada
 * 260801/02 — o coordenador disparou um `AskUserQuestion` malformado/placeholder
 * no meio da Fase 1 (autônoma), violando a Regra 1 (HARD RULE, "zero perguntas
 * pós-briefing") de `.claude/skills/diaria-overnight/SKILL.md`. Diferente do
 * #3038 (decisão de raciocínio ruim, corrigida com reforço de prompt), aqui a
 * chamada em si foi anômala — reforçar o texto da regra não teria evitado uma
 * tool call que não seguiu nenhum raciocínio identificável. `phase` grava em
 * qual momento da rodada o coordenador está: `"briefing"` (Fase 0 — perguntar é
 * permitido e esperado) ou `"autonomous"` (Fase 1 em diante — perguntar é
 * proibido). `--start` sempre grava `phase: "briefing"` (toda rodada nova
 * começa no briefing); a skill chama `--phase autonomous` ao concluir a Fase 0
 * (passo 8, ao entrar na Fase 1) — esse é o gatilho que arma o hook
 * `.claude/hooks/block-askuserquestion-overnight-autonomous.mjs`, que nega
 * qualquer `AskUserQuestion` enquanto `phase` for `"autonomous"` neste marker.
 * O hook duplica a lógica de path (mesmo padrão de `pr-create-review.mjs`) e
 * consome só leitura — nunca escreve o marker. **Resume (passo 0):** quando
 * `plan.json` já existe, a skill pula direto pra Fase 1/1.5/2 sem passar pelo
 * passo 8 — mas o passo 1 (`--start`) ainda roda nesse caminho e reseta
 * `phase` pra `"briefing"`. O passo 0 re-arma `--phase autonomous`
 * explicitamente logo depois, então uma rodada retomada nunca fica sem o
 * guard armado.
 *
 * Deliberadamente NÃO é `data/overnight/{AAMMDD}/plan.json` (documento de progresso
 * do coordenador, schema evoluindo, dono de uma feature não-relacionada — a
 * statusLine). Uma revisão anterior desta correção reusava `plan.json` e o
 * code-review consolidado do PR encontrou 3 gaps reais nessa abordagem: (1)
 * sem staleness — uma rodada travada/crashada ficava "ativa" pra sempre; (2)
 * `readTodayPlan` só olha o diretório MAIS RECENTE — se esse for de outra
 * máquina, a rodada ativa desta máquina nunca era vista; (3) direção de
 * fail-safe invertida herdada de `isTerminalForBar` (status desconhecido/ausente
 * = "ainda rodando", certo pra uma barra de progresso, errado pra um gate de
 * custo). Um marker dedicado, por máquina, com timestamp próprio, evita as 3
 * classes por construção — contrato inteiro é "existe + é recente + é meu".
 *
 * A lógica de path (`activeSessionPath`/`machineTag`) é DUPLICADA — não
 * importada — em `.claude/hooks/pr-create-review.mjs`: aquele hook roda num
 * caminho que nunca pode lançar (`gh pr create` não pode ser bloqueado por um
 * hook quebrado) e evita depender de qualquer `scripts/*.ts` pra isso (imports
 * estáticos de `.ts` num hook `.mjs` são um ponto de falha sensível a versão
 * de Node — ver comentário no topo do hook). Se o esquema de path mudar aqui,
 * mudar lá também — `test/pr-create-review-hook.test.ts` e
 * `test/overnight-session-marker.test.ts` cobrem os dois lados
 * independentemente, então uma divergência acidental quebra pelo menos um dos
 * dois test files.
 *
 * **Campo `session_id` (#5156, retrocompat obrigatória).** Marker novo pode
 * carregar `session_id` — o `session_id` do payload do hook, injetado
 * automaticamente por `.claude/hooks/inject-session-id.mjs` (a skill nunca
 * passa `--session-id` manualmente: ela não tem como saber o próprio
 * `session_id`, ver docblock desse hook). Com `session_id` gravado,
 * `.claude/hooks/block-askuserquestion-overnight-autonomous.mjs` e
 * `.claude/hooks/pr-create-review.mjs` (`isOvernightRoundActive`) passam a
 * comparar o `session_id` da chamada ATUAL contra o do marker — só tratam
 * como "é esta rodada overnight" quando os dois batem, permitindo que uma
 * sessão `/diaria-develop` rodando em paralelo na MESMA máquina não seja
 * afetada pelo guard/desconto de effort do overnight (#5156 itens 1/2).
 * **Marker SEM `session_id` (formato antigo — inclusive o de qualquer rodada
 * overnight já em progresso no momento deste PR) preserva o comportamento
 * PRÉ-#5156 nos dois hooks: "ativo nesta máquina" já basta, independente de
 * quem chama** — nunca um requisito novo que quebraria uma rodada em voo.
 *
 * Uso (chamado pela skill `/diaria-overnight` — Fase 0 passo 1, Fase 0 passo 8
 * e Fase 2 passo 0):
 *   npx tsx scripts/overnight-session-marker.ts --start
 *   npx tsx scripts/overnight-session-marker.ts --phase autonomous
 *   npx tsx scripts/overnight-session-marker.ts --end
 * (`--session-id X` é sempre injetado automaticamente pelo hook acima — nunca
 * precisa ser passado manualmente pela skill.)
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

/** Fases da rodada (#4450) — ver docblock do topo do arquivo. */
export type OvernightPhase = "briefing" | "autonomous";

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — string vazia em falha. */
export function machineTag(): string {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

export function activeSessionPath(repoRoot: string, tag: string = machineTag()): string {
  return join(repoRoot, "data", "overnight", `.active-session-${tag}.json`);
}

/**
 * Grava o marker de sessão ativa. Idempotente — sobrescreve `started_at` se já
 * existir. **Sempre grava `phase: "briefing"` (#4450)** — `--start` roda tanto
 * numa rodada genuinamente nova (segue pro briefing normal, arma
 * `--phase autonomous` no passo 8) quanto no Resume de uma rodada existente
 * (passo 1, sempre executado de novo mesmo quando o passo 0 pula direto pra
 * Fase 1/1.5/2) — e nos dois casos o valor logo após `--start` É "briefing"
 * até o passo seguinte decidir o contrário. **Isto NÃO significa que uma
 * rodada retomada fica desprotegida**: o passo 0 (Resume) re-arma
 * `--phase autonomous` explicitamente, imediatamente após este `--start`,
 * exatamente porque `--start` sempre reseta pra "briefing" — os dois passos
 * são um par deliberado, não uma coincidência de ordem.
 *
 * `sessionId` (#5156, opcional) grava o campo `session_id` no marker quando
 * fornecido — omitido, o marker sai no formato antigo (sem o campo), que os
 * dois hooks consumidores tratam como "comportamento pré-#5156" (ver docblock
 * do topo do arquivo).
 */
export function startSession(repoRoot: string, startedAtIso: string, sessionId?: string): void {
  const path = activeSessionPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const marker: Record<string, unknown> = { started_at: startedAtIso, phase: "briefing" };
  if (sessionId) marker.session_id = sessionId;
  writeFileSync(path, JSON.stringify(marker), "utf8");
}

/** Remove o marker de sessão ativa. Idempotente — no-op se já ausente. */
export function endSession(repoRoot: string): void {
  const path = activeSessionPath(repoRoot);
  if (existsSync(path)) rmSync(path);
}

/**
 * Atualiza SÓ o campo `phase` do marker já existente — preserva `started_at`
 * (e qualquer outro campo futuro) intacto (#4450). Retorna `false`, sem
 * lançar, quando não há marker pra atualizar: `--start` nunca rodou nesta
 * rodada, o marker já foi removido por `--end`, ou o JSON está corrompido no
 * disco — falha graciosa, o caller (CLI abaixo) decide como reportar (aviso +
 * exit code, nunca stack trace). Retorna `true` em sucesso.
 *
 * `sessionId` (#5156, opcional) grava/atualiza `session_id` no marker junto
 * da mudança de fase — útil quando `--start` rodou sem a flag (ex: resume de
 * uma rodada iniciada antes do #5156) mas o `session_id` já está disponível
 * agora. Omitido, preserva o `session_id` já presente (se houver) intocado —
 * mesmo espírito de "preserva campos que não conhece".
 */
export function setPhase(repoRoot: string, phase: OvernightPhase, sessionId?: string): boolean {
  const path = activeSessionPath(repoRoot);
  if (!existsSync(path)) return false;
  try {
    const current = JSON.parse(readFileSync(path, "utf8"));
    const updated = { ...current, phase };
    if (sessionId) updated.session_id = sessionId;
    writeFileSync(path, JSON.stringify(updated), "utf8");
    return true;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  const arg = argv[0];
  // #5156: --session-id normalmente chega injetado por .claude/hooks/inject-session-id.mjs
  // (a skill nunca sabe o próprio session_id pra passar manualmente) — parseado via
  // parseArgs pra não depender de posição fixa relativa a --phase <valor>.
  const sessionId = parseArgs(argv).values["session-id"];
  if (arg === "--start") {
    startSession(repoRoot, new Date().toISOString(), sessionId);
    process.stdout.write(
      `overnight session marker: started, phase=briefing${sessionId ? `, session_id=${sessionId}` : ""} (${activeSessionPath(repoRoot)})\n`,
    );
  } else if (arg === "--end") {
    endSession(repoRoot);
    process.stdout.write(`overnight session marker: ended (${activeSessionPath(repoRoot)})\n`);
  } else if (arg === "--phase") {
    const phase = argv[1];
    if (phase !== "briefing" && phase !== "autonomous") {
      process.stderr.write("uso: npx tsx scripts/overnight-session-marker.ts --phase <briefing|autonomous>\n");
      process.exitCode = 1;
    } else if (setPhase(repoRoot, phase, sessionId)) {
      process.stdout.write(`overnight session marker: phase=${phase} (${activeSessionPath(repoRoot)})\n`);
    } else {
      process.stderr.write(
        `overnight session marker: nenhum marker ativo em ${activeSessionPath(repoRoot)} — rode --start antes de --phase\n`,
      );
      process.exitCode = 1;
    }
  } else {
    process.stderr.write("uso: npx tsx scripts/overnight-session-marker.ts --start | --end | --phase <briefing|autonomous>\n");
    process.exitCode = 1;
  }
}
