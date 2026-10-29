/**
 * humanizer-run-record.ts (#11534)
 *
 * Prova de que o humanizador e a Clarice rodaram sobre o texto atual de cada
 * seção de `03-social.md`. Antes, `check-humanizer-social.ts --write
 * --bypass-reason "..."` regravava o selo por simples asserção textual: na
 * edição 261029 o D1 e o `## um` foram reescritos à mão e o selo foi refeito
 * sem humanizador nem Clarice, e o invariante `social-humanizer-seal-fresh`
 * passou verde.
 *
 * O registro (`_internal/.humanizer-run.json`) guarda o sha256 das SEÇÕES que
 * saíram de cada passo, endereçado por conteúdo (não por nome de seção, então
 * um reorder D1↔D3 não perde a prova):
 *
 *   - `humanizador`: hash de cada seção do escopo que saiu do humanizador.
 *     Seção que saiu idêntica também ganha prova (#11604): o humanizador leu o
 *     texto e o manteve. Mas só quando ao menos outra seção do escopo do mesmo
 *     run mudou (#11609, opção a do editor): snapshots idênticos em todo o
 *     escopo são indistinguíveis de "a Skill não rodou" e não provam nada —
 *     run de uma única seção mantida cai em `--unproven-ok`. Os hashes
 *     mantidos ficam também em `humanizador_unchanged`, pra auditoria e pro
 *     `--provenance` mostrar "texto mantido". O escopo continua sendo o
 *     `--sections` pedido (ou o arquivo inteiro na passada full-file).
 *   - `clarice`: hash de cada seção que saiu da Clarice partindo de um texto
 *     já provado pelo humanizador. A Clarice pode não mudar nada; a prova vem
 *     de o texto de entrada ser humanizado.
 *
 * `--write --bypass-reason` passa a aceitar só (a) seção com o hash atual no
 * registro dos dois passos ou (b) seção cuja mudança é só de formatação
 * (`{quebra}`, hashtags, espaços). Fora disso exige `--unproven-ok "<motivo>"`,
 * que fica gravado no selo e aparece no resumo do gate.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { computeSectionHashes, extractSocialSections } from "./social-lint-rules.ts";

export const HUMANIZER_RUN_RECORD = ".humanizer-run.json";

export type RunStep = "humanizador" | "clarice";

export interface HumanizerRunRecord {
  version: 1;
  /** sha256 (mesma normalização de `computeSectionHashes`) de seções que saíram do humanizador. */
  humanizador: string[];
  /** #11604: subconjunto de `humanizador` — seções que o humanizador devolveu idênticas. */
  humanizador_unchanged: string[];
  /** sha256 de seções que saíram da Clarice a partir de texto já humanizado. */
  clarice: string[];
  runs: Array<{ at: string; step: RunStep; sections: string[] }>;
}

export function emptyRunRecord(): HumanizerRunRecord {
  return { version: 1, humanizador: [], humanizador_unchanged: [], clarice: [], runs: [] };
}

export function runRecordPath(editionDir: string): string {
  return join(editionDir, "_internal", HUMANIZER_RUN_RECORD);
}

/** Lê o registro; ausente ou corrompido vira registro vazio (nenhuma prova). */
export function readRunRecord(editionDir: string): HumanizerRunRecord {
  const path = runRecordPath(editionDir);
  if (!existsSync(path)) return emptyRunRecord();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HumanizerRunRecord>;
    return {
      version: 1,
      humanizador: Array.isArray(raw.humanizador) ? raw.humanizador.filter((h) => typeof h === "string") : [],
      humanizador_unchanged: Array.isArray(raw.humanizador_unchanged)
        ? raw.humanizador_unchanged.filter((h) => typeof h === "string")
        : [],
      clarice: Array.isArray(raw.clarice) ? raw.clarice.filter((h) => typeof h === "string") : [],
      runs: Array.isArray(raw.runs) ? raw.runs : [],
    };
  } catch {
    return emptyRunRecord();
  }
}

export interface RunRecordPlan {
  record: HumanizerRunRecord;
  recorded: string[];
  skipped: Array<{ section: string; reason: string }>;
}

/**
 * Pure: acrescenta ao registro as seções provadas por um passo. `preMd` é o
 * `03-social.md` antes do passo, `postMd` depois. `sections` restringe o
 * registro a essas seções (o escopo pedido ao humanizador scoped).
 */
export function planRunRecord(
  current: HumanizerRunRecord,
  step: RunStep,
  preMd: string,
  postMd: string,
  sections?: string[],
  now: Date = new Date(),
): RunRecordPlan {
  const pre = computeSectionHashes(preMd);
  const post = computeSectionHashes(postMd);
  const only = sections && sections.length > 0 ? new Set(sections) : null;
  const humanizador = new Set(current.humanizador);
  const unchanged = new Set(current.humanizador_unchanged);
  const clarice = new Set(current.clarice);
  const recorded: string[] = [];
  const skipped: RunRecordPlan["skipped"] = [];

  // #11609 (decisão do editor, opção a): pre === post sozinho não distingue "o
  // humanizador leu e manteve" de "o humanizador não rodou" (Skill pulada ou
  // falha silenciosa deixa os dois snapshots iguais). Seção idêntica só vira
  // prova se ao menos outra seção do escopo deste run mudou — sinal de que o
  // passo de fato reescreveu o arquivo. Run em que nada mudou não prova nada.
  const inScope = Object.entries(post).filter(([name]) => !only || only.has(name));
  const runChangedSomething = inScope.some(([name, postHash]) => pre[name] !== postHash);

  for (const [name, postHash] of inScope) {
    const preHash = pre[name];
    if (step === "humanizador") {
      if (preHash === postHash) {
        if (!runChangedSomething) {
          skipped.push({
            section: name,
            reason:
              "seção devolvida idêntica e nenhuma outra seção do run mudou — sem sinal de que o humanizador rodou (#11609)",
          });
          continue;
        }
        // #11604: idêntica com outra seção alterada no mesmo run = o humanizador manteve o texto.
        unchanged.add(postHash);
      }
      humanizador.add(postHash);
      recorded.push(name);
    } else {
      const inputProven = preHash !== undefined && (humanizador.has(preHash) || clarice.has(preHash));
      if (!inputProven) {
        skipped.push({ section: name, reason: "texto de entrada da Clarice não passou pelo humanizador" });
        continue;
      }
      clarice.add(postHash);
      recorded.push(name);
    }
  }
  if (only) {
    for (const name of only) {
      if (!(name in post)) skipped.push({ section: name, reason: "seção ausente no texto pós-passo" });
    }
  }

  return {
    record: {
      version: 1,
      humanizador: [...humanizador],
      humanizador_unchanged: [...unchanged],
      clarice: [...clarice],
      runs: [...current.runs, { at: now.toISOString(), step, sections: recorded }],
    },
    recorded,
    skipped,
  };
}

export function writeRunRecord(editionDir: string, record: HumanizerRunRecord): string {
  const path = runRecordPath(editionDir);
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Normalização de "só formatação": tira `{quebra}`, hashtags e diferenças de
 * espaço. Duas versões com o mesmo resultado diferem só nisso; qualquer outra
 * diferença é mudança de redação.
 */
export function normalizeForFormatting(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\{quebra\}/g, " ")
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 da versão normalizada de cada seção nomeada (vocabulário de `computeSectionHashes`). */
export function computeSectionFormatHashes(md: string): Record<string, string> {
  const sections = extractSocialSections(md);
  const names = Object.keys(computeSectionHashes(md));
  const out: Record<string, string> = {};
  for (const name of names) {
    const content = sections[name];
    if (content === undefined) continue;
    out[name] = createHash("sha256").update(normalizeForFormatting(content)).digest("hex");
  }
  return out;
}

export interface SectionProvenance {
  section: string;
  /** `formatting` = só `{quebra}`/hashtags/espaços mudaram; `redaction` = texto mudou. */
  change: "formatting" | "redaction";
  humanizador: boolean;
  clarice: boolean;
}

export interface SealChangeClassification {
  /** true = selo sem `section_hashes`: toda seção atual conta como alterada. */
  legacy: boolean;
  changed: SectionProvenance[];
  /** Seções com mudança de redação sem prova de humanizador E Clarice. */
  unproven: string[];
}

/** Proveniência do texto atual de uma seção, pelo registro. */
export function sectionProof(hash: string, record: HumanizerRunRecord): { humanizador: boolean; clarice: boolean } {
  const clarice = record.clarice.includes(hash);
  return { humanizador: clarice || record.humanizador.includes(hash), clarice };
}

/**
 * Pure: classifica as seções que mudaram entre o selo armazenado e o
 * `03-social.md` atual. Seção removida não entra (não há texto a provar).
 */
export function classifySealChanges(
  stored: { section_hashes?: Record<string, string>; section_format_hashes?: Record<string, string> },
  currentMd: string,
  record: HumanizerRunRecord,
): SealChangeClassification {
  const current = computeSectionHashes(currentMd);
  const currentFormat = computeSectionFormatHashes(currentMd);
  const legacy = !stored.section_hashes;
  // Endereçado por conteúdo: um reorder troca o nome da seção, não o texto.
  const storedFormat = new Set(Object.values(stored.section_format_hashes ?? {}));
  const changed: SectionProvenance[] = [];
  for (const [name, hash] of Object.entries(current)) {
    if (!legacy && stored.section_hashes![name] === hash) continue;
    const formatOnly = currentFormat[name] !== undefined && storedFormat.has(currentFormat[name]);
    changed.push({ section: name, change: formatOnly ? "formatting" : "redaction", ...sectionProof(hash, record) });
  }
  const unproven = changed
    .filter((c) => c.change === "redaction" && !(c.humanizador && c.clarice))
    .map((c) => c.section);
  return { legacy, changed, unproven };
}

/**
 * Proveniência de TODAS as seções do texto atual — o bloco do resumo do gate (#11534 item 4).
 * `kept: true` (#11604) quando o humanizador devolveu esse texto idêntico.
 */
export function describeProvenance(
  currentMd: string,
  record: HumanizerRunRecord,
): Array<{ section: string; humanizador: boolean; clarice: boolean; kept?: true }> {
  return Object.entries(computeSectionHashes(currentMd)).map(([section, hash]) => ({
    section,
    ...sectionProof(hash, record),
    ...(record.humanizador_unchanged.includes(hash) ? { kept: true as const } : {}),
  }));
}
