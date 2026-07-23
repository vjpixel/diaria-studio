/**
 * replay-stage-input.ts (#3833, item 2 do #3748 / EPIC #3379)
 *
 * Biblioteca de suporte ao script `scripts/replay-stage-input.ts` — ver o
 * cabeçalho daquele arquivo para o playbook completo de uso (como um
 * coordenador roda uma comparação A/B com isto).
 *
 * Escopo desta lib: preparar um FIXTURE de input congelado — copia os
 * `_internal/*.json` (+ companions) relevantes de uma EDIÇÃO DE REFERÊNCIA
 * real já publicada para um diretório de EDIÇÃO DE TESTE isolado, sob
 * `data/editions/replay-{label}/`. O prefixo `replay-` é estrutural (sempre
 * prepended por `buildReplayDirName`) — nenhum nome de diretório de teste
 * bate nos regexes `^\d{6}$` (flat) / `^\d{4}$` (nested top-level) que
 * `enumerateEditionDirs`/`findEditionsInProgress` (`scripts/lib/find-current-edition.ts`)
 * usam pra enumerar edições reais, então o diretório de teste NUNCA aparece
 * como edição "em curso" e nunca contamina `data/past-editions.md`/dedup real
 * — ver `test/replay-stage-input.test.ts` para a verificação direta contra
 * `find-current-edition.ts`.
 *
 * Reusa `resolveEditionDir` (não reimplementa a resolução dual flat/nested
 * da edição de REFERÊNCIA) e é composto com `edition-cost.ts` só por
 * convenção de path (`{testDir}/_internal/cost.json`) — cada rodada de
 * replay grava seu próprio `cost.json` via `record-agent-costs.ts`/
 * `writeCostArtifact` normalmente, sem nenhum código novo aqui.
 *
 * Funções puras (sem I/O): `slugifyLabel`, `buildReplayDirName`,
 * `isKnownStagePreset`, `resolveStagePreset`, `planFileList`,
 * `isSafeRelPath`, `buildFixtureManifest`. Wrappers de I/O (thin):
 * `copyReferenceFile`, `createReplayFixture` (orquestra tudo, escreve
 * `_internal/replay-manifest.json` no diretório de teste).
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { resolveEditionDir } from "./find-current-edition.ts";

/** Prefixo estrutural do diretório de teste — ver header do módulo. */
export const REPLAY_DIR_PREFIX = "replay-";

const AAMMDD_RE = /^\d{6}$/;

/**
 * Presets de arquivos por mecanismo medido (#3442/#3443/#3444). Paths
 * relativos ao diretório da edição de referência.
 *
 * - "1"        — pool bruto + categorizado/pontuado completo do Stage 1
 *                (#3442 — comparar mecanismo de pesquisa/paralelismo
 *                reproduzindo dedup/categorize/score sobre o MESMO pool).
 * - "1-scorer" — só o input imediato do scorer (#3444 — scorer-chunk K-way
 *                vs. scorer single-call sobre EXATAMENTE o mesmo pool,
 *                sem o resto do Stage 1 no caminho).
 * - "2"        — input real do Stage 2 escrita (#3443 — writer-destaque ×3
 *                vs. writer único). `01-categorized.md` é companion humano
 *                (não consumido por script, mas útil pro coordenador
 *                conferir visualmente o pool que originou o approved.json).
 */
export const STAGE_INPUT_FILES: Record<string, string[]> = {
  "1": [
    "_internal/researcher-results.json",
    "_internal/01-categorized.json",
    "_internal/tmp-dates-reviewed.json",
    "01-categorized.md",
  ],
  "1-scorer": ["_internal/tmp-dates-reviewed.json"],
  "2": ["_internal/01-approved.json", "01-categorized.md"],
};

export function isKnownStagePreset(stage: string): boolean {
  return Object.prototype.hasOwnProperty.call(STAGE_INPUT_FILES, stage);
}

/** Lança com mensagem explícita (presets válidos) se `stage` não for reconhecido. */
export function resolveStagePreset(stage: string): string[] {
  if (!isKnownStagePreset(stage)) {
    throw new Error(
      `replay-stage-input: preset de --stage desconhecido: "${stage}". ` +
        `Presets válidos: ${Object.keys(STAGE_INPUT_FILES).join(", ")} (ou use --files para uma lista explícita).`,
    );
  }
  return [...STAGE_INPUT_FILES[stage]];
}

/**
 * Decide a lista final de paths relativos a copiar: `--files` explícito
 * (CSV) sempre vence sobre `--stage` (uso avançado — mecanismo não coberto
 * pelos presets). Lança se nenhum dos dois foi passado.
 */
export function planFileList(stage: string | undefined, filesOverrideCsv: string | undefined): string[] {
  if (filesOverrideCsv && filesOverrideCsv.trim() !== "") {
    const list = filesOverrideCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) {
      throw new Error("replay-stage-input: --files foi passado mas ficou vazio após parse");
    }
    return list;
  }
  if (!stage) {
    throw new Error("replay-stage-input: precisa de --stage <preset> ou --files <lista-csv>");
  }
  return resolveStagePreset(stage);
}

/** Normaliza um label livre pra um slug seguro de nome de diretório (a-z0-9-, minúsculo). Lança se o slug resultante for vazio. */
export function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(`replay-stage-input: label produz slug vazio: "${label}"`);
  }
  return slug;
}

/**
 * Nome do diretório de teste — SEMPRE prefixado `replay-`. Sem `label`,
 * deriva um slug do timestamp (rodadas sem nome explícito ainda ficam
 * distinguíveis). O prefixo garante que o resultado nunca bate nos regexes
 * AAMMDD (`^\d{6}$`)/AAMM (`^\d{4}$`) usados por `find-current-edition.ts`
 * — mesmo se o `label` for puramente numérico (ex: label "260415" vira
 * "replay-260415", 13 chars, não 6).
 */
export function buildReplayDirName(label?: string, nowIso: string = new Date().toISOString()): string {
  const slug = label ? slugifyLabel(label) : nowIso.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return `${REPLAY_DIR_PREFIX}${slug}`;
}

export interface ReplayFixtureFileResult {
  relPath: string;
  copied: boolean;
  reason?: string;
  bytes?: number;
}

export interface ReplayFixtureManifest {
  schema_version: 1;
  kind: "replay-stage-input-fixture";
  reference_edition: string;
  /** Path do diretório de referência, relativo ao editions root passado (posix). */
  reference_dir: string;
  test_dir_name: string;
  stage_preset?: string;
  created_at: string;
  files: ReplayFixtureFileResult[];
  note: string;
}

export const REPLAY_FIXTURE_NOTE =
  "Diretório de FIXTURE de input congelado (#3833) — NÃO é uma edição real. " +
  "Nunca deve ser tratada como publicável, nunca contamina data/past-editions.md " +
  "nem o dedup real, e nunca aparece como edição 'em curso' para " +
  "find-current-edition.ts (o prefixo replay- não bate nos regexes AAMMDD/AAMM).";

/** Monta o objeto do manifest (puro — sem tocar disco). */
export function buildFixtureManifest(params: {
  referenceEdition: string;
  referenceDirRel: string;
  testDirName: string;
  stagePreset?: string;
  files: ReplayFixtureFileResult[];
  createdAtIso?: string;
}): ReplayFixtureManifest {
  return {
    schema_version: 1,
    kind: "replay-stage-input-fixture",
    reference_edition: params.referenceEdition,
    reference_dir: params.referenceDirRel,
    test_dir_name: params.testDirName,
    stage_preset: params.stagePreset,
    created_at: params.createdAtIso ?? new Date().toISOString(),
    files: params.files,
    note: REPLAY_FIXTURE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// I/O — thin wrappers.
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * Guard de path traversal (achado no self-review do #3833, #3922).
 * `--files` é o escape hatch documentado pra mecanismos não cobertos pelos
 * presets — sem este guard, um `relPath` como `../../../../algo` escaparia
 * tanto da leitura (`referenceDir`) quanto da escrita (`testDir`), quebrando
 * a garantia de isolamento do fixture. Rejeita paths absolutos e qualquer
 * path cujo primeiro segmento (posix ou Windows) seja `..`. Puro — não toca
 * disco, só string/regex.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (!relPath || isAbsolute(relPath)) return false;
  const segments = relPath.split(/[\\/]+/);
  return !segments.some((seg) => seg === "..");
}

/**
 * Copia 1 arquivo (`relPath`) da edição de referência para o diretório de
 * teste. Nunca lança — arquivo ausente na referência OU path inseguro
 * (`isSafeRelPath`) vira `copied: false` com `reason` (comportamento
 * esperado: nem toda edição tem todo arquivo, ex: `tmp-dates-reviewed.json`
 * não existe em edições que caíram no 1q-fallback).
 */
export function copyReferenceFile(
  referenceDir: string,
  testDir: string,
  relPath: string,
): ReplayFixtureFileResult {
  if (!isSafeRelPath(relPath)) {
    return { relPath: toPosix(relPath), copied: false, reason: "path inseguro (absoluto ou com '..') — recusado" };
  }
  const src = join(referenceDir, relPath);
  if (!existsSync(src)) {
    return { relPath: toPosix(relPath), copied: false, reason: "ausente na edição de referência" };
  }
  const dest = join(testDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return { relPath: toPosix(relPath), copied: true, bytes: statSync(dest).size };
}

export interface CreateReplayFixtureOptions {
  /** Diretório raiz das edições (ex: resolve(cwd(), "data/editions")). Parametrizado para testabilidade. */
  editionsRootDir: string;
  referenceAammdd: string;
  stage?: string;
  filesOverrideCsv?: string;
  label?: string;
  /** Sobrescreve um diretório de teste pré-existente em vez de lançar. */
  force?: boolean;
  nowIso?: string;
}

/**
 * Orquestra a criação do fixture: resolve a edição de referência (reusa
 * `resolveEditionDir` — mesma resolução dual flat/nested que o resto da
 * pipeline usa, nunca monta o path à mão), copia os arquivos planejados e
 * grava `_internal/replay-manifest.json` no diretório de teste. Lança se a
 * edição de referência não existir em disco, se `--reference-edition` não
 * for AAMMDD, ou se o diretório de teste já existir sem `force: true`.
 */
export function createReplayFixture(opts: CreateReplayFixtureOptions): ReplayFixtureManifest {
  if (!AAMMDD_RE.test(opts.referenceAammdd)) {
    throw new Error(
      `replay-stage-input: --reference-edition deve ser AAMMDD (6 dígitos): "${opts.referenceAammdd}"`,
    );
  }

  const referenceDir = resolveEditionDir(opts.editionsRootDir, opts.referenceAammdd);
  if (!existsSync(referenceDir)) {
    throw new Error(`replay-stage-input: edição de referência não encontrada em disco: ${referenceDir}`);
  }

  const files = planFileList(opts.stage, opts.filesOverrideCsv);
  const testDirName = buildReplayDirName(opts.label, opts.nowIso);
  const testDir = join(opts.editionsRootDir, testDirName);

  if (existsSync(testDir)) {
    if (!opts.force) {
      throw new Error(
        `replay-stage-input: diretório de teste já existe: ${testDir} (use force: true / --force para sobrescrever)`,
      );
    }
    rmSync(testDir, { recursive: true, force: true });
  }
  mkdirSync(join(testDir, "_internal"), { recursive: true });

  const fileResults = files.map((relPath) => copyReferenceFile(referenceDir, testDir, relPath));

  const manifest = buildFixtureManifest({
    referenceEdition: opts.referenceAammdd,
    referenceDirRel: toPosix(relative(opts.editionsRootDir, referenceDir)),
    testDirName,
    stagePreset: opts.stage,
    files: fileResults,
    createdAtIso: opts.nowIso,
  });

  writeFileSync(
    join(testDir, "_internal", "replay-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  return manifest;
}
