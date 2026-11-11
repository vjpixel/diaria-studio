/**
 * scripts/lib/diaria/publish-confirm.ts (#11741)
 *
 * Confirmação explícita nos publishers de vídeo com efeito público:
 * `publish-youtube.ts --upload` e `publish-shorts.ts --publish` só rodam com
 * `--confirm-publish AAMMDD` (a MESMA edição do comando). Sem a flag, ou com
 * outra edição, saem exit 2 antes de ler credencial, baixar vídeo ou chamar
 * qualquer API.
 *
 * ## Por que (incidente 261030)
 *
 * Na `/diaria-publica-video 261030`, duas chamadas de Bash que o editor
 * rejeitou no app parecem ter publicado mesmo assim: o `--upload` do
 * horizontal (o registro mostra `uploadedAt` 24 s antes da chamada seguinte,
 * com a capa antiga, a que existia na hora da chamada rejeitada) e o
 * `--publish` do vertical (Shorts e Facebook registrados antes do "pode
 * publicar"). Não está provado.
 *
 * **Hipótese de harness (fora deste repo, não reproduzível aqui):**
 * `.claude/settings.json` libera `Bash(npx tsx scripts/*.ts *)`, então os dois
 * publishers rodam sem prompt de permissão. O "não" do editor, nesse caso,
 * só pode ter sido uma INTERRUPÇÃO de um Bash já em execução, e o app grava
 * isso como `User rejected tool use` (visto no transcript d38d27cc de
 * 22/10/2026, em `bypassPermissions`). Se a interrupção não mata a árvore do
 * processo (`npx` → `node` → upload, no Windows), o publisher segue vivo e
 * termina o envio depois que o agente já acha que nada aconteceu. O
 * transcript de 30/10 está no Neo; a confirmação é procurar ali o
 * `toolUseResult` das duas chamadas. A outra hipótese do item 1 é a sessão
 * paralela `Diaria publica video 261030` na mesma pasta, que não explica o
 * item 2.
 *
 * ## Mitigação (decisão do editor no briefing do overnight 261102)
 *
 * 1. Esta confirmação: o agente só monta o comando de publicação depois de um
 *    "pode publicar" explícito do editor na conversa, sobre o plano do
 *    dry-run. Invocar a skill deixou de ser o pedido de publicação. Uma
 *    interrupção/rejeição de um publisher é um "não": a confirmação anterior
 *    não vale para a próxima chamada.
 * 2. Releitura do registro depois de qualquer interrupção
 *    (`scripts/video-publish-registry-status.ts --since ISO`): se o processo
 *    sobreviveu, o que ele publicou aparece no registro, e o agente relata em
 *    vez de seguir como se nada tivesse saído.
 *
 * Os chamadores automáticos já autorizados por config (timers do 300,
 * tasks one-shot que a skill
 * cria a partir do `owners[]`) passam a flag eles mesmos — a autorização deles
 * é a decisão do editor que os ligou, não uma pergunta a cada execução.
 * (O `stage5-youtube.ts` deixou de subir vídeo no #12588: só o
 * `/diaria-publica-video`, depois do "pode publicar", sobe o horizontal.)
 *
 * A flag não protege contra o processo que sobrevive à interrupção (isso é
 * harness); ela garante que o processo só começa depois do "sim".
 *
 * #12654: a flag sozinha não liga o "sim" a um plano. Desde então o "pode
 * publicar" é gravado com o SHA-256 do manifesto do plano
 * (`video-publish-plan.ts`, `video-publish-authorize.ts grant`) e o publisher
 * consome essa autorização de uso único antes do 1º efeito externo
 * (`video-publish-authorization.ts`). A flag continua: é a 1ª trava, antes de
 * qualquer leitura.
 */

export const PUBLISH_CONFIRM_FLAG = "confirm-publish";

export type ConfirmedPublisher = "publish-youtube" | "publish-shorts";

/** Argumentos que confirmam a publicação da edição (para chamadores automáticos). */
export function publishConfirmArgs(aammdd: string): string[] {
  return [`--${PUBLISH_CONFIRM_FLAG}`, aammdd];
}

/** Mesmo que `publishConfirmArgs`, como trecho de linha de comando. */
export function publishConfirmSuffix(aammdd: string): string {
  return publishConfirmArgs(aammdd).join(" ");
}

/**
 * Pure: `null` quando a publicação está confirmada para `aammdd`; senão, a
 * mensagem de recusa (o chamador sai exit 2 sem fazer nada).
 *
 * `values`/`flags` são os do `parseArgs` de `scripts/lib/cli-args.ts`:
 * `--confirm-publish 261030` vira `values["confirm-publish"]`, e a flag sem
 * valor (ou seguida de outra `--flag`) vira `flags`.
 */
export function publishConfirmationError(input: {
  script: ConfirmedPublisher;
  mode: "--upload" | "--publish";
  aammdd: string;
  flags: ReadonlySet<string>;
  values: Readonly<Record<string, string>>;
}): string | null {
  const given = input.values[PUBLISH_CONFIRM_FLAG];
  if (given === input.aammdd) return null;
  const how =
    `mostre o plano (o mesmo comando sem ${input.mode}) ao editor, espere o "pode publicar" explícito dele nesta conversa ` +
    `e só então rode com ${publishConfirmSuffix(input.aammdd)}. Se uma chamada anterior foi interrompida/rejeitada, ` +
    `releia antes o registro (npx tsx scripts/video-publish-registry-status.ts ${input.aammdd} --since ISO-da-chamada) — ` +
    "o processo pode ter seguido vivo e publicado (#11741).";
  if (given === undefined && !input.flags.has(PUBLISH_CONFIRM_FLAG)) {
    return `${input.script}: ${input.mode} tem efeito público e exige confirmação explícita (#11741). Nada foi enviado. Para publicar, ${how}`;
  }
  if (given === undefined) {
    return `${input.script}: --${PUBLISH_CONFIRM_FLAG} exige a edição (AAMMDD) como valor. Nada foi enviado. Para publicar, ${how}`;
  }
  return (
    `${input.script}: --${PUBLISH_CONFIRM_FLAG} ${given} não confirma a edição ${input.aammdd} (a confirmação vale só para a edição do comando). ` +
    `Nada foi enviado. Para publicar, ${how}`
  );
}
