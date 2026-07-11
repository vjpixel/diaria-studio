/**
 * link-ctr-categorize.ts (#1844 — extraído de build-link-ctr.ts)
 *
 * Classificador de links pro relatório de CTR: taxonomia host/path/anchor
 * (~665L em `categorize()`) + a subcategoria de Negócios. Funções puras de
 * string (sem I/O), antes inline e SEM teste direto no build-link-ctr.ts.
 * Agora exportável e coberto por golden tests. build-link-ctr.ts importa
 * `categorize`; `negociosSubcategory` é privado do módulo (só categorize usa).
 *
 * #3145: também exporta `resolveNewsletterSection` — normaliza o
 * `section_title` bruto (heading/kicker mais próximo acima do link, extraído
 * por `extractLinks()` em build-link-ctr.ts) pra um label de SEÇÃO ESTRUTURAL
 * da newsletter (Destaque/Lançamento/Radar/Use Melhor/Vídeo), distinto de
 * `category` (inferência por domínio/conteúdo feita aqui em `categorize()`).
 */
import { stripEmojiPrefix } from './section-naming.ts';

// ─── Categorization ───────────────────────────────────────────────────────────

// ─── Negócios subcategory via text signal ─────────────────────────────────────

function negociosSubcategory(signal: string): string {
  const s = signal.normalize('NFC').toLowerCase();

  // Infraestrutura — chips, data centers, compute, energia
  const hardwareKw = [
    'chip', 'chips', ' gpu', ' tpu', ' cpu', 'supercluster', 'data center',
    'datacenter', 'servidor', 'servidores', 'compute', 'infraestrutura de ia',
    'infraestrutura de i.a', 'hbm', 'memória hbm', 'placa de vídeo',
    'capacidade elétrica', 'energia elétrica', 'consumo energético',
    'sk hynix', 'tsmc', 'broadcom', 'asml', 'amd ', ' intel ',
    'h100', 'h200', 'b200', 'blackwell', 'atlas 950',
    'nuvem de us$', 'data centers',
  ];

  // Aplicação — IA aplicada em setores específicos do mundo real
  const aplicacaoKw = [
    'hospital', 'clínica', 'médico', 'diagnóst', 'anticorpo', 'medicament',
    'robôs', 'robô ', 'robótica', 'robotáxi', 'robotaxi',
    'motorista', 'trânsito', 'rodovia', 'veículo autônomo', 'carro autônomo',
    'call center', 'atendimento ao cliente',
    'varejo', 'walmart', 'loja', 'e-commerce',
    'fazenda', 'agricultura', 'plantio',
    'manufatura', 'fábrica', 'logística',
    'jurídico', 'advogado', 'tribunal', 'justiça',
    'idosos', 'crianças', 'avós robôs',
    'clínicas africanas', 'horizon1000',
    'spotify', 'música', 'entretenimento',
    'desmatamento', 'travel planning', 'booking',
    'mammogram', 'breast cancer', 'remarcação de voos',
    'lung-cancer', 'collaboration with openai',
    'séries e filmes', 'produção de séries',
  ];

  // Geopolítica — corrida global, disputas entre países, soberania tecnológica
  const geopoliticaKw = [
    'china ', 'chinesa', 'chinês', 'beijing', 'pequim',
    'estados unidos', 'washington', 'pentágono', 'white house',
    'corrida ', 'projeto manhattan', 'rivalizar com ocidente', 'rivalizar com o ocidente',
    'aliados dos eua', 'acesso de aliados', 'sanção', 'sanções',
    'geopolítica', 'soberania', 'soberania tecnológica', 'soberania cognitiva',
    'guerra tecnológica', 'guerra fria', 'ocidente',
    'impede entrada de chips', 'veta chips', 'bloqueia chips',
    'indonesia', 'indonésia', 'malásia', 'albânia',
    'davos', 'cúpula', 'g7', 'g20', 'onu', 'unesco',
    'europa ', 'união europeia', 'comissão europeia',
    'capacidade elétrica coloca a china',
    'summit', 'ai summit',
  ];

  // Mercado — financeiro: funding, valuations, M&A, receita
  const mercadoKw = [
    'levanta', 'levantou', 'capta', 'captou', 'valuation', 'bilhão', 'bilhões',
    'bilh', 'milh', 'ipo', 'receita', 'faturamento', 'lucro', 'prejuízo',
    'ações', 'bolsa', 'nasdaq', 'funding', 'rodada', 'série a', 'série b',
    'série c', 'aquisição', 'adquire', 'adquiriu', 'comprou',
    'fusão', 'acordo de us$', 'contrato de us$', 'investe', 'investimento',
    'demite', 'demitiu', 'corte de', 'layoff', 'dispensa',
    'contrata', 'contratou', 'aposta', 'prevê', 'projeção',
    'abrir capital', 'valor de mercado', 'wall street', 's&p ',
    'títulos ', 'bonds ', 'price hike',
    'bilionário', 'bilionários', 'mercado de ia', 'mercado de i.a',
    'mercado aguarda', 'resultados da nvidia', 'raises ',
  ];

  // Impacto — efeitos de IA em pessoas, sociedade, empregos
  const impactoKw = [
    'emprego', 'empregos', 'trabalho', 'trabalhador', 'funcionário', 'funcionários',
    'carreira', 'profissional', 'profissionais', 'habilidade', 'habilidades',
    'escola', 'estudante', 'aluno', 'professor', 'educação',
    'direito', 'direitos', 'lei ', 'legislação',
    'sociedade', 'social', 'emocion', 'psicol', 'mental',
    'vício', 'privacidade', 'vigilância', 'viés',
    'criança', 'adolescente', 'menor ', 'suicídio', 'bem-estar',
    'futuro do trabalho', 'automação', 'substituição',
    'reduzir pessoal', 'redução de empregos',
    'mass-unemployment', 'halved-workforce', 'ganhando em dólar',
    'negative-sentiment', 'gen-z',
    'imagem falsa', 'holocausto',
  ];

  // Regulação — termos jurídicos e processos legais (migra para cat. Regulação existente)
  const regulacaoKw = [
    'processada', 'processam', 'processou', 'processo judicial', 'processo sobre',
    'ação coletiva', 'tribunal', 'litígio', 'infring', 'sues ',
    'violação', 'patente', 'acusa', 'acusação', 'acusando',
    'regulação', 'regulament', 'legislação', 'proíbe', 'proibir',
    'barra ', 'suspende', 'investig', 'ofcom', 'exige que',
    'compliance', 'veta', 'norma', 'lei estadual', 'copyright',
    'cancel chatgpt', 'unauthorized', 'cracks down',
    'safety panel', 'safety-panel',
    'processa ', 'monopolista', 'lei obrigatória', 'rotulagem',
  ];

  // Segurança — ameaças, deepfakes, fraudes, vulnerabilidades
  const segurancaKw = [
    'segurança de ia', 'segurança da ia', 'segurança na ia', 'segurança em ia',
    'deepfake', 'fraude', 'golpe', 'malware',
    'hackeada', 'hackear', 'hacked', 'vulnerab', 'phishing',
    'vazamento de dados', 'vazou dados', 'leaked source code',
    'pornô', 'nudez', 'abuse', 'uso indevido', 'falsific',
    'perigoso', 'pesadelo', 'invasor', 'cibernético',
    'rogue ai agent', 'trouble with rogue',
    'ciberataqu', 'cyberattack', 'expõe dados',
    'age sem autorização', 'sem autorização',
  ];

  // Bastidores — movimentações de executivos, contratações, saídas
  const bastidoresKw = [
    'ceo ', 'executiv', 'líder ', 'chefe ', 'diretor', 'cofundador',
    'contrata ', 'deixa ', 'saída', 'renuncia', 'assume cargo',
    'recruta', 'perde executiv', 'perde o executiv', 'altman', 'musk', 'hassabis',
    'bezos', 'jensen', 'jony ive', 'mira murati', 'robby walker',
    'ex-líder', 'ex-secretário', 'retornam à',
    'joins openai', 'joins anthropic', 'joins google',
    'disbands', 'reassigns staff', 'pessoa do ano',
    'apagão', 'outage', 'parceria', 'partnership',
    'acordo para', 'assinam acordo', 'fecha a torneira',
    'evento de ia', 'conference', 'conferência',
    'licensing',
  ];

  // Tendência — pesquisas, relatórios, estatísticas de adoção
  const tendenciaKw = [
    '% d', '% das', '% dos', 'pesquisa ', 'estudo ', 'survey',
    'relatório', 'revela que', 'aponta que', 'segundo estudo',
    'índice', 'benchmark', 'ranking', 'reporta crescimento',
    'adoção', 'pesquisadores', 'poll', 'surpassed', 'popularidade',
    'gallup', 'stanford report', 'disconnect between',
    'skyrocketing', 'entrou no resultado',
    'desconexão entre', 'mede resultado', 'competição',
  ];

  // Estratégia — visão, previsões, análises de mercado, "bolha"
  const estrategiaKw = [
    'bolha', 'boom ', 'futuro ', 'previsão', 'previsões',
    'tendência', 'moldará', 'esperar da', 'estratégia',
    'projeção', 'potencial de', 'era ', 'próxima era',
    'fase inicial', 'doutrina', 'agenda de ia',
    'predictions for', 'jagged intelligence',
    'diz reitor', 'steady global growth', 'vantagem de',
  ];

  // Tutorial & Dica → merge com Treinamento
  const tutorialKw = [
    'prompt', 'passo a passo', 'setup', 'como extrair',
    'como melhorar', 'dica', 'tutorial', 'guia ',
  ];

  // Produto / Feature — lançamentos de big tech cobertos pela mídia → merge com Lançamento
  const produtoKw = [
    'lança', 'apresenta', 'anuncia', 'estreia', 'libera',
    'atualiza', 'disponibiliza', 'habilita', 'adiciona',
    'novo modelo', 'novo feed', 'novo recurso',
    'iphone', 'galaxy s2', 'airpods', 'macbook', 'ipad air',
    'siri', 'alexa', 'kindle', 'copilot',
    'aposentar', 'desliga o ', 'testa modelo', 'ganha marketplace',
    'agora vende', 'recebe novo', 'abre beta',
    'browser-launch', 'comet-ai-browser', 'releases mmx',
    'shopping results', 'model-for-robots', 'pagamento com ia',
    'ai-assistant-coming', 'rival para o echo',
    'super bowl ai', 'ai ads',
    'vibe coding', 'novos modelos', 'chega ao brasil',
    'personalização chega', 'testa compras',
    'ai assistant', 'personal ai', 'agente autoevolutivo',
    'video generator',
  ];

  // Order matters: most specific first
  if (regulacaoKw.some(k => s.includes(k))) return 'Regulação';
  if (segurancaKw.some(k => s.includes(k))) return 'Segurança';
  if (hardwareKw.some(k => s.includes(k))) return 'Infraestrutura';
  if (bastidoresKw.some(k => s.includes(k))) return 'Bastidores';
  if (geopoliticaKw.some(k => s.includes(k))) return 'Geopolítica';
  if (tendenciaKw.some(k => s.includes(k))) return 'Tendência';
  if (aplicacaoKw.some(k => s.includes(k))) return 'Aplicação';
  if (mercadoKw.some(k => s.includes(k))) return 'Mercado';
  if (estrategiaKw.some(k => s.includes(k))) return 'Estratégia';
  if (impactoKw.some(k => s.includes(k))) return 'Impacto';
  if (tutorialKw.some(k => s.includes(k))) return 'Treinamento';
  if (produtoKw.some(k => s.includes(k))) return 'Lançamento';
  return 'Indústria';
}

export function categorize(url: string, anchor = '', sectionTitle = '', postTitle = '', context = ''): string {
  let host: string, pathname: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathname = u.pathname.toLowerCase();
  } catch {
    return 'Outro';
  }

  // Blog/newsroom paths inside tool/product sites → Lançamento
  // (announcement ≠ the tool itself)
  const isAnnouncementPath =
    pathname.includes('/blog/') ||
    pathname.includes('/hub/blog/') ||
    pathname.includes('/newsroom/') ||
    pathname.includes('/press-release') ||
    pathname.includes('/news/') ||
    pathname.includes('/changelog') ||
    pathname.includes('/announcing') ||
    pathname.includes('/intl/');

  const isToolDomainWithBlog =
    isAnnouncementPath && (
      host === 'perplexity.ai' || host === 'pplx.ai' ||
      host === 'cursor.com' ||
      host === 'notion.com' ||
      host === 'figma.com' ||
      host === 'slack.com' ||
      host === 'grammarly.com' ||
      host === 'databricks.com' ||
      host === 'huggingface.co' ||
      host === 'github.com' ||
      host === 'cloud.google.com' ||
      host === 'aws.amazon.com' ||
      host === 'oracle.com' ||
      host === 'glideapps.com' ||
      host === 'bentoml.com' ||
      host === 'openrouter.ai' ||
      host === 'opentools.ai' ||
      host === 'testingcatalog.com'
    );

  if (isToolDomainWithBlog) return 'Lançamento';

  // Pesquisa — academic / research
  if (
    host === 'arxiv.org' ||
    host === 'nature.com' || host.endsWith('.nature.com') ||
    host === 'science.org' ||
    host === 'pubmed.ncbi.nlm.nih.gov' || host.includes('pubmed') ||
    host === 'dl.acm.org' || host === 'acm.org' ||
    host === 'proceedings.mlr.press' ||
    host === 'jmlr.org' ||
    host === 'openreview.net' ||
    host.includes('research.google') ||
    host === 'ai.meta.com' ||
    host === 'research.ibm.com' ||
    host === 'research.microsoft.com' ||
    host === 'deepmind.com' || host.includes('deepmind') ||
    host === 'bair.berkeley.edu' ||
    host === 'pair.withgoogle.com' ||
    host === 'news-medical.net' ||
    pathname.includes('/papers/') ||
    // University / study pages
    host.endsWith('.edu') ||
    host.endsWith('.ac.uk') ||
    host === 'apufsc.org.br' ||
    host === 'sbic.com.br' ||
    host === 'sciencedaily.com' ||
    host === 'sciencedirect.com' ||
    host === 'pub.sakana.ai' ||
    host === 'pewresearch.org' ||
    host === 'news.gallup.com' ||
    host === 'gallup.com' ||
    host === 'quantamagazine.org' ||
    host === 'spectrum.ieee.org' ||
    host === 'iclr.cc' ||
    host === 'papers.ssrn.com' ||
    host === 'basecamp-research.com' ||
    host === 'poynter.org' ||
    host === 'oecd.org' ||
    host === 'weforum.org' ||
    host === 'wmo.int' ||
    host === 'who.int' ||
    host === 'internationalaisafetyreport.org' ||
    host === 'cepal.org' ||
    host === 'news-medical.net' ||
    host === 'insidehighered.com' ||
    host === 'statnews.com' ||
    host === 'lesswrong.com' ||
    host === 'alignment.anthropic.com' ||
    host === 'cdn.openai.com' ||
    host === 'assets.anthropic.com' ||
    host === 'thequantuminsider.com' ||
    host === 'odsc.medium.com' ||
    host === 'labidecom.eca.usp.br' ||
    // GitHub research pages
    host.endsWith('.github.io') ||
    // Outro → Pesquisa
    host === 'chaiassets.com' ||
    host === 'danfu.org' ||
    host === 'www-cdn.anthropic.com' ||
    host === 'publications.iadb.org' ||
    host === 'gartner.com' ||
    host === 'news.cognizant.com' ||
    host === 'thesciencesurvey.com' ||
    host === 'advisorperspectives.com' ||
    host === 'edtechinnovationhub.com' ||
    host === 'ufrn.br' ||
    host === 'fastcompanybrasil.com' ||
    host === 'services.google.com' ||
    (host === 'microsoft.com' && pathname.includes('/research/'))
  ) return 'Pesquisa';

  // Treinamento — cursos, certificações, workshops, bootcamps
  if (
    host === 'coursera.org' ||
    host === 'udemy.com' ||
    host === 'edx.org' ||
    host === 'linkedin.com' && pathname.includes('/learning/') ||
    host === 'alura.com.br' ||
    host === 'dio.me' ||
    host === 'nucamp.co' ||
    host === 'conquer.plus' ||
    host === 'learnwithmeai.com' ||
    host === 'youreverydayai.com' ||
    host === 'kahoot.com' ||
    host === 'unlockingaispotential.com' ||
    host === 'skillshare.com' ||
    host === 'pluralsight.com' ||
    host === 'datacamp.com' ||
    host === 'fast.ai' ||
    host === 'cloudonair.withgoogle.com' ||
    host === 'grow.google' ||
    host === 'gd.eurisko.com.br' ||
    host === 'academy.google.com' ||
    host === 'gaiaciencia.com.br' ||
    host === 'academia.org.br' ||
    // Páginas de certificação/curso dentro de sites maiores
    (pathname.includes('/certificate') || pathname.includes('/certification') ||
     pathname.includes('/curso') || pathname.includes('/course') ||
     pathname.includes('/bootcamp') || pathname.includes('/workshop') ||
     pathname.includes('/treinamento') || pathname.includes('/capacita')) ||
    // Outro → Treinamento
    host === 'portal.ifce.edu.br' ||
    host === 'brasil.ia.inesq.org.br'
  ) return 'Treinamento';

  // Ferramenta — docs, repos, tools, apps
  if (
    host === 'github.com' ||
    host === 'gitlab.com' ||
    host.startsWith('docs.') ||
    host.startsWith('developer.') ||
    host.startsWith('platform.') ||
    host === 'npmjs.com' ||
    host === 'pypi.org' ||
    host === 'huggingface.co' ||
    host === 'red.anthropic.com' ||
    host === 'cursor.com' ||
    host === 'claude.ai' ||
    host === 'chatgpt.com' ||
    host === 'gemini.google.com' ||
    host === 'perplexity.ai' || host === 'pplx.ai' ||
    host === 'slack.com' ||
    host === 'ia.br' ||
    host === 'drive.google.com' ||
    host === 'support.google.com' ||
    host === 'support.claude.com' ||
    host === 'help.openai.com' ||
    host === 'developers.openai.com' ||
    host === 'cloud.google.com' ||
    host === 'notion.com' ||
    host === 'figma.com' ||
    host === 'grammarly.com' ||
    host === 'openrouter.ai' ||
    host === 'aws.amazon.com' ||
    host === 'bentoml.com' ||
    host === 'databricks.com' ||
    host === 'oracle.com' ||
    host === 'nodejs.org' ||
    host === 'glideapps.com' ||
    host === 'testingcatalog.com' ||
    host === 'agents.md' ||
    host === 'design.md' ||
    host === 'opentools.ai' ||
    pathname.includes('/docs/') ||
    pathname.includes('/api/') ||
    pathname.includes('/sdk/') ||
    // Outro → Ferramenta
    host === 'creative-tim.com' ||
    (host === 'microsoft.com' && pathname.includes('/edge/'))
  ) return 'Ferramenta';

  // Regulação — policy, law, regulation
  if (
    host.includes('euaiact') ||
    host === 'artificialintelligenceact.eu' ||
    host === 'consilium.europa.eu' ||
    host === 'europarl.europa.eu' ||
    host.endsWith('.gov') ||
    host.endsWith('.gov.br') || host === 'gov.br' ||
    host.endsWith('.leg.br') ||
    host.endsWith('.legis.br') ||
    host.endsWith('.jus.br') ||
    host === 'registro.br' ||
    host === 'cnj.jus.br' ||
    host === 'wto.org' ||
    host === 'news.un.org' ||
    host === 'aisi.gov.uk' ||
    host === 'impact.indiaai.gov.in' ||
    host === 'genai.mil' ||
    host === 'news.bloomberglaw.com' ||
    host === 'politico.com' || host.endsWith('.politico.com') ||
    host === 'thehill.com' ||
    pathname.includes('/policy/') ||
    pathname.includes('/regulation') ||
    pathname.includes('/governance') ||
    url.includes('bug-bounty') || url.includes('safety-bounty') ||
    // Outro → Regulação
    host === 'portal.cfm.org.br' ||
    host === 'transparencycoalition.ai' ||
    host === 'correio24horas.com.br' ||
    host === 'english.luatvietnam.vn' ||
    host === 'iab.com' ||
    // #3145: veículos jurídicos/regulatórios BR — auditoria de código (sem acesso a
    // dados reais de produção nesta sessão), lacuna óbvia pra uma newsletter que
    // cobre regulação de IA no Brasil (LGPD, PL de IA, decisões judiciais).
    host === 'jota.info' ||
    host === 'migalhas.com.br' ||
    host === 'conjur.com.br'
  ) return 'Regulação';

  // Curiosidade — cultural, pop, wikipedia, encyclopedic
  if (
    host.includes('wikipedia.org') ||
    host.includes('wikimedia.org') ||
    host === 'wikidata.org' ||
    host === 'gizmodo.com' || host === 'gizmodo.com.br' ||
    host === 'imdb.com' ||
    host === 'rottentomatoes.com' ||
    host === 'soberaniacognitiva.com.br' ||
    host === 'futurism.com' ||
    (host === 'wired.com' && (pathname.includes('/culture/') || pathname.includes('/magazine/'))) ||
    host === 'variety.com' ||
    host === 'deadline.com' ||
    host === 'kotaku.com' ||
    host === 'dexerto.com' ||
    host === 'reddit.com' ||
    host === 'youtube.com' || host === 'youtu.be' ||
    host === 'i.ytimg.com' ||
    host === 'universalmusic.com' ||
    host === 'motionpictures.org' ||
    host === 'nymag.com' && pathname.includes('/culture/') ||
    host === 'darioamodei.com' ||
    host === 'karpathy.bearblog.dev' ||
    host === 'lesswrong.com' ||
    host === 'critterz.tv' ||
    host === 'hollywoodreporter.com' ||
    host === 'automaton-media.com' ||
    // Outro → Curiosidade
    host === 'merriam-webster.com' ||
    host === 'focusfeatures.com' ||
    host === 'computerhope.com' ||
    host === 'molt.church' ||
    host === 'nexalgaming.co' ||
    pathname.includes('copa-do-mundo') || pathname.includes('pokemon')
  ) return 'Curiosidade';

  // Lançamento — official blog announcements & AI company releases
  const isAiCompany =
    host === 'anthropic.com' ||
    host === 'openai.com' ||
    host === 'mistral.ai' ||
    host === 'cohere.com' ||
    host === 'ai21.com' ||
    host === 'inflection.ai' ||
    host === 'together.ai' ||
    host === 'replicate.com' ||
    host === 'stability.ai' ||
    host === 'midjourney.com' ||
    host === 'runway.com' ||
    host === 'z.ai' || host === 'zhipuai.cn' ||
    host === 'andon.ai' ||
    host === 'x.ai' ||
    host === 'qwen.ai' ||
    host === 'minimax.io' ||
    host === 'moonshot.cn' ||
    host === 'tomoviee.ai' ||
    host === 'app.tomoviee.ai' ||
    host === 'heygenuser.com' || host === 'heygen.com' ||
    host === 'arcee.ai' ||
    host === 'allenai.org' ||
    host === 'claude.com' ||
    host === 'elevenlabs.io' ||
    host === 'kimi.com' || host === 'moonshot.ai' ||
    host === 'tegabrain.com' ||
    host === 'accomplish.ai' ||
    host === 'openclaw.ai' ||
    host === 'manus.im' ||
    host === 'meta.ai' ||
    host === 'ai.com' ||
    host === 'humain.com' ||
    host === 'suno.com' ||
    host === 'gamma.app' ||
    host === 'fal.ai' ||
    host === 'bfl.ai' ||
    host === 'runwayml.com' ||
    host === 'extropic.ai' ||
    host === 'superhuman.ai' ||
    host === 'marketeam.ai' ||
    host === 'midoo.ai' ||
    host === 'sentient.foundation' ||
    host === 'epoch.ai' ||
    host === 'exa.ai' ||
    host === 'lovable.dev' || // AI coding tool
    host === 'andonlabs.com' ||
    host === 'builder.ai' ||
    host === 'pharma.ai' ||
    host === 'blip.ai' ||
    host === 'chat.qwen.ai' ||
    host === 'visualelectric.com' ||
    host === 'kiro.dev' ||
    host === 'operaneon.com' ||
    host === 'ap2-protocol.org' ||
    host === 'api-docs.deepseek.com' ||
    host === 'deepseek.com' ||
    host === 'periodic.com' ||
    host === 'anthrogen.com' ||
    host === '3d-models.hunyuan.tencent.com' ||
    host === 'superintelligence-statement.org' ||
    host === 'ir.amd.com' ||
    host === 'github.blog' ||
    host === 'labs.google.com' ||
    host === 'hcompany.ai' ||
    host === 'news.lmarena.ai' ||
    // #3145: empresas/ferramentas de IA nativas comuns em cobertura de IA —
    // auditoria de código (sem acesso a dados reais de produção nesta sessão),
    // lacuna óbvia contra o volume de lançamentos que a Diar.ia cobre.
    host === 'groq.com' ||
    host === 'character.ai' ||
    host === 'you.com' ||
    host === 'leonardo.ai' ||
    host === 'pika.art' ||
    host === 'synthesia.io' ||
    host === 'descript.com' ||
    host === 'otter.ai' ||
    host === 'langchain.com' ||
    // Outro → Lançamento
    host === 'lambda.ai' ||
    host === 'poe.com' ||
    host === 'intology.ai' ||
    host === 'edisonscientific.com' ||
    host === 'blog.character.ai' ||
    host === 'klarna.com' ||
    host === 'resemble.ai' ||
    host === 'ensemblelisteningmodel.com' ||
    host === 'prism.openai.com' ||
    host === 'community.openai.com' ||
    host === 'securiti.ai' ||
    host === 'nemoclaw.bot' ||
    host === 'sync.so' ||
    host === 't54.ai' ||
    host === 'moltbook.com' ||
    host === 'awesomeagents.ai' ||
    host === '24aiglobal.com' ||
    host === 'datadome.co' ||
    host === 'hp.com' ||
    host === 'seed.bytedance.com' ||
    host === 'clawd.bot' ||
    (host === 'meta.com' && pathname.includes('/connect'));

  const isTechBlog =
    (host.includes('google') && (pathname.includes('/blog/') || pathname.includes('/intl/'))) ||
    host === 'blog.google' ||
    host === 'developers.googleblog.com' ||
    host === 'workspaceupdates.googleblog.com' ||
    host === 'labs.google' ||
    host === 'stitch.withgoogle.com' ||
    host === 'aistudio.google.com' ||
    host === 'cloud.google.com' && pathname.includes('/blog/') ||
    (host.includes('microsoft.com') && pathname.includes('/blog/')) ||
    host === 'microsoft.ai' ||
    host === 'news.microsoft.com' ||
    host === 'blogs.microsoft.com' ||
    (host === 'meta.com' && pathname.includes('/blog/')) ||
    host === 'about.fb.com' ||
    (host === 'facebook.com' && pathname.includes('/business/news/')) ||
    host === 'nvidianews.nvidia.com' ||
    host === 'blogs.nvidia.com' ||
    host === 'nvidia.com' && pathname.includes('/blog/') ||
    host === 'news.samsung.com' ||
    host === 'samsungmobilepress.com' ||
    host === 'aboutamazon.com' ||
    host === 'newsroom.ibm.com' ||
    host === 'newsroom.intel.com' ||
    host === 'newsroom.accenture.com' ||
    host === 'newsroom.spotify.com' ||
    host === 'newsroom.paypal-corp.com' ||
    host === 'press.asus.com' ||
    host === 'news.adobe.com' ||
    host === 'business.adobe.com' ||
    host === 'blog.adobe.com' ||
    host === 'oracle.com' && pathname.includes('/news/') ||
    host === 'aws.amazon.com' && pathname.includes('/blogs/') ||
    (host === 'replit.com' && pathname.includes('/blog/')) ||
    host === 'prnewswire.com' ||
    host === 'globenewswire.com' ||
    host === 'newswire.ca' ||
    host === 'businesswire.com' ||
    // Outro → Lançamento (tech blogs / newsrooms)
    host === 'blog.mozilla.org' ||
    host === 'news.lenovo.com' ||
    host === 'enterprise.wikimedia.com' ||
    host === 'newsroom.fedex.com' ||
    host === 'lego.com';

  if (isAiCompany || isTechBlog) return 'Lançamento';

  // Negócios — business, finance, industry news
  if (
    // International finance/biz
    host === 'bloomberg.com' || host.endsWith('.bloomberg.com') || host === 'bnnbloomberg.ca' ||
    host === 'reuters.com' ||
    host === 'ft.com' ||
    host === 'wsj.com' ||
    host === 'forbes.com' || host === 'forbes.com.br' ||
    host === 'businessinsider.com' ||
    host === 'cnbc.com' ||
    host === 'fortune.com' ||
    host === 'economist.com' ||
    host === 'hbr.org' ||
    host === 'inc.com' ||
    host === 'fastcompany.com' ||
    // Tech news international
    host === 'techcrunch.com' ||
    host === 'venturebeat.com' ||
    host === 'theverge.com' ||
    host === 'wired.com' ||
    host === 'arstechnica.com' ||
    host === 'axios.com' ||
    host === 'technologyreview.com' || host.includes('technologyreview') ||
    host === 'zdnet.com' ||
    host === 'cnet.com' ||
    host === 'engadget.com' ||
    host === 'neowin.net' ||
    host === 'techzine.eu' ||
    host === 'techradar.com' ||
    host === 'tomshardware.com' ||
    host === 'artificialintelligence-news.com' ||
    host === 'the-decoder.com' ||
    host === 'techbuzz.ai' ||
    host === 'mashable.com' ||
    host === 'usnews.com' ||
    host === 'futurism.com' ||
    host === 'aljazeera.com' ||
    host === 'indiatoday.in' ||
    host === 'chosun.com' ||
    host === 'independent.co.uk' ||
    host === 'theatlantic.com' ||
    // Finance/market data
    host === 'yahoo.com' || host === 'finance.yahoo.com' ||
    host === 'markets.financialcontent.com' ||
    // General media
    host === 'nytimes.com' ||
    host === 'washingtonpost.com' ||
    host === 'theguardian.com' ||
    host === 'bbc.com' || host === 'bbc.co.uk' ||
    host === 'cnn.com' || host === 'edition.cnn.com' ||
    // Brazilian media
    host === 'exame.com' ||
    host === 'cnnbrasil.com.br' ||
    host === 'veja.abril.com.br' ||
    host === 'g1.globo.com' ||
    host === 'timesbrasil.com.br' ||
    host === 'tiinside.com.br' ||
    host === 'webpronews.com' ||
    host === 'ibm.com' ||
    // Consulting / enterprise
    host === 'accenture.com' ||
    host === 'mckinsey.com' ||
    host === 'pwc.com' ||
    host === 'deloitte.com' ||
    // Blogs / opinion
    host === 'medium.com' ||
    host === 'substack.com' || host.endsWith('.substack.com') ||
    // Amazon (product/shopping)
    host === 'amazon.com.br' || host === 'amzn.to' ||
    // Apple (product)
    host === 'apple.com' || host.endsWith('.apple.com') ||
    // More intl tech/business news
    host === 'euronews.com' ||
    host === 'timesofindia.indiatimes.com' ||
    host === 'economictimes.indiatimes.com' ||
    host === 'economictimes.com' ||
    host === 'business-standard.com' ||
    host === 'abcnews.go.com' ||
    host === 'cbsnews.com' ||
    host === 'nbcnews.com' ||
    host === 'npr.org' ||
    host === 'latimes.com' ||
    host === 'time.com' ||
    host === 'theatlantic.com' ||
    host === 'nymag.com' ||
    host === 'reason.com' ||
    host === 'theinformation.com' ||
    host === 'thenextweb.com' ||
    host === 'siliconangle.com' ||
    host === 'siliconrepublic.com' ||
    host === '404media.co' ||
    host === 'theregister.com' ||
    host === 'computerworld.com' ||
    host === 'windowscentral.com' ||
    host === 'techspot.com' ||
    host === 'techpowerup.com' ||
    host === 'tweaktown.com' ||
    host === 'geeky-gadgets.com' ||
    host === 'analyticsinsight.net' ||
    host === 'aibusiness.com' ||
    host === 'ainews.net.br' ||
    host === 'ainvest.com' ||
    host === 'aiBusinessnews.com' ||
    host === 'timesofai.com' ||
    host === 'techbuzz.ai' ||
    host === 'thedeepview.com' ||
    host === 'dataconomy.com' ||
    host === 'diginomica.com' ||
    host === 'hpcwire.com' ||
    host === 'cio.com' ||
    host === 'builtin.com' ||
    host === 'marktechpost.com' ||
    host === 'startupresearcher.com' ||
    host === 'startse.com' ||
    host === 'neofeed.com.br' ||
    host === 'suno.com.br' ||
    host === 'canaltech.com.br' ||
    host === 'tecmundo.com.br' ||
    host === 'olhardigital.com.br' ||
    host === 'tecnoblog.net' ||
    host === 'gazetadopovo.com.br' ||
    host === 'otempo.com.br' ||
    host === 'oglobo.globo.com' ||
    host === 'uol.com.br' || host === 'economia.uol.com.br' ||
    host === 'braziljournal.com' ||
    host === 'anba.com.br' ||
    host === 'infomoney.com.br' ||
    host === 'seudinheiro.com' ||
    host === 'portalnovarejo.com.br' ||
    host === 'sbtnews.sbt.com.br' ||
    host === 'jornaldebrasilia.com.br' ||
    host === 'agenciabrasil.ebc.com.br' ||
    host === 'apublica.org' ||
    host === 'congressoemfoco.com.br' ||
    host === 'convergenciadigital.com.br' ||
    host === 'eco.sapo.pt' ||
    host === 'news.cgtn.com' ||
    host === 'eu.36kr.com' ||
    host === 'bnamericas.com' ||
    host === 'morningstar.com' ||
    host === 'investing.com' ||
    host === 'spglobal.com' ||
    host === 'benzinga.com' ||
    host === 'simplywall.st' ||
    host === 'tipranks.com' ||
    host === 'linkedin.com' ||
    host === 'x.com' ||
    // India/intl
    host === 'ndtv.com' ||
    host === 'indiatoday.in' ||
    host === 'thehindu.com' ||
    // EU/international
    host === 'brusselstimes.com' ||
    host === 'europeanbusinessreview.com' ||
    host === 'sifted.eu' ||
    // AI news general
    host === 'theaibreak.com' ||
    host === 'ground.news' ||
    host === 'tomtunguz.com' ||
    host === 'fedscoop.com' ||
    host === 'globalgovernmentforum.com' ||
    host === 'pymnts.com' ||
    host === 'thefintechtimes.com' ||
    host === 'retailtechinnovationhub.com' ||
    host === 'musicbusinessworldwide.com' ||
    host === 'radiologybusiness.com' ||
    host === 'healthcaredive.com' ||
    host === 'highereddive.com' ||
    host === 'hrexecutive.com' ||
    host === 'impakter.com' ||
    host === 'insurancejournal.com' ||
    host === 'japantimes.co.jp' ||
    host === 'abs-cbn.com' ||
    host === 'aljazeera.com' ||
    host === 'chosun.com' ||
    host === 'independent.co.uk' ||
    host === 'canadianaffairs.news' ||
    host === 'indexbox.io' ||
    host === 'waymo.com' ||
    host === 'spacex.com' ||
    host === 'wiz.io' ||
    host === 'cisco.com' || host === 'investor.cisco.com' ||
    host === 'uber.com' ||
    host === 'global.fujitsu' ||
    host === 'epic.com' ||
    host === 'scmp.com' ||
    host === 'pcmag.com' ||
    host === 'patentlyapple.com' ||
    host === 'newsroom.cisco.com' ||
    host === 'techfundingnews.com' ||
    host === 'acaert.com.br' ||
    // Catch Google news/product pages not already caught
    (host === 'google.com' && (pathname.includes('/ai') || pathname.includes('/blog') || pathname.includes('/intl'))) ||
    host === 'content.techgig.com' ||
    host === 'mlq.ai' ||
    host === 'techinasia.com' ||
    host === 'odyssey.ml' ||
    host === 'theaiworld.org' ||
    host === 'aitechsuite.com' ||
    host === 'entrepreneur.com' ||
    host === 'talkdigital.co' ||
    host === 'techshotsapp.com' ||
    host === 'flash.co' ||
    // Outro → Negócios subcategories
    host === 'ultimosegundo.ig.com.br' ||
    host === 'rollingstone.com' ||
    host === '9to5mac.com' ||
    host === '9to5google.com' ||
    host === 'apnews.com' ||
    host === 'businesstimes.com.sg' ||
    host === 'in.mashable.com' ||
    host === 'technobezz.com' ||
    host === 'newsdefused.com' ||
    host === 'seroundtable.com' ||
    host === 'erp.today' ||
    host === 'resilientcyber.io' ||
    host === 'inesplorato.com.br' ||
    host === 'infobae.com' ||
    host === 'roastbrief.us' ||
    host === 'techrt.com' ||
    host === 'kq2.com' ||
    host === 'theblock.co' ||
    host === 'how2shout.com' ||
    host === 'seucreditodigital.com.br' ||
    // Mercado-leaning
    host === 'goldmansachs.com' ||
    host === 'coinpaper.com' ||
    host === 'uk.finance.yahoo.com' ||
    host === 'sg.news.yahoo.com' ||
    host === 'financialcontent.com' ||
    host === 'manilatimes.net' ||
    host === 'thenewyorkfinance.com' ||
    // Aplicação-leaning
    host === 'hyundai.com' ||
    host === 'fiercehealthcare.com' ||
    host === 'virginaustralia.com' ||
    host === 'expresscomputer.in' ||
    host === 'reinsurancene.ws' ||
    host === 'allianz.com' ||
    host === 'synaptics.com' ||
    // Mercado-specific
    host === 'man.com' ||
    // Hardware-leaning
    host === 'nvidia.com' ||
    host === 'nebius.com' ||
    host === 'news.skhynix.com' ||
    host === 'thetechportal.com' ||
    // #3145: lacunas óbvias identificadas via auditoria de código (sem acesso
    // a dados reais de produção nesta sessão) — veículos BR de grande porte
    // (Estadão/Folha/Valor/Terra/R7/Metrópoles) e veículos internacionais de
    // tech/business recorrentes em cobertura de IA que ainda caíam em 'Outro'.
    host === 'estadao.com.br' ||
    host === 'folha.uol.com.br' ||
    host === 'valor.globo.com' ||
    host === 'metropoles.com' ||
    host === 'terra.com.br' ||
    host === 'r7.com' ||
    host === 'poder360.com.br' ||
    host === 'istoedinheiro.com.br' ||
    host === 'epocanegocios.globo.com' ||
    host === 'moneytimes.com.br' ||
    host === 'semafor.com' ||
    host === 'restofworld.org' ||
    host === 'stratechery.com' ||
    host === 'marketwatch.com' ||
    host === 'geekwire.com' ||
    host === 'macrumors.com' ||
    host === 'appleinsider.com' ||
    host === 'digitaltrends.com'
  ) {
    // Use anchor if descriptive, else section title, else post title as last resort
    const isGeneric = !anchor || anchor.length < 3 || /^https?:\/\//.test(anchor) || /^(aprofunde|saiba mais|aqui|veja|clique|leia)$/i.test(anchor.trim());
    const sectionClean = /^[_\s]+$/.test(sectionTitle.trim()) ? '' : sectionTitle;
    const signal = isGeneric ? (sectionClean || postTitle || anchor) : anchor;
    // Enrich with paragraph context + URL path (hyphens→spaces for keyword matching)
    const pathSpaced = pathname.replace(/-/g, ' ');
    const enrichedSignal = signal + ' ' + context + ' ' + pathSpaced;
    return negociosSubcategory(enrichedSignal);
  }

  // .ai TLD heuristic — unknown .ai domains are typically AI startup announcements
  if (/^[^.]+\.ai$/.test(host)) return 'Lançamento';

  // Fallback
  return 'Outro';
}

// ─── Newsletter section (structural) ───────────────────────────────────────

/**
 * Kickers renderizados via renderKicker() (scripts/lib/newsletter-render-html.ts)
 * que NÃO envolvem links editoriais de conteúdo — aparecem acima dos blocos É
 * IA?/Divulgação/Sorteio/Para encerrar. Um link raro capturado sob um desses
 * (a maioria já é filtrada por isEditorial() em build-link-ctr.ts) não deve
 * ser rotulado incorretamente como 'Destaque'.
 */
const NON_SECTION_KICKERS = new Set(['É IA?', 'DIVULGAÇÃO', 'SORTEIO', 'PARA ENCERRAR']);

/**
 * Seções secundárias canônicas (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS + aliases
 * legacy PESQUISAS/OUTRAS NOTÍCIAS, cf. `SECTIONS` em section-naming.ts) →
 * label singular pra exibição. Padrões espelham `SECTIONS[].pattern`
 * (case-insensitive aqui pois comparamos contra `.toUpperCase()`).
 */
const SECONDARY_SECTION_LABELS: Array<{ re: RegExp; label: string }> = [
  { re: /^LAN[ÇC]AMENTOS?$/, label: 'Lançamento' },
  { re: /^RADAR$/, label: 'Radar' },
  { re: /^USE\s+MELHOR$/, label: 'Use Melhor' },
  { re: /^V[ÍI]DEOS?$/, label: 'Vídeo' },
  { re: /^PESQUISAS?$/, label: 'Radar' }, // legacy alias (#1569)
  { re: /^OUTRAS?\s+NOT[ÍI]CIAS?$/, label: 'Radar' }, // legacy alias (#1569)
];

/**
 * Resolve a SEÇÃO REAL da newsletter onde um link apareceu (Destaque /
 * Lançamento / Radar / Use Melhor / Vídeo), a partir do `section_title` bruto
 * extraído por `extractLinks()` — o texto do kicker <td> mais próximo ACIMA
 * do link no HTML renderizado.
 *
 * Distinto de `categorize()`: aqui a fonte é ESTRUTURAL (qual bloco da
 * newsletter envolve o link), não uma inferência por domínio/conteúdo — as
 * duas dimensões podem (e costumam) divergir, ex: um link 'Lançamento' por
 * `categorize()` pode ter aparecido dentro do RADAR.
 *
 * Como funciona:
 * - Seções secundárias (renderSection() → renderKicker(displaySectionName(...)),
 *   com prefixo emoji + singular/plural) → label canônico via
 *   `SECONDARY_SECTION_LABELS`.
 * - O kicker de um Destaque usa a categoria editorial da matéria
 *   (`renderKicker(d.category)` em renderDestaque(), ex: "LANÇAMENTO" /
 *   "REGULAÇÃO" / "NOTÍCIA" — ver `CATEGORY_EMOJI` em newsletter-parse.ts).
 *   Esse texto é livre e não é enumerado aqui: qualquer heading não
 *   reconhecido como seção secundária, não-vazio, e não um kicker de bloco
 *   não-editorial é assumido como Destaque — única outra origem de kicker com
 *   link editorial no template.
 * - Kickers de blocos sem conteúdo editorial (É IA?, Divulgação, Sorteio,
 *   Para encerrar) retornam 'Outro' em vez de 'Destaque' incorreto.
 * - Heading vazio (post antigo pré-#3043, sem match de kicker) → ''.
 *
 * Limitação conhecida (ambiguidade estrutural, não um bug de parsing): 2 das
 * 14 categorias editoriais de Destaque colidem textualmente com o singular de
 * uma seção secundária — "LANÇAMENTO" (categoria) === "LANÇAMENTO" (seção
 * LANÇAMENTOS com 1 item) e "PESQUISA" (categoria) === "PESQUISA" (alias
 * legacy de RADAR com 1 item). `renderKicker()` sempre remove qualquer prefixo
 * emoji do texto ANTES de renderizar (`stripKickerEmoji`), então o HTML final
 * não preserva nenhum sinal que distinga as duas origens nesses 2 casos —
 * ambos resolvem pro label da seção secundária (Lançamento/Radar), não
 * 'Destaque'. Nos outros 12 casos (REGULAÇÃO/MERCADO/FERRAMENTA/PRODUTO/
 * TENDÊNCIA/INDÚSTRIA/CULTURA/BRASIL/OPINIÃO/DADOS/CONCEITO/NOTÍCIA) não há
 * colisão — resolvem corretamente pra 'Destaque'.
 */
export function resolveNewsletterSection(sectionTitle: string): string {
  const bare = stripEmojiPrefix(sectionTitle ?? '').trim();
  if (!bare) return '';
  const upper = bare.toUpperCase();
  if (NON_SECTION_KICKERS.has(upper)) return 'Outro';
  for (const { re, label } of SECONDARY_SECTION_LABELS) {
    if (re.test(upper)) return label;
  }
  return 'Destaque';
}
