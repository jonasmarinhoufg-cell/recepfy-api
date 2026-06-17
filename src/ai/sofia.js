const Anthropic = require('@anthropic-ai/sdk');
const { buildPrompt } = require('./prompt');
const { parseResponse } = require('./parser');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Busca todas as configurações da clínica no Supabase
async function getClinicConfig(clinicaId) {
  const [clinica, sofia, medicos, faqs, horarios] = await Promise.all([
    supabase
      .from('clinicas')
      .select('*')
      .eq('id', clinicaId)
      .single(),
    supabase
      .from('sofia_configs')
      .select('*')
      .eq('clinica_id', clinicaId)
      .single(),
    supabase
      .from('medicos')
      .select('*')
      .eq('clinica_id', clinicaId)
      .eq('ativo', true),
    supabase
      .from('faqs')
      .select('*')
      .eq('clinica_id', clinicaId)
      .order('ordem'),
    supabase
      .from('horarios_disponiveis')
      .select('*, medicos(nome)')
      .eq('clinica_id', clinicaId)
      .eq('disponivel', true)
      .gte('data_hora', new Date().toISOString())
      .limit(10)
  ]);

  return {
    clinica: clinica.data,
    sofia: sofia.data,
    medicos: medicos.data || [],
    faqs: faqs.data || [],
    horarios: (horarios.data || []).map(h => ({
      ...h,
      medico_nome: h.medicos?.nome
    }))
  };
}

// Busca ou cria conversa ativa do paciente
async function getOrCreateConversa(clinicaId, pacienteId) {
  // Busca conversa ativa
  const { data: conversa } = await supabase
    .from('conversas')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('paciente_id', pacienteId)
    .eq('status', 'ativa')
    .single();

  if (conversa) return conversa;

  // Cria nova conversa
  const { data: novaConversa } = await supabase
    .from('conversas')
    .insert({
      clinica_id: clinicaId,
      paciente_id: pacienteId,
      status: 'ativa',
      canal: 'whatsapp'
    })
    .select()
    .single();

  return novaConversa;
}

// Busca histórico de mensagens da conversa
async function getHistorico(conversaId) {
  const { data } = await supabase
    .from('mensagens')
    .select('role, conteudo')
    .eq('conversa_id', conversaId)
    .order('created_at', { ascending: true })
    .limit(20);

  return (data || []).map(m => ({
    role: m.role,
    content: m.conteudo
  }));
}

// Busca ou cria paciente pelo telefone
async function getOrCreatePaciente(clinicaId, telefone) {
  const { data: paciente } = await supabase
    .from('pacientes')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('telefone', telefone)
    .single();

  if (paciente) {
    // Atualiza último contato
    await supabase
      .from('pacientes')
      .update({ ultimo_contato: new Date().toISOString() })
      .eq('id', paciente.id);
    return paciente;
  }

  // Cria novo paciente
  const { data: novoPaciente } = await supabase
    .from('pacientes')
    .insert({
      clinica_id: clinicaId,
      telefone,
      ultimo_contato: new Date().toISOString()
    })
    .select()
    .single();

  return novoPaciente;
}

// Salva mensagem no banco
async function salvarMensagem(conversaId, role, conteudo, tokens = 0) {
  await supabase.from('mensagens').insert({
    conversa_id: conversaId,
    role,
    conteudo,
    tokens_usados: tokens
  });
}

// Salva agendamento e notifica médico
async function salvarAgendamento(clinicaId, pacienteId, conversaId, booking) {
  // Busca médico pelo nome
  const { data: medico } = await supabase
    .from('medicos')
    .select('id')
    .eq('clinica_id', clinicaId)
    .ilike('nome', `%${booking.medico}%`)
    .single();

  // Salva agendamento
  const { data: agendamento } = await supabase
    .from('agendamentos')
    .insert({
      clinica_id: clinicaId,
      paciente_id: pacienteId,
      conversa_id: conversaId,
      medico_id: medico?.id,
      data_hora: new Date().toISOString(),
      motivo: booking.motivo,
      status: 'confirmado',
      origem: 'sofia'
    })
    .select()
    .single();

  // Cria notificação para o médico
  if (medico) {
    await supabase.from('notificacoes').insert({
      clinica_id: clinicaId,
      medico_id: medico.id,
      tipo: 'agendamento',
      titulo: 'Novo agendamento pela Sofia',
      corpo: `${booking.nome} — ${booking.data} às ${booking.hora} — ${booking.motivo}`
    });
  }

  return agendamento;
}

// Função principal — processa mensagem do paciente
async function processarMensagem(clinicaId, telefone, mensagem) {
  try {
    // 1. Busca configurações da clínica
    const config = await getClinicConfig(clinicaId);
    if (!config.clinica) throw new Error('Clínica não encontrada');

    // 2. Busca ou cria paciente
    const paciente = await getOrCreatePaciente(clinicaId, telefone);

    // 3. Busca ou cria conversa ativa
    const conversa = await getOrCreateConversa(clinicaId, paciente.id);

    // 4. Busca histórico
    const historico = await getHistorico(conversa.id);

    // 5. Salva mensagem do paciente
    await salvarMensagem(conversa.id, 'user', mensagem);

    // 6. Monta prompt e chama Claude
    const systemPrompt = buildPrompt(config);
    const messages = [
      ...historico,
      { role: 'user', content: mensagem }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages
    });

    const rawText = response.content
      .map(b => b.text || '')
      .join('');

    // 7. Parseia resposta
    const parsed = parseResponse(rawText);

    // 8. Salva resposta da Sofia
    await salvarMensagem(
      conversa.id,
      'assistant',
      parsed.message,
      response.usage?.output_tokens || 0
    );

    // 9. Processa agendamento se houver
    if (parsed.booking) {
      await salvarAgendamento(
        clinicaId,
        paciente.id,
        conversa.id,
        parsed.booking
      );
    }

    // 10. Processa handoff se necessário
    if (parsed.handoff) {
      await supabase
        .from('conversas')
        .update({ status: 'handoff' })
        .eq('id', conversa.id);

      await supabase.from('notificacoes').insert({
        clinica_id: clinicaId,
        tipo: 'handoff',
        titulo: 'Paciente precisa de atendimento humano',
        corpo: `Telefone: ${telefone}`
      });
    }

    return parsed.message;

  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    return 'Desculpe, tive um problema técnico. Tente novamente em instantes.';
  }
}

module.exports = { processarMensagem };