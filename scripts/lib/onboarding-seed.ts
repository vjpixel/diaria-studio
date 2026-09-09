/**
 * onboarding-seed.ts (#7674)
 *
 * Miolo PURO do modo dirigido de `onboarding-welcome-run.ts` — "processe
 * exatamente esta lista de e-mails", em vez de "processe quem a detecção
 * automática encontrou desde o cursor".
 *
 * ## Por que existe
 *
 * A troca de canal do onboarding (Kit → Brevo, #7599) deixou duas coortes
 * que a detecção automática NUNCA vai alcançar, porque o cursor foi
 * remarcado à frente das duas no bootstrap de 08/09/2026:
 *
 *   - **#7665** — 31 cadastros na janela entre a morte da sequence do Kit
 *     (07/09 17:01 UTC) e o bootstrap do cursor (08/09 12:05 UTC). Não
 *     receberam NADA (`stats.sent = 0` no Kit). Precisam da sequência
 *     inteira, a partir do e-mail 1.
 *   - **#7675** — 175 que receberam o e-mail 1 pela sequence do Kit e
 *     ficaram sem o 2 e o 3. Precisam do OPOSTO: entrar no store com
 *     `email1_sent_at` JÁ preenchido, para que o Brevo continue de onde a
 *     sequence parou e nunca reenvie o e-mail 1.
 *
 * Os dois casos são a mesma operação com um parâmetro diferente
 * (`seed_email1_sent_at` nulo ou não), e é por isso que moram num módulo só.
 *
 * ## O que este módulo NÃO faz: enviar
 *
 * `planSeed` só decide QUE ENTRADAS ESCREVER no store. Nenhum e-mail sai
 * daqui, e o caller não deve mandar e-mail no mesmo passo. Semear é escrita
 * de estado; o envio continua sendo trabalho do caminho normal
 * (`buildRunPlan`), que já carrega todos os guards existentes — corpo
 * pendente, status não-active, idade D+3/D+10, `--skip-emailN`. Um modo
 * dirigido que também enviasse duplicaria essas regras num segundo caminho,
 * e é justamente a duplicação de caminho de envio que produziu o #6043.
 *
 * Consequência prática: semear os 31 da #7665 faz o e-mail 1 sair na
 * PRÓXIMA rodada diária, não no ato.
 *
 * ## Tudo-ou-nada, de propósito
 *
 * Qualquer recusa aborta o plano inteiro (`ok: false`), em vez de semear o
 * que deu e pular o resto. O #6043 mandou 585 e-mails indevidos porque um
 * recorte silencioso passou por cima de um caso que ninguém tinha olhado —
 * a lição operacional é que, numa ferramenta que dispara e-mail para pessoa
 * real, "pulei alguns" é indistinguível de "recortei errado" até chegar a
 * reclamação. Abortar força o operador a olhar a lista antes de qualquer
 * escrita.
 *
 * A recusa carrega SEMPRE o e-mail e o motivo, para o operador corrigir a
 * lista sem adivinhar qual endereço causou o quê.
 */

/** Estado do assinante no Kit, como `planSeed` precisa vê-lo. */
export interface SeedKitSubscriber {
  /** Id NUMÉRICO do Kit — nunca um `sub_...` da Beehiiv (ver #7670). */
  id: number;
  email: string;
  /** `active` | `cancelled` | `bounced` | `complained` | `inactive`. */
  state: string;
  /** ISO 8601 de `created_at` do Kit. */
  created_at: string;
}

/** O que o caller já tem no store, reduzido ao que a decisão precisa. */
export interface SeedExistingEntry {
  subscription_id: string;
  email: string;
  email1_sent_at: string | null;
}

export interface SeedInput {
  /** Lista explícita, na ordem em que o operador a forneceu. */
  emails: string[];
  /** Assinantes resolvidos no Kit, indexados por e-mail minúsculo. */
  kitByEmail: Map<string, SeedKitSubscriber>;
  /** Entradas já existentes no store, indexadas por e-mail minúsculo. */
  existingByEmail: Map<string, SeedExistingEntry>;
  /**
   * As MESMAS entradas, indexadas por `subscription_id` — a CHAVE do mapa
   * `entries` do store.
   *
   * Existe porque a dedup por e-mail sozinha tem um furo com consequência
   * real (achado do review da PR #7683): o store é escrito em
   * `entries[subscription_id]`, mas a checagem `ja_no_store` casava só por
   * e-mail. Se alguém MUDA de e-mail no Kit (mesmo id, endereço novo), a
   * entrada antiga continua guardada sob o e-mail ANTIGO — a busca por
   * e-mail não acha, a recusa não dispara, e o `store.entries[id] = {...}`
   * seguinte SOBRESCREVE o histórico de onboarding daquela pessoa
   * (`email1_sent_at` volta a `null`). Na rodada seguinte ela é detectada
   * como nova e recebe os 3 e-mails de novo — o #6043 em miniatura, chegando
   * pelo descasamento id↔e-mail em vez de endereço duplicado.
   */
  existingById: Map<string, SeedExistingEntry>;
  /**
   * ISO — quando o e-mail 1 JÁ saiu por outro canal (#7675: a data de
   * inscrição na sequence do Kit). `null` = a coorte não recebeu nada e
   * deve receber o e-mail 1 pelo caminho normal (#7665).
   */
  seedEmail1SentAt: string | null;
  /** Rótulo de origem gravado na entrada, ex. `"#7665"`. Obrigatório. */
  seededBy: string;
}

export type SeedRefusalReason =
  /** O e-mail apareceu mais de uma vez na lista de entrada. */
  | "duplicado_na_lista"
  /** Não existe assinante com este e-mail no Kit. */
  | "nao_encontrado_no_kit"
  /** Existe no Kit, mas não está `active` (suprimido, cancelado, etc.). */
  | "estado_nao_active"
  /** Já tem entrada no store — semear por cima é ambíguo, nunca implícito. */
  | "ja_no_store"
  /** `seededBy` vazio — a origem é obrigatória para auditoria posterior. */
  | "seeded_by_ausente"
  /** `--seed-email1-sent-at` não é uma data ISO parseável. */
  | "seed_email1_sent_at_invalido";

export interface SeedRefusal {
  email: string;
  reason: SeedRefusalReason;
  detalhe?: string;
}

/** Entrada a escrever no store, já com a chave que o caller deve usar. */
export interface SeedPlannedEntry {
  /** Chave do mapa `entries` — o id do Kit, em string. */
  key: string;
  subscription_id: string;
  email: string;
  status_detectado: string;
  /** Epoch SEGUNDOS, derivado do `created_at` ISO do Kit. */
  created_at: number;
  email1_sent_at: string | null;
  seeded_by: string;
}

/**
 * O tipo TUPLA VAZIA (`[]`) nos campos cruzados não é decoração: um
 * `SeedPlannedEntry[]` de comprimento arbitrário **não é atribuível** a `[]`,
 * então `return { ok: false, entries: <array não vazio>, ... }` não compila.
 * É o compilador, e não convenção, garantindo o invariante que sustenta o
 * tudo-ou-nada — "recusou ⇒ nada a escrever" e "aprovou ⇒ nada a recusar".
 */
export type SeedPlan =
  | { ok: true; entries: SeedPlannedEntry[]; refusals: [] }
  | { ok: false; entries: []; refusals: SeedRefusal[] };

/** Normaliza para comparação: trim + minúsculas. Não valida formato. */
export function normalizeSeedEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Converte o `created_at` ISO do Kit em epoch SEGUNDOS — a base que
 * `OnboardingEntry.created_at` usa para calcular D+3 e D+10.
 *
 * Devolve `null` para data inválida; o caller trata como recusa, nunca
 * como zero (um `created_at: 0` faria D+3 e D+10 vencerem imediatamente,
 * disparando e-mail 2 e 3 no mesmo instante).
 */
export function isoToEpochSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Decide o que semear. Puro: nada de rede, nada de disco, nada de relógio.
 *
 * Aborta com `ok: false` na PRIMEIRA lista de recusas — todas as recusas
 * são reportadas juntas (não só a primeira), para o operador corrigir a
 * lista de uma vez em vez de descobrir um problema por rodada.
 */
export function planSeed(input: SeedInput): SeedPlan {
  const refusals: SeedRefusal[] = [];
  const entries: SeedPlannedEntry[] = [];

  // O `created_at` vindo do Kit já é validado por e-mail lá embaixo; este
  // valor vem do OPERADOR e não tinha guard nenhum (achado do review da PR
  // #7683). Data malformada não quebra o agendamento (D+3/D+10 saem de
  // `created_at`), mas corrompe justamente o registro de auditoria que este
  // campo existe pra ser.
  if (input.seedEmail1SentAt != null && isoToEpochSeconds(input.seedEmail1SentAt) == null) {
    return {
      ok: false,
      entries: [],
      refusals: [
        {
          email: "",
          reason: "seed_email1_sent_at_invalido",
          detalhe: `não é uma data ISO parseável: ${JSON.stringify(input.seedEmail1SentAt)}`,
        },
      ],
    };
  }

  if (input.seededBy.trim() === "") {
    // Recusa de lista inteira, não por e-mail: sem origem, nenhuma entrada
    // é auditável depois. Reportada uma vez, com o e-mail vazio.
    return { ok: false, entries: [], refusals: [{ email: "", reason: "seeded_by_ausente" }] };
  }

  const vistos = new Set<string>();
  for (const raw of input.emails) {
    const email = normalizeSeedEmail(raw);
    if (email === "") continue;

    if (vistos.has(email)) {
      refusals.push({ email, reason: "duplicado_na_lista" });
      continue;
    }
    vistos.add(email);

    const existing = input.existingByEmail.get(email);
    if (existing) {
      // Nunca semear por cima. Se o e-mail 1 já saiu, semear de novo
      // reenviaria boas-vindas a quem já recebeu (#6043 em miniatura); se
      // não saiu, a entrada já está na fila normal e semear é redundante.
      refusals.push({
        email,
        reason: "ja_no_store",
        detalhe:
          existing.email1_sent_at == null
            ? "entrada já existe, e-mail 1 ainda pendente pelo caminho normal"
            : `e-mail 1 já enviado em ${existing.email1_sent_at}`,
      });
      continue;
    }

    const kit = input.kitByEmail.get(email);
    if (!kit) {
      refusals.push({ email, reason: "nao_encontrado_no_kit" });
      continue;
    }
    if (kit.state !== "active") {
      refusals.push({ email, reason: "estado_nao_active", detalhe: `state=${kit.state}` });
      continue;
    }
    const createdAt = isoToEpochSeconds(kit.created_at);
    if (createdAt == null) {
      refusals.push({
        email,
        reason: "nao_encontrado_no_kit",
        detalhe: `created_at inválido: ${JSON.stringify(kit.created_at)}`,
      });
      continue;
    }

    // Segunda checagem de duplicata, por CHAVE do store — pega quem trocou
    // de e-mail no Kit e ficaria invisível à busca por e-mail acima. Sem
    // isto, o write sobrescreveria o histórico e a pessoa receberia os 3
    // e-mails de novo (ver docstring de `existingById`).
    const porId = input.existingById.get(String(kit.id));
    if (porId) {
      refusals.push({
        email,
        reason: "ja_no_store",
        detalhe:
          `id ${kit.id} já está no store sob o e-mail ${porId.email}` +
          (porId.email1_sent_at ? ` (e-mail 1 enviado em ${porId.email1_sent_at})` : " (e-mail 1 pendente)") +
          " — provável troca de endereço no Kit; semear sobrescreveria o histórico",
      });
      continue;
    }

    entries.push({
      key: String(kit.id),
      subscription_id: String(kit.id),
      email,
      status_detectado: kit.state,
      created_at: createdAt,
      email1_sent_at: input.seedEmail1SentAt,
      seeded_by: input.seededBy,
    });
  }

  if (refusals.length > 0) return { ok: false, entries: [], refusals };
  return { ok: true, entries, refusals: [] };
}

/**
 * Render do plano para o operador CONFERIR antes de qualquer escrita.
 *
 * Imprime a lista NOMINAL, nunca só a contagem: "31 destinatários" não é
 * verificável por um humano, os 31 endereços são. O #6043 teria sido pego
 * exatamente aqui — o recorte errado era invisível num total.
 */
export function renderSeedPlan(plan: SeedPlan, opts: { send: boolean; seededBy: string }): string {
  const linhas: string[] = [];
  if (!plan.ok) {
    linhas.push(`[onboarding:seed] ABORTADO — ${plan.refusals.length} recusa(s), nenhuma entrada escrita:`);
    for (const r of plan.refusals) {
      linhas.push(`  - ${r.email || "(lista)"}: ${r.reason}${r.detalhe ? ` (${r.detalhe})` : ""}`);
    }
    return linhas.join("\n");
  }
  const modo = opts.send ? "GRAVANDO" : "dry-run (nada é escrito sem --send)";
  linhas.push(`[onboarding:seed] ${modo} — ${plan.entries.length} entrada(s), origem ${opts.seededBy}:`);
  for (const e of plan.entries) {
    const e1 = e.email1_sent_at ? `e-mail 1 marcado como enviado em ${e.email1_sent_at}` : "e-mail 1 PENDENTE (sai na próxima rodada)";
    linhas.push(`  - ${e.email} · kit=${e.subscription_id} · ${e1}`);
  }
  return linhas.join("\n");
}
