/**
 * newsletter-patronos.ts (#4275, Fase 1 — "Gerar e revisar")
 *
 * Variante Patronos da newsletter diária: MESMO `02-reviewed.md` de sempre
 * (destaques/seções idênticos, sem segundo `writer`, sem segundo gate de
 * revisão de conteúdo — fora de escopo desta issue) — só a SELEÇÃO DE CAIXAS
 * muda, trocando o pitch de apoio/divulgação padrão por conteúdo próprio do
 * nível Patrono (bastidores, acesso antecipado, agradecimento nominal —
 * decisão do editor, comentário 260731 da issue).
 *
 * ## Por que não re-stitchar
 *
 * `02-reviewed.md` já passou por humanizador + Clarice (Stage 2) — e
 * possivelmente por edição manual do editor no Studio. Re-rodar
 * `stitchNewsletter` (scripts/stitch-newsletter.ts) a partir dos drafts
 * brutos descartaria essas correções. Este módulo, em vez disso, parte do
 * `NewsletterContent` JÁ PARSEADO por `extractContent(editionDir)` (que lê
 * `02-reviewed.md` como está, humanizado/corrigido/editado) e sobrescreve só
 * os campos relativos aos boxes de divulgação (slot 0-3) — todo o resto
 * (destaques, seções, É IA?, SORTEIO, PARA ENCERRAR) permanece intocado.
 *
 * ## Config: chave irmã, não aninhada
 *
 * `platform.config.json` → `boxes_divulgacao_patronos` tem o MESMO shape
 * plano de `boxes_divulgacao` (`BoxesDivulgacaoConfig`, stitch-newsletter.ts)
 * — chave IRMÃ, nunca aninhada (`boxes_divulgacao.variants.patronos`
 * quebraria a premissa de `replaceBoxesDivulgacaoBlock`, que assume o bloco
 * `boxes_divulgacao` sem chaves aninhadas por dentro — ver docstring lá).
 *
 * ## Decisão de implementação: boxes PLANOS, sem imagem por slot (Fase 1)
 *
 * Ao contrário do render padrão — onde `readBoxDivulgacaoCategoriaForSlot`/
 * `readBoxDivulgacaoAltForSlot`/`readBoxSlotImage` (newsletter-parse.ts)
 * fazem slot -> filename -> metadado a partir de `boxes_divulgacao` — este
 * módulo já SABE qual arquivo ocupa cada slot Patronos (veio direto de
 * `boxes_divulgacao_patronos`), então lê o snippet diretamente, sem esse
 * indireto. Duas simplificações deliberadas, documentadas aqui pra não
 * serem redescobertas do zero:
 *
 *   1. Todo box Patronos é tratado como PLANO (`bold: false`, mesma
 *      convenção visual de `apoio-divulgacao.md`/`clarice-divulgacao.md` —
 *      ver `data/snippets/patronos-bastidores.md`), nunca como o callout
 *      bold-wrap do slot 0 padrão (`agradecimento-apoiadores.md`). Os 3
 *      snippets Patronos autorados pro #4275 seguem essa convenção.
 *   2. Nenhum slot Patronos tem imagem própria (`Image: null`,
 *      `ImageExplicit/ImagePortrait: false`, `ImageAlt: null`) — o
 *      mecanismo de imagem por slot (`box_slot{N}_image` em
 *      `06-public-images.json`) não foi estendido à variante Patronos nesta
 *      fase; os 3 snippets atuais são só-texto. Revisitar se uma Fase futura
 *      quiser paridade total de imagem.
 *
 * ## Semântica "TROCA", não "herda o padrão"
 *
 * Slot Patronos sem override (`boxes_divulgacao_patronos.slotN` vazio/null)
 * -> box `null` NESSE slot na variante — NÃO cai de volta pro box padrão
 * daquele slot. Decisão do editor (260731): a variante Patronos troca as
 * caixas, não as reatribui seletivamente; um slot sem conteúdo Patronos
 * fica vazio, nunca mostra o pitch de apoio/divulgação padrão.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NewsletterContent } from "./newsletter-parse.ts";
import type { BoxesDivulgacaoConfig } from "../stitch-newsletter.ts";
import { parseBoxHeaderField, stripHeaderBlock } from "./shared/snippet-header.ts";

/** Raiz do repo, resolvida a partir do próprio módulo — default de `rootDir`
 * nos exports abaixo (mesmo padrão de `REPO_ROOT_FROM_MODULE` em
 * newsletter-parse.ts). Parametrizável pra fixture de teste isolada. */
const REPO_ROOT_FROM_MODULE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Chave de `platform.config.json` da variante Patronos — irmã plana de
 * `boxes_divulgacao` (#4275). */
export const PATRONOS_BOXES_CONFIG_KEY = "boxes_divulgacao_patronos";

const EMPTY_BOXES_CONFIG: BoxesDivulgacaoConfig = { slot0: null, slot1: null, slot2: null, slot3: null };

/**
 * Lê `platform.config.json` → `boxes_divulgacao_patronos` — mesmo shape/
 * contrato de leitura de `loadBoxesDivulgacaoConfig` (stitch-newsletter.ts),
 * só que pra chave irmã. Fail-soft total: config ausente, JSON corrompido,
 * ou chave ausente/malformada -> todos os slots `null`. Nunca lança.
 */
export function loadBoxesDivulgacaoPatronosConfig(
  rootDir: string = REPO_ROOT_FROM_MODULE,
): BoxesDivulgacaoConfig {
  try {
    const configPath = resolve(rootDir, "platform.config.json");
    if (!existsSync(configPath)) return EMPTY_BOXES_CONFIG;
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    const boxes = raw?.[PATRONOS_BOXES_CONFIG_KEY];
    if (!boxes || typeof boxes !== "object") return EMPTY_BOXES_CONFIG;
    const get = (key: "slot0" | "slot1" | "slot2" | "slot3"): string | null => {
      const v = boxes[key];
      return typeof v === "string" && v ? v : null;
    };
    return { slot0: get("slot0"), slot1: get("slot1"), slot2: get("slot2"), slot3: get("slot3") };
  } catch {
    return EMPTY_BOXES_CONFIG;
  }
}

interface SlotOverride {
  /** Corpo do box (header removido, trimado) — `null` se sem override ou
   * arquivo ausente/vazio. */
  text: string | null;
  /** `categoria:` sanitizado (mesmo tratamento de
   * `readBoxDivulgacaoCategoriaForSlot`), `null` se ausente. */
  categoria: string | null;
}

const EMPTY_OVERRIDE: SlotOverride = { text: null, categoria: null };

/** Sanitiza `categoria:`/`alt:` do header pro mesmo padrão de
 * `readBoxDivulgacaoCategoriaForSlot`/`readBoxDivulgacaoAltForSlot`
 * (newsletter-parse.ts): remove markdown (`**`, `#`, `- ` inicial) — texto
 * livre digitado no Studio vira label renderizado, não deve carregar
 * marcação. `null`/"" -> `null`. */
function sanitizeHeaderField(v: string | null): string | null {
  if (!v) return null;
  const cleaned = v.replace(/[*#]/g, "").replace(/^-+\s*/, "").trim();
  return cleaned || null;
}

/**
 * Lê `data/snippets/{filename}` (migrado de `context/snippets/` em #5227)
 * sob `rootDir` (parametrizável, testável com fixture — ao contrário de
 * `loadDivulgacaoSnippet`/`readSnippetFile`, que resolvem sempre a raiz REAL
 * do repo) e devolve `{text, categoria}`. `filename` vazio ->
 * `EMPTY_OVERRIDE` (slot não configurado, estado legítimo). Arquivo ausente
 * -> `EMPTY_OVERRIDE` (fail-soft mantido aqui de propósito — a variante
 * Patronos ainda está na Fase 1, "gerar + revisar, sem publicar", não é o
 * caminho de publicação real que #5227 endureceu em `loadDivulgacaoSnippet`).
 * Nunca lança.
 */
function resolveSlotOverride(filename: string | null, rootDir: string): SlotOverride {
  if (!filename) return EMPTY_OVERRIDE;
  const snippetPath = resolve(rootDir, "data", "snippets", filename);
  if (!existsSync(snippetPath)) return EMPTY_OVERRIDE;
  let raw: string;
  try {
    raw = readFileSync(snippetPath, "utf8");
  } catch {
    return EMPTY_OVERRIDE;
  }
  const text = stripHeaderBlock(raw).trim() || null;
  const categoria = sanitizeHeaderField(parseBoxHeaderField(raw, "categoria"));
  return { text, categoria };
}

/**
 * Sobrescreve os campos de box de divulgação (slot 0-3) de um
 * `NewsletterContent` JÁ PARSEADO (via `extractContent`) com a variante
 * Patronos (#4275) — destaques/seções/demais campos saem intocados
 * (spread). Fail-soft: config ausente/slot vazio -> box `null` nesse slot
 * (nunca herda o box padrão do mesmo `content` de entrada — semântica
 * "TROCA", ver docstring do módulo). Nunca lança.
 */
export function applyPatronosBoxes(
  content: NewsletterContent,
  rootDir: string = REPO_ROOT_FROM_MODULE,
): NewsletterContent {
  const cfg = loadBoxesDivulgacaoPatronosConfig(rootDir);
  const s0 = resolveSlotOverride(cfg.slot0 ?? null, rootDir);
  const s1 = resolveSlotOverride(cfg.slot1 ?? null, rootDir);
  const s2 = resolveSlotOverride(cfg.slot2 ?? null, rootDir);
  const s3 = resolveSlotOverride(cfg.slot3 ?? null, rootDir);
  return {
    ...content,
    boxDivulgacao0: s0.text,
    boxDivulgacao0Image: null,
    boxDivulgacao0Bold: false,
    boxDivulgacao0Categoria: s0.categoria,
    boxDivulgacao1: s1.text,
    boxDivulgacao1Image: null,
    boxDivulgacao1Bold: false,
    boxDivulgacao1Categoria: s1.categoria,
    boxDivulgacao2: s2.text,
    boxDivulgacao2Image: null,
    boxDivulgacao2Bold: false,
    boxDivulgacao2Categoria: s2.categoria,
    boxDivulgacao3: s3.text,
    boxDivulgacao3Image: null,
    boxDivulgacao3Bold: false,
    boxDivulgacao3Categoria: s3.categoria,
    boxDivulgacaoImageExplicit: { 0: false, 1: false, 2: false, 3: false },
    boxDivulgacaoImagePortrait: { 0: false, 1: false, 2: false, 3: false },
    boxDivulgacaoImageAlt: { 0: null, 1: null, 2: null, 3: null },
  };
}
