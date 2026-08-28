/**
 * provider-split.ts — corte de engajamento por PROVEDOR de e-mail.
 *
 * Miolo puro de `scripts/kit-provider-split.ts`. Existe porque o número
 * agregado de um envio esconde a única coisa que importava no incidente de
 * 28/08/2026: a edição 260827 saiu pelo Kit com 13,97% de abertura contra
 * 34,8% de média na Beehiiv, e a queda estava INTEIRA no Gmail — 8,5% de
 * abertura entre os endereços `@gmail.com` (434 dos 596 assinantes ativos,
 * 72,8%) contra 28,4% em todo o resto. O agregado sozinho não distingue
 * "conteúdo ruim" de "um provedor filtrou o envio"; este corte distingue.
 *
 * ## Por que o corte Gmail × resto é destacado à parte
 *
 * A tabela por provedor responde "onde está a queda". Mas a decisão
 * operacional da rampa (`platform.config.json` → `kit_diaria.audience_tag`)
 * é binária — a onda cresce ou para —, e o critério é a abertura do lote
 * Gmail. Por isso `gmail` e `naoGmail` são campos próprios do resultado, não
 * linhas que o caller tem que reencontrar na tabela.
 *
 * ## Abertura E clique juntos: o que o corte permite concluir
 *
 * Abertura baixa sozinha pode ser artefato de medição (o pixel de abertura do
 * Kit é o último elemento do e-mail; acima do corte de ~102 KB o Gmail trunca
 * e o pixel não carrega). Abertura E clique caindo juntos no MESMO provedor
 * não tem explicação de medição — é entrega. Por isso as duas taxas andam
 * lado a lado em toda linha, nunca uma sem a outra.
 */

/** Rótulos de provedor. `outros` agrega domínio próprio/corporativo. */
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
 * **Os três campos são normalizados antes do cruzamento** — `trim`, caixa
 * baixa e deduplicação. Um caller que passe `["A@x.com", "a@x.com "]` vê 1
 * destinatário, não 2. Isso está aqui, no tipo, e não só na docstring da
 * função, porque a entrada vem de API externa e quem lê a interface para
 * montar a chamada não passa necessariamente pelo corpo dela (#6491).
 */
export interface ProviderSplitInput {
  /** Quem recebeu o envio. Duplicatas e diferenças de caixa são absorvidas. */
  recipients: readonly string[];
  /** Quem abriu. Endereço fora de `recipients` é ignorado (ver `foraDaLista`). */
  openers: readonly string[];
  /** Quem clicou. Mesma regra de `openers`. */
  clickers: readonly string[];
}

export interface ProviderRow {
  provider: Provider | "Gmail (total)" | "Não-Gmail" | "Total";
  recipients: number;
  openers: number;
  clickers: number;
  /** `openers / recipients`, em pontos percentuais, 1 casa. 0 sem destinatário. */
  openRatePct: number;
  /** `clickers / recipients`, em pontos percentuais, 1 casa. 0 sem destinatário. */
  clickRatePct: number;
}

export interface ProviderSplitResult {
  /** Uma linha por provedor presente, da maior base para a menor. */
  rows: ProviderRow[];
  gmail: ProviderRow;
  naoGmail: ProviderRow;
  total: ProviderRow;
  /**
   * Endereços que abriram/clicaram mas não estão na lista de destinatários.
   *
   * Não é um erro: a lista de ativos é lida AGORA e o envio foi antes, então
   * quem descadastrou no meio some da lista e continua no relatório de
   * abertura. Fica exposto porque um número grande aqui significa que o corte
   * está sendo calculado sobre uma base que já não é a do envio — aí a
   * comparação com o agregado do Kit deixa de fechar, e é melhor saber disso
   * do que ver a divergência e culpar a matemática.
   */
  foraDaLista: { openers: number; clickers: number };
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

function buildRow(
  provider: ProviderRow["provider"],
  recipients: number,
  openers: number,
  clickers: number,
): ProviderRow {
  return {
    provider,
    recipients,
    openers,
    clickers,
    openRatePct: pct(openers, recipients),
    clickRatePct: pct(clickers, recipients),
  };
}

/**
 * Cruza destinatários × aberturas × cliques e devolve as taxas por provedor.
 *
 * Puro e determinístico: nenhuma chamada de rede, nenhuma leitura de env.
 * Abertura e clique são sempre contados sobre DESTINATÁRIOS do provedor —
 * nunca sobre aberturas (isso seria click-to-open, outra métrica) e nunca
 * sobre o total geral (isso mediria a composição da lista, não o provedor).
 */
export function computeProviderSplit(input: ProviderSplitInput): ProviderSplitResult {
  const recipients = normalizeSet(input.recipients);
  const openers = normalizeSet(input.openers);
  const clickers = normalizeSet(input.clickers);

  const foraDaLista = {
    openers: [...openers].filter((e) => !recipients.has(e)).length,
    clickers: [...clickers].filter((e) => !recipients.has(e)).length,
  };

  const tally = new Map<Provider, { recipients: number; openers: number; clickers: number }>();
  for (const email of recipients) {
    const provider = classifyProvider(email);
    const bucket = tally.get(provider) ?? { recipients: 0, openers: 0, clickers: 0 };
    bucket.recipients += 1;
    if (openers.has(email)) bucket.openers += 1;
    if (clickers.has(email)) bucket.clickers += 1;
    tally.set(provider, bucket);
  }

  const rows = [...tally.entries()]
    .map(([provider, b]) => buildRow(provider, b.recipients, b.openers, b.clickers))
    .sort((a, b) => b.recipients - a.recipients || a.provider.localeCompare(b.provider));

  const g = tally.get("Gmail") ?? { recipients: 0, openers: 0, clickers: 0 };
  const totals = [...tally.values()].reduce(
    (acc, b) => ({
      recipients: acc.recipients + b.recipients,
      openers: acc.openers + b.openers,
      clickers: acc.clickers + b.clickers,
    }),
    { recipients: 0, openers: 0, clickers: 0 },
  );

  return {
    rows,
    gmail: buildRow("Gmail (total)", g.recipients, g.openers, g.clickers),
    naoGmail: buildRow(
      "Não-Gmail",
      totals.recipients - g.recipients,
      totals.openers - g.openers,
      totals.clickers - g.clickers,
    ),
    total: buildRow("Total", totals.recipients, totals.openers, totals.clickers),
    foraDaLista,
  };
}

/**
 * Veredito da rampa: a onda pode crescer?
 *
 * O limiar de 20% de abertura no lote Gmail é a trava registrada em
 * `platform.config.json` → `kit_diaria.audience_tag_note`. Abaixo dele a
 * reputação não está acompanhando o volume e a onda para de crescer — não
 * volta atrás sozinha, só para.
 */
export const RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT = 20;

export function rampaPodeCrescer(split: ProviderSplitResult): boolean {
  return split.gmail.recipients > 0 && split.gmail.openRatePct >= RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT;
}
