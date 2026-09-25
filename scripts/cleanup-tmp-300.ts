#!/usr/bin/env node
/**
 * scripts/cleanup-tmp-300.ts (#8828)
 *
 * ─── Contexto ────────────────────────────────────────────────────────────
 *
 * Em 25/09/2026 o `/tmp` do servidor `300` (tmpfs de 15 GB) estourou a
 * cota (EDQUOT), derrubando TODO comando Bash de TODA sessão de Claude Code
 * ativa na máquina — o harness grava saída de shell em
 * `/tmp/claude-{uid}/<projeto>/<sessionId>/...`. Depois da limpeza manual,
 * uso ficou em 9,8 GB de 15 GB (65%), dos quais só ~24 MB em
 * `/tmp/claude-1000` — o `/tmp/claude-1000` deste projeto NUNCA foi o
 * gargalo real.
 *
 * ─── Diagnóstico (rodado ao vivo nesta unidade, `du` real na máquina `300`) ─
 *
 * Os maiores consumidores de `/tmp` (`du -sh` por entrada de topo,
 * 25/09/2026, ~9,8 GB total) são, em ordem:
 *
 *   1. `tsx-1000/` (2,1 GB) — cache de compilação do `tsx`, cresce com
 *      cada versão/hash de módulo já rodado na máquina. Sistema (cache do
 *      `tsx` propriamente dito, não deste repo).
 *   2-N. Dezenas de diretórios com nome aleatório de 21-24 caracteres
 *      (ex: `wFRjPRlkD4Ls9HDNCZfKL/`, 929 MB; `aHMldX7iJrSS5OG3ur_8P/`,
 *      573 MB; `x4hPK5Rk7PL73tFZtI9KA/`, 316 MB — dezenas de MB a quase 1 GB
 *      cada), todos contendo só um subdiretório `ssr/<hash>` — padrão de
 *      cache SSR do `wrangler`/`esbuild` (este projeto publica Workers
 *      Cloudflare via `wrangler`). Ferramenta de terceiro, não código
 *      deste repo — `wrangler` não limpa esses diretórios sozinho.
 *   - `hermes-wt/` (850 MB), `wt-hermes-*` — worktrees do Hermes (cron
 *      externo a este repo, ver `CLAUDE.md` §"infra do kind `continuo`").
 *   - `gh-cli-cache/` (352 MB), `node-compile-cache/` (319 MB) — caches de
 *      sistema/ferramenta (gh CLI, V8 compile cache), não deste repo.
 *   - `wt-fix-*`, `wt-*`, `diaria-*-worktree`, `work-isolated-*`,
 *      `continuo-*-impl` (dezenas de MB a ~85 MB cada) — clones de
 *      isolamento de worktree criados pelo PRÓPRIO HARNESS do Claude Code
 *      quando `isolation: "worktree"` cai no fallback fora do checkout
 *      (ver item 22 de `context/overnight-dispatch-rules.md` — "Refusing
 *      to use ... as an isolation worktree" — e a memória
 *      `worktree-sandbox-isolated-clone-fallback.md`). Comportamento do
 *      harness, fora do alcance de um fix de código deste repo.
 *   - `/tmp/claude-1000/` (24 MB) — o que ESTE script cobre.
 *
 * **Nenhum vazamento de script/teste DESTE repo foi identificado na
 * varredura** (`grep -rl mkdtempSync scripts/ test/` aponta só usos em
 * `test/*.ts`, que rodam sob o runner de teste e são de vida curta — sem
 * padrão de `mkdtempSync` sem `rmSync` correspondente em `finally` visível
 * nos scripts de produção grepados). O item 2 da issue #8828 ("corrigir
 * quem vaza") portanto não se aplica além do diagnóstico acima — os
 * consumidores reais são todos EXTERNOS ao código deste repo (ferramenta
 * de terceiro ou comportamento do harness), o que está fora do escopo de
 * "vazamento de script deste repo" que a issue pede pra corrigir.
 *
 * ─── O que este script FAZ ──────────────────────────────────────────────────
 *
 * Cobre só o que É deste projeto dentro de `/tmp`: os diretórios de sessão
 * do Claude Code em `/tmp/claude-{uid}/<projeto>/<sessionId>/` e os
 * arquivos `.output` de tarefas em background dentro deles
 * (`<sessionId>/tasks/*.output`). Lógica de decisão pura em
 * `scripts/lib/tmp-cleanup.ts` (`planTmpCleanup`) — este arquivo só faz
 * I/O: varre o disco, consulta `listActiveSessions()`
 * (`scripts/lib/session-registry.ts`) pra nunca apagar sessão ativa, e
 * aplica o plano.
 *
 * **Guard de idade OBRIGATÓRIO**: diretório de sessão só é candidato com
 * mais de `SESSION_DIR_MIN_AGE_MS` (2 dias) desde a última modificação
 * DENTRO dele (mtime recursivo, não só do diretório em si — o diretório-pai
 * não muda de mtime quando um arquivo dentro dele é tocado). `.output`
 * files só com mais de `OUTPUT_FILE_MIN_AGE_MS` (1 dia) E
 * `OUTPUT_FILE_MIN_SIZE_BYTES` (~50 MB).
 *
 * ## Uso
 *
 *   npx tsx scripts/cleanup-tmp-300.ts               # aplica de verdade
 *   npx tsx scripts/cleanup-tmp-300.ts --dry-run      # só imprime o plano
 *   npx tsx scripts/cleanup-tmp-300.ts --claude-dir /tmp/claude-1000  # override (testes/outra máquina)
 *
 * ## Registro na task agendada
 *
 * `scripts/lib/scheduled-tasks.ts` → `Diaria-Tmp-Cleanup` (daily). Como os
 * demais scripts deste registro, a task nasce DECLARADA — armar o timer
 * systemd de verdade na máquina `300` (`scripts/setup-systemd-timers.ts`)
 * é ação POSTERIOR do editor, fora do escopo deste PR (a issue #8828 pede
 * só o REGISTRO, não `systemctl enable` ao vivo).
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { resolveRepoRoot, listActiveSessions } from "./lib/session-registry.ts";
import {
  planTmpCleanup,
  planFreedOutputBytes,
  type SessionDirCandidate,
  type OutputFileCandidate,
} from "./lib/tmp-cleanup.ts";

const LOG_PREFIX = "[cleanup-tmp-300]";

/** Default: `/tmp/claude-{uid}` — mesmo esquema que o harness usa pra
 *  nomear o diretório-base de sessão (visto ao vivo na máquina `300`:
 *  `/tmp/claude-1000`, uid 1000). `process.getuid` não existe no Windows —
 *  cai pro literal `/tmp/claude-1000` só como fallback de tipo (este script
 *  só roda em Linux/servidor, nunca na máquina Windows do editor). */
function defaultClaudeDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return `/tmp/claude-${uid}`;
}

/** `mtimeMs` mais recente entre o próprio caminho e todo conteúdo dentro
 *  dele (recursivo) — um diretório de sessão cujo `.output` foi escrito
 *  ontem não deve parecer "velho" só porque o diretório em si foi criado
 *  há semanas. Falha de stat em qualquer entrada (ex: symlink quebrado) é
 *  ignorada silenciosamente — não deve derrubar a varredura inteira. */
function newestMtimeMs(path: string): number {
  let newest = 0;
  try {
    newest = statSync(path).mtimeMs;
  } catch {
    return 0;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(path, { recursive: true }) as string[];
  } catch {
    return newest;
  }
  for (const rel of entries) {
    try {
      const m = statSync(join(path, rel)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // ignora entrada inacessível — não bloqueia a varredura.
    }
  }
  return newest;
}

function collectSessionDirs(claudeDir: string): SessionDirCandidate[] {
  const out: SessionDirCandidate[] = [];
  if (!existsSync(claudeDir)) return out;
  let projectSlugs: string[];
  try {
    projectSlugs = readdirSync(claudeDir);
  } catch {
    return out;
  }
  for (const slug of projectSlugs) {
    const projectDir = join(claudeDir, slug);
    let stat;
    try {
      stat = statSync(projectDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue; // arquivos soltos direto em claudeDir (ex: cache-break-state-*.json) não são sessão
    let sessionIds: string[];
    try {
      sessionIds = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const sessionId of sessionIds) {
      const sessionPath = join(projectDir, sessionId);
      let sStat;
      try {
        sStat = statSync(sessionPath);
      } catch {
        continue;
      }
      if (!sStat.isDirectory()) continue;
      out.push({ sessionId, path: sessionPath, mtimeMs: newestMtimeMs(sessionPath) });
    }
  }
  return out;
}

function collectOutputFiles(sessionDirs: readonly SessionDirCandidate[]): OutputFileCandidate[] {
  const out: OutputFileCandidate[] = [];
  for (const dir of sessionDirs) {
    const tasksDir = join(dir.path, "tasks");
    if (!existsSync(tasksDir)) continue;
    let files: string[];
    try {
      files = readdirSync(tasksDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".output")) continue;
      const p = join(tasksDir, f);
      try {
        const st = statSync(p);
        out.push({ path: p, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // arquivo removido entre o readdir e o stat — ignora.
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const claudeDir = getArg(argv, "claude-dir") || defaultClaudeDir();
  const repoRoot = resolveRepoRoot();

  const sessionDirs = collectSessionDirs(claudeDir);
  const outputFiles = collectOutputFiles(sessionDirs);
  const activeSessionIds = new Set(listActiveSessions(repoRoot).map((s) => s.sessionId));

  const plan = planTmpCleanup(sessionDirs, outputFiles, activeSessionIds, Date.now());
  const freedBytes = planFreedOutputBytes(plan);

  console.log(
    `${LOG_PREFIX} claudeDir=${claudeDir} sessões: ${plan.sessionDirsToRemove.length} candidatas a remoção, ` +
      `${plan.sessionDirsSkippedActive.length} ativas (protegidas), ${plan.sessionDirsSkippedYoung.length} recentes (protegidas). ` +
      `.output: ${plan.outputFilesToRemove.length} candidatos (${Math.round(freedBytes / 1024 / 1024)} MB), ` +
      `${plan.outputFilesSkipped.length} abaixo do limiar.`,
  );

  if (isDryRun) {
    for (const d of plan.sessionDirsToRemove) console.log(`${LOG_PREFIX} --dry-run: removeria diretório ${d.path}`);
    for (const f of plan.outputFilesToRemove) console.log(`${LOG_PREFIX} --dry-run: removeria arquivo ${f.path} (${Math.round(f.sizeBytes / 1024 / 1024)} MB)`);
    console.log(`${LOG_PREFIX} --dry-run: nada foi removido.`);
    return;
  }

  let removedDirs = 0;
  for (const d of plan.sessionDirsToRemove) {
    try {
      rmSync(d.path, { recursive: true, force: true });
      removedDirs += 1;
    } catch (err) {
      console.error(`${LOG_PREFIX} falha ao remover ${d.path}:`, err);
    }
  }
  let removedFiles = 0;
  for (const f of plan.outputFilesToRemove) {
    try {
      rmSync(f.path, { force: true });
      removedFiles += 1;
    } catch (err) {
      console.error(`${LOG_PREFIX} falha ao remover ${f.path}:`, err);
    }
  }
  console.log(`${LOG_PREFIX} removidos: ${removedDirs} diretório(s) de sessão, ${removedFiles} arquivo(s) .output (~${Math.round(freedBytes / 1024 / 1024)} MB).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
