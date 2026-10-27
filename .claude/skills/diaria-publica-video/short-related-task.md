# Vínculo do vídeo relacionado do Short (task das 06:30, #10811)

Roteiro da task LOCAL `diaria-short-video-relacionado` (app Claude desktop, MCP scheduled-tasks, máquina **Neo**, dias úteis 06:30 BRT). É a fonte canônica: a task agendada no Neo só aponta para este arquivo, nunca guarda uma cópia (mesmo padrão do `relatorio-diario-teste-2608`, #8246). Definição da task (nome, cron, prompt): `scripts/lib/scheduled-tasks.ts` → `DESKTOP_SCHEDULED_TASKS`; registro operacional em `docs/scheduled-tasks-registry.md`.

**Por que é task local no Neo e não script no `300`:** a YouTube Data API não expõe o campo de vídeo relacionado de um Short (`docs/youtube-short-related-video.md`). O vínculo só existe no YouTube Studio, e o Studio precisa do Chrome logado no @diariabr, que vive no Neo. Decisão do editor de 22/10/2026, reconfirmada em 26/10: exceção à regra "tasks só no servidor". É 1 ação editorial por dia na conta do editor, dentro da regra de ToS do `CLAUDE.md`.

**O que a API faz e o que o Chrome faz:** a API (pelo script) acha os IDs e confirma que o horizontal está **público** (#573). O Chrome só faz o clique no Studio e relê a página. Nada aqui publica, agenda, despublica ou edita outro campo do vídeo.

Rodar tudo a partir do checkout `C:\Users\vjpix\Projects\diaria-studio` (é ali que estão `data/` e o `.env` com as credenciais do YouTube e do Gmail).

## Passo 1 — Plano

```bash
npx tsx scripts/youtube-short-related-plan.ts --json --poll-minutes 9
```

Sem AAMMDD o script usa a edição de **hoje em BRT** (calculado no TS; não use `date` do Git Bash, que devolve UTC). O JSON traz `action`, `horizontalId`, `horizontalTitle`, `shortId`, `studioUrl`, `shortAt` e `reason`. Exit ≠ 0 é erro do script: ir ao Passo 5 com o motivo.

- `skip` → fim de semana, sem edição, edição sem vídeo, ou **já vinculado** (registro `linked` com os mesmos IDs). Encerrar com uma linha dizendo o motivo.
- `wait` → o horizontal ainda não está público (ou um dos IDs ainda não existe) e o horário do Short não passou. O `--poll-minutes 9` já re-confere a cada 2 minutos; se voltar `wait`, rodar o mesmo comando de novo. Repetir até sair `link`, `skip` ou `alert`.
- `alert` → passou o horário do Short sem dar para vincular. Ir ao Passo 5.
- `link` → seguir para o Passo 2.

## Passo 2 — Abrir o Short no Studio

1. Carregar as ferramentas do Claude in Chrome numa chamada só (`ToolSearch` com `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__get_page_text`). Chrome indisponível ou desconectado → Passo 5 com esse motivo.
2. Abrir uma aba nova (nunca reaproveitar aba do editor) em `studioUrl` — a lista de Shorts do canal **certo** (`/channel/UCSsppeUnBy6q-4a5hsl5u0w/videos/short`). **Nunca abrir `/video/{id}/edit` direto:** às vezes carrega no contexto do canal pessoal e dá "Ops! Algo deu errado" (observado em 261022).
3. Conferir que o Studio está no canal **diar.ia.br** (nome no canto do menu). Outro canal, tela de login ou pedido de senha → parar, não digitar nada, Passo 5.
4. Na lista, achar a linha do Short cujo link aponta para `shortId` (`find` pelo id, ou o link `/video/{shortId}/edit` da linha) e clicar nele a partir da lista.

## Passo 3 — Vincular

1. Na página de detalhes do Short, ir à seção **"Elementos do vídeo"** e abrir **"Vídeo relacionado"**.
2. **Idempotência na página:** se o campo já mostra o horizontal (título igual a `horizontalTitle`, ou link com `horizontalId`), não mexer em nada: ir direto ao Passo 4 com `linked` e nota "já estava vinculado no Studio". Se mostra **outro** vídeo, trocar pelo horizontal desta edição (é a decisão do editor: o relacionado do Short é o horizontal da mesma edição).
3. Clicar **"Adicionar"** (ou trocar) → **"Escolha um vídeo específico"** → escolher o vídeo com título `horizontalTitle` (conferir pelo id `horizontalId` quando o seletor mostrar o link). Seletor sem o horizontal na lista → Passo 5 (o seletor só lista vídeo público ou não listado; se a API disse público e o seletor não mostra, é atraso do Studio: tentar de novo uma vez depois de 5 minutos antes de desistir).
4. Clicar **"Salvar"** e esperar a confirmação **"Alterações salvas"**.
5. Reler: recarregar a página do Short (voltando pela lista do Passo 2, não pela URL direta) e confirmar que "Vídeo relacionado" mostra o horizontal. Só isso conta como sucesso; "Salvar" clicado sem a releitura não conta.

**Nunca**, nesta task: mudar título, descrição, capa, visibilidade, agendamento, Teste A/B de títulos (deixar como está, mesmo "Em andamento"), comentários ou qualquer outro campo; clicar em "Publicar"; aceitar diálogo de termos; trocar de conta.

## Passo 4 — Registrar

Sucesso:

```bash
npx tsx scripts/youtube-short-related-plan.ts --record linked --note "Alterações salvas; relido no Studio"
```

Falha no Studio (qualquer passo acima):

```bash
npx tsx scripts/youtube-short-related-plan.ts --record failed --note "{o que falhou, em uma linha}"
```

Depois de um `failed`, se o horário do Short (`shortAt`) ainda não passou, voltar ao Passo 1 uma vez; senão, Passo 5. O registro vive em `_internal/06-short-related.json` da edição; `linked` com os mesmos IDs faz a próxima execução sair `skip`.

## Passo 5 — Alertar o editor

```bash
npx tsx scripts/youtube-short-related-plan.ts --alert --note "{motivo em uma linha}"
```

Manda um e-mail ao editor (Gmail API, `sendPushNotification`) com o motivo, os IDs e o caminho manual no Studio, **uma vez por edição** (o registro guarda `alertedAt`; chamar de novo não reenvia). Falha do e-mail = exit 1: dizer isso no resumo final da task, que é o último canal.

## Fim

Resumo de uma ou duas linhas: edição, ação final (`vinculado`, `já vinculado`, `pulado: motivo`, `alerta enviado: motivo`) e os IDs. Nada de perguntas: a task roda sem o editor presente.
