#!/usr/bin/env node
/**
 * check-acquisition-health.ts (#5249)
 *
 * Task semanal: alarme de saúde de aquisição por canal, sobre os snapshots
 * já existentes de `data/beehiiv-backup/` (`Diaria-Beehiiv-Backup`, #5229) +
 * o mapa de origem recuperada (`scripts/build-origem-map.ts`, #5235 Parte 2,
 * usado só como referência de contexto no leitor humano do e-mail — a
 * DETECÇÃO em si roda sobre `utm_source`/`referring_site` bruto de cada
 * snapshot, ver `scripts/lib/acquisition-health.ts`). **NUNCA chama a API
 * Beehiiv ao vivo** — leitura local apenas (guard de publicação do
 * overnight/develop).
 *
 * ## Por que até 3 snapshots (não só 2)
 *
 * Sobrevivência/CTR comparam "semana atual" (snapshot mais recente) vs
 * "semana anterior" (2º mais recente) — 2 snapshots bastam. `canal_parou`
 * (sinal 3a) precisa saber se o canal JÁ estava entregando cadastros antes
 * de zerar — isso exige uma 3ª data pra formar a janela "semana anterior"
 * (`(data[-3], data[-2]]`) e compará-la contra a janela atual
 * (`(data[-2], data[-1]]`). Com só 2 snapshots disponíveis (early do
 * `Diaria-Beehiiv-Backup`, #5229, ainda sem 3 semanas de histórico), o sinal
 * `canal_parou` fica automaticamente desligado (janela anterior nunca >0)
 * até o histórico crescer — degradação silenciosa e correta, não um erro.
 *
 * Uso:
 *   npx tsx scripts/check-acquisition-health.ts [--dry-run] [--to email@x.com]
 *     [--root data/beehiiv-backup] [--state data/acquisition-health/state.json]
 *     [--config platform.config.json] [--store-db data/diaria-subscribers/diaria-subscribers.db]
 *
 *   --dry-run  computa os findings e avalia se alarmaria, mas NÃO envia
 *              e-mail nem avança o state (mesmo contrato dos outros alarmes
 *              locais deste repo — cursos-error-alarm.ts, apoios-diff-alarm.ts).
 *   --to       override do destinatário (default: resolveEditorEmail).
 *   --config   override de `platform.config.json` (default: o real do repo) —
 *              usado pelo guard de fonte cega (#8243, ver abaixo) e por
 *              testes que precisam simular `subscriber_backend: "kit"`.
 *   --store-db override do path do store unificado (default: o real do
 *              repo) — usado só quando `subscriber_backend !== "beehiiv"`
 *              (caminho `runOverStore`, #8243 item 2); testes passam um
 *              `.db` de fixture aqui.
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais) pra ENVIAR o alarme — a leitura/detecção em si
 * não precisa de credencial nenhuma. Requer o junction `data/` (OneDrive)
 * pra ler os snapshots e persistir o state.
 *
 * Fail-soft: menos de 1 snapshot disponível → log + exit 0 (nada pra
 * avaliar ainda, não é erro — mesmo espírito do #4740/#4750: task agendada
 * que roda antes da 1ª dependência existir não deve virar alarme de
 * infraestrutura). Exatamente 1 snapshot → estabelece `knownChannels` sem
 * comparação (sem "semana anterior" pra comparar).
 *
 * Snapshot MAIS RECENTE ausente/incompleto (#5281): diferente do fail-soft
 * acima, isso NÃO é "nada pra avaliar ainda" — é uma falha real do backup
 * que merece barulho. `isSubscribersSnapshotUsable` (`beehiiv-backup-
 * snapshots.ts`) checa `manifest.json` (status `error`/`skipped` do endpoint
 * `subscribers`) e o conteúdo de fato de `subscribers.jsonl`; se
 * inutilizável, o script emite `console.warn` explícito e retorna **sem**
 * avançar `lastCheckedSnapshotDate` — avançar mascararia a falha como
 * "avaliado: limpo" e a próxima rodada (mesmo snapshot ainda quebrado)
 * ficaria presa no guard de idempotência achando que já foi checado.
 *
 * Estado (idempotência + baseline de canais conhecidos):
 *   `data/acquisition-health/state.json`.
 *
 * ## Fonte por backend (#8243)
 *
 * `main()` checa `publishing.newsletter.subscriber_backend`
 * (`resolveNewsletterSubscriberBackend`, `lib/shared/newsletter-subscriber-source.ts`)
 * ANTES de tocar em qualquer snapshot. `"beehiiv"` (default) segue o
 * caminho histórico abaixo, sobre `data/beehiiv-backup/`. Qualquer outro
 * valor (hoje `"kit"`, desde a migração #7386/#7395 — a Beehiiv fica
 * CONGELADA, sem cadastro novo) desvia para `runOverStore()`, que lê o
 * store unificado (`data/diaria-subscribers/`, via
 * `scripts/lib/acquisition-health-store.ts`) em vez de continuar avaliando
 * um snapshot morto — era isso que fabricava "sobrevivência 0%" pra todo
 * canal (medido ao vivo em 06/09 e 13/09/2026, #8086; item 1 do #8243, PR
 * #8263, foi o estancamento imediato — parar de avaliar, sem migrar a
 * leitura ainda). `runOverStore()` é fail-soft nas mesmas bordas do
 * caminho Beehiiv (store ausente, sem captura recente — #5281): loga e
 * retorna sem tocar `state.json`, nunca lança. "Alarme calado com log" é
 * preferível a "alarme afirmando algo falso" nos dois caminhos (mesmo eixo
 * de veracidade do #6798).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { resolveNewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";
import { listSnapshotDates, readSnapshotSubscribers, isSubscribersSnapshotUsable } from "./lib/beehiiv-backup-snapshots.ts";
import { openDiariaSubscribersDbSafe, DEFAULT_DB_PATH as DEFAULT_STORE_DB_PATH } from "./lib/diaria-subscribers-db.ts";
import {
  buildKitChannelSubscribersFromStore,
  isStoreStale,
  STORE_STALENESS_MAX_DAYS,
} from "./lib/acquisition-health-store.ts";
import {
  computeChannelStats,
  snapshotDateToEpochSeconds,
  detectAcquisitionHealthFindings,
  computeFindingsFingerprint,
  buildNextKnownChannels,
  buildAcquisitionHealthEmail,
  emptyAcquisitionHealthState,
  type AcquisitionHealthState,
} from "./lib/acquisition-health.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const DEFAULT_STATE_PATH = resolve(ROOT, "data/acquisition-health/state.json");
const LOG_PREFIX = "[check-acquisition-health]";

export function loadState(statePath: string): AcquisitionHealthState {
  if (!existsSync(statePath)) return emptyAcquisitionHealthState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<AcquisitionHealthState>;
    // #8243: `source` fica AUSENTE da chave (não `undefined` explícito) em
    // state pré-#8243 — só o campo presente com o valor exato distingue
    // "beehiiv"/"store"; qualquer outra coisa (ausente, valor desconhecido)
    // não entra no objeto, preservando `deepEqual` estrito contra state
    // gravado por versões anteriores deste script (ver
    // docstring do campo em acquisition-health.ts).
    const source = raw.source === "beehiiv" || raw.source === "store" ? { source: raw.source } : {};
    return {
      ...source,
      knownChannels: Array.isArray(raw.knownChannels) ? raw.knownChannels : [],
      ctrBelowBaseStreak:
        raw.ctrBelowBaseStreak && typeof raw.ctrBelowBaseStreak === "object" ? raw.ctrBelowBaseStreak : {},
      lastCheckedAt: typeof raw.lastCheckedAt === "string" ? raw.lastCheckedAt : null,
      lastCheckedSnapshotDate: typeof raw.lastCheckedSnapshotDate === "string" ? raw.lastCheckedSnapshotDate : null,
      lastAlarmedFingerprint: typeof raw.lastAlarmedFingerprint === "string" ? raw.lastAlarmedFingerprint : null,
    };
  } catch {
    return emptyAcquisitionHealthState();
  }
}

export function saveState(state: AcquisitionHealthState, statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * #8243 item 2 — caminho de avaliação sobre o store unificado
 * (`data/diaria-subscribers/`), usado quando `subscriber_backend !==
 * "beehiiv"` (hoje "kit"). Só canal Kit-nativo entra (migração da Beehiiv,
 * #7386, é excluída — ver `acquisition-health-store.ts`). Fail-soft em toda
 * borda (store ausente/indisponível, sem captura recente): loga e retorna
 * sem tocar `state.json`, nunca lança — mesmo contrato do caminho Beehiiv.
 */
export async function runOverStore(
  argv: string[],
  statePath: string,
  isDryRun: boolean,
  toOverride: string | undefined,
): Promise<void> {
  const storeDbPath = getArg(argv, "store-db") || DEFAULT_STORE_DB_PATH;
  const db = openDiariaSubscribersDbSafe(storeDbPath);
  if (!db) {
    console.warn(
      `${LOG_PREFIX} store unificado indisponível em ${storeDbPath} (data/ ausente, ou store corrompido) — ` +
        `nenhum achado gerado, state.json intocado.`,
    );
    return;
  }

  try {
    const { subscribers, totalSubscriptions, excludedMigrated, asOf } = buildKitChannelSubscribersFromStore(db);

    if (isStoreStale(asOf)) {
      console.warn(
        `${LOG_PREFIX} store sem captura recente (última: ${asOf ?? "nunca"}, limite: ` +
          `${STORE_STALENESS_MAX_DAYS}d) — não avaliado, state.json intocado (mesma regra do #5281).`,
      );
      return;
    }

    console.log(
      `${LOG_PREFIX} store: ${totalSubscriptions} subscription(s) kit total, ${excludedMigrated} excluída(s) ` +
        `(migração Beehiiv #7386), ${subscribers.length} nativa(s) avaliada(s). asOf=${asOf}.`,
    );
    // #8236: identidade partida do Kit zera `total_received` para todo
    // cadastro nativo — CTR por canal fica sempre `amostraVazia` (guard
    // existente de `computeChannelStats`), nunca dispara `ctr_abaixo_base`.
    // Registrado explicitamente (não calado) por pedido do #8243.
    console.warn(`${LOG_PREFIX} CTR suprimido: identidade partida (#8236) — total_received sempre 0 para cadastros Kit.`);

    const todayDate = new Date().toISOString().slice(0, 10);
    let state = loadState(statePath);

    // Troca de fonte (beehiiv -> store, ou state nunca gravado antes deste
    // caminho): a baseline de canais conhecidos foi construída sobre a
    // OUTRA fonte — reavaliar contra ela fabricaria `canal_desconhecido`
    // para meta-ads/google-ads/etc, que a Beehiiv nunca viu (#8243). Trata
    // esta rodada como 1ª execução sobre a fonte nova, preservando só o
    // que não depende da fonte (nada, hoje — reseta tudo).
    if (state.source !== "store") {
      console.log(
        `${LOG_PREFIX} trocando fonte (${state.source ?? "beehiiv (implícito)"} → store) — recomeçando baseline ` +
          `de canais conhecidos, sem alarmar canal_desconhecido nesta rodada.`,
      );
      state = emptyAcquisitionHealthState();
    }

    if (!isDryRun && state.lastCheckedSnapshotDate === todayDate) {
      console.log(`${LOG_PREFIX} store já avaliado hoje (${todayDate}, idempotência por data) — nada a fazer.`);
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentWindowSince = nowSeconds - 7 * 86400;
    const currentWindowUntil = nowSeconds;
    const previousWindowSince = nowSeconds - 14 * 86400;
    const previousWindowUntil = currentWindowSince;

    const currentStats = computeChannelStats(subscribers, currentWindowSince, currentWindowUntil);
    // Mesmo array (o store não guarda snapshots datados) — só a JANELA de
    // `novosNaJanela` muda entre "atual" e "anterior"; `cadastros`/`ativos`/
    // `sobrevivenciaPct` são cumulativos e saem idênticos nos dois, então
    // `sobrevivencia_queda` nunca dispara sobre o store (degrada para
    // "nunca falso-positivo" em vez de comparar contra um "antes" que o
    // store não tem — documentado, não um bug).
    const previousStats = computeChannelStats(subscribers, previousWindowSince, previousWindowUntil);

    const { findings, suppressedFindings, nextCtrBelowBaseStreak } = detectAcquisitionHealthFindings(
      currentStats,
      previousStats,
      state,
    );

    console.log(
      `${LOG_PREFIX} store: canais=${currentStats.length} findings=${findings.length} ` +
        `suprimidos=${suppressedFindings.length}.`,
    );
    for (const f of findings) {
      console.log(`${LOG_PREFIX}   [${f.type}] ${f.channel}: ${f.detail}`);
    }
    for (const f of suppressedFindings) {
      console.warn(`${LOG_PREFIX}   [${f.type}] ${f.channel} SUPRIMIDO: ${f.detail}`);
    }

    const fingerprint = findings.length > 0 ? computeFindingsFingerprint(findings) : null;
    const shouldSend = fingerprint != null && fingerprint !== state.lastAlarmedFingerprint;

    if (shouldSend) {
      const { subject, body } = buildAcquisitionHealthEmail(findings, `store (${todayDate})`, suppressedFindings);
      if (isDryRun) {
        console.log(`${LOG_PREFIX} --dry-run: registraria alarme:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
      } else {
        const result = await notifyEditor(
          { check: "check-acquisition-health", fingerprint: fingerprint as string, severity: "acao", subject, body },
          { cwd: ROOT, emailTo: toOverride },
        );
        if (result.issue?.action === "failed") {
          throw new Error(`ensureAlarmIssue falhou: ${result.issue.error}`);
        }
        console.log(`${LOG_PREFIX} alarme registrado (issue #${result.issue?.issueNumber ?? "?"}).`);
      }
    } else if (findings.length > 0) {
      console.log(`${LOG_PREFIX} findings inalterados desde o último alarme (mesmo fingerprint) — sem novo alarme.`);
    } else {
      console.log(`${LOG_PREFIX} nenhum achado nesta rodada.`);
    }

    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: state NÃO avançado.`);
      return;
    }

    const nextState: AcquisitionHealthState = {
      source: "store",
      knownChannels: buildNextKnownChannels(state, currentStats),
      ctrBelowBaseStreak: nextCtrBelowBaseStreak,
      lastCheckedAt: new Date().toISOString(),
      lastCheckedSnapshotDate: todayDate,
      lastAlarmedFingerprint: fingerprint,
    };
    saveState(nextState, statePath);
  } finally {
    db.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const root = getArg(argv, "root") || DEFAULT_BACKUP_ROOT;
  const statePath = getArg(argv, "state") || DEFAULT_STATE_PATH;

  // #8243: a Beehiiv só é a fonte viva de assinantes se
  // subscriber_backend === "beehiiv" — qualquer outro valor (hoje "kit")
  // significa que o snapshot Beehiiv está congelado (nenhum cadastro novo
  // chega ali) e avaliar sobre ele fabrica achados falsos. Guard ANTES de
  // ler qualquer snapshot; nunca toca state.json.
  const configPathOverride = getArg(argv, "config");
  const subscriberBackend = configPathOverride
    ? resolveNewsletterSubscriberBackend(configPathOverride)
    : resolveNewsletterSubscriberBackend();
  if (subscriberBackend !== "beehiiv") {
    console.warn(
      `${LOG_PREFIX} fonte Beehiiv não é a base de assinantes (subscriber_backend=${subscriberBackend}) — ` +
        `snapshot Beehiiv está congelado, avaliação sobre ele produziria achados fabricados. Ver #8243.`,
    );
    return runOverStore(argv, statePath, isDryRun, toOverride);
  }

  const dates = listSnapshotDates(root); // ascendente
  if (dates.length === 0) {
    console.log(`${LOG_PREFIX} nenhum snapshot encontrado em ${root} — nada a avaliar ainda.`);
    return;
  }

  const state = loadState(statePath);
  const currentDate = dates[dates.length - 1];

  // Guard de idempotência por data só vale pra execução REAL — avança
  // `state.json` e não deve reavaliar o mesmo snapshot 2×. `--dry-run` NUNCA
  // toca o state (ver retorno mais abaixo), então precisa poder reinspecionar
  // os achados quantas vezes o operador quiser, mesmo com a semana já
  // processada (debug story de `docs/acquisition-health-alarm-setup.md`).
  if (!isDryRun && state.lastCheckedSnapshotDate === currentDate) {
    console.log(
      `${LOG_PREFIX} snapshot ${currentDate} já foi avaliado nesta rodada (idempotência por data) — nada a fazer.`,
    );
    // #5494 item 6: "já avaliado nesta semana" e "o backup não gerou o
    // snapshot desta semana" são indistinguíveis nesta linha — os dois
    // resultam em `dates[-1]` == o mesmo `currentDate` de sempre. Se esse
    // snapshot já tem mais de 7 dias, o log acima está mascarando uma falha
    // de `Diaria-Beehiiv-Backup`, não uma idempotência normal — avisa
    // explícito (o alarme dedicado, `beehiiv-backup-staleness-alarm.ts`,
    // #5494, é quem manda o e-mail; aqui é só sinal pro operador que lê o
    // journal).
    const ageDays = (Date.now() / 1000 - snapshotDateToEpochSeconds(currentDate)) / 86400;
    if (ageDays > 7) {
      console.warn(
        `${LOG_PREFIX} ATENÇÃO: snapshot mais recente (${currentDate}) tem ${Math.round(ageDays)} dia(s) — ` +
          `"já avaliado" pode significar "Diaria-Beehiiv-Backup não gerou snapshot novo esta semana", não que ` +
          `está tudo em dia. Ver beehiiv-backup-staleness-alarm.ts.`,
      );
    }
    return;
  }

  // Guard contra snapshot ausente/incompleto virando "avaliado: limpo" (#5281)
  // — checa ANTES de gastar qualquer cálculo, e retorna sem tocar o state
  // (nem em modo real: reavaliar o mesmo snapshot quebrado na próxima
  // rodada é o comportamento certo, não idempotência).
  const usability = isSubscribersSnapshotUsable(root, currentDate);
  if (!usability.usable) {
    console.warn(
      `${LOG_PREFIX} snapshot de ${currentDate} ausente ou incompleto (${usability.reason}) — ` +
        `alarme não pôde rodar, não marcado como avaliado.`,
    );
    return;
  }

  const previousDate = dates.length >= 2 ? dates[dates.length - 2] : null;
  const olderDate = dates.length >= 3 ? dates[dates.length - 3] : null;

  const currentSubs = readSnapshotSubscribers(root, currentDate);
  const previousSubs = previousDate ? readSnapshotSubscribers(root, previousDate) : null;

  const currentWindowSince = previousDate ? snapshotDateToEpochSeconds(previousDate) : null;
  const currentWindowUntil = previousDate ? snapshotDateToEpochSeconds(currentDate) : null;
  const currentStats = computeChannelStats(currentSubs, currentWindowSince, currentWindowUntil);

  let previousStats = null;
  if (previousSubs) {
    const prevWindowSince = olderDate ? snapshotDateToEpochSeconds(olderDate) : null;
    const prevWindowUntil = olderDate ? snapshotDateToEpochSeconds(previousDate as string) : null;
    previousStats = computeChannelStats(previousSubs, prevWindowSince, prevWindowUntil);
  }

  const { findings, suppressedFindings, nextCtrBelowBaseStreak } = detectAcquisitionHealthFindings(
    currentStats,
    previousStats,
    state,
  );

  console.log(
    `${LOG_PREFIX} snapshot=${currentDate} canais=${currentStats.length} findings=${findings.length} ` +
      `suprimidos=${suppressedFindings.length} (3 snapshots disponíveis: ${olderDate != null}).`,
  );
  for (const f of findings) {
    console.log(`${LOG_PREFIX}   [${f.type}] ${f.channel}: ${f.detail}`);
  }
  // #5494: findings suprimidos por divergência de largura de janela NUNCA
  // ficam invisíveis — logados sempre (nunca só quando um e-mail sai), com
  // console.warn pra diferenciar visualmente de um finding ativo.
  for (const f of suppressedFindings) {
    console.warn(`${LOG_PREFIX}   [${f.type}] ${f.channel} SUPRIMIDO: ${f.detail}`);
  }

  const fingerprint = findings.length > 0 ? computeFindingsFingerprint(findings) : null;
  const shouldSend = fingerprint != null && fingerprint !== state.lastAlarmedFingerprint;

  if (shouldSend) {
    const { subject, body } = buildAcquisitionHealthEmail(findings, currentDate, suppressedFindings);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: registraria alarme:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // #7960: migrado de sendGmailMessage direto pro portão notifyEditor —
      // severidade "acao" (health check, sem envio/dinheiro em risco), issue
      // sem e-mail sob `email_policy: "urgent_only"`.
      const result = await notifyEditor(
        { check: "check-acquisition-health", fingerprint: fingerprint as string, severity: "acao", subject, body },
        { cwd: ROOT, emailTo: toOverride },
      );
      if (result.issue?.action === "failed") {
        throw new Error(`ensureAlarmIssue falhou: ${result.issue.error}`);
      }
      console.log(`${LOG_PREFIX} alarme registrado (issue #${result.issue?.issueNumber ?? "?"}).`);
    }
  } else if (findings.length > 0) {
    console.log(`${LOG_PREFIX} findings inalterados desde o último alarme (mesmo fingerprint) — sem novo alarme.`);
  } else {
    console.log(`${LOG_PREFIX} nenhum achado nesta rodada.`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: state NÃO avançado.`);
    return;
  }

  const nextState: AcquisitionHealthState = {
    knownChannels: buildNextKnownChannels(state, currentStats),
    ctrBelowBaseStreak: nextCtrBelowBaseStreak,
    lastCheckedAt: new Date().toISOString(),
    lastCheckedSnapshotDate: currentDate,
    // Sempre sincroniza com o fingerprint desta rodada (não só quando um
    // e-mail novo saiu) — `null` (sem findings) RE-ARMA o cursor, mesmo
    // padrão de `hub-drift-check.ts`: o drift sendo resolvido tira o canal
    // do conjunto pendente, e se ele voltar a aparecer depois, alarma de
    // novo em vez de ficar preso ao último fingerprint não-vazio.
    lastAlarmedFingerprint: fingerprint,
  };
  saveState(nextState, statePath);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
