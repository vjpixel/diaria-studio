/**
 * publish-linkedin-personal.ts (#9568 — LinkedIn PESSOAL automatizado)
 *
 * Publica o 4º post (item USE MELHOR, `## um` de `# Social` — o MESMO texto
 * que a página agenda) no perfil pessoal do editor, no MESMO horário do 4º
 * post da página. Substitui o lembrete manual do Stage 6 quando o token do app
 * LinkedIn pessoal existe; sem token, o lembrete manual continua igual
 * (fail-soft — este script nunca quebra a edição).
 *
 * A Posts API da LinkedIn não agenda: publica na hora. Por isso são 2 tempos:
 *
 *   --check                      sem rede: o post automático está disponível?
 *                                exit 0 = sim; exit 3 = não (motivo no stderr)
 *                                → o Stage 6 mostra o lembrete manual.
 *   --arm --edition-dir <dir>    Stage 6, DEPOIS do `ok` do gate: grava
 *                                `_internal/06-linkedin-personal.json` (status
 *                                `armed`, texto, imagem, scheduled_at).
 *                                exit 0 = armado; 1 = nada a postar (4º post
 *                                pulado, sem horário da página); 3 = sem token
 *                                → lembrete manual.
 *   --fire-due [--dry-run]       task `Diaria-LinkedIn-Personal` (logo depois
 *                                do slot): publica toda intenção `armed` de
 *                                hoje/ontem (BRT) cujo horário já passou, até
 *                                3h de atraso. exit 1 se algum post falhou.
 *
 * Sem intenção armada, `--fire-due` não publica nada — é o arme explícito do
 * Stage 6 que autoriza o post (e evita post duplicado se o editor postou à
 * mão). GUARD de publicação: só `--fire-due` sem `--dry-run` fala com a API.
 *
 * Setup do app/token: `docs/linkedin-personal-setup.md`.
 */

import { existsSync, readFileSync } from "node:fs";
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
  aammddBrt,
  decideFire,
  defaultLinkedInApiVersion,
  postToPersonalProfile,
  postUrlFromUrn,
  readPersonalCreds,
  type FetchFn,
  type PersonalPostIntent,
} from "./lib/linkedin-personal.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const EXIT_UNAVAILABLE = 3;

type Env = Record<string, string | undefined>;

export function intentPath(editionDir: string): string {
  return resolve(editionDir, "_internal", PERSONAL_INTENT_FILE);
}

export function readIntent(editionDir: string): PersonalPostIntent | null {
  const p = intentPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PersonalPostIntent;
  } catch {
    return null;
  }
}

function writeIntent(editionDir: string, intent: PersonalPostIntent): void {
  writeFileAtomic(intentPath(editionDir), JSON.stringify(intent, null, 2) + "\n");
}

// ── --arm ────────────────────────────────────────────────────────────────

export type ArmResult =
  | { kind: "armed"; intent: PersonalPostIntent }
  | { kind: "already_published"; intent: PersonalPostIntent }
  | { kind: "nothing"; reason: string }
  | { kind: "unavailable"; reason: string };

export function armPersonalPost(args: {
  editionDir: string;
  config: unknown;
  env: Env;
  now: Date;
}): ArmResult {
  const { editionDir, now } = args;
  const existing = readIntent(editionDir);
  if (existing && (existing.status === "published" || existing.status === "posting")) {
    return { kind: "already_published", intent: existing };
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
  if (Number.isNaN(at.getTime())) return { kind: "nothing", reason: `scheduled_at ilegível: ${r.scheduledAt}` };
  // O token precisa valer até o horário do post, não só agora.
  const creds = readPersonalCreds(args.env, at);
  if (!creds.ok) return { kind: "unavailable", reason: creds.reason };
  const intent: PersonalPostIntent = {
    edition: basename(editionDir),
    status: "armed",
    text: r.text,
    image: r.image,
    scheduled_at: r.scheduledAt,
    armed_at: now.toISOString(),
  };
  writeIntent(editionDir, intent);
  return { kind: "armed", intent };
}

// ── --fire-due ───────────────────────────────────────────────────────────

export type FireOutcome = {
  edition: string;
  action: "published" | "failed" | "expired" | "would_publish";
  reason?: string;
  post_url?: string | null;
};

/** Edições candidatas: hoje e ontem (BRT) — o 4º post sai no dia da edição. */
export function candidateEditions(now: Date): string[] {
  return [aammddBrt(now), aammddBrt(new Date(now.getTime() - 24 * 60 * 60 * 1000))];
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
    const intent = readIntent(dir);
    if (!intent) continue;
    const decision = decideFire(intent, now);
    if (decision === "not_due" || decision === "done") continue;
    if (decision === "expired") {
      if (!args.dryRun) {
        writeIntent(dir, { ...intent, status: "expired", reason: `não disparado até ${now.toISOString()} (limite de atraso)` });
      }
      outcomes.push({ edition: intent.edition, action: "expired", reason: "passou do limite de atraso do slot" });
      continue;
    }
    const creds = readPersonalCreds(env, now);
    if (!creds.ok) {
      if (!args.dryRun) writeIntent(dir, { ...intent, status: "failed", reason: creds.reason });
      outcomes.push({ edition: intent.edition, action: "failed", reason: creds.reason });
      continue;
    }
    if (args.dryRun) {
      outcomes.push({ edition: intent.edition, action: "would_publish" });
      continue;
    }
    // `posting` ANTES da rede: um crash depois do POST nunca vira post duplicado.
    writeIntent(dir, { ...intent, status: "posting" });
    const imageBytes = intent.image ? readImage(resolve(dir, intent.image)) : null;
    const result = await postToPersonalProfile({
      fetchFn: args.fetchFn,
      creds: creds.creds,
      apiVersion: (env[LINKEDIN_PERSONAL_ENV.apiVersion] ?? "").trim() || defaultLinkedInApiVersion(now),
      text: intent.text,
      imageBytes,
    });
    if (result.ok) {
      const post_url = postUrlFromUrn(result.postUrn);
      writeIntent(dir, {
        ...intent,
        status: "published",
        published_at: now.toISOString(),
        post_urn: result.postUrn,
        post_url,
        ...(intent.image && !result.imageUsed ? { reason: `imagem ${intent.image} ilegível no disparo — post saiu só com texto` } : {}),
      });
      outcomes.push({ edition: intent.edition, action: "published", post_url });
    } else {
      writeIntent(dir, { ...intent, status: "failed", reason: result.reason });
      outcomes.push({ edition: intent.edition, action: "failed", reason: result.reason });
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

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const { flags, values } = parseArgs(process.argv.slice(2));
  const env = process.env as Env;
  const now = new Date();

  if (flags.has("check")) {
    const c = readPersonalCreds(env, now);
    if (c.ok) {
      console.log("disponivel");
      return;
    }
    console.error(`#9568: post automático no LinkedIn pessoal indisponível — ${c.reason}`);
    console.log("indisponivel");
    process.exit(EXIT_UNAVAILABLE);
  }

  if (flags.has("arm")) {
    const raw = values["edition-dir"];
    if (!raw) {
      console.error("Uso: npx tsx scripts/publish-linkedin-personal.ts --arm --edition-dir data/editions/AAMM/AAMMDD");
      process.exit(1);
    }
    const dir = resolve(ROOT, raw);
    const r = armPersonalPost({ editionDir: dir, config: readConfig(), env, now });
    const edition = basename(dir);
    if (r.kind === "armed" || r.kind === "already_published") {
      console.log(JSON.stringify({ ok: true, kind: r.kind, scheduled_at: r.intent.scheduled_at, image: r.intent.image }));
      logEvent({ edition, stage: 6, agent: "publish-linkedin-personal", level: "info", message: `#9568: post pessoal ${r.kind}`, details: { scheduled_at: r.intent.scheduled_at } }, ROOT);
      return;
    }
    console.error(`#9568: post pessoal não armado (${r.kind}) — ${r.reason}`);
    console.log(JSON.stringify({ ok: false, kind: r.kind, reason: r.reason }));
    logEvent({ edition, stage: 6, agent: "publish-linkedin-personal", level: r.kind === "unavailable" ? "warn" : "info", message: `#9568: post pessoal não armado (${r.kind})`, details: { reason: r.reason } }, ROOT);
    process.exit(r.kind === "unavailable" ? EXIT_UNAVAILABLE : 1);
  }

  if (flags.has("fire-due")) {
    const dryRun = flags.has("dry-run");
    const dirs = candidateEditions(now).map((e) => resolve(ROOT, editionDirFor(e)));
    const outcomes = await fireDuePersonalPosts({ editionDirs: dirs, env, now, fetchFn: fetch, dryRun });
    if (outcomes.length === 0) console.log("[linkedin-personal] nenhuma intenção vencida (hoje/ontem).");
    let failed = false;
    for (const o of outcomes) {
      console.log(`[linkedin-personal] ${o.edition}: ${o.action}${o.post_url ? ` ${o.post_url}` : ""}${o.reason ? ` — ${o.reason}` : ""}`);
      if (o.action === "failed" || o.action === "expired") failed = true;
      if (!dryRun) {
        logEvent({ edition: o.edition, stage: 6, agent: "publish-linkedin-personal", level: o.action === "published" ? "info" : "error", message: `#9568: post pessoal ${o.action}`, details: o }, ROOT);
      }
    }
    process.exit(failed ? 1 : 0);
  }

  console.error("Uso: --check | --arm --edition-dir <dir> | --fire-due [--dry-run]");
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[linkedin-personal] erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
