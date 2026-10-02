/**
 * scripts/update-retrospectiva-box.ts (#9474)
 *
 * Canal `box` de `/diaria-mensal-apoiadores`: reescreve o CORPO de
 * `data/snippets/retrospectiva-apoiadores.md` com o mês/título/gancho da
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
 * ## Formato do snippet (spec em `context/snippets/README.md`)
 *
 *   **Retrospectiva de {Mês}**
 *
 *   A Retrospectiva de {Mês} é: **"{título}"**. {gancho}.
 *
 *   Quem apoia a partir de R$25/mês recebe a Retrospectiva do Mês por e-mail e lê a edição completa na web.
 *
 *   [Ler a Retrospectiva](https://retrospectiva.diar.ia.br/{AAMM})
 *
 * Edição cirúrgica (#495): num arquivo PRÉ-EXISTENTE só 3 linhas são trocadas
 * (título, frase-padrão, URL do CTA); header de comentário e parágrafo do tier
 * ficam intocados. Linha não encontrada → `RetrospectivaBoxFormatError`
 * (nunca adivinhar onde inserir). Arquivo ausente → seed completo.
 *
 * O CTA do BOX aponta pra página da Retrospectiva (trecho + paywall, a página
 * feita pra vender o apoio, #7580) — mesma escolha do box do Artigo Especial
 * (`[Ler o Artigo Especial](url)`, editor 30/09/2026). A regra "nunca a URL
 * direta" é dos posts PÚBLICOS de rede social (LinkedIn), não do box da
 * newsletter.
 *
 * Uso:
 *   npx tsx scripts/update-retrospectiva-box.ts --cycle 2609-10 \
 *     --titulo "{título do D1}" --gancho "{1 frase}" [--no-pin] [--force] [--dry-run]
 *   npx tsx scripts/update-retrospectiva-box.ts --unpin [--cycle 2609-10] [--dry-run]
 *   [--snippets-file path] [--config path]
 *
 * `--unpin` não exige título/gancho, não toca no snippet nem no state por
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
a cada ciclo — não editar título/frase-padrão/URL do CTA à mão aqui, o
próximo ciclo sobrescreve (o parágrafo do tier segue estável). Formato:
context/snippets/README.md.
-->`;

const TIER_PARAGRAPH =
  "Quem apoia a partir de R$25/mês recebe a Retrospectiva do Mês por e-mail e lê a edição completa na web.";

const TITLE_LINE_RE = /^\*\*Retrospectiva de [^*\n]+\*\*$/m;
const QUOTE_PARAGRAPH_RE = /^A Retrospectiva de [^:\n]+ é:.*$/m;
const CTA_LINE_RE = /^\[Ler a Retrospectiva\]\([^)\n]+\)$/m;

function buildTitleLine(mesLabel: string): string {
  return `**Retrospectiva de ${mesLabel}**`;
}
function buildQuoteParagraph(mesLabel: string, titulo: string, gancho: string): string {
  const ganchoTrimmed = gancho.trim().replace(/\.+$/, "");
  return `A Retrospectiva de ${mesLabel} é: **"${titulo.trim()}"**. ${ganchoTrimmed}.`;
}
function buildCtaLine(url: string): string {
  return `[Ler a Retrospectiva](${url})`;
}

export interface RetrospectivaBoxInput {
  mesLabel: string;
  titulo: string;
  gancho: string;
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
    buildQuoteParagraph(input.mesLabel, input.titulo, input.gancho),
    "",
    TIER_PARAGRAPH,
    "",
    buildCtaLine(input.url),
    "",
  ].join("\n");
}

/** Pura: atualização cirúrgica de um conteúdo EXISTENTE (ver docstring). */
export function applyRetrospectivaBoxUpdate(content: string, input: RetrospectivaBoxInput): string {
  const missing: string[] = [];
  if (!TITLE_LINE_RE.test(content)) missing.push('linha de título "**Retrospectiva de {Mês}**"');
  if (!QUOTE_PARAGRAPH_RE.test(content)) missing.push('parágrafo "A Retrospectiva de {Mês} é: ..."');
  if (!CTA_LINE_RE.test(content)) missing.push('linha de CTA "[Ler a Retrospectiva](url)"');
  if (missing.length > 0) {
    throw new RetrospectivaBoxFormatError(
      `${missing.join(", ")} não encontrada(s) — formato do arquivo divergiu da convenção. ` +
        "Ajuste manualmente uma vez (ver context/snippets/README.md) antes de rodar de novo.",
    );
  }
  // Replacers como FUNÇÃO: título/gancho vêm de texto editorial, e numa
  // string de substituição `$&`, `$'` etc. seriam interpretados como padrões.
  return content
    .replace(TITLE_LINE_RE, () => buildTitleLine(input.mesLabel))
    .replace(QUOTE_PARAGRAPH_RE, () => buildQuoteParagraph(input.mesLabel, input.titulo, input.gancho))
    .replace(CTA_LINE_RE, () => buildCtaLine(input.url));
}

export function renderRetrospectivaBox(existing: string | null, input: RetrospectivaBoxInput): string {
  return existing === null ? buildDefaultRetrospectivaBox(input) : applyRetrospectivaBoxUpdate(existing, input);
}

// ── Orquestração (testável) ─────────────────────────────────────────────

export interface RunRetrospectivaBoxOptions {
  /** Ciclo `YYMM-MM` — obrigatório no modo update; opcional no `--unpin`. */
  cycle?: string;
  titulo?: string;
  gancho?: string;
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
  if (!o.unpin && (!o.cycle || !o.titulo || !o.gancho)) {
    throw new Error("--cycle, --titulo e --gancho são obrigatórios (exceto com --unpin).");
  }
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
        titulo: o.titulo!,
        gancho: o.gancho!,
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
    titulo: values["titulo"],
    gancho: values["gancho"],
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
