const Anthropic = require('@anthropic-ai/sdk');
const { buildPrompt } = require('./prompt');
const { parseResponse } = require('./parser');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── CACHE DE CONFIGURAÇÃO DA CLÍNICA ────────────────────────────────────────
// Por quê existe: buscar configs da clínica no banco a cada mensagem é caro.
// Como funciona: guarda o resultado por 5 minutos. Se a clínica atualizar
// as configs no dashboard, o cache é invalidado automaticamente via
// invalidateCache(). Se não invalidar, a atualização leva até 5min para valer.
// Risco: se o servidor reiniciar, o cache é perdido — isso é seguro, apenas
// a primeira mensagem após reinício será um pouco mais lenta.

const configCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos em milissegundos

async function getClinicConfig(clinicaId) {
  const cached = configCache.get(clinicaId);

  // Verifica se existe cache válido (não expirado)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  // Busca tudo em paralelo — mais rápido que buscar um por um
  const [clinica, sofia, medicos, faqs, horarios] = await Promise.all([
    supabase.from('clinicas').select('*').eq('id', clinicaId).single(),
    supabase.from('sofia_configs').select('*').eq('clinica_id', clinicaId).single(),
    supabase.from('medicos').select('*').eq('clinica_id', clinicaId).eq('ativo', true),
    supabase.from('faqs').select('*').eq('clinica_id', clinicaId).order('ordem'),
    supabase
      .from('horarios_disponiveis')
      .select('*, medicos(nome)')
      .eq('clinica_id', clinicaId)
      .eq('disponivel', true)
      // Só busca horários a partir de agora — evita mostrar horários passados
      .gte('data_hora', new Date().toISOString())
      .order('data_hora', { ascending: true })
      .limit(12)
  ]);

  const data = {
    clinica: clinica.data,
    sofia: sofia.data,
    medicos: medicos.data || [],
    faqs: faqs.data || [],
    horarios: (horarios.data || []).map(h => ({
      ...h,
      medico_nome: h.medicos?.nome
    }))
  };

  // Salva no cache com timestamp atual
  configCache.set(clinicaId, { data, ts: Date.now() });
  return data;
}

// Chame essa função sempre que a clínica salvar configurações no dashboard.
// Exemplo de uso no endpoint de salvar config:
// const { invalidateCache } = require('../ai/sofia');
// invalidateCache(clinicaId);
function invalidateCache(clinicaId) {
  configCache.delete(clinicaId);
}

// ─── PACIENTE ─────────────────────────────────────────────────────────────────
// Por quê maybeSingle() em vez de single(): o .single() lança erro se não
// encontrar nada. O .maybeSingle() retorna null sem erro — mais seguro para
// casos onde o paciente ainda não existe no banco.

async function getOrCreatePaciente(clinicaId, telefone) {
  const { data: paciente } = await supabase
    .from('pacientes')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('telefone', telefone)
    .maybeSingle();

  if (paciente) {
    // Atualiza último contato sem bloquear o fluxo (fire and forget)
    // Por quê não await: não precisamos esperar essa atualização para continuar
    supabase
      .from('pacientes')
      .update({ ultimo_contato: new Date().toISOString() })
      .eq('id', paciente.id)
      .then(() => {}) // silencia o warning de promise não tratada
      .catch(e => console.error('Erro ao atualizar ultimo_contato:', e.message));

    return paciente;
  }

  // Cria novo paciente com apenas o telefone — nome será preenchido
  // automaticamente quando ele se identificar durante o agendamento
  const { data: novo, error } = await supabase
    .from('pacientes')
    .insert({
      clinica_id: clinicaId,
      telefone,
      ultimo_contato: new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar paciente: ${error.message}`);
  return novo;
}

// ─── PERFIL DO PACIENTE ───────────────────────────────────────────────────────
// Por quê existe: é o que resolve o problema do paciente que volta depois.
// A conversa tem histórico limitado (últimas 8 mensagens dessa sessão).
// O perfil é permanente — carrega o que sabemos sobre o paciente em TODAS
// as conversas anteriores, não só a atual.
// O que incluímos: apenas o que é útil para a Sofia — nome, convênio,
// se já foi atendido antes. Não incluímos CPF ou dados sensíveis.

function buildPerfilPaciente(paciente, agendamentoRecente) {
  // Paciente nunca interagiu antes
  if (!paciente.nome && !agendamentoRecente) {
    return `PERFIL DO PACIENTE:
- Primeiro contato — não temos cadastro anterior
- Não pergunte se ele já veio antes, apenas atenda normalmente`;
  }

  // Paciente já conhecido
  let perfil = `PERFIL DO PACIENTE:
- Nome: ${paciente.nome || 'não informado ainda'}
- Já atendido anteriormente: sim`;

  if (paciente.convenio) {
    perfil += `\n- Convênio registrado: ${paciente.convenio}`;
  }

  if (agendamentoRecente) {
    perfil += `\n- Tem consulta agendada: ${agendamentoRecente.data_hora_formatada} com ${agendamentoRecente.medico_nome}`;
    perfil += `\n- Status da consulta: ${agendamentoRecente.status}`;
  }

  // Instrução específica baseada no que sabemos
  if (paciente.nome) {
    perfil += `\n\nINSTRUÇÃO: Você já conhece este paciente. Chame pelo nome "${paciente.nome}" e NÃO peça o nome novamente.`;
  }

  if (agendamentoRecente && agendamentoRecente.status === 'confirmado') {
    perfil += `\nINSTRUÇÃO: Este paciente tem consulta agendada. Se ele perguntar sobre o agendamento, confirme os dados acima.`;
  }

  return perfil;
}

// ─── AGENDAMENTO RECENTE ──────────────────────────────────────────────────────
// Busca o agendamento mais recente do paciente nessa clínica.
// Por quê: para informar a Sofia se ele já tem consulta marcada,
// evitando que ela ofereça novo agendamento desnecessariamente.
// Limite de 30 dias: só considera consultas futuras ou recentes.

async function getAgendamentoRecente(clinicaId, pacienteId) {
  const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('agendamentos')
    .select('*, medicos(nome)')
    .eq('clinica_id', clinicaId)
    .eq('paciente_id', pacienteId)
    .in('status', ['confirmado', 'reagendado'])
    .gte('data_hora', trintaDiasAtras)
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  // Formata a data para o prompt de forma legível
  return {
    ...data,
    medico_nome: data.medicos?.nome || 'médico não identificado',
    data_hora_formatada: new Date(data.data_hora).toLocaleString('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  };
}

// ─── CONVERSA ─────────────────────────────────────────────────────────────────
// Por quê 2 horas: é o tempo que consideramos uma conversa "ativa".
// Se o paciente mandar mensagem após 2 horas, abrimos uma conversa nova.
// Isso resolve o problema do histórico longo que confundia a Sofia.
// Ajuste esse valor se quiser janelas maiores ou menores.

async function getOrCreateConversa(clinicaId, pacienteId) {
  const duasHorasAtras = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: conversa } = await supabase
    .from('conversas')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('paciente_id', pacienteId)
    .eq('status', 'ativa')
    .gte('iniciada_em', duasHorasAtras)
    .order('iniciada_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conversa) return conversa;

  const { data: nova, error } = await supabase
    .from('conversas')
    .insert({
      clinica_id: clinicaId,
      paciente_id: pacienteId,
      status: 'ativa',
      canal: 'whatsapp'
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar conversa: ${error.message}`);
  return nova;
}

// ─── HISTÓRICO ────────────────────────────────────────────────────────────────
// Por quê limite de 8: a IA fica confusa com histórico muito longo.
// 8 mensagens = 4 trocas = contexto suficiente para entender onde parou.
// O perfil do paciente (acima) compensa o que o histórico curto não cobre.

async function getHistorico(conversaId) {
  const { data } = await supabase
    .from('mensagens')
    .select('role, conteudo')
    .eq('conversa_id', conversaId)
    .order('created_at', { ascending: true })
    .limit(8);

  return (data || []).map(m => ({ role: m.role, content: m.conteudo }));
}

// ─── PERSISTÊNCIA ─────────────────────────────────────────────────────────────

async function salvarMensagem(conversaId, role, conteudo, tokens = 0) {
  const { error } = await supabase.from('mensagens').insert({
    conversa_id: conversaId,
    role,
    conteudo,
    tokens_usados: tokens
  });
  if (error) console.error('Erro ao salvar mensagem:', error.message);
}

async function encerrarConversa(conversaId, resolucao = 'ia') {
  const { error } = await supabase
    .from('conversas')
    .update({
      status: 'encerrada',
      resolucao,
      encerrada_em: new Date().toISOString()
    })
    .eq('id', conversaId);
  if (error) console.error('Erro ao encerrar conversa:', error.message);
}

// Atualiza nome do paciente quando ele se identifica no agendamento.
// Por quê .is('nome', null): só atualiza se ainda não tem nome salvo.
// Evita sobrescrever um nome já confirmado com uma variação digitada errada.
async function atualizarNomePaciente(pacienteId, nome) {
  if (!nome || nome.trim().length < 3) return;
  const { error } = await supabase
    .from('pacientes')
    .update({ nome: nome.trim() })
    .eq('id', pacienteId)
    .is('nome', null);
  if (error) console.error('Erro ao atualizar nome do paciente:', error.message);
}

// Atualiza convênio do paciente quando identificado na conversa.
// Mesmo princípio — só salva se ainda não estava preenchido.
async function atualizarConvenioPaciente(pacienteId, convenio) {
  if (!convenio || convenio.trim().length < 2) return;
  const { error } = await supabase
    .from('pacientes')
    .update({ convenio: convenio.trim() })
    .eq('id', pacienteId)
    .is('convenio', null);
  if (error) console.error('Erro ao atualizar convênio do paciente:', error.message);
}

// ─── AGENDAMENTO ─────────────────────────────────────────────────────────────

async function salvarAgendamento(clinicaId, pacienteId, conversaId, booking) {
  // Busca médico pelo nome — usa ilike para ser tolerante a variações de case
  const { data: medico } = await supabase
    .from('medicos')
    .select('id, nome')
    .eq('clinica_id', clinicaId)
    .ilike('nome', `%${booking.medico}%`)
    .maybeSingle();

  const { error } = await supabase.from('agendamentos').insert({
    clinica_id: clinicaId,
    paciente_id: pacienteId,
    conversa_id: conversaId,
    medico_id: medico?.id || null,
    data_hora: new Date().toISOString(),
    motivo: booking.motivo,
    status: 'confirmado',
    origem: 'sofia'
  });

  if (error) {
    console.error('Erro ao salvar agendamento:', error.message);
    return;
  }

  // Notifica médico apenas se encontrou o registro dele no banco
  if (medico) {
    await supabase.from('notificacoes').insert({
      clinica_id: clinicaId,
      medico_id: medico.id,
      tipo: 'agendamento',
      titulo: 'Novo agendamento pela Sofia',
      corpo: `${booking.nome} — ${booking.data} às ${booking.hora} — ${booking.motivo}`
    });
  }

  // Atualiza perfil do paciente com nome e convênio se informados
  await atualizarNomePaciente(pacienteId, booking.nome);
  if (booking.convenio) {
    await atualizarConvenioPaciente(pacienteId, booking.convenio);
  }
}

// ─── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────
// Essa é a função chamada pelo webhook a cada mensagem recebida.
// Ordem dos passos é importante — não altere sem entender as dependências.

async function processarMensagem(clinicaId, telefone, mensagem) {
  try {
    // 1. Configurações da clínica (usa cache quando possível)
    const config = await getClinicConfig(clinicaId);
    if (!config.clinica) throw new Error(`Clínica não encontrada: ${clinicaId}`);

    // 2. Perfil do paciente — NOVO: carrega antes de montar o prompt
    const paciente = await getOrCreatePaciente(clinicaId, telefone);
    const agendamentoRecente = await getAgendamentoRecente(clinicaId, paciente.id);
    const perfilPaciente = buildPerfilPaciente(paciente, agendamentoRecente);

    // 3. Conversa ativa (ou nova se passaram mais de 2h)
    const conversa = await getOrCreateConversa(clinicaId, paciente.id);

    // 4. Histórico desta conversa (últimas 8 mensagens)
    const historico = await getHistorico(conversa.id);

    // 5. Salva mensagem do paciente antes de processar
    // Por quê antes: se der erro na IA, ainda temos o registro do que ele enviou
    await salvarMensagem(conversa.id, 'user', mensagem);

    // 6. Monta e envia para Claude
    // O perfilPaciente é passado ao buildPrompt — é o que resolve contatos posteriores
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: buildPrompt(config, perfilPaciente),
      messages: [...historico, { role: 'user', content: mensagem }]
    });

    const rawText = response.content.map(b => b.text || '').join('');
    const parsed = parseResponse(rawText);

    // 7. Salva resposta da Sofia
    await salvarMensagem(
      conversa.id,
      'assistant',
      parsed.message,
      response.usage?.output_tokens || 0
    );

    // 8. Processa agendamento confirmado
    if (parsed.booking) {
      await salvarAgendamento(clinicaId, paciente.id, conversa.id, parsed.booking);
      // Encerra a conversa — próximo contato abre uma nova
      await encerrarConversa(conversa.id, 'ia');
    }

    // 9. Processa handoff
    if (parsed.handoff) {
      await encerrarConversa(conversa.id, 'humano');
      await supabase.from('notificacoes').insert({
        clinica_id: clinicaId,
        tipo: 'handoff',
        titulo: 'Paciente precisa de atendimento humano',
        corpo: `Telefone: ${telefone} — "${mensagem}"`
      });
    }

    return parsed.message;

  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    // Mensagem de fallback — nunca deixa o paciente sem resposta
    return 'Desculpe, tive um problema técnico. Tente novamente em instantes.';
  }
}

module.exports = { processarMensagem, invalidateCache };