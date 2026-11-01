/**
 * stage5-freshness.ts (#11698) — o conteúdo da edição neste host é o que o
 * gate 4 aprovou? Somente leitura, fail-closed.
 *
 * `data/` sincroniza por OneDrive entre máquinas e o sentinel do Stage 4
 * (`.step-4-done.json`) pode chegar a outro host antes da versão nova de
 * `02-reviewed.md`/`03-social.md`. Esses arquivos existem em todo host desde
 * a Etapa 2, então presença e mtime não distinguem a versão aprovada de uma
 * cópia pré-gate (review da PR #11700). O sentinel grava `output_hashes`
 * (sha256 de cada output, `scripts/lib/pipeline-state.ts`) e aqui o conteúdo
 * local é comparado com ele.
 *
 * `03-social.md`: o próprio Stage 5 (§5c-2, `resolve-edition-url.ts
 * --validate-social`) troca `{edition_url}` pela URL resolvida depois do
 * sentinel. Na retomada, TODA ocorrência da URL EXATA gravada em
 * `_internal/05-edition-url.txt` volta ao placeholder antes de comparar. Sem
 * regex de domínio: outro link próprio não é revertido. Consequência aceita:
 * se a mesma URL já estava colada literalmente antes do gate (ou é prefixo de
 * outro link próprio no texto), a reversão a transforma também e o resultado
 * acusa divergência — falha fechada, saída `--force` com o editor.
 * Com troca de URL do Stage 6 interrompida (#11751), a URL de destino do
 * marcador `_internal/05-edition-url.transition.json` também é candidata
 * (`edition-url-transition.ts`).
 *
 * Sentinel sem `output_hashes`: gravado antes de `OUTPUT_HASHES_REQUIRED_SINCE`
 * é legado (aviso, `verification: "unverified_legacy"`); gravado depois é
 * código defasado em algum host e bloqueia (`no_hash`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./pipeline-state.ts";
import { readEditionUrlTransition } from "./edition-url-transition.ts";

/** Sempre conferidos, mesmo com `outputs` do sentinel vazio ou inválido. */
export const STAGE5_ALWAYS_WATCHED = ["02-reviewed.md", "03-social.md"] as const;

/**
 * A partir daqui todo sentinel do Stage 4 tem que trazer `output_hashes`
 * (merge do #11698). Sentinel mais novo sem hash = gravado por código
 * defasado em outro host: não é legado, é problema.
 */
export const OUTPUT_HASHES_REQUIRED_SINCE = "2026-11-02T00:00:00Z";

export type Stage5ProblemKind =
  | "sentinel_missing"
  | "sentinel_unreadable"
  | "sentinel_malformed"
  | "absent"
  | "empty"
  | "no_hash"
  | "diverged"
  | "edition_url_invalid";

export interface Stage5Problem {
  /** Caminho relativo à edição, quando o problema é de um arquivo. */
  file?: string;
  kind: Stage5ProblemKind;
  message: string;
}

export interface Stage5FreshnessResult {
  ok: boolean;
  /** `verified` = conteúdo conferido por hash; `unverified_legacy` = sentinel anterior ao corte, sem hash. */
  verification: "verified" | "unverified_legacy";
  /** Cada item bloqueia. */
  problems: Stage5Problem[];
  /** Não bloqueiam (sentinel legado sem hashes). */
  warnings: string[];
}

/** Arquivo que o §5c-2 reescreve com a URL resolvida. */
const URL_REWRITTEN = "03-social.md";

/** O que fazer em cada tipo de problema (halt banner do Stage 5). */
export const STAGE5_PROBLEM_ACTIONS: Record<Stage5ProblemKind, string> = {
  sentinel_missing: "sync em trânsito: aguardar o OneDrive e re-rodar a Etapa 5",
  sentinel_unreadable: "sync em trânsito: aguardar o OneDrive e re-rodar a Etapa 5",
  sentinel_malformed: "sentinel do Stage 4 inválido: re-rodar a Etapa 4 (regrava o sentinel)",
  absent: "sync em trânsito: aguardar o OneDrive e re-rodar a Etapa 5",
  empty: "sync em trânsito: aguardar o OneDrive e re-rodar a Etapa 5",
  no_hash:
    "sentinel do Stage 4 sem hash (código defasado no host que aprovou): atualizar o código lá e re-rodar a Etapa 4 para regravar o sentinel",
  diverged:
    "conteúdo diferente do aprovado: aguardar o sync; se o editor ajustou depois do gate de propósito, ele confirma --force, ou re-rodar a Etapa 4",
  edition_url_invalid:
    "_internal/05-edition-url.txt inválido: conferir/regravar com resolve-edition-url.ts e re-rodar",
};

function readEditionUrl(editionDir: string): { url: string | null; problem?: Stage5Problem } {
  const rel = "_internal/05-edition-url.txt";
  const p = join(editionDir, rel);
  if (!existsSync(p)) return { url: null };
  const url = readFileSync(p, "utf8").trim();
  if (!/^https:\/\/\S+$/.test(url)) {
    return {
      url: null,
      problem: { file: rel, kind: "edition_url_invalid", message: `${rel}: presente mas não é uma URL https válida` },
    };
  }
  return { url };
}

/**
 * O conteúdo local bate com o hash aprovado? Em `03-social.md`, aceita também
 * a versão com a URL resolvida pelo Stage 5 revertida ao placeholder.
 *
 * `editionUrls` são as candidatas à reversão, cada uma tentada sozinha: a de
 * `_internal/05-edition-url.txt` e, com troca de URL em curso (#11751,
 * `edition-url-transition.ts`), a de destino do marcador.
 */
export function matchesApprovedHash(
  rel: string,
  content: Buffer,
  expected: string,
  editionUrls: readonly string[],
): boolean {
  if (sha256Hex(content) === expected) return true;
  if (rel !== URL_REWRITTEN) return false;
  const text = content.toString("utf8");
  return editionUrls.some((url) => url.length > 0 && sha256Hex(text.replaceAll(url, "{edition_url}")) === expected);
}

export function checkStage5Freshness(editionDir: string): Stage5FreshnessResult {
  const problems: Stage5Problem[] = [];
  const warnings: string[] = [];
  const fail = (p: Stage5Problem): Stage5FreshnessResult => ({ ok: false, verification: "verified", problems: [p], warnings });
  const sentinelRel = "_internal/.step-4-done.json";
  const sentinelPath = join(editionDir, sentinelRel);
  if (!existsSync(sentinelPath)) {
    return fail({ file: sentinelRel, kind: "sentinel_missing", message: "sentinel do Stage 4 ausente (ainda sincronizando?)" });
  }
  let sentinel: { outputs?: unknown; output_hashes?: unknown; completed_at?: unknown };
  try {
    sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
    if (!sentinel || typeof sentinel !== "object") throw new Error("não é objeto");
  } catch {
    return fail({ file: sentinelRel, kind: "sentinel_unreadable", message: "sentinel do Stage 4 ilegível (sync em trânsito?)" });
  }

  const outputs: string[] = [];
  if (Array.isArray(sentinel.outputs) && sentinel.outputs.every((x) => typeof x === "string")) {
    outputs.push(...(sentinel.outputs as string[]));
  } else {
    problems.push({ file: sentinelRel, kind: "sentinel_malformed", message: "sentinel do Stage 4 com `outputs` inválido" });
  }

  let verification: Stage5FreshnessResult["verification"] = "verified";
  const rawHashes = sentinel.output_hashes;
  // Sem hash: só é legado se o sentinel for comprovadamente anterior ao corte.
  let checkHashes = true;
  let hashes: Record<string, unknown> = {};
  if (rawHashes === undefined) {
    const completed = typeof sentinel.completed_at === "string" ? Date.parse(sentinel.completed_at) : Number.NaN;
    if (Number.isFinite(completed) && completed < Date.parse(OUTPUT_HASHES_REQUIRED_SINCE)) {
      checkHashes = false;
      verification = "unverified_legacy";
      warnings.push(
        "sentinel do Stage 4 sem output_hashes (gravado antes do #11698): o conteúdo de 02-reviewed.md/03-social.md não pôde ser conferido contra o aprovado",
      );
    }
    // Depois do corte (ou completed_at ilegível): hashes = {} → cada arquivo vira `no_hash`.
  } else if (rawHashes && typeof rawHashes === "object" && !Array.isArray(rawHashes)) {
    hashes = rawHashes as Record<string, unknown>;
  } else {
    problems.push({ file: sentinelRel, kind: "sentinel_malformed", message: "sentinel do Stage 4 com `output_hashes` inválido" });
  }

  const { url: editionUrl, problem: urlProblem } = readEditionUrl(editionDir);
  if (urlProblem) problems.push(urlProblem);
  // #11751: queda no meio da troca de URL do Stage 6 deixa `03-social.md` com
  // a URL de destino e `05-edition-url.txt` com a anterior; o marcador diz qual.
  const transition = readEditionUrlTransition(editionDir);
  const editionUrls = [...new Set([editionUrl, transition?.to].filter((u): u is string => !!u))];

  const watched = [...new Set<string>([...STAGE5_ALWAYS_WATCHED, ...outputs])];
  for (const rel of watched) {
    const p = join(editionDir, rel);
    if (!existsSync(p)) {
      problems.push({ file: rel, kind: "absent", message: `${rel}: ausente` });
      continue;
    }
    const content = readFileSync(p);
    if (content.length === 0) {
      problems.push({ file: rel, kind: "empty", message: `${rel}: vazio` });
      continue;
    }
    if (!checkHashes) continue;
    const expected = hashes[rel];
    if (typeof expected !== "string") {
      problems.push({
        file: rel,
        kind: "no_hash",
        message: `${rel}: sem hash no sentinel do Stage 4 (gravado por código anterior ao #11698 depois do corte?)`,
      });
      continue;
    }
    if (!matchesApprovedHash(rel, content, expected, editionUrls)) {
      problems.push({
        file: rel,
        kind: "diverged",
        message: `${rel}: conteúdo difere do aprovado no gate 4 (sha256): versão anterior ainda sincronizando, ou editado depois do gate`,
      });
    }
  }
  return { ok: problems.length === 0, verification, problems, warnings };
}
