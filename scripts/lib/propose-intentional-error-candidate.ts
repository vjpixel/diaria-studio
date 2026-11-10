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

/** Tipo da marca — muda só a descrição/narrativa ("marca de IA" × "marca de tecnologia"). */
export type BrandKind = "ia" | "tecnologia";

interface EntityMisspelling {
  correct: string;
  /** Grafias erradas em ordem de preferência (#12612): a 1ª já usada em qualquer edição cede a vez à seguinte. */
  wrongs: readonly string[];
  kind: BrandKind;
}

/**
 * Catálogo #5742 — grafias erradas óbvias em nomes de entidades de IA MUITO
 * conhecidas do público da newsletter (empresa/produto). Curado, não
 * exaustivo: cada entrada é uma troca de letra/duplicação que qualquer
 * leitor reconhece de cabeça como digitação, nunca um dado que possa ser
 * lido como fato (Regra 2, "não gerar desinformação").
 *
 * #12612: cada entidade tem VÁRIAS grafias (a 1ª é a original, mantida pra
 * não mudar a proposta de quem já tinha candidato), e o catálogo ganhou um
 * 2º nível (`EXTENDED_ENTITY_MISSPELLINGS`). Motivo: com a entidade repetida
 * em 30 dias virando ERRO, o catálogo de 10 marcas com 1 grafia cada se
 * esgotava (261110: 6 das 10 marcas usadas nos 30 dias anteriores e as
 * outras com a grafia única já gasta) e o replant caía em `no_candidate`.
 */
const KNOWN_ENTITY_MISSPELLINGS: readonly EntityMisspelling[] = [
  { correct: "Claude", wrongs: ["Craude", "Claudi", "Cluade"], kind: "ia" },
  { correct: "Anthropic", wrongs: ["Anthropik", "Antropic", "Anthropyc"], kind: "ia" },
  { correct: "Hugging Face", wrongs: ["Hugging Race", "Huging Face", "Hugging Fase"], kind: "ia" },
  { correct: "ChatGPT", wrongs: ["ChatGTP", "ChatPGT", "ChaGPT"], kind: "ia" },
  { correct: "Gemini", wrongs: ["Gemine", "Gemeni", "Gemnini"], kind: "ia" },
  { correct: "DeepMind", wrongs: ["DeepMinde", "DeepMing", "DeepMid"], kind: "ia" },
  { correct: "Mistral", wrongs: ["Mistrall", "Mistrau", "Mystral"], kind: "ia" },
  { correct: "Perplexity", wrongs: ["Perplexit", "Perplexyti", "Perplexty"], kind: "ia" },
  { correct: "Copilot", wrongs: ["Copilto", "Copliot", "Copilott"], kind: "ia" },
  { correct: "Grok", wrongs: ["Grook", "Grokk"], kind: "ia" },
  { correct: "OpenAI", wrongs: ["OppenAI", "OpennAI", "OpeanAI"], kind: "ia" },
  { correct: "DeepSeek", wrongs: ["DeepSek", "DeepSeeck", "DepSeek"], kind: "ia" },
  { correct: "Nvidia", wrongs: ["Nvidea", "Nividia", "Nvidiaa"], kind: "ia" },
  { correct: "Midjourney", wrongs: ["Midjorney", "Midjourny", "Mydjourney"], kind: "ia" },
  { correct: "Qwen", wrongs: ["Qwenn", "Qewn"], kind: "ia" },
];

/**
 * 2º nível (#12612): marcas de tecnologia muito conhecidas, fora do nicho de
 * IA, só tentadas quando NENHUMA marca do 1º nível rende candidato. Mesmo
 * critério de curadoria: typo que qualquer leitor reconhece, nunca um nome
 * comum do português (por isso não entram "Meta", "Cursor" etc., que casariam
 * com palavras do texto).
 */
const EXTENDED_ENTITY_MISSPELLINGS: readonly EntityMisspelling[] = [
  { correct: "Google", wrongs: ["Gogle", "Googel", "Goolge"], kind: "tecnologia" },
  { correct: "Microsoft", wrongs: ["Microsfot", "Mircosoft", "Microsoftt"], kind: "tecnologia" },
  { correct: "Apple", wrongs: ["Appel", "Aplle", "Appple"], kind: "tecnologia" },
  { correct: "Amazon", wrongs: ["Amazom", "Amazonn", "Amazone"], kind: "tecnologia" },
  { correct: "Samsung", wrongs: ["Samsumg", "Sansung", "Samsungg"], kind: "tecnologia" },
  { correct: "Intel", wrongs: ["Intell", "Imtel"], kind: "tecnologia" },
  { correct: "Tesla", wrongs: ["Teslla", "Tesle"], kind: "tecnologia" },
  { correct: "YouTube", wrongs: ["YouTbue", "YuoTube", "YouTubbe"], kind: "tecnologia" },
  { correct: "Instagram", wrongs: ["Instagran", "Instragram", "Instagramm"], kind: "tecnologia" },
  { correct: "WhatsApp", wrongs: ["WhatsAp", "WhastApp", "WhatsAppp"], kind: "tecnologia" },
  { correct: "LinkedIn", wrongs: ["LinkdIn", "LinkedInn", "LikedIn"], kind: "tecnologia" },
  { correct: "Netflix", wrongs: ["Netflis", "Netflixx", "Nteflix"], kind: "tecnologia" },
  { correct: "Spotify", wrongs: ["Spotfy", "Spotifi", "Spotyfy"], kind: "tecnologia" },
  { correct: "GitHub", wrongs: ["GitHbu", "GiHub", "GitHubb"], kind: "tecnologia" },
  { correct: "Photoshop", wrongs: ["Fotoshop", "Photoshp", "Photoshopp"], kind: "tecnologia" },
  { correct: "Salesforce", wrongs: ["Salesforse", "Salesfroce"], kind: "tecnologia" },
  { correct: "Oracle", wrongs: ["Oracel", "Orcale"], kind: "tecnologia" },
  { correct: "Qualcomm", wrongs: ["Qualcom", "Qualcoom"], kind: "tecnologia" },
  { correct: "Huawei", wrongs: ["Huawey", "Hauwei"], kind: "tecnologia" },
  { correct: "Alibaba", wrongs: ["Alibabba", "Alibada"], kind: "tecnologia" },
];

/** Tiers do catálogo, na ordem em que são tentados (#12612). */
const CATALOG_TIERS: readonly (readonly EntityMisspelling[])[] = [
  KNOWN_ENTITY_MISSPELLINGS,
  EXTENDED_ENTITY_MISSPELLINGS,
];

/** (#12612) Tipo da marca do catálogo pelo `correct_value`; desconhecida → "ia" (texto histórico). */
export function brandKindFor(correct: string): BrandKind {
  for (const tier of CATALOG_TIERS) {
    const hit = tier.find((e) => e.correct === correct);
    if (hit) return hit.kind;
  }
  return "ia";
}

/** Rótulo em prosa do tipo da marca ("marca de IA" / "marca de tecnologia"). */
export function brandKindLabel(kind: BrandKind): string {
  return kind === "tecnologia" ? "marca de tecnologia" : "marca de IA";
}

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

  // #12612: entidade (`correct_value`) usada na janela veta a marca inteira;
  // grafia errada já usada em QUALQUER edição veta só aquela grafia — a
  // próxima grafia da mesma marca ainda serve.
  const entityInWindow = ({ correct }: EntityMisspelling): boolean =>
    history.length > 0 && findRecentRepeats({ correct_value: correct }, history, edition, { windowDays }).length > 0;
  const wrongEverUsed = (wrong: string): boolean =>
    history.length > 0 &&
    findRecentRepeats({ wrong_value: wrong }, history, edition, { windowDays: Infinity }).length > 0;
  const entityEverUsed = ({ correct }: EntityMisspelling): boolean =>
    history.length > 0 &&
    findRecentRepeats({ correct_value: correct }, history, edition, { windowDays: Infinity }).length > 0;

  // Tier 1 (marcas de IA) antes do tier 2 (#12612); dentro de cada tier,
  // 1ª passada: só entidades inéditas; 2ª: aceita entidade usada fora da janela.
  for (const tier of CATALOG_TIERS) {
    for (const allowUsedEntity of [false, true]) {
      for (const block of blocks) {
        if (DESTAQUE_HEADER_RE.test(block)) continue; // Regra 3 — nunca em bloco de destaque

        const section = SECONDARY_SECTION_PATTERNS.find(({ re }) => re.test(block));
        if (!section) continue; // bloco não identificado como seção secundária conhecida (ex: intro) — pula, não arrisca

        for (const entry of tier) {
          const { correct, kind } = entry;
          const wordBoundaryRe = new RegExp(`\\b${escapeRegExp(correct)}\\b`);
          if (!wordBoundaryRe.test(block)) continue;
          if (entityInWindow(entry)) continue; // #9101/#12612
          if (!allowUsedEntity && entityEverUsed(entry)) continue; // #9101 — prefere inédita
          const wrong = entry.wrongs.find((w) => !wrongEverUsed(w)); // #9101/#12612
          if (!wrong) continue;

          const key = `${section.name}|${correct}`;
          if (seen.has(key)) continue;
          seen.add(key);
          yield {
            description: `Uma ${brandKindLabel(kind)} muito conhecida do público da newsletter aparece com o nome grafado errado numa menção lateral do texto.`,
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
}
