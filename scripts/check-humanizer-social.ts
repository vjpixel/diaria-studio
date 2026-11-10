#!/usr/bin/env npx tsx
/**
 * check-humanizer-social.ts (#2279, #2373, #2529)
 *
 * Sentinel determinístico para garantir que o humanizador rodou no social
 * e que o `03-social.md` não foi editado depois da humanização sem re-humanizar.
 *
 * Modos:
 *   --write   Grava `_internal/.humanizer-social-done.json` com sha256 do
 *             `03-social.md` atual. Chamar APÓS humanização bem-sucedida.
 *
 *             Se um sentinel anterior já existe e hash diverge (social foi editado
 *             após a humanização anterior), --write EXIGE --bypass-reason para
 *             evitar uso como atalho que bypassa a humanização (#2373).
 *             Sem --bypass-reason nesse caso: exit 3 com mensagem de erro.
 *
 *   --check   Compara o hash armazenado com o sha256 atual do `03-social.md`.
 *             Exit 0 = hash bate (humanizador rodou e social não mudou depois).
 *             Exit 1 = sentinel ausente (humanizador nunca rodou).
 *             Exit 2 = hash diverge (social editado/reordenado pós-humanização
 *                      sem re-humanizar).
 *
 *             Quando exit 2 (hash diverge), o guard também roda lint de tics de IA
 *             determinísticos (#2529) sobre o `03-social.md` editado e emite
 *             WARNs adicionais no stderr se tics forem detectados. O lint usa
 *             `lintAntithesisReveal` de lint-social-md.ts. A decisão de
 *             re-humanizar fica com o editor/orchestrator — não é bloqueio extra.
 *             Logar a decisão (acusou / passou limpo) no run-log via log-event.ts
 *             quando --edition-dir é fornecido (sempre o caso no Stage 4).
 *
 *   --record-run --step humanizador|clarice --pre <arquivo> --post <arquivo> [--sections a,b]
 *             (#11534) Registra em `_internal/.humanizer-run.json` a PROVA de que o
 *             passo rodou: o sha256 de cada seção que saiu dele. `humanizador`:
 *             --pre = snapshot antes da Skill, --post = snapshot pós-humanizador;
 *             toda seção do escopo ganha prova, inclusive a que saiu idêntica
 *             (#11604, marcada "texto mantido" no --provenance). `clarice`: --pre = snapshot
 *             pós-humanizador, --post = `03-social.md` pós-Clarice; só seção cujo
 *             texto de entrada já tinha prova do humanizador.
 *             --pre/--post são sempre o `03-social.md` INTEIRO (trecho de uma
 *             seção não tem o cabeçalho `# Social` e sai "seção ausente").
 *             #11674: run da Clarice em que --pre e --post são iguais em todo o
 *             escopo (inclusive o mesmo arquivo nos dois) é RECUSADO (exit 1, nada
 *             gravado) — não distingue "rodou sem sugestões" de "não rodou". Se a
 *             Clarice rodou e não sugeriu nada, `--note "<motivo>"` registra a prova
 *             como mais fraca ("sem sugestões" no --provenance, motivo no run).
 *             `--note` não vale para o humanizador (#11609).
 *
 *   --provenance  (#11534) Imprime, por seção do `03-social.md` atual, se o texto
 *             passou pelo humanizador e pela Clarice (bloco do resumo do gate).
 *             Marca as seções aceitas pelo selo (`accepted_section_hashes`, #12377).
 *
 * Seções (#12383): `main_d{N}`, `main_d{N}-cards`, `main_um`, `comment_pixel_d{N}`,
 * `post_pixel`. Selo sem `cards_sections_tracked` (anterior à #12383) deixa os
 * cards fora da comparação com o texto atual.
 *
 * Flags:
 *   --unproven-ok <motivo>   (#11534, só com --write) aceita seção com mudança de
 *             redação SEM prova de humanizador + Clarice. Só quando o EDITOR pediu
 *             para manter um texto dele sem humanizar; fica gravado no selo
 *             (`unproven_sections` + `accepted_section_hashes`) e aparece no `--provenance`.
 *             #12398: com o selo já batendo com o `03-social.md` (ou sem selo
 *             anterior), aceita as seções hoje sem prova no `.humanizer-run.json` —
 *             antes saía exit 0 sem aceitar nada.
 *             #12511: nesse caso (sem mudança desde o selo) exige
 *             `--unproven-ok-section`; sem ele, exit 5 listando as seções sem prova
 *             e nada gravado.
 *
 *   --unproven-ok-section <seções>   (#12511, só com --unproven-ok) seções aceitas
 *             sem prova, separadas por vírgula: nome completo (`main_d2`,
 *             `main_d2-cards`, `comment_pixel_d1`, `post_pixel`) ou atalho sem
 *             `main_` (`d2`, `d2-cards`, `um`). Obrigatório sem mudança desde o
 *             selo; com mudança, restringe o aceite (seção sem prova não nomeada
 *             sai exit 4). Seção inexistente no `03-social.md`: exit 1.
 *
 *   --bypass-reason <motivo>   (opcional, só válido com --write)
 *             Registra o motivo no sentinel quando --write é chamado com hash
 *             divergente (ex: "humanizador re-rodou após ajuste D1↔D2 no Stage 4").
 *             OBRIGATÓRIO quando --write é chamado após edição pós-humanização
 *             para garantir rastreabilidade (#2373).
 *             Desde #11534 o motivo sozinho não basta: cada seção com mudança de
 *             REDAÇÃO precisa de prova no `.humanizer-run.json` (humanizador E
 *             Clarice). Mudança só de formatação (`{quebra}`, hashtags, espaços)
 *             passa. Sem prova: exit 4, listando as seções.
 *
 * Uso:
 *   npx tsx scripts/check-humanizer-social.ts --write --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/check-humanizer-social.ts --check --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/check-humanizer-social.ts --write --bypass-reason "humanizador re-rodou após ajuste Stage 4" --edition-dir data/editions/AAMMDD/
 *
 * Integração com Stage 4 (§4c.2b, §4d.1): checar antes do gate humano para garantir
 * que qualquer edição/reorder pós-Stage-2 re-dispara o humanizador.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { lintAntithesisReveal, lintTrailingEditorialHook, type AntithesisRevealMatch, type TrailingEditorialHookMatch } from "./lint-social-md.ts";
import { computeSectionHashes, isCardsSection } from "./lib/social-lint-rules.ts"; // #3446: hash por-seção p/ re-humanização scoped
import { hashSocialContent } from "./lib/humanizer-social-seal.ts"; // #9679: fonte única do sha256
import {
  classifySealChanges,
  computeSectionFormatHashes,
  describeProvenance,
  planAcceptedSectionHashes,
  planRunRecord,
  planUnprovenOkWithoutChanges,
  readRunRecord,
  resolveSectionSelector,
  sealTracksCards,
  writeRunRecord,
  type AcceptedSectionReason,
  type RunStep,
  type SectionProvenance,
} from "./lib/humanizer-run-record.ts"; // #11534: prova de humanizador + Clarice

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL_FILENAME = ".humanizer-social-done.json";

export interface HumanizerSocialSentinel {
  social_sha256: string;
  written_at: string;
  /** Razão de bypass quando --write foi chamado após edição pós-humanização (#2373). */
  bypass_reason?: string;
  /**
   * Hash sha256 por seção nomeada (main_dN, comment_pixel_dN, post_pixel) — #3446.
   * Permite detectar EXATAMENTE quais seções mudaram desde a última humanização,
   * pra re-humanizar só o(s) destaque(s) tocado(s) no gate do Stage 4 em vez do
   * arquivo inteiro. Ausente em sentinels gravados antes do #3446 (legacy) —
   * computeChangedSections() trata esse caso como fallback pra full-file.
   */
  section_hashes?: Record<string, string>;
  /**
   * #9679: presente quando o selo foi refeito por um script que só renumerou
   * headers `## d{N}` (reorder/promote) sobre um social que já batia com o selo.
   */
  resealed_by?: string;
  /** #11534: sha256 da versão normalizada (sem `{quebra}`/hashtags/espaços) de cada seção. */
  section_format_hashes?: Record<string, string>;
  /** #11534: seções alteradas neste `--write` e a prova de cada uma. */
  section_provenance?: SectionProvenance[];
  /** #11534: seções aceitas sem prova via `--unproven-ok` / `unprovenOk`. */
  unproven_sections?: string[];
  unproven_ok?: string;
  /**
   * #12361: sha256 de seção (conteúdo) aceita sem prova no registro — `unproven_ok`
   * (via `--unproven-ok`) ou `formatting` (só formatação sobre texto provado).
   * Persiste entre `--write`s enquanto o texto existir; o Stage 2 aceita essas seções.
   */
  accepted_section_hashes?: Record<string, AcceptedSectionReason>;
  /**
   * #12383: `true` quando `section_hashes` já inclui `main_d{N}-cards`. Selo sem o
   * campo é anterior à #12383 e os cards ficam fora da comparação selo × texto.
   */
  cards_sections_tracked?: boolean;
}

/** #11534: `--write --bypass-reason` com seção reescrita sem prova de humanizador + Clarice. */
export class UnprovenSectionsError extends Error {
  constructor(
    public readonly sections: string[],
    public readonly provenance: SectionProvenance[],
  ) {
    const detail = sections
      .map((s) => {
        const p = provenance.find((x) => x.section === s);
        return `${s} (humanizador ${p?.humanizador ? "ok" : "falta"}, Clarice ${p?.clarice ? "ok" : "falta"})`;
      })
      .join(", ");
    super(
      `check-humanizer-social: seção(ões) com mudança de redação sem prova de humanizador + Clarice: ${detail}. ` +
        "Rodar o humanizador e a Clarice nessas seções e registrar cada passo com " +
        "--record-run --step humanizador|clarice antes do --write (#11534). " +
        '--unproven-ok "<motivo>" só quando o editor pediu para manter o texto dele sem humanizar.',
    );
    this.name = "UnprovenSectionsError";
  }
}

/**
 * #12511: `--unproven-ok` sem `--unproven-ok-section` quando não há mudança desde o
 * selo (primeiro `--write`, selo ilegível ou já batendo com o texto). Aceitar tudo
 * nesse caso silenciava D1/D2/D3 de uma vez, inclusive a seção em que o
 * humanizador simplesmente não rodou.
 */
export class UnprovenOkSectionRequiredError extends Error {
  constructor(public readonly candidates: string[]) {
    super(
      `check-humanizer-social: --unproven-ok sem mudança desde o selo exige --unproven-ok-section nomeando as seções ` +
        `que o editor pediu para manter sem humanizar (sem prova hoje: ${candidates.join(", ")}). ` +
        "Seção em que o humanizador não rodou não se aceita: rodar o humanizador e a Clarice e registrar com " +
        "--record-run (#12511). Nada foi gravado.",
    );
    this.name = "UnprovenOkSectionRequiredError";
  }
}

/** #12511: `--unproven-ok-section` com nome que não casa com nenhuma seção do texto atual. */
export class UnknownSectionSelectorError extends Error {
  constructor(
    public readonly unknown: string[],
    public readonly available: string[],
  ) {
    super(
      `check-humanizer-social: --unproven-ok-section com seção inexistente em 03-social.md: ${unknown.join(", ")} ` +
        `(seções: ${available.join(", ")}). Nada foi gravado (#12511).`,
    );
    this.name = "UnknownSectionSelectorError";
  }
}

export interface WriteSentinelOptions {
  /** Aceita seções sem prova; o motivo fica no selo. Ex.: autofix mecânico de fact-check. */
  unprovenOk?: string;
  /**
   * #12511: seções que o `unprovenOk` aceita (`main_d2` ou o atalho `d2`).
   * Obrigatório quando não há mudança desde o selo; com mudança, restringe o
   * aceite às seções nomeadas e as demais sem prova recusam (exit 4).
   * Ausente com mudança: aceita as seções que mudaram, como antes.
   */
  unprovenOkSections?: string[];
}

/**
 * Calcula sha256 do arquivo 03-social.md.
 */
export function computeSocialHash(socialPath: string): string {
  return hashSocialContent(readFileSync(socialPath, "utf8"));
}

/**
 * Escreve o sentinel `.humanizer-social-done.json` em `_internal/`.
 * Deve ser chamado logo após a humanização bem-sucedida do social.
 *
 * Guard (#2373): se um sentinel anterior existe e o hash diverge (social foi editado
 * após a humanização anterior), `bypassReason` é OBRIGATÓRIO — forçar rastreabilidade.
 * Sem `bypassReason` nesse caso, lança erro (use --bypass-reason na CLI).
 *
 * @param editionDir  Diretório da edição (ex: data/editions/AAMMDD/)
 * @param bypassReason  (opcional) Motivo registrado quando --write é chamado após edição
 *                      pós-humanização. Obrigatório quando hash diverge.
 * @returns path do sentinel gravado
 */
export function writeSentinel(editionDir: string, bypassReason?: string, opts: WriteSentinelOptions = {}): string {
  return writeSentinelDetailed(editionDir, bypassReason, opts).path;
}

export interface WriteSentinelResult {
  path: string;
  /** Seções aceitas sem prova neste `--write` (`--unproven-ok`). */
  unproven: string[];
}

/** `writeSentinel` com o detalhe do que foi aceito sem prova (#12398). */
export function writeSentinelDetailed(
  editionDir: string,
  bypassReason?: string,
  opts: WriteSentinelOptions = {},
): WriteSentinelResult {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) {
    throw new Error(`check-humanizer-social: 03-social.md não existe em ${editionDir}`);
  }
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const sentinelPath = join(internalDir, SENTINEL_FILENAME);

  // #12511: seletor de seção do --unproven-ok, validado contra o texto atual
  // antes de qualquer gravação (nome errado não pode virar "aceitou nada").
  let selected: Set<string> | undefined;
  if (opts.unprovenOkSections !== undefined) {
    const available = Object.keys(computeSectionHashes(readFileSync(socialPath, "utf8")));
    const { sections, unknown } = resolveSectionSelector(opts.unprovenOkSections, available);
    if (unknown.length > 0) throw new UnknownSectionSelectorError(unknown, available);
    selected = new Set(sections);
  }

  // Guard #2373: se sentinel anterior existe e hash diverge, exigir bypassReason
  // para evitar uso de --write como atalho que bypassa a humanização.
  let provenance: SectionProvenance[] | undefined;
  let unproven: string[] = [];
  let existing: HumanizerSocialSentinel | null = null;
  if (existsSync(sentinelPath)) {
    try {
      existing = JSON.parse(readFileSync(sentinelPath, "utf8")) as HumanizerSocialSentinel;
    } catch {
      // Sentinel corrompido — pode sobrescrever sem guard.
    }
    if (existing?.social_sha256) {
      const currentHash = computeSocialHash(socialPath);
      if (existing.social_sha256 !== currentHash && !bypassReason) {
        throw new Error(
          "check-humanizer-social: 03-social.md foi editado após a última humanização " +
          "(hash diverge) e --bypass-reason não foi fornecido. " +
          "Re-rodar o humanizador ANTES de --write, ou passar --bypass-reason se " +
          "o humanizador já rodou nesta sessão (#2373).",
        );
      }
      if (existing.social_sha256 !== currentHash) {
        // #11534: o motivo não é prova. Cada seção reescrita precisa ter passado
        // pelo humanizador e pela Clarice (registro `.humanizer-run.json`).
        const cls = classifySealChanges(existing, readFileSync(socialPath, "utf8"), readRunRecord(editionDir));
        provenance = cls.changed;
        unproven = cls.unproven;
        if (unproven.length > 0 && !opts.unprovenOk) {
          throw new UnprovenSectionsError(unproven, cls.changed);
        }
        // #12511: com seletor, só as seções nomeadas saem aceitas; o resto recusa.
        const notSelected = selected ? unproven.filter((s) => !selected.has(s)) : [];
        if (notSelected.length > 0) throw new UnprovenSectionsError(notSelected, cls.changed);
      }
    }
  }

  const socialMd = readFileSync(socialPath, "utf8");
  const record = readRunRecord(editionDir);
  const priorSeal = existing?.social_sha256 ? existing : null;
  // #12361: aceites sem prova (--unproven-ok, só formatação) por hash de conteúdo,
  // lidos pela invariante `social-humanizer-provenance-recorded` do Stage 2.
  const accepted = planAcceptedSectionHashes(priorSeal, socialMd, record, unproven, opts.unprovenOk);
  // #12398: com o selo já batendo com o texto (ou sem selo anterior), nada conta
  // como "mudou" e o aceite acima não pega nenhuma seção — o `--unproven-ok` que a
  // invariante do Stage 2 sugere saía exit 0 sem efeito. Aqui ele aceita as seções
  // que estão hoje sem prova dos dois passos no registro.
  // #12511: só as que o seletor nomeia. Sem seletor, recusa (antes aceitava TODAS,
  // e o guard do #12331 caía justo na 1ª gravação do Stage 2).
  if (opts.unprovenOk && provenance === undefined) {
    const candidates = planUnprovenOkWithoutChanges(socialMd, record, accepted);
    if (candidates.length > 0 && selected === undefined) {
      throw new UnprovenOkSectionRequiredError(candidates.map((s) => s.section));
    }
    for (const s of candidates) {
      if (!selected?.has(s.section)) continue;
      accepted[s.hash] = "unproven_ok";
      unproven.push(s.section);
    }
  }
  const sentinel: HumanizerSocialSentinel = {
    social_sha256: computeSocialHash(socialPath),
    written_at: new Date().toISOString(),
    section_hashes: computeSectionHashes(socialMd), // #3446
    section_format_hashes: computeSectionFormatHashes(socialMd), // #11534
    // #12383: selo novo compara os cards; selo que já existia sem eles continua sem
    // (edição em curso na transição não passa a exigir prova dos cards).
    ...(priorSeal === null || sealTracksCards(priorSeal) ? { cards_sections_tracked: true } : {}),
    ...(bypassReason ? { bypass_reason: bypassReason } : {}),
    ...(provenance ? { section_provenance: provenance } : {}),
    ...(unproven.length > 0 ? { unproven_sections: unproven, unproven_ok: opts.unprovenOk } : {}),
    ...(Object.keys(accepted).length > 0 ? { accepted_section_hashes: accepted } : {}),
  };
  writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + "\n", "utf8");
  return { path: sentinelPath, unproven };
}

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: "sentinel_missing" }
  | { ok: false; reason: "hash_mismatch"; stored: string; current: string };

/**
 * Verifica se o sentinel existe e o hash armazenado bate com `03-social.md` atual.
 *
 * Retorna um objeto estruturado — o caller (main / invariant check) decide
 * o exit code e a mensagem de erro.
 */
export function checkSentinel(editionDir: string): CheckResult {
  const socialPath = resolve(editionDir, "03-social.md");
  const sentinelPath = join(editionDir, "_internal", SENTINEL_FILENAME);

  if (!existsSync(sentinelPath)) {
    return { ok: false, reason: "sentinel_missing" };
  }

  // Se 03-social.md não existe mas o sentinel existe, isso é erro: Stage 2 já
  // rodou (sentinel prova isso) mas o arquivo sumiu (Drive pull falhou, etc.).
  if (!existsSync(socialPath)) {
    return { ok: false, reason: "sentinel_missing" };
  }

  let stored: HumanizerSocialSentinel;
  try {
    stored = JSON.parse(readFileSync(sentinelPath, "utf8")) as HumanizerSocialSentinel;
  } catch {
    return { ok: false, reason: "sentinel_missing" };
  }

  // Guard contra sentinel malformado: JSON parseou mas falta social_sha256.
  if (!stored?.social_sha256) {
    return { ok: false, reason: "sentinel_missing" };
  }

  const current = computeSocialHash(socialPath);
  if (stored.social_sha256 !== current) {
    return { ok: false, reason: "hash_mismatch", stored: stored.social_sha256, current };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// #3446: seções alteradas — habilita re-humanização SCOPED em vez de full-file
// ---------------------------------------------------------------------------

export interface ChangedSectionsResult {
  /**
   * true = sentinel armazenado não tem `section_hashes` (gravado antes do
   * #3446, ou primeiro `--write` desta sessão nunca rodou). Fail-safe:
   * caller deve tratar como "tudo mudou" e cair no fluxo full-file antigo —
   * nunca assumir escopo reduzido sem uma baseline por-seção confiável.
   */
  legacy: boolean;
  /** Nomes de seção cujo hash diverge do sentinel armazenado (vazio se `legacy`). */
  changed: string[];
}

/**
 * Compara os hashes por-seção do sentinel armazenado contra o `03-social.md`
 * atual, retornando exatamente quais seções mudaram desde a última
 * humanização — usado pelo Stage 4 (§4d.1) pra escopar a re-humanização
 * ao(s) destaque(s) de fato tocado(s) em vez do arquivo inteiro (#3446).
 *
 * Chamar apenas quando `checkSentinel` já indicou `hash_mismatch` — caso
 * contrário não há nada mudado para escopar.
 */
export function computeChangedSections(editionDir: string): ChangedSectionsResult {
  const socialPath = resolve(editionDir, "03-social.md");
  const sentinelPath = join(editionDir, "_internal", SENTINEL_FILENAME);

  if (!existsSync(sentinelPath) || !existsSync(socialPath)) {
    return { legacy: true, changed: [] };
  }

  let stored: HumanizerSocialSentinel;
  try {
    stored = JSON.parse(readFileSync(sentinelPath, "utf8")) as HumanizerSocialSentinel;
  } catch {
    return { legacy: true, changed: [] };
  }

  if (!stored.section_hashes) {
    return { legacy: true, changed: [] };
  }

  const current = computeSectionHashes(readFileSync(socialPath, "utf8"));
  const allNames = new Set([...Object.keys(stored.section_hashes), ...Object.keys(current)]);
  const tracksCards = sealTracksCards(stored);
  const changed: string[] = [];
  for (const name of allNames) {
    // #12383: selo anterior aos cards não tem o hash deles — não é mudança.
    if (!tracksCards && isCardsSection(name)) continue;
    if (stored.section_hashes[name] !== current[name]) changed.push(name);
  }
  return { legacy: false, changed };
}

// ---------------------------------------------------------------------------
// #2529: Tic lint on mismatch — roda quando hash diverge (social editado pós-humanização)
// ---------------------------------------------------------------------------

/**
 * Resultado do lint de tics de IA sobre o social editado pós-humanizador.
 * WARN-ONLY: `tics_found` informa se há tics; não bloqueia o gate por si só.
 * O hash mismatch (exit 2) já é o sinal de bloqueio — o tic lint é informativo,
 * dando ao editor mais contexto para decidir se re-humaniza.
 */
export interface TicLintResult {
  /** true = lint rodou sem erros (tics pode existir ainda — ver `tics_found`). */
  ok: true;
  /** Se algum tic determinístico foi detectado no social editado. */
  tics_found: boolean;
  /** Matches de antítese-revelação detectados (pode estar vazio). */
  antithesis_matches: AntithesisRevealMatch[];
  /** Matches de gancho editorial emendado via ", e" (#2658 — pode estar vazio). */
  trailing_hook_matches: TrailingEditorialHookMatch[];
}

/**
 * #2529: roda lint de tics determinísticos sobre o `03-social.md` editado.
 * Chamado internamente pelo `--check` quando o hash diverge (exit 2).
 *
 * Usa os tic checks WARN-ONLY de lint-social-md.ts que cobrem construções de IA
 * e rodam sobre qualquer conteúdo do MD: `lintAntithesisReveal` (#2526) e
 * `lintTrailingEditorialHook` (#2658). Travessões e anglicismos não têm
 * equivalente check em lint-social-md.ts (os existentes são de CTA e schema),
 * então não incluídos (#2529 decisão).
 */
export function lintTicsOnMismatch(socialPath: string): TicLintResult {
  if (!existsSync(socialPath)) {
    return { ok: true, tics_found: false, antithesis_matches: [], trailing_hook_matches: [] };
  }
  const md = readFileSync(socialPath, "utf8");
  const antithesisResult = lintAntithesisReveal(md);
  const hookResult = lintTrailingEditorialHook(md);
  const tics_found = antithesisResult.matches.length > 0 || hookResult.matches.length > 0;
  return {
    ok: true,
    tics_found,
    antithesis_matches: antithesisResult.matches,
    trailing_hook_matches: hookResult.matches,
  };
}

/**
 * Loga o resultado do tic lint via `scripts/log-event.ts` (fire-and-forget).
 * Falha silenciosa — o lint result já foi emitido no stderr.
 */
function logTicLintEvent(editionDir: string, result: TicLintResult): void {
  // Extrair AAMMDD do editionDir (último componente sem trailing slash)
  const normalized = editionDir.replace(/[/\\]+$/, "");
  const edition = normalized.split(/[/\\]/).pop() ?? "unknown";
  const logScriptPath = resolve(ROOT, "scripts/log-event.ts");
  if (!existsSync(logScriptPath)) return; // defensive — skip em testes sem scripts/

  const level = result.tics_found ? "warn" : "info";
  const message = result.tics_found
    ? `social_tic_lint: hash diverge E tics detectados (${result.antithesis_matches.length} antítese-revelação, ${result.trailing_hook_matches.length} gancho-editorial) — considerar re-humanizar`
    : "social_tic_lint: hash diverge mas sem tics detectados — edição pode ser só remoção de tic";

  const details = JSON.stringify({
    tics_found: result.tics_found,
    antithesis_count: result.antithesis_matches.length,
    trailing_hook_count: result.trailing_hook_matches.length,
    kind: "humanizer_social_tic_lint",
  });

  try {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", logScriptPath,
        "--edition", edition,
        "--stage", "4",
        "--agent", "check-humanizer-social",
        "--level", level,
        "--message", message,
        "--details", details,
      ],
      { encoding: "utf8", stdio: "ignore" },
    );
    // Surface spawn errors (e.g. tsx resolver failure on Windows) without breaking prod.
    if (r.error) {
      console.warn(`[check-humanizer-social] logTicLintEvent: spawn falhou — ${r.error.message} (tic log perdido)`);
    } else if (r.status !== 0 && r.status !== null) {
      console.warn(`[check-humanizer-social] logTicLintEvent: log-event.ts saiu com status ${r.status} (tic log pode estar incompleto)`);
    }
  } catch (e: unknown) {
    // fire-and-forget: never block on log failure
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[check-humanizer-social] logTicLintEvent: erro inesperado — ${msg} (tic log perdido)`);
  }
}

export interface SealAcceptance {
  /** Seção do texto atual → por que o selo a aceitou sem prova dos dois passos. */
  bySection: Record<string, AcceptedSectionReason>;
  /** Seções aceitas via `--unproven-ok` (subconjunto de `bySection`). */
  unprovenSections: string[];
}

/**
 * #12377 item 2: o que o `--provenance` marca como aceito. Lê
 * `accepted_section_hashes` (#12361, endereçado por conteúdo) com o mesmo
 * critério da invariante `social-humanizer-provenance-recorded`: só vale com o
 * selo batendo com o `03-social.md` atual. Selo anterior ao #12361 (sem
 * `accepted_section_hashes`) cai no `unproven_sections` por nome, como antes.
 */
export function describeSealAcceptance(seal: HumanizerSocialSentinel | null, socialMd: string): SealAcceptance {
  const bySection: Record<string, AcceptedSectionReason> = {};
  if (seal) {
    const acc = seal.accepted_section_hashes;
    if (acc && typeof acc === "object") {
      if (seal.social_sha256 === hashSocialContent(socialMd)) {
        for (const [section, hash] of Object.entries(computeSectionHashes(socialMd))) {
          const reason = acc[hash];
          if (reason === "formatting" || reason === "unproven_ok") bySection[section] = reason;
        }
      }
    } else {
      for (const s of seal.unproven_sections ?? []) bySection[s] = "unproven_ok";
    }
  }
  return {
    bySection,
    unprovenSections: Object.entries(bySection)
      .filter(([, r]) => r === "unproven_ok")
      .map(([s]) => s),
  };
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];

  if (!editionDirArg) {
    console.error(
      "Uso: check-humanizer-social.ts [--write|--check|--record-run|--provenance] --edition-dir data/editions/AAMMDD/ " +
        "[--bypass-reason <motivo>] [--unproven-ok <motivo> [--unproven-ok-section d2,...]] [--step humanizador|clarice --pre <arq> --post <arq> [--sections a,b] [--note <motivo>]]",
    );
    process.exit(1);
  }

  const editionDir = resolve(ROOT, editionDirArg);
  const bypassReason = values["bypass-reason"];
  const unprovenOk = values["unproven-ok"];
  // #12511: seções aceitas pelo --unproven-ok (`main_d2` ou `d2`, vírgula separa).
  const unprovenOkSectionsArg = values["unproven-ok-section"];
  const unprovenOkSections = unprovenOkSectionsArg?.split(",").map((s) => s.trim()).filter(Boolean);
  if (unprovenOkSectionsArg !== undefined && !unprovenOk) {
    console.error("[check-humanizer-social] ERRO: --unproven-ok-section só vale junto com --unproven-ok \"<motivo>\" (#12511).");
    process.exit(1);
  }

  if (flags.has("record-run")) {
    const step = values["step"];
    const pre = values["pre"];
    const post = values["post"];
    if ((step !== "humanizador" && step !== "clarice") || !pre || !post) {
      console.error("Uso: --record-run --step humanizador|clarice --pre <arquivo> --post <arquivo> [--sections a,b] [--note <motivo>] --edition-dir DIR");
      process.exit(1);
    }
    const note = values["note"]?.trim() || undefined;
    if (note && step === "humanizador") {
      // #11609: snapshots idênticos não provam o humanizador nem com motivo — o caminho é --unproven-ok no --write.
      console.error(
        "[check-humanizer-social] ERRO: --note só vale para --step clarice (#11674). Humanizador que devolveu tudo idêntico " +
          'não gera prova (#11609); use --unproven-ok "<motivo>" no --write.',
      );
      process.exit(1);
    }
    const prePath = resolve(ROOT, pre);
    const postPath = resolve(ROOT, post);
    if (!existsSync(prePath) || !existsSync(postPath)) {
      console.error(`[check-humanizer-social] ERRO: arquivo ausente — pre=${existsSync(prePath)} post=${existsSync(postPath)}`);
      process.exit(1);
    }
    const sections = values["sections"]?.split(",").map((s) => s.trim()).filter(Boolean);
    const plan = planRunRecord(
      readRunRecord(editionDir),
      step as RunStep,
      readFileSync(prePath, "utf8"),
      readFileSync(postPath, "utf8"),
      sections,
      { note },
    );
    if (plan.noop && step === "clarice" && !note) {
      // #11674: recusa sem gravar — --pre igual a --post não prova que a Clarice rodou.
      console.error(
        "[check-humanizer-social] RECUSADO — --pre e --post são idênticos em todo o escopo: nada prova que a Clarice rodou. " +
          'Se ela rodou e não sugeriu nada, repita com --note "<motivo>" (fica gravado no run e aparece como ' +
          '"sem sugestões" no --provenance). Nada foi gravado (#11674).',
      );
      for (const s of plan.skipped) {
        console.error(`[check-humanizer-social] sem prova (${step}): ${s.section} — ${s.reason}`);
      }
      console.log(JSON.stringify({ ok: false, step, reason: "noop_without_note", recorded: [], skipped: plan.skipped }));
      process.exit(1);
    }
    if (note && !plan.noop) {
      console.error("[check-humanizer-social] WARN: --note ignorado — houve mudança entre --pre e --post (#11674).");
    }
    const recordPath = writeRunRecord(editionDir, plan.record);
    for (const s of plan.skipped) {
      console.error(`[check-humanizer-social] sem prova (${step}): ${s.section} — ${s.reason}`);
    }
    console.log(JSON.stringify({ ok: true, step, record_path: recordPath, recorded: plan.recorded, skipped: plan.skipped }));
    process.exit(0);
  }

  if (flags.has("provenance")) {
    const socialPath = resolve(editionDir, "03-social.md");
    if (!existsSync(socialPath)) {
      console.error(`[check-humanizer-social] ERRO: 03-social.md não existe em ${editionDir}`);
      process.exit(1);
    }
    const socialMd = readFileSync(socialPath, "utf8");
    const rows = describeProvenance(socialMd, readRunRecord(editionDir));
    let seal: HumanizerSocialSentinel | null = null;
    const sentinelPath = join(editionDir, "_internal", SENTINEL_FILENAME);
    if (existsSync(sentinelPath)) {
      try {
        seal = JSON.parse(readFileSync(sentinelPath, "utf8")) as HumanizerSocialSentinel;
      } catch (e) {
        console.error(`[check-humanizer-social] WARN: selo ilegível (${(e as Error).message}) — unproven_sections não listadas`);
      }
    }
    const acceptance = describeSealAcceptance(seal, socialMd);
    const unprovenSections = acceptance.unprovenSections;
    for (const r of rows) {
      const reason = acceptance.bySection[r.section];
      const extra =
        reason === "unproven_ok"
          ? " · aceita sem prova (--unproven-ok)"
          : reason === "formatting"
            ? " · aceita (só formatação sobre texto provado)"
            : "";
      const kept = r.kept ? " (texto mantido)" : ""; // #11604
      const claricePlain = r.clarice_unchanged ? " (sem sugestões, --note)" : ""; // #11674
      console.error(
        `  ${r.section}: humanizador ${r.humanizador ? "sim" : "NÃO"}${kept} · Clarice ${r.clarice ? "sim" : "NÃO"}${claricePlain}${extra}`,
      );
    }
    console.log(JSON.stringify({
      ok: true,
      sections: rows,
      unproven_sections: unprovenSections,
      accepted_sections: acceptance.bySection,
    }));
    process.exit(0);
  }

  if (flags.has("write")) {
    try {
      const { path, unproven } = writeSentinelDetailed(editionDir, bypassReason, { unprovenOk, unprovenOkSections });
      const out: Record<string, unknown> = { ok: true, sentinel_path: path };
      if (bypassReason) out["bypass_reason"] = bypassReason;
      if (unproven.length > 0) {
        out["unproven_sections"] = unproven;
        console.error(`[check-humanizer-social] aceitas sem prova (--unproven-ok): ${unproven.join(", ")}`);
      } else if (unprovenOk) {
        console.error("[check-humanizer-social] --unproven-ok: nenhuma seção sem prova a aceitar.");
      }
      console.log(JSON.stringify(out));
      process.exit(0);
    } catch (e) {
      if (e instanceof UnprovenSectionsError) {
        console.error(`[check-humanizer-social] PROVA AUSENTE — ${e.message}`);
        console.log(JSON.stringify({ ok: false, reason: "unproven_sections", unproven_sections: e.sections, provenance: e.provenance }));
        process.exit(4);
      }
      if (e instanceof UnprovenOkSectionRequiredError) {
        // #12511: exit 5 — --unproven-ok sem mudança desde o selo pede o seletor.
        console.error(`[check-humanizer-social] SELETOR AUSENTE — ${e.message}`);
        console.log(JSON.stringify({ ok: false, reason: "unproven_ok_section_required", candidates: e.candidates }));
        process.exit(5);
      }
      if (e instanceof UnknownSectionSelectorError) {
        console.error(`[check-humanizer-social] SELETOR INVÁLIDO — ${e.message}`);
        console.log(JSON.stringify({ ok: false, reason: "unknown_section", unknown: e.unknown, available: e.available }));
        process.exit(1);
      }
      const msg = (e as Error).message;
      if (msg.includes("hash diverge") || msg.includes("--bypass-reason")) {
        // Guard #2373: hash diverge sem bypass-reason — exit 3 (distinguível de I/O errors)
        console.error(`[check-humanizer-social] BYPASS REQUIRED — ${msg}`);
        process.exit(3);
      }
      console.error(`[check-humanizer-social] ERRO ao gravar sentinel: ${msg}`);
      process.exit(1);
    }
  } else if (flags.has("check")) {
    try {
      const result = checkSentinel(editionDir);
      if (result.ok) {
        console.log(JSON.stringify({ ok: true }));
        process.exit(0);
      }
      if (result.reason === "sentinel_missing") {
        console.error(
          "[check-humanizer-social] FAIL — sentinel ausente: humanizador não rodou no social " +
          "ou 03-social.md foi editado e sentinel não foi atualizado. " +
          "Re-rodar humanizador e gravar sentinel com --write.",
        );
        process.exit(1);
      }
      if (result.reason === "hash_mismatch") {
        console.error(
          "[check-humanizer-social] FAIL — 03-social.md mudou após humanização (hash diverge). " +
          `stored=${result.stored.slice(0, 12)}… current=${result.current.slice(0, 12)}… ` +
          "Re-humanizar 03-social.md e gravar sentinel com --write.",
        );

        // #2529: lint de tics de IA sobre o social editado (WARN-ONLY, não bloqueia além do exit 2)
        const socialPath = resolve(editionDir, "03-social.md");
        const ticResult = lintTicsOnMismatch(socialPath);
        if (ticResult.tics_found) {
          console.error(
            `[check-humanizer-social] ⚠️  TICS DE IA DETECTADOS no social editado pós-humanizador (#2529):`,
          );
          for (const m of ticResult.antithesis_matches) {
            console.error(`  linha ${m.line} [antítese-revelação/${m.pattern}]: "...${m.context}..."`);
          }
          for (const m of ticResult.trailing_hook_matches) {
            console.error(`  linha ${m.line} [gancho-editorial/, e]: "...${m.context}..."`);
          }
          console.error(
            "[check-humanizer-social] ⚠️  Considere re-humanizar antes de aprovar o gate.",
          );
        } else {
          console.error(
            "[check-humanizer-social] ℹ️  Lint de tics: nenhum tic detectado na edição — " +
            "a edição pode ter sido apenas remoção de tic (#2529).",
          );
        }

        // Logar decisão no run-log para rastreabilidade (#2529)
        logTicLintEvent(editionDir, ticResult);

        // #3446: reportar EXATAMENTE quais seções mudaram — permite ao orchestrator
        // escopar a re-humanização ao(s) destaque(s) tocado(s) em vez do arquivo inteiro.
        const changedSections = computeChangedSections(editionDir);
        if (changedSections.legacy) {
          console.error(
            "[check-humanizer-social] ℹ️  Sentinel sem section_hashes (legacy, pré-#3446) — " +
            "sem baseline por-seção confiável. Re-humanizar 03-social.md INTEIRO (fallback seguro).",
          );
        } else {
          console.error(
            `[check-humanizer-social] SEÇÕES ALTERADAS (re-humanizar apenas estas): ${changedSections.changed.join(", ") || "(nenhuma — hash mismatch veio de fora das seções conhecidas)"}`,
          );
        }
        console.log(JSON.stringify({
          ok: false,
          reason: "hash_mismatch",
          legacy: changedSections.legacy,
          changed_sections: changedSections.changed,
        }));

        process.exit(2);
      }
      // Exhaustiveness guard — should never reach here
      console.error("[check-humanizer-social] INTERNAL ERROR: unhandled CheckResult");
      process.exit(1);
    } catch (e) {
      console.error(`[check-humanizer-social] ERRO no check: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error("Especifique --write ou --check.");
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
