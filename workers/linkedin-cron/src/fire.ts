import type { Env, QueueEntry, WebhookTarget, QueueAction } from "./index";
import { buildDlqKey, MAX_RETRIES, DLQ_TTL_SECONDS, FETCH_TIMEOUT_MS } from "./index";
import { isUnsupportedCommentTarget } from "./guards";

// ── Cron handler — fira items maduros ──────────────────────────────────────

/**
 * #880 — move entry pra dlq:{uuid} após esgotar retries.
 * #881 — fetch ao Make tem timeout via AbortSignal (FETCH_TIMEOUT_MS).
 */
export async function fireDueItems(env: Env): Promise<{ fired: number; errors: number; dlq: number }> {
  const now = Date.now();
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  let fired = 0;
  let errors = 0;
  let dlq = 0;

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;

    let entry: QueueEntry;
    try {
      entry = JSON.parse(raw) as QueueEntry;
    } catch (e) {
      console.error(`[fire] invalid JSON in ${k.name}: ${(e as Error).message}`);
      errors++;
      continue;
    }

    const scheduledMs = Date.parse(entry.scheduled_at);
    if (isNaN(scheduledMs)) {
      console.error(`[fire] invalid scheduled_at in ${k.name}: ${entry.scheduled_at}`);
      errors++;
      continue;
    }

    // (#2230 bug 2 fix) Verificar tombstone de cancelamento.
    // Se handleQueueDelete gravou um tombstone (cancelled=true) porque o KV.delete
    // falhou após o DO cancel, o cron deve pular e limpar esta entry sem postar.
    // (#2293 self-review HIGH): movido ANTES da guarda `scheduledMs > now`.
    // Bug original: tombstone com scheduled_at no FUTURO era `continue`d pela guarda
    // de horário sem jamais ser deletado — acumulava no KV indefinidamente.
    // Fix: verificar cancelled antes do skip de horário — tombstone futuro ou passado → deletar sempre.
    if (entry.cancelled) {
      // (#2235 fix F5) Garantir DO /cancel best-effort ao limpar tombstone: mesmo que o DO
      // cancel já tenha sido feito no handleQueueDelete, o DO pode ter re-armado (rearm).
      // Limpar o payload do DO ao remover o tombstone é a defesa final contra post-após-delete.
      try {
        const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
        const doStub = env.LINKEDIN_SCHEDULER.get(doId);
        await doStub.fetch("https://do/cancel", { method: "POST" });
      } catch { /* non-fatal — DO pode não estar disponível */ }
      await env.LINKEDIN_QUEUE.delete(k.name);
      console.log(`[fire] ${k.name} is a cancellation tombstone — DO cancelled + deleted without firing`);
      continue;
    }

    if (scheduledMs > now) continue; // ainda não chegou a hora

    // (#2219 bug 2) Exactly-once via /claim atômico no DO.
    // O cron usa POST /claim em vez de GET /status-then-fire: o DO testa-e-seta
    // `claiming` dentro de blockConcurrencyWhile, eliminando a janela de corrida
    // onde cron lê fired=false, alarm() também lê fired=false, e ambos postam.
    //
    // Resultado possível:
    //   claimed=true  → este caller (cron) ganhou; pode postar
    //   claimed=false → alarm() ou outro cron já ganhou o claim; apenas limpar KV
    //   DO unavailable → fallback: cron dispara normalmente (compat com deploys antigos)
    //
    // (#2219 bug 3) Telemetria de item-loss: se o DO reporta claiming=true sem
    // fired=true (crash mid-flight do alarm), o cron detecta via /status e loga
    // error pra o editor investigar (em vez de silenciosamente pular).
    let cronShouldFire = true; // default = fallback (DO indisponível)
    try {
      const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
      const doStub = env.LINKEDIN_SCHEDULER.get(doId);

      // Verificar estado atual antes de tentar claim:
      // Se fired=true → alarm já completou com sucesso, apenas limpar KV.
      // Se claiming=true mas fired=false → crash mid-flight detectado, logar.
      const statusRes = await doStub.fetch("https://do/status", { method: "GET" });
      if (statusRes.ok) {
        // Fix #F3 (confirmed bug): include `claiming` in the type — previously the cast
        // `as { fired: boolean }` dropped `claiming` from the parsed object, making the
        // crash-detection logic (claiming=true + fired=false) permanently unreachable.
        const status = await statusRes.json() as { fired: boolean; claiming: boolean; claimed_at: number | null };
        if (status.fired) {
          // DO já disparou — apenas limpar KV entry sem re-fire
          await env.LINKEDIN_QUEUE.delete(k.name);
          console.log(`[fire] ${k.name} already fired by DO alarm — cleaning KV (idempotency)`);
          fired++; // conta como fired pra estatísticas
          continue;
        }
        // Telemetria de crash mid-flight: claiming=true + fired=false indica que o alarm()
        // ganhou o claim mas crashou antes de completar o post. Logar erro pra investigação.
        if (status.claiming && !status.fired) {
          const claimedAgo = status.claimed_at ? Date.now() - status.claimed_at : null;
          console.error(`[fire] ${k.name} crash-mid-flight detected: claiming=true, fired=false, claimed_at_ms_ago=${claimedAgo} — cron will attempt re-fire via /claim`);
        }
      }

      // Tentar ganhar o claim atômico. Se alarm() já ganhou (ou está em andamento),
      // não disparamos — evita dup cron↔alarm.
      const claimRes = await doStub.fetch("https://do/claim", { method: "POST" });
      if (claimRes.ok) {
        const claimData = await claimRes.json() as { claimed: boolean };
        if (!claimData.claimed) {
          // Alarm (ou outro cron) ganhou o claim — não postar.
          // Item será limpo na próxima rodada do cron quando fired=true.
          console.log(`[fire] ${k.name} claim lost — alarm or peer cron already claimed, skipping`);
          cronShouldFire = false;
        }
        // Se claimed=true: cronShouldFire permanece true, cron dispara normalmente.
      }
      // Se claimRes não ok: fallback — cron dispara normalmente
    } catch {
      // DO indisponível ou binding ausente — cron dispara normalmente (fallback)
    }

    if (!cronShouldFire) continue;

    // (#2219 bug 1 fix) Helper pra liberar o claim no DO após qualquer saída
    // sem post bem-sucedido (DLQ-path, skip, erro). O padrão try/finally é
    // aplicado abaixo: se o cron ganhou o claim mas NÃO postou com sucesso,
    // o claim é liberado via /release-claim pra não travar o DO permanentemente.
    const releaseCronClaim = async () => {
      // Só libera se cronShouldFire=true (significa que ganhamos o claim)
      try {
        const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
        const doStub = env.LINKEDIN_SCHEDULER.get(doId);
        await doStub.fetch("https://do/release-claim", { method: "POST" });
      } catch { /* non-fatal — eviction limpará o DO */ }
    };

    // #595 — Resolver webhook URL por target. Default "diaria" pra backward-compat.
    // Pixel target sem MAKE_PIXEL_WEBHOOK_URL configurado → DLQ direto, evita loop.
    const webhookTarget: WebhookTarget = entry.webhook_target ?? "diaria";
    const action: QueueAction = entry.action ?? "post";
    let webhookUrl: string;
    if (webhookTarget === "pixel") {
      if (!env.MAKE_PIXEL_WEBHOOK_URL) {
        // (#2219 bug 1 fix) Liberar claim ANTES de ir pro DLQ — sem isso o DO
        // fica com claiming=true permanente e o alarm fica travado até eviction.
        await releaseCronClaim();
        // Sem URL Pixel → DLQ imediato (não retry, não dá pra resolver).
        const dlqKey = buildDlqKey(k.name, entry.scheduled_at);
        await env.LINKEDIN_QUEUE.put(
          dlqKey,
          JSON.stringify({ ...entry, retry_count: MAX_RETRIES }),
          { expirationTtl: DLQ_TTL_SECONDS },
        );
        await env.LINKEDIN_QUEUE.delete(k.name);
        console.error(
          `[fire] ${k.name} dropped to dlq: webhook_target=pixel but MAKE_PIXEL_WEBHOOK_URL not configured (dlq_key=${dlqKey})`,
        );
        dlq++;
        continue;
      }
      webhookUrl = env.MAKE_PIXEL_WEBHOOK_URL;
    } else {
      webhookUrl = env.MAKE_WEBHOOK_URL;
    }

    // (#3662) Guard: o módulo LinkedIn do Make Diar.ia (webhookTarget != "pixel")
    // não suporta "Create Comment" — o comentário na montagem do payload abaixo
    // já documenta que "Pixel só aceita comment", ou seja, webhook_target="pixel"
    // é o ÚNICO caso onde action="comment" é válido. Uma entry residual (fila
    // pré-#3627, que removeu a geração de comments) ou regressão futura com
    // action="comment" + webhookTarget="diaria" geraria erro
    // `Missing value of required parameter 'url'` no Make, 5 retries, DLQ, e
    // email de erro pro editor — não adianta re-tentar, o Make sempre rejeita o
    // mesmo payload. Rejeitar cedo, direto pra DLQ, mesmo padrão do bloco
    // pixel-sem-webhook-url acima.
    // (#3667) Decisão extraída pra isUnsupportedCommentTarget() (guards.ts) —
    // reusada também por alarm() (durable-object.ts), que aplica o mesmo guard
    // mas libera o claim em vez de escrever DLQ (sem acesso a KV).
    if (isUnsupportedCommentTarget(action, webhookTarget)) {
      await releaseCronClaim();
      const dlqKey = buildDlqKey(k.name, entry.scheduled_at);
      await env.LINKEDIN_QUEUE.put(
        dlqKey,
        JSON.stringify({ ...entry, retry_count: MAX_RETRIES }),
        { expirationTtl: DLQ_TTL_SECONDS },
      );
      await env.LINKEDIN_QUEUE.delete(k.name);
      console.error(
        `[fire] ${k.name} dropped to dlq: action=comment but webhook_target=${webhookTarget} (só "pixel" suporta comment) (dlq_key=${dlqKey})`,
      );
      dlq++;
      continue;
    }

    // Disparar webhook Make (#881 — com timeout)
    let succeeded = false;
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          image_url: entry.image_url,
          scheduled_at: entry.scheduled_at,
          destaque: entry.destaque,
          // #595 — forward action + parent_destaque pro Make scenario.
          // Make Diar.ia faz Router por action; Pixel só aceita "comment".
          action,
          ...(entry.parent_destaque !== undefined && { parent_destaque: entry.parent_destaque }),
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) {
        await env.LINKEDIN_QUEUE.delete(k.name);
        // (#2235 fix) Transicionar DO para fired=true + limpar payload com retry robusto.
        // CRÍTICO: alarm() lê o PAYLOAD do DO storage, NÃO do KV. Sem fired=true E sem
        // payload no DO, o alarm não tem o quê postar mesmo se re-disparar via TTL expiry.
        // Dupla proteção (espelhando o alarm path em alarm()):
        //   1. fired=true: tryClaim() retorna false imediatamente.
        //   2. payload deletado por /status-set-fired: alarm re-entry aborta cedo (payload missing).
        // Sem retry aqui, uma falha silenciosa deixa o DO em claiming=true+fired=false+payload
        // presente → cron pode re-clamar via TTL e re-postar (double-post).
        //
        // (#2235 fix F8) DO stub içado pra fora do loop: idFromName()+get() é O(1) mas
        // chamado 3× no loop original sem necessidade — içar evita redundância e simplifica.
        let firedSetOk = false;
        let sfDoStub: { fetch: (url: string, init?: RequestInit) => Promise<Response> } | null = null;
        try {
          const sfDoId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
          sfDoStub = env.LINKEDIN_SCHEDULER.get(sfDoId);
        } catch { /* binding ausente — sfDoStub permanece null */ }
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!sfDoStub) break;
          try {
            const sfRes = await sfDoStub.fetch("https://do/status-set-fired", { method: "POST" });
            if (sfRes.ok) {
              firedSetOk = true;
              break;
            }
            console.warn(`[fire] /status-set-fired attempt ${attempt + 1} returned ${sfRes.status} for key=${k.name}`);
          } catch (sfErr) {
            // (#2235 fix F9) String(sfErr) em vez de (sfErr as Error).message — undefined pra não-Error
            console.warn(`[fire] /status-set-fired attempt ${attempt + 1} failed for key=${k.name}: ${String(sfErr)}`);
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        }
        if (!firedSetOk) {
          // Falha persistente: KV já deletado, mas DO ainda tem payload + claiming=true.
          // (#2235 fix F1) Chamar /cancel best-effort: sem payload, alarm re-entry não tem o quê
          // postar mesmo que re-claime via TTL. Invariante: payload limpo ⇒ sem re-post.
          // Se /cancel também falhar, NÃO há mais o que fazer (KV já deletado) — logar crítico.
          let cancelledViaCancel = false;
          if (sfDoStub) {
            try {
              const cancelRes = await sfDoStub.fetch("https://do/cancel", { method: "POST" });
              cancelledViaCancel = cancelRes.ok;
              if (cancelRes.ok) {
                console.warn(`[fire] /status-set-fired failed after 3 attempts for key=${k.name} — called /cancel to clear payload (double-post prevention)`);
              } else {
                console.error(`[fire] CRITICAL: /status-set-fired AND /cancel failed for key=${k.name} status=${cancelRes.status} — DO payload may remain, double-post risk if alarm re-fires via TTL`);
              }
            } catch (cancelErr) {
              console.error(`[fire] CRITICAL: /status-set-fired AND /cancel threw for key=${k.name}: ${String(cancelErr)} — DO payload may remain, double-post risk if alarm re-fires via TTL`);
            }
          } else {
            console.error(`[fire] CRITICAL: /status-set-fired skipped (DO binding absent) for key=${k.name} — double-post risk if alarm re-fires via TTL`);
          }
          void cancelledViaCancel; // loggado acima
        }
        console.log(
          `[fire] ${k.name} fired (target=${webhookTarget} action=${action} destaque=${entry.destaque}, scheduled=${entry.scheduled_at})`,
        );
        fired++;
        succeeded = true;
      } else {
        const body = await res.text();
        // Liberar claim no DO pra próximo retry do cron poder tentar de novo.
        try {
          const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
          const doStub = env.LINKEDIN_SCHEDULER.get(doId);
          await doStub.fetch("https://do/release-claim", { method: "POST" });
        } catch { /* non-fatal */ }
        console.error(
          `[fire] ${k.name} make webhook returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      const err = e as Error;
      // Liberar claim no DO pra próximo retry do cron poder tentar de novo.
      try {
        const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
        const doStub = env.LINKEDIN_SCHEDULER.get(doId);
        await doStub.fetch("https://do/release-claim", { method: "POST" });
      } catch { /* non-fatal */ }
      // AbortError surge se AbortSignal.timeout dispara antes do Make responder
      if (err.name === "AbortError" || err.name === "TimeoutError") {
        console.error(`[fire] ${k.name} fetch timeout after ${FETCH_TIMEOUT_MS}ms`);
      } else {
        console.error(`[fire] ${k.name} fetch failed: ${err.message}`);
      }
    }

    if (succeeded) continue;

    // #880 — incrementar retry_count e mover pra dlq se esgotou
    const currentRetry = entry.retry_count ?? 0;
    const nextRetry = currentRetry + 1;

    if (nextRetry >= MAX_RETRIES) {
      // #894 P1-A — Move pra DLQ com ordem atômica: PUT dlq primeiro, delete
      // queue depois. Se Worker crashar entre as 2 ops, o item permanece em
      // ambos: o cron seguinte vai re-processar a queue entry (e potencialmente
      // re-mover pra DLQ, gerando duplicata). Trade-off: duplicata é benigna
      // (DLQ é só auditoria, não dispara ação) e o TTL (#894 P1-B) garante que
      // entries antigas evaporam. Inverter a ordem (delete primeiro, put
      // depois) seria pior: crash entre as ops perde o item silenciosamente.
      //
      // Reusa o UUID original pra rastreabilidade (`queue:<ts>:<uuid>` →
      // `dlq:<ts>:<uuid>`). Pra schema legacy (`queue:<uuid>`), usa o uuid
      // direto. Mantém vínculo entre entry da fila e entry no DLQ.
      const dlqKey = buildDlqKey(k.name, entry.scheduled_at);
      const dlqEntry: QueueEntry = { ...entry, retry_count: nextRetry };
      await env.LINKEDIN_QUEUE.put(dlqKey, JSON.stringify(dlqEntry), {
        expirationTtl: DLQ_TTL_SECONDS, // #894 P1-B
      });
      await env.LINKEDIN_QUEUE.delete(k.name);
      console.error(
        `[fire] ${k.name} moved to dlq after ${nextRetry} retries (destaque=${entry.destaque}, scheduled=${entry.scheduled_at}, dlq_key=${dlqKey})`,
      );
      dlq++;
    } else {
      // Re-write com retry_count incrementado
      const updated: QueueEntry = { ...entry, retry_count: nextRetry };
      await env.LINKEDIN_QUEUE.put(k.name, JSON.stringify(updated));
      console.error(
        `[fire] ${k.name} retry ${nextRetry}/${MAX_RETRIES} (destaque=${entry.destaque})`,
      );
      errors++;
    }
  }

  return { fired, errors, dlq };
}
