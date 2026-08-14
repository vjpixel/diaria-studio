#!/usr/bin/env npx tsx
/**
 * scripts/lib/continuo-plan-rotation.ts (#5293 item 5)
 *
 * `/diaria-continuo` reusa o formato de `plan.json` do overnight
 * (`data/{kind}/{AAMMDD}/plan.json`, ver `.claude/skills/diaria-overnight/SKILL.md`
 * Fase 0 passo 7), mas esse formato assume uma rodada que ABRE e FECHA no
 * mesmo dia — o overnight só grava um `{AAMMDD}` por invocação, à noite, e
 * termina (`report.md`) antes do dia seguinte começar. `/diaria-continuo` por
 * desenho **nunca termina** (ver "Loop invariável",
 * `.claude/skills/diaria-continuo/SKILL.md`) — uma sessão viva cruza múltiplos
 * dias, e sem rotação `plan.json` cresceria indefinidamente sob um único
 * `{AAMMDD}` que já não corresponde ao dia corrente.
 *
 * Este módulo implementa a política de rotação decidida na issue de origem:
 * **por dia civil (BRT)**. Toda vez que o coordenador chama
 * `rotateContinuoPlanIfNeeded` (previsto: início de cada re-varredura da fila,
 * passo 2 do loop) e o dia mudou desde o `{AAMMDD}` do diretório ativo mais
 * recente, um novo diretório `data/continuo/{novoAAMMDD}/` é criado com um
 * `plan.json` fresco que carrega `continued_from` apontando pro dia anterior
 * — a cadeia inteira fica reconstruível seguindo esse campo pra trás, sem
 * precisar que nenhum arquivo único guarde o histórico completo.
 *
 * **Nunca é destrutivo**: o `plan.json` do dia anterior fica intocado no
 * próprio diretório (`data/continuo/{diaAnterior}/plan.json`) — a rotação só
 * ADICIONA um diretório novo, nunca edita ou apaga o antigo. Uma linha é
 * também apendada em `data/continuo/history.jsonl` (append-only, 1 linha por
 * rotação) com um resumo mínimo pra permitir auditoria/dashboard sem precisar
 * abrir cada `plan.json` individualmente.
 *
 * **Campos carregados adiante** (não resetados a cada rotação — são
 * configuração da SESSÃO, não do dia): `bugs_only`, `priority_filter` — os
 * mesmos dois filtros que `/diaria-overnight` já grava em `plan.json`
 * (SKILL.md irmão, passo 3) e que persistem por toda a vida da rodada, não
 * por dia.
 *
 * @see .claude/skills/diaria-continuo/SKILL.md ("Loop invariável", item 5 da
 *      seção "Itens 3-6")
 * @see scripts/overnight-watchdog.ts (findActiveRun trata `data/continuo/`
 *      como "ativa" enquanto plan.json existir no dia mais recente — não
 *      depende de rotação ter rodado a tempo, só do scan lexicográfico)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, isMainModule } from "./cli-args.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./next-edition-date.ts";

/** Campos de configuração de SESSÃO (não de dia) — carregados adiante em toda rotação. */
const SESSION_SCOPED_FIELDS = ["bugs_only", "priority_filter"] as const;

export function continuoRoot(rootDir: string): string {
  return join(rootDir, "data", "continuo");
}

export function continuoHistoryPath(rootDir: string): string {
  return join(continuoRoot(rootDir), "history.jsonl");
}

/**
 * Hoje em AAMMDD, fuso BRT (America/Sao_Paulo) — dia CIVIL, não "hoje" em UTC
 * (evita rotacionar cedo/tarde demais perto da meia-noite BRT). Reusa
 * `datePartsInTz`/`toAammdd` de `next-edition-date.ts` (já testados,
 * #2068) — só a intenção difere: lá é D+1 (edição de amanhã), aqui é D+0
 * (dia corrente da sessão contínua).
 */
export function todayAammdd(now: Date = new Date()): string {
  return toAammdd(datePartsInTz(now, BRT_TIMEZONE));
}

/**
 * Pure: decide se é hora de rotacionar. `>` (não `!==`) — um `today` "no
 * passado" relativo ao diretório mais recente (clock skew, ou um dia
 * futuro gravado por engano) NUNCA aciona rotação; só um dia civil
 * genuinamente novo aciona.
 */
export function shouldRotatePlan(currentAammdd: string, todayAammddValue: string): boolean {
  return todayAammddValue > currentAammdd;
}

/**
 * Varre `data/continuo/` e retorna todos os `{AAMMDD}` com `plan.json`,
 * ordenados cronologicamente (lexicográfico = cronológico em YYMMDD).
 * Reusado por `rotateContinuoPlanIfNeeded` (achar o dia mais recente) e por
 * `scripts/continuo-cost-summary.ts` (item 6 — somar tokens por dia).
 */
export function listContinuoDays(rootDir: string): string[] {
  const dir = continuoRoot(rootDir);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{6}$/.test(d.name))
      .map((d) => d.name)
      .filter((aammdd) => existsSync(join(dir, aammdd, "plan.json")))
      .sort();
  } catch {
    return [];
  }
  return entries;
}

/**
 * Pure: monta o `plan.json` inicial do novo dia a partir do plan.json do dia
 * anterior. `previousPlan` pode ser `null` (dia anterior ilegível/corrompido —
 * fail-soft, a rotação segue mesmo assim, só sem os campos de sessão pra
 * carregar adiante).
 */
export function buildRotatedPlanSeed(params: {
  previousAammdd: string;
  previousPlan: Record<string, unknown> | null;
  nowIso: string;
}): Record<string, unknown> {
  const { previousAammdd, previousPlan, nowIso } = params;
  const seed: Record<string, unknown> = {
    started_at: nowIso,
    continued_from: previousAammdd,
    stall_events: [],
    issues: [],
    timeline: [],
    resume_state: null,
  };
  if (previousPlan) {
    for (const field of SESSION_SCOPED_FIELDS) {
      if (field in previousPlan) seed[field] = previousPlan[field];
    }
  }
  return seed;
}

/**
 * Pure: linha de `history.jsonl` que resume o dia que está sendo fechado
 * pela rotação — não é o `report.md` do overnight (não há relatório
 * narrativo aqui, isso é responsabilidade do coordenador/LLM, não desta
 * lib), só um rastro mecânico o bastante pra reconstruir a linha do tempo
 * sem abrir cada `plan.json` individualmente.
 */
export function buildHistoryLine(params: {
  fromAammdd: string;
  toAammdd: string;
  rotatedAt: string;
}): string {
  return JSON.stringify({
    aammdd: params.fromAammdd,
    continued_to: params.toAammdd,
    rotated_at: params.rotatedAt,
  });
}

export interface RotationResult {
  rotated: boolean;
  fromAammdd: string | null;
  toAammdd: string;
}

/**
 * Ponto de entrada de I/O — chamar no início de cada re-varredura do loop
 * (`.claude/skills/diaria-continuo/SKILL.md`, passo 2). Idempotente: se o
 * dia mais recente em `data/continuo/` já é hoje, no-op (`rotated: false`).
 * Se `data/continuo/` está vazio (sessão nunca rodou nesta máquina/checkout),
 * cria o primeiro diretório do dia sem `continued_from` (não é uma rotação,
 * é o bootstrap — `fromAammdd: null` sinaliza isso).
 */
export function rotateContinuoPlanIfNeeded(rootDir: string, now: Date = new Date()): RotationResult {
  const today = todayAammdd(now);
  const days = listContinuoDays(rootDir);
  const latest = days.length > 0 ? days[days.length - 1] : null;

  if (latest === null) {
    // Bootstrap: nenhum dia ainda — cria o diretório de hoje com plan.json
    // seed vazio (sem continued_from, não há "dia anterior").
    const dir = join(continuoRoot(rootDir), today);
    mkdirSync(dir, { recursive: true });
    const planPath = join(dir, "plan.json");
    if (!existsSync(planPath)) {
      writeFileAtomic(
        planPath,
        JSON.stringify(
          { started_at: now.toISOString(), continued_from: null, stall_events: [], issues: [], timeline: [], resume_state: null },
          null,
          2,
        ) + "\n",
      );
    }
    return { rotated: false, fromAammdd: null, toAammdd: today };
  }

  if (!shouldRotatePlan(latest, today)) {
    return { rotated: false, fromAammdd: latest, toAammdd: latest };
  }

  // Rotação de verdade: dia mudou.
  let previousPlan: Record<string, unknown> | null = null;
  try {
    previousPlan = JSON.parse(readFileSync(join(continuoRoot(rootDir), latest, "plan.json"), "utf8"));
  } catch {
    previousPlan = null; // fail-soft — ver docstring de buildRotatedPlanSeed
  }

  const nowIso = now.toISOString();
  const newDir = join(continuoRoot(rootDir), today);
  mkdirSync(newDir, { recursive: true });
  const seed = buildRotatedPlanSeed({ previousAammdd: latest, previousPlan, nowIso });
  writeFileAtomic(join(newDir, "plan.json"), JSON.stringify(seed, null, 2) + "\n");

  try {
    mkdirSync(continuoRoot(rootDir), { recursive: true });
    appendFileSync(
      continuoHistoryPath(rootDir),
      buildHistoryLine({ fromAammdd: latest, toAammdd: today, rotatedAt: nowIso }) + "\n",
    );
  } catch {
    // history.jsonl é só auditoria auxiliar — falha de escrita aqui nunca
    // deve impedir a rotação em si (já persistida acima) de ser reportada
    // como bem-sucedida.
  }

  return { rotated: true, fromAammdd: latest, toAammdd: today };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const { positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "check";
  if (command !== "check") {
    process.stderr.write("uso: npx tsx scripts/lib/continuo-plan-rotation.ts [check]\n");
    process.exit(1);
  }
  const result = rotateContinuoPlanIfNeeded(process.cwd());
  if (result.rotated) {
    process.stdout.write(
      `continuo-plan-rotation: rotacionado ${result.fromAammdd} → ${result.toAammdd}\n`,
    );
  } else if (result.fromAammdd === null) {
    process.stdout.write(`continuo-plan-rotation: bootstrap — data/continuo/${result.toAammdd}/plan.json criado\n`);
  } else {
    process.stdout.write(`continuo-plan-rotation: sem rotação necessária (dia corrente: ${result.toAammdd})\n`);
  }
}
