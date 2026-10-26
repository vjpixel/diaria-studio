/**
 * scripts/lib/onedrive-skip-file.ts (#10957)
 *
 * Lógica PURA da chave `skip_file` do cliente Linux do OneDrive
 * (`abraunegg/onedrive`, `~/.config/onedrive/config`). Dois consumidores:
 *
 *   1. `scripts/onedrive-skip-file-config.ts` — gera/aplica de forma
 *      IDEMPOTENTE a linha `skip_file` com os padrões que o projeto exige
 *      fora do sync (o `*.mp4` decidido no briefing do overnight 261026b,
 *      mais os padrões transitórios do #5548).
 *   2. `scripts/onedrive-sync-alarm.ts` (sinal de cota) — lê os padrões
 *      EFETIVOS da config pra descontar do uso de `data/` o que o cliente
 *      já não sobe (um `.mp4` excluído não ocupa cota).
 *
 * Formato da config (documentação do cliente): uma linha por chave,
 * `chave = "valor"`, `#` comenta a linha. `skip_file` é uma lista de globs
 * separados por `|`, casados contra o NOME do arquivo. Quando a chave
 * aparece em mais de uma linha, o cliente soma as entradas — por isso
 * `readSkipFilePatterns` une todas as linhas não comentadas.
 *
 * Por que `*.mp4` (decisão do editor, comentário de 26/10/2026 na #10957):
 * o vídeo da edição pesa 0,3 a 0,6 GB e já tem três cópias fora do
 * OneDrive (YouTube, R2 pros verticais, a fonte no Drive). Era o grosso da
 * cota que parou o sync de `data/` em 23/10/2026.
 */

/** Default do próprio cliente quando `skip_file` não está na config. Entra
 * na linha gerada porque declarar a chave SUBSTITUI o default. */
export const ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE: readonly string[] = ["~*", ".~*", "*.tmp", "*.swp", "*.partial"];

/** Padrões que o projeto exige fora do sync. Os seis primeiros vêm do
 * `docs/onedrive-sync-setup.md` (#5548, arquivos transitórios e o
 * append-only `run-log.jsonl`); `*.mp4` é do #10957. */
export const REQUIRED_SKIP_FILE_PATTERNS: readonly string[] = [
  "*.db-shm",
  "*.db-wal",
  "*.sqlite3-shm",
  "*.sqlite3-wal",
  "run-log.jsonl",
  "*.mp4",
];

/** Valor entre aspas duplas (formato da doc do cliente) ou simples — o
 * parser de config do cliente aceita as duas. Grupo 3 = valor. */
const SKIP_FILE_LINE = /^(\s*)skip_file\s*=\s*(["'])((?:(?!\2).)*)\2\s*$/;

/** Divide o valor de `skip_file` em padrões (sem vazios, sem espaços). */
export function splitSkipFileValue(value: string): string[] {
  return value
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Padrões efetivos de `skip_file` na config, na ordem em que aparecem,
 * sem duplicatas. `null` = nenhuma linha `skip_file` ativa (o cliente usa o
 * default `ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE`).
 */
export function readSkipFilePatterns(configText: string): string[] | null {
  let found = false;
  const out: string[] = [];
  for (const line of configText.split(/\r?\n/)) {
    const m = SKIP_FILE_LINE.exec(line);
    if (!m) continue;
    found = true;
    for (const p of splitSkipFileValue(m[3])) if (!out.includes(p)) out.push(p);
  }
  return found ? out : null;
}

export interface SkipFilePlan {
  /** Config resultante (igual à entrada quando `changed` é false). */
  text: string;
  changed: boolean;
  /** Padrões que faltavam e entraram. */
  added: string[];
  /** Padrões efetivos depois do plano. */
  effective: string[];
}

/**
 * Pura e idempotente — garante que todos os `required` estejam no
 * `skip_file` efetivo. Aplicar duas vezes dá o mesmo texto (`changed:
 * false` na segunda).
 *
 * - Sem linha `skip_file` ativa: acrescenta uma no fim, com o default do
 *   cliente + `required` (declarar a chave substitui o default, então ele
 *   precisa vir junto pra não voltar a subir `~*`/`*.tmp`).
 * - Com linha(s) ativa(s): acrescenta só o que falta, na ÚLTIMA linha
 *   ativa. Nunca remove nem reordena padrão que o editor já tinha.
 */
export function planSkipFileConfig(configText: string, required: readonly string[] = REQUIRED_SKIP_FILE_PATTERNS): SkipFilePlan {
  const current = readSkipFilePatterns(configText);
  if (current === null) {
    const effective = [...ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE];
    for (const p of required) if (!effective.includes(p)) effective.push(p);
    const added = effective.filter((p) => !ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE.includes(p));
    const sep = configText.length === 0 || configText.endsWith("\n") ? "" : "\n";
    const text =
      configText +
      sep +
      `# #10957 (diar.ia.br): arquivos fora do sync — gerado por scripts/onedrive-skip-file-config.ts\n` +
      `skip_file = "${effective.join("|")}"\n`;
    return { text, changed: true, added, effective };
  }

  const added = required.filter((p) => !current.includes(p));
  if (added.length === 0) return { text: configText, changed: false, added: [], effective: current };

  const lines = configText.split(/(?<=\n)/); // preserva os terminadores de linha
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SKIP_FILE_LINE.test(lines[i].replace(/\r?\n$/, ""))) lastIdx = i;
  }
  const raw = lines[lastIdx];
  const eol = raw.match(/\r?\n$/)?.[0] ?? "";
  const m = SKIP_FILE_LINE.exec(raw.replace(/\r?\n$/, ""))!;
  const merged = [...splitSkipFileValue(m[3]), ...added];
  lines[lastIdx] = `${m[1]}skip_file = "${merged.join("|")}"${eol}`;
  return { text: lines.join(""), changed: true, added, effective: [...current, ...added] };
}

/** Glob do `skip_file` (`*` e `?`, sem `/`) → RegExp ancorada. */
export function skipGlobToRegExp(glob: string): RegExp {
  let src = "";
  for (const ch of glob) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "i");
}

/** Matcher pré-compilado: `true` se o NOME do arquivo casa algum padrão
 * (o cliente compara sem diferenciar maiúsculas). */
export function buildSkipFileMatcher(patterns: readonly string[]): (fileName: string) => boolean {
  const res = patterns.map(skipGlobToRegExp);
  return (fileName) => res.some((re) => re.test(fileName));
}
