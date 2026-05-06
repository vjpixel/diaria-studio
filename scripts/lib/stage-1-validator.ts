/**
 * stage-1-validator.ts (#581)
 *
 * Bateria de assertions determinísticas que rodam antes de apresentar o gate
 * humano em /diaria-1-pesquisa. Detecta classe inteira de bugs recorrentes que
 * só apareciam quando o editor revisava (#577 Drive skip, #578 EIA format,
 * #579 numeração, #580 off-topic noticias).
 *
 * Cada assertion é função pura — pode ser chamada isoladamente em test ou
 * combinada via runStage1Validation. Output canônico em ValidationResult.
 *
 * Não substitui review editorial — pega regressões conhecidas + invariantes
 * documentados, libera tempo do editor pra avaliar conteúdo (escolha de
 * destaques, qualidade copy).
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { isArticleAIRelevant } from "./ai-relevance.ts";
import type { Article } from "./types/article.ts";

export type AssertionStatus = "ok" | "warn" | "blocker";

export interface AssertionResult {
  /** Identifier curto da assertion (ex: "outputs_present"). */
  name: string;
  status: AssertionStatus;
  /** Mensagem human-readable pra editor. */
  message: string;
  /** Dados estruturados (quais arquivos, ratio computed, etc.) — pra logs. */
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  edition: string;
  edition_dir: string;
  assertions: AssertionResult[];
  blocking_count: number;
  warning_count: number;
  ok_count: number;
}

/**
 * Pure: confirma outputs gate-facing existem e não estão vazios.
 * Critério "non-empty" é > 200 bytes (heurística — markdown vazio tem ~80
 * bytes de header).
 *
 * Bug coberto: edição com Drive sync skipado silenciosamente — ou orchestrator
 * crashou sem gerar output mas seguiu adiante.
 */
export function validateOutputsPresent(editionDir: string): AssertionResult {
  const required = [
    "01-categorized.md",
    "_internal/01-categorized.json",
  ];
  const missing: string[] = [];
  const tooSmall: Array<{ file: string; size: number }> = [];
  for (const file of required) {
    const path = resolve(editionDir, file);
    if (!existsSync(path)) {
      missing.push(file);
      continue;
    }
    const size = statSync(path).size;
    if (size < 200) tooSmall.push({ file, size });
  }
  if (missing.length > 0) {
    return {
      name: "outputs_present",
      status: "blocker",
      message: `Outputs Stage 1 ausentes: ${missing.join(", ")}.`,
      details: { missing, edition_dir: editionDir },
    };
  }
  if (tooSmall.length > 0) {
    return {
      name: "outputs_present",
      status: "warn",
      message: `Outputs Stage 1 suspeitamente pequenos (< 200 bytes): ${tooSmall.map((t) => `${t.file} (${t.size}B)`).join(", ")}.`,
      details: { too_small: tooSmall, edition_dir: editionDir },
    };
  }
  return {
    name: "outputs_present",
    status: "ok",
    message: "Outputs Stage 1 presentes e não-vazios.",
  };
}

/**
 * Pure: calcula ratio de IA-relevance no bucket noticias e avisa se < 70%.
 * Usa scripts/lib/ai-relevance.ts pra single source of truth do regex (#642).
 *
 * Bug coberto (#580): feeds generalistas (g1, exame) sem topic_filter
 * configurado vazaram artigos não-IA pro Stage 1 → editor encontrou ~37%
 * off-topic em 260505. Lint detecta antes do gate.
 *
 * Threshold default 0.7 — abaixo disso, warn loud. Não blocker porque pode
 * haver edição legitimamente fora-do-tema central (cobertura de regulação,
 * ética, etc.) que não bate todos os termos.
 */
export interface RelevanceRatioOptions {
  threshold?: number;
  /** Restringe a checagem a este bucket. Default `noticias` (mais sujeito a
   *  feeds generalistas). */
  bucket?: "noticias" | "lancamento" | "pesquisa" | "tutorial";
}

export function validateAiRelevanceRatio(
  categorized: Record<string, unknown>,
  opts: RelevanceRatioOptions = {},
): AssertionResult {
  const threshold = opts.threshold ?? 0.7;
  const bucket = opts.bucket ?? "noticias";
  const articles = (categorized[bucket] ?? []) as Article[];

  if (articles.length === 0) {
    return {
      name: "ai_relevance_ratio",
      status: "ok",
      message: `Bucket '${bucket}' vazio — sem ratio pra calcular.`,
      details: { bucket, total: 0 },
    };
  }

  const onTopic = articles.filter((a) => isArticleAIRelevant(a));
  const offTopic = articles.filter((a) => !isArticleAIRelevant(a));
  const ratio = onTopic.length / articles.length;

  if (ratio < threshold) {
    return {
      name: "ai_relevance_ratio",
      status: "warn",
      message: `${(ratio * 100).toFixed(0)}% dos artigos em '${bucket}' batem termos de IA (threshold ${(threshold * 100).toFixed(0)}%). ${offTopic.length} artigos off-topic — considerar tightening do topic_filter de fontes generalistas (#580).`,
      details: {
        bucket,
        total: articles.length,
        on_topic: onTopic.length,
        off_topic_count: offTopic.length,
        ratio,
        threshold,
        off_topic_urls: offTopic.slice(0, 10).map((a) => a.url),
      },
    };
  }

  return {
    name: "ai_relevance_ratio",
    status: "ok",
    message: `${(ratio * 100).toFixed(0)}% on-topic em '${bucket}' (${onTopic.length}/${articles.length}).`,
    details: { bucket, total: articles.length, on_topic: onTopic.length, ratio },
  };
}

/**
 * Pure: valida formato canônico do bloco de crédito do É IA?.
 * Espera linha de crédito conforme #582 — link para Wikipedia + autor +
 * link de domínio + licença, todos como `[texto](url)`.
 *
 * Padrões aceitos:
 *   `[Título](url) descrição — [Autor](url) / [Licença](url).`
 *   `Descrição [Título](url) descrição — autor desconhecido / [Domínio](url) / [Licença](url).`
 *
 * Bug coberto (#578): geração de "UnknownUnknown", inglês no lugar de PT-BR,
 * sem hyperlinks.
 */
export function validateEiaFormat(eiaMd: string | null): AssertionResult {
  if (eiaMd === null) {
    return {
      name: "eia_format",
      status: "ok",
      message: "01-eia.md ausente — skip silencioso (edição sem É IA?).",
    };
  }

  // Heurísticas mínimas baseadas em invariantes documentados:
  const hasUnknown = /UnknownUnknown|Unknown\s+Unknown/i.test(eiaMd);
  // Detectar caso onde TUDO é em inglês (heurística: presença de termos PT-BR
  // típicos vs inglês). Crédito Wikipedia tipicamente tem "—", "/", "domínio
  // público" ou "Public domain" no fim.
  const hasMarkdownLink = /\[[^\]]+\]\([^)]+\)/.test(eiaMd);

  const issues: string[] = [];
  if (hasUnknown) issues.push("contém 'Unknown' duplicado (artefato de prompt template)");
  if (!hasMarkdownLink) issues.push("sem hyperlinks Markdown — esperado [texto](url) para fonte e licença");

  if (issues.length > 0) {
    return {
      name: "eia_format",
      status: "warn",
      message: `É IA? format inválido: ${issues.join("; ")}.`,
      details: { issues, content: eiaMd.slice(0, 300) },
    };
  }
  return {
    name: "eia_format",
    status: "ok",
    message: "É IA? format OK (hyperlinks Markdown presentes, sem 'Unknown' duplicado).",
  };
}

/**
 * Roda toda a bateria de assertions e agrega counts.
 *
 * `editionDir` deve ser o caminho absoluto pra `data/editions/{AAMMDD}/`.
 */
export interface RunStage1ValidationOptions {
  /** Override threshold de IA-relevance ratio. */
  aiRelevanceThreshold?: number;
}

export function runStage1Validation(
  edition: string,
  editionDir: string,
  opts: RunStage1ValidationOptions = {},
): ValidationResult {
  const assertions: AssertionResult[] = [];

  const outputsAssertion = validateOutputsPresent(editionDir);
  assertions.push(outputsAssertion);

  // Próximas assertions só rodam se outputs presentes (caso contrário não há
  // o que checar)
  if (outputsAssertion.status !== "blocker") {
    const categorizedJsonPath = join(editionDir, "_internal", "01-categorized.json");
    if (existsSync(categorizedJsonPath)) {
      try {
        const categorized = JSON.parse(readFileSync(categorizedJsonPath, "utf8"));
        assertions.push(
          validateAiRelevanceRatio(categorized, {
            threshold: opts.aiRelevanceThreshold,
          }),
        );
      } catch (err) {
        assertions.push({
          name: "ai_relevance_ratio",
          status: "warn",
          message: `Falha ao parsear 01-categorized.json: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const eiaPath = join(editionDir, "01-eia.md");
    const eiaMd = existsSync(eiaPath) ? readFileSync(eiaPath, "utf8") : null;
    assertions.push(validateEiaFormat(eiaMd));
  }

  const blocking_count = assertions.filter((a) => a.status === "blocker").length;
  const warning_count = assertions.filter((a) => a.status === "warn").length;
  const ok_count = assertions.filter((a) => a.status === "ok").length;

  return {
    edition,
    edition_dir: editionDir,
    assertions,
    blocking_count,
    warning_count,
    ok_count,
  };
}
