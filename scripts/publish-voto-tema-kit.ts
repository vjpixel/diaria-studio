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
 * ⚠️ NUNCA remove o guard `--dry-run` por padrão nem adiciona `send_at` ao
 * broadcast real — disparo pro eleitorado é sempre ação humana no painel do Kit.
 *
 * `--test-send` (#9261) é o teste decisivo da merge tag `voto_token`: garante
 * token (KV `polltoken:` + custom field `voto_token`) para cada membro da tag
 * `diaria-test-email`, cria um broadcast `[TESTE]` filtrado SÓ nessa tag,
 * relê o `subscriber_filter` e, só se ele bater, agenda o envio para daqui a
 * 2 min (`send_at`). Filtro não confirmado → nada é agendado. O link do e-mail
 * de teste deve abrir a página "não pertence ao eleitorado" (403: token
 * substituído e resolvido) — a página de "tag de e-mail não resolvida" (400)
 * significa que o Kit NÃO substituiu a merge tag.
 *
 * `--push` (fora do `--test-send`) exige o marcador `revisado` em
 * `ballot.json`, com hash igual ao texto da cédula local e da do KV (#11199,
 * `scripts/lib/voto-tema-revisao.ts`). Sem ele, recusa antes de tocar o Kit.
 *
 * Uso:
 *   npx tsx scripts/publish-voto-tema-kit.ts --ciclo 2610 --dry-run
 *   npx tsx scripts/publish-voto-tema-kit.ts --ciclo 2610                      # cria rascunho (eleitorado inteiro)
 *   npx tsx scripts/publish-voto-tema-kit.ts --ciclo 2610 --audience pendentes  # rascunho do lembrete
 *   npx tsx scripts/publish-voto-tema-kit.ts --ciclo 2610 --test-send --push    # teste da merge tag (#9261)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getStringArg } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import {
  KIT_TEST_SEND_TAG_NAME,
  buildTagFilter,
  buildTestSendFilter,
  createBroadcast,
  findTagIdByName,
  updateBroadcast,
  type CreateBroadcastInput,
  type KitSubscriberFilter,
} from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { fetchTagMembers } from "./lib/kit-apoio-tag-sync.ts";
import type { KitTagMember } from "./lib/shared/kit-apoio-tag.ts";
import { updateSubscriberFields } from "./lib/kit-subscribers.ts";
import { computePollToken } from "./lib/shared/poll-token.ts";
import { putTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { APOIO_EXCLUSIVE_PREVIEW_TEXT } from "./lib/shared/apoio-preview-text.ts";
import { BOX, COLORS, FONTS, LAYOUT } from "./lib/shared/design-tokens.ts";
import { tealDot } from "./lib/shared/email-components.ts";
import { parseCicloVotacao, htmlEscapeVotoTema, formatPrazo, pollTokenKvKeyMirror, type BallotTema } from "../workers/artigos/src/voto-tema-core.ts";
import {
  VOTO_TEMA_TAG_SYNC_COMMAND,
  VotoTemaGuardError,
  readBallotFromKv,
  readPlatformConfig,
  resolveVotoTemaKvConfig,
  resolveVotoTemaTagName,
} from "./lib/voto-tema-channel.ts";
import { VOTO_TEMA_PENDENTE_TAG } from "./voto-tema-lembrete.ts";
import { ballotInputPath } from "./voto-tema-open.ts";
import { checkRevisao, type CedulaTexto, type RevisaoCheck } from "./lib/voto-tema-revisao.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[publish-voto-tema-kit]";
const ARTIGOS_BASE_URL = "https://especial.diar.ia.br";

export function publishedStatePath(dataDir: string, ciclo: string, audience: "eleitorado" | "pendentes" | "teste"): string {
  return resolve(dataDir, "artigo-especial", "votacao", ciclo, `published-${audience}.json`);
}

/** Pura — corpo HTML do e-mail: kicker + título + prazo (painel bege) + 1
 *  card contorno por opção da cédula, cada botão levando
 *  `?t={{ subscriber.voto_token }}`. Tabelas com estilo inline e tokens do DS
 *  (teal só como texto: ponto do kicker + link do placar; botão cheio em ink
 *  numa célula de tabela, pro Outlook manter padding; font-size ∈ {12,16,22,26}). @pure */
export function renderVotoTemaEmailHtml(ciclo: string, ballot: BallotTema): string {
  const sans = `font-family:${FONTS.sans};`;
  const serif = `font-family:${FONTS.serif};`;
  const ink = `color:${COLORS.ink};`;
  const kicker = (txt: string) =>
    `<p style="margin:0 0 8px;${sans}font-size:12px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;${ink}">${tealDot()} ${txt}</p>`;
  const cards = ballot.opcoes
    .map(
      (o) =>
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 16px;border:1px solid ${BOX.contornoBorder};border-radius:8px;background:${COLORS.paperEmail};">` +
        `<tr><td style="padding:24px;">` +
        kicker(`Opção ${o.n}`) +
        `<p style="margin:0 0 8px;${serif}font-size:22px;line-height:28px;font-weight:700;${ink}">${htmlEscapeVotoTema(o.titulo)}</p>` +
        `<p style="margin:0 0 20px;${sans}font-size:16px;line-height:24px;${ink}">${htmlEscapeVotoTema(o.descricao)}` +
        `${o.proponente ? ` <em>Sugestão de ${htmlEscapeVotoTema(o.proponente)}.</em>` : ""}</p>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td bgcolor="${COLORS.ink}" style="background:${COLORS.ink};border-radius:8px;padding:14px 24px;">` +
        `<a href="${ARTIGOS_BASE_URL}/votacao/${ciclo}/${o.n}?t={{ subscriber.voto_token }}" ` +
        `aria-label="Votar em ${htmlEscapeVotoTema(o.titulo)}" ` +
        `style="color:${COLORS.onInk};${sans}font-size:16px;line-height:16px;font-weight:600;text-decoration:none;">Votar neste tema</a>` +
        `</td></tr></table>` +
        `</td></tr></table>`,
    )
    .join("\n");
  // #9260: prazo no e-mail — no ciclo 2609 ele ficou de fora e ninguém sabia até quando votar.
  const prazoFmt = formatPrazo(ballot.prazo);
  const prazoBox = prazoFmt
    ? `\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;background:${BOX.painelBg};border-radius:8px;">` +
      `<tr><td style="padding:12px 16px;${sans}font-size:16px;line-height:24px;${ink}"><strong>Prazo para votar: ${htmlEscapeVotoTema(prazoFmt)}.</strong></td></tr></table>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${LAYOUT.containerWidth}px;margin:0 auto;"><tr><td>
${kicker("Artigo Especial · Votação")}
<h1 style="margin:0 0 16px;${serif}font-size:26px;line-height:32px;font-weight:700;${ink}">${htmlEscapeVotoTema(ballot.titulo)}</h1>
<p style="margin:0 0 20px;${sans}font-size:16px;line-height:24px;${ink}">Você escolhe o tema do próximo Artigo Especial. É só clicar no botão da opção que preferir. Se mudar de ideia, clique em outra: vale o último voto.</p>${prazoBox}
${cards}
<p style="margin:12px 0 0;${sans}font-size:16px;line-height:24px;${ink}">Quer acompanhar? <a href="${ARTIGOS_BASE_URL}/votacao/${ciclo}" style="color:${COLORS.brand};font-weight:600;">Ver placar parcial</a></p>
</td></tr></table>`;
}

/** Atraso do envio agendado do `--test-send` — curto o bastante pra conferir
 *  na hora, longo o bastante pro Kit aceitar o agendamento. */
export const TEST_SEND_DELAY_MS = 2 * 60 * 1000;
const KIT_VOTO_TOKEN_FIELD = "voto_token";

/** I/O injetável do `--test-send` — produção usa os clientes reais; o teste
 *  passa mocks (nunca toca Kit/KV de verdade). */
export interface TestSendDeps {
  findTagIdByName: (name: string) => Promise<number | null>;
  fetchTagMembers: (tagId: number) => Promise<KitTagMember[]>;
  computeToken: (email: string) => Promise<string>;
  putKv: (key: string, value: string) => Promise<void>;
  updateSubscriberFields: (id: number, fields: Record<string, string>) => Promise<void>;
  createBroadcast: (input: CreateBroadcastInput) => Promise<{ id: number }>;
  getBroadcast: (id: number) => Promise<{ subscriber_filter?: unknown }>;
  updateBroadcast: (id: number, input: { send_at: string }) => Promise<unknown>;
  now: () => Date;
}

export interface TestSendResult {
  broadcastId: number;
  tagId: number;
  members: number;
  sendAt: string;
}

/**
 * #9261 — teste decisivo da merge tag `{{ subscriber.voto_token }}`. Ordem:
 * tag de teste resolvida (sem criar — tag vazia/inexistente é erro) → token
 * por membro (KV ANTES do Kit, mesmo racional de `voto-tema-open.ts`) →
 * broadcast `[TESTE]` como rascunho → releitura do `subscriber_filter` →
 * só então `send_at`. Filtro divergente ou releitura falha = nada agendado.
 */
export async function runTestSend(
  ciclo: string,
  ballot: BallotTema,
  deps: TestSendDeps,
  log: (msg: string) => void,
): Promise<TestSendResult> {
  const tagId = await deps.findTagIdByName(KIT_TEST_SEND_TAG_NAME);
  if (tagId === null) {
    throw new VotoTemaGuardError(`tag "${KIT_TEST_SEND_TAG_NAME}" não existe no Kit — crie-a com o e-mail de teste antes.`);
  }
  const members = await deps.fetchTagMembers(tagId);
  if (members.length === 0) {
    throw new VotoTemaGuardError(`tag "${KIT_TEST_SEND_TAG_NAME}" (id=${tagId}) está vazia — nada a testar.`);
  }

  for (const m of members) {
    const token = await deps.computeToken(m.email);
    await deps.putKv(pollTokenKvKeyMirror(token), m.email);
    await deps.updateSubscriberFields(m.id, { [KIT_VOTO_TOKEN_FIELD]: token });
  }
  log(`token "${KIT_VOTO_TOKEN_FIELD}" garantido para ${members.length} membro(s) de "${KIT_TEST_SEND_TAG_NAME}".`);

  const filter = buildTestSendFilter(tagId);
  const created = await deps.createBroadcast({
    subject: `[TESTE] Vote no tema do próximo Artigo Especial`,
    content: renderVotoTemaEmailHtml(ciclo, ballot),
    preview_text: APOIO_EXCLUSIVE_PREVIEW_TEXT,
    description: `diar.ia.br votação de tema — ciclo ${ciclo} (test-send da merge tag voto_token, #9261)`,
    send_at: null,
    subscriber_filter: filter,
    public: false,
  });

  let reread: { subscriber_filter?: unknown };
  try {
    reread = await deps.getBroadcast(created.id);
  } catch (e) {
    throw new Error(
      `broadcast de teste id=${created.id} criado como RASCUNHO, mas a releitura falhou (${(e as Error).message}) — NÃO foi agendado.`,
    );
  }
  if (JSON.stringify(reread.subscriber_filter) !== JSON.stringify(filter)) {
    throw new Error(
      `broadcast de teste id=${created.id} criado como RASCUNHO com subscriber_filter divergente ` +
        `(${JSON.stringify(reread.subscriber_filter)}) — NÃO foi agendado. Apague-o no painel do Kit.`,
    );
  }

  const sendAt = new Date(deps.now().getTime() + TEST_SEND_DELAY_MS).toISOString();
  await deps.updateBroadcast(created.id, { send_at: sendAt });
  log(
    `broadcast de teste id=${created.id} agendado para ${sendAt} (só tag "${KIT_TEST_SEND_TAG_NAME}"). ` +
      'Ao clicar, a página esperada é "não pertence ao eleitorado" (token substituído); "tag de e-mail não resolvida" = merge tag falhou.',
  );
  return { broadcastId: created.id, tagId, members: members.length, sendAt };
}

/**
 * #11199 — confere o marcador `revisado` (Humanizador + Clarice) de
 * `ballot.json` contra o texto da cédula local e o da cédula do KV, que é a
 * renderizada no e-mail. Lê o arquivo; a regra em si é `checkRevisao`.
 */
export function checkCedulaRevisada(dataDir: string, ciclo: string, kvBallot: CedulaTexto): RevisaoCheck {
  const path = ballotInputPath(dataDir, ciclo);
  const local = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CedulaTexto & { revisado?: unknown }) : null;
  return checkRevisao(local, kvBallot);
}

export interface RunOptions {
  ciclo: string;
  audience: "eleitorado" | "pendentes";
  dataDir: string;
  dryRun: boolean;
  /** #9261: em vez do broadcast real, roda `runTestSend`. */
  testSend?: boolean;
  log: (msg: string) => void;
}

export async function run(options: RunOptions): Promise<void> {
  const { ciclo: rawCiclo, audience, dataDir, dryRun, testSend, log } = options;
  const ciclo = parseCicloVotacao(rawCiclo);
  if (!ciclo) throw new VotoTemaGuardError(`--ciclo "${rawCiclo}" inválido — precisa ser AAMM.`);

  const kvConfig = resolveVotoTemaKvConfig();
  const ballot = await readBallotFromKv(ciclo, kvConfig);
  if (!ballot) throw new VotoTemaGuardError(`ciclo ${ciclo}: nenhuma cédula gravada — rode voto-tema-open.ts antes.`);

  if (testSend) {
    if (dryRun) {
      log(`[DRY RUN] test-send: tokens para os membros de "${KIT_TEST_SEND_TAG_NAME}", broadcast [TESTE] filtrado nessa tag,`);
      log(`[DRY RUN] releitura do filtro e agendamento para +${TEST_SEND_DELAY_MS / 60000} min. Rode com --push para executar.`);
      return;
    }
    const kitResult = resolveKitConfig();
    if (!kitResult.ok) throw new VotoTemaGuardError(kitResult.reason);
    const kc: KitConfig = kitResult.config;
    const pollSecret = process.env.POLL_SECRET;
    if (!pollSecret) throw new VotoTemaGuardError("POLL_SECRET ausente — necessário pra calcular o token de voto.");
    const result = await runTestSend(
      ciclo,
      ballot,
      {
        findTagIdByName: (name) => findTagIdByName(name, kc),
        fetchTagMembers: (id) => fetchTagMembers(id, kc),
        computeToken: (email) => computePollToken(pollSecret, email),
        putKv: async (key, value) => {
          await putTextToWorkerKV(key, value, kvConfig);
        },
        updateSubscriberFields: async (id, fields) => {
          await updateSubscriberFields(id, fields, kc);
        },
        createBroadcast: (input) => createBroadcast(input, kc),
        getBroadcast: (id) => getBroadcast(id, kc),
        updateBroadcast: (id, input) => updateBroadcast(id, input, kc),
        now: () => new Date(),
      },
      log,
    );
    writeFileAtomic(
      publishedStatePath(dataDir, ciclo, "teste"),
      JSON.stringify({ ciclo, audience: "teste", ...result, createdAt: new Date().toISOString() }, null, 2) + "\n",
    );
    return;
  }

  const platformConfig = readPlatformConfig(ROOT);
  const tagName =
    audience === "eleitorado"
      ? (() => {
          const r = resolveVotoTemaTagName(platformConfig.kit_votacao);
          if (!r.ok) throw new VotoTemaGuardError(r.reason);
          return r.tagName;
        })()
      : VOTO_TEMA_PENDENTE_TAG;

  // #11199: rascunho real (eleitorado ou lembrete) só com a cédula revisada.
  // O --test-send fica de fora: vai só pra tag de teste e prova a merge tag.
  const revisao = checkCedulaRevisada(dataDir, ciclo, ballot);
  if (!revisao.ok) {
    if (!dryRun) throw new VotoTemaGuardError(`revisão de texto pendente: ${revisao.reason}`);
    log(`[DRY RUN] AVISO: --push vai recusar — ${revisao.reason}`);
  }

  const html = renderVotoTemaEmailHtml(ciclo, ballot);
  const subject =
    audience === "eleitorado"
      ? `Vote no tema do próximo Artigo Especial`
      : `Ainda dá tempo de votar no tema do próximo Artigo Especial`;

  if (dryRun) {
    log(`[DRY RUN] assunto: ${subject}`);
    log(`[DRY RUN] audiência: tag "${tagName}"`);
    log(`[DRY RUN] ${html.length} bytes de HTML, ${ballot.opcoes.length} opção(ões).`);
    if (revisao.ok) log(`[DRY RUN] cédula revisada (Humanizador + Clarice) em ${revisao.marker.em}.`);
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
    process.stderr.write("Uso: npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM [--dry-run|--push] [--audience eleitorado|pendentes] [--test-send]\n");
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
      testSend: hasFlag(argv, "test-send"),
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
