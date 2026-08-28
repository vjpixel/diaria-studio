#!/usr/bin/env node
// SessionStart hook — auto-arma o sync do repo `claude-config`
// (`github.com/vjpixel/claude-config`) em QUALQUER máquina que abra o
// `diaria-studio`, sem depender de alguém lembrar de rodar
// `bootstrap.sh`/`bootstrap.ps1` à mão (#6310).
//
// Wired em .claude/settings.json sob hooks.SessionStart (deste repo — NÃO
// no `~/.claude/settings.json` do `claude-config`, que é o alvo, não a
// fonte). É essa inversão que resolve o ovo-e-galinha registrado na issue:
// o hook que mantém o `claude-config` atualizado (`sync-check.cjs`) só
// dispara depois que `~/.claude/settings.json` já é symlink pro repo — mas
// nada arma esse symlink na 1ª vez numa máquina nova, então a máquina nunca
// sai do estado inicial sozinha. Este arquivo, ao contrário, é versionado
// e distribuído pelo `git pull` NORMAL do `diaria-studio` — chega em toda
// máquina que já usa este projeto, independente do estado do `claude-config`
// nela.
//
// ─────────────────────────────────────────────────────────────────────────
// CONTRATO DE SEGURANÇA (mesmo espírito de `sync-check.cjs`, já em produção
// no `claude-config` — ver `~/claude-config/sync-check.cjs`)
// ─────────────────────────────────────────────────────────────────────────
//
//   - NUNCA bloqueia nem atrasa o início da sessão: o processo pai se
//     auto-destaca (spawn detached + `process.exit(0)` imediato) ANTES de
//     tocar rede/disco de verdade — o trabalho de fato roda no filho, fora
//     do caminho crítico do SessionStart.
//   - NUNCA propaga exceção: todo o corpo do trabalho roda dentro de um
//     try/catch único; qualquer falha (offline, git ausente, permissão
//     negada, symlink falhando no Windows) vira log + estado gravado, nunca
//     um exit != 0 nem um throw não capturado.
//   - NUNCA faz merge/rebase/stash automático — delega ao `bootstrap.sh`/
//     `bootstrap.ps1` do PRÓPRIO `claude-config`, que por sua vez só faz
//     `git pull --ff-only` (working tree suja lá vira aviso, não um pull
//     forçado — decisão do editor, não do script).
//   - IDEMPOTENTE: rodar em várias sessões abertas ao mesmo tempo não
//     duplica trabalho de rede além do necessário — debounce por timestamp
//     (`DEBOUNCE_MS` abaixo) evita reclonar/rebootstrapar a cada sessão nova
//     quando a máquina já está armada ou acabou de ser tocada.
//
// A lógica de DECISÃO (clonar? bootstrapar? pular?) é pura e tem teste
// dedicado em `scripts/lib/claude-config-autosync.ts` /
// `test/claude-config-autosync.test.ts` — este arquivo DUPLICA (não importa)
// essa lógica em JS puro, mesmo padrão de `block-branch-checkout-main.mjs`:
// um import estático de `.ts` quebraria o hook inteiro, silenciosamente, num
// Node sem type-stripping nativo. Ao editar a decisão, editar os DOIS
// lugares e conferir que continuam batendo (o teste TS é a fonte da verdade
// do comportamento esperado; este arquivo precisa espelhar).
//
// ─────────────────────────────────────────────────────────────────────────
// O QUE ESTE HOOK NÃO FAZ (fora de escopo, de propósito)
// ─────────────────────────────────────────────────────────────────────────
//
//   - Não sincroniza `memory/` (decisão do #4804: pode conter dado de
//     negócio sensível, fica manual).
//   - Não resolve conflito de merge/working-tree-sujo automaticamente — só
//     avisa (via log do bootstrap/`sync-check.cjs`).
//   - Não substitui `sync-check.cjs` — uma vez que a máquina está ARMADA
//     (settings.json já é symlink pro repo), é `sync-check.cjs` (o hook
//     vendorado DENTRO do `claude-config`, que passa a rodar a cada sessão
//     assim que o symlink existe) quem mantém o pull recorrente. Este hook
//     só cobre o intervalo entre "máquina nova" e "primeira vez armada".

import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), "claude-config");
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_HOME_DIR || join(homedir(), ".claude");
const REPO_URL = "https://github.com/vjpixel/claude-config.git";
const STATE_FILE = join(REPO_DIR, ".diaria-studio-autosync-state.json");
const LOG_FILE = join(REPO_DIR, ".diaria-studio-autosync.log");
const DEBOUNCE_MS = 60 * 60 * 1000; // 1h — espelha DEFAULT_AUTOSYNC_DEBOUNCE_MS

function log(line) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* log nunca pode virar um novo modo de falha */
  }
}

function readLastRunAt() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return typeof raw.lastRunAt === "string" ? raw.lastRunAt : null;
  } catch {
    return null; // arquivo ausente/corrompido -> nunca rodou, do ponto de vista deste hook
  }
}

function saveState(patch) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ lastRunAt: new Date().toISOString(), ...patch }, null, 2) + "\n");
  } catch {
    /* idem log() acima — nunca propagar */
  }
}

// Espelha shouldDebounce() de scripts/lib/claude-config-autosync.ts.
function shouldDebounce(lastRunAt, now, debounceMs) {
  if (lastRunAt === null) return false;
  const last = Date.parse(lastRunAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < debounceMs;
}

// Espelha resolvePlatformKind()/bootstrapScriptName().
function bootstrapScriptName(rawPlatform) {
  return rawPlatform === "win32" ? "bootstrap.ps1" : "bootstrap.sh";
}

function isArmed() {
  // "Armado" = ~/.claude/settings.json é symlink apontando pro repo. Ausente
  // (bootstrap nunca rodou) ou cópia real (fallback do Windows sem symlink,
  // já detectado por sync-check.cjs) contam como NÃO armado.
  const dst = join(CLAUDE_DIR, "settings.json");
  if (!existsSync(dst)) return false;
  try {
    return lstatSync(dst).isSymbolicLink();
  } catch {
    return false; // ilegível: não afirmar que está armado
  }
}

function runBootstrap(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = join(REPO_DIR, scriptName);
    if (!existsSync(scriptPath)) {
      resolve({ ok: false, err: `script ausente: ${scriptPath}` });
      return;
    }
    const [cmd, args] =
      scriptName === "bootstrap.ps1"
        ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]]
        : ["bash", [scriptPath]];
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || "").slice(0, 2000), err: String(stderr || err?.message || "").slice(0, 500) });
    });
  });
}

function cloneRepo() {
  return new Promise((resolve) => {
    execFile("git", ["clone", REPO_URL, REPO_DIR], { timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, err: String(stderr || err?.message || "").slice(0, 500) });
    });
  });
}

async function run() {
  const now = new Date();
  const lastRunAt = readLastRunAt();

  if (shouldDebounce(lastRunAt, now, DEBOUNCE_MS)) {
    return; // sem log: caminho feliz recorrente, log só quando precisa de ação (requisito 6 da issue)
  }

  const repoExists = existsSync(join(REPO_DIR, ".git"));
  const armed = repoExists && isArmed();
  const scriptName = bootstrapScriptName(process.platform);

  if (!repoExists) {
    log(`repo ausente em ${REPO_DIR} — clonando`);
    const cloneResult = await cloneRepo();
    if (!cloneResult.ok) {
      log(`ERRO git clone: ${cloneResult.err}`);
      saveState({ result: "erro", step: "clone", detail: cloneResult.err });
      return; // sem repo, não adianta tentar bootstrap
    }
    const bootstrapResult = await runBootstrap(scriptName);
    if (!bootstrapResult.ok) log(`ERRO bootstrap (${scriptName}) pós-clone: ${bootstrapResult.err}`);
    saveState({ result: bootstrapResult.ok ? "ok" : "erro", step: "clone-and-bootstrap" });
    return;
  }

  if (!armed) {
    log(`repo presente mas nao armado — rodando ${scriptName}`);
    const bootstrapResult = await runBootstrap(scriptName);
    if (!bootstrapResult.ok) log(`ERRO bootstrap (${scriptName}): ${bootstrapResult.err}`);
    saveState({ result: bootstrapResult.ok ? "ok" : "erro", step: "bootstrap" });
    return;
  }

  // Já armado: sync-check.cjs (vendorado dentro do próprio claude-config,
  // agora alcançável via o symlink que este hook garantiu) assume o pull
  // recorrente a partir daqui. Só registra o estado, sem log (caminho feliz).
  saveState({ result: "ok", step: "skip-ja-armado" });
}

// AUTO-DESTACAMENTO — mesmo padrão de sync-check.cjs: o hook chama este
// script SEM `&` e sem sintaxe de shell POSIX (não portável pro cmd.exe do
// Windows). Em vez de exigir isso do wrapper em settings.json, o próprio
// script se re-lança destacado e sai na hora — a sessão NUNCA espera rede.
if (!process.env.CLAUDE_CONFIG_AUTOSYNC_CHILD) {
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CLAUDE_CONFIG_AUTOSYNC_CHILD: "1" },
    }).unref();
  } catch {
    /* se nem spawn funcionar, desistir em silêncio — nunca atrapalhar a sessão */
  }
  process.exit(0);
}

run().catch((e) => {
  try {
    log(`ERRO inesperado: ${String(e && e.message).slice(0, 200)}`);
    saveState({ result: "erro", detail: String(e && e.message).slice(0, 300) });
  } catch {
    /* nunca propagar */
  }
});
