#!/usr/bin/env node
/**
 * scripts/backfill-kit-native-attribution.ts (#6425 Parte A)
 *
 * Recupera a atribuição de quem se cadastrou pelo FORM NATIVO hospedado no
 * Kit (`https://diar-ia-br.kit.com/`) — caminho que não passa por
 * `subscribeToKit` (`workers/poll/src/subscribe.ts`), então nenhum dos
 * nossos custom fields é escrito e o assinante fica com os 10 campos
 * `null`. `scripts/backfill-kit-attribution.ts` (#6318) não cobre este
 * caso: aquele script recupera a partir do snapshot da Beehiiv, e quem
 * entra pelo form nativo nunca esteve na Beehiiv — nasceu direto no Kit.
 *
 * O dado não está perdido: o Kit guarda a atribuição NATIVA do form no
 * bloco `attribution`, legível via `GET /v4/subscribers?include[]=attribution`
 * (confirmado ao vivo no #6425 — `referrer`/`source_type`/`source_name`/
 * `source_mechanism` sempre presentes pra quem veio do form; `utm_*` só
 * quando a visita trouxe parâmetro na URL). Isto é recuperação EXATA de um
 * dado que o Kit já tem na mão, não inferência — por isso grava
 * `atribuicao_fonte: "kit-nativo-form"`, distinto de `beehiiv-import`
 * (#6318) e `reconstruido-logs` (#6318 Passo 4). Ver
 * `scripts/lib/kit-attribution.ts` (`buildNativeFormAttributionFields`,
 * `montarPlanoNativo`) pro miolo puro.
 *
 * Nuance importante: um assinante do form sem UTM/referrer na visita
 * (`origemVazia` no plano) NÃO é falha de recuperação — é o form
 * respondendo "esta visita não trouxe atribuição nenhuma", caso legítimo.
 * `semOrigem` é outra população: quem não tem bloco `attribution` NENHUM
 * (tipicamente criado via API, não pelo form) — fora do escopo deste
 * script, candidato do #6318 (`backfill-kit-attribution.ts`) se casar com
 * o snapshot da Beehiiv.
 *
 * **Dry-run por padrão** (mesma convenção de `backfill-kit-attribution.ts`
 * e `sync-apoio-nivel-*.ts`): imprime o plano completo e só escreve com
 * `--push`.
 *
 * Uso:
 *   npx tsx scripts/backfill-kit-native-attribution.ts
 *   npx tsx scripts/backfill-kit-native-attribution.ts --push
 *   npx tsx scripts/backfill-kit-native-attribution.ts --push --limit 20
 *   npx tsx scripts/backfill-kit-native-attribution.ts --push --force
 *
 * Exit codes: 1 erro fatal; 2 config ausente.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { montarPlanoNativo, type KitSubscriberComAtribuicao } from "./lib/kit-attribution.ts";
import { listAllKitSubscribers, updateSubscriberFields } from "./lib/kit-subscribers.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";

/** Mesmo espaçamento de `backfill-kit-attribution.ts` — endpoints
 *  singulares do Kit dão 429 depois de algumas dezenas de chamadas sem
 *  pausa (achado do #6047). */
const REQUEST_SPACING_MS = 350;

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const force = hasFlag(argv, "force");
  const valores = parseCliArgs(argv).values;
  const log = (m: string) => process.stderr.write(`[backfill-kit-native-attribution] ${m}\n`);
  // Mesma semântica de `--limit` do #6318 Passo 0: grava só os N primeiros;
  // idempotência por `atribuicao_fonte` faz a rodada seguinte continuar de
  // onde parou.
  const limite = valores.limit === undefined ? undefined : Number(valores.limit);
  if (limite !== undefined && (!Number.isInteger(limite) || limite <= 0)) {
    log(`ERRO: --limit precisa ser inteiro positivo, recebido "${valores.limit}".`);
    process.exitCode = 2;
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exitCode = 2;
    return;
  }
  const kitConfig = kitConfigResult.config;

  // `status: "all"` inclui cancelados — mesmo racional de
  // `backfill-kit-attribution.ts`: a atribuição de quem cancelou continua
  // valendo pra análise de churn por canal.
  const kitSubs = await listAllKitSubscribers(kitConfig, { status: "all", includeAttribution: true });
  const kit: KitSubscriberComAtribuicao[] = kitSubs.map((s) => ({
    id: s.id,
    email_address: s.email_address,
    fields: s.fields,
    attribution: s.attribution ?? null,
  }));
  log(`base Kit: ${kit.length} subscribers (inclui cancelados)`);

  const plano = montarPlanoNativo(kit, { force });
  log("");
  log(`  a gravar                                    : ${plano.aplicar.length}`);
  log(`  ja tinham atribuicao_fonte (pulados)         : ${plano.jaFeitos}`);
  log(`  sem bloco attribution (criado via API)       : ${plano.semOrigem.length}`);
  log(`  form respondeu sem UTM/referrer (legitimo)   : ${plano.origemVazia.length}`);

  if (!push) {
    log("");
    log("[dry-run] nada gravado. Rode com --push para aplicar.");
    return;
  }

  const aGravar = limite === undefined ? plano.aplicar : plano.aplicar.slice(0, limite);
  if (limite !== undefined) {
    log("");
    log(`[--limit ${limite}] gravando ${aGravar.length} de ${plano.aplicar.length}. ` +
      `Os ${plano.aplicar.length - aGravar.length} restantes ficam pra proxima rodada.`);
  }

  let ok = 0;
  const falhas: { email: string; erro: string }[] = [];
  for (const entry of aGravar) {
    try {
      await updateSubscriberFields(entry.subscriberId, entry.fields, kitConfig);
      ok++;
      if (ok % 50 === 0) log(`  ... ${ok}/${aGravar.length}`);
    } catch (e) {
      falhas.push({ email: entry.email, erro: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

  log("");
  log(`gravados: ${ok}/${aGravar.length}`);
  if (falhas.length > 0) {
    log(`FALHAS: ${falhas.length}`);
    for (const f of falhas.slice(0, 20)) log(`  ${f.email}: ${f.erro}`);
    log("Re-rodar o script reprocessa apenas as falhas (idempotencia por atribuicao_fonte).");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(
      `[backfill-kit-native-attribution] erro fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exitCode = 1;
  });
}
