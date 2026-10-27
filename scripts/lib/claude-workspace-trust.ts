/**
 * scripts/lib/claude-workspace-trust.ts (#11383)
 *
 * Preflight de CONFIANÇA DO WORKSPACE para os runners headless
 * (`run-nightly-chain.ts`, `run-scheduled-edicao.ts`).
 *
 * `claude -p` nunca mostra o diálogo de confiança, e as regras
 * `permissions.allow` de `.claude/settings.json` só valem num diretório já
 * confiado (https://code.claude.com/docs/en/permissions, "Project allow rules
 * and workspace trust"). A marca vive em `~/.claude.json`:
 * `projects["<caminho absoluto>"].hasTrustDialogAccepted: true`. Sem ela, a
 * allowlist inteira é ignorada e o único sinal é uma linha no stderr
 * (`Ignoring N permissions.allow entries from .claude/settings.json: this
 * workspace has not been trusted`). Medido na prova do #11235 (PR #11382): 38
 * negações num clone sem a marca, contra 6 sob o checkout confiável.
 *
 * Duas defesas, as duas aqui:
 *   1. `checkWorkspaceTrust` — ANTES de subir o `claude`: lê `~/.claude.json`
 *      e procura a marca no repo ou num ancestral (o worktree sob
 *      `.claude/worktrees/` herda a confiança do checkout principal, prova do
 *      #11235). Sem a marca, o runner loga e sai com `EXIT_WORKSPACE_UNTRUSTED`.
 *   2. `stderrSaysWorkspaceUntrusted` — DEPOIS da run: a linha do CLI no stderr.
 *      Pega o caso em que o arquivo diz "confiado" mas o CLI discorda (formato
 *      do `~/.claude.json` mudou, `CLAUDE_CONFIG_DIR` diferente no filho).
 *
 * **Ilegível não é confiado (pedido explícito da issue).** Arquivo ausente,
 * JSON inválido ou erro de leitura caem num status próprio (`unreadable`), com
 * mensagem distinta de "sem a marca", e o runner trata igual: falha. Um
 * fail-soft aqui mascararia justamente o cenário que a issue descreve
 * (`~/.claude.json` recriado numa máquina nova).
 *
 * Puro exceto pela leitura do arquivo, que é injetável (`readFile`).
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Exit dos runners quando o workspace não está confiado. Fora de `successExitCodes`: a unit sai `failed`. */
export const EXIT_WORKSPACE_UNTRUSTED = 6;

/** Linha que o CLI escreve no stderr quando ignora a allowlist do projeto. */
export const WORKSPACE_UNTRUSTED_STDERR_RE = /this workspace has not been trusted/i;

export type WorkspaceTrustStatus =
  /** Repo (ou ancestral) com `hasTrustDialogAccepted: true`. */
  | "trusted"
  /** Arquivo legível, mas nenhuma entrada do repo/ancestral tem a marca. */
  | "untrusted"
  /** `~/.claude.json` ausente, ilegível, JSON inválido ou sem objeto `projects`. */
  | "unreadable";

export interface WorkspaceTrustResult {
  status: WorkspaceTrustStatus;
  /** Caminho do `.claude.json` consultado. */
  configPath: string;
  /** Entrada de `projects` que deu a confiança (só em `trusted`). */
  trustedBy?: string;
  /** Linha pronta pro log do runner. */
  message: string;
}

export interface WorkspaceTrustOptions {
  /** Ambiente do runner: `HOME` e `CLAUDE_CONFIG_DIR` saem daqui (injetável nos testes). */
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
}

/**
 * Caminho do config global do Claude Code: `$CLAUDE_CONFIG_DIR/.claude.json`
 * quando a var existe, senão `$HOME/.claude.json`.
 */
export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir && configDir.trim() !== "") return join(configDir, ".claude.json");
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  return join(home, ".claude.json");
}

/** O caminho e todos os ancestrais, do mais fundo pra raiz. */
export function selfAndAncestors(pathAbs: string): string[] {
  const out: string[] = [];
  let cur = resolve(pathAbs);
  for (;;) {
    out.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

export function checkWorkspaceTrust(repoRootAbs: string, opts: WorkspaceTrustOptions = {}): WorkspaceTrustResult {
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const realpath = opts.realpath ?? realpathSync;
  const configPath = claudeGlobalConfigPath(env);

  const unreadable = (why: string): WorkspaceTrustResult => ({
    status: "unreadable",
    configPath,
    message:
      `confiança do workspace: NÃO VERIFICÁVEL — ${configPath} ${why}. Tratado como não confiado: ` +
      `sem a marca, \`claude -p\` ignora a allowlist de .claude/settings.json (#11383). ` +
      `Abrir \`claude\` interativo em ${repoRootAbs} uma vez e aceitar o diálogo de confiança.`,
  });

  let raw: string;
  try {
    raw = readFile(configPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return unreadable(code === "ENOENT" ? "não existe" : `ilegível (${(e as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return unreadable(`não é JSON válido (${(e as Error).message})`);
  }
  const projects = (parsed as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    return unreadable("não tem o objeto `projects`");
  }

  const candidates = new Set<string>(selfAndAncestors(repoRootAbs));
  try {
    for (const p of selfAndAncestors(realpath(repoRootAbs))) candidates.add(p);
  } catch {
    // repo inexistente/sem realpath: os caminhos resolvidos já estão no set
  }
  // No Windows o Claude Code grava as chaves com barra normal (`C:/Users/...`),
  // e `resolve` devolve barra invertida: as duas grafias entram.
  for (const p of [...candidates]) candidates.add(p.replace(/\\/g, "/"));
  const table = projects as Record<string, unknown>;
  for (const path of candidates) {
    const entry = table[path];
    if (entry && typeof entry === "object" && (entry as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true) {
      return {
        status: "trusted",
        configPath,
        trustedBy: path,
        message: `confiança do workspace: ok (${path} em ${configPath})`,
      };
    }
  }
  return {
    status: "untrusted",
    configPath,
    message:
      `confiança do workspace: AUSENTE — nenhuma entrada de \`projects\` em ${configPath} para ${repoRootAbs} ` +
      `(ou ancestral) tem hasTrustDialogAccepted: true. Sem a marca, \`claude -p\` ignora a allowlist de ` +
      `.claude/settings.json (#11383). Abrir \`claude\` interativo em ${repoRootAbs} uma vez e aceitar o diálogo de confiança.`,
  };
}

/** Defesa depois da run: o CLI anunciou no stderr que ignorou a allowlist. */
export function stderrSaysWorkspaceUntrusted(stderr: string | null | undefined): boolean {
  return WORKSPACE_UNTRUSTED_STDERR_RE.test(stderr ?? "");
}
