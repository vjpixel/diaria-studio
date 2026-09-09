#!/usr/bin/env node
/**
 * scripts/build-apoiador-allowlist.ts (#3940)
 *
 * Constrói a allowlist de e-mails com direito à **Retrospectiva do Mês** — o
 * recap mensal servido por `workers/artigo-mensal` (`artigo.diar.ia.br`).
 * Limiar: Mantenedor R$25+/mês do mês vigente (ver `RETROSPECTIVA_DO_MES_NIVEIS`
 * abaixo; era R$10+ até o #7658, que alinhou o gate à recompensa anunciada).
 *
 * NÃO reimplementa a checagem de apoio: reusa a MESMA maquinaria já testada
 * do painel Apoios (`scripts/studio-ui/studio-apoios.ts`) —
 * `buildApoiosData` (loadContacts + fetchCurrentStatuses/checkBacker +
 * deriveContactStatus, tudo já fail-soft em 3 camadas) e `computeRewardGroup`
 * (fonte única da correspondência valor→nível). A ÚNICA lógica nova aqui é
 * `computeApoiadorAllowlist` — pura, filtra `ContactWithStatus[]` já
 * resolvido pra a lista de e-mails que qualificam.
 *
 * Uso:
 *   npx tsx scripts/build-apoiador-allowlist.ts [--out <path>] [--push] [--allow-partial] [--force-blast-radius]
 *
 * Sem `--out`: imprime o JSON (array de e-mails) em stdout.
 * `--push` (+ credenciais Cloudflare no env): grava no KV `ALLOWLIST` via
 * `uploadTextToWorkerKV` — mesmo padrão de `scripts/clarice-db-summary.ts`.
 * Recusa o push (fail-closed) se `buildApoiosData` reportou erro (data/
 * ausente, credenciais apoia.se ausentes, 401) — uma allowlist parcial
 * nunca é gravada por cima da anterior.
 *
 * **Falha transiente POR CONTATO (#3965, follow-up do #3940/PR #3964):**
 * `data.error` (acima) só cobre falha TOTAL — `buildApoiosData` é fail-soft
 * em 3 camadas e uma falha pontual de `checkBacker` pra 1 e-mail específico
 * (hiccup de rede, não-auth) nunca vira esse `data.error` de nível superior:
 * o contato afetado só cai com `status.label === "sem_dados"` internamente
 * (distinto de `"nao_apoia"`, que é resultado válido — consultado com
 * sucesso, não paga este mês) e o restante segue normal. Sem o guard
 * abaixo, `--push` prosseguiria e aquele apoiador real ficaria
 * silenciosamente FORA da allowlist gravada. `findTransientFailureContacts`
 * detecta esses contatos; por padrão o `--push` é recusado (fail-closed,
 * mesmo padrão do `data.error`) — `--allow-partial` é o escape hatch
 * explícito pra prosseguir mesmo assim (ex: 1-2 falhas pontuais em centenas
 * de contatos, cenário onde recusar sempre tornaria o push impraticável),
 * sempre logando os e-mails afetados.
 *
 * **Guard de blast radius (#7688):** antes do push, o script LÊ a allowlist
 * atual do KV e compara. Se as remoções passarem de 30%
 * (`APOIO_TAG_BLAST_RADIUS_THRESHOLD`, o mesmo limiar dos 4 syncs de audiência
 * vizinhos), recusa o push inteiro e lista QUEM sai — `--force-blast-radius` é
 * a decisão consciente. Falha na LEITURA também recusa, pela mesma razão:
 * sem o estado anterior o guard não roda, e sobrescrever às cegas é o que esta
 * issue fechou. Até o #7688 o script tinha guard para dado FALTANDO
 * (`data.error`, `findTransientFailureContacts`) e nenhum para dado que
 * ENCOLHEU — medido ao vivo em 08/09/2026, quando o push do limiar novo levou
 * a allowlist de 21 para 10 sem nenhum aviso proporcional. Quem sai perde
 * acesso às Retrospectivas do Mês já publicadas.
 *
 * HISTÓRICO (#3940 → #7580): `--push` nunca tinha sido executado, e o
 * namespace era um literal `REPLACE_ME_...`. Em 07/09/2026 a allowlist foi
 * publicada pela primeira vez (21 apoiadores, contra `contacts.jsonl` real) —
 * até então o KV estava VAZIO, e o fail-closed do gate recusava todo mundo,
 * apoiador incluído. O namespace agora é lido do `wrangler.toml` (ver
 * `apoiadorAllowlistKvNamespaceId` abaixo).
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { buildApoiosData, computeRewardGroup, type ContactWithStatus, type RewardGroup } from "./studio-ui/studio-apoios.ts";
import { uploadTextToWorkerKV, getTextFromWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { readArtigoMensalNamespaceId } from "./lib/mensal/artigo-mensal-kv-namespaces.ts";
import {
  diffTagMembership,
  evaluateTagBlastRadius,
  APOIO_TAG_BLAST_RADIUS_THRESHOLD,
} from "./lib/shared/kit-apoio-tag.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

/**
 * Namespace KV do binding `ALLOWLIST`, lido de
 * `workers/artigo-mensal/wrangler.toml` — a MESMA fonte que o `wrangler deploy`
 * consome.
 *
 * Função, e não `const` de módulo: a leitura acontece só no caminho que grava.
 * Como `const` ela rodava no IMPORT, acoplando qualquer uso deste arquivo
 * (dry-run, teste que importe um helper daqui) à existência e ao formato do
 * `wrangler.toml`, com exceção de carga de módulo antes de qualquer tratamento
 * de erro do `main()`. Mesma disciplina do `loadProjectEnv`, que já é escopado
 * ao push (achado do review da PR #7592).
 */
export function apoiadorAllowlistKvNamespaceId(): string {
  return readArtigoMensalNamespaceId("ALLOWLIST");
}

/** Chave única do KV ALLOWLIST — valor é o JSON array de e-mails. */
export const APOIADOR_ALLOWLIST_KV_KEY = "emails";

/**
 * Níveis que têm direito à **Retrospectiva do Mês** — o recap mensal servido em
 * `artigo.diar.ia.br/{ciclo}` (futuramente `retrospectiva.diar.ia.br/AAMM`,
 * #7658).
 *
 * **Corrigido de R$10+ para R$25+ em 08/09/2026 (#7658).** A página pública
 * da campanha vende a Retrospectiva do Mês como recompensa de **Mantenedor
 * (R$25/mês)** — transcrito da apoia.se: "🚀 Mantenedor — R$ 25/mês […]
 * Retrospectiva do Mês - Recap conectando os principais acontecimentos do último
 * mês. Enviado na primeira semana do mês." O que o Apoiador (R$10) compra é
 * outra coisa: o **Artigo Especial**, servido por `especial.diar.ia.br`
 * (`workers/artigos`, limiar próprio em `apoio-gate-config.ts`, que segue
 * correto em R$10+).
 *
 * O gate daqui nasceu em R$10+ (#3940, "paywall de apoiador R$10+") e nunca
 * acompanhou a recompensa anunciada — quem apoiava com R$10 lia na web um
 * conteúdo vendido como exclusivo de Mantenedor, esvaziando a diferença entre
 * os dois níveis. Não era acesso negado indevidamente; era o contrário.
 *
 * O canal de E-MAIL do mesmo recap (`/diaria-mensal-apoiadores`) já mirava
 * Mantenedor/Patrono desde sempre — esta constante é o que faz web e e-mail
 * finalmente concordarem.
 *
 * Mudar o limiar é mudar ESTA lista, e nada mais.
 */
export const RETROSPECTIVA_DO_MES_NIVEIS: readonly RewardGroup[] = ["mantenedor", "patrono"];

/**
 * Pure: filtra contatos com status "apoiando" no mês corrente E nível dentro
 * de `RETROSPECTIVA_DO_MES_NIVEIS` (Mantenedor/Patrono, R$25+). Cada contato pode ter
 * múltiplos e-mails cadastrados (#3500) — TODOS entram na allowlist, não só
 * o e-mail que casou com a apoia.se, pra que o apoiador consiga logar com
 * qualquer um dos e-mails que ele mesmo cadastrou.
 *
 * Retorna lista ordenada, deduplicada, sem I/O — caller decide o que fazer
 * com o resultado (imprimir, gravar em arquivo, ou push pro KV).
 */
export function computeApoiadorAllowlist(contacts: ContactWithStatus[]): string[] {
  const emails = new Set<string>();
  for (const c of contacts) {
    if (c.status.label !== "apoiando") continue;
    const group = computeRewardGroup(c.status.monthlyValue);
    if (group === null || !RETROSPECTIVA_DO_MES_NIVEIS.includes(group)) continue;
    for (const email of c.emails) emails.add(email);
  }
  return [...emails].sort();
}

/**
 * Pure: filtra contatos com falha TRANSIENTE de `checkBacker` — status
 * `"sem_dados"`, atribuído por `buildApoiosData`/`deriveContactStatus` quando
 * pelo menos 1 e-mail do contato nunca recebeu resposta definitiva do mês
 * corrente nesta rodada (rede, timeout, erro pontual não-auth). Distinto de
 * `"nao_apoia"` (resultado válido: consultado com sucesso, não paga este
 * mês) — nunca confundir os dois (#3965).
 *
 * Usado como guard PRÉ-`--push`: se não-vazio, o caller decide entre
 * recusar (default) ou prosseguir explicitamente via `--allow-partial`,
 * sempre logando os e-mails retornados.
 */
export function findTransientFailureContacts(contacts: ContactWithStatus[]): ContactWithStatus[] {
  return contacts.filter((c) => c.status.label === "sem_dados");
}

// ── guard de blast radius (#7688) ─────────────────────────────────────────

/**
 * Pura: lê o JSON gravado no KV e devolve a allowlist ATUAL.
 *
 * `null` (chave ausente — 1º push de todos) vira `[]`, que é a leitura certa:
 * ninguém tinha acesso, então não há remoção possível e o guard nunca bloqueia
 * a primeira escrita.
 *
 * Conteúdo que não é um array de strings LANÇA em vez de virar `[]`: tratar
 * lixo como "lista vazia" transformaria uma leitura corrompida em "0 remoções",
 * que é exatamente o silêncio que este guard existe pra impedir.
 *
 * @pure
 */
export function parseCurrentAllowlist(raw: string | null): string[] {
  if (raw === null) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `a allowlist atual no KV não é JSON válido (${(e as Error).message}) — recusando comparar contra ela. ` +
        "Conferir a chave 'emails' no namespace ALLOWLIST antes de sobrescrever.",
    );
  }
  if (!Array.isArray(parsed) || parsed.some((e) => typeof e !== "string")) {
    throw new Error(
      "a allowlist atual no KV não é um array de strings — recusando comparar contra ela. " +
        "Conferir a chave 'emails' no namespace ALLOWLIST antes de sobrescrever.",
    );
  }
  return parsed as string[];
}

export interface AllowlistBlastRadius {
  entram: string[];
  saem: string[];
  inalterados: string[];
  blocked: boolean;
  ratio: number;
  currentCount: number;
}

/**
 * Pura: quem entra, quem sai, e se a proporção de saídas passa do limiar.
 *
 * Reusa `diffTagMembership`/`evaluateTagBlastRadius` (`lib/shared/kit-apoio-tag.ts`,
 * #7659) em vez de reimplementar: é a MESMA pergunta que os 4 syncs de
 * audiência vizinhos já fazem, com o mesmo limiar de 30%, e ter duas respostas
 * diferentes pra ela seria a origem do próximo bug.
 *
 * @pure
 */
export function evaluateAllowlistBlastRadius(
  next: readonly string[],
  current: readonly string[],
  force: boolean,
): AllowlistBlastRadius {
  const diff = diffTagMembership(next, current);
  // Denominador DEDUPLICADO/normalizado, não `current.length` cru: o numerador
  // (`toRemove`) já sai de um `Set` normalizado dentro de `diffTagMembership`,
  // e misturar as duas contagens diluiria a razão — uma allowlist com e-mails
  // repetidos (só alcançável por uma escrita forçada/à mão anterior, já que
  // `computeApoiadorAllowlist` sempre deduplica) faria o guard bloquear MENOS
  // do que deveria. Achado do review da #7688.
  const currentCount = new Set(current.map((e) => e.trim().toLowerCase()).filter(Boolean)).size;
  const blast = evaluateTagBlastRadius(diff.toRemove.length, currentCount, force);
  return {
    entram: diff.toAdd,
    saem: diff.toRemove,
    inalterados: diff.unchanged,
    blocked: blast.blocked,
    ratio: blast.ratio,
    currentCount: blast.currentCount,
  };
}

/**
 * Decisão de push, com a leitura do KV injetada — é ESTE o miolo do #7688
 * (ler o estado anterior antes de sobrescrever), e ele fica fora de `main()`
 * justamente pra ser testável: a 1ª versão desta PR só tinha teste das funções
 * puras, deixando sem cobertura o caminho que a issue chama de correção
 * (achado do code-reviewer).
 *
 * Três desfechos, e o terceiro existe pra não mentir no log:
 *   - `refuse` — leitura falhou sem `--force-blast-radius`, ou queda acima do
 *     limiar. Nada é escrito.
 *   - `push` — comparado de verdade; `blast` traz quem entra e quem sai.
 *   - `push-unverified` — a leitura falhou e o editor forçou. Grava, mas SEM
 *     diff: reportar "-0 saem (atual: 0)" aqui pareceria autoritativo e diria
 *     o oposto da verdade (as remoções reais são desconhecidas) — justamente
 *     no cenário em que o operador mais precisa saber que não sabe.
 */
export type AllowlistPushDecision =
  | { action: "refuse"; reason: string }
  | { action: "push"; blast: AllowlistBlastRadius }
  | { action: "push-unverified"; reason: string };

export async function decideAllowlistPush(opts: {
  next: readonly string[];
  force: boolean;
  readCurrent: () => Promise<string | null>;
}): Promise<AllowlistPushDecision> {
  let current: string[];
  try {
    current = parseCurrentAllowlist(await opts.readCurrent());
  } catch (e) {
    if (!opts.force) {
      return {
        action: "refuse",
        reason:
          `não foi possível ler a allowlist ATUAL do KV pra comparar (${(e as Error).message}). Sem essa ` +
          "leitura o guard de blast radius não tem como rodar, e sobrescrever às cegas é justamente o que o " +
          "#7688 fechou. Re-tente, ou use --force-blast-radius pra gravar assumindo o risco (sempre logado).",
      };
    }
    return {
      action: "push-unverified",
      reason:
        `leitura da allowlist atual falhou (${(e as Error).message}), mas --force-blast-radius foi passado — ` +
        "gravando SEM comparação prévia. As remoções desta escrita são DESCONHECIDAS.",
    };
  }

  const blast = evaluateAllowlistBlastRadius(opts.next, current, opts.force);
  if (blast.blocked) {
    return {
      action: "refuse",
      reason:
        `${blast.saem.length}/${blast.currentCount} remoções (${(blast.ratio * 100).toFixed(1)}%) — acima do ` +
        `limiar de ${(APOIO_TAG_BLAST_RADIUS_THRESHOLD * 100).toFixed(0)}%. Quem sai perde acesso às ` +
        "Retrospectivas do Mês já publicadas, então uma queda desse tamanho precisa ser confirmada, não " +
        "aplicada por inércia: confira se não é leitura parcial do apoia.se/virada de mês. Se a queda for " +
        "REAL (ex: mudança de limiar), use --force-blast-radius.",
    };
  }
  return { action: "push", blast };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(REPO_ROOT);

  const data = await buildApoiosData(REPO_ROOT);
  const allowlist = computeApoiadorAllowlist(data.contacts);
  const payload = JSON.stringify(allowlist);

  const outPath = getArg(argv, "out");
  if (outPath) {
    writeFileSync(resolve(REPO_ROOT, outPath), payload, "utf-8");
    console.error(`[build-apoiador-allowlist] gravado em ${outPath} (${allowlist.length} e-mails)`);
  } else {
    console.log(payload);
  }

  if (data.error) {
    console.error(
      `[build-apoiador-allowlist] aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}`,
    );
  }

  if (hasFlag(argv, "push")) {
    if (data.error) {
      console.error(
        "[build-apoiador-allowlist] RECUSANDO --push: dados de apoio incompletos/indisponíveis " +
          "(ver aviso acima) — nunca sobrescreve a allowlist do KV com dado parcial.",
      );
      process.exit(1);
      return;
    }

    const transientFailures = findTransientFailureContacts(data.contacts);
    if (transientFailures.length > 0) {
      const affectedEmails = transientFailures.flatMap((c) => c.emails).sort();
      if (!hasFlag(argv, "allow-partial")) {
        console.error(
          `[build-apoiador-allowlist] RECUSANDO --push: ${transientFailures.length} contato(s) com falha ` +
            'TRANSIENTE de checkBacker (status "sem_dados" — distinto de "não apoia", que é resultado ' +
            "válido) — allowlist parcial nunca sobrescreve a anterior silenciosamente. E-mail(s) afetado(s): " +
            `${affectedEmails.join(", ")}. Re-tente, ou use --allow-partial pra prosseguir mesmo assim ` +
            "(decisão consciente do editor, sempre logada).",
        );
        process.exit(1);
        return;
      }
      console.error(
        `[build-apoiador-allowlist] aviso: prosseguindo com --allow-partial apesar de ${transientFailures.length} ` +
          `contato(s) com falha transiente de checkBacker. E-mail(s) afetado(s): ${affectedEmails.join(", ")}.`,
      );
    }

    const kvNamespaceId = apoiadorAllowlistKvNamespaceId();

    // #7688: LER antes de escrever por cima. Até aqui o script era o único
    // sync de audiência do projeto sem guard de blast radius — e nem sequer
    // consultava o estado anterior, então uma leitura parcial do apoia.se que
    // derrubasse metade dos apoiadores seria aplicada sem nada acusar.
    const decision = await decideAllowlistPush({
      next: allowlist,
      force: hasFlag(argv, "force-blast-radius"),
      readCurrent: () => getTextFromWorkerKV(APOIADOR_ALLOWLIST_KV_KEY, { kvNamespaceId }),
    });

    if (decision.action === "refuse") {
      console.error(`[build-apoiador-allowlist] RECUSANDO --push: ${decision.reason}`);
      process.exit(1);
      return;
    }

    if (decision.action === "push-unverified") {
      // Sem diff aqui de propósito — ver `decideAllowlistPush`.
      console.error(`[build-apoiador-allowlist] aviso: ${decision.reason}`);
    } else {
      const { blast } = decision;
      console.error(
        `[build-apoiador-allowlist] diff vs KV: +${blast.entram.length} entram · -${blast.saem.length} saem · ` +
          `${blast.inalterados.length} já corretos (allowlist atual: ${blast.currentCount}).`,
      );
      // Lista explícita, como os syncs vizinhos — quem revisa precisa ver QUEM
      // perde acesso, não só quantos.
      for (const e of blast.entram) console.error(`[build-apoiador-allowlist]   + ${e}`);
      for (const e of blast.saem) console.error(`[build-apoiador-allowlist]   - ${e}`);
    }

    console.error(
      `[build-apoiador-allowlist] --push: enviando ${allowlist.length} e-mail(s) pro KV ALLOWLIST...`,
    );
    await uploadTextToWorkerKV(payload, APOIADOR_ALLOWLIST_KV_KEY, {
      kvNamespaceId,
      contentType: "application/json",
    });
    console.error(`[build-apoiador-allowlist] push concluído.`);
  } else {
    console.error(
      `[build-apoiador-allowlist] dry-run (default) — ${allowlist.length} e-mail(s) computados, ` +
        "NENHUM push ao KV. Use --push para gravar.",
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-apoiador-allowlist: erro fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
