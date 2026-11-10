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
 *     já provado pelo humanizador. A Clarice pode não mudar nada, mas aí
 *     `--pre` e `--post` iguais não distinguem "rodou sem sugestões" de "não
 *     rodou" (#11674): run da Clarice em que nenhuma seção do escopo mudou só
 *     vira prova com `--note "<motivo>"`, gravado no run e em
 *     `clarice_unchanged` (prova mais fraca, "sem sugestões" no `--provenance`).
 *
 * `--write --bypass-reason` passa a aceitar só (a) seção com o hash atual no
 * registro dos dois passos ou (b) seção cuja mudança é só de formatação
 * (`{quebra}`, hashtags, espaços). Fora disso exige `--unproven-ok "<motivo>"`,
 * que fica gravado no selo e aparece no resumo do gate.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { computeSectionHashes, extractSocialSections, isCardsSection } from "./social-lint-rules.ts";

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
  /** #11674: subconjunto de `clarice` — run sem mudança, aceito só com `--note`. */
  clarice_unchanged: string[];
  runs: Array<{ at: string; step: RunStep; sections: string[]; note?: string }>;
}

export function emptyRunRecord(): HumanizerRunRecord {
  return { version: 1, humanizador: [], humanizador_unchanged: [], clarice: [], clarice_unchanged: [], runs: [] };
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
      clarice_unchanged: Array.isArray(raw.clarice_unchanged)
        ? raw.clarice_unchanged.filter((h) => typeof h === "string")
        : [],
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
  /**
   * #11674: nenhuma seção do escopo mudou entre `--pre` e `--post` (inclusive o
   * mesmo arquivo passado nos dois). O CLI recusa esse run sem `--note`.
   */
  noop: boolean;
}

export interface PlanRunOptions {
  now?: Date;
  /**
   * #11674: só para a Clarice — motivo de um run sem mudança ("Clarice sem
   * sugestões"). Sem ele, run da Clarice sem mudança não prova nada.
   */
  note?: string;
}

/** Dica comum às mensagens de "seção ausente": `--pre`/`--post` são o arquivo inteiro. */
export const WHOLE_FILE_HINT =
  "--pre e --post precisam ser o 03-social.md INTEIRO (com o cabeçalho `# Social`), não o trecho da seção; " +
  "para restringir o registro use --sections";

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
  opts: PlanRunOptions = {},
): RunRecordPlan {
  const now = opts.now ?? new Date();
  const note = opts.note?.trim() || undefined;
  const pre = computeSectionHashes(preMd);
  const post = computeSectionHashes(postMd);
  const only = sections && sections.length > 0 ? new Set(sections) : null;
  const humanizador = new Set(current.humanizador);
  const unchanged = new Set(current.humanizador_unchanged);
  const clarice = new Set(current.clarice);
  const clariceUnchanged = new Set(current.clarice_unchanged);
  const recorded: string[] = [];
  const skipped: RunRecordPlan["skipped"] = [];

  // #11609 (decisão do editor, opção a): pre === post sozinho não distingue "o
  // humanizador leu e manteve" de "o humanizador não rodou" (Skill pulada ou
  // falha silenciosa deixa os dois snapshots iguais). Seção idêntica só vira
  // prova se ao menos outra seção do escopo deste run mudou — sinal de que o
  // passo de fato reescreveu o arquivo. Run em que nada mudou não prova nada.
  const inScope = Object.entries(post).filter(([name]) => !only || only.has(name));
  const runChangedSomething = inScope.some(([name, postHash]) => pre[name] !== postHash);
  const noop = inScope.length > 0 && !runChangedSomething;

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
      if (preHash === undefined) {
        skipped.push({ section: name, reason: `seção ausente no texto pré-passo — ${WHOLE_FILE_HINT}` });
        continue;
      }
      const inputProven = humanizador.has(preHash) || clarice.has(preHash);
      if (!inputProven) {
        skipped.push({ section: name, reason: "texto de entrada da Clarice não passou pelo humanizador" });
        continue;
      }
      // #11674: --pre e --post iguais em todo o escopo não distinguem "a Clarice
      // rodou sem sugestões" de "a Clarice não rodou". Só com --note explícito.
      if (noop && !note) {
        skipped.push({
          section: name,
          reason:
            "--pre e --post idênticos em todo o escopo — sem sinal de que a Clarice rodou; " +
            'se ela rodou e não sugeriu nada, repita com --note "<motivo>" (#11674)',
        });
        continue;
      }
      if (noop) clariceUnchanged.add(postHash);
      clarice.add(postHash);
      recorded.push(name);
    }
  }
  if (!only && Object.keys(post).length === 0) {
    skipped.push({ section: "(nenhuma)", reason: `nenhuma seção reconhecida no texto pós-passo — ${WHOLE_FILE_HINT}` });
  }
  if (only) {
    for (const name of only) {
      if (!(name in post)) skipped.push({ section: name, reason: `seção ausente no texto pós-passo — ${WHOLE_FILE_HINT}` });
    }
  }

  return {
    record: {
      version: 1,
      humanizador: [...humanizador],
      humanizador_unchanged: [...unchanged],
      clarice: [...clarice],
      clarice_unchanged: [...clariceUnchanged],
      runs: [
        ...current.runs,
        { at: now.toISOString(), step, sections: recorded, ...(note && noop && step === "clarice" ? { note } : {}) },
      ],
    },
    recorded,
    skipped,
    noop,
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

/** Campos do selo que a comparação selo × texto atual lê. */
export interface StoredSealSections {
  section_hashes?: Record<string, string>;
  section_format_hashes?: Record<string, string>;
  /**
   * #12383: o selo foi gravado já com `main_d{N}-cards` nos hashes por seção.
   * Ausente = selo anterior à #12383: os cards ficam fora da comparação (não
   * contam como "mudou" só por não terem hash no selo), senão toda edição em
   * curso passaria a exigir prova dos cards no primeiro `--write`.
   */
  cards_sections_tracked?: boolean;
}

/** #12383: o selo compara os cards? Só quando foi gravado com eles nos hashes. */
export function sealTracksCards(stored: StoredSealSections | null | undefined): boolean {
  return stored?.cards_sections_tracked === true;
}

/**
 * Pure: classifica as seções que mudaram entre o selo armazenado e o
 * `03-social.md` atual. Seção removida não entra (não há texto a provar).
 */
export function classifySealChanges(
  stored: StoredSealSections,
  currentMd: string,
  record: HumanizerRunRecord,
): SealChangeClassification {
  const current = computeSectionHashes(currentMd);
  const currentFormat = computeSectionFormatHashes(currentMd);
  const legacy = !stored.section_hashes;
  const tracksCards = sealTracksCards(stored);
  // Endereçado por conteúdo: um reorder troca o nome da seção, não o texto.
  const storedFormat = new Set(Object.values(stored.section_format_hashes ?? {}));
  const changed: SectionProvenance[] = [];
  for (const [name, hash] of Object.entries(current)) {
    if (!tracksCards && isCardsSection(name)) continue; // #12383: selo antigo, sem hash dos cards
    if (!legacy && stored.section_hashes![name] === hash) continue;
    const formatOnly = currentFormat[name] !== undefined && storedFormat.has(currentFormat[name]);
    changed.push({ section: name, change: formatOnly ? "formatting" : "redaction", ...sectionProof(hash, record) });
  }
  const unproven = changed
    .filter((c) => c.change === "redaction" && !(c.humanizador && c.clarice))
    .map((c) => c.section);
  return { legacy, changed, unproven };
}

/** #12361: por que uma seção sem prova no registro foi aceita pelo selo. */
export type AcceptedSectionReason = "formatting" | "unproven_ok";

/**
 * #12361: hashes de seção (conteúdo, mesmo vocabulário de `computeSectionHashes`)
 * que o `--write` aceitou sem prova dos dois passos no registro:
 *
 *   - `unproven_ok`: seção listada em `unproven` e aceita com `--unproven-ok`
 *     (ex.: o editor editou o social no gate do Stage 2 e pediu para manter o texto);
 *   - `formatting`: mudança só de `{quebra}`/hashtags/espaços sobre um texto
 *     que já estava provado (registro) ou aceito (selo anterior). Formatação
 *     sobre texto que nunca teve prova NÃO vira aceite, senão o selo inicial
 *     sem `--record-run` (#12331) passaria com um espaço a mais.
 *
 * Entradas do selo anterior cujo texto ainda existe no social atual são
 * mantidas; um `--write` sem mudança não apaga o aceite. Endereçado por conteúdo:
 * reorder D1↔D3 não perde o aceite.
 */
export function planAcceptedSectionHashes(
  stored: (StoredSealSections & { accepted_section_hashes?: Record<string, string> }) | null,
  currentMd: string,
  record: HumanizerRunRecord,
  unproven: string[] = [],
  unprovenOk?: string,
): Record<string, AcceptedSectionReason> {
  const current = computeSectionHashes(currentMd);
  const currentHashes = new Set(Object.values(current));
  const out: Record<string, AcceptedSectionReason> = {};
  const prevAccepted = stored?.accepted_section_hashes ?? {};
  for (const [hash, reason] of Object.entries(prevAccepted)) {
    if (currentHashes.has(hash) && (reason === "formatting" || reason === "unproven_ok")) out[hash] = reason;
  }
  if (!stored) return out;

  const isCovered = (hash: string) => {
    const p = sectionProof(hash, record);
    return (p.humanizador && p.clarice) || hash in prevAccepted;
  };
  const currentFormat = computeSectionFormatHashes(currentMd);
  const storedHashes = stored.section_hashes ?? {};
  const storedFormat = stored.section_format_hashes ?? {};
  const cls = classifySealChanges(stored, currentMd, record);
  for (const c of cls.changed) {
    const hash = current[c.section];
    if (hash === undefined || (c.humanizador && c.clarice)) continue;
    if (c.change === "formatting") {
      const fmt = currentFormat[c.section];
      const predecessorCovered = Object.entries(storedFormat).some(
        ([name, f]) => f === fmt && storedHashes[name] !== undefined && isCovered(storedHashes[name]),
      );
      if (predecessorCovered) out[hash] = "formatting";
    } else if (unprovenOk && unproven.includes(c.section)) {
      out[hash] = "unproven_ok";
    }
  }
  return out;
}

/**
 * #12398: seções do texto atual sem prova dos dois passos no registro e ainda
 * não aceitas — o que um `--write --unproven-ok` aceita quando NÃO há mudança
 * em relação ao selo (selo já batendo com o texto, ou primeiro `--write`). Sem
 * isto o `--unproven-ok` sugerido pela invariante `social-humanizer-provenance-recorded`
 * saía exit 0 sem gravar aceite nenhum (`planAcceptedSectionHashes` só olha o
 * que mudou desde o selo).
 *
 * #12511: devolve os CANDIDATOS; o `--write` só aceita os que o seletor
 * `--unproven-ok-section` nomeia. Sem seletor, nada é aceito (o caller recusa):
 * sem mudança desde o selo não há como distinguir "o editor manteve o texto
 * dele" de "o humanizador nunca rodou nesta seção".
 */
export function planUnprovenOkWithoutChanges(
  currentMd: string,
  record: HumanizerRunRecord,
  accepted: Record<string, AcceptedSectionReason>,
): Array<{ section: string; hash: string }> {
  return Object.entries(computeSectionHashes(currentMd))
    .filter(([, hash]) => !(hash in accepted))
    .filter(([, hash]) => {
      const p = sectionProof(hash, record);
      return !(p.humanizador && p.clarice);
    })
    .map(([section, hash]) => ({ section, hash }));
}

/**
 * #12511: resolve o seletor de `--unproven-ok-section` contra as seções do texto
 * atual. Aceita o nome completo (`main_d2`, `main_d2-cards`, `comment_pixel_d1`,
 * `post_pixel`) e o atalho sem o prefixo `main_` (`d2`, `d2-cards`, `um`).
 * `unknown` = nome que não casa com nenhuma seção do `03-social.md` atual.
 */
export function resolveSectionSelector(
  selector: string[],
  available: string[],
): { sections: string[]; unknown: string[] } {
  const avail = new Set(available);
  const sections: string[] = [];
  const unknown: string[] = [];
  for (const raw of selector) {
    const name = raw.trim();
    if (!name) continue;
    const resolved = avail.has(name) ? name : avail.has(`main_${name}`) ? `main_${name}` : undefined;
    if (resolved === undefined) unknown.push(name);
    else if (!sections.includes(resolved)) sections.push(resolved);
  }
  return { sections, unknown };
}

/**
 * Proveniência de TODAS as seções do texto atual — o bloco do resumo do gate (#11534 item 4).
 * `kept: true` (#11604) quando o humanizador devolveu esse texto idêntico.
 */
export function describeProvenance(
  currentMd: string,
  record: HumanizerRunRecord,
): Array<{ section: string; humanizador: boolean; clarice: boolean; kept?: true; clarice_unchanged?: true }> {
  return Object.entries(computeSectionHashes(currentMd)).map(([section, hash]) => ({
    section,
    ...sectionProof(hash, record),
    ...(record.humanizador_unchanged.includes(hash) ? { kept: true as const } : {}),
    // #11674: Clarice registrada sem mudança, por --note (prova mais fraca).
    ...(record.clarice_unchanged.includes(hash) ? { clarice_unchanged: true as const } : {}),
  }));
}
