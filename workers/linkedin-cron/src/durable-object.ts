import type { Env, QueueEntry, WebhookTarget, QueueAction } from "./index";
import { CLAIM_TTL_MS, FETCH_TIMEOUT_MS } from "./index";

// ── LinkedInScheduler — Durable Object (#1168) ────────────────────────────

/**
 * Payload armazenado no DO storage, contendo tudo que alarm() precisa pra
 * disparar o webhook sem acesso ao KV ou ao env do Worker.
 */
export interface DoStoredPayload {
  key: string;               // KV key do item (usado em logs)
  entry: QueueEntry;         // entry completa (texto, webhook_target, action, etc.)
  webhookUrl: string;        // MAKE_WEBHOOK_URL resolvido no momento do enqueue
  pixelWebhookUrl?: string;  // MAKE_PIXEL_WEBHOOK_URL (opcional)
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
 *   POST /cancel  → cancela alarm, limpa storage (para DELETE /queue/:key)
 *   GET  /status  → retorna { fired: boolean; claiming: boolean; claimed_at: number | null } (consultado por fireDueItems)
 *   POST /claim   → check-and-set atômico de `claiming` dentro de
 *                   blockConcurrencyWhile. Retorna { claimed: boolean }.
 *                   `true` significa "este caller ganhou o claim e pode postar".
 *                   `false` significa "outro caller já está processando" — não postar.
 *                   Implementa exactly-once entre cron↔alarm (#2219 bug 2).
 *                   (#2230 bug 3) alarm() usa tryClaim() DIRETAMENTE — não via self-fetch.
 */
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
      const alreadyFired = await this.state.storage.get<boolean>("fired");
      if (alreadyFired) return false;
      if (alreadyClaiming) {
        // Verificar se o claim expirou (crash mid-flight sem release)
        const claimedAt = await this.state.storage.get<number>("claimed_at");
        const claimExpired = claimedAt !== undefined && (Date.now() - claimedAt) > CLAIM_TTL_MS;
        if (!claimExpired) return false;
        // Claim expirado — logar e re-clamar
        console.warn(`[DO tryClaim] claim expired after ${Date.now() - (claimedAt ?? 0)}ms — re-claiming (crash recovery)`);
      }
      await this.state.storage.put("claiming", true);
      await this.state.storage.put("claimed_at", Date.now());
      return true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/arm" && request.method === "POST") {
      const body = await request.json() as DoStoredPayload & { scheduledAtMs: number };
      // Persiste tudo que alarm() precisará — inclusive entry completa + webhook URLs
      const { scheduledAtMs, ...payload } = body;
      await this.state.storage.put("payload", payload satisfies DoStoredPayload);
      // setAlarm sobrescreve alarm anterior — idempotente pra re-arm
      await this.state.storage.setAlarm(scheduledAtMs);

      return new Response(JSON.stringify({ armed: true, scheduledAtMs }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      // deleteAll limpa payload + fired + claiming; deleteAlarm cancela o alarm.
      // Ordem: deleteAlarm primeiro pra evitar janela onde o alarm dispara mas
      // o storage ainda tem payload (risco baixo mas defensivo).
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return new Response(JSON.stringify({ cancelled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const fired = (await this.state.storage.get<boolean>("fired")) ?? false;
      // (#2219 bug 6 fix) Expor `claiming` pra telemetria de crash-mid-flight.
      // Se claiming=true + fired=false, o cron pode detectar via /status que o alarm
      // travou no meio — logar DLQ-style error pra investigação do editor.
      const claiming = (await this.state.storage.get<boolean>("claiming")) ?? false;
      const claimedAt = await this.state.storage.get<number>("claimed_at");
      return new Response(JSON.stringify({ fired, claiming, claimed_at: claimedAt ?? null }), {
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
        const alreadyFired = await this.state.storage.get<boolean>("fired");
        if (alreadyFired) return false;
        if (alreadyClaiming) {
          // Verificar se o claim expirou (crash mid-flight sem release)
          const claimedAt = await this.state.storage.get<number>("claimed_at");
          const claimExpired = claimedAt !== undefined && (Date.now() - claimedAt) > CLAIM_TTL_MS;
          if (!claimExpired) return false;
          // Claim expirado — logar e re-clamar
          console.warn(`[DO claim] claim expired after ${Date.now() - (claimedAt ?? 0)}ms — re-claiming (crash recovery)`);
        }
        await this.state.storage.put("claiming", true);
        await this.state.storage.put("claimed_at", Date.now());
        return true;
      });
      return new Response(JSON.stringify({ claimed }), {
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

    const { key, entry, webhookUrl: defaultWebhookUrl, pixelWebhookUrl } = payload;
    const webhookTarget: WebhookTarget = entry.webhook_target ?? "diaria";
    const action: QueueAction = entry.action ?? "post";

    let webhookUrl: string;
    if (webhookTarget === "pixel") {
      if (!pixelWebhookUrl) {
        // Configuração incompleta — libera claim pra cron tentar (vai pra DLQ direto).
        await this.state.storage.delete("claiming");
        await this.state.storage.delete("claimed_at");
        console.error(`[DO alarm] pixel entry ${key} but pixelWebhookUrl not stored — releasing claim`);
        return;
      }
      webhookUrl = pixelWebhookUrl;
    } else {
      webhookUrl = defaultWebhookUrl;
    }

    // (#2219 bug 3) Estado 2 fases: `claiming:true` (claim ganho, fetch em andamento)
    // → `fired:true` + delete `claiming` (SÓ após sucesso do webhook).
    //
    // Trade-off dup×loss:
    //   - Se setar fired ANTES do fetch (padrão anterior): crash mid-flight → fired=true
    //     mas o post não aconteceu → item perdido silenciosamente (cron vê fired=true,
    //     deleta KV sem postar). Escolha: LOSS (o pior caso).
    //   - Com 2 fases: crash mid-flight → claiming=true, fired=false/undefined →
    //     o cron vê `claiming` (não `fired`) e re-tenta → risco de dup se o webhook
    //     foi parcialmente entregue mas retornou erro por timeout. Escolha: possível DUP.
    //   - Dup é preferível a LOSS para posts LinkedIn: dup é visível (editor pode deletar
    //     o duplicado); post perdido é invisível e passa a falsa impressão de sucesso.
    //   - O claim atomico (via /claim) já elimina o dup CRON↔ALARM (o caso 90%);
    //     o dup residual é apenas no cenário de crash mid-flight + cron re-tenta
    //     (cenário extremamente raro — CF DO tem retry interno).
    //
    // Telemetria de item-loss: cron detecta `claiming=true` sem `fired=true` e loga
    // DLQ-style error pra investigação, permitindo recuperação manual pelo editor.

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          image_url: entry.image_url,
          scheduled_at: entry.scheduled_at,
          destaque: entry.destaque,
          action,
          ...(entry.parent_destaque !== undefined && { parent_destaque: entry.parent_destaque }),
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) {
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
          `[DO alarm] fired ok key=${key} target=${webhookTarget} action=${action} destaque=${entry.destaque} fired_persisted=${firedPersisted}`,
        );
        // KV entry permanece até o cron path a encontrar e deletar (com idempotência:
        // cron verifica DO /status, vê fired:true, deleta KV sem re-disparar webhook).
        // Trade-off: item pode aparecer em /list por até 5min após fire. Aceitável.
      } else {
        // Fire falhou — libera o claim pra cron fallback tentar via retry normal.
        await this.state.storage.delete("claiming");
        await this.state.storage.delete("claimed_at");
        const body = await res.text();
        console.error(
          `[DO alarm] fire failed key=${key} status=${res.status}: ${body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      // Timeout ou exception — libera o claim pra cron fallback.
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      const err = e as Error;
      console.error(`[DO alarm] fire exception key=${key}: ${err.message}`);
    }
  }
}

// ── POST /queue — enfileira ─────────────────────────────────────────────────
