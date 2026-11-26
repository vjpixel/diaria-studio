/**
 * scripts/lib/claude-dir-candidate.ts (#14071)
 *
 * Detecção MECÂNICA, só de aviso, da issue aberta cuja correção parece
 * escrever na pasta de config do Claude Code (`.claude/skills`,
 * `.claude/agents`, `.claude/hooks`, `.claude/settings*.json`) e que ainda
 * não tem a label `claude-dir` (#11255). O overnight agendado roda em
 * `acceptEdits` sem TTY e não consegue editar `.claude/`; sem a label a issue
 * nasce `overnight` e a rodada só descobre o problema quando a edição é
 * negada (a #11104 ficou sem fazer na rodada 261026 assim).
 *
 * ## Aviso, nunca roteamento
 *
 * Citar `.claude/` no corpo não prova que a correção escreve lá (#14071,
 * passo 2 da proposta; item 34 de `context/overnight-dispatch-rules.md`:
 * "o roteamento é por label, nunca por heurística sobre o corpo"). Este
 * módulo NÃO aplica label e NÃO muda `classifyExecTrack`: produz um sinal
 * (`ClaudeDirCandidate`) que a triagem exibe para quem decide
 * (`route-issue.ts --track develop --motivo claude-dir`).
 *
 * ## Como separa ALVO de CONTEXTO
 *
 * O corpo é cortado pelos cabeçalhos markdown. Cada seção cai numa classe
 * pelo texto do cabeçalho:
 *
 * - `alvo`: onde a issue diz o que vai mudar ("Proposta", "Mudança
 *   proposta", "Skill e passo", "Correção", "Plano", "Passos"...). O título
 *   da issue também conta como alvo.
 * - `contexto`: evidência, medição, prova, risco, ganho, prioridade,
 *   histórico. Menção a `.claude/` aqui nunca sinaliza: é o caso das issues
 *   que citam um hook ou uma skill como evidência (#14004, #14061).
 * - `neutra`: preâmbulo sem cabeçalho e seções que não casam ("O que é").
 *   Só sinaliza caminho `.claude/` explícito numa frase com verbo de
 *   escrita.
 *
 * Dentro de alvo/neutra a frase com negação de escopo ("ficam onde
 * estão", "não mexer", "fora desta issue", "avaliar depois") é descartada.
 *
 * ## Força do sinal
 *
 * - `forte`: caminho explícito `.claude/{skills,agents,hooks}/...` ou
 *   `.claude/settings*.json` no título ou numa seção alvo (ou numa frase
 *   neutra com verbo de escrita).
 * - `fraca`: referência indireta numa seção alvo — `SKILL.md`, "playbook",
 *   nome de agent com `.md` (`orchestrator-stage-4.md`), `settings.json`,
 *   arquivo `.mjs` de hook — ou o nome de uma skill (`/diaria-*`) numa seção
 *   cujo cabeçalho fala de skill ("Skill e passo", modelo da revisão
 *   #13988).
 *
 * Calibrado contra os corpos reais da revisão #13984 (fixtures em
 * `test/claude-dir-candidate.test.ts`). Puro: sem I/O, sem rede.
 *
 * Falso negativo conhecido: a issue cuja mudança mora em `.claude/` sem que
 * o texto diga isso numa seção alvo (a #14061, roteada à mão, só cita
 * `.claude/skills/...` na Evidência). O detector reduz a lacuna, não a
 * fecha: a label continua sendo a fonte do roteamento.
 */
import { CLAUDE_DIR_LABEL } from "./issue-exec-track.ts";

/** Força do sinal (ver docblock). */
export type ClaudeDirStrength = "forte" | "fraca";

export interface ClaudeDirEvidence {
  /** Cabeçalho da seção (`"(título)"` para o título da issue, `"(preâmbulo)"`
   * para o texto antes do 1º cabeçalho). */
  section: string;
  /** O trecho que casou (`.claude/skills/x/SKILL.md`, `SKILL.md`, `/diaria-2-escrita`...). */
  ref: string;
  strength: ClaudeDirStrength;
  /** Frase onde casou, cortada em 160 caracteres. */
  excerpt: string;
}

export interface ClaudeDirCandidate {
  /** A mais forte entre as evidências. */
  strength: ClaudeDirStrength;
  evidence: ClaudeDirEvidence[];
}

export interface ClaudeDirIssueInput {
  title: string;
  body: string | null;
  labels: string[];
}

export interface ClaudeDirOptions {
  /** Nomes (sem `.md`) dos arquivos de `.claude/agents/`. Sem a lista, só
   * `orchestrator*.md` e `dev-*.md` contam como nome de agent. */
  agentNames?: readonly string[];
}

type SectionClass = "alvo" | "contexto" | "neutra";

const CONTEXT_HEADING =
  /evid[êe]ncia|medi[çc][ãa]o|prova|risco|como medir|hist[óo]ric|contexto|ganho|redu[çc][ãa]o|prioridade|fora d[eo] escopo|custo|refer[êe]ncia|complemento|motiva[çc][ãa]o|achado/i;
const TARGET_HEADING =
  /propost|mudan[çc]a|skill e passo|o que fazer|corre[çc][ãa]o|solu[çc][ãa]o|plano|passos|escopo|implementa|fix\b|onde mexer/i;
/** Cabeçalho que nomeia a skill afetada (modelo da revisão #13988). */
const SKILL_HEADING = /\bskills?\b/i;

/** Caminho explícito sob `.claude/` que é config do Claude Code (não
 * `.claude/worktrees/`). */
const STRONG_REF =
  /\.claude\/(?:(?:skills|agents|hooks)\/[\w.*{}\/-]*[\w*}]|settings(?:\.local)?\.json)/g;
const SKILL_INVOCATION = /(?<![\w/.-])\/diaria-[a-z0-9-]+/g;

/** Frase que tira a menção do escopo ("ficam onde estão", "não mexer"...). */
const SCOPE_NEGATION =
  /\bficam? (?:onde est[ãa]o|fora|como est[áa])|\bn[ãa]o (?:mexer|tocar|mudar|editar|alterar|fazer junto)|\bsem (?:tocar|mexer|mudar)|\bfora (?:desta|deste|do escopo)|\bavaliar depois|\bem separado\b|\boutra issue\b|\bpara n[ãa]o (?:quebrar|afetar)/i;

/** Verbo de escrita — exigido para caminho explícito em seção neutra. */
const WRITE_VERB =
  /\b(?:editar|alterar|mudar|mover|ajustar|corrigir|atualizar|reescrever|apagar|remover|tirar|adicionar|acrescentar|incluir|criar|dividir|separar|instruir|trocar|repontar|levar|cit[áa]-lo|registrar)\b/i;

function weakRefPatterns(agentNames: readonly string[] | undefined): RegExp[] {
  const names = (agentNames ?? []).filter((n) => /^[\w-]+$/.test(n));
  const agentAlt = names.length > 0 ? names.map((n) => n.replace(/-/g, "\\-")).join("|") : "orchestrator[\\w-]*|dev-[\\w-]+";
  return [
    /\bSKILL\.md\b/g,
    /\bplaybooks?\b/gi,
    new RegExp(`(?<![\\w/-])(?:${agentAlt})\\.md\\b`, "g"),
    /(?<![\w/-])settings(?:\.local)?\.json\b/g,
    /(?<![\w/-])[\w-]+\.mjs\b/g,
    // Prosa sem caminho: "citar X na skill da semanal", "prompt do subagente".
    /\b(?:n|d)[ao]s? skills?\b/gi,
    /\bprompt d[oe] (?:sub)?agente?\b/gi,
    /\bagent pr[óo]prio\b/gi,
  ];
}

function stripNoise(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ");
}

interface Section {
  heading: string;
  cls: SectionClass;
  skillHeading: boolean;
  text: string;
}

function classifyHeading(heading: string): SectionClass {
  // Contexto vence: "Fora de escopo", "Risco da mudança" não são alvo.
  if (CONTEXT_HEADING.test(heading)) return "contexto";
  if (TARGET_HEADING.test(heading)) return "alvo";
  return "neutra";
}

function splitSections(body: string): Section[] {
  const out: Section[] = [];
  let heading = "(preâmbulo)";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) {
      const pre = heading === "(preâmbulo)";
      out.push({
        heading,
        cls: pre ? "neutra" : classifyHeading(heading),
        skillHeading: !pre && SKILL_HEADING.test(heading),
        text,
      });
    }
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1] || "(sem título)";
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Frases: quebra em linha e em `.`/`;`/`!`/`?` seguido de espaço (caminho
 * com ponto, como `SKILL.md:12`, fica inteiro). */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.;!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function excerpt(s: string): string {
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function matchesOf(re: RegExp, s: string): string[] {
  re.lastIndex = 0;
  return [...s.matchAll(re)].map((m) => m[0]);
}

/**
 * Detecta se o texto (título + corpo) cita `.claude/` como ALVO da mudança.
 * Devolve `null` quando não há sinal. Não olha labels: ver
 * `claudeDirCandidateForIssue`.
 */
export function detectClaudeDirTarget(
  title: string,
  body: string | null,
  opts: ClaudeDirOptions = {},
): ClaudeDirCandidate | null {
  const weak = weakRefPatterns(opts.agentNames);
  const evidence: ClaudeDirEvidence[] = [];
  const seen = new Set<string>();
  const push = (section: string, ref: string, strength: ClaudeDirStrength, sentence: string) => {
    const key = `${section}\u0000${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ section, ref, strength, excerpt: excerpt(sentence) });
  };

  const sections: Section[] = [
    { heading: "(título)", cls: "alvo", skillHeading: false, text: title ?? "" },
    ...splitSections(stripNoise(body ?? "")),
  ];

  for (const sec of sections) {
    if (sec.cls === "contexto") continue;
    for (const sentence of splitSentences(sec.text)) {
      if (SCOPE_NEGATION.test(sentence)) continue;
      const strong = matchesOf(STRONG_REF, sentence);
      if (sec.cls === "alvo" || WRITE_VERB.test(sentence)) {
        for (const ref of strong) push(sec.heading, ref, "forte", sentence);
      }
      if (sec.cls !== "alvo") continue;
      for (const re of weak) {
        for (const ref of matchesOf(re, sentence)) push(sec.heading, ref, "fraca", sentence);
      }
      if (sec.skillHeading) {
        for (const ref of matchesOf(SKILL_INVOCATION, sentence)) push(sec.heading, ref, "fraca", sentence);
      }
    }
  }

  if (evidence.length === 0) return null;
  const strength: ClaudeDirStrength = evidence.some((e) => e.strength === "forte") ? "forte" : "fraca";
  return { strength, evidence };
}

/**
 * Candidata a `claude-dir`: sinal no texto E a label ainda ausente. Issue que
 * já tem a label devolve `null` (nada a avisar).
 */
export function claudeDirCandidateForIssue(
  issue: ClaudeDirIssueInput,
  opts: ClaudeDirOptions = {},
): ClaudeDirCandidate | null {
  if (issue.labels.includes(CLAUDE_DIR_LABEL)) return null;
  return detectClaudeDirTarget(issue.title, issue.body, opts);
}
