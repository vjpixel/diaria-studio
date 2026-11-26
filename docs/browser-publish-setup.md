# Claude in Chrome — setup e onde a pipeline usa o navegador

Setup da extensão **Claude in Chrome** e lista do que ainda passa pelo navegador logado do editor. Reescrito no #14061: a versão anterior descrevia a publicação da newsletter no Beehiiv e dos posts de LinkedIn e Facebook pelo Chrome, e nada disso roda mais assim.

---

## O que NÃO passa pelo Chrome

- **Newsletter diária:** sai pelo Kit, por API (`scripts/publish-newsletter-kit.ts`, #7388). A Beehiiv é só arquivo histórico desde o #11225: a conta segue ativa, mas não envia e o pipeline não depende dela.
- **Schedule da Etapa 6:** é um PATCH de `send_at` no broadcast do Kit, com GET de verificação (`.claude/skills/diaria-5-publicacao/SKILL.md`).
- **Posts sociais da diária:** LinkedIn pelo Worker de agendamento, Facebook pela Graph API, Instagram e Threads pelo Worker, X pela Buffer, Brevo diária por API. São scripts sem navegador (`scripts/publish-social-concurrent.ts`, Etapa 5).

O Chrome nunca é pré-requisito da Etapa 5/6: sem ele, a única coisa que muda é o caminho do e-mail de teste (abaixo).

## Onde o Chrome ainda entra

| Uso | Onde está descrito | Sem Chrome |
|---|---|---|
| E-mail de teste da diária pela UI do Kit ("Send test email" do próprio broadcast, ainda rascunho, #10395) | `.claude/agents/orchestrator-stage-5.md`, Passo 5c-1-kit | Fallback `publish-newsletter-kit.ts --send-test` (broadcast descartável com `[teste]` no assunto) |
| Post restrito no apoia.se | `/diaria-artigo-especial` (Passo 3), `/diaria-mensal-apoiadores` (Passo 5) | `--skip apoiase` |
| Paste assistido da newsletter semanal no editor do LinkedIn | `/diaria-linkedin-semanal` (Passo 8) | Paste manual pelo editor |
| Preenchimento do formulário Tally do desafio Mandala | `/diaria-mandala-semana` (Passo 4) | Preenchimento manual |
| Prévia local do digest mensal | `/diaria-mensal` | Abrir a prévia no navegador à mão |
| Etapas de vídeo que só o YouTube Studio web aceita (comentário fixado, tela final, capa do Short) | `/diaria-publica` e `reference/vertical-depois-do-stage6.md` | Fazer no Studio à mão |

**Regra do teste pela UI do Kit (#10410):** o `ui_test_url` é o broadcast REAL da edição, com a audiência de produção. Só três cliques são permitidos: Preview, Send test email, Send preview. Clicar em Send, Schedule, Continue ou Publish manda (ou agenda) a edição para a base inteira, sem volta. Tela inesperada = parar e usar o fallback `--send-test`.

Automação de site de terceiro pelo Chrome segue a regra de ToS do `CLAUDE.md`: só em conta em que o editor está logado, com volume baixo e ação editorial; nunca scraping nem escala.

---

## 1. Instalar a extensão

1. Instalar **Claude in Chrome** pela Chrome Web Store (ou [claude.ai/chrome](https://claude.ai/chrome)).
2. Fazer login com a mesma conta claude.ai usada no Claude Code.
3. Confirmar que a extensão está ativa (ícone na barra de ferramentas).

Só a máquina do editor (Windows) tem Chrome logado. O servidor `300` não tem, e por isso as rodadas lá usam os fallbacks da tabela acima. Issue que exige o Chrome leva a label `windows` e vai para o Develop (`scripts/lib/issue-exec-track.ts`).

## 2. Confirmar o MCP no Claude Code

No diretório `diaria-studio`, rodar `/mcp`: deve listar `claude-in-chrome` (conector nativo), com as ferramentas `mcp__claude-in-chrome__*`.

O Stage 0 pinga o MCP (`mcp__claude-in-chrome__tabs_context_mcp`) e grava o resultado; a Etapa 5 lê esse sinal (`CHROME_MCP`, #5414) do disco para escolher entre o teste pela UI e o `--send-test`.

## 3. Logar nas contas

No mesmo Chrome da extensão, com "manter conectado" marcado:

| Conta | URL | Usada por |
|---|---|---|
| Kit | https://app.kit.com/ | E-mail de teste pela UI (Etapa 5) |
| apoia.se | https://apoia.se/ | Artigo especial, retrospectiva dos apoiadores |
| LinkedIn (perfil pessoal) | https://www.linkedin.com/ | Newsletter semanal do LinkedIn |
| YouTube Studio | https://studio.youtube.com/ | Etapas de vídeo só disponíveis na web |

## 4. Permissões em `.claude/settings.json`

O `allow` do projeto libera `navigate`, `read_page`, `get_page_text`, `find`, `form_input`, `upload_image`, `tabs_create_mcp`, `tabs_context_mcp` e `javascript_tool` do `mcp__claude-in-chrome__*`. Os cliques (`computer`) seguem pedindo confirmação, de propósito: é por eles que sai um envio.

## 5. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Stage 0 registra `chromeMcp: false` | Extensão desligada ou Chrome fechado | Abrir o Chrome; a Etapa 5 já cai sozinha no `--send-test` |
| MCP cai no meio da etapa | Extensão desconectou | Halt banner (#738): reconectar e responder `retry` |
| UI do Kit mostra tela diferente do Preview | Kit mudou a interface | Não clicar; usar `--send-test` e abrir issue |
| Login expirado numa conta | Sessão caducou | Logar de novo no Chrome e repetir só o passo |
