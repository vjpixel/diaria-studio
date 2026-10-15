#!/usr/bin/env tsx
/**
 * scripts/replant-intentional-error.ts (#10176, #10213)
 *
 * Stage 4: replanta o erro intencional quando o item que o carregava saiu do
 * `02-reviewed.md` no gate (poda, movimento, retirada pelo editor — edição
 * 261014). Antes isso era à mão em 3 lugares (`_internal/intentional-error.json`,
 * `data/intentional-errors.jsonl`, narrativa "Nessa edição, …" no MD) e
 * `propose-intentional-error-candidate.ts` podia devolver `candidate: null`.
 *
 * Fluxo: propõe o próximo candidato plantável do MD ATUAL (mesmo catálogo e
 * filtro de repetição do #9101 — a entry antiga desta edição não conta como
 * histórico) → troca a menção no MD → reescreve a linha "Nessa edição, …" →
 * valida `intentional-error-present-in-final` e `intentional-error-not-recent-repeat`
 * → grava MD + JSON + JSONL num lote verificado (`writeFilesVerified`, #9173).
 *
 * Garantias (#10213):
 *   - A validação roda sobre uma CÓPIA em diretório temporário do SO (fora de
 *     `data/`), nunca sobre os arquivos reais: `--dry-run` não toca em nada e
 *     um processo morto no meio não deixa estado intermediário pro OneDrive
 *     sincronizar.
 *   - Antes de gravar, relê `02-reviewed.md`; se mudou desde a leitura (save do
 *     editor pelo Studio na janela), aborta sem gravar (#495/#7401).
 *   - O JSONL é reescrito a partir do TEXTO CRU — só as linhas desta edição são
 *     trocadas; linhas corrompidas/sem `edition` são preservadas. JSONL que
 *     existe mas não pode ser lido aborta (nunca reescreve a partir de `[]`).
 *   - Se o `wrong_value` do erro ANTIGO ainda aparece no MD (item só movido),
 *     recusa: replantar deixaria a edição com dois erros e só um declarado.
 *     Ocorrência só FORA da seção declarada em `location` (#10234) também
 *     recusa (`old_error_maybe_moved` — mover RADAR → LANÇAMENTOS/USE MELHOR
 *     ou promover a destaque é rotina do editor), salvo quando o baseline
 *     pós-Stage 2 confiável mostra que a contagem de ocorrências CAIU (o item
 *     com o erro saiu; o que sobrou é menção legítima de outro item) ou com
 *     `--allow-elsewhere` explícito.
 *
 * Uso: npx tsx scripts/replant-intentional-error.ts --edition-dir data/editions/AAMMDD/ [--jsonl path] [--dry-run] [--allow-elsewhere]
 * Stdout: JSON `{ action: "replanted"|"no_candidate"|"invalid"|"old_error_still_present"|"old_error_maybe_moved"|"md_changed"|..., ... }`.
 * Exit: 0 = replantado (ou dry-run ok); 1 = sem candidato / validação falhou / recusa; 2 = uso inválido.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listIntentionalErrorCandidates } from "./lib/propose-intentional-error-candidate.ts";
import {
  frontmatterToEntry,
  intentionalErrorJsonPath,
  loadIntentionalErrorJson,
  readIntentionalErrorsJsonlStrict,
  replaceEditionInJsonlRaw,
} from "./lib/intentional-errors.ts";
import { intentionalErrorsJsonlPathForEditionDir } from "./lib/intentional-error-repeat.ts";
import { buildCurrentNarrative, plantIntentionalError } from "./lib/plant-intentional-error.ts";
import { checkIntentionalErrorNotRecentRepeat } from "./lib/intentional-error-repeat.ts";
import { checkIntentionalErrorPresentInFinal } from "./lib/invariant-checks/stage-4.ts";
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts";
import { assessStage2BaselineOnDisk, readSnapshots, STAGE2_BASELINE_LABEL } from "./lib/editor-request-snapshots.ts";
import type { IntentionalError, IntentionalErrorJson } from "./lib/intentional-errors.ts";

/** Linha da declaração corrente ("Nessa edição, …" — frase única até o 1º ponto final da linha). */
const CURRENT_NARRATIVE_LINE_RE = /^Nessa edição,.*$/m;

/** Seções nomeadas reconhecidas em `location` e nos headers do MD (#10234). */
const NAMED_SECTIONS: ReadonlyArray<{ key: string; re: RegExp }> = [
  { key: "LANÇAMENTOS", re: /LAN[ÇC]AMENTOS?/iu },
  { key: "RADAR", re: /RADAR|OUTRAS?\s+NOT[ÍI]CIAS?/iu },
  { key: "USE MELHOR", re: /USE\s+MELHOR/iu },
  { key: "VÍDEOS", re: /V[ÍI]DEOS?/iu },
];

/**
 * (#10234) Seção declarada no texto livre de `location`/`description`
 * ("DESTAQUE 2, parágrafo 3", "RADAR (menção a …)", "D3"). `null` quando não
 * dá pra resolver uma única seção — aí o chamador cai no comportamento
 * conservador (texto inteiro).
 */
export function sectionKeyFromLocation(text: string | undefined): string | null {
  if (!text) return null;
  const keys = new Set<string>();
  for (const m of text.matchAll(/\bDESTAQUE\s*(\d)\b|\bD([1-9])\b/giu)) keys.add(`DESTAQUE ${m[1] ?? m[2]}`);
  for (const { key, re } of NAMED_SECTIONS) if (re.test(text)) keys.add(key);
  return keys.size === 1 ? [...keys][0] : null;
}

/** Chave de seção de uma linha de header do MD, ou `null` se a linha não é header. */
function headerKey(line: string): string | null {
  const stripped = line
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  const d = /^DESTAQUE\s+(\d)\b/iu.exec(stripped);
  if (d) return `DESTAQUE ${d[1]}`;
  for (const { key, re } of NAMED_SECTIONS) if (new RegExp(`^(?:${re.source})$`, "iu").test(stripped)) return key;
  // Outros headers em caixa alta (ERRO INTENCIONAL, É IA?, SORTEIO…) só encerram a seção anterior.
  const isBoldOrHeading = /^\s*(?:\*\*[^*]+\*\*|#+\s+\S.*)\s*$/u.test(line);
  if (isBoldOrHeading && /\p{Lu}/u.test(stripped) && !/\p{Ll}/u.test(stripped)) return `OUTRA:${stripped}`;
  return null;
}

/** Texto de cada seção do MD, por chave (seção repetida concatena). */
function sectionTexts(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "";
  for (const line of md.split("\n")) {
    const key = headerKey(line);
    if (key) {
      current = key;
      continue;
    }
    out.set(current, (out.get(current) ?? "") + line + "\n");
  }
  return out;
}

/** Regex de palavra inteira (sem flag `g`) pro `wrong_value`. */
function wholeWordRe(wrong: string, flags = "u"): RegExp {
  const esc = wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, flags);
}

/** Nº de ocorrências de `wrong` (palavra inteira) em `text`. */
export function countWholeWord(text: string, wrong: string): number {
  const w = wrong.trim();
  if (!w) return 0;
  return [...text.matchAll(wholeWordRe(w, "gu"))].length;
}

/**
 * (#10234) Contagem do `wrong_value` no `02-reviewed.md` do baseline pós-Stage 2
 * (`_internal/editor-request-snapshots/stage2-post-gate/`). `count: null`
 * quando o baseline não existe ou não é confiável (legado/capturado tarde —
 * pode já conter as edições do editor).
 */
export function baselineOccurrences(
  editionDir: string,
  wrong: string,
): { status: string; count: number | null; bySection: Map<string, number> } {
  const bySection = new Map<string, number>();
  const health = assessStage2BaselineOnDisk(editionDir);
  if (health.status !== "ok") return { status: health.status, count: null, bySection };
  const md = readSnapshots(editionDir, STAGE2_BASELINE_LABEL, ["02-reviewed.md"]).get("02-reviewed.md");
  if (md === undefined) return { status: "missing", count: null, bySection };
  for (const [k, text] of sectionTexts(md)) bySection.set(k || "(topo)", countWholeWord(text, wrong));
  return { status: "ok", count: countWholeWord(md, wrong), bySection };
}

/**
 * (#10234) O erro ANTIGO ainda está no texto? Antes era `md.includes(wrong)`,
 * que recusava por coincidência — o editor poda o item com "Sonnet" e outro
 * item cita "Claude Sonnet 5". Agora:
 *   - casamento por palavra inteira (não acha "Large 3" dentro de "Large 30");
 *   - quando `location` (ou `description`) aponta UMA seção ainda presente no
 *     MD, `present` só considera ocorrência DENTRO dela; ocorrência só em
 *     outra seção volta em `elsewhere` — o chamador (`main`) decide entre
 *     "item movido" (recusa) e "menção legítima" (contagem vs baseline, ou
 *     `--allow-elsewhere`).
 * Conservador quando não dá pra escopar: seção não resolvida, ou o header da
 * seção declarada sumiu do MD (item pode ter sido movido junto com a
 * reorganização) → qualquer ocorrência no texto inteiro conta.
 */
export function findOldErrorStillPresent(
  md: string,
  record: Pick<IntentionalErrorJson, "wrong_value" | "location" | "description">,
): { present: boolean; scope: string; elsewhere: string[] } {
  const wrong = (record.wrong_value ?? "").trim();
  if (!wrong) return { present: false, scope: "nenhum", elsewhere: [] };
  const re = wholeWordRe(wrong);
  if (!re.test(md)) return { present: false, scope: "texto inteiro", elsewhere: [] };
  const key = sectionKeyFromLocation(record.location) ?? sectionKeyFromLocation(record.description);
  const sections = sectionTexts(md);
  if (!key || !sections.has(key)) return { present: true, scope: "texto inteiro", elsewhere: [] };
  if (re.test(sections.get(key) ?? "")) return { present: true, scope: key, elsewhere: [] };
  const elsewhere = [...sections].filter(([, text]) => re.test(text)).map(([k]) => k || "(topo)");
  return { present: false, scope: key, elsewhere };
}

function jsonRecordBody(record: IntentionalErrorJson): string {
  // Mesmo formato de `writeIntentionalErrorJson`.
  return JSON.stringify(record, null, 2) + "\n";
}

/**
 * (#10213) Valida o candidato numa cópia descartável em `os.tmpdir()` (fora de
 * `data/`), preservando o basename AAMMDD que o check de repetição exige.
 */
function validateInScratch(
  edition: string,
  newMd: string,
  record: IntentionalErrorJson,
  history: IntentionalError[],
): string[] {
  const root = mkdtempSync(join(tmpdir(), "replant-validate-"));
  try {
    const dir = join(root, edition);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), newMd, "utf8");
    writeFileSync(intentionalErrorJsonPath(dir), jsonRecordBody(record), "utf8");
    return [
      ...checkIntentionalErrorPresentInFinal(dir),
      ...checkIntentionalErrorNotRecentRepeat(dir, { history }),
    ]
      .filter((v) => v.severity === "error")
      .map((v) => v.message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const values = parseArgs(argv);
  const dryRun = values["dry-run"] === "true" || argv.includes("--dry-run");
  const allowElsewhere = values["allow-elsewhere"] === "true" || argv.includes("--allow-elsewhere");
  const editionDirArg = values["edition-dir"]?.replace(/[\\/]+$/, "");
  if (!editionDirArg) {
    console.error("Uso: npx tsx scripts/replant-intentional-error.ts --edition-dir data/editions/AAMMDD/ [--dry-run] [--allow-elsewhere]");
    return 2;
  }
  const editionDir = resolve(editionDirArg);
  const mdPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    console.error(`replant-intentional-error: ${mdPath} não existe`);
    return 2;
  }
  const jsonPath = intentionalErrorJsonPath(editionDir);
  const edition = basename(editionDir);
  const jsonlPath = values["jsonl"] ?? intentionalErrorsJsonlPathForEditionDir(editionDir);

  // (#10213) Leitura estrita: JSONL existente mas ilegível aborta em vez de virar `[]`
  // (histórico vazio desligaria o filtro de repetição e a reescrita apagaria o arquivo).
  let jsonlRaw: string | null = null;
  let history: IntentionalError[] = [];
  if (jsonlPath) {
    try {
      const read = readIntentionalErrorsJsonlStrict(jsonlPath);
      jsonlRaw = read.raw;
      history = read.entries;
      if (read.unparsedLines > 0) {
        console.error(
          `replant-intentional-error: ${read.unparsedLines} linha(s) de ${jsonlPath} não parseiam — ` +
            "ficam de fora do filtro de repetição, mas são preservadas na reescrita.",
        );
      }
    } catch (err) {
      console.log(JSON.stringify({ action: "jsonl_unreadable", jsonl: jsonlPath }));
      console.error(
        `replant-intentional-error: ${jsonlPath} existe mas não pôde ser lido (${(err as Error).message}) — ` +
          "abortando sem gravar nada (reescrever a partir de leitura vazia apagaria o histórico do concurso).",
      );
      return 1;
    }
  }

  const md = readFileSync(mdPath, "utf8");
  if (!CURRENT_NARRATIVE_LINE_RE.test(md)) {
    console.log(JSON.stringify({ action: "no_narrative_line" }));
    console.error(`replant-intentional-error: linha "Nessa edição, …" ausente em ${mdPath} — rode render-erro-intencional.ts antes.`);
    return 1;
  }

  // (#10213) Erro velho ainda no texto (item só movido, não removido) → replantar
  // deixaria a edição com dois erros e só o novo declarado.
  const prevRecord = loadIntentionalErrorJson(jsonPath);
  let elsewhereInfo: Record<string, unknown> | null = null;
  const oldWrong = (prevRecord?.wrong_value ?? "").trim();
  if (prevRecord && prevRecord.no_error !== true && oldWrong && !/^\{PREENCHER/i.test(oldWrong)) {
    // (#10234) Escopado à seção declarada em `location` — ver `findOldErrorStillPresent`.
    const old = findOldErrorStillPresent(md, prevRecord);
    if (old.present) {
      console.log(JSON.stringify({ action: "old_error_still_present", wrong_value: oldWrong, scope: old.scope }));
      console.error(
        `replant-intentional-error: o erro antigo ("${oldWrong}") ainda aparece em 02-reviewed.md (${old.scope}) — ` +
          "o item provavelmente só foi movido e não precisa de replantio. Se for mesmo replantar, corrija o erro antigo no texto antes.",
      );
      return 1;
    }
    if (old.elsewhere.length > 0) {
      // (#10234) Ocorrência só fora da seção declarada: pode ser o item com o erro
      // MOVIDO (RADAR → LANÇAMENTOS, promoção a destaque — rotina do editor), e aí
      // replantar deixaria dois erros com um só declarado. Só segue quando o
      // baseline confiável mostra que a contagem CAIU (o item com o erro saiu e o
      // que restou é menção de outro item) ou com override explícito.
      const currentCount = countWholeWord(md, oldWrong);
      const baseline = baselineOccurrences(editionDir, oldWrong);
      // (#10237) Total menor não basta: se o item do erro foi movido pra uma seção e OUTRO
      // item foi cortado, o total cai mas o erro antigo segue lá. Cada seção de `elsewhere`
      // precisa já ter tido >= as ocorrências de hoje no baseline (crescimento = movimento).
      const currentBySection = new Map<string, number>();
      for (const [k, text] of sectionTexts(md)) currentBySection.set(k || "(topo)", countWholeWord(text, oldWrong));
      const grewElsewhere = old.elsewhere.some(
        (k) => (currentBySection.get(k) ?? 0) > (baseline.bySection.get(k) ?? 0),
      );
      const countDropped = baseline.count !== null && baseline.count > currentCount && !grewElsewhere;
      elsewhereInfo = {
        wrong_value: oldWrong,
        scope: old.scope,
        elsewhere: old.elsewhere,
        current_count: currentCount,
        baseline_count: baseline.count,
        baseline_status: baseline.status,
        resolved_by: countDropped ? "baseline_count" : allowElsewhere ? "allow_elsewhere" : null,
      };
      if (!countDropped && !allowElsewhere) {
        console.log(JSON.stringify({ action: "old_error_maybe_moved", ...elsewhereInfo, override: "--allow-elsewhere" }));
        console.error(
          `replant-intentional-error: "${oldWrong}" não está mais em ${old.scope}, mas aparece em ${old.elsewhere.join(", ")} — ` +
            `o item com o erro pode ter sido só movido de seção (${currentCount} ocorrência(s) agora; baseline pós-Stage 2: ` +
            `${baseline.count ?? `indisponível (${baseline.status})`}). Nada gravado. Se for menção legítima de outro item, ` +
            "rode de novo com --allow-elsewhere.",
        );
        return 1;
      }
      console.error(
        `replant-intentional-error: "${oldWrong}" ainda aparece fora da seção declarada (${old.scope}) — em ${old.elsewhere.join(", ")}; ` +
          (countDropped
            ? `contagem caiu de ${baseline.count} (baseline pós-Stage 2) pra ${currentCount}: tratado como menção legítima (#10234).`
            : "tratado como menção legítima por --allow-elsewhere (#10234)."),
      );
    }
  }

  const tried: string[] = [];
  const invalid: string[] = [];
  for (const c of listIntentionalErrorCandidates(md, { history, edition })) {
    tried.push(c.location);
    const planted = plantIntentionalError(md, c);
    if (!planted) continue;
    const newMd = planted.md.replace(CURRENT_NARRATIVE_LINE_RE, () => buildCurrentNarrative(planted.section));
    // Record só do candidato: campos do record antigo (reveal etc.) descreveriam o erro velho.
    const record: IntentionalErrorJson = { ...c };
    const violations = validateInScratch(edition, newMd, record, history);
    if (violations.length > 0) {
      invalid.push(...violations);
      continue;
    }
    if (dryRun) {
      console.log(JSON.stringify({ action: "replanted", dry_run: true, validated: true, section: planted.section, candidate: c, old_error_elsewhere: elsewhereInfo }, null, 2));
      return 0;
    }

    // (#10213) Save do editor na janela entre a leitura e a escrita → não sobrescrever.
    if (readFileSync(mdPath, "utf8") !== md) {
      console.log(JSON.stringify({ action: "md_changed" }));
      console.error("replant-intentional-error: 02-reviewed.md mudou durante a execução (save do editor?) — nada gravado; rode de novo.");
      return 1;
    }

    const writes: VerifiedWrite[] = [
      { path: mdPath, content: newMd },
      { path: jsonPath, content: jsonRecordBody(record) },
    ];
    if (jsonlPath) {
      // Substitui TODA entry desta edição (qualquer `source`), preservando as demais linhas verbatim.
      writes.push({ path: jsonlPath, content: replaceEditionInJsonlRaw(jsonlRaw, edition, frontmatterToEntry(record, edition)) });
    } else {
      console.error("replant-intentional-error: JSONL não resolvido — data/intentional-errors.jsonl NÃO sincronizado.");
    }
    for (const w of writes) mkdirSync(dirname(w.path), { recursive: true });
    writeFilesVerified(writes, "replant-intentional-error");
    console.log(JSON.stringify({ action: "replanted", dry_run: false, jsonl_synced: !!jsonlPath, section: planted.section, candidate: c, old_error_elsewhere: elsewhereInfo }, null, 2));
    return 0;
  }
  if (invalid.length > 0) {
    console.log(JSON.stringify({ action: "invalid", violations: invalid, tried }));
    return 1;
  }
  console.log(JSON.stringify({ action: "no_candidate", tried }));
  console.error(
    "replant-intentional-error: nenhuma menção plantável do catálogo #5742 em seção secundária — " +
      "replante à mão ou declare {\"no_error\": true} em _internal/intentional-error.json.",
  );
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
