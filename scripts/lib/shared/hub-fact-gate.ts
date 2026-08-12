/**
 * hub-fact-gate.ts (#5060 Parte B1)
 *
 * Gate MECÂNICO (determinístico, sem LLM) de auto-consistência factual pros
 * hubs temáticos — a camada B1 da issue #5060: "toda cronologia derivada
 * confere contra as datas absolutas do próprio texto", "todo link de edição
 * citado na prosa existe em `sources.generated.json` e a data do parágrafo
 * bate com a da edição", "todo parágrafo tem pelo menos uma âncora de data
 * absoluta" e "nenhuma data no futuro em relação a `updatedDate`".
 *
 * **Escopo deliberadamente estreito: auto-consistência, não fato-checagem
 * externa.** Este módulo NUNCA busca a Anthropic/OpenAI/Google/Meta/governo
 * real pra confirmar se uma cifra ou data está correta (isso é a Parte A da
 * issue, fora deste módulo, e a Parte B2, que precisa de LLM + gate humano).
 * O que ele garante é que o texto não se contradiz: uma cronologia derivada
 * ("N dias depois") bate com as datas absolutas citadas ao redor dela, um
 * link pra edição existe de fato no dataset gerado, e nenhum parágrafo cita
 * uma data futura em relação ao próprio `updatedDate` do hub.
 *
 * **Por que a checagem de cronologia é conservadora de propósito.** Prosa
 * editorial em português usa MUITAS construções pra relacionar datas — "N
 * dias depois", "no dia seguinte", "no mesmo dia", referências pra trás por
 * nome ("3 dias antes da manchete sobre a virada") — e nem todas são
 * resolvíveis com regex sem risco real de falso positivo. A auditoria que
 * motivou este módulo encontrou pelo menos 2 padrões que produziriam alarme
 * falso contra os 5 hubs reais se tratados ingenuamente:
 *   1. Cadeias de múltiplos saltos sem data explícita no meio ("32 dias
 *      depois... 14 dias depois... 31 dias depois, em 9 de fevereiro de
 *      2026") — resolvido acumulando um "cursor" de data corrente que avança
 *      a cada offset reconhecido, mesmo quando não há data pra conferir
 *      naquele ponto, e só é reconferido quando um "N dias depois" aparece
 *      imediatamente colado numa data explícita.
 *   2. Referências "N dias antes" que apontam pra um evento nomeado, não pro
 *      cursor corrente ("3 dias antes da manchete sobre a virada contra o
 *      ChatGPT, [...] em 6 de janeiro de 2026" — a manchete referida não tem
 *      data explícita própria no texto). Decisão: `antes` NUNCA é verificado
 *      (nem avança o cursor) — só serve de sinal de que existe uma âncora de
 *      data ali perto (checagem separada, `checkParagraphDateAnchors`).
 *      Toda ocorrência real de `antes` no corpus atual é seguida de perto por
 *      uma data explícita que reseta o cursor de qualquer forma (a próxima
 *      DATA absoluta sempre vence, incondicionalmente) — não perde nada.
 * "no dia seguinte" (+1) e "no mesmo dia" (+0) entram como offsets IMPLÍCITOS
 * que avançam o cursor (pra não perder a cadeia, achado ao vivo: sem isso o
 * `google-gemini` acusava 1 dia de diferença numa cadeia real e correta) mas
 * NUNCA são o alvo de uma verificação (`verifiable: false`) — só a data
 * explícita que os segue reseta o cursor de verdade.
 *
 * Quando a checagem não consegue resolver uma construção com segurança, ela
 * SKIPA (não verifica, não acusa) — prefere perder cobertura a acusar prosa
 * correta. Rodada contra os 6 hubs reais de `HUB_LOADERS`
 * (`test/hub-fact-gate-5060.test.ts`): zero violações no dataset publicado
 * em 260811.
 */
import type { HubContent } from "./hub-page.ts";
import { findParagraphLinks } from "./markdown-links.ts";

// ---------------------------------------------------------------------------
// Extração de datas absolutas
// ---------------------------------------------------------------------------

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

export interface DateAnchor {
  index: number;
  end: number;
  iso: string;
  raw: string;
}

/** "D de mês de AAAA" (extenso, aceita "1º"). */
const LONG_DATE_RE =
  /\b(\d{1,2})º?\s+de\s+(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})\b/giu;

/** "DD/MM/AAAA" — formato curto usado por `formatDateShort`/vários hubs. */
const SHORT_DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;

/**
 * Todas as âncoras de data absoluta de `text`, em ordem de aparição — os
 * dois formatos que a prosa dos hubs usa (extenso e `DD/MM/AAAA`). Pure.
 */
export function extractAbsoluteDates(text: string): DateAnchor[] {
  const out: DateAnchor[] = [];
  for (const m of text.matchAll(LONG_DATE_RE)) {
    const day = m[1].padStart(2, "0");
    const monthIdx = MONTHS.indexOf(m[2].toLowerCase() as (typeof MONTHS)[number]);
    if (monthIdx === -1) continue;
    const month = String(monthIdx + 1).padStart(2, "0");
    out.push({ index: m.index, end: m.index + m[0].length, iso: `${m[3]}-${month}-${day}`, raw: m[0] });
  }
  for (const m of text.matchAll(SHORT_DATE_RE)) {
    const [, dd, mm, yyyy] = m;
    const mmNum = Number(mm);
    const ddNum = Number(dd);
    if (mmNum < 1 || mmNum > 12 || ddNum < 1 || ddNum > 31) continue; // não é uma data real (evita casar outro padrão N/N/NNNN)
    out.push({ index: m.index, end: m.index + m[0].length, iso: `${yyyy}-${mm}-${dd}`, raw: m[0] });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/** Mesma regra de `test/hub-section-paragraph-dates-4917.test.ts` (cópia
 * deliberada, não import — mesma disciplina de independência já usada por
 * `test/hub-google-gemini-launch-gap-4945.test.ts`, ver `maxDateGap` em
 * `hub-page.ts`: o teste permanece uma verificação INDEPENDENTE deste
 * módulo, não decorativa dele). Usada só pra "tem alguma âncora" — mais
 * frouxa que `extractAbsoluteDates` (não precisa converter pra ISO). */
export const ABSOLUTE_DATE_ANCHOR_RE =
  /\d{1,2}º? de (?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)|\b\d{2}\/\d{2}\/\d{4}\b/i;

// ---------------------------------------------------------------------------
// Extração de offsets relativos ("N dias depois")
// ---------------------------------------------------------------------------

const UNIT_WORDS: Record<string, number> = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  "três": 3,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  catorze: 14,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
};
const TENS_WORDS: Record<string, number> = {
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
};
const HUNDRED_WORDS: Record<string, number> = {
  cem: 100,
  cento: 100,
  duzentos: 200,
  trezentos: 300,
  quatrocentos: 400,
  quinhentos: 500,
  seiscentos: 600,
  setecentos: 700,
  oitocentos: 800,
  novecentos: 900,
};

/** Converte um número cardinal por extenso em português ("sessenta e três")
 * pro valor numérico, somando o valor de cada palavra reconhecida (é assim
 * que a composição cardinal do português funciona — nunca multiplicativa
 * abaixo de mil, "e" é só conector). `null` se alguma palavra não for
 * reconhecida — o caller trata como "não é um número", não lança. */
function wordsToNumber(phrase: string): number | null {
  const words = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "e");
  if (words.length === 0) return null;
  let total = 0;
  for (const w of words) {
    if (w in HUNDRED_WORDS) total += HUNDRED_WORDS[w];
    else if (w in TENS_WORDS) total += TENS_WORDS[w];
    else if (w in UNIT_WORDS) total += UNIT_WORDS[w];
    else return null;
  }
  return total;
}

function altPattern(words: string[]): string {
  return words.join("|");
}

/** Gramática de número cardinal por extenso — hundred(+tens)(+unit) |
 * tens(+unit) | unit — com `\b` implícito nas bordas de cada palavra via
 * fronteira de word-char natural do português (sem acento ambíguo aqui). */
const NUMBER_WORD_GRAMMAR =
  `(?:(?:${altPattern(Object.keys(HUNDRED_WORDS))})(?:\\s+e\\s+(?:${altPattern(Object.keys(TENS_WORDS))}))?(?:\\s+e\\s+(?:${altPattern(Object.keys(UNIT_WORDS))}))?` +
  `|(?:${altPattern(Object.keys(TENS_WORDS))})(?:\\s+e\\s+(?:${altPattern(Object.keys(UNIT_WORDS))}))?` +
  `|(?:${altPattern(Object.keys(UNIT_WORDS))}))`;

const NUMBER_TOKEN = `(?:\\d+|${NUMBER_WORD_GRAMMAR})`;

/** "N dias/semanas depois/antes/mais tarde" — dígito OU extenso. `meses`/`mês`
 * fica FORA de propósito: duração de mês varia (28-31 dias), não dá pra
 * verificar como contagem exata de dias sem introduzir tolerância — melhor
 * não extrair do que extrair e nunca verificar (mesmo racional de excluir
 * `antes` da verificação, ver docstring do módulo). */
const EXPLICIT_OFFSET_RE = new RegExp(`\\b(${NUMBER_TOKEN})\\s+(dias?|semanas?)\\s+(depois|antes|mais tarde)\\b`, "giu");

const IMPLICIT_NEXT_DAY_RE = /\bno dia seguinte\b/giu;
const IMPLICIT_SAME_DAY_RE = /\bno mesmo dia\b/giu;

export interface OffsetAnchor {
  index: number;
  end: number;
  /** Dias corridos — sempre >= 0 (`antes` nunca chega aqui, ver módulo). */
  days: number;
  /** `false` pros idiomas implícitos ("no dia seguinte"/"no mesmo dia") —
   * avançam o cursor mas nunca são o alvo de uma verificação (ver docstring
   * do módulo, achado do "mesmo dia" referenciando um evento diferente do
   * cursor corrente). */
  verifiable: boolean;
  raw: string;
}

function parseOffsetAmount(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return wordsToNumber(token);
}

/** Todos os offsets relativos reconhecidos de `text`, em ordem de aparição.
 * `antes` é DESCARTADO aqui (não extraído) — ver docstring do módulo sobre
 * por que essa direção não é verificável com segurança. */
export function extractOffsetEvents(text: string): OffsetAnchor[] {
  const out: OffsetAnchor[] = [];
  for (const m of text.matchAll(EXPLICIT_OFFSET_RE)) {
    const direction = m[3].toLowerCase();
    if (direction === "antes") continue;
    const amount = parseOffsetAmount(m[1]);
    if (amount == null) continue;
    const unitMultiplier = /^semana/i.test(m[2]) ? 7 : 1;
    out.push({ index: m.index, end: m.index + m[0].length, days: amount * unitMultiplier, verifiable: true, raw: m[0] });
  }
  for (const m of text.matchAll(IMPLICIT_NEXT_DAY_RE)) {
    out.push({ index: m.index, end: m.index + m[0].length, days: 1, verifiable: false, raw: m[0] });
  }
  for (const m of text.matchAll(IMPLICIT_SAME_DAY_RE)) {
    out.push({ index: m.index, end: m.index + m[0].length, days: 0, verifiable: false, raw: m[0] });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

// ---------------------------------------------------------------------------
// Aritmética de data (cópia local deliberada — ver nota de independência em
// `calendarDaysBetween`/`maxDateGap`, scripts/lib/shared/hub-page.ts: este
// módulo não importa NADA em runtime de hub-page.ts — só `import type` — pra
// não criar um ciclo real de módulo com `validateHubContent` chamando
// `checkHubFacts` daqui).
// ---------------------------------------------------------------------------

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${t.getUTCFullYear()}`.padStart(4, "0") + "-" + String(t.getUTCMonth() + 1).padStart(2, "0") + "-" + String(t.getUTCDate()).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Check 1 — cronologia derivada confere com as datas absolutas do texto
// ---------------------------------------------------------------------------

const MAX_CONNECTOR_GAP = 30;
/** Texto permitido ENTRE um offset e a data que o confirma — só pontuação e
 * um conector curto ("em"/"já em"/"no dia"/"a partir de"). Gap fora disso
 * não é tratado como par (a data não é necessariamente a resposta do
 * offset — ver achado do "mesmo dia" no docstring do módulo). */
const CONNECTOR_RE = /^[,;:]?\s*(já\s+)?(em|no dia|a partir de)?\s*$/i;

type ChronologyEvent = ({ kind: "date" } & DateAnchor) | ({ kind: "offset" } & OffsetAnchor);

/**
 * Quantos links `diar.ia.br/p/...` (edições — não "fonte primária" externa)
 * aparecem em `gapText`. Usado como guarda-chuva CONTRA um 3º modo de falso
 * positivo achado ao vivo (auditoria 260811, PRs #openai-chatgpt/S1 e S5):
 * quando o texto introduz um evento NOVO sem nenhuma data/offset reconhecido
 * pra ele (ex: "[GPT-Live](url) e [outra versão](url) saíram com 1 dia de
 * diferença, e [o ChatGPT pra pequenos negócios](url) fechou a série 12 dias
 * depois") o cursor fica desatualizado em relação ao evento de fato referido
 * pelo offset — mas o texto não dá nenhum sinal sintático de QUE evento é
 * esse. Achado empírico: nos casos genuinamente encadeáveis do corpus (ex:
 * a cadeia "32 dias depois... 14 dias depois... 31 dias depois, em 9 de
 * fevereiro" do `google-gemini`), o texto entre um evento e o próximo cita
 * NO MÁXIMO 1 link de edição — o próprio evento que aquele hop descreve.
 * Quando aparecem 2+ links de edição no meio, é sinal de que mais de um
 * evento foi introduzido sem instrumentação temporal própria — a cadeia não
 * é mais confiável, e a verificação é pulada (cursor ainda avança, só a
 * comparação não dispara). */
function countEditionLinks(gapText: string): number {
  return findParagraphLinks(gapText).filter((l) => l.url.includes("diar.ia.br/p/")).length;
}

/** "até 5 de março de 2026" é um PRAZO/alvo futuro embutido numa frase sobre
 * um evento diferente já datado ("[Gilmar Mendes propôs força-tarefa],
 * defendendo... audiências públicas que atualizariam as normas eleitorais
 * até 5 de março de 2026") — não é "isto aconteceu em 5 de março". Uma data
 * assim NUNCA deveria resetar o cursor da cadeia (faria o próximo "N dias
 * depois" contar a partir do prazo, não do evento sendo narrado — achado ao
 * vivo, auditoria 260811, `brasil-regulacao` seção "blindar a eleição").
 * Escopo estreito de propósito: só exclui a data da CADEIA de cronologia;
 * ela continua contando pra `checkParagraphDateAnchors`/`checkNoFutureDates`
 * (é uma data real do texto, só não é um evento narrativo). */
function isDeadlineDate(text: string, index: number): boolean {
  return /até\s*$/i.test(text.slice(Math.max(0, index - 8), index));
}

function checkChronologyForText(text: string, label: string): string[] {
  const violations: string[] = [];
  const dateEvents: ChronologyEvent[] = extractAbsoluteDates(text)
    .filter((d) => !isDeadlineDate(text, d.index))
    .map((d) => ({ kind: "date", ...d }));
  const offsetEvents: ChronologyEvent[] = extractOffsetEvents(text).map((o) => ({ kind: "offset", ...o }));
  const events = [...dateEvents, ...offsetEvents].sort((a, b) => a.index - b.index);

  let cursor: string | null = null;
  let prevEnd = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === "date") {
      cursor = ev.iso;
      prevEnd = ev.end;
      continue;
    }
    if (cursor == null) {
      prevEnd = ev.end;
      continue; // sem âncora ainda neste escopo — nada a conferir
    }
    const expected = addDaysIso(cursor, ev.days);
    const newLinksSincePrev = countEditionLinks(text.slice(prevEnd, ev.index));
    const next = events[i + 1];
    let fired = false;
    if (ev.verifiable && newLinksSincePrev <= 1 && next && next.kind === "date") {
      const gap = text.slice(ev.end, next.index);
      if (gap.length <= MAX_CONNECTOR_GAP && CONNECTOR_RE.test(gap)) {
        fired = true;
        if (next.iso !== expected) {
          violations.push(
            `${label}: "${ev.raw}" a partir de ${cursor} deveria cair em ${expected}, mas o texto cita "${next.raw}" (${next.iso})`,
          );
        }
      }
    }
    if (!fired) cursor = expected; // avança especulativamente (verificação não disparou agora)
    prevEnd = ev.end;
  }
  return violations;
}

/**
 * Verifica cada `HubSection` (parágrafos concatenados, na ordem — a
 * narrativa de uma seção pode espalhar uma cadeia de offsets por 2+
 * parágrafos, ver docstring do módulo) contra as datas absolutas citadas no
 * próprio texto. `introParagraph`/`faq[].answer` ficam fora de propósito —
 * citam a janela de cobertura agregada (`hubCoverageWindow`), não uma
 * sequência de eventos individuais (mesmo escopo de
 * `test/hub-section-paragraph-dates-4917.test.ts`).
 */
export function checkChronologyConsistency(hub: HubContent): string[] {
  const violations: string[] = [];
  hub.sections.forEach((section, i) => {
    const text = section.paragraphs.join(" ");
    violations.push(...checkChronologyForText(text, `sections[${i}] ("${section.heading}")`));
  });
  return violations;
}

// ---------------------------------------------------------------------------
// Check 2 — todo link de edição citado na prosa existe em sourceEditions
// (ver docstring de checkSourceLinksCited sobre o escopo reduzido em relação
// ao bullet original da issue).
// ---------------------------------------------------------------------------

function proseFields(hub: HubContent): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  hub.sections.forEach((s, i) => s.paragraphs.forEach((p, j) => out.push({ label: `sections[${i}].paragraphs[${j}]`, text: p })));
  hub.faq.forEach((f, i) => out.push({ label: `faq[${i}].answer`, text: f.answer }));
  out.push({ label: "methodologyNote", text: hub.methodologyNote });
  return out;
}

/**
 * Todo link de edição (`diar.ia.br/p/...`) citado na prosa existe em
 * `hub.sourceEditions` — ou seja, em `{slug}-sources.generated.json`
 * (`sourceEditions` é derivado DIRETO dele via `toSourceEditions`, ver cada
 * `scripts/lib/hubs/{slug}.ts`). Um link que não existe ali é ou um typo de
 * URL ou uma citação que sobrou de uma edição anterior de `SOURCES` — os
 * dois casos são bug real, não falso positivo.
 *
 * **Escopo deliberadamente MENOR que o bullet original da issue.** A issue
 * também pede "a data do parágrafo bate com a `date` da edição citada" — a
 * auditoria que motivou este módulo tentou essa comparação via "data
 * absoluta mais próxima do link" e encontrou ~35 falsos positivos nos 6 hubs
 * reais (achado ao vivo, 260811): a data mais próxima de um link no texto é
 * quase sempre a data do EVENTO discutido na frase, não a `date` de
 * PUBLICAÇÃO da edição que noticiou esse evento — os dois divergem por dias
 * a meses em prosa real (o texto às vezes cita a data do fato, não a data em
 * que a diar.ia.br publicou sobre ele). Comparar os dois é comparar coisas
 * diferentes por construção, não um bug de proximidade de regex — não tem
 * heurística de proximidade que resolva isso sem entender qual data cada
 * frase está de fato afirmando. Descoberta, não implementada: a metade
 * "existe em sourceEditions" (abaixo) é a parte mecanicamente segura do
 * bullet e cobre o caso de dano real (link morto/typo/URL de edição
 * removida); a comparação de data fica fora, documentada aqui em vez de
 * silenciosamente ausente.
 */
export function checkSourceLinksCited(hub: HubContent): string[] {
  const violations: string[] = [];
  const knownUrls = new Set(hub.sourceEditions.map((e) => e.url));
  for (const { label, text } of proseFields(hub)) {
    const links = findParagraphLinks(text).filter((l) => l.url.startsWith("https://diar.ia.br/p/"));
    for (const link of links) {
      if (!knownUrls.has(link.url)) {
        violations.push(`${label}: link "${link.url}" não existe em sourceEditions — regenerar {slug}-sources.generated.json?`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check 3 — todo parágrafo de sections[].paragraphs tem >=1 âncora de data
// absoluta (regressão do #4917).
// ---------------------------------------------------------------------------

export function checkParagraphDateAnchors(hub: HubContent): string[] {
  const violations: string[] = [];
  hub.sections.forEach((section, i) => {
    section.paragraphs.forEach((p, j) => {
      if (!ABSOLUTE_DATE_ANCHOR_RE.test(p)) {
        violations.push(`sections[${i}].paragraphs[${j}] ("${section.heading}"): sem âncora de data absoluta — "${p.slice(0, 80)}..."`);
      }
    });
  });
  return violations;
}

// ---------------------------------------------------------------------------
// Check 4 — nenhuma data no texto é posterior a updatedDate.
// ---------------------------------------------------------------------------

export function checkNoFutureDates(hub: HubContent): string[] {
  const violations: string[] = [];
  const fields: { label: string; text: string }[] = [{ label: "introParagraph", text: hub.introParagraph }, ...proseFields(hub)];
  for (const { label, text } of fields) {
    for (const d of extractAbsoluteDates(text)) {
      if (d.iso > hub.updatedDate) {
        violations.push(`${label}: data "${d.raw}" (${d.iso}) é posterior a updatedDate (${hub.updatedDate})`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Agregador — chamado por `validateHubContent` (hub-page.ts).
// ---------------------------------------------------------------------------

/** Roda os 4 checks mecânicos do #5060 Parte B1, nesta ordem (estrutural
 * antes de derivado). Pure — nunca lança, devolve a lista de violações
 * (vazia = ok), mesmo contrato de `validateHubContent`. */
export function checkHubFacts(hub: HubContent): string[] {
  return [
    ...checkParagraphDateAnchors(hub),
    ...checkNoFutureDates(hub),
    ...checkSourceLinksCited(hub),
    ...checkChronologyConsistency(hub),
  ];
}

// ---------------------------------------------------------------------------
// recomputeHubFactGate (#5060 fleet review item 3) — recálculo determinístico
// do gate BLOQUEANTE do fact-checker em `mode: "hub"`.
// ---------------------------------------------------------------------------

/** Subconjunto de `claims[]` no output do fact-checker (`mode: "hub"`,
 * `.claude/agents/fact-checker.md` Passo 6) relevante pro gate — só
 * `claim_id`/`verdict` importam pra aritmética, o resto (`text`,
 * `source_url`, etc.) é irrelevante aqui. */
export interface HubFactGateClaim {
  claim_id: string;
  verdict: "SUSTAINED" | "DIVERGENT" | "NOT_FOUND_IN_SOURCE" | "SOURCE_UNREACHABLE" | "INFERRED";
}

/** Subconjunto de `contradictions[]` relevante pro gate. `resolvable_with_source_url`
 * é aceito no tipo (o output do agente sempre carrega o campo, é dado útil
 * pro editor triar) mas **deliberadamente não entra na aritmética** — ver
 * docstring de `recomputeHubFactGate` abaixo e `.claude/agents/fact-checker.md`
 * Passo 5. */
export interface HubFactGateContradiction {
  claim_id: string;
  resolvable_with_source_url: string | null;
}

export interface HubFactGateResult {
  blocked: boolean;
  blocking_items: string[];
}

/**
 * Recalcula `gate.blocked`/`gate.blocking_items` deterministicamente a
 * partir do JSON que o agente `fact-checker` (`mode: "hub"`) produz — mesma
 * disciplina do #573 (`resolveBeehiivState`/`resolveLinkedInState` em
 * `scripts/lib/publish-state.ts`): o Passo 5 de `.claude/agents/fact-checker.md`
 * descreve uma regra 100% mecânica (aritmética sobre `claims[]`/
 * `contradictions[]`/`approved_claim_ids`) que o LLM calcula sozinho antes de
 * gravar o output — exatamente o tipo de afirmação de estado que não deve
 * ser confiada sem revalidação em TS. Um erro de contagem do agente passaria
 * sem detecção se o CALLER só lesse `gate.blocked` do JSON.
 *
 * **Contrato: o CALLER roda isto sobre o output do agente e trata o
 * resultado daqui — não o `gate.blocked` que o agente escreveu — como
 * autoritativo** antes de decidir bloquear/liberar um build ou deploy de hub
 * (ver nota "ainda NÃO conectado a nada" no prompt do fact-checker — este
 * helper existe pro dia em que esse wiring for feito).
 *
 * Regra (espelha `.claude/agents/fact-checker.md` Passo 5, pós-#5060 fleet
 * review item 2 — a condição `resolvable_with_source_url: null` FOI REMOVIDA
 * do predicado de bloqueio de contradição):
 * - bloqueia se existir qualquer claim com `verdict` ≠ `SUSTAINED`/`INFERRED`
 *   E `claim_id` ausente de `approvedClaimIds`.
 * - bloqueia se existir QUALQUER entrada em `contradictions` cujo `claim_id`
 *   esteja ausente de `approvedClaimIds` — independente de
 *   `resolvable_with_source_url`. Achar uma fonte que resolve qual versão é
 *   correta não prova que a prosa errada foi removida da página (o agente
 *   não tem `Edit`/`Bash`) — só o editor, via aprovação explícita, destrava.
 *
 * Pure — nunca lança, `approvedClaimIds` já resolvido pelo caller (o
 * `{approvals_path}` em si é I/O de arquivo, fora do escopo deste helper —
 * mesma separação leitura/aritmética de `checkHubFacts` acima).
 */
export function recomputeHubFactGate(
  claims: HubFactGateClaim[],
  contradictions: HubFactGateContradiction[],
  approvedClaimIds: string[],
): HubFactGateResult {
  const approved = new Set(approvedClaimIds);
  const blockingItems: string[] = [];
  for (const claim of claims) {
    if (claim.verdict !== "SUSTAINED" && claim.verdict !== "INFERRED" && !approved.has(claim.claim_id)) {
      blockingItems.push(claim.claim_id);
    }
  }
  for (const contradiction of contradictions) {
    if (!approved.has(contradiction.claim_id)) {
      blockingItems.push(contradiction.claim_id);
    }
  }
  return { blocked: blockingItems.length > 0, blocking_items: blockingItems };
}
