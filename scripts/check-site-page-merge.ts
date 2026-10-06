#!/usr/bin/env node
/**
 * scripts/check-site-page-merge.ts (#9621 item 1)
 *
 * Check agendado pré-envio (task `Diaria-Site-Page-Merge-Check`, 05:15 BRT):
 * lê `_internal/site-page-published.json` da edição DO DIA e, se o PR da
 * página do site não estiver MERGED, alerta o editor (`notifyEditor`
 * urgente) antes do envio das 06:00 — sem o merge, `/p/{slug}` (link de
 * WhatsApp do e-mail) dá 404.
 *
 * **Por que existe (resíduo da #9616):** o waiter em background
 * (`publish-edition-site-page.ts --merge-pr`, #9593) já alerta sozinho quando
 * termina sem merge. O que ele não cobre é a própria morte: reboot/kill na
 * janela de até 35min deixa o state file para sempre em "merge delegado ao
 * waiter", e nenhum leitor roda depois do gate do Stage 6. Este check é o
 * leitor que faltava, independente de qualquer processo da véspera.
 *
 * **Mesmo fingerprint do alerta do waiter** (`site-page-merge-waiter:pr-N`):
 * se o waiter chegou a alertar, a issue já existe e `ensureAlarmIssue` a
 * reaproveita (sem 2º e-mail); se ele morreu calado, a issue nasce aqui.
 *
 * Desfechos (exit code):
 *   - 0 — sem state file (dia sem edição / página não publicada pelo script),
 *         página não publicada, sem PR identificável, PR MERGED, ou alerta
 *         registrado com sucesso.
 *   - 1 — `data/editions/` ausente (junction `data/` não montada: sem isso o
 *         "sem state file" seria indistinguível de dia sem edição e o check
 *         passaria em silêncio justo quando devia alertar, review do PR
 *         #9695), state file PRESENTE mas ilegível (vazio/truncado por
 *         reboot no meio da escrita — justamente o cenário-alvo deste check,
 *         #9760), não deu pra verificar (`gh pr view` falhou) ou o alerta
 *         falhou — a unit sai `failed` e o
 *         `Diaria-Systemd-Failed-Units-Alarm` pega.
 *
 * ## Uso
 *
 *   npx tsx scripts/check-site-page-merge.ts                 # edição de hoje (BRT)
 *   npx tsx scripts/check-site-page-merge.ts --edition 261006
 *   npx tsx scripts/check-site-page-merge.ts --dry-run       # avalia e imprime, NÃO alerta
 *
 * ## Guard de publicação
 *
 * Só leitura (state file + `gh pr view`). Nunca mergeia nem fecha o PR —
 * mergear é ação do editor (ou do waiter), o check só avisa.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { editionDir, editionsRoot } from "./lib/edition-paths.ts";
import { BRT_TIMEZONE, datePartsInTz, toAammdd } from "./lib/next-edition-date.ts";
import { notifyEditor, type NotifyEditorFinding } from "./lib/editor-notify.ts";
import { logEvent } from "./lib/run-log.ts";
import { defaultGhRunner, parsePrNumberFromUrl, type GhRunner } from "./publish-edition-site-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[site-page-merge-check]";

export type SitePageMergeCheckVerdict =
  | { kind: "no-data-dir"; reason: string }
  | { kind: "no-state"; reason: string }
  | { kind: "unreadable-state"; reason: string }
  | { kind: "not-published"; reason: string }
  | { kind: "no-pr"; reason: string }
  | { kind: "ok"; prNumber: number; reason: string }
  | { kind: "cannot-verify"; prNumber: number; reason: string }
  | { kind: "alert"; prNumber: number; prState: string; slug?: string; prUrl?: string; mergeReason?: string };

/** AAMMDD de hoje em BRT — a edição que sai às 06:00 do dia em que o check roda. */
export function todayEditionBrt(now: Date = new Date()): string {
  return toAammdd(datePartsInTz(now, BRT_TIMEZONE));
}

/**
 * Pura (com `gh` injetado): decide o desfecho a partir do state file já lido
 * (`null` = ausente/ilegível). `state.merged === true` é confiado sem `gh` —
 * o script só grava `true` depois de confirmar o merge.
 */
export function evaluateSitePageMergeCheck(
  state: Record<string, unknown> | null,
  rootDir: string,
  gh: GhRunner,
): SitePageMergeCheckVerdict {
  if (!state) return { kind: "no-state", reason: "sem _internal/site-page-published.json — nada a checar" };
  if (state.published !== true) {
    return {
      kind: "not-published",
      reason: "página não publicada (published≠true) — fora do escopo deste check (invariant site-page-published, Stage 6)",
    };
  }
  const prUrl = typeof state.prUrl === "string" ? state.prUrl : undefined;
  const prNumber = parsePrNumberFromUrl(prUrl);
  if (prNumber === undefined) {
    return { kind: "no-pr", reason: "state file sem prUrl identificável — o mergeBlocker do gate 6 já cobre esse caso" };
  }
  if (state.merged === true) return { kind: "ok", prNumber, reason: `state file já registra merge do PR #${prNumber}` };
  let prState: string | undefined;
  try {
    const raw = gh(["pr", "view", String(prNumber), "--json", "state"], rootDir);
    prState = (JSON.parse(raw) as { state?: string }).state;
  } catch (e) {
    return { kind: "cannot-verify", prNumber, reason: `gh pr view ${prNumber} falhou (${(e as Error).message})` };
  }
  if (typeof prState !== "string" || prState === "") {
    return { kind: "cannot-verify", prNumber, reason: `gh pr view ${prNumber} não devolveu state` };
  }
  if (prState === "MERGED") {
    return { kind: "ok", prNumber, reason: `PR #${prNumber} MERGED (state file defasado — waiter morto depois do merge ou merge manual)` };
  }
  return {
    kind: "alert",
    prNumber,
    prState,
    slug: typeof state.slug === "string" ? state.slug : undefined,
    prUrl,
    mergeReason: typeof state.mergeReason === "string" ? state.mergeReason : undefined,
  };
}

/**
 * Achado do alerta (puro). Mesmo `check`/`fingerprint` de
 * `buildMergeWaiterAlertFinding` — uma issue por PR, venha o alerta do waiter
 * ou deste check.
 */
export function buildSitePageMergeCheckFinding(
  verdict: Extract<SitePageMergeCheckVerdict, { kind: "alert" }>,
  edition: string,
  editionDirAbs: string,
): NotifyEditorFinding {
  const slug = verdict.slug ?? "?";
  const prRef = verdict.prUrl ?? `PR #${verdict.prNumber}`;
  const body = [
    `O check pré-envio (05:15 BRT) encontrou o PR da página do site ainda NÃO mergeado.`,
    ``,
    `- Edição: ${edition}`,
    `- PR: ${prRef} (state: ${verdict.prState})`,
    `- Página: /p/${slug}`,
    `- Último registro no state file: ${verdict.mergeReason ?? "(sem mergeReason)"}`,
    `- Log do waiter: ${join(editionDirAbs, "_internal", "site-page-merge-waiter.log")}`,
    ``,
    `Provável causa quando o state ainda diz "merge delegado ao waiter": o waiter em background (#9593) morreu (reboot/kill) antes de terminar.`,
    ``,
    `Efeito: enquanto o PR não for mergeado, /p/${slug} (link de WhatsApp do e-mail) dá 404 no envio das 06:00.`,
    ``,
    `Ação: conferir o CI com \`gh pr view ${verdict.prNumber} --json state,statusCheckRollup\`, corrigir se vermelho/conflito e mergear com \`gh pr merge ${verdict.prNumber} --squash\`. Fechar esta issue depois do merge.`,
    ``,
    `Achado automático de \`scripts/check-site-page-merge.ts\` (task Diaria-Site-Page-Merge-Check, #9621).`,
  ].join("\n");
  return {
    check: "site-page-merge-waiter",
    fingerprint: `site-page-merge-waiter:pr-${verdict.prNumber}`,
    severity: "urgente",
    family: "evento",
    priority: "P1",
    subject: `Página do site: PR #${verdict.prNumber} não mergeado — /p/${slug} dá 404 no envio (${edition})`,
    body,
  };
}

/**
 * Lê o state file. #9760: "ausente" (`absent` → `no-state`, dia sem edição)
 * e "presente mas ilegível" (`unreadable` → exit 1) são desfechos DISTINTOS —
 * antes os dois viravam `null` e um arquivo vazio/truncado por reboot no meio
 * da escrita passava como dia sem edição, em silêncio, com `/p/{slug}` em 404.
 */
export type SitePageStateRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "ok"; state: Record<string, unknown> };

export function readSitePageState(editionDirAbs: string): SitePageStateRead {
  const path = join(editionDirAbs, "_internal", "site-page-published.json");
  if (!existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { kind: "unreadable", reason: `falha ao ler ${path} (${(e as Error).message})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "unreadable", reason: `${path} não é JSON válido (${raw.length} bytes; ${(e as Error).message})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", reason: `${path} não contém um objeto JSON` };
  }
  return { kind: "ok", state: parsed as Record<string, unknown> };
}

export interface RunSitePageMergeCheckDeps {
  gh?: GhRunner;
  notify?: (finding: NotifyEditorFinding) => Promise<unknown>;
  dryRun?: boolean;
  now?: Date;
}

/** Corpo do CLI, injetável. Devolve o exit code. */
export async function runSitePageMergeCheck(
  rootDir: string,
  edition: string | undefined,
  deps: RunSitePageMergeCheckDeps = {},
): Promise<{ exitCode: number; verdict: SitePageMergeCheckVerdict; edition: string }> {
  const ed = edition ?? todayEditionBrt(deps.now);
  const editionDirAbs = resolve(rootDir, editionDir(ed));
  const editionsRootAbs = resolve(rootDir, editionsRoot());
  if (!existsSync(editionsRootAbs)) {
    const verdict: SitePageMergeCheckVerdict = {
      kind: "no-data-dir",
      reason: `${editionsRootAbs} ausente — junction data/ não montada? Sem ela não dá pra distinguir "dia sem edição" de "state ilegível"`,
    };
    process.stderr.write(`${LOG_PREFIX} edição ${ed}: ${verdict.kind} — ${verdict.reason}\n`);
    return { exitCode: 1, verdict, edition: ed };
  }
  const read = readSitePageState(editionDirAbs);
  if (read.kind === "unreadable") {
    const verdict: SitePageMergeCheckVerdict = {
      kind: "unreadable-state",
      reason: `${read.reason} — state corrompido (escrita interrompida?), não dá pra saber se o PR da página foi mergeado; conferir à mão antes do envio das 06:00`,
    };
    process.stderr.write(`${LOG_PREFIX} edição ${ed}: ${verdict.kind} — ${verdict.reason}\n`);
    return { exitCode: 1, verdict, edition: ed };
  }
  const verdict = evaluateSitePageMergeCheck(read.kind === "ok" ? read.state : null, rootDir, deps.gh ?? defaultGhRunner);
  const reason = verdict.kind === "alert" ? `PR #${verdict.prNumber} em ${verdict.prState}` : verdict.reason;
  process.stderr.write(`${LOG_PREFIX} edição ${ed}: ${verdict.kind} — ${reason}\n`);
  if (verdict.kind === "cannot-verify") return { exitCode: 1, verdict, edition: ed };
  if (verdict.kind !== "alert") return { exitCode: 0, verdict, edition: ed };
  const finding = buildSitePageMergeCheckFinding(verdict, ed, editionDirAbs);
  if (deps.dryRun) {
    process.stderr.write(`${LOG_PREFIX} --dry-run: alerta NÃO enviado — ${finding.subject}\n`);
    return { exitCode: 0, verdict, edition: ed };
  }
  try {
    if (deps.notify) {
      await deps.notify(finding);
    } else {
      logEvent(
        {
          edition: ed,
          stage: 6,
          agent: "check-site-page-merge",
          level: "error",
          message: finding.subject,
          details: { pr: verdict.prNumber, prState: verdict.prState },
        },
        rootDir,
      );
      await notifyEditor(finding, { cwd: rootDir, rootDir });
    }
    return { exitCode: 0, verdict, edition: ed };
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} alerta falhou (${(e as Error).message})\n`);
    return { exitCode: 1, verdict, edition: ed };
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const edition = getArg(argv, "edition") || undefined;
  if (edition !== undefined && !/^\d{6}$/.test(edition)) {
    console.error(`--edition precisa ser AAMMDD (recebido: ${edition})`);
    process.exitCode = 1;
    return;
  }
  const r = await runSitePageMergeCheck(ROOT, edition, { dryRun: hasFlag(argv, "dry-run") });
  console.log(JSON.stringify({ edition: r.edition, verdict: r.verdict }, null, 2));
  process.exitCode = r.exitCode;
}

if (isMainModule(import.meta.url)) {
  await main();
}
