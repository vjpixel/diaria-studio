/**
 * Invariantes do Stage 4 — conteúdo da newsletter (contagem, itens, títulos, intake, template) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findUnknownTemplateMarkers,
  findClosingCreditsLines,
} from "../../lint-checks/reviewed-md-template-leaks.ts"; // #13252
import type { InvariantViolation } from "../types.ts";
import { readMarker } from "../../pipeline-state.ts";
import { computeIntakeFingerprint } from "../../newsletter-intake-fingerprint.ts"; // #12188
import { linkScoreBlocks, linkTitleBlocks } from "../../newsletter-intake-link-rules.ts"; // #12593
import { lintIntroCount, countSelectedItems } from "../../newsletter-count.ts";
import { findLancamentosSemFabricante } from "../../lancamento-maker.ts"; // #12595
import { MAX_EDITION_CONTENT_ITEMS } from "../../apply-stage2-caps.ts"; // #9785
import {
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
} from "../../lint-checks/title-normalization.ts";
import { checkNoTrailingEllipsis } from "../../lint-checks/no-trailing-ellipsis.ts";
import { checkTitleMentionsIA } from "../../lint-checks/ia-in-title.ts"; // #4825
import { checkTitleIaAsAgent } from "../../lint-checks/title-ia-as-agent.ts"; // #12106
import {
  checkD1ShortsFrontLoad,
  formatShortsFrontLoadWarning,
} from "../../lint-checks/title-shorts-front-load.ts"; // #12464
import { isTruncatedSummary } from "../../truncated-summary.ts";
import { sectionHeaderRegex } from "../../section-naming.ts";
import {
  INLINE_LINK_ONLY_RE,
  URL_WITH_BALANCED_PARENS_RE_PART,
} from "../../lint-checks/section-item-format.ts";
import { canonicalize } from "../../url-utils.ts";
import { ROOT } from "./_shared.ts";

/**
 * #1578: garante que intro line "Selecionamos os Z mais relevantes" bate com
 * a contagem real de items visíveis no `02-reviewed.md`. Stage 2 já tem este
 * lint, mas editor pode reorder / editar mid-Stage 4 (Drive pull, manual
 * tweak) e re-introduzir mismatch.
 *
 * Caso 260529: intro saiu "6 mais relevantes" quando real era 11 — bug em
 * countSelectedItems + edição editorial mid-stage. Sem re-check em stage 4,
 * email final foi enviado com mismatch.
 */
export function checkIntroCountConsistent(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = lintIntroCount(md);
  if (result.ok) return [];
  return [
    {
      rule: "intro-count-consistent",
      message:
        `intro line declara ${result.claimed} items mas contagem real é ${result.actual}. ` +
        `Fix manual: editar "Selecionamos os ${result.claimed}" → "Selecionamos os ${result.actual}" ` +
        `em ${path}. Re-rodar sync-coverage-line só se quiser também recomputar X/Y ` +
        `(consome tmp-articles-raw.json — pode mudar mais que Z).`,
      source_issue: "#1578",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #9785: o rascunho que chega ao Gate 4 tem no máximo 13 conteúdos
 * (`MAX_EDITION_CONTENT_ITEMS`) — destaques + USE MELHOR + LANÇAMENTOS + RADAR
 * (+ VÍDEOS). Contagem pela fonte única `countSelectedItems` (a mesma do
 * `intro-count-consistent`), que já ignora É IA?, sorteio, erro intencional,
 * boxes e rodapé. O corte de fato acontece cedo, no `apply-stage2-caps.ts`
 * (Stage 2, por score); este guard acusa o que escapou dele — itens pinados
 * pelo editor que estouram sozinhos, ou conteúdo inserido depois do Stage 2.
 *
 * severity: warning — entra no `{violations_block}` do gate e nunca pausa: o
 * corte que falta é escolha editorial do editor, no próprio gate (pausar aqui
 * travaria `--no-gates` sem nada que o pipeline pudesse consertar sozinho).
 */
export function checkMaxContentItems(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const counts = countSelectedItems(readFileSync(path, "utf8"));
  if (counts.total <= MAX_EDITION_CONTENT_ITEMS) return [];
  return [
    {
      rule: "max-content-items",
      message:
        `rascunho com ${counts.total} conteúdos, teto é ${MAX_EDITION_CONTENT_ITEMS} (#9785) — ` +
        `destaques=${counts.destaques}, use_melhor=${counts.use_melhor}, lançamentos=${counts.lancamentos}, ` +
        `radar=${counts.radar + counts.pesquisas}, vídeos=${counts.videos}. Cortar ${counts.total - MAX_EDITION_CONTENT_ITEMS} ` +
        `item(ns) no gate (menor score primeiro; o corte automático do Stage 2 não remove itens pinados pelo editor).`,
      source_issue: "#9785",
      severity: "warning",
      file: path,
    },
  ];
}

/**
 * #2596: detecta itens de seção secundária (LANÇAMENTOS/RADAR/USE MELHOR)
 * cuja descrição vem truncada de `og:description` — terminando em reticências
 * (…/...) com palavra pendente (conjunção/preposição/artigo) antes delas.
 *
 * Ação: warning (não bloqueante). O editor decide se reescreve a descrição ou
 * aceita o item assim. Alinhado ao padrão "flag não DROP" do repo.
 *
 * Seções É IA? e VÍDEOS são excluídas — formato próprio sem descrição inline.
 */
const TARGET_SECONDARY_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

const ANY_SECTION_HEADER_RE_S4 = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|V[ÍI]DEOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|DESTAQUES?`,
  { capture: "none", flags: "u" },
);

// Formato canônico (link + descrição na mesma linha) com captura da descrição.
// Usa URL_WITH_BALANCED_PARENS_RE_PART (#2413/#2596) pra tolerar URLs Wikipedia
// `/wiki/X_(model)` — `[^\s)]+` simples pararia no 1º `)` e o item escaparia o check.
const INLINE_LINK_WITH_TEXT_RE = new RegExp(
  String.raw`^\s*\*{0,2}\s*\[[^\]]+\]\(${URL_WITH_BALANCED_PARENS_RE_PART}\)\*{0,2}\s+(.+)$`,
  "u",
);

export function checkTruncatedSecondaryItemSummary(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  const violations: InvariantViolation[] = [];
  let currentSection: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (TARGET_SECONDARY_SECTION_RE.test(t)) {
      currentSection = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      continue;
    }
    if (ANY_SECTION_HEADER_RE_S4.test(t) || /^(?:\*\*)?DESTAQUE\s+\d+/.test(t)) {
      currentSection = null;
      continue;
    }
    if (t === "---") {
      currentSection = null;
      continue;
    }
    if (!currentSection) continue;

    // Formato canônico: link + texto na mesma linha — checar texto inline
    const inlineMatch = raw.match(INLINE_LINK_WITH_TEXT_RE);
    if (inlineMatch) {
      const desc = inlineMatch[1].trim();
      if (isTruncatedSummary(desc)) {
        violations.push({
          rule: "truncated-secondary-item-summary",
          message:
            `Seção ${currentSection} linha ${i + 1}: descrição parece truncada (termina em reticências ` +
            `com palavra pendente): "${desc.slice(-60)}". ` +
            `Origem provável: og:description truncada na fonte. ` +
            `Fix: reescrever a descrição ou aceitar o item com ressalva editorial.`,
          source_issue: "#2596",
          severity: "warning",
          file: path,
          line: i + 1,
        });
      }
      continue;
    }

    // Formato de 2 linhas: link sozinho + próxima linha é a descrição
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        const descLine = lines[j].trim();
        // Só checar se a próxima linha é texto simples (não é outro link nem header)
        if (
          descLine &&
          !INLINE_LINK_ONLY_RE.test(lines[j]) &&
          !ANY_SECTION_HEADER_RE_S4.test(descLine) &&
          descLine !== "---"
        ) {
          if (isTruncatedSummary(descLine)) {
            violations.push({
              rule: "truncated-secondary-item-summary",
              message:
                `Seção ${currentSection} linha ${j + 1}: descrição parece truncada (termina em reticências ` +
                `com palavra pendente): "${descLine.slice(-60)}". ` +
                `Origem provável: og:description truncada na fonte. ` +
                `Fix: reescrever a descrição ou aceitar o item com ressalva editorial.`,
              source_issue: "#2596",
              severity: "warning",
              file: path,
              line: j + 1,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * #2693 item 3: registro dos 2 lints de título (#2664 sufixo de veículo,
 * #2672 ponto final) em `invariant-checks/`. Antes rodavam como invocação
 * CLI separada no pré-gate (`orchestrator-stage-4.md` §4c.2, #14033) (`lint-newsletter-md.ts --check
 * title-publisher-suffix`/`title-trailing-period`) — funcionais, mas fora do
 * registry, então invisíveis em `docs/editorial-invariants.md`. Severity
 * "warning" preserva o comportamento atual (backstop deliberadamente amplo,
 * WARN-ONLY — ver docstring de `checkTitlePublisherSuffix`/
 * `checkTitleTrailingPeriod` em lint-checks/title-normalization.ts).
 * A invocação CLI direta no orchestrator continua existindo (não removida
 * nesta passada) — este registro é só pra visibilidade/doc-gen.
 *
 * #2715 item 3: até aqui, a invocação CLI (`lint-newsletter-md.ts --check
 * title-publisher-suffix`/`title-trailing-period`) saía com `process.exit(1)`
 * + `❌` em caso de match — inconsistente com a doc WARN-ONLY acima e com a
 * severity "warning" deste registry, podendo levar o orchestrator LLM a
 * bloquear o gate indevidamente ao ver exit não-zero. O CLI foi corrigido pra
 * sempre sair 0 (`⚠️` em vez de `❌`), alinhado a este registry.
 */
export function checkTitlePublisherSuffixInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkTitlePublisherSuffix(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "title-publisher-suffix",
    message:
      `Título com sufixo de veículo residual (linha ${e.line}): "${e.title}" ` +
      `(separador ${e.separator}, sufixo "${e.suffix}"). ` +
      `Verificar se é veículo real ou falso-positivo (backstop amplo, sem allowlist) — ` +
      `ver docstring de checkTitlePublisherSuffix.`,
    source_issue: "#2664",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

export function checkTitleTrailingPeriodInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkTitleTrailingPeriod(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "title-trailing-period",
    message:
      `Título termina com ponto final único (linha ${e.line}): "${e.title}". ` +
      `Manchetes não terminam em ponto — remover manualmente se não for reticências.`,
    source_issue: "#2672",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

/**
 * #4825: título de DESTAQUE menciona "IA"/"AI"/"inteligência artificial".
 * WARN-ONLY por decisão do editor — há exceções legítimas (manchete sobre a
 * categoria em si, ambiguidade real, nome próprio/citação/nome de produto,
 * ver `context/editorial-rules.md` seção 5) frequentes o bastante pra um
 * lint bloqueante virar atrito toda edição. Ver docstring de
 * `checkTitleMentionsIA` em `lint-checks/ia-in-title.ts` pro racional
 * completo e o escopo (só títulos de DESTAQUE, não seções secundárias).
 */
export function checkTitleMentionsIaInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkTitleMentionsIA(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "title-mentions-ia",
    message:
      `DESTAQUE ${e.destaque} (${e.category}) linha ${e.line}: título menciona "${e.matched}": "${e.title}". ` +
      `A newsletter é sobre IA — o termo raramente carrega informação nova no título; prefira nomear o agente ` +
      `concreto (empresa, modelo, produto). Exceção legítima? Ver context/editorial-rules.md seção 5.`,
    source_issue: "#4825",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

/**
 * #12106: título de DESTAQUE põe "IA" como sujeito que age ("IA usa seu
 * rosto") quando o corpo descreve um ator humano (criminosos, golpistas...).
 * WARN-ONLY: heurística léxica, ver `lint-checks/title-ia-as-agent.ts`.
 */
export function checkTitleIaAsAgentInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkTitleIaAsAgent(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "title-ia-as-agent",
    message:
      `DESTAQUE ${e.destaque} (${e.category}) linha ${e.line}: título põe "IA" como sujeito ("IA ${e.verb}…"), ` +
      `mas o corpo cita "${e.humanActor}": "${e.title}". Quem age é o humano; a IA é o instrumento ` +
      `(ex.: "criminosos usam IA para copiar seu rosto"). Ver context/editorial-rules.md seção 3.`,
    source_issue: "#12106",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

/**
 * #12464: o título do D1 é o título do Short, e o feed de Shorts no celular
 * mostra só os primeiros ~40 caracteres. Acusa a fatia visível que não se lê
 * sozinha (termina em palavra de ligação ou tem menos de 2 palavras).
 * WARN-ONLY: a regra é front-load, não teto (o teto do D1 segue 70).
 */
export function checkTitleShortsFrontLoadInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const result = checkD1ShortsFrontLoad(readFileSync(path, "utf8"));
  if (result.ok) return [];
  return result.errors.map((w) => ({
    rule: "title-shorts-front-load",
    message: `${formatShortsFrontLoadWarning(w)}. Ver context/editorial-rules.md seção 3.`,
    source_issue: "#12464",
    severity: "warning",
    file: path,
  }));
}

/**
 * #2881: backstop pra `sanitizeTrailingEllipsis` (roda em `enrich-inbox-
 * articles.ts`, Stage 1). Diferente de `checkTruncatedSecondaryItemSummary`
 * (#2596, que só flagra quando o texto ANTES da reticência parece ter
 * "palavra pendente" e tem carve-outs para idiomas de suspense/fechamento
 * intencional), este check é deliberadamente MAIS AMPLO: QUALQUER descrição
 * de item secundário terminando em `…`/`...` é flagrada, sem exceção — a
 * regra do #2881 é "nunca publicar descrição terminando em reticência".
 * Ambos os checks podem disparar na mesma linha; isso é esperado (registros
 * independentes, WARN-ONLY).
 */
export function checkNoTrailingEllipsisInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkNoTrailingEllipsis(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "no-trailing-ellipsis",
    message:
      `Seção ${e.section} linha ${e.line}: descrição do item "${e.titleExcerpt}" termina em reticências ` +
      `("...${e.descriptionExcerpt}"). Provável causa: a fonte truncou a própria meta-description com "…" ` +
      `e ela vazou verbatim — não é truncamento nosso. Fix: reescrever a descrição em ` +
      `02-reviewed.md antes de aprovar.`,
    source_issue: "#2881",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

/**
 * #12188: independent backstop when the gate skipped the deterministic audit.
 *
 * Princípio: a auditoria nunca bloqueia a publicação por algo que o pipeline
 * não controla. `error` só para o que o pipeline deixou de fazer (relatório
 * ausente/desatualizado com threads a auditar, link no pool sem score/título
 * sem tentativa registrada). Falha de fetch/enrich registrada (paywall, 403,
 * challenge) e link removido antes do pool (dedup/data — score ali é só
 * auditoria) viram `warning`. Os warnings do relatório (pendentes, descoberta
 * falhou, capture_failed) saem sempre, independente da contagem de threads.
 * #12593: "pool" é o `tmp-scoring-pool.json` (o que foi ao scorer), não o bruto
 * pré-dedup; e título placeholder de link já pontuado e fora da edição é warning.
 */
export function checkNewsletterIntake(editionDir: string): InvariantViolation[] {
  const internal = resolve(editionDir, "_internal");
  const captured = resolve(internal, "captured-newsletters.json");
  const reportPath = resolve(internal, "newsletter-link-scores.json");
  const violation = (message: string, severity: "warning" | "error"): InvariantViolation => ({
    rule: "newsletter-intake", source_issue: "#12188", message, severity, file: reportPath,
  });
  const traces = [captured, reportPath, resolve(internal, ".capture-newsletter-failed.json"), resolve(internal, "captured-newsletters.json.fetch.jsonl")];
  // Captura nunca rodou nesta edição (auto-capture desligado, edição antiga): nada a auditar.
  if (!traces.some((p) => existsSync(p))) return [];
  let threadCount = 0;
  if (existsSync(captured)) {
    try {
      const threads = JSON.parse(readFileSync(captured, "utf8"));
      if (!Array.isArray(threads)) return [violation("Captura de newsletters ilegível", "error")];
      threadCount = threads.length;
    } catch (error) {
      return [violation(`Captura de newsletters ilegível (${error instanceof Error ? error.message : String(error)})`, "error")];
    }
  }
  if (!existsSync(reportPath)) {
    return [violation("Intake ausente: rodar audit-newsletter-intake.ts antes do gate", threadCount > 0 ? "error" : "warning")];
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      links: Array<{url?: string; score: number | null; title?: string; fetch_error?: string; in_pool?: boolean | null; destino?: string}>;
      rows: Array<{thread_id: string}>; warnings: string[]; pending_senders: string[];
      input_fingerprint?: string; registry_path?: string; fingerprint_keys?: string[];
    };
    if (!Array.isArray(report.links) || !Array.isArray(report.rows) || !Array.isArray(report.warnings) || !Array.isArray(report.pending_senders)) throw new Error("shape inválido");
    const out: InvariantViolation[] = report.warnings.map((w) => violation(w, "warning"));
    // #12188/#12593: mesmas regras de `audit-newsletter-intake.ts` (lib compartilhada, sem importar o CLI).
    if (report.links.some(linkScoreBlocks)) out.push(violation("Links IA sem score: pontuar newsletter-unscored.json e re-rodar auditoria", "error"));
    if (report.links.some(linkTitleBlocks)) out.push(violation("Links IA sem título: enriquecer newsletter-unscored.json e re-rodar auditoria", "error"));
    if (report.pending_senders.length) out.push(violation(`Remetentes pendentes de decisão em lote: ${report.pending_senders.join(", ")}`, "warning"));
    // #12188 item 7: content hash of the audit inputs, never mtime — a save
    // that keeps the links (Studio, refresh-use-melhor-tempo, sync-code) is not stale.
    // Registro relativo resolve contra o seed LOCAL (path absoluto de outra máquina não existe aqui).
    const registryPath = resolve(ROOT, typeof report.registry_path === "string" ? report.registry_path : "seed/newsletter-senders.json");
    const keys = Array.isArray(report.fingerprint_keys) ? report.fingerprint_keys
      : report.links.flatMap((l) => typeof l.url === "string" ? [canonicalize(l.url).toLowerCase()] : []);
    if (report.input_fingerprint !== computeIntakeFingerprint(editionDir, registryPath, keys)) out.push(violation("Intake desatualizado: re-rodar audit-newsletter-intake.ts para atualizar scores e destinos", "error"));
    return out;
  } catch (error) {
    return [violation(`Relatório de intake ilegível (${error instanceof Error ? error.message : String(error)}): re-rodar audit-newsletter-intake.ts`, "error")];
  }
}

/**
 * #2878: quando `scripts/fetch-newsletter-threads.ts` (Stage 0 passo 0b-bis)
 * falha por auth/rede, `inject-inbox-urls.ts` grava `capture_failed: true`
 * (+ `capture_error`) em `.marker-inject-inbox-urls.json` em vez de deixar
 * `captured_newsletter_count: 0` indistinguível de "editor genuinamente não
 * enviou newsletter nenhuma". `sync-coverage-line.ts` (Stage 2) já troca a
 * linha "Para esta edição..." por um aviso quando vê esse sinal — este check
 * é a segunda barreira, gate-blocking, pra garantir que a edição não segue
 * pro publish com a contagem de submissões subrepresentada e sem que o
 * editor tenha visto o aviso (ex: editor editou 02-reviewed.md no Drive e
 * apagou a linha de aviso sem perceber o que ela significava).
 *
 * Caso real: 260703, 2º dia seguido com `invalid_client` — coverage line
 * saiu "0 submissões" quando a captura simplesmente falhou.
 */
export function checkCaptureFailedSubmissionCount(editionDir: string): InvariantViolation[] {
  const marker = readMarker(editionDir, "inject-inbox-urls");
  // #2878 self-review LOW: accept both the nested `details` shape (how
  // `writeMarker` stores it in prod) and a top-level shape, matching
  // `readCaptureFailedFromMarker` (sync-coverage-line, padrão #1476) — the two
  // readers must not diverge on which marker shape they honour.
  const details = (marker?.details ?? marker) as
    | { capture_failed?: boolean; capture_error?: string }
    | undefined;
  if (!details?.capture_failed) return [];
  return [
    {
      rule: "capture-failed-submission-count",
      message:
        `Captura de newsletters (Stage 0 passo 0b-bis) falhou: ${details.capture_error ?? "motivo desconhecido"}. ` +
        `A contagem de submissões da coverage line não é confiável (pode estar subcontada). ` +
        `Reautenticar (ver data/.credentials.json / scripts/oauth-setup.ts) e re-rodar 0b-bis → ` +
        `inject-inbox-urls (Stage 1) → sync-coverage-line (Stage 2) antes de publicar.`,
      source_issue: "#2878",
      severity: "error",
      file: resolve(editionDir, "02-reviewed.md"),
    },
  ];
}

/**
 * #12595: item de LANÇAMENTOS cujo título e descrição não dizem de quem é o
 * lançamento (caso 261109: "Voice Chat with Agents", cursor.com, descrição sem
 * "Cursor"). Os nomes aceitos saem da URL (`lancamento-maker.ts`: empresa do
 * registro oficial + rótulo do host + dono do repo). Severity "warning": a
 * correção é reescrever a descrição, escolha do editor no gate.
 */
export function checkLancamentoSemFabricante(editionDir: string): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  return findLancamentosSemFabricante(readFileSync(file, "utf8")).map((it) => ({
    rule: "lancamento-sem-fabricante",
    source_issue: "#12595",
    severity: "warning" as const,
    file,
    message:
      `LANÇAMENTOS “${it.title}” (${it.url}) não cita o fabricante no título nem na descrição ` +
      `(esperado um de: ${it.expected.join(", ")}). Reescrever a descrição dizendo de quem é o produto ` +
      `(ex.: "O ${it.expected[0]} lançou..."). Heurístico: falso positivo, seguir sem mudar.`,
  }));
}

/**
 * #13252: `{{...}}` em `02-reviewed.md` que não é merge tag conhecida de ESP
 * (`findUnknownTemplateMarkers`). Edição 261116: `{{OPENING}}` cru veio do
 * snippet de encerramento escolhido pro slot 1 e só foi barrado pelo Kit
 * (exit 8) e pelo site (exit 5) no Stage 5. Error, gate-blocking. Roda também
 * no Stage 2, logo após o stitch.
 */
export function checkReviewedUnknownTemplateMarkers(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  return findUnknownTemplateMarkers(readFileSync(path, "utf8")).map((hit) => ({
    rule: "reviewed-unknown-template-marker",
    message:
      `02-reviewed.md linha ${hit.line}: marcador \`${hit.marker}\` não é merge tag conhecida do ESP — ` +
      `o leitor veria o texto cru (e o Kit/site recusam no Stage 5). Fix: substituir pelo texto ` +
      `final ou remover o bloco que o trouxe (box de divulgação com snippet que não é box, #13252).`,
    source_issue: "#13252",
    severity: "error" as const,
    file: path,
    line: hit.line,
  }));
}

/**
 * #13252: parágrafo de créditos do "Para encerrar" ("Nesta edição da
 * diar.ia.br, usei...") mais de uma vez em `02-reviewed.md` — o bloco saiu
 * duplicado (edição 261116: cópia no slot 1 + PARA ENCERRAR). Error,
 * gate-blocking. Roda também no Stage 2.
 */
export function checkReviewedDuplicateClosingBlock(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const lines = findClosingCreditsLines(readFileSync(path, "utf8"));
  if (lines.length <= 1) return [];
  return [
    {
      rule: "reviewed-duplicate-closing-block",
      message:
        `02-reviewed.md tem o parágrafo "Nesta edição da diar.ia.br, usei..." ${lines.length} vezes ` +
        `(linhas ${lines.join(", ")}) — o bloco "Para encerrar" saiu duplicado. Fix: remover a cópia ` +
        `fora do PARA ENCERRAR (em geral um box de divulgação com o snippet de encerramento, #13252).`,
      source_issue: "#13252",
      severity: "error",
      file: path,
      line: lines[1],
    },
  ];
}
