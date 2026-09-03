/**
 * openrouter-billing-leak.ts (#6716 escopo 3)
 *
 * Lógica PURA do guard que detecta MODELO PAGO NÃO PEDIDO sendo faturado no
 * gateway OpenRouter — o vazamento que o #6716 mediu (Claude Sonnet 5 a
 * preço cheio, ~75% do custo de cada delegação do contínuo, invisível no
 * transcript da sessão).
 *
 * ## Por que a fonte é o BILLING DO GATEWAY, e não a tabela local
 *
 * Já existe um detector de vazamento pago (`_is_leak`/`vazamento_pago` em
 * `hermes/scripts/hermes-model-cost-report.py`), rodado todo dia pelo
 * `watch-continuo-health.sh`, que reporta "custo ok (sem vazamento pago em
 * 24h)". **Ele é estruturalmente incapaz de ver este vazamento**, e isso foi
 * medido (01/09/2026, comentário na #6716): `session_model_usage` — a tabela
 * que ele lê — tem ZERO linhas de `anthropic/claude-sonnet-5` em TODO o
 * histórico, enquanto o `/api/v1/activity` do OpenRouter cobrou, pelos
 * mesmos dias:
 *
 *     2026-08-29  anthropic/claude-sonnet-5   21 req   USD 1.2064
 *     2026-08-30  anthropic/claude-sonnet-5   10 req   USD 0.3868
 *     2026-08-31  anthropic/claude-sonnet-5   32 req   USD 0.9599
 *
 * A razão é a mesma que o corpo do #6716 dá pro transcript: são chamadas
 * INTERNAS do CLI (compactação, título, caminhos que pedem modelo por
 * FAMÍLIA), não mensagens da sessão — não entram no que o Hermes
 * contabiliza por sessão. O #6716 já concluía *"o transcript não é fonte
 * confiável para custo; a fonte é o billing do gateway"*; vale igual pra
 * tabela local.
 *
 * ## Limitação de desenho, herdada do endpoint e NÃO contornável aqui
 *
 * `/api/v1/activity` **não cobre o dia corrente** (~1 dia de consolidação).
 * Então este guard é necessariamente **D-1**, nunca "pós-tick" imediato como
 * o título do escopo 3 sugere. Um alarme que rodasse logo após o tick não
 * teria dado nenhum pra ler — preferir D-1 honesto a tempo-real fabricado.
 *
 * Todo I/O (fetch do endpoint, credencial, alarme) vive em
 * `scripts/openrouter-billing-leak-check.ts`.
 */

/** Uma linha de `/api/v1/activity` — só os campos que este guard usa. */
export interface BillingRow {
  /** `YYYY-MM-DD` ou ISO; comparado como string, nunca parseado como data. */
  date: string;
  model: string;
  requests: number;
  /** USD faturado nessa linha. */
  usageUsd: number;
}

export interface BillingLeak {
  date: string;
  model: string;
  requests: number;
  usageUsd: number;
}

export interface BillingLeakEvaluation {
  leaks: BillingLeak[];
  /** Soma do que foi faturado FORA da allowlist na janela. */
  leakedUsd: number;
  /** Soma de TUDO faturado na janela — contexto pro leitor do alarme. */
  totalUsd: number;
  /** Dias efetivamente presentes no dado (o endpoint pode não cobrir o
   *  intervalo pedido — ver a limitação D-1 no docblock do módulo). */
  daysCovered: string[];
}

/**
 * Modelos cuja cobrança é ESPERADA — a cadeia que o repo de fato pede.
 *
 * Duplicado de propósito em relação ao `PAID_ALLOWLIST` de
 * `hermes-model-cost-report.py` (que é Python e lê outra fonte): o objetivo
 * aqui é justamente NÃO herdar as premissas daquele detector, que provou
 * estar olhando pro lugar errado. Se os dois divergirem, é sinal a
 * investigar, não erro a silenciar.
 *
 * `:free` nunca é vazamento — não custa dólar (o custo dele é cota, coberta
 * por outro guard, ver #6907).
 */
export const EXPECTED_PAID_MODELS: ReadonlySet<string> = new Set([
  "z-ai/glm-5.3-flash", // elo pago da cadeia do wrapper (MODELS_DEFAULT)
  "gpt-5.6-luna",
  "openai-codex/gpt-5.6-luna",
  "openai/gpt-5.6-luna", // mesma família sob o id prefixado do gateway
]);

/**
 * `true` quando a linha representa gasto que ninguém pediu.
 *
 * **Não há atalho por sufixo `:free` (#6983 review, achado 3).** A 1ª versão
 * tinha `if (row.model.endsWith(":free")) return false` DEPOIS do teste de
 * `usageUsd > 0` — ou seja, o atalho só era alcançado por uma linha `:free`
 * que **de fato cobrou dólar**, que é precisamente a anomalia que vale ver
 * (mudança de tier, overage, bug de billing do gateway). O guard descartava
 * em silêncio a única circunstância em que aquele branch importava, apoiado
 * na premissa "`:free` nunca cobra" — e delegar a garantia a outro guard
 * (#6907, que vigia COTA, não dólar) é a mesma confiança-cruzada que já
 * falhou no `vazamento_pago` original.
 *
 * Gasto ZERO segue não sendo vazamento: é assim que todo `:free` normal
 * aparece no activity (usage 0,0000), e é o teste que basta.
 */
export function isBillingLeak(row: BillingRow, expected: ReadonlySet<string> = EXPECTED_PAID_MODELS): boolean {
  if (!(row.usageUsd > 0)) return false;
  return !expected.has(row.model);
}

/**
 * Dias de calendário UTC esperados na janela `[cutoff .. D-1]`, onde D-1 é
 * ontem.
 *
 * O endpoint `/api/v1/activity` agrega por dias UTC completos e **não cobre o
 * dia corrente** (~1 dia de consolidação). "Últimos N dias" aqui significa N
 * dias de calendário UTC que TERMINAM ontem — nunca o dia corrente. A data de
 * `cutoff` usada em `openrouter-billing-leak-check.ts` é derivada de
 * `Date.now() - days * 24h` em UTC; este cálculo espelha esse mesmo referencial
 * para que os dois lados da comparação nunca divergam.
 *
 * #6992: `daysCovered` é comparado contra este conjunto. Ausência de qualquer
 * dia esperado — especialmente os mais recentes, onde um vazamento fresco seria
 * visível — vira INDETERMINADO, não "sem vazamento". Um dia com gasto realmente
 * zero (nenhuma chamada feita) também não aparece no activity, então o ruído de
 * "indeterminado em dia ocioso" é aceito de propósito: prevenir um
 * falso-negativo de vazamento pesa mais que um alarme extra num dia quieto.
 */
export function computeExpectedDays(days: number, now: Date = new Date()): string[] {
  if (days <= 0) return [];
  const result: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    result.push(d.toISOString().slice(0, 10));
  }
  return result.sort();
}

/**
 * `true` quando `daysCovered` falta algum dia esperado na janela.
 *
 * #6992: o guard original só tratava janela 100% vazia como indeterminado.
 * Presença parcial (ex: só D-3 presente, faltando D-2 e D-1) era lida como
 * cobertura completa — e um vazamento fresco nos dias recentes escapava sempre,
 * pois o dado consolidado daquele dia ainda não tinha chegado.
 */
export function hasPartialCoverage(daysCovered: readonly string[], expectedDays: readonly string[]): boolean {
  const covered = new Set(daysCovered);
  return expectedDays.some((d) => !covered.has(d));
}

/**
 * Pura — agrega as linhas do gateway e devolve o que foi cobrado fora da
 * allowlist. Linhas do MESMO modelo em dias diferentes ficam separadas de
 * propósito: saber que o vazamento voltou HOJE, e não só que existiu na
 * janela, é o que distingue "regressão nova" de "resíduo do dia do fix".
 */
export function evaluateBillingLeak(
  rows: readonly BillingRow[],
  expected: ReadonlySet<string> = EXPECTED_PAID_MODELS,
): BillingLeakEvaluation {
  const leaks: BillingLeak[] = [];
  let leakedUsd = 0;
  let totalUsd = 0;
  const days = new Set<string>();

  for (const row of rows) {
    days.add(row.date.slice(0, 10));
    totalUsd += row.usageUsd > 0 ? row.usageUsd : 0;
    if (isBillingLeak(row, expected)) {
      leaks.push({ date: row.date.slice(0, 10), model: row.model, requests: row.requests, usageUsd: row.usageUsd });
      leakedUsd += row.usageUsd;
    }
  }

  leaks.sort((a, b) => b.usageUsd - a.usageUsd);
  return { leaks, leakedUsd, totalUsd, daysCovered: [...days].sort() };
}

// ─── Idempotência do alarme (mesmo molde dos demais alarmes "estado") ──────
//
// #7211: o fingerprint original deduplicava por CONJUNTO inteiro (dia+modelo
// de TODOS os leaks da janela, ordenado e concatenado). Como a janela é
// deslizante (`--days N`), um incidente de N dias produz N conjuntos
// DIFERENTES conforme dias mais velhos saem da janela — e cada conjunto
// novo (mesmo sendo um SUBCONJUNTO do já avisado, nunca achado novo) batia
// `!== lastAlarmedFingerprint` e re-enviava o e-mail. Reproduzido ao vivo:
// incidente de 3 dias (29-31/08) produziu 3 e-mails, um por dia que saía da
// janela — o 2º e 3º sem NENHUM dado novo, só o total encolhendo.
//
// A correção troca "dedup por CONJUNTO" por "dedup por ITEM, acumulado":
// `alarmedKeys` guarda toda chave `date:model` já avisada, através de
// janelas sucessivas — `shouldAlarmBillingLeak`/`newBillingLeakKeys` só
// consideram achado novo o que NUNCA apareceu em `alarmedKeys`, nunca "saiu
// e voltou a aparecer no conjunto atual".

export interface BillingLeakAlarmState {
  /** Chaves `date:model` (ver `billingLeakKey`) de todo vazamento já
   * avisado, acumuladas através de janelas sucessivas — não o conjunto da
   * ÚLTIMA leitura (#7211). Podadas por `advanceBillingLeakAlarmState`
   * (`MAX_ALARMED_KEY_AGE_DAYS`) pra não crescer sem limite. */
  alarmedKeys: string[];
  lastCheckedAt: string | null;
}

export function emptyBillingLeakAlarmState(): BillingLeakAlarmState {
  return { alarmedKeys: [], lastCheckedAt: null };
}

/** Pura — chave estável de UM achado (dia+modelo). Inclui o dia: o mesmo
 *  modelo vazando num dia NOVO é achado novo, não repetição do já avisado. */
export function billingLeakKey(leak: Pick<BillingLeak, "date" | "model">): string {
  return `${leak.date}:${leak.model}`;
}

/** Pura — fingerprint do CONJUNTO de vazamentos (dia+modelo, ordenado).
 *  Mantida por compat de nome/uso (estabilidade sob reordenação das linhas
 *  de entrada) — não é mais a base da decisão de alarmar (#7211, ver
 *  `newBillingLeakKeys`/`shouldAlarmBillingLeak` abaixo). */
export function billingLeakFindingKey(evaluation: Pick<BillingLeakEvaluation, "leaks">): string {
  return evaluation.leaks
    .map((l) => billingLeakKey(l))
    .sort()
    .join(",");
}

export function isBillingLeakPending(evaluation: Pick<BillingLeakEvaluation, "leaks">): boolean {
  return evaluation.leaks.length > 0;
}

/** Pura (#7211) — chaves do achado atual que ainda NÃO estão em
 * `state.alarmedKeys`. Vazio = nada de novo a avisar (mesmo achado
 * reaparecendo numa janela menor não conta como novo). Sempre ordenado e
 * sem duplicatas. */
export function newBillingLeakKeys(
  evaluation: Pick<BillingLeakEvaluation, "leaks">,
  state: Pick<BillingLeakAlarmState, "alarmedKeys">,
): string[] {
  const alreadyAlarmed = new Set(state.alarmedKeys);
  const currentKeys = new Set(evaluation.leaks.map((l) => billingLeakKey(l)));
  return [...currentKeys].filter((k) => !alreadyAlarmed.has(k)).sort();
}

/** Teto de retenção de `alarmedKeys` — generoso o bastante pra cobrir
 * qualquer `--days` plausível deste guard (default 3, nunca visto acima de
 * ~7 em uso real) sem deixar o array crescer pra sempre. Chaves com `date`
 * mais velho que `now - MAX_ALARMED_KEY_AGE_DAYS` são podadas. */
export const MAX_ALARMED_KEY_AGE_DAYS = 30;

/** Pura — remove de `keys` as chaves cujo prefixo `YYYY-MM-DD` (os 10
 * primeiros caracteres de `date:model`, formato fixo de `billingLeakKey`) é
 * mais velho que o teto de retenção. */
export function pruneOldAlarmedKeys(keys: readonly string[], now: Date): string[] {
  const cutoff = new Date(now.getTime() - MAX_ALARMED_KEY_AGE_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return [...new Set(keys)].filter((k) => k.slice(0, 10) >= cutoff).sort();
}

export function advanceBillingLeakAlarmState(
  evaluation: BillingLeakEvaluation,
  now: Date,
  priorState: Pick<BillingLeakAlarmState, "alarmedKeys"> = emptyBillingLeakAlarmState(),
): BillingLeakAlarmState {
  const merged = [...priorState.alarmedKeys, ...evaluation.leaks.map((l) => billingLeakKey(l))];
  return {
    alarmedKeys: pruneOldAlarmedKeys(merged, now),
    lastCheckedAt: now.toISOString(),
  };
}

export function shouldAlarmBillingLeak(
  state: BillingLeakAlarmState,
  evaluation: BillingLeakEvaluation,
): boolean {
  if (!isBillingLeakPending(evaluation)) return false;
  return newBillingLeakKeys(evaluation, state).length > 0;
}

/**
 * Pura — assunto + corpo do e-mail (texto puro, molde dos demais alarmes).
 *
 * `newKeys` (#7211, opcional — default = todo `evaluation.leaks`, mesmo
 * comportamento de antes desta issue): as chaves (`billingLeakKey`) que são
 * achado NOVO desde o último aviso (ver `newBillingLeakKeys`). O corpo
 * separa achado NOVO (destaque) de achado já avisado que ainda aparece na
 * janela atual (contexto, sem prescrição nova) — em vez de listar tudo como
 * se fosse igualmente urgente.
 */
export function buildBillingLeakAlarmEmail(
  evaluation: BillingLeakEvaluation,
  now: Date = new Date(),
  newKeys?: readonly string[],
): { subject: string; body: string } {
  const subject = `[diar.ia.br] modelo pago não pedido faturado no OpenRouter (US$ ${evaluation.leakedUsd.toFixed(4)})`;

  const newKeySet = new Set(newKeys ?? evaluation.leaks.map((l) => billingLeakKey(l)));
  const newLeaks = evaluation.leaks.filter((l) => newKeySet.has(billingLeakKey(l)));
  const alreadyKnownLeaks = evaluation.leaks.filter((l) => !newKeySet.has(billingLeakKey(l)));

  const lines: string[] = [
    "O guard `openrouter-billing-leak-check.ts` (#6716 escopo 3) encontrou",
    "cobrança de modelo FORA da cadeia que o repo pede, no billing do gateway.",
    "",
    `Janela coberta: ${evaluation.daysCovered.join(", ") || "(vazia)"}`,
    `Faturado fora da allowlist: US$ ${evaluation.leakedUsd.toFixed(4)} de US$ ${evaluation.totalUsd.toFixed(4)} no total`,
    "",
  ];

  if (newLeaks.length > 0) {
    lines.push("Achado(s) NOVO(s) desde o último aviso:");
    for (const l of newLeaks) {
      lines.push(`  ${l.date}  ${l.model}  —  ${l.requests} req  US$ ${l.usageUsd.toFixed(4)}`);
    }
    lines.push("");
  }
  if (alreadyKnownLeaks.length > 0) {
    // #7211: contexto, não repetição do aviso — este alarme já foi enviado
    // pra estas chaves numa execução anterior; seguem faturadas na janela
    // atual só porque a janela é deslizante, não porque é achado novo.
    lines.push("Já avisado(s) antes — seguem faturado(s) na janela atual, sem ação nova:");
    for (const l of alreadyKnownLeaks) {
      lines.push(`  ${l.date}  ${l.model}  —  ${l.requests} req  US$ ${l.usageUsd.toFixed(4)}`);
    }
    lines.push("");
  }

  lines.push(
    "",
    "Por que este guard existe e por que ele lê o GATEWAY:",
    "o detector antigo (`vazamento_pago` em hermes-model-cost-report.py) lê",
    "`session_model_usage`, tabela que NUNCA registrou uma única chamada de",
    "`anthropic/claude-sonnet-5` — nem nos dias em que o OpenRouter cobrou por",
    "ela. São chamadas internas do CLI, não mensagens da sessão (#6716).",
    "",
    "Se o modelo listado acima for legítimo, adicione-o a EXPECTED_PAID_MODELS",
    "em scripts/lib/openrouter-billing-leak.ts — nunca silencie ampliando a",
    "janela ou baixando o alarme.",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}
