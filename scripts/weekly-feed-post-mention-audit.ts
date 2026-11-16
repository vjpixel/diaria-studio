#!/usr/bin/env node
/**
 * scripts/weekly-feed-post-mention-audit.ts (#13261)
 *
 * Confere a menção "@diar.ia.br" do post de feed do artigo semanal do
 * LinkedIn (`/diaria-linkedin-semanal`, Passo 9). Lógica e motivo em
 * `scripts/lib/linkedin-feed-mention-audit.ts`.
 *
 * Fluxo: a sessão roda `--snippet`, executa o JavaScript impresso pelo
 * `javascript_tool` do Claude in Chrome com o diálogo de publicação aberto
 * (texto do post colado e menção escolhida pelo editor, antes de agendar),
 * grava o JSON devolvido num arquivo e roda `--dom-json` sobre ele. O texto
 * revisado vem de `data/weekly/{cycle}/_internal/ln-feed-post.txt` (o mesmo
 * do `weekly-feed-post-review.ts --check`); o nome e o URN da página, de
 * `publishing.shorts.diaria_profiles.linkedin` no `platform.config.json`.
 * O resultado fica em `_internal/ln-feed-post-mention.json`.
 *
 * Uso:
 *   npx tsx scripts/weekly-feed-post-mention-audit.ts --snippet
 *   npx tsx scripts/weekly-feed-post-mention-audit.ts --cycle 26w47 --dom-json /tmp/x/dom-13261.json
 *
 * Exit: 0 menção confirmada (ou o texto não pede menção) · 1 argumento ou
 * arquivo inválido · 2 menção não confirmada (mensagem no stderr diz o que o
 * editor tem de fazer).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { feedPostPath } from "./lib/weekly-feed-post-review.ts";
import { loadDiariaProfiles } from "./lib/diaria/short-video.ts";
import {
  auditFeedPostMention,
  FEED_MENTION_DOM_SNIPPET,
  type FeedMentionAudit,
  type FeedMentionDom,
  type FeedMentionTarget,
} from "./lib/linkedin-feed-mention-audit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[weekly-feed-post-mention-audit]";

/** Resultado gravado ao lado do texto do post. */
export const FEED_POST_MENTION_REL = "_internal/ln-feed-post-mention.json";

export class MentionAuditInputError extends Error {}

/** Lê o JSON do snippet. Aceita a string JSON que o `javascript_tool` devolve (JSON dentro de JSON). */
export function parseDomJson(raw: string): FeedMentionDom {
  let v: unknown;
  try {
    v = JSON.parse(raw);
    if (typeof v === "string") v = JSON.parse(v);
  } catch (e) {
    throw new MentionAuditInputError(`--dom-json não é JSON válido: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new MentionAuditInputError("--dom-json precisa ser um objeto.");
  const o = v as Record<string, unknown>;
  if (typeof o.error === "string") throw new MentionAuditInputError(`o snippet não achou o campo: ${o.error}`);
  if (typeof o.text !== "string") throw new MentionAuditInputError("--dom-json sem o campo `text` (string).");
  return {
    text: o.text,
    anchors: Array.isArray(o.anchors) ? (o.anchors as FeedMentionDom["anchors"]) : [],
    mentions: Array.isArray(o.mentions) ? (o.mentions as FeedMentionDom["mentions"]) : [],
  };
}

export function loadMentionTarget(configPath: string): FeedMentionTarget {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { publishing?: { shorts?: { diaria_profiles?: unknown } } };
  const li = loadDiariaProfiles(config.publishing?.shorts?.diaria_profiles).linkedin;
  return { name: li.name, urn: li.urn };
}

export function runMentionAudit(opts: {
  cycleDir: string;
  domJsonPath: string;
  target: FeedMentionTarget;
  now: Date;
}): FeedMentionAudit {
  const textPath = feedPostPath(opts.cycleDir);
  if (!existsSync(textPath)) throw new MentionAuditInputError(`${textPath} ausente: rode o Passo 8d antes.`);
  if (!existsSync(opts.domJsonPath)) throw new MentionAuditInputError(`--dom-json ${opts.domJsonPath} não existe.`);
  const dom = parseDomJson(readFileSync(opts.domJsonPath, "utf8"));
  const audit = auditFeedPostMention({ sourceText: readFileSync(textPath, "utf8"), dom, target: opts.target });
  writeFileAtomic(
    resolve(opts.cycleDir, FEED_POST_MENTION_REL),
    JSON.stringify({ em: opts.now.toISOString(), ...audit }, null, 2) + "\n",
  );
  return audit;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "snippet")) {
    process.stdout.write(`${FEED_MENTION_DOM_SNIPPET}\n`);
    return;
  }
  let cycle: string | undefined;
  let domJson: string | undefined;
  try {
    cycle = getStringArg(argv, "cycle", { example: "26w47" });
    domJson = getStringArg(argv, "dom-json");
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(1);
  }
  if (!cycle || !isValidWeeklyCycle(cycle) || !domJson) {
    process.stderr.write(
      "Uso: npx tsx scripts/weekly-feed-post-mention-audit.ts (--snippet | --cycle {YY}w{WW} --dom-json ARQUIVO)\n",
    );
    process.exit(1);
  }
  try {
    const audit = runMentionAudit({
      cycleDir: resolve(ROOT, weeklyLinkedinRelDir(cycle)),
      domJsonPath: resolve(domJson),
      target: loadMentionTarget(resolve(ROOT, "platform.config.json")),
      now: new Date(),
    });
    process.stderr.write(`${LOG_PREFIX} ${audit.status}: ${audit.message}\n`);
    process.exit(audit.ok ? 0 : 2);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
