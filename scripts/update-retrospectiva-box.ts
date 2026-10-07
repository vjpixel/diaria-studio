/**
 * scripts/update-retrospectiva-box.ts (#9474)
 *
 * Canal `box` de `/diaria-mensal-apoiadores`: reescreve o CORPO de
 * `data/snippets/retrospectiva-apoiadores.md` com o mês e os 3 temas da
 * Retrospectiva do ciclo e (por padrão) pina o box no **slot 2** de
 * `platform.config.json` — análogo a `update-artigo-especial-box.ts` (#5979),
 * de quem reusa a lógica de pin (`scripts/lib/box-slot-pin.ts`).
 *
 * ## Slot 2 compartilhado com o Artigo Especial (decisão do editor, 02/10/2026)
 *
 * Retrospectiva e Artigo Especial usam o MESMO slot 2 e se ALTERNAM:
 * last-writer-wins no pin (quem publica por último ocupa o slot) e `--unpin`
 * só solta o slot se ele ainda aponta pra `retrospectiva-apoiadores.md` —
 * nunca derruba o pin do Artigo Especial (ver docstring de `box-slot-pin.ts`).
 * Trade-off do #6748 vale igual: em edição de 2 destaques o slot 2 não existe.
 *
 * ## Formato do snippet (#9845, texto aprovado pelo editor na edição 261008)
 *
 *   **Retrospectiva de {Mês}**
 *
 *   Três temas marcaram o mês: {tema 1}, {tema 2} e {tema 3}. A Retrospectiva liga esses pontos e mostra as tendências por trás deles.
 *
 *   Quem apoia a partir de R$25/mês recebe:
 *
 *   - a Retrospectiva do Mês por e-mail, com a edição completa na web
 *   - o Artigo Especial mensal
 *   - voto no tema do próximo Artigo Especial
 *   - nome na página "Quem torna a Diar.ia possível" (opcional)
 *
 *   [Ler a Retrospectiva](https://retrospectiva.diar.ia.br/{AAMM})
 *
 * Regras do editor (#9845): o TÍTULO da retrospectiva não entra no box; entram
 * os 3 temas principais do ciclo (frases curtas, minúsculas, sem ponto final —
 * `--temas "a|b|c"`), a frase sobre ligar os pontos e as tendências, e a lista
 * completa de benefícios de R$25 (`TIER_BLOCK`, estável entre ciclos).
 *
 * Edição cirúrgica (#495): num arquivo PRÉ-EXISTENTE só 3 linhas são trocadas
 * (título, parágrafo dos temas, URL do CTA); header de comentário e bloco do
 * tier ficam intocados. **Migração:** um arquivo ainda no formato anterior
 * (#9474 — parágrafo `A Retrospectiva de {Mês} é: **"{título}"**. {gancho}.`
 * + tier de uma linha) é aceito e convertido: o parágrafo do título vira o dos
 * temas e o tier de uma linha vira o `TIER_BLOCK`. Arquivo que não bate com
 * nenhum dos dois formatos → `RetrospectivaBoxFormatError` (nunca adivinhar
 * onde inserir). Arquivo ausente → seed completo.
 *
 * O CTA do BOX aponta pra página da Retrospectiva (trecho + paywall, a página
 * feita pra vender o apoio, #7580) — mesma escolha do box do Artigo Especial
 * (`[Ler o Artigo Especial](url)`, editor 30/09/2026). A regra "nunca a URL
 * direta" é dos posts PÚBLICOS de rede social (LinkedIn), não do box da
 * newsletter.
 *
 * Uso:
 *   npx tsx scripts/update-retrospectiva-box.ts --cycle 2609-10 \
 *     --temas "{tema 1}|{tema 2}|{tema 3}" [--no-pin] [--force] [--dry-run]
 *   npx tsx scripts/update-retrospectiva-box.ts --unpin [--cycle 2609-10] [--dry-run]
 *   [--snippets-file path] [--config path]
 *
 * `--unpin` não exige `--temas`, não toca no snippet nem no state por
 * canal — só no pin. Fora do `--unpin`, `--cycle` é obrigatório e o canal
 * `box` é gravado em `divulgacao-published.json`.
 *
 * **Retomar o slot depois do Artigo Especial:** com o canal `box` já `done`,
 * uma 2ª execução pula (idempotência) e NÃO re-pina — se o Artigo Especial
 * assumiu o slot 2 depois, devolver o slot à Retrospectiva é decisão
 * consciente: `--force`.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  ARTIGO_ESPECIAL_BOX_FILENAME,
  applyBoxPin,
  isBoxSlotOwnedBy,
  serializeConfigSurgically,
  type BoxesDivulgacaoConfig,
} from "./lib/box-slot-pin.ts";
import { decideChannelAction, buildDoneChannelState, buildFailedChannelState, withChannelState } from "./lib/artigo-especial-state.ts";
import { monthlyDir } from "./lib/mensal/monthly-paths.ts";
import {
  contentMonthLabel,
  retrospectivaUrl,
  retrospectivaDivulgacaoStatePath,
  readRetrospectivaDivulgacaoState,
  writeRetrospectivaDivulgacaoState,
} from "./lib/mensal/retrospectiva-divulgacao.ts";

export const RETROSPECTIVA_BOX_FILENAME = "retrospectiva-apoiadores.md";
/** Slot fixo — decisão do editor (#9474): o mesmo do Artigo Especial. */
export const RETROSPECTIVA_BOX_SLOT = 2;

export const RETROSPECTIVA_BOX_HEADER = `<!--
nome: Retrospectiva do Mês
categoria: Retrospectiva
retrospectiva-apoiadores.md — box de divulgação da Retrospectiva do Mês
(recompensa Mantenedor/Patrono, R$25+). Slot 2, ALTERNANDO com
artigo-especial-apoiadores.md (quem publica por último ocupa o slot, #9474).
Reescrito por scripts/update-retrospectiva-box.ts (/diaria-mensal-apoiadores)
a cada ciclo — não editar título/parágrafo dos temas/URL do CTA à mão aqui, o
próximo ciclo sobrescreve (o bloco do tier, parágrafo + lista de benefícios,
segue estável). Formato: context/snippets/README.md.
-->`;

/**
 * Bloco do tier (#9845): parágrafo + lista completa de benefícios de quem
 * apoia a partir de R$25 (Mantenedor = tudo dos planos anteriores, mais a
 * Retrospectiva e a votação). Estável entre ciclos — o script só o escreve no
 * seed e na migração do formato antigo; num arquivo já no formato novo ele
 * fica intocado (o editor pode ajustá-lo à mão).
 */
export const TIER_BLOCK = [
  "Quem apoia a partir de R$25/mês recebe:",
  "",
  "- a Retrospectiva do Mês por e-mail, com a edição completa na web",
  "- o Artigo Especial mensal",
  "- voto no tema do próximo Artigo Especial",
  '- nome na página "Quem torna a Diar.ia possível" (opcional)',
].join("\n");

/** Frase fixa que fecha o parágrafo dos temas (texto aprovado, #9845). */
const TEMAS_CLOSING = "A Retrospectiva liga esses pontos e mostra as tendências por trás deles.";

const TITLE_LINE_RE = /^\*\*Retrospectiva de [^*\n]+\*\*$/m;
const TEMAS_PARAGRAPH_RE = /^Três temas marcaram o mês: .*$/m;
const CTA_LINE_RE = /^\[Ler a Retrospectiva\]\([^)\n]+\)$/m;
// Formato anterior (#9474) — só pra migração.
const LEGACY_QUOTE_PARAGRAPH_RE = /^A Retrospectiva de [^:\n]+ é:.*$/m;
const LEGACY_TIER_PARAGRAPH_RE = /^Quem apoia a partir de R\$25\/mês recebe [^\n]+$/m;
/** Header de comentário gerado por este script (qualquer versão), no topo. */
const GENERATED_HEADER_RE = /^<!--\r?\nnome: Retrospectiva do Mês\r?\n(?:(?!-->)[\s\S])*?Reescrito por scripts\/update-retrospectiva-box\.ts(?:(?!-->)[\s\S])*-->/;

/** Quantidade exata de temas do parágrafo (texto aprovado: "Três temas"). */
export const RETROSPECTIVA_TEMAS_COUNT = 3;

/**
 * Pura: normaliza e valida os temas (trim, sem ponto final). Lança se não
 * vierem exatamente 3 temas não vazios — o parágrafo diz "Três temas".
 */
export function normalizeTemas(temas: readonly string[]): string[] {
  const out = temas.map((t) => t.trim().replace(/\.+$/, "").trim());
  if (out.length !== RETROSPECTIVA_TEMAS_COUNT || out.some((t) => t.length === 0)) {
    throw new Error(
      `--temas precisa de exatamente ${RETROSPECTIVA_TEMAS_COUNT} temas não vazios separados por "|" ` +
        `(recebi ${out.length}${out.some((t) => t.length === 0) ? ", com tema vazio" : ""}): ` +
        '--temas "tema 1|tema 2|tema 3".',
    );
  }
  return out;
}

/** Pura: `--temas "a|b|c"` → `["a","b","c"]` (validado por `normalizeTemas`). */
export function parseTemasArg(raw: string): string[] {
  return normalizeTemas(raw.split("|"));
}

function buildTitleLine(mesLabel: string): string {
  return `**Retrospectiva de ${mesLabel}**`;
}
function buildTemasParagraph(temas: readonly string[]): string {
  const [t1, t2, t3] = normalizeTemas(temas);
  return `Três temas marcaram o mês: ${t1}, ${t2} e ${t3}. ${TEMAS_CLOSING}`;
}
function buildCtaLine(url: string): string {
  return `[Ler a Retrospectiva](${url})`;
}

export interface RetrospectivaBoxInput {
  mesLabel: string;
  /** Exatamente 3 frases curtas, minúsculas, sem ponto final (#9845). */
  temas: readonly string[];
  url: string;
}

export class RetrospectivaBoxFormatError extends Error {}

/** Seed do arquivo (bootstrap, arquivo ausente). */
export function buildDefaultRetrospectivaBox(input: RetrospectivaBoxInput): string {
  return [
    RETROSPECTIVA_BOX_HEADER,
    "",
    buildTitleLine(input.mesLabel),
    "",
    buildTemasParagraph(input.temas),
    "",
    TIER_BLOCK,
    "",
    buildCtaLine(input.url),
    "",
  ].join("\n");
}

/**
 * Pura: atualização cirúrgica de um conteúdo EXISTENTE (ver docstring).
 * Formato novo → troca título, parágrafo dos temas e URL. Formato anterior
 * (#9474) → migra: parágrafo do título vira o dos temas e o tier de uma linha
 * vira o `TIER_BLOCK`. Nenhum dos dois → `RetrospectivaBoxFormatError`.
 */
export function applyRetrospectivaBoxUpdate(content: string, input: RetrospectivaBoxInput): string {
  const temasParagraph = buildTemasParagraph(input.temas);
  const isNew = TEMAS_PARAGRAPH_RE.test(content);
  const isLegacy = !isNew && LEGACY_QUOTE_PARAGRAPH_RE.test(content) && LEGACY_TIER_PARAGRAPH_RE.test(content);

  const missing: string[] = [];
  if (!TITLE_LINE_RE.test(content)) missing.push('linha de título "**Retrospectiva de {Mês}**"');
  if (!isNew && !isLegacy) {
    missing.push(
      'parágrafo "Três temas marcaram o mês: ..." (ou, no formato anterior, o par ' +
        '"A Retrospectiva de {Mês} é: ..." + "Quem apoia a partir de R$25/mês recebe ...")',
    );
  }
  if (!CTA_LINE_RE.test(content)) missing.push('linha de CTA "[Ler a Retrospectiva](url)"');
  if (missing.length > 0) {
    throw new RetrospectivaBoxFormatError(
      `${missing.join(", ")} não encontrada(s) — formato do arquivo divergiu da convenção. ` +
        "Ajuste manualmente uma vez (ver context/snippets/README.md) antes de rodar de novo.",
    );
  }
  // Replacers como FUNÇÃO: os temas vêm de texto editorial, e numa string de
  // substituição `$&`, `$'` etc. seriam interpretados como padrões.
  let next = content.replace(TITLE_LINE_RE, () => buildTitleLine(input.mesLabel));
  next = isNew
    ? next.replace(TEMAS_PARAGRAPH_RE, () => temasParagraph)
    : next
        .replace(LEGACY_QUOTE_PARAGRAPH_RE, () => temasParagraph)
        .replace(LEGACY_TIER_PARAGRAPH_RE, () => TIER_BLOCK)
        // Header gerado pelo próprio script (descreve o formato antigo) vira o
        // atual; header editado à mão (não bate) fica intocado (#495).
        .replace(GENERATED_HEADER_RE, () => RETROSPECTIVA_BOX_HEADER);
  return next.replace(CTA_LINE_RE, () => buildCtaLine(input.url));
}

export function renderRetrospectivaBox(existing: string | null, input: RetrospectivaBoxInput): string {
  return existing === null ? buildDefaultRetrospectivaBox(input) : applyRetrospectivaBoxUpdate(existing, input);
}

// ── Orquestração (testável) ─────────────────────────────────────────────

export interface RunRetrospectivaBoxOptions {
  /** Ciclo `YYMM-MM` — obrigatório no modo update; opcional no `--unpin`. */
  cycle?: string;
  /** Exatamente 3 temas (#9845) — obrigatório fora do `--unpin`. */
  temas?: readonly string[];
  unpin: boolean;
  pin: boolean;
  force: boolean;
  dryRun: boolean;
  snippetsFile: string;
  configPath: string;
  /** Diretório do ciclo (`monthlyDir(cycle)`) — injetável pra teste. */
  cycleDir?: string;
}

export type RunRetrospectivaBoxResult =
  | { action: "skipped"; reason: string }
  | { action: "dry-run" }
  /** `--unpin` sem efeito: o slot não aponta (mais) pra Retrospectiva. */
  | { action: "noop"; reason: string }
  | { action: "updated"; snippetWritten: boolean; configChanged: boolean };

export function runUpdateRetrospectivaBox(o: RunRetrospectivaBoxOptions): RunRetrospectivaBoxResult {
  if (!o.unpin && (!o.cycle || !o.temas)) {
    throw new Error('--cycle e --temas "tema 1|tema 2|tema 3" são obrigatórios (exceto com --unpin).');
  }
  // Valida a contagem ANTES de tocar em state/arquivo: erro de uso não é
  // falha do canal.
  const temas = o.unpin ? null : normalizeTemas(o.temas!);
  const statePath = o.cycle ? retrospectivaDivulgacaoStatePath(o.cycleDir ?? monthlyDir(o.cycle)) : null;
  let state = o.cycle && statePath ? readRetrospectivaDivulgacaoState(statePath, o.cycle) : null;

  if (state && !o.unpin) {
    const decision = decideChannelAction(state, "box", o.force);
    if (decision.action === "skip") {
      console.log(`[box] pulado — ${decision.reason}`);
      return { action: "skipped", reason: decision.reason };
    }
  }

  let nextSnippet: string | null = null;
  if (!o.unpin) {
    const existing = existsSync(o.snippetsFile) ? readFileSync(o.snippetsFile, "utf8") : null;
    try {
      nextSnippet = renderRetrospectivaBox(existing, {
        mesLabel: contentMonthLabel(o.cycle!),
        temas: temas!,
        url: retrospectivaUrl(o.cycle!),
      });
    } catch (e) {
      if (state && statePath && !o.dryRun) {
        writeRetrospectivaDivulgacaoState(
          statePath,
          withChannelState(state, "box", buildFailedChannelState(new Date().toISOString(), (e as Error).message)),
        );
      }
      throw e;
    }
  }

  const configText = readFileSync(o.configPath, "utf8");
  const config = JSON.parse(configText) as BoxesDivulgacaoConfig;
  const doPin = o.unpin ? false : o.pin;
  const touchesConfig = o.unpin || o.pin;
  const nextConfig = touchesConfig
    ? applyBoxPin(config, { slot: RETROSPECTIVA_BOX_SLOT, filename: RETROSPECTIVA_BOX_FILENAME, pin: doPin })
    : config;
  const configChanged = JSON.stringify(nextConfig) !== JSON.stringify(config);

  if (o.unpin && !isBoxSlotOwnedBy(config, RETROSPECTIVA_BOX_SLOT, RETROSPECTIVA_BOX_FILENAME)) {
    const current = config.boxes_divulgacao?.[`slot${RETROSPECTIVA_BOX_SLOT}`];
    // Só o PARCEIRO de alternância (Artigo Especial) é no-op legítimo; um
    // terceiro valor (typo, edição manual) é drift de config — avisar alto.
    const reason =
      current === ARTIGO_ESPECIAL_BOX_FILENAME
        ? `slot${RETROSPECTIVA_BOX_SLOT} está com o Artigo Especial — o pin dele fica intacto (alternância, #9474).`
        : `slot${RETROSPECTIVA_BOX_SLOT}=${JSON.stringify(current)} não é nenhum dos 2 boxes que se alternam no slot — ` +
          "nada alterado; confira platform.config.json.";
    if (current === ARTIGO_ESPECIAL_BOX_FILENAME) console.log(`[box] --unpin no-op: ${reason}`);
    else console.warn(`[box] AVISO --unpin no-op: ${reason}`);
    return { action: "noop", reason };
  }
  if (doPin && configChanged) {
    const before = config.boxes_divulgacao?.[`slot${RETROSPECTIVA_BOX_SLOT}`];
    if (before !== RETROSPECTIVA_BOX_FILENAME) {
      console.log(`[box] slot${RETROSPECTIVA_BOX_SLOT}: ${JSON.stringify(before)} → "${RETROSPECTIVA_BOX_FILENAME}" (last-writer-wins).`);
    }
  }

  if (o.dryRun) {
    if (nextSnippet !== null) console.log(`[dry-run] escreveria ${o.snippetsFile}:\n---\n${nextSnippet}\n---`);
    console.log(
      `[dry-run] ${configChanged ? "escreveria" : "não mudaria"} ${o.configPath} ` +
        `(slot${RETROSPECTIVA_BOX_SLOT}=${JSON.stringify(nextConfig.boxes_divulgacao?.[`slot${RETROSPECTIVA_BOX_SLOT}`])}, ` +
        `pinned_slots=${JSON.stringify(nextConfig.boxes_divulgacao_auto?.pinned_slots)})`,
    );
    return { action: "dry-run" };
  }

  if (nextSnippet !== null) {
    mkdirSync(dirname(o.snippetsFile), { recursive: true });
    writeFileAtomic(o.snippetsFile, nextSnippet);
    console.log(`OK — box atualizado em ${o.snippetsFile}`);
  }
  if (configChanged) {
    writeFileAtomic(o.configPath, serializeConfigSurgically(configText, nextConfig, RETROSPECTIVA_BOX_SLOT));
    console.log(
      `OK — ${o.configPath} atualizado (slot${RETROSPECTIVA_BOX_SLOT}=` +
        `${JSON.stringify(nextConfig.boxes_divulgacao?.[`slot${RETROSPECTIVA_BOX_SLOT}`])}, ` +
        `pinned_slots=${JSON.stringify(nextConfig.boxes_divulgacao_auto?.pinned_slots)}).`,
    );
  }

  if (state && statePath && !o.unpin) {
    state = withChannelState(state, "box", buildDoneChannelState(new Date().toISOString(), null));
    writeRetrospectivaDivulgacaoState(statePath, state);
  }
  return { action: "updated", snippetWritten: nextSnippet !== null, configChanged };
}

// ── CLI ───────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  runUpdateRetrospectivaBox({
    cycle: values["cycle"],
    temas: values["temas"] !== undefined ? parseTemasArg(values["temas"]) : undefined,
    unpin: flags.has("unpin"),
    pin: !flags.has("no-pin"),
    force: flags.has("force"),
    dryRun: flags.has("dry-run"),
    snippetsFile: values["snippets-file"]
      ? resolve(ROOT, values["snippets-file"])
      : resolve(ROOT, "data/snippets", RETROSPECTIVA_BOX_FILENAME),
    configPath: values["config"] ? resolve(ROOT, values["config"]) : resolve(ROOT, "platform.config.json"),
  });
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`Erro: ${(e as Error).message}`);
    process.exit(1);
  }
}
