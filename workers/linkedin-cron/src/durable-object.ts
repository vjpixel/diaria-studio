import type { QueueEntry, ReelsContainerRef } from "./index";
import { CLAIM_TTL_MS, sameQueueContent } from "./index";
import { fireQueueEntry, pickReelsContainer, type InstagramCreds, type ThreadsCreds, type LinkedInCreds } from "./dispatch";

// ── LinkedInScheduler — Durable Object (#1168) ────────────────────────────

/**
 * Payload armazenado no DO storage, contendo tudo que alarm() precisa pra
 * disparar o post sem acesso ao KV ou ao env do Worker.
 */
export interface DoStoredPayload {
  key: string;               // KV key do item (usado em logs)
  entry: QueueEntry;         // entry completa (texto, webhook_target, action, channel, etc.)
  webhookUrl: string;        // MAKE_WEBHOOK_URL resolvido no momento do enqueue
  pixelWebhookUrl?: string;  // MAKE_PIXEL_WEBHOOK_URL (opcional)
  webhookApiKey?: string;    // #3903 — MAKE_WEBHOOK_API_KEY resolvido no momento do enqueue (opcional)
  // #3817 — credenciais Graph API do Instagram, capturadas no enqueue (o DO
  // não tem acesso a `env` no alarm() — só ao que foi persistido aqui).
  instagram?: InstagramCreds;
  // #10823 — mesmo racional, pra 2ª conta do Instagram (`ig_account: "vjpixel"`).
  instagramVjpixel?: InstagramCreds;
  // #3944 Parte B — mesmo racional acima, pra credenciais Threads.
  threads?: ThreadsCreds;
  // #8052 — mesmo racional acima, pra credenciais da API direta do LinkedIn
  // (só usadas pelo caminho carrossel, image_urls > 1).
  linkedin?: LinkedInCreds;
}

/**
 * LinkedInScheduler — Durable Object (#1168).
 * 1 instância por item de fila: `idFromName(queueKey)`.
 *
 * Design (1 DO por item vs 1 scheduler central):
 *   - 1 DO por item: alarme isolado, falha de 1 item não afeta outros, sem
 *     lógica de "re-arm pra próximo item mais cedo". Escolha adotada.
 *   - 1 scheduler central: 1 DO com alarm sempre no próximo item mais cedo;
 *     após fire, re-arm pro seguinte. Mais complexo; falha de 1 item pode
 *     bloquear o scheduler global.
 *
 * Fluxo:
 *   1. `handleEnqueue` chama DO via `/arm` com `DoStoredPayload`.
 *   2. DO persiste payload + chama `state.storage.setAlarm(scheduledAtMs)`.
 *   3. Em `scheduledAtMs`, CF invoca `alarm()`.
 *   4. `alarm()` chama `tryClaim()` DIRETAMENTE (sem self-fetch — #2230 bug 3).
 *   5. Se claim ganho: lê payload, dispara webhook Make.
 *   6. Se sucesso: grava `fired:true` + deleta `payload` do storage (#2230 bug 1).
 *      Com payload ausente E fired=true, qualquer alarm posterior via TTL expiry
 *      (claim re-claimado) não tem o quê postar.
 *   7. KV delete é feito pelo Worker cron path após confirmar `fired:true`;
 *      idempotência impede double-fire mesmo se alarm disparar mais de 1x.
 *
 * Idempotência (alarm + cron fallback):
 *   - DO armazena `fired:true` + deleta `payload` após fire bem-sucedido.
 *   - `fireDueItems` (cron path) consulta DO via `/status` antes de disparar
 *     item com `alarm_armed:true`. Se DO reporta `fired:true`, cron apenas
 *     deleta a KV entry sem re-disparar o webhook.
 *   - Sem acesso a DO (ex: DO destruído), cron dispara normalmente (fallback).
 *
 * Protocol interno (fetch ao DO):
 *   POST /arm     body: DoStoredPayload + { scheduledAtMs: number }
 *                 → persiste payload, agenda alarm, retorna { armed: true }
 *                 → 409 { armed: false, fired: true, send_unknown? } se o DO já disparou ou terminou ambíguo (#10992, #11238)
 *                 → 409 { armed: false, claiming: true } durante claim ativo (#11035)
 *                 → apaga `reels_container` se o conteúdo mudou (#11024)
 *   GET  /idem    → { queue_key: string | null } — só no DO-índice `idem:{uuid}` (#10992)
 *   POST /idem    body: { queue_key } → grava a queue key atual da chave idempotente
 *   POST /cancel  → cancela alarm, limpa storage (para DELETE /queue/:key)
 *                 → body { if_not_claiming: true }: 409 { cancelled: false, claiming: true } durante claim ativo (#11107)
 *                 → body { if_not_claiming: true }: 409 { cancelled: false, fired: true, send_unknown? } se já disparou/ambíguo (#11215, #11238)
 *                 → com replacement_token + replacement_entry, reserva claiming até /arm do dono ou /release-replacement (#11133)
 *   POST /release-replacement body: { replacement_token } → libera apenas a reserva correspondente
 *   GET  /status  → retorna { fired: boolean; claiming: boolean; claimed_at: number | null; send_unknown: string | null } (consultado por fireDueItems; send_unknown #11106)
 *   POST /claim   → check-and-set atômico de `claiming` dentro de
 *                   blockConcurrencyWhile. Retorna { claimed: boolean; entry?: QueueEntry }
 *                   (`entry` = payload armado, só com claimed=true, #11107).
 *                   `true` significa "este caller ganhou o claim e pode postar".
 *                   `false` significa "outro caller já está processando" — não postar.
 *                   Implementa exactly-once entre cron↔alarm (#2219 bug 2).
 *                   (#2230 bug 3) alarm() usa tryClaim() DIRETAMENTE — não via self-fetch.
 */

/**
 * #11238 — estado terminal de um DO: disparou (`fired`) ou terminou num envio
 * ambíguo (`send_unknown`, #11106). `null` = ainda pode disparar.
 *
 * Fonte única do critério para `/arm`, `/claim`, `tryClaim()` e `/cancel`:
 * cada um checava do seu jeito (só `/cancel` olhava `send_unknown`), e se
 * `send_unknown` passasse a ser gravado sem `fired` eles divergiriam — o
 * `/arm` re-armaria e o `/claim` entregaria o claim de um post que pode já
 * ter saído. `send_unknown` vem antes de `fired` no retorno: o chamador
 * precisa saber que o post PODE não ter saído (não é prova de publicação).
 */
export type FiredOrAmbiguous =
  | { kind: "send_unknown"; reason: string }
  | { kind: "fired" };

export async function firedOrAmbiguous(storage: Pick<DurableObjectStorage, "get">): Promise<FiredOrAmbiguous | null> {
  const sendUnknown = await storage.get<string>("send_unknown");
  if (sendUnknown !== undefined && sendUnknown !== null) return { kind: "send_unknown", reason: String(sendUnknown) };
  if ((await storage.get<boolean>("fired")) === true) return { kind: "fired" };
  return null;
}

export async function isFiredOrAmbiguous(storage: Pick<DurableObjectStorage, "get">): Promise<boolean> {
  return (await firedOrAmbiguous(storage)) !== null;
}

/** Corpo do 409 de `/arm`/`/cancel` para um DO terminal (#11238). */
function terminalConflictBody(state: FiredOrAmbiguous, base: Record<string, unknown>): string {
  return JSON.stringify({
    ...base,
    fired: true,
    ...(state.kind === "send_unknown" && { send_unknown: state.reason }),
  });
}

export class LinkedInScheduler {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * tryClaim — lógica de claim atômico chamada DIRETAMENTE pelo alarm() (#2230 bug 3).
   *
   * Evita nested `blockConcurrencyWhile` que ocorria quando alarm() chamava
   * `this.fetch('/claim')`, que internamente entrava em blockConcurrencyWhile.
   * Agora alarm() chama este método diretamente dentro de UM blockConcurrencyWhile.
   *
   * Reutiliza a mesma lógica do endpoint POST /claim (com TTL de claim expirado).
   * O endpoint POST /claim ainda existe para o cron path (fetch externo ao DO).
   */
  async tryClaim(): Promise<boolean> {
    return this.state.blockConcurrencyWhile(async () => {
      const alreadyClaiming = await this.state.storage.get<boolean>("claiming");
      if (await isFiredOrAmbiguous(this.state.storage)) return false; // #11238
      if (alreadyClaiming) {
        // Verificar se o claim expirou (crash mid-flight sem release)
        const claimedAt = await this.state.storage.get<number>("claimed_at");
        const claimExpired = claimedAt !== undefined && (Date.now() - claimedAt) > CLAIM_TTL_MS;
        if (!claimExpired) return false;
        // Claim expirado — logar e re-clamar
        console.warn(`[DO tryClaim] claim expired after ${Date.now() - (claimedAt ?? 0)}ms — re-claiming (crash recovery)`);
      }
      await this.state.storage.delete("replacement_token");
      await this.state.storage.put("claiming", true);
      await this.state.storage.put("claimed_at", Date.now());
      return true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/arm" && request.method === "POST") {
      const body = await request.json() as DoStoredPayload & { scheduledAtMs: number; replacement_token?: string };
      return this.state.blockConcurrencyWhile(async () => {
        // #10992 item 1: DO que já disparou não re-arma. O alarm novo sairia,
        // mas `tryClaim()` devolve false com `fired=true` e nada é publicado —
        // responder 200 aqui fazia o enqueue devolver 202 `alarm_armed: true`
        // para um post que nunca sai. 409 deixa o caller dizer isso ao cliente.
        // #11238 — mesmo critério de `/claim`/`/cancel` (`isFiredOrAmbiguous`).
        const terminal = await firedOrAmbiguous(this.state.storage);
        if (terminal !== null) {
          return new Response(terminalConflictBody(terminal, { armed: false }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        // #11035 — não alterar payload/container enquanto alarm ou cron dispara.
        // Mesmo TTL do claim: permite recuperar um processo interrompido.
        const claiming = await this.state.storage.get<boolean>("claiming");
        const claimedAt = await this.state.storage.get<number>("claimed_at");
        const ownsReplacement = body.replacement_token !== undefined &&
          body.replacement_token === await this.state.storage.get<string>("replacement_token");
        if (claiming && !ownsReplacement && (claimedAt === undefined || Date.now() - claimedAt <= CLAIM_TTL_MS)) {
          return new Response(JSON.stringify({ armed: false, claiming: true }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Persiste tudo que alarm() precisará — inclusive entry completa + webhook URLs
        const { scheduledAtMs, replacement_token: _token, ...payload } = body;
        // #11024 — o container de Reels guardado (#10922) pertence ao conteúdo
        // da tentativa anterior. Re-armar com conteúdo DIFERENTE (enqueue
        // idempotente `replaced`, #10917) e retomá-lo publicaria a legenda/vídeo
        // velhos — no alarm e no cron, que o recebe do /claim. Só sobrevive se o
        // payload anterior existe e publica a mesma coisa (re-arm do mesmo item).
        const previous = await this.state.storage.get<DoStoredPayload>("payload");
        if (!previous || !sameQueueContent(previous.entry, payload.entry)) {
          await this.state.storage.delete("reels_container");
        }
        await this.state.storage.put("payload", payload satisfies DoStoredPayload);
        await this.state.storage.delete("replacement_entry");
        // setAlarm sobrescreve alarm anterior — idempotente pra re-arm
        await this.state.storage.setAlarm(scheduledAtMs);
        if (ownsReplacement) {
          await this.state.storage.delete("replacement_token");
          await this.state.storage.delete("claiming");
          await this.state.storage.delete("claimed_at");
        }

        return new Response(JSON.stringify({ armed: true, scheduledAtMs }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      // #11107 — body opcional `{ if_not_claiming: true }`: recusa com 409
      // (mesmo critério do `/arm`, #11035) se um disparo está em andamento. O
      // enqueue de conteúdo mudado usa esse modo: checar `/status` e só depois
      // cancelar deixava o alarm/cron ganhar o `/claim` no meio, e o
      // `deleteAll` apagava o `claiming` dele — o `/arm` seguinte armava o
      // payload novo enquanto o disparo em curso publicava o velho. Sem o body
      // (DELETE /queue, limpeza de tombstone e fallback do `/status-set-fired`
      // no cron, que já segura o claim), o cancel segue incondicional.
      let ifNotClaiming = false;
      let replacementToken: string | undefined;
      let replacementEntry: QueueEntry | undefined;
      try {
        const body = (await request.json()) as { if_not_claiming?: unknown; replacement_token?: unknown; replacement_entry?: QueueEntry } | null;
        ifNotClaiming = body?.if_not_claiming === true;
        if (ifNotClaiming && typeof body?.replacement_token === "string" && body.replacement_entry) {
          replacementToken = body.replacement_token;
          replacementEntry = body.replacement_entry;
        }
      } catch { /* sem body = cancel incondicional */ }
      return this.state.blockConcurrencyWhile(async () => {
        if (ifNotClaiming) {
          // #11215 — mesmo critério do `/arm` (#10992 item 1): DO que já
          // disparou (`fired`) ou terminou ambíguo (`send_unknown`, #11106)
          // não é cancelado. O `deleteAll` apagaria esses marcadores, a
          // reserva (#11133) e o `/arm` seguinte armariam o conteúdo novo e
          // o slot sairia 2 vezes.
          // #11238 — o body leva `send_unknown` quando o envio foi ambíguo:
          // `fired: true` sozinho fazia o cliente ler "o post saiu".
          const terminal = await firedOrAmbiguous(this.state.storage);
          if (terminal !== null) {
            return new Response(terminalConflictBody(terminal, { cancelled: false }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            });
          }
          const claiming = await this.state.storage.get<boolean>("claiming");
          const claimedAt = await this.state.storage.get<number>("claimed_at");
          if (claiming && (claimedAt === undefined || Date.now() - claimedAt <= CLAIM_TTL_MS)) {
            return new Response(JSON.stringify({ cancelled: false, claiming: true }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        // deleteAll limpa payload + fired + claiming; deleteAlarm cancela o alarm.
        // Ordem: deleteAlarm primeiro pra evitar janela onde o alarm dispara mas
        // o storage ainda tem payload (risco baixo mas defensivo).
        await this.state.storage.deleteAlarm();
        await this.state.storage.deleteAll();
        // #11133 — reserva atômica: cron/alarm não podem reivindicar o KV velho
        // entre cancel e put/arm. TTL permite recuperar um enqueue interrompido.
        if (replacementToken !== undefined) {
          await this.state.storage.put("replacement_token", replacementToken);
          await this.state.storage.put("replacement_entry", replacementEntry);
          await this.state.storage.put("claiming", true);
          await this.state.storage.put("claimed_at", Date.now());
        }
        return new Response(JSON.stringify({ cancelled: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    }

    // Só o dono pode liberar a reserva; não libera um claim de cron/alarm.
    if (url.pathname === "/release-replacement" && request.method === "POST") {
      const body = await request.json() as { replacement_token?: string };
      return this.state.blockConcurrencyWhile(async () => {
        if (body.replacement_token !== undefined && body.replacement_token === await this.state.storage.get<string>("replacement_token")) {
          await this.state.storage.delete("replacement_token");
          await this.state.storage.delete("claiming");
          await this.state.storage.delete("claimed_at");
        }
        return new Response("{}", { status: 200 });
      });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const fired = (await this.state.storage.get<boolean>("fired")) ?? false;
      // (#2219 bug 6 fix) Expor `claiming` pra telemetria de crash-mid-flight.
      // Se claiming=true + fired=false, o cron pode detectar via /status que o alarm
      // travou no meio — logar DLQ-style error pra investigação do editor.
      const claiming = (await this.state.storage.get<boolean>("claiming")) ?? false;
      const claimedAt = await this.state.storage.get<number>("claimed_at");
      // #11106 — motivo do envio ambíguo gravado pelo alarm (o DO não escreve
      // no KV): o cron move a entry pra DLQ com esse `last_error`.
      const sendUnknown = (await this.state.storage.get<string>("send_unknown")) ?? null;
      return new Response(JSON.stringify({ fired, claiming, claimed_at: claimedAt ?? null, send_unknown: sendUnknown }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /claim — check-and-set atômico pra exactly-once entre cron↔alarm.
    // (#2219 bug 2) O DO event loop serializa tudo, então blockConcurrencyWhile
    // garante que 2 callers concorrentes (alarm + cron) não ganhem o claim
    // simultaneamente. O 1º que chegar seta `claiming:true` + `claimed_at` e
    // retorna { claimed: true }. O 2º lê `claiming:true` e retorna { claimed: false }.
    //
    // (#2219 bug 2 fix) Claim com TTL: se `claimed_at` é mais antigo que
    // CLAIM_TTL_MS, o claim é considerado expirado e pode ser re-claimado.
    // Isso evita que um DO fique travado permanentemente se `/release-claim`
    // falhar transitoriamente (ex: CF retry de alarm sem release prévio).
    if (url.pathname === "/claim" && request.method === "POST") {
      const claimed = await this.state.blockConcurrencyWhile(async () => {
        const alreadyClaiming = await this.state.storage.get<boolean>("claiming");
        if (await isFiredOrAmbiguous(this.state.storage)) return false; // #11238
        if (alreadyClaiming) {
          // Verificar se o claim expirou (crash mid-flight sem release)
          const claimedAt = await this.state.storage.get<number>("claimed_at");
          const claimExpired = claimedAt !== undefined && (Date.now() - claimedAt) > CLAIM_TTL_MS;
          if (!claimExpired) return false;
          // Claim expirado — logar e re-clamar
          console.warn(`[DO claim] claim expired after ${Date.now() - (claimedAt ?? 0)}ms — re-claiming (crash recovery)`);
        }
        await this.state.storage.delete("replacement_token");
        await this.state.storage.put("claiming", true);
        await this.state.storage.put("claimed_at", Date.now());
        return true;
      });
      // #10922 — quem ganhou o claim recebe o container de Reels que o alarm
      // deixou em processamento (o cron lê a entry do KV, que não o tem).
      const reelsContainer = claimed ? (await this.state.storage.get<ReelsContainerRef>("reels_container")) ?? null : null;
      // #11107 — e a entry do payload armado (strongly consistent, ao contrário
      // do KV): o cron compara com a cópia do KV que leu ANTES do claim e não
      // dispara se um re-enqueue trocou o conteúdo nesse meio-tempo.
      // #11133 — após TTL/crash ou falha do /arm, a entry da substituição
      // continua sendo a referência forte: KV velho nunca pode ser disparado.
      const armedEntry = claimed ? (await this.state.storage.get<DoStoredPayload>("payload"))?.entry
        ?? (await this.state.storage.get<QueueEntry>("replacement_entry")) ?? null : null;
      return new Response(JSON.stringify({
        claimed,
        ...(reelsContainer && { reels_container: reelsContainer }),
        ...(armedEntry && { entry: armedEntry }),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /reels-container — #10922: o cron sincroniza o container de Reels
    // depois de uma falha (body `{ reels_container: ReelsContainerRef | null }`;
    // null apaga). Sem isso o DO devolveria no próximo /claim um container que
    // o cron já descartou (expirado).
    if (url.pathname === "/reels-container" && request.method === "POST") {
      const body = (await request.json()) as { reels_container?: ReelsContainerRef | null };
      if (body.reels_container) await this.state.storage.put("reels_container", body.reels_container);
      else await this.state.storage.delete("reels_container");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /status-set-fired — cron path seta fired=true + limpa claiming + payload após
    // fire bem-sucedido. Permite que o DO saiba que o cron disparou, evitando
    // que o alarm() tente re-disparar em CF retry.
    // (#2230 bug 1 fix) Deleta também o `payload` para consistência com o alarm path:
    // mesmo que o alarm() seja re-invocado (TTL+claim expirado), sem payload não há o
    // quê postar — segunda linha de defesa contra double-post.
    if (url.pathname === "/status-set-fired" && request.method === "POST") {
      await this.state.storage.put("fired", true);
      await this.state.storage.delete("payload");  // (#2230 bug 1 fix) payload limpo
      await this.state.storage.delete("replacement_entry"); // #11133
      await this.state.storage.delete("reels_container"); // #10922
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /release-claim — cron ou alarm libera claiming após falha do webhook,
    // permitindo que o próximo retry do cron tente novamente.
    if (url.pathname === "/release-claim" && request.method === "POST") {
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET/POST /idem — #10992 item 2: DO-ÍNDICE da chave idempotente
    // (`idFromName("idem:{uuid}")`, instância própria, sem alarm). Guarda a
    // queue key atual daquela chave, que muda quando o mesmo pedido volta com
    // outro `scheduled_at` (a key da fila leva o horário). Strongly consistent,
    // ao contrário de um índice no KV.
    if (url.pathname === "/idem" && request.method === "GET") {
      const queueKey = (await this.state.storage.get<string>("idem_queue_key")) ?? null;
      return new Response(JSON.stringify({ queue_key: queueKey }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/idem" && request.method === "POST") {
      const body = (await request.json()) as { queue_key?: unknown };
      if (typeof body.queue_key !== "string" || body.queue_key === "") {
        return new Response(JSON.stringify({ error: "queue_key required" }), { status: 400 });
      }
      await this.state.storage.put("idem_queue_key", body.queue_key);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  async alarm(): Promise<void> {
    // (#2230 bug 3 fix) Claim atômico via tryClaim() DIRETAMENTE — sem self-fetch.
    // O self-fetch anterior (`this.fetch('/claim')`) criava nested blockConcurrencyWhile:
    // alarm() rodava em isolamento DO, depois `fetch('/claim')` entrava em outro
    // blockConcurrencyWhile interno, o que pode lançar em algumas runtimes CF.
    // Fix: tryClaim() contém o blockConcurrencyWhile diretamente — 1 nível apenas.
    //
    // (#2219 bug 2) Claim atômico garante exactly-once com cron fallback:
    // blockConcurrencyWhile serializa alarm() e cron — apenas 1 ganha o claim.
    const claimed = await this.tryClaim();
    if (!claimed) {
      console.log("[DO alarm] claim lost — cron already claimed or fired, skipping to avoid dup");
      return;
    }

    const payload = await this.state.storage.get<DoStoredPayload>("payload");
    if (!payload) {
      // Alarm foi cancelado (DELETE /queue) mas alarm já estava enfileirado no CF.
      // Clearing do claim pra não bloquear nada; payload já foi deletado por /cancel.
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      console.error("[DO alarm] payload missing after claim — alarm was cancelled, aborting");
      return;
    }

    const { key, webhookUrl, pixelWebhookUrl, webhookApiKey, instagram, instagramVjpixel, threads, linkedin } = payload;
    // #10922 — Reels: retoma o container de uma volta anterior, se houver.
    const storedContainer = await this.state.storage.get<ReelsContainerRef>("reels_container");
    const resumeContainer = pickReelsContainer(payload.entry.reels_container, storedContainer, Date.now());
    const entry: QueueEntry = resumeContainer ? { ...payload.entry, reels_container: resumeContainer } : payload.entry;
    const channel = entry.channel ?? "linkedin";

    // (#3817/#3944 Parte B) fireQueueEntry() é o ponto único de dispatch,
    // compartilhado com fireDueItems (cron path, fire.ts) — decide o branch
    // linkedin/instagram/threads e devolve um outcome puro (fired | failed |
    // dlq). Guards que antes viviam inline aqui (#3662/#3667
    // isUnsupportedCommentTarget, pixel sem URL configurada) agora moram em
    // dispatch.ts::fireQueueEntry.
    //
    // Diferente de fire.ts, alarm() não tem acesso a env.LINKEDIN_QUEUE (só
    // ao DO storage) — outcome "dlq" aqui só libera o claim sem postar,
    // deixando a KV entry intocada: o próximo ciclo do cron (fireDueItems)
    // processa essa mesma entry, aplica o MESMO guard puro, e aí sim escreve
    // em dlq: via KV.
    const outcome = await fireQueueEntry(entry, {
      webhookUrl,
      pixelWebhookUrl,
      apiKey: webhookApiKey,
      instagram,
      instagramVjpixel,
      threads,
      linkedin,
    });

    if (outcome.status === "send_unknown") {
      // #11106 — a Meta pode ter publicado. Liberar o claim (como no `failed`)
      // deixava o cron refazer container + publish e duplicar o post. Marca o
      // DO como disparado (tryClaim/`/arm` recusam, payload apagado) e guarda o
      // motivo; o cron vê `send_unknown` no `/status` e move a entry pra DLQ.
      await this.state.storage.put("send_unknown", outcome.reason);
      await this.state.storage.put("fired", true);
      await this.state.storage.delete("payload");
      await this.state.storage.delete("reels_container");
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      console.error(`[DO alarm] ${key} envio ambíguo, não refeito: ${outcome.reason} — cron move pra DLQ`);
      return;
    }

    if (outcome.status === "dlq") {
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      console.error(
        `[DO alarm] ${key} dlq guard: ${outcome.reason} — releasing claim without firing, cron will DLQ`,
      );
      return;
    }

    // (#2219 bug 3) Estado 2 fases: `claiming:true` (claim ganho, fetch em andamento)
    // → `fired:true` + delete `claiming` (SÓ após sucesso do disparo).
    //
    // Trade-off dup×loss:
    //   - Se setar fired ANTES do fetch (padrão anterior): crash mid-flight → fired=true
    //     mas o post não aconteceu → item perdido silenciosamente (cron vê fired=true,
    //     deleta KV sem postar). Escolha: LOSS (o pior caso).
    //   - Com 2 fases: crash mid-flight → claiming=true, fired=false/undefined →
    //     o cron vê `claiming` (não `fired`) e re-tenta → risco de dup se o webhook
    //     foi parcialmente entregue mas retornou erro por timeout. Escolha: possível DUP.
    //   - Dup é preferível a LOSS para posts LinkedIn/Instagram: dup é visível (editor
    //     pode deletar o duplicado); post perdido é invisível e passa a falsa
    //     impressão de sucesso.
    //   - O claim atomico (via /claim) já elimina o dup CRON↔ALARM (o caso 90%);
    //     o dup residual é apenas no cenário de crash mid-flight + cron re-tenta
    //     (cenário extremamente raro — CF DO tem retry interno).
    //
    // Telemetria de item-loss: cron detecta `claiming=true` sem `fired=true` e loga
    // DLQ-style error pra investigação, permitindo recuperação manual pelo editor.

    if (outcome.status === "fired") {
      // (#2230 bug 1 fix) Sucesso: gravar fired=true DURÁVEL + limpar payload ANTES
      // de liberar o claim. Dupla proteção contra double-post via alarm re-disparado:
      //   1. fired=true: tryClaim() retorna false imediatamente (caminho rápido).
      //   2. payload deletado: mesmo que o claim TTL expire e alarm() re-entre,
      //      a leitura de payload retorna null → abort sem postar.
      // O comentário anterior "alarm não poderá re-disparar sem KV entry" estava ERRADO
      // (#2230 bug 1): alarm lê DO storage, não KV. Fix: payload limpo no DO storage.
      //
      // Retry de 3x pra garantir que fired=true persiste (transitório CF storage error).
      // Sem retry, uma falha aqui deixa o DO em claiming=true,fired=false → o cron
      // pode re-clamar via TTL e re-postar (double-post).
      let firedPersisted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.state.storage.put("fired", true);
          await this.state.storage.delete("payload");   // payload limpo — alarm re-entry posta nada
          await this.state.storage.delete("reels_container"); // #10922
          await this.state.storage.delete("claiming");
          await this.state.storage.delete("claimed_at");
          firedPersisted = true;
          break;
        } catch (storageErr) {
          console.warn(`[DO alarm] storage put fired attempt ${attempt + 1} failed: ${(storageErr as Error).message}`);
          if (attempt < 2) await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        }
      }
      if (!firedPersisted) {
        // Storage persistentemente indisponível — logar crítico mas não lançar
        // (CF alarm não re-tenta se alarm() não lança; deixamos cron detectar via claiming=true).
        console.error(`[DO alarm] CRITICAL: failed to persist fired=true after 3 attempts — key=${key}; double-post risk if alarm re-fires via TTL`);
      }
      console.log(
        `[DO alarm] fired ok key=${key} channel=${channel} destaque=${entry.destaque} fired_persisted=${firedPersisted}`,
      );
      // KV entry permanece até o cron path a encontrar e deletar (com idempotência:
      // cron verifica DO /status, vê fired:true, deleta KV sem re-disparar webhook).
      // Trade-off: item pode aparecer em /list por até 5min após fire. Aceitável.
    } else {
      // outcome.status === "failed" — libera o claim pra cron fallback tentar via retry normal.
      // #10922 — guarda (ou descarta) o container de Reels ANTES de liberar o
      // claim: o cron recebe ele no /claim e retoma em vez de criar outro.
      if (outcome.reelsContainer) await this.state.storage.put("reels_container", outcome.reelsContainer);
      else if (entry.reels_container) await this.state.storage.delete("reels_container");
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      console.error(`[DO alarm] fire failed key=${key} channel=${channel}: ${outcome.reason}`);
    }
  }
}

// ── POST /queue — enfileira ─────────────────────────────────────────────────
