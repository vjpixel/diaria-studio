/**
 * propose-intentional-error-candidate.ts (#8592)
 *
 * Gerador DETERMINÍSTICO do candidato de erro intencional que o Stage 4 deve
 * propor PROATIVAMENTE ao montar o gate, quando detecta que
 * `_internal/intentional-error.json` ainda tem campos `{PREENCHER}` (Stage 2
 * pulou/bypassou a declaração — ver `orchestrator-stage-4.md` §"Erro
 * intencional ainda placeholder ao montar o gate", #5566).
 *
 * **Escopo exato da issue #8592 (comentário do editor, 21/09/2026):** gerar
 * uma proposta completa (os 5 campos), pronta pra o editor aceitar em 1
 * clique, trocar, ou escrever a própria — **nunca** gravar/plantar nada em
 * disco sozinho. Este módulo é PURO: recebe o texto de `02-reviewed.md` e
 * devolve um candidato ou `null`. Quem grava em
 * `_internal/intentional-error.json` (após aceite explícito do editor) é o
 * orchestrator, no chat — mesmo fluxo de sempre, só que agora com uma
 * proposta pronta em vez de um formulário em branco.
 *
 * Filtro de segurança aplicado (#3808 + #5742, `context/editorial-rules.md`
 * §10 "Concurso 'ache o erro'"):
 *   1. **Nunca no fato central de um DESTAQUE** (Regra 3) — a busca só
 *      considera seções secundárias (RADAR/USE MELHOR/LANÇAMENTOS/VÍDEOS/É
 *      IA?), nunca o corpo de um bloco `DESTAQUE N`. Não precisa detectar
 *      "frase que carrega o fato principal" dentro do destaque porque o
 *      destaque inteiro fica fora de escopo.
 *   2. **Erro cômico/leve, não inflação de magnitude** — só usa o catálogo
 *      de grafias erradas óbvias em nomes de entidades de IA muito
 *      conhecidas do público da newsletter (padrão de maior taxa de aceite,
 *      #5742: "Craude", "Anthropik", "Hugging Race").
 *   3. **Menção lateral/secundária** — decorre do item 1 (seção secundária
 *      inteira já é lateral em relação aos destaques).
 *
 * Categoria sempre `ortografico` — segura por design
 * (`checkIntentionalErrorSafety`, nunca cai nas categorias de risco
 * `numeric`/`factual`/`data`).
 */

import type { IntentionalError, IntentionalErrorJson } from "./intentional-errors.ts";
import { findRecentRepeats, DEFAULT_REPEAT_WINDOW_DAYS } from "./intentional-error-repeat.ts";
import { SECTION_EMOJI_PREFIX } from "./section-naming.ts";

export interface IntentionalErrorCandidate {
  description: NonNullable<IntentionalErrorJson["description"]>;
  location: NonNullable<IntentionalErrorJson["location"]>;
  category: NonNullable<IntentionalErrorJson["category"]>;
  correct_value: NonNullable<IntentionalErrorJson["correct_value"]>;
  wrong_value: NonNullable<IntentionalErrorJson["wrong_value"]>;
  reveal: NonNullable<IntentionalErrorJson["reveal"]>;
}

interface EntityMisspelling {
  correct: string;
  wrong: string;
}

/**
 * Catálogo #5742 — grafias erradas óbvias em nomes de entidades de IA MUITO
 * conhecidas do público da newsletter (empresa/produto). Curado, não
 * exaustivo: cada entrada é uma troca de letra/duplicação que qualquer
 * leitor reconhece de cabeça como digitação, nunca um dado que possa ser
 * lido como fato (Regra 2, "não gerar desinformação").
 */
const KNOWN_ENTITY_MISSPELLINGS: readonly EntityMisspelling[] = [
  { correct: "Claude", wrong: "Craude" },
  { correct: "Anthropic", wrong: "Anthropik" },
  { correct: "Hugging Face", wrong: "Hugging Race" },
  { correct: "ChatGPT", wrong: "ChatGTP" },
  { correct: "Gemini", wrong: "Gemine" },
  { correct: "DeepMind", wrong: "DeepMinde" },
  { correct: "Mistral", wrong: "Mistrall" },
  { correct: "Perplexity", wrong: "Perplexit" },
  { correct: "Copilot", wrong: "Copilto" },
  { correct: "Grok", wrong: "Grook" },
];

/** Nomes de seção SECUNDÁRIA (nunca DESTAQUE) onde é seguro procurar uma
 * menção lateral — mesmo vocabulário de `section-naming.ts`/`newsletter-count.ts`,
 * reimplementado aqui em regex simples pra não acoplar a internals privados
 * daqueles módulos. */
const SECONDARY_SECTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "LANÇAMENTOS", re: /^\s*(?:\*\*)?(?:🚀\s*)?LAN[ÇC]AMENTOS?\s*(?:\*\*)?\s*$/imu },
  { name: "RADAR", re: /^\s*(?:\*\*)?(?:📡\s*)?(?:RADAR|OUTRAS?\s+NOT[ÍI]CIAS?)\s*(?:\*\*)?\s*$/imu },
  { name: "USE MELHOR", re: /^\s*(?:\*\*)?(?:🛠️\s*)?USE\s+MELHOR\s*(?:\*\*)?\s*$/imu },
  { name: "VÍDEOS", re: /^\s*(?:\*\*)?(?:📺\s*)?V[ÍI]DEOS?\s*(?:\*\*)?\s*$/imu },
  { name: "É IA?", re: /^\s*(?:##\s+)?É\s+IA\?\s*$/imu },
];

/** Header de bloco `DESTAQUE N` — usado só pra CORTAR o texto desses blocos
 * fora da busca (Regra 3), nunca pra identificar seção onde plantar. */
const DESTAQUE_HEADER_RE = /^\s*(?:\*\*)?DESTAQUE\s+\d+(?:\s*\||\s*(?:\*\*)?\s*$)/im;

/** Fragmento com os nomes de TODOS os headers reconhecidos (destaque +
 * seções secundárias) — usado só como ponto de corte do documento em
 * blocos, mesma estratégia de `SECTION_HEADER_LOOKAHEAD` em
 * `newsletter-count.ts` (lookahead, não consome, então cada header vira o
 * início do bloco seguinte mesmo sem `---` isolando as seções). */
const EMOJI_PREFIX_FRAGMENT = `(?:\\*\\*)?${SECTION_EMOJI_PREFIX}`;
const ALL_HEADER_NAMES_FRAGMENT =
  "LAN[ÇC]AMENTOS?|RADAR|OUTRAS?\\s+NOT[ÍI]CIAS?|OUTRA\\s+NOT[ÍI]CIA|USE\\s+MELHOR|V[ÍI]DEOS?";
const BLOCK_SPLIT_LOOKAHEAD = new RegExp(
  `(?=^\\s*${EMOJI_PREFIX_FRAGMENT}(?:${ALL_HEADER_NAMES_FRAGMENT})[^\\n]*$)|(?=^\\s*(?:\\*\\*)?DESTAQUE\\s+\\d)|(?=^\\s*(?:##\\s+)?É\\s+IA\\?)`,
  "imu",
);

/** Divide o corpo em blocos: primeiro por linha `---` isolada (separador
 * usado entre destaques/boxes), depois cada trecho é sub-dividido no
 * lookahead de qualquer header conhecido — sem isso, duas seções
 * consecutivas sem `---` entre elas (comum entre RADAR/USE MELHOR/VÍDEOS)
 * cairiam no mesmo bloco e um `DESTAQUE` adjacente contaminaria uma seção
 * secundária vizinha via `DESTAQUE_HEADER_RE.test(block)`. */
function splitIntoBlocks(md: string): string[] {
  const byRule = md.split(/^\s*---\s*$/m);
  const blocks: string[] = [];
  for (const chunk of byRule) {
    blocks.push(...chunk.split(BLOCK_SPLIT_LOOKAHEAD));
  }
  return blocks;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ProposeOptions {
  /** (#9101) Histórico de `data/intentional-errors.jsonl` já carregado. Ausente = sem filtro de repetição. */
  history?: IntentionalError[];
  /** (#9101) AAMMDD da edição — referência da janela de repetição. */
  edition?: string;
  /** (#9101) Janela em dias (default 30). */
  windowDays?: number;
}

/**
 * Pure (#8592): dado o texto de `02-reviewed.md`, procura a primeira menção
 * (em ordem de documento) de uma entidade do catálogo dentro de uma seção
 * SECUNDÁRIA (nunca dentro de um bloco `DESTAQUE N`) e monta um candidato
 * completo. Retorna `null` quando nenhuma seção secundária menciona nenhuma
 * entidade do catálogo — não força candidato ruim; o Stage 4 cai de volta
 * pra perguntar em aberto (comportamento pré-#8592).
 *
 * (#9101) Com `opts.history`: descarta grafia errada JÁ usada em qualquer
 * edição (ex: "Craude", 3x) e entidade (`correct_value`) usada dentro da
 * janela (ex: Anthropic em 260928); entre as restantes, prefere entidade
 * nunca usada (inédita) antes de cair numa já usada fora da janela.
 */
export function proposeIntentionalErrorCandidate(
  reviewedMd: string,
  opts: ProposeOptions = {},
): IntentionalErrorCandidate | null {
  for (const c of listIntentionalErrorCandidates(reviewedMd, opts)) return c;
  return null;
}

/**
 * (#9255) Todos os candidatos, na MESMA ordem de preferência de
 * `proposeIntentionalErrorCandidate` (que devolve o 1º). Usado pelo plantio
 * pra tentar o próximo quando o 1º não é plantável (menção só em URL etc.).
 * Sem duplicatas por (seção, entidade).
 */
export function* listIntentionalErrorCandidates(
  reviewedMd: string,
  opts: ProposeOptions = {},
): Generator<IntentionalErrorCandidate> {
  const seen = new Set<string>();
  const blocks = splitIntoBlocks(reviewedMd);
  const history = opts.history ?? [];
  const edition = opts.edition ?? "";
  const windowDays = opts.windowDays ?? DEFAULT_REPEAT_WINDOW_DAYS;

  const isBlocked = ({ correct, wrong }: EntityMisspelling): boolean =>
    history.length > 0 &&
    (findRecentRepeats({ wrong_value: wrong }, history, edition, { windowDays: Infinity }).length > 0 ||
      findRecentRepeats({ correct_value: correct }, history, edition, { windowDays }).length > 0);
  const entityEverUsed = ({ correct }: EntityMisspelling): boolean =>
    history.length > 0 &&
    findRecentRepeats({ correct_value: correct }, history, edition, { windowDays: Infinity }).length > 0;

  // 1ª passada: só entidades inéditas; 2ª: aceita entidade usada fora da janela.
  for (const allowUsedEntity of [false, true]) {
    for (const block of blocks) {
      if (DESTAQUE_HEADER_RE.test(block)) continue; // Regra 3 — nunca em bloco de destaque

      const section = SECONDARY_SECTION_PATTERNS.find(({ re }) => re.test(block));
      if (!section) continue; // bloco não identificado como seção secundária conhecida (ex: intro) — pula, não arrisca

      for (const entry of KNOWN_ENTITY_MISSPELLINGS) {
        const { correct, wrong } = entry;
        const wordBoundaryRe = new RegExp(`\\b${escapeRegExp(correct)}\\b`);
        if (!wordBoundaryRe.test(block)) continue;
        if (isBlocked(entry)) continue; // #9101
        if (!allowUsedEntity && entityEverUsed(entry)) continue; // #9101 — prefere inédita

        const key = `${section.name}|${correct}`;
        if (seen.has(key)) continue;
        seen.add(key);
        yield {
          description:
            "Uma marca de IA muito conhecida do público da newsletter aparece com o nome grafado errado numa menção lateral do texto.",
          location: `${section.name} (menção a "${correct}")`,
          category: "ortografico",
          correct_value: correct,
          wrong_value: wrong,
          reveal: `Na última edição, escrevi "${wrong}" onde o correto é "${correct}".`,
        };
      }
    }
  }

}
