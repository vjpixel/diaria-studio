/**
 * plan-path-resolution.ts (#6328)
 *
 * Miolo PURO e genérico do resolvedor de colisão de `plan.json` — extraído
 * de `scripts/lib/develop-plan-collision.ts` (#6265, que resolvia isto só
 * pro `/diaria-develop`) para ser compartilhado com `/diaria-overnight`
 * (#6328). Parametrizado pelo diretório base (`data/develop` vs
 * `data/overnight`) — a lógica em si nunca dependeu de nada específico do
 * develop, só o naming dos tipos/CLI original sugeria isso.
 *
 * ## Por que o overnight também precisa disto (#6328)
 *
 * `data/overnight/{AAMMDD}/plan.json` é chaveado só por data — sem
 * `session_id` no path — exatamente como o `plan.json` do develop era antes
 * do #6265. A diferença que faz o caso do overnight **mais grave**, não
 * menos: ele roda DESASSISTIDO. Uma 2ª máquina que rode `/diaria-overnight`
 * no mesmo dia (`data/` é o MESMO OneDrive entre máquinas, ver CLAUDE.md §
 * Setup) encontra o `plan.json` que a 1ª máquina escreveu e, com a checagem
 * antiga (`existsSync` puro, "existe → é retomada"), conclui erroneamente
 * que é ela mesma continuando — **pulando o briefing** e escrevendo por
 * cima do plano da rodada viva, sem alarme e sem ninguém acordado para
 * notar (issue #6328, achado ao vivo em 26/08/2026 quando o editor
 * perguntou "se eu rodar numa 2ª máquina, ela sabe que deve usar sufixo
 * diferente?" — resposta correta antes deste módulo: só se alguém
 * lembrar).
 *
 * ## Escolha de desenho: escrita defensiva por `session_id`, não lock
 *
 * Ver o docblock original de `scripts/lib/develop-plan-collision.ts` (#6265)
 * para o racional completo (lock `O_CREAT|O_EXCL` descartado porque
 * `data/` é uma junction OneDrive cross-máquina onde esse tipo de lock é só
 * *advisory*, #6182; recusa dura sem fallback descartada porque obrigaria
 * parar e esperar humano pra escolher um sufixo que o mecanismo já sabe
 * derivar sozinho). O discriminador é `session_id` — não `machine_id`:
 * duas sessões em MÁQUINAS diferentes já têm `session_id` diferentes por
 * construção (o harness gera um por sessão, nunca reaproveitado entre
 * processos), então a checagem por `session_id` já cobre o caso
 * cross-máquina sem precisar comparar `machine_id` explicitamente — o
 * campo `machine_id` gravado no `plan.json` (ver `scripts/lib/machine-id.ts`)
 * é consumido por quem PRECISA saber "de qual máquina veio este plano"
 * depois do fato (statusLine, painel, relatório), não pelo resolver em si.
 *
 * ## Contrato de `resolvePlanPath`
 *
 * Tenta, em ordem, os sufixos `""`, `"b"`, `"c"`, ... — pra cada candidato
 * `{baseDir}/{aammdd}{suffix}/plan.json`:
 *
 * 1. **Não existe** → usa este path (é o primeiro slot livre do dia).
 * 2. **Existe E `session_id` bate com o desta sessão** → `mode: "resume"`,
 *    mesmo path — é a PRÓPRIA sessão continuando (resume pós-compaction
 *    dentro da mesma conversa, ou um 2º write em diante).
 * 3. **Existe E `session_id` NÃO bate (ou está ausente — plano legado)** →
 *    tratado como colisão (sessão ALHEIA em voo — mesma máquina OU outra
 *    máquina no mesmo OneDrive, indistinguível e irrelevante pra decisão);
 *    tenta o próximo sufixo.
 *
 * Ausência de `session_id` no arquivo existente é tratada como colisão
 * (nunca como "livre pra tomar") de propósito — um plano sem `session_id`
 * pode ser de uma sessão viva que ainda não escreveu o campo (rollout desta
 * mudança em progresso, ou `plan.json` de antes do #6265/#6328), então a
 * escolha conservadora é nunca sobrescrever silenciosamente.
 *
 * `probe` é injetável — a implementação real (CLI) lê `existsSync`/
 * `readFileSync` de verdade (ver `createFsPlanProbe` abaixo); testes
 * simulam múltiplas escritas concorrentes sem tocar o filesystem.
 *
 * ## Edge case conhecido e aceito: resume pós-crash com `session_id` NOVO
 * (#6259/#6265 self-review, restaurado no #6328 — ver nota abaixo)
 *
 * O harness não garante `session_id` estável entre invocações — uma sessão
 * `/diaria-develop` ou `/diaria-overnight` que trava e é retomada pelo
 * editor (develop) ou pelo watchdog/reinício de máquina (overnight) pode
 * receber um `session_id` diferente na invocação seguinte. Quando isso
 * acontece, `resolvePlanPath` não reconhece o plano existente como "nosso"
 * (regra 2 do contrato acima não bate) e o trata como colisão — a sessão
 * retomada bifurca pra um sufixo novo (`b`) em vez de continuar o
 * `plan.json` original. **Sem perda de dado** (o plano original permanece
 * intacto em disco, íntegro), mas o trabalho registrado nele (issues já
 * processadas, `goal.reached` no develop, status já gravados no overnight)
 * fica invisível pra sessão retomada, que recomeça do zero num arquivo
 * separado — duplicando esforço já feito, não corrompendo estado.
 *
 * Decisão consciente: **não** reconciliar automaticamente por conteúdo/mtime
 * ao retomar. O sinal disponível (dois arquivos de plano, `session_id`
 * diferentes, mesma data) é indistinguível entre "isto é a mesma sessão
 * lógica retomada após crash" e "duas sessões genuinamente diferentes
 * coincidiram no mesmo dia" — exatamente o cenário que este módulo existe
 * pra proteger. Uma heurística de reconciliação arriscaria fundir
 * silenciosamente o trabalho de duas sessões DISTINTAS quando o palpite
 * errar, o que é estritamente pior do que o fork atual (sem perda, só
 * duplicação visível e auditável). **Isto importa mais no overnight que no
 * develop** (nota do #6328): o develop roda supervisionado, o editor pode
 * notar o fork e decidir; o overnight roda desassistido, então um fork
 * silencioso às 3h da manhã só é notado no relatório da manhã seguinte —
 * ainda assim, o trade-off aceito acima (duplicação auditável > risco de
 * fusão errada) continua valendo, e mais ainda nesse caminho: fundir
 * errado o trabalho de duas rodadas overnight distintas sem ninguém
 * acordado pra notar seria pior que a duplicação visível. Se isto se
 * mostrar recorrente na prática, o caminho mais seguro é o editor/painel
 * `/rodada` oferecer "continuar {AAMMDD}b em vez de {AAMMDD}" como escolha
 * explícita — não inferência automática. Sem issue própria aberta;
 * registrar aqui é o suficiente até que o custo justifique o mecanismo.
 *
 * ## `baseDir: string`, não união de literais (decisão consciente, #6328)
 *
 * Foi sugerido estreitar pra `type PlanBaseDir = "data/develop" |
 * "data/overnight"` — descartado: este miolo é lógica de filesystem
 * genuinamente genérica (não sabe nem precisa saber que só 2 valores
 * existem em produção hoje) e os testes (`test/plan-path-resolution.test.ts`,
 * `test/develop-plan-collision.test.ts`) montam disco falso com diretórios
 * arbitrários — estreitar o tipo obrigaria cast nos testes sem ganho real
 * de segurança (os 2 CLIs já fixam a constante certa cada um no seu
 * escopo). Não "corrigir" sem um caso concreto que precise da união.
 *
 * @see scripts/lib/develop-plan-collision.ts (wrapper fino, nomes
 *   específicos do develop preservados para retrocompatibilidade — mesmo
 *   contrato de saída, nenhum consumidor existente precisa mudar)
 * @see scripts/resolve-develop-plan-path.ts (CLI develop)
 * @see scripts/resolve-overnight-plan-path.ts (CLI overnight, #6328)
 * @see scripts/lib/machine-id.ts (`machine_id` gravado à parte, consumido
 *   por quem precisa discriminar por máquina depois do fato)
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see .claude/skills/diaria-overnight/SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";

/** Resultado de sondar um path candidato de `plan.json`. */
export interface PlanPathProbeResult {
  exists: boolean;
  /** `session_id` gravado no arquivo, se presente — `null`/`undefined`/`""`
   * tratado uniformemente como "ausente" pelo resolver. */
  sessionId?: string | null;
}

export type PlanPathProbe = (path: string) => PlanPathProbeResult;

export type PlanPathResolveMode = "fresh" | "resume" | "derived-after-collision";

/** Um plano alheio encontrado no caminho — path candidato + `session_id`
 * que ele carregava (ou `null` se ausente/legado). */
export interface CollisionEntry {
  path: string;
  sessionId: string | null;
}

/**
 * União discriminada por `mode` (#6328 fleet review, achado P2). Antes,
 * `collisions` era um campo opcional independente de `mode` — nada no
 * TIPO impedia `{ mode: "fresh", collisions: [...] }` nem
 * `{ mode: "derived-after-collision" }` sem `collisions`; o invariante real
 * ("`collisions` presente e não-vazio SE E SOMENTE SE
 * `mode === "derived-after-collision"`") existia só por convenção no único
 * ponto de construção (`resolvePlanPath` abaixo). A prova de que isso já
 * incomodava: os dois CLIs (`resolve-develop-plan-path.ts`,
 * `resolve-overnight-plan-path.ts`) escreviam `resolved.collisions ?? []`
 * mesmo DENTRO do branch `mode === "derived-after-collision"`, onde o
 * campo deveria ser garantido — o código consumidor não confiava no
 * próprio tipo. Com a união, o `?? []` virou desnecessário nos dois CLIs
 * (removido).
 *
 * `collisions` é uma tupla não-vazia (`[CollisionEntry, ...CollisionEntry[]]`)
 * porque o loop em `resolvePlanPath` só atribui `derived-after-collision`
 * quando `collisions.length > 0` — nunca zero.
 *
 * **Não-invariante que já causou confusão — não é `suffix !== "" ⟺
 * derived-after-collision`.** Uma sessão que retoma o PRÓPRIO plano já
 * sufixado (ex: a 2ª sessão do dia, `{aammdd}b`, retomando depois de uma
 * compactação) recebe `mode: "resume"` com `suffix: "b"` — sufixo
 * não-vazio, mode `resume`. O invariante real é só sobre `collisions`,
 * nunca sobre `suffix`.
 */
export type ResolvedPlanPath =
  | {
      /** Path final a usar para `plan.json` desta sessão. */
      path: string;
      /** Sufixo aplicado ao diretório `{aammdd}{suffix}` — `""` no caso
       * comum, mas pode ser não-vazio mesmo em `resume` (ver docblock do
       * tipo). */
      suffix: string;
      /** `Extract<>` sobre `PlanPathResolveMode` — fonte única do enum de
       * modos (nunca duplicar os 3 literais aqui e lá; knip reclamaria de
       * `PlanPathResolveMode` órfão se este tipo voltasse a usar literais
       * soltos, #6328). */
      mode: Extract<PlanPathResolveMode, "fresh" | "resume">;
    }
  | {
      path: string;
      suffix: string;
      mode: Extract<PlanPathResolveMode, "derived-after-collision">;
      /** O(s) plano(s) alheio(s) que forçaram o avanço de sufixo, na
       * ordem em que foram encontrados — sempre ≥1 entrada. */
      collisions: [CollisionEntry, ...CollisionEntry[]];
    };

/** Sufixos tentados em ordem — mesma convenção alfabética já usada pelo
 * repo pra 2ª/3ª rodada do mesmo dia (`260822b`, `260826b`, observados ao
 * vivo em `data/overnight/`/`data/develop/`). 25 letras é folga generosa
 * sobre qualquer concorrência real esperada. */
const SUFFIXES: readonly string[] = [
  "",
  ...Array.from({ length: 25 }, (_, i) => String.fromCharCode("b".charCodeAt(0) + i)),
];

function normalizeSessionId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Pure: resolve qual path de `plan.json` esta sessão deve usar, evitando
 * sobrescrever o plano de outra sessão em voo — mesma máquina ou outra
 * máquina compartilhando o mesmo diretório `data/` via OneDrive. Nunca
 * lança em uso normal — só se os 26 sufixos se esgotarem (cenário extremo,
 * ver `SUFFIXES`), sinal de que algo mais está errado (falha ao ler
 * `{baseDir}/`, por exemplo).
 */
export function resolvePlanPath(
  baseDir: string,
  aammdd: string,
  sessionId: string,
  probe: PlanPathProbe,
): ResolvedPlanPath {
  const ourSessionId = normalizeSessionId(sessionId);
  const collisions: CollisionEntry[] = [];

  for (const suffix of SUFFIXES) {
    const path = `${baseDir}/${aammdd}${suffix}/plan.json`;
    const probed = probe(path);

    if (!probed.exists) {
      if (collisions.length > 0) {
        // Cast seguro: o `if` acima já confirma length > 0, exatamente o
        // que a tupla não-vazia do tipo exige — TS não estreita
        // `CollisionEntry[]` pra `[CollisionEntry, ...CollisionEntry[]]`
        // sozinho a partir de um length check.
        return {
          path,
          suffix,
          mode: "derived-after-collision",
          collisions: collisions as [CollisionEntry, ...CollisionEntry[]],
        };
      }
      return { path, suffix, mode: "fresh" };
    }

    const planSessionId = normalizeSessionId(probed.sessionId);
    if (ourSessionId !== "" && planSessionId === ourSessionId) {
      return { path, suffix, mode: "resume" };
    }

    // Existe, e não é claramente nosso (session_id diferente OU ausente —
    // plano legado tratado como potencialmente alheio, nunca "livre").
    collisions.push({ path, sessionId: probed.sessionId ?? null });
  }

  throw new Error(
    `resolvePlanPath: esgotou os ${SUFFIXES.length} sufixos disponíveis para ${aammdd} em ${baseDir} — ` +
      `sinal de problema na leitura de ${baseDir}, não concorrência real.`,
  );
}

/**
 * Probe real de filesystem — leitura de `{path}` do disco, mesma
 * implementação que os dois CLIs (`resolve-develop-plan-path.ts`,
 * `resolve-overnight-plan-path.ts`) usavam duplicada antes deste módulo.
 * JSON malformado (conflito de sync do OneDrive em voo) é tratado como
 * "existe, session_id desconhecido" — nunca "não existe": a checagem de
 * colisão continua conservadora, nunca escreve por cima de um arquivo que
 * não conseguiu ler.
 */
export function createFsPlanProbe(): PlanPathProbe {
  return (path: string): PlanPathProbeResult => {
    if (!existsSync(path)) return { exists: false };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { session_id?: unknown };
      const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
      return { exists: true, sessionId };
    } catch {
      return { exists: true, sessionId: null };
    }
  };
}
