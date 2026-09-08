/**
 * scripts/lib/mensal/monthly-apoiadores-state.ts (#4521)
 *
 * Idempotência/dedup do envio extra Beehiiv pra apoiadores Mantenedor/Patrono
 * (#4482, render em `scripts/render-monthly-beehiiv.ts`) — ponto explicitamente
 * deixado em aberto pelo #4482 ("Escopo atual: só o primeiro envio, semi-manual")
 * e cobrado pela questão 3 do #4521: "registrar em algum estado... que a
 * edição X já foi enviada pros apoiadores, pra a skill não reenviar a mesma
 * edição 2x se rodada de novo."
 *
 * ## Por que não existe um estado "sent" automático
 *
 * Este módulo hoje serve DOIS consumidores com disciplina de escrita
 * diferente — não generalizar a frase abaixo pro módulo inteiro:
 *
 *   - `send-monthly-apoiadores.ts` (Passo 1/3) NUNCA chama a API de escrita
 *     de nenhum ESP (guard de publicação, #4521 "Restrições invioláveis" +
 *     regra 1 de `context/overnight-dispatch-rules.md`) — o envio real
 *     continua manual (Custom HTML paste + Audience tab + Schedule, mesmo
 *     fluxo do #4482).
 *   - `publish-monthly-apoiadores-brevo.ts` (Passo 2, #4572/#4593) chama a
 *     API de escrita da Brevo DE VERDADE (`POST /emailCampaigns`) pra criar
 *     a campanha — sempre como RASCUNHO, nunca agenda/envia sozinho. Este
 *     módulo é quem dá a idempotência dessa escrita (`brevoCampaignId`
 *     abaixo), justamente porque ela é real.
 *
 * Por isso o ciclo de vida tem 2 estados, não 1:
 *
 *   1. `draft_prepared` — HTML renderizado localmente (`renderMonthlyBeehiivEmail`),
 *      NADA foi enviado ainda. Rodar de novo nesse estado é seguro/idempotente
 *      (só regenera o HTML — reflete qualquer edição do `draft.md` desde a
 *      última preparação).
 *   2. `sent` — o EDITOR confirmou manualmente, via `--mark-sent`, que de fato
 *      enviou pela UI (Beehiiv originalmente; desde #4572/#4593 o mesmo
 *      `--mark-sent` também confirma o envio real pela UI da Brevo — o
 *      campo é channel-agnostic, só o texto desta docstring ficou preso à
 *      origem histórica). Este módulo não tem como observar isso sozinho
 *      (não há webhook/poll da campanha real aqui) — é uma decisão humana
 *      registrada, não inferida.
 *
 * O dedup real (#4521 questão 3) age na transição `sent → prepare de novo`:
 * bloqueada por padrão (`decidePrepareAction`), destravável com `--force`
 * pra cobrir o caso legítimo "preciso reenviar uma correção".
 *
 * Fail-soft por design (mesmo padrão de `clarice-novos-state.ts`/
 * `clarice-envio-enabled.ts`): leitura tolerante — arquivo ausente/corrompido/
 * shape inesperado vira `null` ("nunca preparado"), nunca lança. Desde
 * #4572/#4593 (guard de idempotência do Passo 2 Brevo, ver `brevoCampaignId`
 * abaixo) essa tolerância tem uma consequência nova: um state file que
 * EXISTIA mas ficou corrompido/malformado é indistinguível de "nunca
 * preparado" pro caller, o que reabriria a janela de campanha Brevo
 * duplicada que o guard existe pra fechar. `readApoiadoresState` continua
 * retornando `null` nesse caso (não muda o contrato — mudar pra fail-closed
 * afetaria também o dedup legado do Passo 1, que é propositalmente tolerante
 * e de baixo risco), mas agora emite um aviso em stderr quando o arquivo
 * EXISTE e falha ao ser lido/parseado (diferente de simplesmente ausente,
 * que é silencioso e esperado) — visibilidade mínima pro operador notar
 * antes de confiar cegamente num "nunca preparado" que na verdade é "não
 * consegui ler o que já existia".
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";

export type ApoiadoresSendStatus = "draft_prepared" | "sent";

export interface ApoiadoresState {
  cycle: string;
  status: ApoiadoresSendStatus;
  /** ISO timestamp da última vez que o HTML foi (re)gerado. */
  preparedAt: string;
  /** ISO timestamp de quando o editor confirmou o envio real (`--mark-sent`). `null` enquanto `status !== "sent"`. */
  sentAt: string | null;
  /** Path absoluto do HTML gerado (`_internal/beehiiv-preview.html`). */
  htmlPath: string;
  subject: string;
  /** Nomes dos segmentos/listas do ESP usados como audiência (auditoria — não reconstrói do zero em cada leitura; legado do fluxo Beehiiv original, hoje também usado pela lista Brevo dedicada). */
  segments: string[];
  /**
   * Id da campanha Brevo real criada por `scripts/publish-monthly-apoiadores-brevo.ts`
   * (Passo 2, #4572/#4593) — `null` enquanto nenhuma campanha Brevo foi criada
   * pra este ciclo (inclui todo state legado do fluxo Beehiiv, que nunca setava
   * este campo). Guard de idempotência do Passo 2 (`decidePublishBrevoAction`):
   * uma vez não-null, uma nova invocação sem `--force` é bloqueada — fecha o
   * "Gap conhecido" do SKILL.md (rodar o Passo 2 2x criava DOIS rascunhos
   * duplicados na Brevo, sem essa trava).
   */
  brevoCampaignId: number | null;
  /**
   * Id do broadcast Kit real criado por `scripts/publish-monthly-apoiadores-kit.ts`
   * (Passo 2 do canal ATUAL, #7633) — `null` enquanto nenhum broadcast Kit foi
   * criado pra este ciclo (inclui todo state legado dos fluxos Beehiiv/Brevo,
   * que nunca setavam este campo). Guard de idempotência do Passo 2 Kit
   * (`decidePublishKitAction`), gêmeo do `brevoCampaignId` acima.
   *
   * Os dois campos coexistem de propósito em vez de um campo genérico
   * `campaignId`: durante a transição um mesmo ciclo pode ter registro dos
   * dois canais, e colapsá-los faria o guard de um canal bloquear o outro (ou,
   * pior, um `--force` num canal apagar o rastro do rascunho órfão do outro).
   * Quando `brevo_apoiadores` for aposentado de vez (depois do 1º envio Kit
   * real, ver #7633), o campo Brevo pode virar só leitura de histórico.
   */
  kitBroadcastId: number | null;
  /**
   * Resultado da RELEITURA pós-criação do broadcast Kit (#7633, achado do
   * silent-failure-hunter): `true` = `GET /v4/broadcasts/{id}` devolveu um
   * `subscriber_filter` igual ao enviado; `false` = divergiu (a API aceitou
   * 2xx sem aplicar o filtro certo — broadcast criado com audiência ERRADA,
   * possivelmente a base inteira); `null` = não confirmável (a releitura
   * falhou, ou não ecoou o campo) ou o broadcast nem foi criado por este
   * canal.
   *
   * Existe porque o 2xx da criação não é prova de que o filtro pegou —
   * mesma disciplina de `kit-diaria-stage5-dispatch.ts` (#6582), o canal
   * irmão de mesmo perfil de risco. `false` é registro de INCIDENTE, não
   * estado normal: significa que existe um rascunho no Kit cuja audiência
   * precisa ser conferida à mão antes de qualquer disparo.
   */
  kitAudienceVerified: boolean | null;
}

/** Nome do arquivo de estado, sob `_internal/` do ciclo — mesma convenção de `05-published.json`/`06-social-published.json`. */
const STATE_FILENAME = "beehiiv-apoiadores-state.json";

/** Path do state file para um `monthlyDir` já resolvido (`monthlyDir(cycle)` de `monthly-paths.ts`). */
export function apoiadoresStatePath(monthlyDir: string): string {
  return resolve(monthlyDir, "_internal", STATE_FILENAME);
}

/**
 * Lê o state file. Tolerante: ausente/corrompido/shape inesperado → `null`
 * (nunca lança) — "nunca preparado". Arquivo AUSENTE é o caso esperado
 * (silencioso, sem log — todo ciclo começa assim). Arquivo PRESENTE mas
 * ilegível/malformado é anômalo (corrupção, escrita concorrente truncada,
 * edição manual quebrada) — emite um aviso em stderr antes de retornar
 * `null`, pra não mascarar silenciosamente um estado real perdido (ver
 * docstring do módulo, #4572/#4593: essa perda agora pode reabrir a janela
 * de campanha Brevo duplicada que o guard de idempotência existe pra fechar).
 */
export function readApoiadoresState(monthlyDir: string): ApoiadoresState | null {
  const path = apoiadoresStatePath(monthlyDir);
  if (!existsSync(path)) return null;
  const warn = (reason: string) =>
    process.stderr.write(
      `[monthly-apoiadores-state] AVISO: ${path} existe mas ${reason} — tratando como "nunca preparado" ` +
        "(fail-soft), mas isso pode mascarar um brevoCampaignId ou status 'sent' já gravado. Confira o arquivo " +
        "manualmente antes de rodar de novo qualquer um dos 3 scripts que leem este state — " +
        "send-monthly-apoiadores.ts (Passo 1/3) ou publish-monthly-apoiadores-brevo.ts (Passo 2).\n",
    );
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ApoiadoresState>;
    if (typeof parsed.cycle !== "string" || typeof parsed.preparedAt !== "string") {
      warn("tem shape inesperado (cycle/preparedAt ausente ou não-string)");
      return null;
    }
    if (parsed.status !== "draft_prepared" && parsed.status !== "sent") {
      warn(`tem status inválido ("${String(parsed.status)}")`);
      return null;
    }
    return {
      cycle: parsed.cycle,
      status: parsed.status,
      preparedAt: parsed.preparedAt,
      sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : null,
      htmlPath: typeof parsed.htmlPath === "string" ? parsed.htmlPath : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      segments: Array.isArray(parsed.segments) ? parsed.segments.filter((s): s is string => typeof s === "string") : [],
      brevoCampaignId: typeof parsed.brevoCampaignId === "number" ? parsed.brevoCampaignId : null,
      kitBroadcastId: typeof parsed.kitBroadcastId === "number" ? parsed.kitBroadcastId : null,
      kitAudienceVerified: typeof parsed.kitAudienceVerified === "boolean" ? parsed.kitAudienceVerified : null,
    };
  } catch (e) {
    warn(`não pôde ser lido/parseado como JSON (${(e as Error).message})`);
    return null;
  }
}

/** Escreve o state file (escrita atômica, mesmo padrão do resto do projeto). Cria `_internal/` se faltar. */
export function writeApoiadoresState(monthlyDir: string, state: ApoiadoresState): void {
  mkdirSync(resolve(monthlyDir, "_internal"), { recursive: true });
  writeFileAtomic(apoiadoresStatePath(monthlyDir), JSON.stringify(state, null, 2) + "\n");
}

export type PrepareDecision = { action: "prepare" } | { action: "blocked"; reason: string };

/**
 * Pura/testável: decide se `send-monthly-apoiadores.ts` (sem `--mark-sent`)
 * pode prosseguir a preparar/regenerar o HTML.
 *
 *   - Sem estado prévio, ou `status === "draft_prepared"` → sempre permitido
 *     (idempotente/inofensivo — só regenera o HTML a partir do `draft.md`
 *     atual, nunca envia nada).
 *   - `status === "sent"` sem `--force` → BLOQUEADO (dedup real, #4521
 *     questão 3): evita reprocessar/reabrir o fluxo de uma edição já
 *     confirmada como enviada por engano.
 *   - `status === "sent"` com `--force` → permitido (caso legítimo: reenviar
 *     uma correção).
 */
export function decidePrepareAction(state: ApoiadoresState | null, force: boolean): PrepareDecision {
  if (state?.status === "sent" && !force) {
    return {
      action: "blocked",
      reason:
        `Ciclo ${state.cycle} já foi marcado como ENVIADO pros apoiadores em ${state.sentAt}. ` +
        "Rodar de novo sem --force é bloqueado pra não reabrir por engano o fluxo de uma edição já confirmada " +
        "como enviada. Use --force se realmente precisa gerar o HTML de novo (ex: reenviar uma correção).",
    };
  }
  return { action: "prepare" };
}

/**
 * Pura/testável: monta o `ApoiadoresState` gravado após um `prepare`
 * bem-sucedido (`renderMonthlyBeehiivEmail` já rodou). Deliberadamente NÃO
 * recebe o state ANTERIOR — `sentAt` é sempre `null` aqui, nunca herdado.
 *
 * #4521 self-review: a 1ª versão deste script fazia `sentAt: state?.sentAt
 * ?? null` (herdava o `sentAt` do state anterior), o que violava o próprio
 * contrato de `ApiadoresState.sentAt` ("null enquanto status !== 'sent'")
 * no caso `--force` sobre um ciclo já `sent`: o registro virava um
 * `draft_prepared` com uma data de envio antiga carimbada — contraditório, e
 * perigoso pra qualquer consumidor futuro que checasse `sentAt` em vez de
 * `status` pra decidir "já foi enviado" (leria "sim" mesmo depois do
 * `--force` reabrir o ciclo pra uma correção). Extraído como função pura
 * pra travar esse contrato com teste, em vez de confiar em revisão visual da
 * linha inline no `main()`.
 *
 * `previousChannelIds` (#4572/#4593 pro Brevo, #7633 pro Kit) é a exceção
 * deliberada ao "não recebe o state anterior" — e o critério pra entrar nela
 * é específico, não "já existe exceção, então tudo bem": só FATO MONOTÔNICO,
 * nunca valor derivado do `status`. Passo 1 (este `prepare`) e Passo 2
 * (`publish-monthly-apoiadores-kit.ts`, ou o `-brevo.ts` legado) escrevem no
 * MESMO state file — sem repassar esses ids, rodar o Passo 1 depois do Passo
 * 2 apagaria o registro de que já existe campanha/broadcast criado pro ciclo,
 * reabrindo a janela do "Gap conhecido" do SKILL.md (2 rascunhos duplicados
 * no ESP). Diferente de `sentAt` (que É derivado do `status` e por isso pode
 * ficar contraditório numa transição), estes campos são passados por VALOR:
 * registram um fato ("esse rascunho já existe") que continua verdadeiro
 * independente do que o Passo 1 faz.
 *
 * #7633: o parâmetro virou OBJETO (era o número solto `previousBrevoCampaignId`)
 * quando o 2º id apareceu — dois `number | null` posicionais seguidos são
 * exatamente a assinatura em que trocar a ordem por engano compila e grava o
 * id do canal errado, num campo cuja função é justamente impedir duplicata.
 */
export function buildPreparedState(
  cycle: string,
  preparedAt: string,
  htmlPath: string,
  subject: string,
  segments: readonly string[],
  previousChannelIds: {
    brevoCampaignId?: number | null;
    kitBroadcastId?: number | null;
    kitAudienceVerified?: boolean | null;
  } = {},
): ApoiadoresState {
  return {
    cycle,
    status: "draft_prepared",
    preparedAt,
    sentAt: null,
    htmlPath,
    subject,
    segments: [...segments],
    brevoCampaignId: previousChannelIds.brevoCampaignId ?? null,
    kitBroadcastId: previousChannelIds.kitBroadcastId ?? null,
    // Fato do broadcast que já existe, não deste `prepare` — nunca "melhora"
    // sozinho: um re-prepare não re-verifica audiência nenhuma, então
    // sobrescrever um `false` aqui apagaria o registro de um incidente real.
    kitAudienceVerified: previousChannelIds.kitAudienceVerified ?? null,
  };
}

export type MarkSentDecision =
  // `state` vai junto no branch "mark" (#4521 self-review) — o caller
  // (`send-monthly-apoiadores.ts`) precisava de um `state as ApoiadoresState`
  // pra montar o update, mesmo já tendo checado `decision.action === "mark"`;
  // TS não correlaciona automaticamente o discriminante de `MarkSentDecision`
  // com a nulidade do `state` passado como argumento separado. Devolver o
  // state (não-null, garantido pelo próprio branch) no resultado elimina o
  // cast no call site.
  | { action: "mark"; state: ApoiadoresState }
  | { action: "noop"; reason: string }
  | { action: "error"; reason: string };

/**
 * Pura/testável: decide o efeito de `--mark-sent` (confirmação manual do
 * editor de que o envio real já aconteceu pela UI do ESP — Beehiiv
 * originalmente; hoje Brevo, #4572/#4593. O campo é channel-agnostic).
 *
 *   - Sem estado (`prepare` nunca rodou) → erro: não há o que marcar como
 *     enviado, e marcar sem um `htmlPath`/`subject` reais deixaria o estado
 *     inconsistente.
 *   - `status === "sent"` → noop (idempotente — já estava marcado; não é erro
 *     rodar `--mark-sent` 2x por engano).
 *   - `status === "draft_prepared"` → `mark` (transição válida).
 */
export function decideMarkSentAction(state: ApoiadoresState | null): MarkSentDecision {
  if (!state) {
    return {
      action: "error",
      reason:
        "Nenhum draft preparado ainda pra este ciclo. Rode sem --mark-sent primeiro " +
        "(gera o HTML e grava o estado 'draft_prepared'), depois de enviar de verdade pela UI do ESP " +
        "(Beehiiv originalmente; hoje Brevo, #4572/#4593), rode de novo com --mark-sent.",
    };
  }
  if (state.status === "sent") {
    return { action: "noop", reason: `Ciclo ${state.cycle} já estava marcado como enviado em ${state.sentAt} — nada a fazer.` };
  }
  return { action: "mark", state };
}

/**
 * Pura/testável: monta o `ApoiadoresState` gravado depois de um `--mark-sent`
 * bem-sucedido (transição `draft_prepared -> sent`, `decideMarkSentAction`
 * já validou que `state.status !== "sent"`). Extraída do que era um object
 * spread inline em `send-monthly-apoiadores.ts::main()`
 * (`{ ...decision.state, status: "sent", sentAt: ... }`) — mesma disciplina
 * que este módulo já cobra de si mesmo (`buildPreparedState`,
 * `buildApoiadoresBrevoPublishedState`): construir `ApoiadoresState` só via
 * builder testado, nunca ad hoc no `main()` de um script (o bug histórico do
 * #4521 self-review, documentado acima em `buildPreparedState`, é exatamente
 * o tipo de erro que um spread inline sem teste pode reintroduzir). Preserva
 * TODOS os campos de `state` por spread — inclusive `brevoCampaignId`
 * (#4572/#4593): marcar um ciclo como enviado não apaga o registro de que
 * uma campanha Brevo foi criada pra ele.
 */
export function buildSentState(state: ApoiadoresState, sentAt: string): ApoiadoresState {
  return { ...state, status: "sent", sentAt };
}

// ─────────────────────────────────────────────────────────────────────────
// #4572/#4593 — guard de idempotência Passo 1 ↔ Passo 2 (fecha o "Gap
// conhecido" do SKILL.md: `publish-monthly-apoiadores-brevo.ts` criava uma
// campanha Brevo real sem consultar nem gravar este state file, então rodar
// o Passo 2 2x pro mesmo ciclo criava DOIS rascunhos duplicados na Brevo).
// ─────────────────────────────────────────────────────────────────────────

export type PublishBrevoDecision = { action: "create" } | { action: "blocked"; reason: string };

/**
 * Pura/testável: decide se `publish-monthly-apoiadores-brevo.ts` (Passo 2)
 * pode criar uma campanha Brevo nova pra este ciclo. Dois motivos de bloqueio
 * independentes, cada um com `--force` como escape hatch explícito (mesma
 * disciplina de `decidePrepareAction`):
 *
 *   1. `status === "sent"` — ciclo já confirmado como enviado (`--mark-sent`,
 *      Passo 3). Criar outra campanha pra um ciclo já enviado é bloqueado por
 *      padrão (mesmo racional do dedup do Passo 1).
 *   2. `brevoCampaignId != null` — já existe uma campanha Brevo criada pra
 *      este ciclo (Passo 2 já rodou com sucesso antes), rascunho ou não. Sem
 *      este guard, rodar o Passo 2 de novo cria um 2º rascunho duplicado na
 *      Brevo (ruído no painel, não um blast radius alto — ambos exigem ação
 *      manual do editor pra sair de rascunho — mas é exatamente o gap que o
 *      SKILL.md documentava como aceito/não resolvido).
 *
 * `force: true` ignora os dois — mesmo `--force` que a skill já expõe
 * (SKILL.md `--force`), não introduz uma 2ª flag.
 */
export function decidePublishBrevoAction(state: ApoiadoresState | null, force: boolean): PublishBrevoDecision {
  if (force) return { action: "create" };
  if (state?.status === "sent") {
    return {
      action: "blocked",
      reason:
        `Ciclo ${state.cycle} já foi marcado como ENVIADO pros apoiadores em ${state.sentAt}. ` +
        "Criar uma nova campanha Brevo pra um ciclo já confirmado como enviado é bloqueado por padrão " +
        "(mesmo dedup do Passo 1). Use --force se realmente precisa (ex: reenviar uma correção).",
    };
  }
  if (state?.brevoCampaignId != null) {
    return {
      action: "blocked",
      reason:
        `Já existe uma campanha Brevo criada pro ciclo ${state.cycle} (id ${state.brevoCampaignId}, criada em ` +
        `${state.preparedAt}) — rodar de novo sem --force criaria um 2º rascunho duplicado na Brevo. Confira o ` +
        "painel Brevo (Campaigns → Drafts); use --force se realmente precisa criar outro.",
    };
  }
  return { action: "create" };
}

/**
 * Pura/testável: monta o `ApoiadoresState` gravado após o Passo 2 criar a
 * campanha Brevo com sucesso. Sempre `status: "draft_prepared"`/`sentAt:
 * null` — mesma filosofia de `buildPreparedState` (nunca herdar `sentAt`):
 * mesmo que `previous?.status === "sent"` (só alcançável aqui via `--force`,
 * ver `decidePublishBrevoAction`), a campanha recém-criada é NOVA e ainda não
 * foi enviada, então o estado correto é "preparado, não enviado" — não a data
 * de envio antiga carimbada por cima de um rascunho diferente.
 */
export function buildApoiadoresBrevoPublishedState(
  previous: ApoiadoresState | null,
  cycle: string,
  preparedAt: string,
  htmlPath: string,
  subject: string,
  brevoCampaignId: number,
): ApoiadoresState {
  return {
    cycle,
    status: "draft_prepared",
    preparedAt,
    sentAt: null,
    htmlPath,
    subject,
    segments: previous?.segments ?? [],
    brevoCampaignId,
    // #7633: preserva o id do OUTRO canal — mesmo motivo de `buildPreparedState`
    // repassar os ids (fato monotônico), e o único jeito de o rascunho Kit de um
    // ciclo não sumir do registro se alguém rodar o publisher Brevo legado depois.
    kitBroadcastId: previous?.kitBroadcastId ?? null,
    kitAudienceVerified: previous?.kitAudienceVerified ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// #7633 — mesmos 2 guards, canal Kit (`publish-monthly-apoiadores-kit.ts`).
// Gêmeos deliberados dos de Brevo acima em vez de uma função genérica
// parametrizada pelo canal: as mensagens de bloqueio citam o painel e o
// vocabulário certos ("broadcast"/"Broadcasts" no Kit, "campanha"/"Drafts" na
// Brevo), e é justamente a mensagem que o operador lê pra decidir o que fazer.
// ─────────────────────────────────────────────────────────────────────────

export type PublishKitDecision = { action: "create" } | { action: "blocked"; reason: string };

/**
 * Pura/testável: decide se `publish-monthly-apoiadores-kit.ts` (Passo 2) pode
 * criar um broadcast Kit novo pra este ciclo. Mesmos 2 motivos de bloqueio de
 * `decidePublishBrevoAction`, lidos do campo do PRÓPRIO canal:
 *
 *   1. `status === "sent"` — ciclo já confirmado como enviado (`--mark-sent`).
 *   2. `kitBroadcastId != null` — já existe broadcast criado pra este ciclo.
 *
 * `brevoCampaignId` de um ciclo antigo NÃO bloqueia aqui, de propósito: um
 * rascunho órfão no ESP anterior (que nunca enviou nada, #7633) não é motivo
 * pra impedir o envio real pelo canal atual.
 *
 * `force: true` ignora os dois.
 */
export function decidePublishKitAction(state: ApoiadoresState | null, force: boolean): PublishKitDecision {
  if (force) return { action: "create" };
  if (state?.status === "sent") {
    return {
      action: "blocked",
      reason:
        `Ciclo ${state.cycle} já foi marcado como ENVIADO pros apoiadores em ${state.sentAt}. ` +
        "Criar um novo broadcast Kit pra um ciclo já confirmado como enviado é bloqueado por padrão " +
        "(mesmo dedup do Passo 1). Use --force se realmente precisa (ex: reenviar uma correção).",
    };
  }
  if (state?.kitBroadcastId != null) {
    return {
      action: "blocked",
      reason:
        `Já existe um broadcast Kit criado pro ciclo ${state.cycle} (id ${state.kitBroadcastId}, criado em ` +
        `${state.preparedAt}) — rodar de novo sem --force criaria um 2º rascunho duplicado no Kit. Confira o ` +
        "painel do Kit (Broadcasts → Drafts); use --force se realmente precisa criar outro.",
    };
  }
  return { action: "create" };
}

/**
 * Pura/testável: monta o `ApoiadoresState` gravado depois do Passo 2 Kit criar
 * o broadcast com sucesso. Mesma filosofia de `buildApoiadoresBrevoPublishedState`
 * (nunca herdar `sentAt`; preservar `segments` e o id do outro canal).
 */
export function buildApoiadoresKitPublishedState(
  previous: ApoiadoresState | null,
  cycle: string,
  preparedAt: string,
  htmlPath: string,
  subject: string,
  kitBroadcastId: number,
  /** Resultado da releitura pós-criação (#7633) — ver `ApoiadoresState.kitAudienceVerified`.
   *  Default `null` ("não confirmável") em vez de `true`: um caller que
   *  esquecer de passar o resultado nunca deve produzir um registro que
   *  AFIRMA audiência verificada sem ninguém ter verificado nada. */
  kitAudienceVerified: boolean | null = null,
): ApoiadoresState {
  return {
    cycle,
    status: "draft_prepared",
    preparedAt,
    sentAt: null,
    htmlPath,
    subject,
    segments: previous?.segments ?? [],
    brevoCampaignId: previous?.brevoCampaignId ?? null,
    kitBroadcastId,
    kitAudienceVerified,
  };
}
