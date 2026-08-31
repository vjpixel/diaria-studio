/**
 * update-artigo-especial-box.ts (#5979)
 *
 * Passo 5 da skill `/diaria-artigo-especial`: reescreve o CORPO de
 * `data/snippets/artigo-especial-apoiadores.md` com o título/gancho do
 * artigo especial do mês, e (por padrão) pina o box no slot 2 em
 * `platform.config.json` (via `boxes_divulgacao.slot2` +
 * `boxes_divulgacao_auto.pinned_slots`).
 *
 * ## #6748 (29/08/2026) — default mudou de slot 3 para slot 2 (slot 3 eliminado)
 *
 * O #6748 eliminou o slot 3 da rotação de boxes de divulgação — `stitch-newsletter.ts`
 * nunca mais renderiza esse slot, `select-boxes-by-clicks.ts` nunca mais o
 * ranqueia/pina. Pinar o box do Artigo Especial em `slot3` (comportamento
 * pré-#6748) hoje escreveria a config e reportaria sucesso sem NENHUM efeito
 * — o box nunca apareceria na newsletter (achado no self-review do #6748,
 * ver PR). O default de `--slot` mudou para `2`. **Trade-off aceito nessa
 * troca**: diferente do slot 3 (que injetava sempre, após o último destaque,
 * independente da contagem de destaques), o slot 2 só existe no gap D2/D3 —
 * em edição de 2 destaques (#2343/#3369, sem D3) o box do Artigo Especial
 * NÃO aparece nessa edição, mesmo pinado. Sem heurística melhor disponível
 * sem tocar `stitch-newsletter.ts` de novo; reavaliar se isso incomodar na
 * prática (ex: repinar pro slot1, que sempre existe, mas aí compete com o
 * box padrão desse slot).
 *
 * ## Frase-padrão fixada no gate 260724 (não reabrir — ver `context/snippets/README.md`)
 *
 * `O Artigo Especial desse mês é: **"{título}"**. {gancho}.` — nunca
 * "Mandei... há pouco" nem qualquer outra fórmula. `**` só em volta do
 * TÍTULO, nunca do bloco/frase inteira (#3373).
 *
 * ## Edição cirúrgica (#495)
 *
 * O snippet pode ter sido editado manualmente pelo editor (painel Caixas do
 * Studio, ou direto no arquivo) entre um reuso e outro — este script NUNCA
 * reescreve o arquivo inteiro. Ele localiza só 2 linhas por regex (o título
 * do box `**Artigo Especial de {Mês}**` e a frase-padrão acima) e troca só
 * essas — o resto (header de comentário, parágrafo do tier R$10+, CTA
 * `[Quero apoiar](...)`) fica intocado. Se as 2 linhas não forem encontradas
 * num arquivo PRÉ-EXISTENTE, o script ABORTA em vez de adivinhar/duplicar —
 * o formato pode ter mudado por edição manual fora da convenção; melhor
 * pedir ajuste manual uma vez do que corromper silenciosamente. Arquivo
 * AUSENTE (1ª vez, bootstrap) usa `DEFAULT_BOX_TEMPLATE` como seed.
 *
 * ## `--pin`/`--unpin` em `platform.config.json`
 *
 * `platform.config.json` é git — a ESCRITA aqui é só o `JSON.stringify`
 * local; a skill (`.claude/skills/diaria-artigo-especial/SKILL.md`) é quem
 * abre branch/commit/PR ao redor desta chamada (mesmo fluxo de qualquer
 * sessão interativa tocando um arquivo git-tracked). `--unpin` só remove o
 * slot de `pinned_slots` — NÃO apaga `boxes_divulgacao.slotN` (o valor
 * configurado ali volta a ser candidato normal do auto-select por cliques,
 * #4626, em vez de ficar travado).
 *
 * ## Guard de idempotência (canal "box", #5979 review PR #6000)
 *
 * Quando `--ano`/`--slug` são passados, este script participa do mesmo guard
 * cross-canal que `publish-artigo-especial-linkedin.ts` já implementa
 * (`scripts/lib/artigo-especial-state.ts`, canal `"box"`): lê
 * `data/artigo-especial/{ano}-{slug}/published.json` ANTES de reescrever
 * qualquer arquivo, pula (exit 0, sem tocar em nada) se o canal já está
 * `done` sem `--force`, e grava `done`/`failed` no MESMO arquivo depois de
 * concluir. **Achado corrigido**: a versão original desta unidade (#5979)
 * documentava esse canal como coberto (`artigo-especial-state.ts` inclui
 * `"box"` em `ARTIGO_ESPECIAL_CHANNELS`) mas nunca chamava o state module
 * — o guard só existia no papel. `--ano`/`--slug` são OPCIONAIS: omiti-los
 * (ex: reuso ad-hoc de `--unpin` fora do fluxo da skill) desliga o guard
 * inteiro, sem quebrar o uso standalone que já existia.
 *
 * Uso:
 *   npx tsx scripts/update-artigo-especial-box.ts \
 *     --titulo "Engenharia de ilusão: jailbreak de IA não arromba, encena" \
 *     --gancho "O atacante assume um papel, e o modelo responde fiel à cena" \
 *     --mes "Agosto" \
 *     --ano 2026 --slug engenharia-de-ilusao \
 *     [--snippets-file data/snippets/artigo-especial-apoiadores.md] \
 *     [--config platform.config.json] [--data-dir data] \
 *     [--slot 2] [--no-pin] [--unpin] [--force] [--dry-run]
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs, isMainModule, getIntArg } from "./lib/cli-args.ts";
import {
  artigoEspecialStatePath,
  readArtigoEspecialState,
  writeArtigoEspecialState,
  decideChannelAction,
  buildDoneChannelState,
  buildFailedChannelState,
  withChannelState,
} from "./lib/artigo-especial-state.ts";

// ── Template / render puro ───────────────────────────────────────────────

export const ARTIGO_ESPECIAL_BOX_HEADER = `<!--
  artigo-especial-apoiadores.md — box de divulgação do Artigo Especial do mês.
  Slot 1, 2 ou 3 (não é um dos defaults automáticos de boxes_divulgacao — ver
  context/snippets/README.md). Reescrito por
  scripts/update-artigo-especial-box.ts (Passo 5 de /diaria-artigo-especial,
  #5979) a cada artigo especial novo — não editar título/frase-padrão à mão
  aqui, o próximo reuso da skill sobrescreve (parágrafo do tier + CTA abaixo
  seguem estáveis entre reusos).
-->`;

const TIER_PARAGRAPH =
  "Apoiadores Mantenedor e Patrono (R$10+/mês) têm prioridade de leitura e podem sugerir o tema do próximo. [Quero apoiar](https://apoia.se/diaria)";

/** Linha de título do box — regex de match (multiline) e builder. */
const TITLE_LINE_RE = /^\*\*Artigo Especial de .+\*\*$/m;
function buildTitleLine(mesLabel: string): string {
  return `**Artigo Especial de ${mesLabel}**`;
}

/** Parágrafo com a frase-padrão fixada no gate 260724 — regex de match
 *  (multiline, robusto a "desse"/"deste") e builder. */
const QUOTE_PARAGRAPH_RE = /^O Artigo Especial (?:desse|deste) mês é:.*$/m;
function buildQuoteParagraph(titulo: string, gancho: string): string {
  const ganchoTrimmed = gancho.trim().replace(/\.+$/, "");
  return `O Artigo Especial desse mês é: **"${titulo}"**. ${ganchoTrimmed}.`;
}

export interface ArtigoEspecialBoxInput {
  titulo: string;
  gancho: string;
  mesLabel: string;
  /**
   * #6014 item 4 — URL do post do mês no apoia.se. Quando presente, a linha
   * de CTA `[Quero apoiar](...)` do parágrafo do tier passa a apontar pra
   * ela (em vez do `https://apoia.se/diaria` genérico). Decisão do editor:
   * o CTA converte melhor apontando pro post do artigo especial. Ausente =
   * CTA intocado (comportamento anterior).
   */
  ctaUrl?: string;
}

/** Seed usado quando o arquivo ainda não existe (bootstrap). */
export function buildDefaultArtigoEspecialBox(input: ArtigoEspecialBoxInput): string {
  const tier = input.ctaUrl
    ? TIER_PARAGRAPH.replace(CTA_LINK_RE, buildCtaLink(input.ctaUrl))
    : TIER_PARAGRAPH;
  return [
    ARTIGO_ESPECIAL_BOX_HEADER,
    "",
    buildTitleLine(input.mesLabel),
    "",
    buildQuoteParagraph(input.titulo, input.gancho),
    "",
    tier,
    "",
  ].join("\n");
}

export class ArtigoEspecialBoxFormatError extends Error {}

/** #6014 item 4: CTA `[Quero apoiar](...)` — regex de match e builder. */
const CTA_LINK_RE = /\[Quero apoiar\]\([^)]+\)/;
function buildCtaLink(ctaUrl: string): string {
  return `[Quero apoiar](${ctaUrl})`;
}

/**
 * Pura: aplica a atualização cirúrgica a um conteúdo EXISTENTE. Lança
 * `ArtigoEspecialBoxFormatError` se a linha de título ou o parágrafo da
 * frase-padrão não forem encontrados (formato divergiu da convenção — não
 * adivinha onde inserir).
 */
export function applyArtigoEspecialBoxUpdate(content: string, input: ArtigoEspecialBoxInput): string {
  if (!TITLE_LINE_RE.test(content)) {
    throw new ArtigoEspecialBoxFormatError(
      'Linha de título "**Artigo Especial de {Mês}**" não encontrada — formato do arquivo divergiu da convenção. Ajuste manualmente uma vez (ver context/snippets/README.md) antes de rodar de novo.',
    );
  }
  if (!QUOTE_PARAGRAPH_RE.test(content)) {
    throw new ArtigoEspecialBoxFormatError(
      'Parágrafo "O Artigo Especial desse/deste mês é: ..." não encontrado — formato do arquivo divergiu da convenção. Ajuste manualmente uma vez (ver context/snippets/README.md) antes de rodar de novo.',
    );
  }
  let next = content
    .replace(TITLE_LINE_RE, buildTitleLine(input.mesLabel))
    .replace(QUOTE_PARAGRAPH_RE, buildQuoteParagraph(input.titulo, input.gancho));
  // #6014 item 4: CTA apontando pro post do mês no apoia.se (quando passado).
  if (input.ctaUrl) {
    next = next.replace(CTA_LINK_RE, buildCtaLink(input.ctaUrl));
  }
  return next;
}

/** Orquestra bootstrap-ou-update — usada pelo `main()` e por testes de integração leve. */
export function renderArtigoEspecialBox(existingContent: string | null, input: ArtigoEspecialBoxInput): string {
  if (existingContent === null) return buildDefaultArtigoEspecialBox(input);
  return applyArtigoEspecialBoxUpdate(existingContent, input);
}

// ── platform.config.json: pin/unpin ─────────────────────────────────────

export interface BoxesDivulgacaoConfig {
  boxes_divulgacao?: Record<string, unknown>;
  boxes_divulgacao_auto?: { enabled?: boolean; pinned_slots?: number[]; note?: string };
  [key: string]: unknown;
}

export interface PinBoxInput {
  slot: number;
  filename: string;
  pin: boolean;
}

/**
 * Pura/imutável: aplica pin/unpin. `pin: true` seta `boxes_divulgacao.slot{N}`
 * = filename (idempotente — sobrescreve sempre) e garante `N` em
 * `pinned_slots` (dedup + ordenado). `pin: false` (--unpin) só REMOVE `N` de
 * `pinned_slots` — não mexe em `boxes_divulgacao.slot{N}` (ver docstring do
 * módulo).
 */
export function applyBoxPin(config: BoxesDivulgacaoConfig, input: PinBoxInput): BoxesDivulgacaoConfig {
  const slotKey = `slot${input.slot}`;
  const currentPinned = config.boxes_divulgacao_auto?.pinned_slots ?? [];

  if (!input.pin) {
    return {
      ...config,
      boxes_divulgacao_auto: {
        ...(config.boxes_divulgacao_auto ?? {}),
        pinned_slots: currentPinned.filter((s) => s !== input.slot),
      },
    };
  }

  const nextPinned = Array.from(new Set([...currentPinned, input.slot])).sort((a, b) => a - b);
  return {
    ...config,
    boxes_divulgacao: {
      ...(config.boxes_divulgacao ?? {}),
      [slotKey]: input.filename,
    },
    boxes_divulgacao_auto: {
      ...(config.boxes_divulgacao_auto ?? {}),
      pinned_slots: nextPinned,
    },
  };
}

// ── Orquestração (testável, sem CLI/process.exit) ──────────────────────

export interface RunUpdateBoxOptions extends ArtigoEspecialBoxInput {
  snippetsFile: string;
  configPath: string;
  slot: number;
  pin: boolean;
  dryRun: boolean;
  force: boolean;
  /** ano/slug do artigo — quando AMBOS presentes, ativa o guard de
   *  idempotência do canal "box" (ver docstring do módulo). Ausentes = sem
   *  guard, sem escrita de state (uso ad-hoc, ex: `--unpin` standalone). */
  ano?: string;
  slug?: string;
  /** Raiz de `data/` — testável (default `resolve(ROOT, "data")` no CLI). */
  dataDir: string;
}

export type RunUpdateBoxResult =
  | { action: "skipped"; reason: string }
  | { action: "dry-run" }
  | { action: "updated"; snippetsFile: string; configPath: string };

/**
 * Corpo testável do Passo 5 (extraído de `main()` — mesmo padrão de
 * `runArtigoEspecialLinkedinDispatch` em `publish-artigo-especial-linkedin.ts`).
 * Não lê `process.argv`/chama `process.exit` — tudo explícito em `options`.
 */
export function runUpdateArtigoEspecialBox(options: RunUpdateBoxOptions): RunUpdateBoxResult {
  const { titulo, gancho, mesLabel, snippetsFile, configPath, slot, pin, dryRun, force, ano, slug, dataDir } = options;

  // #5979/PR #6000 fleet review (silent-failure-hunter, média confiança):
  // --ano/--slug são all-or-nothing — passar só 1 dos 2 (typo, flag sem
  // valor) desligava o guard de idempotência inteiro em silêncio, sem
  // warning nenhum. Falha alto em vez de degradar pro caminho "sem canal".
  if (Boolean(ano) !== Boolean(slug)) {
    throw new Error(
      `--ano e --slug devem ser passados JUNTOS ou nenhum dos dois (recebido ano=${JSON.stringify(ano)}, ` +
        `slug=${JSON.stringify(slug)}) — passar só 1 deles desligaria o guard de idempotência do canal "box" ` +
        "em silêncio.",
    );
  }
  const hasArtigoContext = Boolean(ano && slug);
  const statePath = hasArtigoContext ? artigoEspecialStatePath(dataDir, ano!, slug!) : null;
  const state = statePath ? readArtigoEspecialState(statePath, ano!, slug!) : null;

  if (state && statePath) {
    const decision = decideChannelAction(state, "box", force);
    if (decision.action === "skip") {
      console.log(`[box] pulado — ${decision.reason}`);
      return { action: "skipped", reason: decision.reason };
    }
  }

  const existingContent = existsSync(snippetsFile) ? readFileSync(snippetsFile, "utf8") : null;
  let nextContent: string;
  try {
    nextContent = renderArtigoEspecialBox(existingContent, { titulo, gancho, mesLabel, ctaUrl: options.ctaUrl });
  } catch (e) {
    if (state && statePath) {
      writeArtigoEspecialState(
        statePath,
        withChannelState(state, "box", buildFailedChannelState(new Date().toISOString(), (e as Error).message)),
      );
    }
    throw e;
  }

  const config = JSON.parse(readFileSync(configPath, "utf8")) as BoxesDivulgacaoConfig;
  const nextConfig = applyBoxPin(config, { slot, filename: "artigo-especial-apoiadores.md", pin });

  if (dryRun) {
    console.log(`[dry-run] escreveria ${snippetsFile}:\n---\n${nextContent}\n---`);
    console.log(
      `[dry-run] escreveria ${configPath} com boxes_divulgacao.slot${slot}=${pin ? "artigo-especial-apoiadores.md" : "(inalterado)"}, pinned_slots=${JSON.stringify(nextConfig.boxes_divulgacao_auto?.pinned_slots)}`,
    );
    // Dry-run nunca escreve state — mesma disciplina de dryRun no script do
    // LinkedIn (nenhum efeito colateral persistido).
    return { action: "dry-run" };
  }

  mkdirSync(dirname(snippetsFile), { recursive: true });
  writeFileAtomic(snippetsFile, nextContent);
  console.log(`OK — box atualizado em ${snippetsFile}`);

  writeFileAtomic(configPath, JSON.stringify(nextConfig, null, 2) + "\n");
  console.log(
    `OK — ${configPath} atualizado (slot${slot}=${pin ? "artigo-especial-apoiadores.md" : "inalterado"}, pinned_slots=${JSON.stringify(nextConfig.boxes_divulgacao_auto?.pinned_slots)}).`,
  );

  if (state && statePath) {
    writeArtigoEspecialState(statePath, withChannelState(state, "box", buildDoneChannelState(new Date().toISOString(), null)));
  }

  return { action: "updated", snippetsFile, configPath };
}

// ── CLI ───────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const titulo = values["titulo"];
  const gancho = values["gancho"];
  const mesLabel = values["mes"];
  if (!titulo || !gancho || !mesLabel) {
    console.error(
      "Uso: npx tsx scripts/update-artigo-especial-box.ts --titulo \"...\" --gancho \"...\" --mes \"Agosto\" " +
        "[--ano AAAA --slug slug] [--cta-url https://apoia.se/...] [--snippets-file path] [--config path] [--data-dir path] " +
        "[--slot 2] [--no-pin] [--unpin] [--force] [--dry-run]",
    );
    process.exit(2);
  }

  const snippetsFile = values["snippets-file"]
    ? resolve(ROOT, values["snippets-file"])
    : resolve(ROOT, "data/snippets/artigo-especial-apoiadores.md");
  const configPath = values["config"] ? resolve(ROOT, values["config"]) : resolve(ROOT, "platform.config.json");
  const dataDir = values["data-dir"] ? resolve(ROOT, values["data-dir"]) : resolve(ROOT, "data");
  // #5979/PR #6000 fleet review (silent-failure-hunter, alta confiança): usa
  // getIntArg — `parseInt(values["slot"], 10)` cru aceitava `--slot abc` como
  // NaN, que corrompia platform.config.json em silêncio (slotNaN,
  // pinned_slots com NaN) sem erro nenhum. getIntArg já existe pra fechar
  // exatamente essa classe de bug (docstring cita #4476/#4496, #4542/#4564,
  // #4568) — aborta com mensagem clara em vez de aceitar lixo.
  // #6748: default mudou de 3 para 2 — slot 3 foi eliminado da rotação e
  // nunca mais renderiza (ver docstring do módulo).
  // #6748: slot 3 foi eliminado da rotação — rejeitar explicitamente
  // `--slot 3` com mensagem que aponta a motivação, não só um max silente.
  const slot = getIntArg(process.argv.slice(2), "slot", { min: 1, max: 2 }) ?? 2;
  const dryRun = flags.has("dry-run");
  const force = flags.has("force");
  const unpin = flags.has("unpin");
  const pin = unpin ? false : !flags.has("no-pin");

  runUpdateArtigoEspecialBox({
    titulo,
    gancho,
    mesLabel,
    snippetsFile,
    configPath,
    dataDir,
    slot,
    pin,
    dryRun,
    force,
    ano: values["ano"],
    slug: values["slug"],
    ctaUrl: values["cta-url"],
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`Erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
