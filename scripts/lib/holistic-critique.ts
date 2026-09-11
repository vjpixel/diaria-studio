/**
 * scripts/lib/holistic-critique.ts (#7981, Camada 3 da #7972 — Fase 7)
 *
 * Crítica holística 3x com maioria sobre um candidato de destilação de
 * prompt (issue #7981: "crítica holística leve reusando social-critic.md
 * (Sonnet, effort baixo), rodada 3 vezes por caso com checagem de
 * consistência/maioria — divergência entre repetições bloqueia
 * automaticamente"). A LLM aqui só CRITICA (aprova/rejeita um diff já
 * montado mecanicamente) — nunca propõe o diff. Isso é o que separa este
 * módulo de "uma 2ª LLM propondo interpretação livre", proibido pela
 * issue.
 *
 * Cada voto é 1 chamada independente via `callClaudeCli`
 * (`claude-cli-subprocess.ts`, filtragem de ambiente não-negociável já
 * embutida ali). `runHolisticCritique` nunca decide sozinho com base em
 * maioria simples SEM checar consistência: as 3 respostas precisam
 * CONCORDAR (mesmo veredito) pra produzir uma decisão — qualquer
 * divergência bloqueia automaticamente (`consistent: false`,
 * `majorityPasses: null`), forçando revisão humana em vez de "2 de 3"
 * silencioso.
 */

import { callClaudeCli, type ClaudeCliCallOptions } from "./claude-cli-subprocess.ts";

export interface CritiqueVote {
  passes: boolean;
  reasoning: string;
}

const VERDICT_MARKER = /VEREDITO:\s*(APROVA|REJEITA)/i;
const REASONING_MARKER = /JUSTIFICATIVA:\s*([\s\S]*)/i;

/**
 * Parseia a resposta de 1 voto — exige o marcador `VEREDITO: APROVA` ou
 * `VEREDITO: REJEITA` em linha própria (formato pedido no prompt do
 * critic). `null` se o marcador não aparecer — resposta mal-formada NUNCA
 * é tratada como aprovação ou rejeição por default, só como voto inválido
 * (que `runHolisticCritique` trata como divergência, nunca maioria).
 */
export function parseCritiqueVote(text: string): CritiqueVote | null {
  const verdictMatch = VERDICT_MARKER.exec(text);
  if (!verdictMatch) return null;
  const passes = verdictMatch[1].toUpperCase() === "APROVA";
  const reasoningMatch = REASONING_MARKER.exec(text);
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : text.trim();
  return { passes, reasoning };
}

export interface HolisticCritiqueResult {
  votes: ReadonlyArray<CritiqueVote | null>;
  /** `true` só se as 3 chamadas produziram um veredito PARSEÁVEL e todos concordam. */
  consistent: boolean;
  /** `null` sempre que `consistent` é `false` — divergência bloqueia, nunca decide por maioria simples. */
  majorityPasses: boolean | null;
}

export type CallClaudeCliFn = typeof callClaudeCli;

/**
 * Roda `votes` chamadas independentes (default 3) com o MESMO prompt,
 * parseia cada resposta, e só produz uma decisão se todas concordarem.
 * `callFn` injetável (mesmo padrão `execFn`/`resolveClaudeBinFn` do resto
 * do repo) — testável sem spawnar `claude` de verdade.
 */
export function runHolisticCritique(
  prompt: string,
  opts: ClaudeCliCallOptions,
  votesCount = 3,
  callFn: CallClaudeCliFn = callClaudeCli,
): HolisticCritiqueResult {
  const votes: Array<CritiqueVote | null> = [];
  for (let i = 0; i < votesCount; i++) {
    const raw = callFn(prompt, opts);
    votes.push(parseCritiqueVote(raw));
  }
  const validVotes = votes.filter((v): v is CritiqueVote => v !== null);
  const consistent = validVotes.length === votesCount && validVotes.every((v) => v.passes === validVotes[0].passes);
  return {
    votes,
    consistent,
    majorityPasses: consistent ? validVotes[0].passes : null,
  };
}

/**
 * Monta o prompt de crítica a partir do corpo de `social-critic.md` (lido
 * pelo chamador, sem frontmatter YAML) + o candidato a criticar. Reusa o
 * TEXTO do agent prompt existente em vez de duplicar critérios — se
 * `social-critic.md` mudar, este prompt automaticamente reflete a mudança
 * na próxima chamada (não há cópia congelada aqui).
 */
export function buildCritiquePrompt(socialCriticBody: string, candidateDescription: string): string {
  return [
    socialCriticBody.trim(),
    "",
    "---",
    "",
    "Acima está sua instrução de crítica (adaptada de social-critic.md pra este contexto: você está revisando uma proposta de mudança de PROMPT de geração, não um texto final de newsletter — os mesmos princípios de 'soa como IA' e naturalidade editorial se aplicam ao TEXTO DE INSTRUÇÃO proposto, não a um artigo).",
    "",
    "Candidato a revisar:",
    candidateDescription,
    "",
    "Responda EXATAMENTE neste formato, sem markdown, sem texto antes:",
    "VEREDITO: APROVA",
    "ou",
    "VEREDITO: REJEITA",
    "JUSTIFICATIVA: <1-3 frases explicando por quê>",
  ].join("\n");
}
