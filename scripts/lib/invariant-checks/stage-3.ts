/**
 * Invariants de Stage 3 — Imagens (#1007 Fase 1, #2133/#2141).
 *
 * Verifica que as 8 imagens existem (eia A/B, d1/d2/d3 2x1, d1/d2/d3 1x1) e
 * que prompts não violam regras editoriais (sem pixels explícitos, sem
 * Noite Estrelada).
 *
 * #2133/#2141: D2 e D3 agora também geram 2x1 como hero inline no email.
 * #2352: imagens e prompts do D3 são condicionais ao destaque_count (2 → d3 não requerido).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";
import { detectExecMode, type ExecMode } from "../exec-mode.ts";

const REQUIRED_IMAGES_BASE = [
  "01-eia-A.jpg",
  "01-eia-B.jpg",
  "04-d1-2x1.jpg",
  "04-d1-1x1.jpg",
  "04-d2-2x1.jpg", // #2133/#2141: hero inline D2
  "04-d2-1x1.jpg",
];

const REQUIRED_IMAGES_D3 = [
  "04-d3-2x1.jpg", // #2133/#2141: hero inline D3
  "04-d3-1x1.jpg",
];

/** Legacy flat export: full 3-destaque list — kept for backward-compat with tests. */
const REQUIRED_IMAGES = [...REQUIRED_IMAGES_BASE, ...REQUIRED_IMAGES_D3];

const PROMPT_FILES_BASE = [
  "04-d1-sd-prompt.json",
  "04-d2-sd-prompt.json",
];

const PROMPT_FILES_D3 = ["04-d3-sd-prompt.json"];

/** Legacy flat export. */
const PROMPT_FILES = [...PROMPT_FILES_BASE, ...PROMPT_FILES_D3];

/**
 * #2352: lê destaque_count de `_internal/01-approved-capped.json` (mesma
 * fonte usada por stitch-newsletter.ts). Returns 2 or 3; defaults to 3 on
 * missing/parse-error so existing 3-destaque editions always work.
 * Fail-loud se count fora de {2,3} — o Stage-1 invariant já deve ter
 * barrado isso; se chegar aqui é corrupção.
 */
function readDestaqueCount(editionDir: string): 2 | 3 {
  const approvedCappedPath = resolve(editionDir, "_internal", "01-approved-capped.json");
  if (!existsSync(approvedCappedPath)) return 3; // default; Stage-1 invariant cobre ausência
  try {
    const data = JSON.parse(readFileSync(approvedCappedPath, "utf8")) as {
      highlights?: unknown[];
    };
    if (!Array.isArray(data.highlights)) return 3;
    const n = data.highlights.length;
    if (n === 2) return 2;
    if (n === 3) return 3;
    // Out-of-range already rejected by Stage-1 invariant; default to 3 to
    // avoid cascading false-positives here.
    return 3;
  } catch {
    return 3; // parse error → keep default
  }
}

/**
 * Stage 4 (publicação) precisa das imagens requeridas. Sem elas, Beehiiv +
 * social falham — pegar antes do dispatch.
 * #2352: d3 images only required when destaque_count == 3.
 */
function checkAllImagesExist(editionDir: string): InvariantViolation[] {
  const destaqueCount = readDestaqueCount(editionDir);
  const requiredImages = destaqueCount === 2
    ? REQUIRED_IMAGES_BASE
    : REQUIRED_IMAGES;
  const violations: InvariantViolation[] = [];
  for (const name of requiredImages) {
    const path = resolve(editionDir, name);
    if (!existsSync(path)) {
      violations.push({
        rule: "all-images-exist",
        message: `Imagem ausente: ${name}`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      });
      continue;
    }
    const size = statSync(path).size;
    if (size < 1024) {
      violations.push({
        rule: "all-images-non-empty",
        message: `Imagem ${name} muito pequena (${size} bytes) — provavelmente corrompida`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      });
    }
  }
  return violations;
}

/**
 * Prompts não devem mencionar resolução em pixels (ex: "1024x1024", "2048px")
 * nem "Noite Estrelada" — duas regras editoriais explícitas em CLAUDE.md.
 * #2352: 04-d3-sd-prompt.json only checked when destaque_count == 3.
 */
function checkPromptsClean(editionDir: string): InvariantViolation[] {
  const destaqueCount = readDestaqueCount(editionDir);
  const promptFiles = destaqueCount === 2 ? PROMPT_FILES_BASE : PROMPT_FILES;
  const violations: InvariantViolation[] = [];
  for (const name of promptFiles) {
    const path = resolve(editionDir, name);
    if (!existsSync(path)) continue; // covered by all-images-exist via missing image
    let prompt: string;
    try {
      const json = JSON.parse(readFileSync(path, "utf8")) as { prompt?: string };
      prompt = json.prompt ?? "";
    } catch (e) {
      violations.push({
        rule: "prompts-parseable",
        message: `${name} JSON inválido: ${(e as Error).message}`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      });
      continue;
    }
    // Pixels: detect "NNNNxNNNN" or "NNNN px" patterns
    if (/\b\d{3,4}\s*x\s*\d{3,4}\b/i.test(prompt) || /\b\d{3,4}\s*px\b/i.test(prompt)) {
      violations.push({
        rule: "prompts-no-pixels",
        message: `Prompt em ${name} contém resolução em pixels (proibido por editorial-rules)`,
        source_issue: "#editorial-rules",
        severity: "error",
        file: path,
      });
    }
    if (/noite\s*estrelada|starry\s*night/i.test(prompt)) {
      violations.push({
        rule: "prompts-no-noite-estrelada",
        message: `Prompt em ${name} menciona Noite Estrelada (proibido por editorial-rules)`,
        source_issue: "#editorial-rules",
        severity: "error",
        file: path,
      });
    }
  }
  return violations;
}

/**
 * `01-eia.md` deve ter frontmatter:
 * ```yaml
 * eia_answer:
 *   A: real|ia
 *   B: real|ia
 * ```
 * (gerado por scripts/eia-compose.ts:171-176). Sem isso, Stage 4 não sabe
 * qual imagem é a verdadeira — quebra a Foto do Dia.
 */
function checkEiaAnswerResolved(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "01-eia.md");
  if (!existsSync(path)) {
    return [
      {
        rule: "eia-md-exists",
        message: `01-eia.md ausente`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      },
    ];
  }
  const md = readFileSync(path, "utf8");
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/m);
  const fm = fmMatch?.[1] ?? "";
  const aMatch = fm.match(/^\s+A:\s*(real|ia)\s*$/m);
  const bMatch = fm.match(/^\s+B:\s*(real|ia)\s*$/m);
  if (!aMatch || !bMatch) {
    return [
      {
        rule: "eia-answer-resolved",
        message:
          `01-eia.md sem frontmatter completo "eia_answer: { A: real|ia, B: real|ia }" — ` +
          `eia-composer não resolveu o sorteio. Stage 4 não sabe qual imagem promover.`,
        source_issue: "#192",
        severity: "error",
        file: path,
      },
    ];
  }
  if (aMatch[1] === bMatch[1]) {
    return [
      {
        rule: "eia-answer-pair-distinct",
        message:
          `01-eia.md tem A=${aMatch[1]} e B=${bMatch[1]} — par precisa ser real+ia, não duplicado.`,
        source_issue: "#192",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

const CARD_4X5_BASE = ["04-d1-4x5.jpg", "04-d2-4x5.jpg"];
const CARD_4X5_D3 = ["04-d3-4x5.jpg"];

/**
 * #4090 (decisão do editor, comentário 260728 na issue): o card social 4:5
 * (feed do Instagram/Facebook, título embutido, #4114) passa de opcional pra
 * MANDATÓRIO — "se o card 4:5 não gerar, o Stage 3 para. Nenhuma edição sai
 * sem card 4:5." Antes dessa decisão, `gen-social-card-4x5.ts` falhando era
 * tratado como não-bloqueante (orchestrator-stage-3.md logava warn e seguia)
 * e os publishers caíam pro 1:1 em silêncio — o estado que motivou a #4114
 * originalmente.
 *
 * Regra SEPARADA de `checkAllImagesExist` (não misturada na mesma lista) por
 * dois motivos: (1) evita alterar a contagem fixa que testes existentes
 * assertam pra `checkAllImagesExist`; (2) a causa mais comum de falha aqui é
 * específica (fonte de marca ausente — ver `assert-brand-font.ts`) e vale
 * nomear na mensagem, o que uma lista genérica de "imagem ausente" não faz.
 *
 * Esta checagem é defesa em profundidade: o call site real
 * (`orchestrator-stage-3.md`) já deve abortar no exit code não-zero de
 * `gen-social-card-4x5.ts` antes de chegar aqui. Este invariant cobre o caso
 * de uma sessão retomada pular essa instrução (resume de checkpoint, ou
 * edição de orquestração que não seguiu o prosa à risca).
 *
 * #4227: a mensagem acima já admitia que "geração de card é LOCAL por decisão
 * do editor — não roda em CI/container sem a fonte instalada", mas o check
 * continuava `severity: "error"` incondicional, sem consultar o sinal
 * canônico dessa exata classe de problema (`scripts/lib/exec-mode.ts` — ver
 * CLAUDE.md § Label `local`). Resultado: qualquer rodada `/diaria-overnight`/
 * `/diaria-edicao` em sessão cloud parava inteiramente no Stage 3, a menos
 * que alguém lembrasse de setar `DIARIA_ALLOW_FONT_FALLBACK=1` manualmente —
 * uma feature antes silenciosamente degradável virou hard-stop sem
 * acomodação automática pra cloud. Agora: em modo `cloud`, a violação sai
 * como `warning` automaticamente (sem exigir a env var); em modo `local`
 * (default), mantém `error` — comportamento intencional do editor,
 * inalterado. `execMode` é injetável só pra teste (default
 * `detectExecMode()`, mesmo padrão de `ExecModeOptions`).
 */
function checkCard4x5Exists(
  editionDir: string,
  execMode: ExecMode = detectExecMode(),
): InvariantViolation[] {
  const destaqueCount = readDestaqueCount(editionDir);
  const required = destaqueCount === 2 ? CARD_4X5_BASE : [...CARD_4X5_BASE, ...CARD_4X5_D3];
  const isCloud = execMode === "cloud";
  const violations: InvariantViolation[] = [];
  for (const name of required) {
    const path = resolve(editionDir, name);
    if (!existsSync(path)) {
      violations.push({
        rule: "card-4x5-exists",
        message: isCloud
          ? `Card social 4:5 ausente: ${name}. Rebaixado a warning automaticamente — sessão ` +
            `cloud (exec-mode.ts) não tem a fonte de marca (Georgia) instalada, e geração de ` +
            `card é LOCAL por decisão do editor (#4090, 260728). Em sessão local isto bloqueia ` +
            `o Stage 3; aqui os publishers caem pro 1:1 em silêncio pra este destaque.`
          : `Card social 4:5 ausente: ${name}. Decisão do editor (#4090, 260728): nenhuma ` +
            `edição sai sem o card 4:5 — sem ele, os publishers caem pro 1:1 EM SILÊNCIO. ` +
            `Causa mais comum: fonte de marca (Georgia) ausente nesta máquina — rode ` +
            `"npx tsx scripts/gen-social-card-4x5.ts --edition-dir ${editionDir}" pra ver o ` +
            `erro específico (a mensagem nomeia a fonte e a saída). Geração de card é LOCAL ` +
            `por decisão do editor — não roda em CI/container sem a fonte instalada.`,
        source_issue: "#4090",
        severity: isCloud ? "warning" : "error",
        file: path,
      });
    }
  }
  return violations;
}

export const STAGE_3_RULES: InvariantRule[] = [
  {
    id: "all-images-exist",
    description: "imagens obrigatórias (eia A/B + d1/d2 2x1/1x1; d3 2x1/1x1 condicional a destaque_count=3) (#2133/#2141/#2352)",
    source_issue: "#stage-3",
    stage: 3,
    run: checkAllImagesExist,
  },
  {
    id: "prompts-clean",
    description: "Prompts não mencionam pixels nem Noite Estrelada (d3 condicional a destaque_count=3, #2352)",
    source_issue: "#editorial-rules",
    stage: 3,
    run: checkPromptsClean,
  },
  {
    id: "eia-answer-resolved",
    description: "01-eia.md tem eia_answer A|B resolvido (#192)",
    source_issue: "#192",
    stage: 3,
    run: checkEiaAnswerResolved,
  },
  {
    id: "card-4x5-exists",
    description: "card social 4:5 (feed IG/FB, título embutido) existe pra cada destaque — mandatório (error) em sessão local (#4090); rebaixado a warning automaticamente em sessão cloud (#4227)",
    source_issue: "#4090",
    stage: 3,
    run: checkCard4x5Exists,
  },
];

export {
  checkAllImagesExist,
  checkPromptsClean,
  checkEiaAnswerResolved,
  checkCard4x5Exists,
  readDestaqueCount,
  REQUIRED_IMAGES,
  REQUIRED_IMAGES_BASE,
  REQUIRED_IMAGES_D3,
  PROMPT_FILES,
  PROMPT_FILES_BASE,
  PROMPT_FILES_D3,
  CARD_4X5_BASE,
  CARD_4X5_D3,
};
