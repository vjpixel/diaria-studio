# Vínculo do vídeo relacionado do Short (task das 06:05, #10811)

Roteiro da task LOCAL `diaria-short-video-relacionado` (app Claude desktop, MCP scheduled-tasks, máquina **Neo**, dias úteis às 06:05 BRT). É a fonte canônica: a task agendada no Neo só aponta para este arquivo e não guarda cópia dele (mesmo padrão do `relatorio-diario-teste-2608`, #8246). A definição da task (nome, cron, prompt) está em `scripts/lib/scheduled-tasks.ts` → `DESKTOP_SCHEDULED_TASKS` (`npx tsx scripts/lib/scheduled-tasks.ts --desktop`); o registro operacional, em `docs/scheduled-tasks-registry.md`.

**Por que é task local no Neo e não script no `300`:** a YouTube Data API não expõe o campo de vídeo relacionado de um Short (`docs/youtube-short-related-video.md`). O vínculo só existe no YouTube Studio, e o Studio precisa do Chrome logado no @diariabr, que fica no Neo. A decisão é do editor (22/10/2026, reconfirmada em 26/10) e abre uma exceção à regra "tasks só no servidor". É 1 ação editorial por dia na conta do editor, dentro da regra de ToS do `CLAUDE.md`.

**Por que 06:05:** o horizontal publica às 06:00, e o slot mais cedo do Short no teste de horário é 06:30 (`publishing.shorts.schedule.rotation_times`). Às 06:05 a task normalmente já encontra o horizontal público; se ainda não estiver, o `wait` cobre o atraso.

**Divisão de trabalho:** a API (pelo script) acha os IDs, confirma que o horizontal está **público** (#573) e lê o título dele. O Chrome só clica no Studio e relê a página. Nada aqui publica, agenda, despublica ou edita outro campo do vídeo.

Rode tudo a partir do checkout `C:\Users\vjpix\Projects\diaria-studio`: é ali que ficam `data/` e o `.env` com as credenciais do YouTube e do Gmail. O script lê `GOOGLE_CLIENT_*` do `.env`, e esse valor vence o do ambiente, porque o app desktop injeta outro client OAuth (#8237).

## Passo 1: plano

Pela ferramenta Bash **com `timeout: 600000`**. O padrão de 2 minutos mataria o processo no meio da espera.

```bash
npx tsx scripts/youtube-short-related-plan.ts --json --poll-minutes 9
```

Sem AAMMDD, o script usa a edição de **hoje em BRT**, calculada no TS. Não use o `date` do Git Bash, que devolve UTC. O JSON traz `action`, `horizontalId`, `horizontalTitle`, `shortId`, `studioUrl`, `shortAt`, `giveUpAt`, `alertDue`, `alreadyAlerted` e `reason`. Exit diferente de 0 é erro do script (inclui `data/editions` não montado e registro ilegível): vá ao Passo 5 com o erro.

- `skip`: fim de semana, sem edição, edição sem vídeo, ou **já vinculado**. Encerre com uma linha dizendo o motivo.
- `link`: siga para o Passo 2. **Guarde `horizontalId`, `shortId` e `horizontalTitle` deste JSON**; o Passo 4 os repassa.
- `alert`: não adianta esperar. Os casos são credencial ausente ou recusada (401/403, `invalid_grant`, `invalid_client`), quota, os dois IDs iguais, horário do Short desconhecido ou o prazo `giveUpAt` já passado. Vá ao Passo 5.
- `wait`: algo ainda não está pronto. Pode ser o horizontal ainda não público, um ID ainda não registrado, o título ainda não lido ou o estado não conferido por falha **transitória** de rede/5xx.
  - Com `alertDue: true` e `alreadyAlerted: false` (o horário do Short passou), rode o Passo 5 **uma vez** e depois volte a este passo. O vínculo depois do Short no ar ainda vale.
  - Nos demais casos, rode o mesmo comando de novo.
  - **Teto:** no máximo 12 rodadas deste comando no total (cerca de 1h50). Ao atingir o teto, vá ao Passo 5.

## Passo 2: abrir o Short no Studio

1. Carregue as ferramentas do Claude in Chrome numa chamada só: `ToolSearch` com `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__get_page_text`. Se o Chrome estiver indisponível ou desconectado, vá ao Passo 4 (`failed`) e depois ao Passo 5.
2. Abra uma aba nova (nunca reaproveite aba do editor) em `studioUrl`, que é a lista de Shorts do canal **certo** (`/channel/UCSsppeUnBy6q-4a5hsl5u0w/videos/short`). **Não abra `/video/{id}/edit` direto:** às vezes a página carrega no contexto do canal pessoal e dá "Ops! Algo deu errado" (observado em 261022).
3. Confira que o Studio está no canal **diar.ia.br** (nome no canto do menu). Se aparecer outro canal, tela de login ou pedido de senha, pare sem digitar nada e vá ao Passo 4 (`failed`).
4. Na lista, ache a linha do Short cujo link aponta para `shortId` (`find` pelo id, ou o link `/video/{shortId}/edit` da linha) e clique nele a partir da lista.

## Passo 3: vincular

1. Na página de detalhes do Short, vá à seção **"Elementos do vídeo"** e abra **"Vídeo relacionado"**.
2. **Idempotência na página:** se o campo já mostra o horizontal (título igual a `horizontalTitle`), não mexa em nada e vá direto ao Passo 4 com `linked`, nota "já estava vinculado no Studio". Se mostra **outro** vídeo, troque pelo horizontal desta edição: pela decisão do editor, o relacionado do Short é o horizontal da mesma edição.
3. Clique em **"Adicionar"** (ou na opção de trocar), depois em **"Escolha um vídeo específico"**, e escolha o vídeo com título `horizontalTitle` (confira pelo id `horizontalId` quando o seletor mostrar o link). O seletor só lista vídeo público ou não listado. Se ele não mostrar o horizontal mesmo com a API dizendo que é público, é atraso do Studio: espere 5 minutos e tente uma vez mais. Se continuar sem aparecer, vá ao Passo 4 (`failed`).
4. Clique em **"Salvar"** e espere a confirmação **"Alterações salvas"**.
5. Releia: volte pela lista do Passo 2 (não pela URL direta), reabra o Short e confirme que "Vídeo relacionado" mostra o horizontal. Só isso conta como sucesso; "Salvar" clicado sem a releitura não conta.

**Nunca**, nesta task: mudar título, descrição, capa, visibilidade, agendamento, Teste A/B de títulos (deixe como está, mesmo "Em andamento"), comentários ou qualquer outro campo; clicar em "Publicar"; aceitar diálogo de termos; trocar de conta.

## Passo 4: registrar

Em caso de sucesso, passe os IDs do JSON do Passo 1. O script recusa o registro se eles divergirem dos recalculados e, sem eles, se o plano não for mais `link`:

```bash
npx tsx scripts/youtube-short-related-plan.ts --record linked --horizontal-id {horizontalId} --short-id {shortId} --note "Alterações salvas; relido no Studio"
```

Em caso de falha no Studio (qualquer passo acima):

```bash
npx tsx scripts/youtube-short-related-plan.ts --record failed --note "{o que falhou, em uma linha}"
```

Depois de um `failed`, se `giveUpAt` ainda não passou, volte ao Passo 1 uma vez (o teto de rodadas continua valendo). Se já passou, vá ao Passo 5. O registro fica em `_internal/06-short-related.json` da edição; com `linked` e os mesmos IDs, a próxima execução sai `skip`.

## Passo 5: alertar o editor

```bash
npx tsx scripts/youtube-short-related-plan.ts --alert --note "{motivo em uma linha}"
```

Manda um e-mail ao editor (Gmail API, `sendPushNotification`) com o motivo, os IDs e o caminho manual no Studio, **uma vez por edição**: o registro guarda `alertedAt`, e uma nova chamada não reenvia. O alerta sai mesmo se o plano falhar (o corpo leva o erro) ou se o registro anterior estiver ilegível (nesse caso sai sem dedup e o arquivo não é sobrescrito).

O exit code diz o desfecho:
- 0: enviado, ou já tinha saído.
- 1: o e-mail não saiu. Diga isso no resumo final, que passa a ser o último canal.
- 3: o e-mail saiu, mas o registro do alerta não foi gravado. Diga isso no resumo e não chame `--alert` de novo.

## Fim

Resumo de uma ou duas linhas: edição, ação final (`vinculado`, `já vinculado`, `pulado: motivo`, `alerta enviado: motivo`) e os IDs. Nada de perguntas: a task roda sem o editor presente.
