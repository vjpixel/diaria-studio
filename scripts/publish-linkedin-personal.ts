/**
 * publish-linkedin-personal.ts (#9568 — LinkedIn PESSOAL automatizado)
 *
 * Publica o 4º post (item USE MELHOR, `## um` de `# Social` — o MESMO texto
 * que a página agenda) no perfil pessoal do editor, no MESMO horário do 4º
 * post da página. Substitui o lembrete manual do Stage 6 quando o token do app
 * LinkedIn pessoal existe e o post cabe na janela das tasks; caso contrário o
 * lembrete manual continua igual (fail-soft — este script nunca quebra a edição).
 *
 * A Posts API da LinkedIn não agenda: publica na hora. Por isso são 2 tempos:
 *
 *   --check [--edition-dir <dir>]  pré-gate do Stage 6. Sem `--edition-dir`:
 *                                  credenciais + `GET /v2/userinfo` (token
 *                                  revogado = indisponível). Com
 *                                  `--edition-dir`: simula o `--arm` inteiro
 *                                  sem gravar — é o que decide se o lembrete
 *                                  diz AUTOMÁTICO.
 *   --arm --edition-dir <dir>      Stage 6, DEPOIS do `ok` do gate: grava
 *                                  `_internal/06-linkedin-personal.json`
 *                                  (status `armed`).
 *   --fire-due [--dry-run]         tasks `Diaria-LinkedIn-Personal` (07:46) e
 *                                  `Diaria-LinkedIn-Personal-Catchup` (de hora
 *                                  em hora): publica toda intenção `armed` de
 *                                  hoje/ontem (BRT) já vencida, até 3h de atraso.
 *
 * Exit codes de `--check --edition-dir` e `--arm` (ver `ARM_EXIT`):
 *   0 armado (ou já publicado) — post automático
 *   1 nada a postar (4º post pulado, página sem entry, edição legada)
 *   3 indisponível (sem token, token expirado/revogado, fora da janela) → lembrete manual
 *   4 erro inesperado → lembrete manual
 *   5 estado ambíguo (posting/send_unknown/arquivo corrompido) → conferir o
 *     perfil ANTES de postar à mão
 * `--fire-due`: 0 ok; 1 se algum post falhou, expirou ou o arquivo está corrompido.
 *
 * Duplicação: sem intenção armada, `--fire-due` não publica nada — é o arme
 * explícito do Stage 6 que autoriza o post. Se o editor postar à mão numa
 * edição já armada, o automático também posta. Dentro do script, o lock
 * O_EXCL (`06-linkedin-personal.lock`) e o status `posting` gravado antes da
 * rede garantem que duas execuções concorrentes (07:46 e catch-up) ou um
 * crash nunca geram post duplicado; `send_unknown` nunca é re-tentado.
 *
 * GUARD de publicação: só `--fire-due` sem `--dry-run` cria post. `--check` e
 * o alarme só leem (`/v2/userinfo`). Setup: `docs/linkedin-personal-setup.md`.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { logEvent } from "./lib/run-log.ts";
import { planUseMelhorDispatch } from "./lib/use-melhor-dispatch.ts";
import { extractPersonalPostText, readUseMelhorScheduledAt, resolvePersonalPost } from "./resolve-post-pixel.ts";
import {
  LINKEDIN_PERSONAL_ENV,
  PERSONAL_INTENT_FILE,
  PERSONAL_LOCK_FILE,
  aammddBrt,
  checkTokenRemote,
  decideFire,
  defaultLinkedInApiVersion,
  fireWindowCheck,
  postToPersonalProfile,
  postUrlFromUrn,
  readPersonalCreds,
  tokenFingerprint,
  type FetchFn,
  type PersonalPostIntent,
} from "./lib/linkedin-personal.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Env = Record<string, string | undefined>;

export function intentPath(editionDir: string): string {
  return resolve(editionDir, "_internal", PERSONAL_INTENT_FILE);
}
export function lockPath(editionDir: string): string {
  return resolve(editionDir, "_internal", PERSONAL_LOCK_FILE);
}

export type IntentRead = { kind: "absent" } | { kind: "ok"; intent: PersonalPostIntent } | { kind: "corrupt"; error: string };

/** Ausente e corrompido são coisas diferentes: corrompido nunca é sobrescrito nem tratado como "nada armado". */
export function readIntent(editionDir: string): IntentRead {
  const p = intentPath(editionDir);
  if (!existsSync(p)) return { kind: "absent" };
  try {
    const intent = JSON.parse(readFileSync(p, "utf8")) as PersonalPostIntent;
    if (!intent || typeof intent.status !== "string" || typeof intent.scheduled_at !== "string") {
      return { kind: "corrupt", error: "campos obrigatórios ausentes" };
    }
    return { kind: "ok", intent };
  } catch (e) {
    return { kind: "corrupt", error: (e as Error).message };
  }
}

function writeIntent(editionDir: string, intent: PersonalPostIntent): void {
  writeFileAtomic(intentPath(editionDir), JSON.stringify(intent, null, 2) + "\n");
}

// ── --arm / --check ──────────────────────────────────────────────────────

export type ArmKind =
  | "armed"
  | "would_arm"
  | "already_published"
  | "nothing"
  | "unavailable"
  | "in_flight"
  | "send_unknown"
  | "corrupt"
  | "error";

export type ArmResult = { kind: ArmKind; reason?: string; intent?: PersonalPostIntent; nextRun?: string };

export const ARM_EXIT: Record<ArmKind, number> = {
  armed: 0,
  would_arm: 0,
  already_published: 0,
  nothing: 1,
  unavailable: 3,
  error: 4,
  in_flight: 5,
  send_unknown: 5,
  corrupt: 5,
};

export async function armPersonalPost(args: {
  editionDir: string;
  config: unknown;
  env: Env;
  now: Date;
  fetchFn: FetchFn;
  /** `--check --edition-dir`: avalia tudo, não grava. */
  dryRun?: boolean;
}): Promise<ArmResult> {
  try {
    return await armInner(args);
  } catch (e) {
    return { kind: "error", reason: (e as Error).message };
  }
}

async function armInner(args: { editionDir: string; config: unknown; env: Env; now: Date; fetchFn: FetchFn; dryRun?: boolean }): Promise<ArmResult> {
  const { editionDir, now } = args;
  const existing = readIntent(editionDir);
  if (existing.kind === "corrupt") return { kind: "corrupt", reason: `06-linkedin-personal.json ilegível (${existing.error}) — não sobrescrevo` };
  if (existsSync(lockPath(editionDir))) return { kind: "in_flight", reason: "lock de disparo presente — um post pode estar saindo agora" };
  if (existing.kind === "ok") {
    const s = existing.intent.status;
    if (s === "published") return { kind: "already_published", intent: existing.intent };
    if (s === "posting") return { kind: "in_flight", reason: "intenção em posting — conferir o perfil antes de qualquer ação", intent: existing.intent };
    if (s === "send_unknown") return { kind: "send_unknown", reason: existing.intent.reason ?? "resultado do envio desconhecido", intent: existing.intent };
    // armed / failed_before_send / expired: re-arme permitido.
  }
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return { kind: "nothing", reason: "03-social.md ausente" };
  const personal = extractPersonalPostText(readFileSync(socialPath, "utf8"));
  if (!personal || personal.source !== "um") {
    // `## post_pixel` legado nunca é automatizado: o post automático é só o 4º post.
    return { kind: "nothing", reason: "edição sem '## um' (4º post USE MELHOR)" };
  }
  const plan = planUseMelhorDispatch(editionDir, args.config);
  const r = resolvePersonalPost({
    personal,
    plan,
    fileExists: (name) => existsSync(resolve(editionDir, name)),
    scheduledAt: readUseMelhorScheduledAt(editionDir),
  });
  if (!r.ok) return { kind: "nothing", reason: r.reason };
  if (!r.scheduledAt) {
    return { kind: "nothing", reason: "a página não agendou o 4º post (sem entry linkedin/um em 06-social-published.json)" };
  }
  const at = new Date(r.scheduledAt);
  const window = fireWindowCheck(at, now);
  if (!window.ok) return { kind: "unavailable", reason: `fora da janela das tasks: ${window.reason}` };
  // O token precisa valer até o horário do post, não só agora.
  const creds = readPersonalCreds(args.env, at);
  if (!creds.ok) return { kind: "unavailable", reason: creds.reason };
  const remote = await checkTokenRemote(args.fetchFn, creds.creds.accessToken);
  if (remote.state !== "valid") return { kind: "unavailable", reason: remote.reason };
  const intent: PersonalPostIntent = {
    edition: basename(editionDir),
    status: "armed",
    text: r.text,
    image: r.image,
    scheduled_at: r.scheduledAt,
    armed_at: now.toISOString(),
    token_fingerprint: tokenFingerprint(args.env),
  };
  if (args.dryRun) return { kind: "would_arm", intent, nextRun: window.nextRun.toISOString() };
  writeIntent(editionDir, intent);
  return { kind: "armed", intent, nextRun: window.nextRun.toISOString() };
}

// ── --fire-due ───────────────────────────────────────────────────────────

export type FireAction = "published" | "failed_before_send" | "send_unknown" | "expired" | "would_publish" | "corrupt" | "locked";

export type FireOutcome = {
  edition: string;
  action: FireAction;
  reason?: string;
  note?: string;
  post_url?: string | null;
};

/** Ações que tornam a execução da task vermelha (exit 1). */
export const FIRE_FAILURE_ACTIONS: ReadonlySet<FireAction> = new Set(["failed_before_send", "send_unknown", "expired", "corrupt"]);

export function fireExitCode(outcomes: readonly FireOutcome[]): number {
  return outcomes.some((o) => FIRE_FAILURE_ACTIONS.has(o.action)) ? 1 : 0;
}

/** Edições candidatas: hoje e ontem (BRT) — o 4º post sai no dia da edição. */
export function candidateEditions(now: Date): string[] {
  return [aammddBrt(now), aammddBrt(new Date(now.getTime() - 24 * 60 * 60 * 1000))];
}

/** O_EXCL: só um processo ganha. `false` = outro já está (ou esteve) disparando. */
function acquireLock(dir: string, nowIso: string): boolean {
  try {
    writeFileSync(lockPath(dir), nowIso, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function releaseLock(dir: string): void {
  try {
    unlinkSync(lockPath(dir));
  } catch {
    /* lock já removido */
  }
}

export async function fireDuePersonalPosts(args: {
  editionDirs: string[];
  env: Env;
  now: Date;
  fetchFn: FetchFn;
  dryRun?: boolean;
  readImage?: (path: string) => Uint8Array | null;
}): Promise<FireOutcome[]> {
  const { env, now } = args;
  const readImage =
    args.readImage ??
    ((p: string) => {
      try {
        return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
      } catch {
        return null;
      }
    });
  const outcomes: FireOutcome[] = [];
  for (const dir of args.editionDirs) {
    const read = readIntent(dir);
    if (read.kind === "absent") continue;
    if (read.kind === "corrupt") {
      outcomes.push({ edition: basename(dir), action: "corrupt", reason: `06-linkedin-personal.json ilegível: ${read.error}` });
      continue;
    }
    const intent = read.intent;
    const decision = decideFire(intent, now);
    if (decision === "not_due" || decision === "done") continue;
    if (decision === "expired") {
      if (!args.dryRun) {
        writeIntent(dir, { ...intent, status: "expired", reason: `não disparado até ${now.toISOString()} (limite de 3h de atraso)` });
      }
      outcomes.push({ edition: intent.edition, action: "expired", reason: "passou do limite de 3h de atraso do slot" });
      continue;
    }
    const creds = readPersonalCreds(env, now);
    if (!creds.ok) {
      const reason = creds.configured
        ? creds.reason
        : `${LINKEDIN_PERSONAL_ENV.accessToken} ausente nesta máquina — rode \`npm run sync-env\` no 300`;
      if (!args.dryRun) writeIntent(dir, { ...intent, status: "failed_before_send", reason });
      outcomes.push({ edition: intent.edition, action: "failed_before_send", reason });
      continue;
    }
    const fp = tokenFingerprint(env);
    const note =
      intent.token_fingerprint && fp !== intent.token_fingerprint
        ? `token desta máquina (expira ${fp ?? "?"}) difere do que armou (expira ${intent.token_fingerprint}) — rode \`npm run sync-env\` no 300`
        : undefined;
    const imageBytes = intent.image ? readImage(resolve(dir, intent.image)) : null;
    if (intent.image && !imageBytes) {
      // Regra: não sai sem a capa que a página tem. Re-armável.
      const reason = `imagem ${intent.image} ausente/ilegível no disparo — post não enviado (re-armável)`;
      if (!args.dryRun) writeIntent(dir, { ...intent, status: "failed_before_send", reason });
      outcomes.push({ edition: intent.edition, action: "failed_before_send", reason });
      continue;
    }
    if (args.dryRun) {
      outcomes.push({ edition: intent.edition, action: "would_publish", ...(note ? { note } : {}) });
      continue;
    }
    // Lock O_EXCL = a transição real para `posting`; `posting` gravado ANTES da rede.
    if (!acquireLock(dir, now.toISOString())) {
      outcomes.push({ edition: intent.edition, action: "locked", reason: "outra execução já está disparando" });
      continue;
    }
    try {
      writeIntent(dir, { ...intent, status: "posting", posting_at: now.toISOString(), ...(note ? { note } : {}) });
      const result = await postToPersonalProfile({
        fetchFn: args.fetchFn,
        creds: creds.creds,
        apiVersion: (env[LINKEDIN_PERSONAL_ENV.apiVersion] ?? "").trim() || defaultLinkedInApiVersion(now),
        text: intent.text,
        imageBytes,
      });
      const base = { ...intent, posting_at: now.toISOString(), ...(note ? { note } : {}) };
      if (result.ok) {
        const post_url = postUrlFromUrn(result.postUrn);
        writeIntent(dir, { ...base, status: "published", published_at: now.toISOString(), post_urn: result.postUrn, post_url });
        outcomes.push({ edition: intent.edition, action: "published", post_url, ...(note ? { note } : {}) });
      } else {
        const status = result.phase === "ambiguous" ? "send_unknown" : "failed_before_send";
        writeIntent(dir, { ...base, status, reason: result.reason });
        outcomes.push({ edition: intent.edition, action: status, reason: result.reason, ...(note ? { note } : {}) });
      }
    } finally {
      releaseLock(dir);
    }
  }
  return outcomes;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function readConfig(): unknown {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Devolve o exit code em vez de chamar `process.exit` (#9884). No Windows,
 * com Node 24, `process.exit()` logo depois de um `fetch` cai no assert do
 * libuv (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c:76) e o
 * processo sai com 127, não com o código pedido. O Stage 6 lê `--check`/`--arm`
 * pelo exit code (`unavailable` = 3), então o assert apagava o sinal. Com
 * `process.exitCode` o loop drena os handles do fetch e o código chega intacto.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  loadProjectEnv(ROOT);
  const { flags, values } = parseArgs([...argv]);
  const env = process.env as Env;
  const now = new Date();

  if (flags.has("check") && !values["edition-dir"]) {
    const c = readPersonalCreds(env, now);
    const remote = c.ok ? await checkTokenRemote(fetch, c.creds.accessToken) : null;
    if (c.ok && remote?.state === "valid") {
      console.log("disponivel");
      return 0;
    }
    const reason = !c.ok ? c.reason : remote && remote.state !== "valid" ? remote.reason : "";
    console.error(`#9568: post automático no LinkedIn pessoal indisponível — ${reason}`);
    console.log("indisponivel");
    return ARM_EXIT.unavailable;
  }

  if (flags.has("arm") || flags.has("check")) {
    const dryRun = flags.has("check");
    const raw = values["edition-dir"];
    if (!raw) {
      console.error("Uso: npx tsx scripts/publish-linkedin-personal.ts --arm|--check --edition-dir data/editions/AAMM/AAMMDD");
      return ARM_EXIT.error;
    }
    const dir = resolve(ROOT, raw);
    const r = await armPersonalPost({ editionDir: dir, config: readConfig(), env, now, fetchFn: fetch, dryRun });
    const code = ARM_EXIT[r.kind];
    console.log(JSON.stringify({ ok: code === 0, kind: r.kind, reason: r.reason ?? null, scheduled_at: r.intent?.scheduled_at ?? null, next_run: r.nextRun ?? null }));
    if (code !== 0) console.error(`#9568: post pessoal ${dryRun ? "(check) " : ""}${r.kind} — ${r.reason ?? ""}`);
    if (!dryRun) {
      logEvent({ edition: basename(dir), stage: 6, agent: "publish-linkedin-personal", level: code === 0 || code === 1 ? "info" : "warn", message: `#9568: arm ${r.kind}`, details: { reason: r.reason ?? null, scheduled_at: r.intent?.scheduled_at ?? null } }, ROOT);
    }
    return code;
  }

  if (flags.has("fire-due")) {
    const dryRun = flags.has("dry-run");
    const dirs = candidateEditions(now).map((e) => resolve(ROOT, editionDirFor(e)));
    const outcomes = await fireDuePersonalPosts({ editionDirs: dirs, env, now, fetchFn: fetch, dryRun });
    if (outcomes.length === 0) console.log("[linkedin-personal] nenhuma intenção vencida (hoje/ontem).");
    for (const o of outcomes) {
      const line = `[linkedin-personal] ${o.edition}: ${o.action}${o.post_url ? ` ${o.post_url}` : ""}${o.reason ? ` — ${o.reason}` : ""}${o.note ? ` (aviso: ${o.note})` : ""}`;
      if (FIRE_FAILURE_ACTIONS.has(o.action)) console.error(line);
      else console.log(line);
      if (!dryRun) {
        logEvent({ edition: o.edition, stage: 6, agent: "publish-linkedin-personal", level: FIRE_FAILURE_ACTIONS.has(o.action) ? "error" : o.note ? "warn" : "info", message: `#9568: post pessoal ${o.action}`, details: o }, ROOT);
      }
    }
    return fireExitCode(outcomes);
  }

  console.error("Uso: --check [--edition-dir <dir>] | --arm --edition-dir <dir> | --fire-due [--dry-run]");
  return ARM_EXIT.error;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`[linkedin-personal] erro: ${(e as Error).message}`);
      process.exitCode = ARM_EXIT.error;
    },
  );
}
