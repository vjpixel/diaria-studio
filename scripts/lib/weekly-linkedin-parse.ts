/**
 * weekly-linkedin-parse.ts (#4456)
 *
 * Extrai os candidatos elegíveis pra newsletter semanal do LinkedIn a partir
 * do `02-reviewed.md` de uma edição diária — reusa os parsers JÁ existentes
 * (`parseDestaques` de `extract-destaques.ts`, `parseSections` de
 * `newsletter-parse.ts`) em vez de escrever um parser novo (mesmo princípio
 * de `select-weekly-d1.ts`: "nada de parser novo").
 *
 * Comentário 260802 (1º) do #4456 mudou o critério de seleção de "só
 * manchete" pra "clique verificado da matéria" — candidato legítimo agora
 * pode vir de QUALQUER seção editorial (Destaque, Lançamentos, Radar, Use
 * Melhor), não só do DESTAQUE 1. `parseSections` já filtra pra essas 4
 * seções (SORTEIO/PARA ENCERRAR/ERRO INTENCIONAL/É IA? usam
 * `extractTemplateBlock`, não `parseSections` — nunca aparecem aqui).
 */

import { parseDestaques } from "../extract-destaques.ts";
import { parseSections } from "./newsletter-parse.ts";
import { SECTIONS, sectionHeaderRegex } from "./section-naming.ts";

export type WeeklyCandidateKind = "destaque" | "section";

export interface WeeklyRawCandidate {
  /** AAMMDD da edição de origem. */
  editionDate: string;
  url: string;
  /** Título do bloco (literal — nunca reescrito na seleção/montagem). */
  title: string;
  /** Corpo (parágrafos, destaque) OU descrição de 1 linha (item de seção). */
  body: string;
  /** "Por que isso importa" — só destaques têm; "" para itens de seção. */
  why: string;
  kind: WeeklyCandidateKind;
  /** Categoria do destaque (`DESTAQUE N | categoria`) OU nome da seção (RADAR/LANÇAMENTOS/USE MELHOR/VÍDEOS). */
  category: string;
  /** Nome da seção normalizado — usado pra achar o pool "USE MELHOR" separadamente. */
  section: "destaque" | "lancamentos" | "radar" | "use_melhor" | "videos" | "outro";
}

function normalizeSectionName(name: string): WeeklyRawCandidate["section"] {
  const n = name.toUpperCase();
  if (n.startsWith("LANÇAMENTO")) return "lancamentos";
  if (n === "RADAR") return "radar";
  if (n === "USE MELHOR") return "use_melhor";
  if (n.startsWith("VÍDEO") || n.startsWith("VIDEO")) return "videos";
  return "outro";
}

/**
 * Pure: extrai todos os candidatos elegíveis (destaques + itens de seção com
 * URL não-vazia) do `02-reviewed.md` de UMA edição.
 */
export function extractWeeklyCandidates(md: string, editionDate: string): WeeklyRawCandidate[] {
  const out: WeeklyRawCandidate[] = [];

  for (const d of parseDestaques(md)) {
    if (!d.url) continue;
    out.push({
      editionDate,
      url: d.url,
      title: d.title,
      body: d.body,
      why: d.why,
      kind: "destaque",
      category: d.category,
      section: "destaque",
    });
  }

  for (const section of parseSections(md)) {
    const norm = normalizeSectionName(section.name);
    for (const item of section.items) {
      if (!item.url) continue;
      out.push({
        editionDate,
        url: item.url,
        title: item.title,
        body: item.description,
        why: "",
        kind: "section",
        category: section.name,
        section: norm,
      });
    }
  }

  return out;
}

/**
 * #4491: mapa `SectionDef.bucket` (fonte única em `section-naming.ts`) →
 * `WeeklyRawCandidate["section"]` — os nomes divergem em singular/plural
 * (`lancamento`/`video` vs `lancamentos`/`videos`) porque `normalizeSectionName`
 * acima deriva do LABEL plural exibido no MD, enquanto `SectionDef.bucket` é o
 * bucket do categorizer. `destaque`/`outro` ficam de fora de propósito — não
 * são seções secundárias com header reconhecível por `sectionHeaderRegex`.
 */
const BUCKET_TO_WEEKLY_SECTION: Record<string, WeeklyRawCandidate["section"]> = {
  lancamento: "lancamentos",
  radar: "radar",
  use_melhor: "use_melhor",
  video: "videos",
};

/**
 * Pure (#4491): detecta, para UMA edição, headers de seção reconhecíveis
 * (RADAR/LANÇAMENTOS/USE MELHOR/VÍDEOS) presentes no markdown BRUTO que não
 * geraram NENHUM candidato extraído (`extractWeeklyCandidates`) — sinal de
 * regressão no parser (formato de item que `parseSections`/`parseListItems`
 * não reconhece), distinto de "seção ausente" (sem header no markdown —
 * editor genuinamente não teve conteúdo pra essa seção nesta edição, ok).
 *
 * Cobre o gap que `candidates.length === 0` (falha TOTAL de parse, já
 * coberto por `emptyParseEditions` em `select-linkedin-weekly.ts`) deixa
 * passar: se só UMA seção mudar de formato enquanto as outras continuam
 * parseando, `candidates.length` da edição fica > 0 e nenhum warning
 * disparava antes — os itens da seção quebrada sumiam da disputa de seleção
 * em silêncio.
 *
 * Retorna os LABELS canônicos (ex: `["RADAR", "USE MELHOR"]`) das seções
 * "mortas" nessa edição — vazio se não há nenhuma.
 */
export function detectDeadSectionHeaders(md: string, candidates: WeeklyRawCandidate[]): string[] {
  const presentSections = new Set(candidates.filter((c) => c.kind === "section").map((c) => c.section));
  const dead: string[] = [];
  for (const def of SECTIONS) {
    if (def.legacy) continue; // aliases legacy (PESQUISAS/OUTRAS NOTÍCIAS) não emitidos em edições novas — fora de escopo.
    const weeklySection = BUCKET_TO_WEEKLY_SECTION[def.bucket];
    if (!weeklySection) continue;
    const headerFound = sectionHeaderRegex(def.pattern, { flags: "mu" }).test(md);
    if (headerFound && !presentSections.has(weeklySection)) {
      dead.push(def.label);
    }
  }
  return dead;
}
