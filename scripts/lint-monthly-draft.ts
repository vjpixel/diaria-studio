/**
 * lint-monthly-draft.ts (#423, guardrail de render #2794)
 *
 * Valida limites de caracteres por destaque no digest mensal:
 *   D1 ≤ 1.500 chars, D2/D3 ≤ 1.200 chars
 *
 * Contagem: do primeiro parágrafo de prosa até o fim do "O fio condutor:",
 * excluindo a linha de cabeçalho (DESTAQUE N | TEMA), a linha de título
 * e os URLs de links ancorados [texto](url) — conta só o texto âncora.
 *
 * #2794: além do lint de chars (advisory), roda um guardrail CRÍTICO — simula
 * o render final (`draftToEmail`, o mesmo código que gera o email de verdade)
 * e verifica que (a) todos os labels de seção esperados foram reconhecidos
 * por `splitByLabels` e (b) o render produz pelo menos 1 `<img>` por destaque
 * quando URLs de imagem são fornecidas. Isso reproduz deterministicamente o
 * bug real do ciclo 2606-07 (writer-monthly emitiu labels em texto plano →
 * draft inteiro virou 1 parágrafo de fallback → zero imagens, zero seções) —
 * SEM depender de imagens reais (Etapa 3, que ainda não rodou neste ponto do
 * pipeline), usando URLs de imagem fictícias como sonda.
 *
 * #2818 (self-review finding 1): o guardrail crítico acima só cobre o
 * subconjunto de labels que causa zero-imagem/zero-seção se perdido. Um
 * segundo check (`checkOptionalSectionIntegrity`) generaliza pros labels
 * OPCIONAIS (CLARICE —, LIVROS, PREVIEW, REMETENTE,
 * LABORATÓRIO CLARICE, OUTRAS NOTÍCIAS DO MÊS): se PRESENTES no draft,
 * exige que sejam reconhecidos como seção — sem exigir presença.
 *
 * #2913: APRESENTAÇÃO (preâmbulo Clarice × diar.ia.br) MIGROU de opcional pra
 * REQUIRED_SECTION_CHECKS — era boilerplate fixo mas opcional aqui, e faltou
 * de fato na edição real do ciclo 2606-07 sem que o lint acusasse nada.
 *
 * Uso:
 *   npx tsx scripts/lint-monthly-draft.ts --cycle YYMM-MM
 *   npx tsx scripts/lint-monthly-draft.ts 2604   (legado, --cycle preferido)
 *
 * Exit codes:
 *   0  Draft íntegro (warnings de char-limit, se houver, são advisory)
 *   1  FALHA CRÍTICA de render (#2794): label(s) esperado(s) não reconhecido(s)
 *      pelo parser, ou o render simulado produziria uma edição sem imagem —
 *      nunca deve passar silencioso
 *   2  Erro de I/O (draft não encontrado)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseMonthlyCycleArg,
  monthlyDir as resolveMonthlyDir,
  cycleToYymm,
} from "./lib/mensal/monthly-paths.ts";
import { splitByLabels, normalizeLabel, draftToEmail } from "./lib/mensal/monthly-render.ts";
import { isMainModule } from "./lib/cli-args.ts";

const LIMITS: Record<string, number> = { D1: 1500, D2: 1200, D3: 1200 };

function stripInlineLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

// ─── Guardrail crítico (#2794) ──────────────────────────────────────────────

export interface SectionIntegrityResult {
  ok: boolean;
  missing: string[];
  sectionCount: number;
}

/** Vocabulário mínimo de labels que TODO draft mensal deve conter (independente
 * de estarem em negrito ou não — `splitByLabels` já tolera ambos, #2794). */
export const REQUIRED_SECTION_CHECKS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "ASSUNTO", re: /^ASSUNTO\b/i },
  // #2913: APRESENTAÇÃO (preâmbulo Clarice × diar.ia.br) é boilerplate fixo
  // emitido todo mês pelo template/writer — faltou no ciclo 2606-07 justamente
  // porque era opcional aqui (OPTIONAL_SECTION_CHECKS) e não bloqueava o lint.
  { name: "APRESENTAÇÃO", re: /^APRESENTA[ÇC][ÃA]O\b/i },
  { name: "INTRO", re: /^INTRO$/i },
  { name: "DESTAQUE 1", re: /^DESTAQUE\s+1\b/i },
  { name: "DESTAQUE 2", re: /^DESTAQUE\s+2\b/i },
  { name: "DESTAQUE 3", re: /^DESTAQUE\s+3\b/i },
  { name: "USE MELHOR", re: /^USE\s+MELHOR/i },
  { name: "RADAR", re: /^RADAR/i },
  { name: "É IA?", re: /^É\s*IA\?/i },
  { name: "ENCERRAMENTO", re: /^(ENCERRAMENTO|PARA\s+ENCERRAR)$/i },
];

/**
 * Pure: verifica se `splitByLabels` reconhece todos os labels obrigatórios do
 * draft como fronteiras de seção distintas. `sectionCount` baixo (ex: 1) é o
 * sintoma direto do bug #2794 — o draft inteiro caiu no fallback de 1 chunk.
 */
export function checkSectionIntegrity(draft: string): SectionIntegrityResult {
  const sections = splitByLabels(draft);
  const firstLines = sections.map((s) => normalizeLabel(s.split("\n")[0] ?? ""));
  const missing = REQUIRED_SECTION_CHECKS.filter(
    (c) => !firstLines.some((l) => c.re.test(l)),
  ).map((c) => c.name);
  return { ok: missing.length === 0, missing, sectionCount: sections.length };
}

/**
 * Labels OPCIONAIS — podem faltar em drafts legítimos (CLARICE é mensal e às
 * vezes omitida, LIVROS é um box promocional opcional, PREVIEW/REMETENTE só
 * existem no header, LABORATÓRIO CLARICE nem sempre roda). Diferente de
 * REQUIRED_SECTION_CHECKS, a AUSÊNCIA aqui nunca é falha.
 *
 * `presentRe` é um detector independente de "isso parece uma tentativa desse
 * label" (nome exato, com ou sem `**`/`*` ao redor, tolerando negrito
 * assimétrico/malformado — ex: `**LIVROS` sem fechar). `re` é o mesmo padrão
 * usado em REQUIRED_SECTION_CHECKS pra verificar se o label de fato virou
 * fronteira de seção reconhecida por `splitByLabels`.
 *
 * Self-review finding #1 do PR #2818 (#2794 follow-up): o guardrail original
 * só cobria o subconjunto crítico de labels (os que causam zero-imagem/
 * zero-seção se perdidos). Uma perda de negrito ISOLADA numa seção CLARICE/
 * LIVROS/PREVIEW/REMETENTE (ex: negrito assimétrico do Drive export) não
 * derrubava sectionCount nem zerava <img>, então passava despercebida — a
 * seção só caía silenciosamente no fallback `renderParagraphs` (perde o box
 * estilizado, listas numeradas, botão CTA). Este check generaliza: para
 * QUALQUER label desse vocabulário que esteja PRESENTE no draft, exige que
 * `splitByLabels` o reconheça como seção própria — sem tornar nenhum deles
 * obrigatório.
 */
export const OPTIONAL_SECTION_CHECKS: ReadonlyArray<{ name: string; presentRe: RegExp; re: RegExp }> = [
  { name: "REMETENTE", presentRe: /^\**REMETENTE\**\s*$/m, re: /^REMETENTE\b/i },
  { name: "PREVIEW", presentRe: /^\**PREVIEW\**\s*$/m, re: /^PREVIEW\b/i },
  { name: "LIVROS", presentRe: /^\**LIVROS\**\s*$/m, re: /^LIVROS\b/i },
  { name: "CLARICE —", presentRe: /^\**CLARICE\s+—/m, re: /^CLARICE\s+—/i },
  { name: "LABORATÓRIO CLARICE", presentRe: /^\**LABORAT[ÓO]RIO\s+CLARICE\**\s*$/m, re: /^LABORAT[ÓO]RIO\s+CLARICE\b/i },
  { name: "OUTRAS NOTÍCIAS DO MÊS", presentRe: /^\**OUTRAS\s+NOT[ÍI]CIAS\s+DO\s+M[ÊE]S\**\s*$/m, re: /^OUTRAS\s+NOT[ÍI]CIAS\s+DO\s+M[ÊE]S\b/i },
];

/**
 * Pure: para cada label OPCIONAL cuja presença é detectada no draft (bold,
 * sem bold ou negrito malformado), verifica se `splitByLabels` de fato o
 * reconheceu como fronteira de seção. Ausência total do label (`presentRe`
 * não bate em nenhuma linha) nunca entra em `missing` — só presença sem
 * reconhecimento.
 */
export function checkOptionalSectionIntegrity(draft: string): SectionIntegrityResult {
  const sections = splitByLabels(draft);
  const firstLines = sections.map((s) => normalizeLabel(s.split("\n")[0] ?? ""));
  const missing = OPTIONAL_SECTION_CHECKS.filter((c) => c.presentRe.test(draft))
    .filter((c) => !firstLines.some((l) => c.re.test(l)))
    .map((c) => c.name);
  return { ok: missing.length === 0, missing, sectionCount: sections.length };
}

export interface ImageRenderProbeResult {
  ok: boolean;
  imgCount: number;
}

/**
 * Pure: simula o render final com URLs de imagem FICTÍCIAS pros 3 destaques
 * (a Etapa 3 real ainda não rodou neste ponto do pipeline — Etapa 2). Se o
 * HTML resultante tiver menos de 3 `<img>`, os labels DESTAQUE N não foram
 * corretamente separados por `splitByLabels` e a edição sairia sem imagem em
 * produção — a causa raiz real do ciclo 2606-07.
 */
export function checkImageRenderProbe(draft: string, yymm: string): ImageRenderProbeResult {
  const probeUrls = {
    1: "https://probe.invalid/lint-monthly-d1.jpg",
    2: "https://probe.invalid/lint-monthly-d2.jpg",
    3: "https://probe.invalid/lint-monthly-d3.jpg",
  };
  const { html } = draftToEmail(
    draft,
    "Assunto de sonda (lint-monthly-draft)",
    yymm,
    undefined,
    undefined,
    undefined,
    probeUrls,
    "Criada com IA",
  );
  const imgCount = (html.match(/<img\b/g) ?? []).length;
  return { ok: imgCount >= 3, imgCount };
}

function extractBody(section: string): string {
  const lines = section.trim().split("\n");
  // line 0: "DESTAQUE N | TEMA", line 1: blank, line 2: título — skip both
  const start = lines.findIndex((l, i) => i >= 2 && l.trim() !== "");
  if (start === -1) return "";

  const body = lines.slice(start);

  // Find end: last non-empty line that is part of "O fio condutor:" block
  let fioStart = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].startsWith("O fio condutor:")) { fioStart = i; break; }
  }
  if (fioStart === -1) return body.join("\n");

  // Include fio condutor label + its paragraph (next non-empty block)
  let end = fioStart + 1;
  while (end < body.length && body[end].trim() !== "") end++;

  return body.slice(0, end).join("\n");
}

function main(): void {
  // Aceita --cycle 2605-06 (novo) ou argumento posicional 2604 (legado compat).
  const cycle = parseMonthlyCycleArg(process.argv.slice(2));
  if (!cycle) {
    console.error(
      "Uso: npx tsx scripts/lint-monthly-draft.ts --cycle YYMM-MM\n" +
      "Compat: npx tsx scripts/lint-monthly-draft.ts <YYMM>",
    );
    process.exit(2);
  }

  const path = join(resolveMonthlyDir(cycle), "draft.md");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[lint-monthly] Erro lendo ${path}: ${(e as Error).message}`);
    process.exit(2);
  }

  // #2794: guardrail crítico ANTES do lint de chars — nunca deve passar
  // silencioso. Roda incondicionalmente (não é advisory como o resto deste
  // script).
  const yymm = cycleToYymm(cycle);
  const sectionCheck = checkSectionIntegrity(text);
  const optionalSectionCheck = checkOptionalSectionIntegrity(text);
  const imageCheck = checkImageRenderProbe(text, yymm);
  let hasFatal = false;

  if (!sectionCheck.ok) {
    hasFatal = true;
    console.error(
      `[lint-monthly] FATAL: labels de seção não reconhecidos: ${sectionCheck.missing.join(", ")} ` +
      `(apenas ${sectionCheck.sectionCount} seção(ões) detectada(s) no total). ` +
      "O writer-monthly provavelmente emitiu labels em texto plano (sem **negrito**) — ver #2794.",
    );
  }
  if (!optionalSectionCheck.ok) {
    hasFatal = true;
    console.error(
      `[lint-monthly] FATAL: label(s) opcional(is) presente(s) no draft mas não reconhecido(s) como seção: ` +
      `${optionalSectionCheck.missing.join(", ")}. Provavelmente negrito perdido ou malformado (assimétrico) — ` +
      "a seção vai cair silenciosamente no fallback renderParagraphs (perde box estilizado/CTA/lista). Ver #2794, #2818.",
    );
  }
  if (!imageCheck.ok) {
    hasFatal = true;
    console.error(
      `[lint-monthly] FATAL: render simulado (draftToEmail com URLs de sonda) produziu apenas ` +
      `${imageCheck.imgCount}/3 <img> para os destaques — a edição sairia SEM IMAGEM em produção. Ver #2794.`,
    );
  }
  if (hasFatal) {
    console.error("[lint-monthly] ══════════════════════════════════════════════════════════════");
    console.error("[lint-monthly] DRAFT COM FALHA CRÍTICA DE RENDER — NÃO PROSSEGUIR SEM CORRIGIR O DRAFT.");
    console.error("[lint-monthly] ══════════════════════════════════════════════════════════════");
    process.exit(1);
  }
  console.log(`[lint-monthly] guardrail de render OK — ${sectionCheck.sectionCount} seções reconhecidas, ${imageCheck.imgCount}/3 <img> na sonda.`);

  const sections = text.split("\n---\n");
  const targets = [
    { label: "D1", prefix: "DESTAQUE 1 |" },
    { label: "D2", prefix: "DESTAQUE 2 |" },
    { label: "D3", prefix: "DESTAQUE 3 |" },
  ];

  let hasWarning = false;

  for (const { label, prefix } of targets) {
    // Aceita header plain ou em **negrito** (#590) — match prefix com ou sem `**` leading.
    const section = sections.find(s => {
      const trimmed = s.trim();
      return trimmed.startsWith(prefix) || trimmed.startsWith("**" + prefix);
    });
    if (!section) {
      console.log(`[lint-monthly] ${label}: não encontrado no draft`);
      continue;
    }
    const body = extractBody(section);
    const prose = stripInlineLinks(body);
    const chars = prose.replace(/\r/g, "").length;
    const limit = LIMITS[label];
    const ok = chars <= limit;
    console.log(`[lint-monthly] ${label}: ${chars} chars / ${limit} ${ok ? "✓" : "⚠  EXCEDE"}`);
    if (!ok) hasWarning = true;
  }

  if (hasWarning) {
    console.log("[lint-monthly] Um ou mais destaques excedem o limite — revisar antes de publicar.");
  }

  process.exit(0);
}

// Só roda main() quando invocado como CLI — permite importar as funções puras
// (checkSectionIntegrity, checkImageRenderProbe) em testes sem disparar
// process.exit() no import (#2794).
if (isMainModule(import.meta.url)) {
  main();
}
