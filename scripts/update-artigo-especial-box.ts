/**
 * update-artigo-especial-box.ts (#5979)
 *
 * Passo 5 da skill `/diaria-artigo-especial`: reescreve o CORPO de
 * `data/snippets/artigo-especial-apoiadores.md` com o título/gancho do
 * artigo especial do mês, e (por padrão) pina o box no slot 3 em
 * `platform.config.json` (via `boxes_divulgacao.slot3` +
 * `boxes_divulgacao_auto.pinned_slots`).
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
 * Uso:
 *   npx tsx scripts/update-artigo-especial-box.ts \
 *     --titulo "Engenharia de ilusão: jailbreak de IA não arromba, encena" \
 *     --gancho "O atacante assume um papel, e o modelo responde fiel à cena" \
 *     --mes "Agosto" \
 *     [--snippets-file data/snippets/artigo-especial-apoiadores.md] \
 *     [--config platform.config.json] \
 *     [--slot 3] [--no-pin] [--unpin] [--dry-run]
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

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
}

/** Seed usado quando o arquivo ainda não existe (bootstrap). */
export function buildDefaultArtigoEspecialBox(input: ArtigoEspecialBoxInput): string {
  return [
    ARTIGO_ESPECIAL_BOX_HEADER,
    "",
    buildTitleLine(input.mesLabel),
    "",
    buildQuoteParagraph(input.titulo, input.gancho),
    "",
    TIER_PARAGRAPH,
    "",
  ].join("\n");
}

export class ArtigoEspecialBoxFormatError extends Error {}

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
  return content
    .replace(TITLE_LINE_RE, buildTitleLine(input.mesLabel))
    .replace(QUOTE_PARAGRAPH_RE, buildQuoteParagraph(input.titulo, input.gancho));
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
        "[--snippets-file path] [--config path] [--slot 3] [--no-pin] [--unpin] [--dry-run]",
    );
    process.exit(2);
  }

  const snippetsFile = values["snippets-file"]
    ? resolve(ROOT, values["snippets-file"])
    : resolve(ROOT, "data/snippets/artigo-especial-apoiadores.md");
  const configPath = values["config"] ? resolve(ROOT, values["config"]) : resolve(ROOT, "platform.config.json");
  const slot = values["slot"] ? parseInt(values["slot"], 10) : 3;
  const dryRun = flags.has("dry-run");
  const unpin = flags.has("unpin");
  const pin = unpin ? false : !flags.has("no-pin");

  const existingContent = existsSync(snippetsFile) ? readFileSync(snippetsFile, "utf8") : null;
  const nextContent = renderArtigoEspecialBox(existingContent, { titulo, gancho, mesLabel });

  const config = JSON.parse(readFileSync(configPath, "utf8")) as BoxesDivulgacaoConfig;
  const nextConfig = applyBoxPin(config, { slot, filename: "artigo-especial-apoiadores.md", pin });

  if (dryRun) {
    console.log(`[dry-run] escreveria ${snippetsFile}:\n---\n${nextContent}\n---`);
    console.log(`[dry-run] escreveria ${configPath} com boxes_divulgacao.slot${slot}=${pin ? "artigo-especial-apoiadores.md" : "(inalterado)"}, pinned_slots=${JSON.stringify(nextConfig.boxes_divulgacao_auto?.pinned_slots)}`);
    return;
  }

  mkdirSync(dirname(snippetsFile), { recursive: true });
  writeFileAtomic(snippetsFile, nextContent);
  console.log(`OK — box atualizado em ${snippetsFile}`);

  writeFileAtomic(configPath, JSON.stringify(nextConfig, null, 2) + "\n");
  console.log(
    `OK — ${configPath} atualizado (slot${slot}=${pin ? "artigo-especial-apoiadores.md" : "inalterado"}, pinned_slots=${JSON.stringify(nextConfig.boxes_divulgacao_auto?.pinned_slots)}).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`Erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
