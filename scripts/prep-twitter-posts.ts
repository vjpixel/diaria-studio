/**
 * prep-twitter-posts.ts (#3994, substitui publish-twitter.ts/twitter-oauth1.ts)
 *
 * Publicação no X mudou de "API direta da X" (OAuth 1.0a, pay-per-usage desde
 * que o free tier acabou — ~$0.20/post com link) para "via Buffer" (MCP
 * `claude_ai_Buffer`, plano Free, $0 — Buffer absorve o custo do lado dela).
 * A API da Buffer só é alcançável de dentro de uma sessão de agente (MCP), não
 * de um script Node puro rodado via Bash — por isso a publicação em si não é
 * mais um script: o orchestrator (Stage 5, `orchestrator-stage-5.md`) chama
 * `mcp__claude_ai_Buffer__create_post` diretamente, um destaque por vez.
 *
 * Este script faz só a parte determinística de antes (extração de texto +
 * gate de config + skip-existing) e devolve ao orchestrator, em JSON, a lista
 * exata de destaques que precisam ser postados. Depois de cada `create_post`,
 * o orchestrator chama `append-twitter-published.ts` pra gravar o resultado.
 *
 * Fonte do texto (#3992): SÓ a seção `# Curto` de 03-social.md (texto único
 * compartilhado com Threads, ≤280 chars, escrito por `social-curto`).
 * **Sem fallback** — ausência da seção/destaque é tratada como "sem conteúdo
 * pronto pro X nesta edição", nunca improvisando texto (decisão da issue #3994).
 *
 * Uso:
 *   npx tsx scripts/prep-twitter-posts.ts \
 *     --edition-dir data/editions/260624/ \
 *     [--skip-existing]     # pula destaques já em 06-social-published.json (default: true)
 *     [--no-skip-existing]  # força re-inclusão
 *
 * Output (stdout, JSON): { enabled, published_path, posts: [{destaque, text}], skipped: [...] }
 * `posts` é a lista que o orchestrator deve efetivamente postar via Buffer MCP.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSocialPublished } from "./lib/social-published-store.ts";
import { parseDestaqueHeaders } from "./lint-social-md.ts";
import { extractSection } from "./lib/extract-section.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Limite de caracteres por tweet. */
export const TWITTER_CHAR_LIMIT = 280;

/**
 * Extrai a lista de destaques da seção `# Curto` do 03-social.md.
 * Sem fallback (#3994): se a seção não existe, retorna `[]`.
 */
export function extractDestaquesFromCurto(socialMd: string): string[] {
  const section = extractSection(socialMd, "Curto");
  if (section === null) return [];
  return parseDestaqueHeaders(section);
}

/**
 * Extrai o texto do post `# Curto` para um destaque específico.
 * Retorna `null` se a seção `# Curto` ou o destaque dentro dela não existir
 * — nunca lança nem cai pra outra seção (#3994: sem fallback).
 */
export function extractCurtoText(socialMd: string, destaque: string): string | null {
  const normalized = socialMd.replace(/\r\n/g, "\n");
  const section = extractSection(normalized, "Curto");
  if (section === null) return null;

  const dRe = new RegExp(
    `(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d+\\b|\\n# |$)`,
    "i",
  );
  const dMatch = section.match(dRe);
  if (!dMatch) return null;
  return dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
}

export interface PrepResult {
  enabled: boolean;
  published_path: string | null;
  posts: Array<{ destaque: string; text: string }>;
  skipped: Array<{ destaque: string; reason: string }>;
}

export function prepTwitterPosts(
  editionDir: string,
  opts: { skipExisting: boolean } = { skipExisting: true },
): PrepResult {
  const gateConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const twitterGateConfig = gateConfig?.publishing?.social?.twitter;
  if (twitterGateConfig?.enabled === false) {
    return { enabled: false, published_path: null, posts: [], skipped: [] };
  }

  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    throw new Error("03-social.md não encontrado. Rode Stage 2 primeiro.");
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  let publishedPath: string;
  if (existsSync(internalPath)) {
    publishedPath = internalPath;
  } else if (existsSync(rootPath)) {
    publishedPath = rootPath;
  } else {
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    publishedPath = internalPath;
  }

  const destaques = extractDestaquesFromCurto(socialMd);
  const posts: PrepResult["posts"] = [];
  const skipped: PrepResult["skipped"] = [];

  if (destaques.length === 0) {
    return { enabled: true, published_path: publishedPath, posts, skipped };
  }

  const published = readSocialPublished(publishedPath);

  for (const d of destaques) {
    if (opts.skipExisting) {
      const existing = published.posts.find(
        (p) =>
          p.platform === "twitter" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        skipped.push({ destaque: d, reason: `already ${existing.status}` });
        continue;
      }
    }

    const text = extractCurtoText(socialMd, d);
    if (!text) {
      skipped.push({ destaque: d, reason: "destaque ausente na seção '# Curto'" });
      continue;
    }

    if (text.length > TWITTER_CHAR_LIMIT) {
      skipped.push({
        destaque: d,
        reason: `texto de ${text.length} chars excede ${TWITTER_CHAR_LIMIT} — sem truncagem silenciosa`,
      });
      continue;
    }

    posts.push({ destaque: d, text });
  }

  return { enabled: true, published_path: publishedPath, posts, skipped };
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("ERRO: --edition-dir é obrigatório.");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const noSkipExisting = process.argv.includes("--no-skip-existing");

  try {
    const result = prepTwitterPosts(editionDir, { skipExisting: !noSkipExisting });
    console.log(JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
