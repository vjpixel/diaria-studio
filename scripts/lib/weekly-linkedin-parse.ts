/**
 * weekly-linkedin-parse.ts (#4456)
 *
 * Extrai os candidatos elegíveis pra newsletter semanal do LinkedIn a partir
 * do `02-reviewed.md` de uma edição diária — reusa os parsers JÁ existentes
 * (`parseDestaques` de `extract-destaques.ts`, `parseSections` de
 * `newsletter-parse.ts`) em vez de escrever um parser novo (mesmo princípio
 * de `select-weekly-d1.ts`: "nada de parser novo").
 *
 * Comentário 260802 (2º) do #4456 mudou o critério de seleção de "só
 * manchete" pra "clique verificado da matéria" — candidato legítimo agora
 * pode vir de QUALQUER seção editorial (Destaque, Lançamentos, Radar, Use
 * Melhor), não só do DESTAQUE 1. `parseSections` já filtra pra essas 4
 * seções (SORTEIO/PARA ENCERRAR/ERRO INTENCIONAL/É IA? usam
 * `extractTemplateBlock`, não `parseSections` — nunca aparecem aqui).
 */

import { parseDestaques } from "../extract-destaques.ts";
import { parseSections } from "./newsletter-parse.ts";

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
