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

async function getClinicConfig(clinicaId) {
  const [clinica, sofia, medicos, faqs, horarios] = await Promise.all([
    supabase.from('clinicas').select('*').eq('id', clinicaId).single(),
    supabase.from('sofia_configs').select('*').eq('clinica_id', clinicaId).single(),
    supabase.from('medicos').select('*').eq('clinica_id', clinicaId).eq('ativo', true),
    supabase.from('faqs').select('*').eq('clinica_id', clinicaId).order('ordem'),
    supabase.from('horarios_disponiveis')
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

async function getOrCreateConversa(clinicaId, pacienteId) {
  // Busca conversa ativa criada há menos de 2 horas
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

async function getHistorico(conversaId) {
  const { data } = await supabase
    .from('mensagens')
    .select('role, conteudo')
    .eq('conversa_id', conversaId)
    .order('created_at', { ascending: true })
    .limit(10); // máximo 10 mensagens — evita contexto longo demais

  return (data || []).map(m => ({
    role: m.role,
    content: m.conteudo
  }));
}

async function getOrCreatePaciente(clinicaId, telefone) {
  const { data: paciente } = await supabase
    .from('pacientes')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('telefone', telefone)
    .single();

  if (paciente) {
    await supabase
      .from('pacientes')
      .update({ ultimo_contato: new Date().toISOString() })
      .eq('id', paciente.id);
    return paciente;
  }

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

async function salvarMensagem(conversaId, role, conteudo, tokens = 0) {
  await supabase.from('mensagens').insert({
    conversa_id: conversaId,
    role,
    conteudo,
    tokens_usados: tokens
  });
}

async function encerrarConversa(conversaId, resolucao = 'ia') {
  await supabase
    .from('conversas')
    .update({
      status: 'encerrada',
      resolucao,
      encerrada_em: new Date().toISOString()
    })
    .eq('id', conversaId);
}

async function salvarAgendamento(clinicaId, pacienteId, conversaId, booking) {
  const { data: medico } = await supabase
    .from('medicos')
    .select('id')
    .eq('clinica_id', clinicaId)
    .ilike('nome', `%${booking.medico}%`)
    .single();

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

async function processarMensagem(clinicaId, telefone, mensagem) {
  try {
    const config = await getClinicConfig(clinicaId);
    if (!config.clinica) throw new Error('Clínica não encontrada');

    const paciente = await getOrCreatePaciente(clinicaId, telefone);
    const conversa = await getOrCreateConversa(clinicaId, paciente.id);
    const historico = await getHistorico(conversa.id);

    await salvarMensagem(conversa.id, 'user', mensagem);

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

    const rawText = response.content.map(b => b.text || '').join('');
    const parsed = parseResponse(rawText);

    await salvarMensagem(
      conversa.id,
      'assistant',
      parsed.message,
      response.usage?.output_tokens || 0
    );

    // Encerra conversa após agendamento confirmado
    if (parsed.booking) {
      await salvarAgendamento(clinicaId, paciente.id, conversa.id, parsed.booking);
      await encerrarConversa(conversa.id, 'ia');
    }

    // Encerra conversa em handoff
    if (parsed.handoff) {
      await encerrarConversa(conversa.id, 'humano');
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