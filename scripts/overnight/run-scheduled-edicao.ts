#!/usr/bin/env node
/**
 * scripts/overnight/run-scheduled-edicao.ts (#4998, reativação do #2068/#3259)
 *
 * Runner Linux/systemd da edição diária agendada — sucessor do antigo
 * `scripts/overnight/run-scheduled-edicao.ps1` (Windows Task Scheduler,
 * removido no #5115). Invocado pelo timer `diaria-edicao-diaria.timer` (dom-qui 16:00 BRT, ver
 * `scripts/lib/edicao-systemd-units.ts`).
 *
 * Fluxo:
 *   1. Calcula AAMMDD = amanhã em America/Sao_Paulo (`nextEditionDate`).
 *   2. GUARD DE IDEMPOTÊNCIA (novo na reativação 260811, pedido do editor):
 *      se `data/editions/{AAMMDD}/` já existe — a edição já foi iniciada,
 *      manualmente pelo editor ou por uma run anterior desta mesma task —
 *      loga SKIP e sai sem invocar `claude`. Nunca reprocessa/duplica
 *      trabalho; a resumabilidade normal de `/diaria-edicao` (CLAUDE.md,
 *      "Retomar edição interrompida") já cobre o caso de retomar uma run
 *      que ficou pela metade — esse guard é sobre não DISPARAR de novo
 *      quando não há motivo.
 *   3. Senão, invoca `claude --print /diaria-edicao {AAMMDD} --skip
 *      newsletter,linkedin,facebook` — Stages 0-3 + pré-render do Stage 4,
 *      sem publicar nada (mesmo contrato do runner Windows, ver
 *      docs/scheduled-edicao-setup.md).
 *   4. Loga resultado em data/overnight-schedule.log (linha simples,
 *      compartilhado com o runner Windows) e data/run-log.jsonl (via
 *      scripts/log-event.ts, agent="scheduled-edicao").
 *
 * GUARD DE PUBLICAÇÃO: este script prepara conteúdo (Stages 0-3) e
 * pré-renderiza o Stage 4, mas NÃO dispatcha nenhum canal — publicação
 * requer ação explícita do editor (/diaria-5-publicacao).
 *
 * @see scripts/overnight/setup-edicao-schedule-systemd.ts (gera os units que invocam este script)
 * @see docs/scheduled-edicao-setup.md
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/cli-args.ts";
import { nextEditionDate } from "../lib/next-edition-date.ts";
import { resolveClaudeBin } from "../lib/resolve-claude-bin.ts";
import { runTsx } from "../lib/run-tsx.ts";

const SKIP_FLAGS = "--skip newsletter,linkedin,facebook";
const MAX_TURNS = "120";

function nowIso(): string {
  return new Date().toISOString();
}

function writeScheduleLog(dataDir: string, message: string): void {
  const logFile = join(dataDir, "overnight-schedule.log");
  if (!existsSync(dataDir)) {
    console.warn(`data/ não encontrado. Log de schedule não gravado. Mensagem: ${message}`);
    return;
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(logFile, `${nowIso()} | ${message}\n`, "utf8");
  } catch (e) {
    console.warn(`writeScheduleLog: falha ao gravar em ${logFile} — ${(e as Error).message}`);
  }
}

function writeRunLog(
  repoRootAbs: string,
  dataDir: string,
  aammdd: string,
  level: "info" | "warn" | "error",
  message: string,
  details: string = "{}",
): void {
  if (!existsSync(dataDir)) return;
  const scriptPath = resolve(repoRootAbs, "scripts/log-event.ts");
  // Guard existsSync antes do spawn (não só try/catch em volta): sem isso,
  // um repoRootAbs sem scripts/log-event.ts (repo incompleto/de teste)
  // ainda tenta spawnar `node --import tsx <path-inexistente>`, que imprime
  // um stack trace feio no stderr HERDADO (runTsx stdout:"ignore" só
  // silencia stdout) antes de lançar — engolido do mesmo jeito, mas com
  // ruído evitável.
  if (!existsSync(scriptPath)) return;
  try {
    runTsx(
      scriptPath,
      ["--edition", aammdd, "--agent", "scheduled-edicao", "--level", level, "--message", message, "--details", details],
      { cwd: repoRootAbs, stdout: "ignore" },
    );
  } catch {
    // Log de run-log falhou — não propagar; já temos o schedule log.
  }
}

function log(
  repoRootAbs: string,
  dataDir: string,
  aammdd: string,
  scheduleMsg: string,
  level: "info" | "warn" | "error",
  runMsg: string,
  details: string = "{}",
): void {
  writeScheduleLog(dataDir, scheduleMsg);
  writeRunLog(repoRootAbs, dataDir, aammdd, level, runMsg, details);
}

/**
 * `aammddOverride` é injetável (default = `nextEditionDate()` real) — mesmo
 * padrão de `exec`/`execFn` injetável usado no resto do repo — para permitir
 * testar o guard de idempotência sem depender da data real do sistema.
 */
export function main(
  repoRootAbs: string,
  execFn: typeof execFileSync = execFileSync,
  aammddOverride?: string,
): number {
  const dataDir = join(repoRootAbs, "data");
  const aammdd = aammddOverride ?? nextEditionDate();
  const pid = process.pid;

  log(
    repoRootAbs,
    dataDir,
    aammdd,
    `START edition=${aammdd} pid=${pid}`,
    "info",
    "scheduled-edicao: início",
    `{"edition":"${aammdd}","trigger":"systemd-timer"}`,
  );

  // -------------------------------------------------------------------
  // Guard de idempotência (#4998): não disparar se a edição já existe.
  // -------------------------------------------------------------------
  const editionDir = join(dataDir, "editions", aammdd);
  if (existsSync(editionDir)) {
    log(
      repoRootAbs,
      dataDir,
      aammdd,
      `SKIP  edition=${aammdd} reason=already-started end=${nowIso()}`,
      "info",
      "scheduled-edicao: pulado (edição já iniciada)",
      `{"edition":"${aammdd}","reason":"already-started"}`,
    );
    console.log(`[${nowIso()}] SKIP — data/editions/${aammdd}/ já existe, edição já foi iniciada. Nada a fazer.`);
    return 0;
  }

  const prompt = `/diaria-edicao ${aammdd} ${SKIP_FLAGS}`;
  console.log(`[${nowIso()}] Iniciando: claude -p '${prompt}'`);

  let exitCode = 0;
  let output = "";
  try {
    // Caminho ABSOLUTO, nunca o literal "claude" (#5549): sob systemd o PATH
    // é o mínimo do sistema e não inclui ~/.npm-global/bin, então o nome cru
    // dava `spawnSync claude ENOENT`. Resolver DENTRO do try faz a falha de
    // resolução cair no mesmo caminho de log FAIL do resto — com mensagem
    // acionável em vez do ENOENT opaco.
    output = execFn(
      resolveClaudeBin(),
      [
        "--print",
        "--permission-mode",
        "acceptEdits",
        "--max-turns",
        MAX_TURNS,
        "--output-format",
        "text",
        "--no-session-persistence",
        prompt,
      ],
      { cwd: repoRootAbs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ) as unknown as string;
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    exitCode = err.status ?? 1;
    output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
  }

  const runEnd = nowIso();
  if (exitCode === 0) {
    log(
      repoRootAbs,
      dataDir,
      aammdd,
      `OK    edition=${aammdd} exit=0 end=${runEnd}`,
      "info",
      "scheduled-edicao: concluído",
      `{"edition":"${aammdd}","exit_code":0}`,
    );
  } else {
    const tail = output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .slice(-20)
      .join(" | ");
    log(
      repoRootAbs,
      dataDir,
      aammdd,
      `FAIL  edition=${aammdd} exit=${exitCode} end=${runEnd} tail=${tail}`,
      "error",
      `scheduled-edicao: falha (exit ${exitCode})`,
      `{"edition":"${aammdd}","exit_code":${exitCode}}`,
    );
  }

  return exitCode;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(main(repoRootAbs));
}
