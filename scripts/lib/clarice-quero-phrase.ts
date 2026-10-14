/**
 * clarice-quero-phrase.ts (#10179) — núcleo PURO da regra da frase do "quero"
 * na APRESENTAÇÃO da Clarice News.
 *
 * A frase *Se você quiser receber essa newsletter com prioridade, responda a
 * este e-mail dizendo "quero".* vive no `draft.md` do ciclo e, portanto, no
 * `cloudflare-preview.html` — um HTML só para o ciclo inteiro. A regra do
 * editor é por ENVIO:
 *
 *   - 1º envio do ciclo  → SEM a frase;
 *   - 2º e 3º envios     → COM a frase;
 *   - 4º em diante       → COM a frase (premissa registrada na issue/PR: o
 *     comportamento do 2º/3º se estende, nada no pedido sugere tirar de novo).
 *
 * Antes disso, a regra dependia de o editor editar o draft à mão no momento
 * certo (retirou no 1º envio de 2609-10 e restaurou em 14/10/2026, com o envio
 * em andamento). Este módulo só decide e transforma texto — não lê disco, não
 * chama rede. Quem aplica é `scripts/clarice-schedule-group.ts` (caminho único
 * das duas tasks automáticas, `clarice-envio-run.ts` e `clarice-novos-run.ts`),
 * no momento em que o `htmlContent` vai pra campanha (`--create`/`--update-html`).
 *
 * O que conta como "envio do ciclo": cada ONDA registrada em
 * `segments/group-campaigns.json` do ciclo (`Clarice {yymm} grupo:{key}`), na
 * ordem em que foi criada — rampa `d{N}-...` e `novos-...` juntas. As células
 * de uma mesma onda (`-A`/`-B`/`-C` de assunto, `-H{HH}` de horário,
 * `-VA`/`-VB` de conteúdo) são o MESMO envio: saem no mesmo dia, para fatias
 * disjuntas da mesma onda, e por isso recebem o mesmo índice.
 */

/** Índice (1-based) do envio no ciclo a partir do qual a frase entra. */
export const QUERO_FIRST_SEND_WITH_PHRASE = 2;

/** Texto plano da frase — usado em mensagens e testes. */
const QUERO_PHRASE_TEXT =
  'Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo "quero".';

// Aspas que o render pode produzir em volta de quero: entidade, reta ou curvas.
const Q = `(?:&quot;|&#34;|&#x22;|&ldquo;|&rdquo;|&#8220;|&#8221;|["“”])`;
// "você" pode sair cru ou como entidade, conforme o render.
const VOCE = `voc(?:ê|&ecirc;|&#234;|&#xea;)`;

/**
 * A frase como aparece no HTML (ou no markdown), mais o espaço que a separa da
 * frase seguinte. `[^<]*?` impede o casamento de atravessar uma tag — a frase
 * nunca tem link nem ênfase no meio; se um dia tiver, o casamento falha e o
 * resultado reporta `found: false` em vez de cortar HTML no meio.
 */
const QUERO_SENTENCE_RE = new RegExp(
  `Se ${VOCE} quiser receber[^<]*?dizendo\\s*${Q}quero${Q}\\.?[ \\t]*(?:\\r?\\n[ \\t]*)?`,
  "gi",
);

/** Parágrafo `<p ...>` que ficou vazio depois de tirar a frase. */
const EMPTY_P_RE = /<p\b[^>]*>\s*<\/p>\s*/gi;

/** `true` quando o texto contém a frase do "quero". */
export function hasQueroPhrase(text: string): boolean {
  QUERO_SENTENCE_RE.lastIndex = 0;
  const found = QUERO_SENTENCE_RE.test(text);
  QUERO_SENTENCE_RE.lastIndex = 0;
  return found;
}

/** A frase entra neste envio? 1º = não; 2º em diante = sim. */
export function queroIncludedForSend(envioIndex: number): boolean {
  if (!Number.isInteger(envioIndex) || envioIndex < 1) {
    throw new Error(`envioIndex inválido: ${envioIndex} (esperado inteiro ≥ 1).`);
  }
  return envioIndex >= QUERO_FIRST_SEND_WITH_PHRASE;
}

/**
 * Sufixo de célula de uma onda: `-A`/`-B`/`-C` (assunto), `-H{HH}` (horário,
 * #5140), `-VA`/`-VB` (conteúdo, #9308). Mesmo vocabulário de
 * `groupKeyFor`/`clarice-wave-plan.ts`.
 */
const CELL_SUFFIX_RE = /-(?:[ABC]|H\d{2}|VA|VB)$/i;

/** Chave do ENVIO (onda) a que uma key de campanha pertence — tira a célula. */
export function sendSlotOf(key: string): string {
  return key.trim().replace(CELL_SUFFIX_RE, "");
}

/**
 * Índice (1-based) do envio de `key` no ciclo, dado o histórico de keys do
 * ciclo na ordem em que as campanhas foram criadas (`group-campaigns.json`).
 *
 * - key já registrada (re-execução idempotente, `--update-html`) → a posição
 *   do envio dela, estável entre chamadas;
 * - key nova de uma onda já registrada (outra célula) → o índice da onda;
 * - key de onda nova → número de ondas já registradas + 1.
 */
export function resolveEnvioIndex(existingKeysInOrder: readonly string[], key: string): number {
  const slots: string[] = [];
  for (const k of existingKeysInOrder) {
    const s = sendSlotOf(k);
    if (!slots.includes(s)) slots.push(s);
  }
  const mine = sendSlotOf(key);
  const pos = slots.indexOf(mine);
  return pos >= 0 ? pos + 1 : slots.length + 1;
}

export interface QueroApplication {
  /** HTML a enviar nesta campanha. */
  html: string;
  envioIndex: number;
  /** A frase está no HTML enviado. */
  included: boolean;
  /** A frase existia no HTML de origem (draft do ciclo). */
  foundInSource: boolean;
}

/**
 * Aplica a regra ao HTML do ciclo para o envio `envioIndex`.
 *
 * - 1º envio: tira a frase (e o parágrafo, se ela era o único texto dele).
 * - 2º em diante: devolve o HTML como está. A frase não é INJETADA quando o
 *   draft não a tem — o draft continua sendo a fonte do texto; `included:
 *   false` + `foundInSource: false` deixa isso visível no relatório.
 */
export function applyQueroPhrase(html: string, envioIndex: number): QueroApplication {
  const foundInSource = hasQueroPhrase(html);
  if (queroIncludedForSend(envioIndex)) {
    return { html, envioIndex, included: foundInSource, foundInSource };
  }
  if (!foundInSource) return { html, envioIndex, included: false, foundInSource };
  const stripped = html.replace(QUERO_SENTENCE_RE, "").replace(EMPTY_P_RE, "");
  return { html: stripped, envioIndex, included: false, foundInSource };
}

/** Linha de relatório/log: diz se a frase entrou neste envio e por quê. */
export function describeQueroApplication(a: Pick<QueroApplication, "envioIndex" | "included" | "foundInSource">): string {
  if (a.included) return `frase do "quero": INCLUÍDA (envio ${a.envioIndex} do ciclo)`;
  if (a.envioIndex < QUERO_FIRST_SEND_WITH_PHRASE) {
    return a.foundInSource
      ? `frase do "quero": RETIRADA (envio 1 do ciclo — #10179)`
      : `frase do "quero": ausente (envio 1 do ciclo — o draft já não tinha a frase)`;
  }
  return `⚠️ frase do "quero": AUSENTE no envio ${a.envioIndex} do ciclo — o draft do ciclo não tem a frase (esperada do 2º envio em diante, #10179)`;
}

/**
 * Versão de relatório a partir do que a campanha GRAVOU (`envioIndex` +
 * `queroIncluded` do resumo de `clarice-schedule-group.ts`) — sem saber se o
 * draft tinha a frase, só se ela foi no HTML enviado.
 */
export function describeQueroOutcome(envioIndex: number, included: boolean): string {
  if (included) return `frase do "quero": INCLUÍDA (envio ${envioIndex} do ciclo)`;
  if (envioIndex < QUERO_FIRST_SEND_WITH_PHRASE) return `frase do "quero": fora (envio 1 do ciclo — #10179)`;
  return `⚠️ frase do "quero": AUSENTE no envio ${envioIndex} do ciclo — esperada do 2º envio em diante (#10179); conferir o draft do ciclo`;
}
