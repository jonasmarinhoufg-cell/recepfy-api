// ─── sofia.js ────────────────────────────────────────────────────────────────
// Orquestração principal da IA — suporte a duas modalidades:
// - clinica:       recepcionista de clínica com múltiplos médicos
// - profissional:  assistente particular de médico autônomo
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const { buildPrompt } = require('./prompt');
const { parseResponse } = require('./parser');
const { createClient } = require('@supabase/supabase-js');

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3

// Converte data/hora do booking (strings em horário de Brasília) para ISO UTC
function parseBookingDateTime(dataStr, horaStr) {
  const dateMatch = (dataStr || '').match(/(\d{1,2})\/(\d{1,2})/);
  const timeMatch = (horaStr  || '').match(/(\d{1,2})[h:](\d{2})/i);
  if (!dateMatch) return new Date().toISOString();

  const day     = parseInt(dateMatch[1]);
  const month   = parseInt(dateMatch[2]) - 1; // 0-indexed
  const hours   = timeMatch ? parseInt(timeMatch[1]) : 8;
  const minutes = timeMatch ? parseInt(timeMatch[2]) : 0;

  const now  = new Date();
  let   year = now.getUTCFullYear();
  // Se a data já passou no ano atual, assume o próximo
  const tentativa = new Date(Date.UTC(year, month, day, hours + 3, minutes));
  if (tentativa < now) year++;

  return new Date(Date.UTC(year, month, day, hours + 3, minutes)).toISOString();
}

// Formata um timestamp UTC para exibição em horário de Brasília
function formatBRT(isoString, opts = {}) {
  return new Date(isoString).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    ...opts,
  });
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── CACHE ───────────────────────────────────────────────────────────────────
// Evita queries repetidas ao banco para configs que mudam raramente
// TTL de 5 minutos — chame invalidateCache() ao salvar configs

const configCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getClinicConfig(clinicaId) {
  const cached = configCache.get(clinicaId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const [clinica, sofia, medicos, faqs, horarios] = await Promise.all([
    supabase.from('clinicas').select('*').eq('id', clinicaId).single(),
    supabase.from('sofia_configs').select('*').eq('clinica_id', clinicaId).maybeSingle(),
    supabase.from('medicos').select('*').eq('clinica_id', clinicaId).eq('ativo', true),
    supabase.from('faqs').select('*').eq('clinica_id', clinicaId).order('ordem'),
    supabase
      .from('horarios_disponiveis')
      .select('*, medicos(nome)')
      .eq('clinica_id', clinicaId)
      .eq('disponivel', true)
      .gte('data_hora', new Date().toISOString())
      .order('data_hora', { ascending: true })
      .limit(12),
  ]);

  const data = {
    clinica: clinica.data,
    sofia: sofia.data,
    medicos: medicos.data || [],
    faqs: faqs.data || [],
    horarios: (horarios.data || []).map(h => ({
      ...h,
      medico_nome: h.medicos?.nome,
    })),
  };

  // Só armazena em cache se sofia_configs existir — sem config retenta na próxima chamada
  if (data.sofia) {
    configCache.set(clinicaId, { data, ts: Date.now() });
  }
  return data;
}

function invalidateCache(clinicaId) {
  configCache.delete(clinicaId);
}

// ─── PACIENTE ─────────────────────────────────────────────────────────────────

async function getOrCreatePaciente(clinicaId, telefone) {
  const { data: paciente } = await supabase
    .from('pacientes')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('telefone', telefone)
    .maybeSingle();

  if (paciente) {
    // Atualiza último contato sem bloquear o fluxo
    supabase.from('pacientes')
      .update({ ultimo_contato: new Date().toISOString() })
      .eq('id', paciente.id)
      .then(() => {}).catch(e => console.error('ultimo_contato:', e.message));
    return paciente;
  }

  const { data: novo, error } = await supabase
    .from('pacientes')
    .insert({ clinica_id: clinicaId, telefone, ultimo_contato: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar paciente: ${error.message}`);
  return novo;
}

// ─── PERFIL DO PACIENTE ───────────────────────────────────────────────────────
// Resolve o problema do paciente que volta depois de dias
// O perfil é permanente — diferente do histórico que é por sessão

function buildPerfilPaciente(paciente, agendamentoRecente) {
  if (!paciente.nome && !agendamentoRecente && !paciente.memoria) {
    return `PERFIL DO PACIENTE:
- Primeiro contato — não temos cadastro anterior
- Não pergunte se ele já veio antes, apenas atenda normalmente`;
  }

  let perfil = `PERFIL DO PACIENTE:
- Nome: ${paciente.nome || 'não informado ainda'}
- Já atendido anteriormente: sim`;

  if (paciente.convenio) perfil += `\n- Convênio registrado: ${paciente.convenio}`;

  if (agendamentoRecente) {
    perfil += `\n- Consulta agendada: ${agendamentoRecente.data_hora_formatada} com ${agendamentoRecente.medico_nome} (ID interno: ${agendamentoRecente.id})`;
    perfil += `\n- Status: ${agendamentoRecente.status}`;
  }

  if (paciente.memoria) {
    perfil += `\n\nHISTÓRICO DE ATENDIMENTOS ANTERIORES:\n${paciente.memoria}`;
  }

  if (paciente.nome) {
    perfil += `\n\nINSTRUÇÃO: Você já conhece este paciente. Chame pelo nome "${paciente.nome}" e NÃO peça o nome novamente.`;
  }

  if (agendamentoRecente?.status === 'confirmado') {
    perfil += `\nINSTRUÇÃO: Este paciente tem consulta agendada. Se perguntar, confirme os dados acima. Se quiser cancelar, siga o fluxo de cancelamento.`;
    perfil += `\nINSTRUÇÃO: Se o paciente quiser mudar o horário, use o FLUXO DE REAGENDAMENTO, não o de cancelamento.`;
  }

  return perfil;
}

// ─── AGENDAMENTO RECENTE ──────────────────────────────────────────────────────

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

  return {
    ...data,
    medico_nome: data.medicos?.nome || 'médico',
    data_hora_formatada: formatBRT(data.data_hora, {
      weekday: 'long', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }),
  };
}

// ─── CONVERSA ────────────────────────────────────────────────────────────────
// Janela de 2 horas — após isso, próxima mensagem abre nova conversa

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
    .insert({ clinica_id: clinicaId, paciente_id: pacienteId, status: 'ativa', iniciada_em: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar conversa: ${error.message}`);
  return nova;
}

// ─── HISTÓRICO ───────────────────────────────────────────────────────────────
// Limite de 8 mensagens — o perfil compensa o que o histórico curto não cobre

async function getHistorico(conversaId) {
  const { data } = await supabase
    .from('mensagens')
    .select('role, conteudo')
    .eq('conversa_id', conversaId)
    .order('created_at', { ascending: true })
    .limit(8);

  return (data || []).map(m => ({ role: m.role, content: m.conteudo }));
}

async function salvarMensagem(conversaId, role, conteudo, tokens = 0) {
  const { error } = await supabase.from('mensagens').insert({
    conversa_id: conversaId, role, conteudo, tokens_usados: tokens,
  });
  if (error) console.error('Erro ao salvar mensagem:', error.message);
}

async function cancelarAgendamento(clinicaId, pacienteId) {
  // Busca o próximo agendamento confirmado do paciente
  const { data } = await supabase
    .from('agendamentos')
    .select('id, medico_id, data_hora')
    .eq('clinica_id', clinicaId)
    .eq('paciente_id', pacienteId)
    .in('status', ['confirmado', 'reagendado'])
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return false;

  await supabase.from('agendamentos')
    .update({ status: 'cancelado' })
    .eq('id', data.id);

  // Notifica a clínica
  if (data.medico_id) {
    await supabase.from('notificacoes').insert({
      clinica_id: clinicaId,
      medico_id:  data.medico_id,
      tipo:       'cancelamento',
      titulo:     'Consulta cancelada pelo paciente',
      corpo:      `Agendamento de ${formatBRT(data.data_hora)} foi cancelado via WhatsApp.`,
    });
  }

  return true;
}

async function reagendarAgendamento(clinicaId, pacienteId, conversaId, booking, modalidade) {
  // Busca o próximo agendamento confirmado/reagendado do paciente
  const { data: agendamentoAtual } = await supabase
    .from('agendamentos')
    .select('id, medico_id, data_hora')
    .eq('clinica_id', clinicaId)
    .eq('paciente_id', pacienteId)
    .in('status', ['confirmado', 'reagendado'])
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle();

  // Cancela o agendamento atual, se existir
  if (agendamentoAtual) {
    await supabase.from('agendamentos')
      .update({ status: 'cancelado' })
      .eq('id', agendamentoAtual.id);
  }

  // Salva o novo agendamento
  await salvarAgendamento(clinicaId, pacienteId, conversaId, booking, modalidade);

  // Notificação de reagendamento
  const medicoId = agendamentoAtual?.medico_id || null;
  await supabase.from('notificacoes').insert({
    clinica_id: clinicaId,
    ...(medicoId ? { medico_id: medicoId } : {}),
    tipo:   'agendamento',
    titulo: 'Consulta reagendada pela Sofia',
    corpo:  `${booking.nome} — ${booking.data} às ${booking.hora} — ${booking.motivo}`,
  });
}

async function encerrarConversa(conversaId, resolucao = 'ia') {
  await supabase.from('conversas')
    .update({ status: 'encerrada', resolucao, encerrada_em: new Date().toISOString() })
    .eq('id', conversaId);
}

// ─── RESUMO E MEMÓRIA ─────────────────────────────────────────────────────────
// Gera um resumo da conversa com Claude Haiku (modelo mais barato).
// Salva o resumo acumulado no perfil do paciente para enriquecer conversas futuras.

async function gerarResumoConversa(conversaId) {
  const { data: msgs } = await supabase
    .from('mensagens')
    .select('role, conteudo')
    .eq('conversa_id', conversaId)
    .order('created_at', { ascending: true });

  if (!msgs || msgs.length < 2) return null;

  const texto = msgs
    .map(m => `${m.role === 'user' ? 'Paciente' : 'Sofia'}: ${m.conteudo}`)
    .join('\n');

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Resuma em até 2 frases o que aconteceu nesta conversa e qualquer informação útil sobre o paciente (motivo, preferências, condições mencionadas, desfecho). Português, direto, sem introdução.\n\n${texto}`,
      }],
    });
    return resp.content[0]?.text?.trim() || null;
  } catch (e) {
    console.error('Erro ao gerar resumo de conversa:', e.message);
    return null;
  }
}

async function salvarMemoriaPaciente(pacienteId, resumo) {
  if (!resumo) return;
  const data = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const entrada = `[${data}] ${resumo}`;

  const { data: p } = await supabase
    .from('pacientes')
    .select('memoria')
    .eq('id', pacienteId)
    .maybeSingle();

  const memoriaAtual = p?.memoria || '';
  // Mantém no máximo os últimos 1200 chars para não inflar o prompt
  const nova = memoriaAtual
    ? `${memoriaAtual}\n${entrada}`.slice(-1200)
    : entrada;

  await supabase.from('pacientes')
    .update({ memoria: nova })
    .eq('id', pacienteId);
}

async function atualizarNomePaciente(pacienteId, nome) {
  if (!nome || nome.trim().length < 3) return;
  await supabase.from('pacientes')
    .update({ nome: nome.trim() })
    .eq('id', pacienteId)
    .is('nome', null); // só atualiza se ainda não tem nome
}

async function atualizarConvenioPaciente(pacienteId, convenio) {
  if (!convenio || convenio.trim().length < 2) return;
  await supabase.from('pacientes')
    .update({ convenio: convenio.trim() })
    .eq('id', pacienteId)
    .is('convenio', null);
}

// ─── SALVAR AGENDAMENTO ───────────────────────────────────────────────────────
// Para profissional: médico_id é buscado pelo campo medico_nome da clinica
// Para clínica: busca pelo nome do médico na tabela medicos

async function salvarAgendamento(clinicaId, pacienteId, conversaId, booking, modalidade) {
  let medicoId = null;

  if (modalidade === 'profissional') {
    // Para profissional, busca o único médico da conta
    const { data: medico } = await supabase
      .from('medicos')
      .select('id')
      .eq('clinica_id', clinicaId)
      .limit(1)
      .maybeSingle();
    medicoId = medico?.id || null;
  } else {
    // Para clínica, busca pelo nome mencionado na conversa
    const { data: medico } = await supabase
      .from('medicos')
      .select('id')
      .eq('clinica_id', clinicaId)
      .ilike('nome', `%${booking.medico}%`)
      .maybeSingle();
    medicoId = medico?.id || null;
  }

  const { error } = await supabase.from('agendamentos').insert({
    clinica_id: clinicaId,
    paciente_id: pacienteId,
    conversa_id: conversaId,
    medico_id: medicoId,
    data_hora: parseBookingDateTime(booking.data, booking.hora),
    motivo: booking.motivo,
    status: 'confirmado',
    origem: 'sofia',
    modalidade_conta: modalidade,
  });

  if (error) {
    console.error('Erro ao salvar agendamento:', error.message);
    return;
  }

  // Notifica o médico — para profissional, notifica o próprio dono da conta
  if (medicoId) {
    await supabase.from('notificacoes').insert({
      clinica_id: clinicaId,
      medico_id: medicoId,
      tipo: 'agendamento',
      titulo: 'Novo agendamento pela Sofia',
      corpo: `${booking.nome} — ${booking.data} às ${booking.hora} — ${booking.motivo}`,
    });
  }

  // Salva nome e convênio do paciente para contatos futuros
  await atualizarNomePaciente(pacienteId, booking.nome);
  if (booking.convenio) await atualizarConvenioPaciente(pacienteId, booking.convenio);
}

// ─── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────

async function processarMensagem(clinicaId, telefone, mensagem) {
  try {
    // 1. Configs da clínica (usa cache quando possível)
    const config = await getClinicConfig(clinicaId);
    if (!config.clinica) throw new Error(`Clínica não encontrada: ${clinicaId}`);

    const modalidade = config.clinica.modalidade || 'clinica';

    // 2. Perfil do paciente — carrega ANTES de montar o prompt
    const paciente = await getOrCreatePaciente(clinicaId, telefone);
    const agendamentoRecente = await getAgendamentoRecente(clinicaId, paciente.id);
    const perfilPaciente = buildPerfilPaciente(paciente, agendamentoRecente);

    // 2a. Handoff pendente: se o paciente foi encaminhado nas últimas 24h, não responde com IA
    const { data: handoffAtivo } = await supabase
      .from('conversas')
      .select('id')
      .eq('clinica_id', clinicaId)
      .eq('paciente_id', paciente.id)
      .eq('resolucao', 'handoff')
      .eq('status', 'encerrada')
      .gte('encerrada_em', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('encerrada_em', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (handoffAtivo) {
      const conversa = await getOrCreateConversa(clinicaId, paciente.id);
      await salvarMensagem(conversa.id, 'user', mensagem);
      const holdMsg = 'Nossa equipe vai te atender em breve. 🙏';
      await salvarMensagem(conversa.id, 'assistant', holdMsg);
      return holdMsg;
    }

    // 3. Conversa ativa (ou nova se passaram mais de 2h)
    const conversa = await getOrCreateConversa(clinicaId, paciente.id);

    // 4. Histórico desta conversa (últimas 8 mensagens)
    const historico = await getHistorico(conversa.id);

    // 5. Salva mensagem do paciente ANTES de processar
    await salvarMensagem(conversa.id, 'user', mensagem);

    // 6. Envia para Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: buildPrompt(config, perfilPaciente),
      messages: [...historico, { role: 'user', content: mensagem }],
    });

    const rawText = response.content.map(b => b.text || '').join('');
    const parsed = parseResponse(rawText);

    // 7. Salva resposta da Sofia
    await salvarMensagem(
      conversa.id, 'assistant', parsed.message,
      response.usage?.output_tokens || 0
    );

    // 8. Agendamento confirmado
    if (parsed.booking) {
      await salvarAgendamento(clinicaId, paciente.id, conversa.id, parsed.booking, modalidade);
      await encerrarConversa(conversa.id, 'ia');
      gerarResumoConversa(conversa.id)
        .then(r => salvarMemoriaPaciente(paciente.id, r))
        .catch(e => console.error('Resumo agendamento:', e.message));
    }

    // 9. Cancelamento confirmado
    if (parsed.cancelamento) {
      await cancelarAgendamento(clinicaId, paciente.id);
      await encerrarConversa(conversa.id, 'ia');
      gerarResumoConversa(conversa.id)
        .then(r => salvarMemoriaPaciente(paciente.id, r))
        .catch(e => console.error('Resumo cancelamento:', e.message));
    }

    // 10. Reagendamento confirmado
    if (parsed.reagendamento) {
      await reagendarAgendamento(clinicaId, paciente.id, conversa.id, parsed.reagendamento, modalidade);
      await encerrarConversa(conversa.id, 'ia');
      gerarResumoConversa(conversa.id)
        .then(r => salvarMemoriaPaciente(paciente.id, r))
        .catch(e => console.error('Resumo reagendamento:', e.message));
    }

    // 11. Handoff — encerra, gera resumo para contexto do atendente e notifica
    if (parsed.handoff) {
      await encerrarConversa(conversa.id, 'handoff');
      const resumo = await gerarResumoConversa(conversa.id);
      if (resumo) salvarMemoriaPaciente(paciente.id, resumo).catch(e => console.error('Memória handoff:', e.message));
      const nomePaciente = paciente.nome || telefone;
      const contexto = resumo ? `\n\nContexto: ${resumo}` : '';
      await supabase.from('notificacoes').insert({
        clinica_id: clinicaId,
        tipo: 'handoff',
        titulo: 'Paciente precisa de atendimento humano',
        corpo: `${nomePaciente} (${telefone}) — "${mensagem}"${contexto}`,
      });
    }

    return parsed.message;

  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    return 'Desculpe, tive um problema técnico. Tente novamente em instantes.';
  }
}

module.exports = { processarMensagem, invalidateCache };
