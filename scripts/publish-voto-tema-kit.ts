#!/usr/bin/env node
/**
 * scripts/publish-voto-tema-kit.ts (#8371)
 *
 * Cria no Kit o broadcast da votação de tema — SEMPRE rascunho
 * (`send_at: null`, `public: false`). Modelado em
 * `publish-artigo-especial-kit.ts`: resolve a audiência por TAG (nunca
 * segmento — ver `scripts/lib/shared/kit-apoio-tag.ts`), relê o broadcast
 * criado pra conferir o `subscriber_filter` aplicado (o 2xx da criação NÃO
 * é prova de que o filtro pegou — #6582/#6126), e recusa seguir se a
 * audiência não confirmar.
 *
 * `--audience eleitorado` (default) manda pra tag `kit_votacao.audience_tag`
 * inteira (abertura da votação). `--audience pendentes` manda só pra
 * `voto-tema-pendente` (lembrete — rode `voto-tema-lembrete.ts --push` antes).
 *
 * O corpo do e-mail (`content`) é montado a partir da cédula gravada no KV —
 * um link por opção, cada um levando `?t={{ subscriber.voto_token }}`
 * (merge tag Liquid). **Fase 0 da #8371 — verificar que o Kit de fato
 * substitui `{{ subscriber.voto_token }}` — não foi executada nesta sessão**
 * (exigiria um test-send real, e o guard de publicação do overnight proíbe
 * qualquer disparo de campanha Kit, mesmo de teste). Antes do 1º uso real,
 * rode o teste decisivo descrito no corpo da #8371.
 *
 * ⚠️ NUNCA remove o guard `--dry-run` por padrão nem adiciona `send_at` —
 * disparo é sempre ação humana no painel do Kit.
 *
 * Uso:
 *   npx tsx scripts/publish-voto-tema-kit.ts --ciclo 2610 --dry-run
 *   npx tsx scripts/publish-voto-tema-kit.ts --ciclo 2610                      # cria rascunho (eleitorado inteiro)
 *   npx tsx scripts/publish-voto-tema-kit.ts --ciclo 2610 --audience pendentes  # rascunho do lembrete
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getStringArg } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { createBroadcast, findTagIdByName, buildTagFilter, type KitSubscriberFilter } from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { APOIO_EXCLUSIVE_PREVIEW_TEXT } from "./lib/shared/apoio-preview-text.ts";
import { parseCicloVotacao, htmlEscapeVotoTema, type BallotTema } from "../workers/artigos/src/voto-tema-core.ts";
import {
  VOTO_TEMA_TAG_SYNC_COMMAND,
  VotoTemaGuardError,
  readBallotFromKv,
  readPlatformConfig,
  resolveVotoTemaKvConfig,
  resolveVotoTemaTagName,
} from "./lib/voto-tema-channel.ts";
import { VOTO_TEMA_PENDENTE_TAG } from "./voto-tema-lembrete.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[publish-voto-tema-kit]";
const ARTIGOS_BASE_URL = "https://especial.diar.ia.br";

export function publishedStatePath(dataDir: string, ciclo: string, audience: "eleitorado" | "pendentes"): string {
  return resolve(dataDir, "artigo-especial", "votacao", ciclo, `published-${audience}.json`);
}

/** Pura — corpo HTML do e-mail: título + 1 botão por opção da cédula, cada
 *  link levando `?t={{ subscriber.voto_token }}`. @pure */
export function renderVotoTemaEmailHtml(ciclo: string, ballot: BallotTema): string {
  const links = ballot.opcoes
    .map(
      (o) =>
        `<p><a href="${ARTIGOS_BASE_URL}/votacao/${ciclo}/${o.n}?t={{ subscriber.voto_token }}" ` +
        `style="display:inline-block;background:#00A0A0;color:#fff;padding:10px 18px;border-radius:8px;` +
        `text-decoration:none;font-weight:600">Votar em "${htmlEscapeVotoTema(o.titulo)}"</a> ` +
        `— ${htmlEscapeVotoTema(o.descricao)}${o.proponente ? ` (sugestão de ${htmlEscapeVotoTema(o.proponente)})` : ""}</p>`,
    )
    .join("\n");
  return `<h1>${htmlEscapeVotoTema(ballot.titulo)}</h1>
<p>Você tem voz no tema do próximo Artigo Especial — escolha uma opção abaixo. Pode trocar seu voto depois, o último clique vale.</p>
${links}
<p><a href="${ARTIGOS_BASE_URL}/votacao/${ciclo}">Ver placar parcial</a></p>`;
}

export interface RunOptions {
  ciclo: string;
  audience: "eleitorado" | "pendentes";
  dataDir: string;
  dryRun: boolean;
  log: (msg: string) => void;
}

export async function run(options: RunOptions): Promise<void> {
  const { ciclo: rawCiclo, audience, dataDir, dryRun, log } = options;
  const ciclo = parseCicloVotacao(rawCiclo);
  if (!ciclo) throw new VotoTemaGuardError(`--ciclo "${rawCiclo}" inválido — precisa ser AAMM.`);

  const kvConfig = resolveVotoTemaKvConfig();
  const ballot = await readBallotFromKv(ciclo, kvConfig);
  if (!ballot) throw new VotoTemaGuardError(`ciclo ${ciclo}: nenhuma cédula gravada — rode voto-tema-open.ts antes.`);

  const platformConfig = readPlatformConfig(ROOT);
  const tagName =
    audience === "eleitorado"
      ? (() => {
          const r = resolveVotoTemaTagName(platformConfig.kit_votacao);
          if (!r.ok) throw new VotoTemaGuardError(r.reason);
          return r.tagName;
        })()
      : VOTO_TEMA_PENDENTE_TAG;

  const html = renderVotoTemaEmailHtml(ciclo, ballot);
  const subject =
    audience === "eleitorado"
      ? `Vote no tema do próximo Artigo Especial`
      : `Ainda dá tempo de votar no tema do próximo Artigo Especial`;

  if (dryRun) {
    log(`[DRY RUN] assunto: ${subject}`);
    log(`[DRY RUN] audiência: tag "${tagName}"`);
    log(`[DRY RUN] ${html.length} bytes de HTML, ${ballot.opcoes.length} opção(ões).`);
    log("[DRY RUN] broadcast que SERIA criado: rascunho (send_at: null), public: false.");
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) throw new VotoTemaGuardError(kitConfigResult.reason);
  const kitConfig: KitConfig = kitConfigResult.config;

  const tagId = await findTagIdByName(tagName, kitConfig);
  if (tagId === null) {
    const syncHint = audience === "eleitorado" ? VOTO_TEMA_TAG_SYNC_COMMAND : "voto-tema-lembrete.ts --push";
    throw new VotoTemaGuardError(`tag "${tagName}" não existe no Kit — rode '${syncHint}' antes.`);
  }

  const filter: KitSubscriberFilter = buildTagFilter(tagId);
  const created = await createBroadcast(
    {
      subject,
      content: html,
      preview_text: APOIO_EXCLUSIVE_PREVIEW_TEXT,
      description: `diar.ia.br votação de tema — ciclo ${ciclo} (${audience})`,
      send_at: null,
      subscriber_filter: filter,
      public: false,
    },
    kitConfig,
  );
  log(`broadcast criado: id=${created.id} (rascunho, tag "${tagName}") — test-send e disparo são ação manual no painel do Kit.`);

  let confirmed = false;
  let reason = "releitura não tentada.";
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const reread = await getBroadcast(created.id, kitConfig);
      confirmed = JSON.stringify(reread.subscriber_filter) === JSON.stringify(filter);
      reason = confirmed ? "" : `subscriber_filter divergente: recebido ${JSON.stringify(reread.subscriber_filter)}.`;
      break;
    } catch (e) {
      reason = `releitura falhou (tentativa ${tentativa}): ${(e as Error).message}`;
    }
  }
  if (!confirmed) log(`AVISO: ${reason} — CONFIRA MANUALMENTE a audiência no painel do Kit antes de qualquer test-send.`);

  writeFileAtomic(
    publishedStatePath(dataDir, ciclo, audience),
    JSON.stringify({ ciclo, audience, broadcastId: created.id, tagName, audienceConfirmed: confirmed, createdAt: new Date().toISOString() }, null, 2) + "\n",
  );

  if (!confirmed) {
    throw new Error(
      `broadcast id=${created.id} FOI CRIADO mas a audiência NÃO foi confirmada — ${reason} NÃO dispare sem conferir manualmente.`,
    );
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const ciclo = getStringArg(argv, "ciclo", { example: "2610" });
  if (!ciclo) {
    process.stderr.write("Uso: npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM [--dry-run|--push] [--audience eleitorado|pendentes]\n");
    process.exit(2);
  }
  const audienceRaw = getStringArg(argv, "audience") ?? "eleitorado";
  if (audienceRaw !== "eleitorado" && audienceRaw !== "pendentes") {
    process.stderr.write(`${LOG_PREFIX} --audience precisa ser "eleitorado" ou "pendentes" (recebeu "${audienceRaw}").\n`);
    process.exit(2);
  }
  try {
    await run({
      ciclo,
      audience: audienceRaw,
      dataDir: resolve(ROOT, "data"),
      dryRun: !hasFlag(argv, "push"),
      log: (msg) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`),
    });
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(e instanceof VotoTemaGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
