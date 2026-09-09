/**
 * onboarding-returning-watch.ts (#7660)
 *
 * Miolo PURO do watcher de RECADASTRO: quem já foi assinante, saiu (ou foi
 * removido) e volta a se cadastrar não pode receber o e-mail 1 de
 * boas-vindas de novo.
 *
 * ## O problema que isto existe pra evitar
 *
 * Um assinante removido do Kit e recadastrado vira, para o pipeline, um
 * cadastro NOVO: id novo, `created_at` de agora. A rodada diária de
 * `onboarding-welcome-run.ts` (09:05 BRT) detecta e manda o e-mail 1 —
 * "Você está dentro. Aqui está o que muda a partir de agora" — para alguém
 * que lê a newsletter há meses.
 *
 * Isso não é hipotético: é a forma exata do #6043 (585 pessoas antigas
 * receberam essa mensagem por um recorte que virou no-op), e o caso da
 * #7660 é um leitor de 248 edições e 84,68% de abertura que já recebeu esse
 * "bem-vindo" indevido uma vez — quatro dias antes de o provedor dele
 * registrar queixa de spam.
 *
 * ## Por que é automação e não um comando manual
 *
 * A regra não tem julgamento no meio: "quando este e-mail aparecer no Kit,
 * semeie a entrada dele com o e-mail 1 já marcado". Deixar isso como
 * alavanca manual significa alguém precisar estar acordado na janela certa —
 * e a janela é diária, contra uma task que roda sozinha às 09:05.
 *
 * ## O que este módulo NÃO faz
 *
 * Não fala com o Kit, não lê nem escreve disco, não envia nada. Recebe o
 * estado já apurado e devolve a decisão. O I/O mora em
 * `scripts/onboarding-watch-returning.ts`.
 *
 * Semear TAMBÉM não envia — a entrada nasce com `email1_sent_at` preenchido,
 * o que faz a detecção pular a pessoa e o e-mail 1 nunca sair. Os e-mails 2
 * e 3 seguem a cadência normal, o que é desejado: são conteúdo (o jogo "É
 * IA?" e o pedido de apoio), não boas-vindas.
 */

/** Uma pessoa sob observação, como o arquivo de watchlist a guarda. */
export interface WatchedReturning {
  email: string;
  /** Rótulo de origem — vira `seeded_by` na entrada do store. Ex.: `"#7660"`. */
  reason: string;
  /** ISO de quando entrou na lista. */
  added_at: string;
  /** ISO de quando a semeadura aconteceu. `null` = ainda observando. */
  seeded_at: string | null;
  /** Id do Kit no momento da semeadura — registro, não usado para decidir. */
  kit_id?: number | null;
}

export interface ReturningWatchlist {
  version: 1;
  entries: WatchedReturning[];
}

/** O que o Kit devolveu para aquele e-mail (ou `null` se ainda não existe). */
export interface WatchKitSubscriber {
  id: number;
  email_address: string;
  state: string;
  created_at: string;
}

export type WatchDecision =
  /** Ainda não se recadastrou — nada a fazer, continua observando. */
  | { kind: "aguardando"; email: string }
  /**
   * Existe no Kit mas não está `active` (double opt-in pendente, ou
   * suprimido de novo). Não semeia: uma entrada semeada para quem não está
   * ativo ficaria parada no store sem servir a nada, e o estado pode ainda
   * mudar. Continua observando.
   */
  | { kind: "nao-active"; email: string; state: string }
  /**
   * Já tem entrada no store — ou porque a rodada diária chegou antes (o
   * e-mail 1 já saiu, tarde demais), ou porque uma semeadura anterior já
   * cobriu. De qualquer forma não há o que fazer, e semear por cima
   * sobrescreveria histórico. Marca como resolvido para parar de observar.
   */
  | { kind: "ja-no-store"; email: string; detalhe: string }
  /** Recadastrou e está limpo: semear com o e-mail 1 já marcado. */
  | {
      kind: "semear";
      email: string;
      kitId: number;
      /** ISO — vira `email1_sent_at`, a data real do recadastro. */
      seedEmail1SentAt: string;
      reason: string;
    };

/**
 * Decide o destino de UMA pessoa observada.
 *
 * `storeHasEmail`/`storeHasKitId` vêm do store de onboarding já lido. Os dois
 * eixos são checados porque a chave do store é o id, mas a identidade que o
 * watcher conhece é o e-mail — a mesma lição do review da #7674, onde casar
 * só por e-mail deixava passar quem tinha trocado de endereço.
 */
export function decideWatchEntry(
  entry: WatchedReturning,
  kit: WatchKitSubscriber | null,
  storeHasEmail: boolean,
  storeHasKitId: boolean,
): WatchDecision {
  if (!kit) return { kind: "aguardando", email: entry.email };
  if (kit.state !== "active") return { kind: "nao-active", email: entry.email, state: kit.state };
  if (storeHasEmail || storeHasKitId) {
    return {
      kind: "ja-no-store",
      email: entry.email,
      detalhe: storeHasEmail ? "já existe entrada com este e-mail" : `já existe entrada com o id ${kit.id}`,
    };
  }
  return {
    kind: "semear",
    email: entry.email,
    kitId: kit.id,
    // A data real do recadastro, não `now`: se o watcher rodar horas depois,
    // `now` faria o D+3 do e-mail 2 contar do momento errado.
    seedEmail1SentAt: kit.created_at,
    reason: entry.reason,
  };
}

/** Só as entradas ainda em observação — `seeded_at` preenchido sai da fila. */
export function pendingWatchEntries(list: ReturningWatchlist): WatchedReturning[] {
  return list.entries.filter((e) => e.seeded_at == null);
}

/** Watchlist vazia, para quando o arquivo ainda não existe. */
export function emptyWatchlist(): ReturningWatchlist {
  return { version: 1, entries: [] };
}

/**
 * Adiciona alguém à observação. Idempotente por e-mail (minúsculo): re-adicionar
 * quem já está lá e ainda não foi semeado não duplica nem reseta o `added_at`.
 */
export function addToWatchlist(
  list: ReturningWatchlist,
  email: string,
  reason: string,
  nowIso: string,
): { list: ReturningWatchlist; added: boolean } {
  const alvo = email.trim().toLowerCase();
  const jaTem = list.entries.some((e) => e.email.toLowerCase() === alvo && e.seeded_at == null);
  if (jaTem) return { list, added: false };
  return {
    list: { ...list, entries: [...list.entries, { email: alvo, reason, added_at: nowIso, seeded_at: null, kit_id: null }] },
    added: true,
  };
}

/** Marca alguém como resolvido (semeado ou já-no-store), saindo da fila. */
export function markWatchResolved(
  list: ReturningWatchlist,
  email: string,
  nowIso: string,
  kitId: number | null,
): ReturningWatchlist {
  const alvo = email.trim().toLowerCase();
  return {
    ...list,
    entries: list.entries.map((e) =>
      e.email.toLowerCase() === alvo && e.seeded_at == null ? { ...e, seeded_at: nowIso, kit_id: kitId } : e,
    ),
  };
}

/** Linha de log por decisão — o que o operador lê no `.log` da task. */
export function renderWatchDecision(d: WatchDecision): string {
  switch (d.kind) {
    case "aguardando":
      return `  aguardando · ${d.email} — ainda não se recadastrou`;
    case "nao-active":
      return `  ignorado   · ${d.email} — existe no Kit mas state=${d.state}, continua em observação`;
    case "ja-no-store":
      return `  resolvido  · ${d.email} — ${d.detalhe}; nada a semear`;
    case "semear":
      return `  SEMEAR     · ${d.email} · kit=${d.kitId} · e-mail 1 marcado como enviado em ${d.seedEmail1SentAt}`;
  }
}
