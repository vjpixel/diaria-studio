/**
 * provider-split.ts — entrega e engajamento de um envio, cortados por PROVEDOR.
 *
 * Miolo puro de `scripts/kit-provider-split.ts`. Existe porque o número
 * agregado de um envio esconde a única coisa que importava no incidente de
 * 28/08/2026 (#6504): a edição 260827 saiu pelo Kit com 13,97% de abertura
 * contra 34,8% de média na Beehiiv — e a queda não era de abertura. O Gmail
 * **recusou 72% das mensagens na porta**: 433 enviados, 122 entregues. Quem
 * recebeu abriu 30,3%, em linha com todo o resto. Microsoft, Yahoo, Apple, UOL
 * e Proton entregaram 100%.
 *
 * ## Por que ENTREGA é uma coluna própria, e não uma taxa derivada no caller
 *
 * A primeira versão deste módulo (#6491) só conhecia destinatários, aberturas e
 * cliques, e media abertura sobre "assinantes ativos agora" — um proxy de
 * ENVIADOS. Com 28% de entrega, esse número mistura duas falhas diferentes num
 * só: "o provedor não aceitou" e "quem recebeu não abriu". As duas pedem ações
 * opostas (aquecer domínio × mexer no conteúdo), então o número que não as
 * separa não decide nada. Daí os dois eixos aqui serem explícitos:
 *
 * - `deliveryRatePct` = entregues ÷ enviados  → o provedor aceitou?
 * - `openRatePct`/`clickRatePct` = engajamento ÷ **entregues** → quem recebeu se importou?
 *
 * Abertura sobre ENVIADOS não aparece em lugar nenhum deste módulo de
 * propósito: é a métrica que produziu o diagnóstico errado do #6504.
 *
 * ## Ainda vale medir abertura por provedor?
 *
 * Vale, e é o segundo eixo do gate. Recusa na porta e entrega-para-o-spam são
 * falhas distintas do mesmo provedor: a primeira derruba `deliveryRatePct`, a
 * segunda derruba `openRatePct` com entrega em 100%. Só as duas juntas cobrem
 * o espaço.
 *
 * ## Ressalva de medição que este módulo NÃO resolve
 *
 * O pixel de abertura do Kit é o último elemento do corpo; acima do corte de
 * ~102 KB o Gmail trunca a mensagem e o pixel não carrega (#6506). Enquanto
 * isso não for corrigido, `openRatePct` do Gmail é um PISO, não a taxa real.
 * `deliveryRatePct` não sofre disso — é contabilidade do provedor de envio,
 * não de um pixel — e é mais uma razão para ele ser o gate primário.
 */

/** Rótulos de provedor. `Outros` agrega domínio próprio/corporativo. */
export type Provider =
  | "Gmail"
  | "Microsoft"
  | "Yahoo"
  | "Apple"
  | "Proton"
  | "UOL/BOL/Terra"
  | "Outros";

const PROVIDER_BY_DOMAIN: ReadonlyArray<readonly [Provider, readonly string[]]> = [
  ["Gmail", ["gmail.com", "googlemail.com"]],
  ["Microsoft", ["hotmail.com", "hotmail.com.br", "outlook.com", "outlook.com.br", "live.com", "msn.com"]],
  ["Yahoo", ["yahoo.com", "yahoo.com.br", "ymail.com", "rocketmail.com"]],
  ["Apple", ["icloud.com", "me.com", "mac.com"]],
  ["Proton", ["proton.me", "protonmail.com", "pm.me"]],
  ["UOL/BOL/Terra", ["uol.com.br", "bol.com.br", "terra.com.br"]],
];

/**
 * Domínio de um e-mail, normalizado. `null` quando a string não tem a forma
 * mínima de e-mail — entrada malformada NÃO derruba o relatório (o caller
 * vem de uma API externa), vira `Outros` e conta no total.
 */
export function emailDomain(raw: string): string | null {
  const at = raw.trim().toLowerCase().lastIndexOf("@");
  if (at < 1) return null;
  const domain = raw.trim().toLowerCase().slice(at + 1);
  return domain.length > 0 ? domain : null;
}

/** Provedor de um endereço. Domínio desconhecido ou malformado ⇒ `Outros`. */
export function classifyProvider(email: string): Provider {
  const domain = emailDomain(email);
  if (!domain) return "Outros";
  for (const [provider, domains] of PROVIDER_BY_DOMAIN) {
    if (domains.includes(domain)) return provider;
  }
  return "Outros";
}

/**
 * Entrada de {@link computeProviderSplit}.
 *
 * **Todos os campos são normalizados antes do cruzamento** — `trim`, caixa
 * baixa e deduplicação. Um caller que passe `["A@x.com", "a@x.com "]` vê 1
 * endereço, não 2. Isso está aqui, no tipo, e não só na docstring da função,
 * porque a entrada vem de API externa e quem lê a interface para montar a
 * chamada não passa necessariamente pelo corpo dela (#6491).
 *
 * `sent` é o **snapshot do envio**, não a lista de assinantes de agora. A
 * distinção não é cosmética: usar a lista atual como denominador foi o que
 * permitiu o diagnóstico errado do #6504, e some com a ressalva de denominador
 * que a versão anterior precisava documentar (quem entrou/saiu depois do envio
 * deslocava todas as taxas em silêncio).
 */
export interface ProviderSplitInput {
  /** Quem o provedor de envio ACEITOU enviar. Denominador da taxa de entrega. */
  sent: readonly string[];
  /** Quem o provedor de destino ACEITOU receber. Denominador de abertura/clique. */
  delivered: readonly string[];
  /** Quem abriu. Endereço fora de `sent` é ignorado (ver `foraDoEnvio`). */
  openers: readonly string[];
  /** Quem clicou. Mesma regra de `openers`. */
  clickers: readonly string[];
}

export interface ProviderRow {
  provider: Provider | "Gmail (total)" | "Não-Gmail" | "Total";
  sent: number;
  delivered: number;
  openers: number;
  clickers: number;
  /** `delivered / sent`, em pontos percentuais, 1 casa. 0 sem envio. */
  deliveryRatePct: number;
  /** `openers / delivered`, em pontos percentuais, 1 casa. 0 sem entrega. */
  openRatePct: number;
  /** `clickers / delivered`, em pontos percentuais, 1 casa. 0 sem entrega. */
  clickRatePct: number;
}

export interface ProviderSplitResult {
  /** Uma linha por provedor presente, da maior base para a menor. */
  rows: ProviderRow[];
  gmail: ProviderRow;
  naoGmail: ProviderRow;
  total: ProviderRow;
  /**
   * Endereços que abriram/clicaram mas não estão no snapshot de envio.
   *
   * Com `sent` vindo do próprio broadcast isto deveria ser **zero**. Diferente
   * da versão anterior deste módulo — onde o denominador era a lista de ativos
   * e um número aqui significava só churn benigno —, hoje qualquer valor > 0 é
   * sinal de coleta inconsistente entre os dois endpoints, e merece
   * desconfiança antes das taxas serem usadas.
   */
  foraDoEnvio: { openers: number; clickers: number };
  /**
   * Quem abriu ou clicou mas NÃO consta como entregue.
   *
   * Fisicamente impossível: não se abre o que não chegou. Valor > 0 é
   * inconsistência de tracking do provedor de envio, e importa porque infla
   * `openRatePct` (numerador com gente que o denominador não tem) — o caso
   * extremo passa de 100%. Exposto em vez de clampado: um gate que decide
   * envio real não pode ser alimentado por um número corrigido em silêncio.
   */
  engajouSemEntrega: { openers: number; clickers: number };
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function normalizeSet(emails: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const e of emails) {
    const t = e.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

interface Tally {
  sent: number;
  delivered: number;
  openers: number;
  clickers: number;
}

const ZERO: Tally = { sent: 0, delivered: 0, openers: 0, clickers: 0 };

function buildRow(provider: ProviderRow["provider"], t: Tally): ProviderRow {
  return {
    provider,
    sent: t.sent,
    delivered: t.delivered,
    openers: t.openers,
    clickers: t.clickers,
    deliveryRatePct: pct(t.delivered, t.sent),
    openRatePct: pct(t.openers, t.delivered),
    clickRatePct: pct(t.clickers, t.delivered),
  };
}

/**
 * Cruza enviados × entregues × aberturas × cliques e devolve as taxas por
 * provedor.
 *
 * Puro e determinístico: nenhuma chamada de rede, nenhuma leitura de env.
 * Entrega é contada sobre ENVIADOS do provedor; abertura e clique sobre
 * ENTREGUES do provedor — nunca sobre aberturas (isso seria click-to-open,
 * outra métrica) e nunca sobre o total geral (isso mediria a composição da
 * lista, não o provedor).
 */
export function computeProviderSplit(input: ProviderSplitInput): ProviderSplitResult {
  const sent = normalizeSet(input.sent);
  const delivered = normalizeSet(input.delivered);
  const openers = normalizeSet(input.openers);
  const clickers = normalizeSet(input.clickers);

  const foraDoEnvio = {
    openers: [...openers].filter((e) => !sent.has(e)).length,
    clickers: [...clickers].filter((e) => !sent.has(e)).length,
  };
  const engajouSemEntrega = {
    openers: [...openers].filter((e) => sent.has(e) && !delivered.has(e)).length,
    clickers: [...clickers].filter((e) => sent.has(e) && !delivered.has(e)).length,
  };

  const tally = new Map<Provider, Tally>();
  for (const email of sent) {
    const provider = classifyProvider(email);
    const bucket = tally.get(provider) ?? { ...ZERO };
    bucket.sent += 1;
    if (delivered.has(email)) bucket.delivered += 1;
    if (openers.has(email)) bucket.openers += 1;
    if (clickers.has(email)) bucket.clickers += 1;
    tally.set(provider, bucket);
  }

  const rows = [...tally.entries()]
    .map(([provider, t]) => buildRow(provider, t))
    .sort((a, b) => b.sent - a.sent || a.provider.localeCompare(b.provider));

  const g = tally.get("Gmail") ?? ZERO;
  const totals = [...tally.values()].reduce<Tally>(
    (acc, t) => ({
      sent: acc.sent + t.sent,
      delivered: acc.delivered + t.delivered,
      openers: acc.openers + t.openers,
      clickers: acc.clickers + t.clickers,
    }),
    { ...ZERO },
  );

  return {
    rows,
    gmail: buildRow("Gmail (total)", g),
    naoGmail: buildRow("Não-Gmail", {
      sent: totals.sent - g.sent,
      delivered: totals.delivered - g.delivered,
      openers: totals.openers - g.openers,
      clickers: totals.clickers - g.clickers,
    }),
    total: buildRow("Total", totals),
    foraDoEnvio,
    engajouSemEntrega,
  };
}

/**
 * Piso de ENTREGA no lote Gmail. Gate primário da rampa.
 *
 * 95% é o patamar de um remetente saudável, e a coorte de cada onda é formada
 * por quem o Gmail JÁ aceitou antes — então cair abaixo disso não é "ainda
 * aquecendo", é a reputação piorando sob o volume novo. O #6504 mediu 28,2%.
 */
export const RAMPA_GMAIL_DELIVERY_RATE_FLOOR_PCT = 95;

/**
 * Piso de ABERTURA no lote Gmail, sobre os ENTREGUES. Gate secundário.
 *
 * Deliberadamente frouxo: cobre o caso "o Gmail aceita mas manda pro spam",
 * que a taxa de entrega não vê. Não é um alvo de qualidade editorial — a
 * referência da Beehiiv é ~34,8% —, é o piso abaixo do qual a caixa de entrada
 * claramente não está sendo alcançada. Continua frouxo também porque o pixel
 * truncado (#6506) subconta este número enquanto o e-mail passar de 102 KB.
 *
 * **Mudou de significado no #6505** — antes era abertura sobre ENVIADOS, o
 * número que produziu o diagnóstico errado do #6504. O valor 20 é o mesmo por
 * coincidência de escala, não por continuidade: agora é uma condição sobre uma
 * base menor e mais exigente.
 */
export const RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT = 20;

export interface RampaVeredito {
  podeCrescer: boolean;
  /** Motivo em uma linha, pronto pra impressão. Sempre preenchido. */
  motivo: string;
}

/**
 * Veredito da rampa: a onda pode crescer?
 *
 * Duas condições, ambas necessárias — entrega Gmail acima do piso E abertura
 * Gmail (sobre entregues) acima do piso. Lote Gmail vazio nunca aprova: "0 de
 * 0" é ausência de evidência, e a rampa existe justamente para produzir essa
 * evidência.
 *
 * ## O que este veredito NÃO prova
 *
 * A coorte de cada onda é **auto-selecionada por entregabilidade** — entra
 * quem engajou no envio anterior, o que implica que o provedor aceitou aquela
 * mensagem. Um `podeCrescer: true` diz "o lote que já passava continua
 * passando", nunca "o aquecimento resolveu para os endereços que o Gmail
 * recusa". Quem lê isso como aval para reincluir os recusados de uma vez está
 * lendo além do dado (#6504).
 */
export function avaliarRampa(split: ProviderSplitResult): RampaVeredito {
  const { gmail } = split;

  if (gmail.sent === 0) {
    return {
      podeCrescer: false,
      motivo:
        "SEGURAR — nenhum endereço Gmail no envio. Isso não é colapso de entrega: é sinal de consulta/filtro errado. Conferir antes de interpretar como dado.",
    };
  }
  if (gmail.deliveryRatePct < RAMPA_GMAIL_DELIVERY_RATE_FLOOR_PCT) {
    return {
      podeCrescer: false,
      motivo:
        `SEGURAR — entrega Gmail em ${gmail.deliveryRatePct.toFixed(1)}% (${gmail.delivered}/${gmail.sent}), ` +
        `abaixo do piso de ${RAMPA_GMAIL_DELIVERY_RATE_FLOOR_PCT}%. O Gmail está recusando na porta; aquecer antes de crescer.`,
    };
  }
  if (gmail.openRatePct < RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT) {
    return {
      podeCrescer: false,
      motivo:
        `SEGURAR — entrega Gmail OK (${gmail.deliveryRatePct.toFixed(1)}%), mas abertura sobre entregues em ` +
        `${gmail.openRatePct.toFixed(1)}%, abaixo do piso de ${RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT}%. ` +
        `Aceita mas provavelmente não chega na caixa de entrada.`,
    };
  }
  return {
    podeCrescer: true,
    motivo:
      `PODE CRESCER — entrega Gmail em ${gmail.deliveryRatePct.toFixed(1)}% e abertura sobre entregues em ` +
      `${gmail.openRatePct.toFixed(1)}%, ambas acima do piso. Vale só para o perfil já aceito pelo Gmail.`,
  };
}

/** Atalho booleano de {@link avaliarRampa}, para quem não precisa do motivo. */
export function rampaPodeCrescer(split: ProviderSplitResult): boolean {
  return avaliarRampa(split).podeCrescer;
}
