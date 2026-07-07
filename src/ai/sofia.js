// ─── sofia.js ────────────────────────────────────────────────────────────────
// Orquestração principal da IA — suporte a duas modalidades:
// - clinica:       recepcionista de clínica com múltiplos médicos
// - profissional:  assistente particular de médico autônomo
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const { buildPrompt } = require('./prompt');
const { parseResponse } = require('./parser');
const { createClient } = require('@supabase/supabase-js');
const { sendMessage } = require('../whatsapp/sender');

function normalizePhone(raw) {
  let d = (raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11) d = '55' + d;
  return d;
}

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3

// Converte data/hora do booking (strings em horário de Brasília) para ISO UTC
function parseBookingDateTime(dataStr, horaStr) {
  const dateMatch = (dataStr || '').match(/(\d{1,2})\/(\d{1,2})/);
  // Aceita hora com OU sem minutos: "14h", "14:30", "14" (minutos default 00).
  // Antes, "14h" não casava e caía silenciosamente no default 08:00.
  const timeMatch = (horaStr  || '').match(/(\d{1,2})(?:[h:](\d{2}))?/i);
  if (!dateMatch) return new Date().toISOString();

  const day     = parseInt(dateMatch[1]);
  const month   = parseInt(dateMatch[2]) - 1; // 0-indexed
  const hours   = timeMatch ? parseInt(timeMatch[1]) : 8;
  const minutes = (timeMatch && timeMatch[2]) ? parseInt(timeMatch[2]) : 0;

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
  // Config estável (clínica, sofia, médicos, FAQs) — cacheada por 5 min
  let cached = configCache.get(clinicaId);
  if (!cached || Date.now() - cached.ts >= CACHE_TTL) {
    const [clinica, sofia, medicos, faqs, convenios, precos] = await Promise.all([
      supabase.from('clinicas').select('*').eq('id', clinicaId).single(),
      supabase.from('sofia_configs').select('*').eq('clinica_id', clinicaId).maybeSingle(),
      supabase.from('medicos').select('*').eq('clinica_id', clinicaId).eq('ativo', true),
      supabase.from('faqs').select('*').eq('clinica_id', clinicaId).order('ordem'),
      supabase.from('convenios').select('nome, planos, aceito, exige_autorizacao, observacao').eq('clinica_id', clinicaId),
      supabase.from('precos_particular').select('procedimento, valor').eq('clinica_id', clinicaId),
    ]);
    cached = {
      data: {
        clinica:  clinica.data,
        sofia:    sofia.data,
        medicos:  medicos.data || [],
        faqs:     faqs.data || [],
        convenios: convenios.data || [],
        precosParticular: precos.data || [],
      },
      ts: Date.now(),
    };
    // Só armazena em cache se sofia_configs existir — sem config retenta na próxima chamada
    if (cached.data.sofia) configCache.set(clinicaId, cached);
  }

  // Horários disponíveis — SEMPRE frescos do banco (disponibilidade muda a cada agendamento)
  const { data: horariosData } = await supabase
    .from('horarios_disponiveis')
    .select('*, medicos(nome)')
    .eq('clinica_id', clinicaId)
    .eq('disponivel', true)
    .gte('data_hora', new Date().toISOString())
    .lte('data_hora', new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString())
    .order('data_hora', { ascending: true })
    .limit(60);

  return {
    ...cached.data,
    horarios: (horariosData || []).map(h => ({ ...h, medico_nome: h.medicos?.nome })),
  };
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
    .eq('status', 'confirmado')
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
    .limit(20);

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
    .eq('status', 'confirmado')
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return false;

  await supabase.from('agendamentos')
    .update({ status: 'cancelado' })
    .eq('id', data.id);

  // B1 — Libera o slot para outros pacientes poderem agendar
  if (data.medico_id) {
    await supabase.from('horarios_disponiveis')
      .update({ disponivel: true })
      .eq('clinica_id', clinicaId)
      .eq('data_hora', data.data_hora)
      .eq('medico_id', data.medico_id);
  }

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

async function reagendarAgendamento(clinicaId, pacienteId, conversaId, booking, modalidade, pacienteTelefone = null) {
  // Busca o próximo agendamento confirmado do paciente
  const { data: agendamentoAtual } = await supabase
    .from('agendamentos')
    .select('id, medico_id, data_hora')
    .eq('clinica_id', clinicaId)
    .eq('paciente_id', pacienteId)
    .eq('status', 'confirmado')
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle();

  const dataAnterior = agendamentoAtual
    ? formatBRT(agendamentoAtual.data_hora, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  // Cancela o agendamento atual e libera o slot (tentativo — restauramos se o novo falhar)
  if (agendamentoAtual) {
    await supabase.from('agendamentos')
      .update({ status: 'cancelado' })
      .eq('id', agendamentoAtual.id);

    await supabase.from('horarios_disponiveis')
      .update({ disponivel: true })
      .eq('clinica_id', clinicaId)
      .eq('data_hora', agendamentoAtual.data_hora)
      .eq('medico_id', agendamentoAtual.medico_id);
  }

  // Salva o novo agendamento como reagendamento
  const result = await salvarAgendamento(clinicaId, pacienteId, conversaId, booking, modalidade, { isReagendamento: true, dataAnterior, pacienteTelefone });

  // B2 — Se o novo agendamento FALHOU (slot ocupado OU erro de banco), restaura o original
  // para não deixar o paciente sem consulta (o cancelamento do original já aconteceu acima).
  if (!result?.success && agendamentoAtual) {
    await supabase.from('agendamentos')
      .update({ status: 'confirmado' })
      .eq('id', agendamentoAtual.id);
    if (agendamentoAtual.medico_id) {
      await supabase.from('horarios_disponiveis')
        .update({ disponivel: false })
        .eq('clinica_id', clinicaId)
        .eq('data_hora', agendamentoAtual.data_hora)
        .eq('medico_id', agendamentoAtual.medico_id);
    }
  }

  return result;
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

async function salvarAgendamento(clinicaId, pacienteId, conversaId, booking, modalidade, opts = {}) {
  const { isReagendamento = false, dataAnterior = null, pacienteTelefone = null } = opts;
  let medicoId = null;
  let telefoneMedico = null;

  if (modalidade === 'profissional') {
    // Profissional autônomo: usa o telefone cadastrado na própria clínica
    const { data: cl } = await supabase.from('clinicas').select('telefone').eq('id', clinicaId).maybeSingle();
    telefoneMedico = cl?.telefone || null;
  } else {
    // Clínica: busca flexível pelo nome (exato → parcial → fallback primeiro ativo)
    const { data: todosMedicos } = await supabase
      .from('medicos').select('id, nome, telefone').eq('clinica_id', clinicaId).eq('ativo', true);
    if (todosMedicos?.length) {
      const busca = (booking.medico || '').toLowerCase();
      const match =
        todosMedicos.find(m => m.nome.toLowerCase() === busca) ||
        todosMedicos.find(m => m.nome.toLowerCase().includes(busca) || busca.includes(m.nome.toLowerCase())) ||
        todosMedicos[0];
      medicoId = match.id;
      telefoneMedico = match.telefone || null;
      // A confirmação ao paciente deve refletir o médico REALMENTE gravado (evita
      // "pediu Dr. X, foi agendado com o [0]" sem o paciente/clínica perceberem).
      booking.medico = match.nome;
    }
  }

  const dataHoraAgendamento = parseBookingDateTime(booking.data, booking.hora);

  const origem = isReagendamento ? 'reagendamento' : 'sofia';

  // Encontra o slot livre correspondente (mesmo inventário oferecido no prompt).
  let slotQ = supabase.from('horarios_disponiveis').select('id')
    .eq('clinica_id', clinicaId).eq('data_hora', dataHoraAgendamento).eq('disponivel', true);
  slotQ = medicoId ? slotQ.eq('medico_id', medicoId) : slotQ.is('medico_id', null);
  const { data: slot } = await slotQ.maybeSingle();

  if (slot?.id) {
    // Caminho TRANSACIONAL: book_slot ocupa o slot e insere a consulta num passo só —
    // trava a corrida com o painel e com a fila de espera (o "primeiro a fechar leva").
    const { data: bookData, error: rpcErr } = await supabase.rpc('book_slot', {
      p_slot_id: slot.id, p_paciente_id: pacienteId,
      p_motivo: booking.motivo || 'Consulta', p_origem: origem,
    });
    if (rpcErr) {
      if (/slot_taken/i.test(rpcErr.message || '')) {
        console.warn(`[SOFIA] slot_taken — clinica=${clinicaId} slot=${slot.id} data=${dataHoraAgendamento}`);
        return { success: false, error: 'slot_taken' };
      }
      console.error('Erro book_slot:', rpcErr.message);
      return { success: false, error: 'db_error' };
    }
    // book_slot não grava conversa_id/modalidade_conta — completa o registro aqui.
    const agId = Array.isArray(bookData) ? bookData[0] : bookData;
    if (agId) await supabase.from('agendamentos')
      .update({ conversa_id: conversaId, modalidade_conta: modalidade }).eq('id', agId);
  } else {
    // Sem slot no inventário (encaixe/edge). Insere direto; o índice único parcial
    // (medico_id, data_hora) do banco (migration 20260707) ainda barra o double-booking
    // — unique_violation (23505) é tratado como slot_taken.
    const { error } = await supabase.from('agendamentos').insert({
      clinica_id: clinicaId,
      paciente_id: pacienteId,
      conversa_id: conversaId,
      medico_id: medicoId,
      data_hora: dataHoraAgendamento,
      motivo: booking.motivo,
      status: 'confirmado',
      origem,
      modalidade_conta: modalidade,
    });
    if (error) {
      if (error.code === '23505') {
        console.warn(`[SOFIA] conflito no índice anti-double-booking — data=${dataHoraAgendamento}`);
        return { success: false, error: 'slot_taken' };
      }
      console.error('Erro ao salvar agendamento:', error.message);
      return { success: false, error: 'db_error' };
    }
  }

  // Notificação na plataforma
  // Nota: tipo usa sempre 'agendamento' para compatibilidade com o schema DB.
  // O campo titulo distingue novo agendamento de reagendamento.
  // Nome configurado da assistente (para os textos que o médico lê); fallback 'Sofia'.
  let nomeIA = 'Sofia';
  try {
    const { data: cfgIA } = await supabase.from('sofia_configs').select('nome_assistente').eq('clinica_id', clinicaId).maybeSingle();
    if (cfgIA?.nome_assistente) nomeIA = cfgIA.nome_assistente;
  } catch {}

  const notifCorpo = isReagendamento && dataAnterior
    ? `${booking.nome} — reagendado de ${dataAnterior} → ${booking.data} às ${booking.hora}`
    : `${booking.nome} — ${booking.data} às ${booking.hora} — ${booking.motivo}`;
  const { error: notifErr } = await supabase.from('notificacoes').insert({
    clinica_id:  clinicaId,
    medico_id:   medicoId,
    paciente_id: pacienteId,
    tipo:        'agendamento',
    titulo:      isReagendamento ? `Consulta reagendada pela ${nomeIA}` : `Novo agendamento pela ${nomeIA}`,
    corpo:       notifCorpo,
  });
  if (notifErr) console.error('Erro ao criar notificação:', notifErr.message);

  // Busca instância WhatsApp uma vez para usar nas duas notificações abaixo
  let whaInstance = null;
  try {
    const { data: wha } = await supabase
      .from('whatsapp_instancias').select('instance_name')
      .eq('clinica_id', clinicaId).maybeSingle();
    whaInstance = wha?.instance_name || null;
  } catch (e) {
    console.error('Erro ao buscar instância WhatsApp:', e.message);
  }

  // Notificação WhatsApp pessoal do médico/profissional
  if (!telefoneMedico) {
    console.warn(`[Sofia] Notificação ao médico pulada — telefone não cadastrado (clinica_id: ${clinicaId})`);
  }
  if (telefoneMedico && whaInstance) {
    try {
      const tel = normalizePhone(telefoneMedico);
      if (tel) {
        const header = isReagendamento ? `🔄 *Reagendamento via ${nomeIA}*` : `📅 *Novo agendamento via ${nomeIA}*`;
        const linhas = [header, ''];
        if (isReagendamento && dataAnterior) linhas.push(`*Horário anterior:* ${dataAnterior}`);
        linhas.push(
          `*Paciente:* ${booking.nome}`,
          `*Data:* ${booking.data} às ${booking.hora}`,
          `*Motivo:* ${booking.motivo || '—'}`,
        );
        if (booking.convenio) linhas.push(`*Convênio:* ${booking.convenio}`);
        await sendMessage(whaInstance, tel, linhas.join('\n'));
      }
    } catch (e) {
      console.error('Erro ao notificar médico via WhatsApp:', e.message);
    }
  }

  // #3 — Confirmação estruturada ao paciente via WhatsApp
  if (pacienteTelefone && whaInstance) {
    try {
      const tel = normalizePhone(pacienteTelefone);
      if (tel) {
        const header = isReagendamento ? '🔄 *Reagendamento confirmado!*' : '✅ *Consulta confirmada!*';
        const linhas = [header, ''];
        if (isReagendamento && dataAnterior) linhas.push(`*Horário anterior:* ${dataAnterior}`, '');
        linhas.push(
          `*Data:* ${booking.data}`,
          `*Horário:* ${booking.hora}`,
          `*Médico:* ${booking.medico}`,
        );
        if (booking.convenio) linhas.push(`*Convênio:* ${booking.convenio}`);
        linhas.push('', 'Guarde essa mensagem! Para cancelar ou reagendar, responda por aqui.');
        await sendMessage(whaInstance, tel, linhas.join('\n'));
      }
    } catch (e) {
      console.error('Erro ao enviar confirmação ao paciente:', e.message);
    }
  }

  // Salva nome e convênio do paciente para contatos futuros
  await atualizarNomePaciente(pacienteId, booking.nome);
  if (booking.convenio) await atualizarConvenioPaciente(pacienteId, booking.convenio);

  return { success: true };
}

// ─── ESTADO DA CONVERSA ───────────────────────────────────────────────────────
// Analisa o histórico em código (determinístico) para saber o que já foi coletado.
// Injeta o estado no prompt para que Claude não repita perguntas.

function _aplicarMensagem(estado, conteudo, prevTexto, isProf, config) {
  const texto = conteudo.toLowerCase();

  // Nome: resposta após pergunta de nome
  if (!estado.nome && /nome|chama|chamo/i.test(prevTexto) && conteudo.length < 80) {
    estado.nome = conteudo;
  }

  // Motivo: resposta após pergunta específica sobre razão da consulta.
  // Evita "o que você precisa?" e "por que posso ajudar?" (genéricas demais).
  if (!estado.motivo && /\bmotivo\b|traz.{0,25}(?:cl[íi]nica|consulta|aqui|hoje)|sentindo|queixa|sintoma|problem|consulta por|tipo de consulta|qual.*consulta|por que.*(?:consulta|veio|quer marcar)/i.test(prevTexto)) {
    estado.motivo = conteudo;
  }

  // Médico: detecta nome de médico em qualquer resposta com contexto relevante
  if (!isProf && !estado.medico) {
    const perguntaSobreMedico = /médico|prefere|escolh|consultar|especialista|profissional|qual.*quer|qual.*deseja|qual.*indica/i.test(prevTexto);
    const medicos = config.medicos || [];

    // Verifica qualquer parte do nome (não só o primeiro nome) para capturar "Dr. Silva", "Dra. Ana" etc.
    const match = medicos.find(m => {
      const partes = m.nome.toLowerCase().split(' ').filter(p => p.length > 2);
      return partes.some(parte => texto.includes(parte));
    });

    if (match) {
      // Nome encontrado — captura se: foi perguntado sobre médico, ou há "com/dr/dra", ou msg curta
      if (perguntaSobreMedico || /\bcom\b|dr\.?|dra\.?/i.test(texto) || conteudo.length < 40) {
        estado.medico = match.nome;
      }
    } else if (perguntaSobreMedico && conteudo.length < 50) {
      // Pergunta sobre médico mas nome não reconhecido → captura resposta curta como seleção
      estado.medico = conteudo;
    }
  }

  // Horário: detecta por contexto da pergunta anterior OU por padrão de data/hora no próprio conteúdo
  if (!estado.horario) {
    const prevTemHora    = /horário|quando|data|hora|agendar para/i.test(prevTexto);
    const prevTemLista   = /\d{1,2}:\d{2}|\d{2}\/\d{2}|segunda|ter[çc]a|quarta|quinta|sexta/i.test(prevTexto);
    const conteudoTemDT  = /\d{1,2}[\/h:]\d{2}|\d{1,2}\s*(h|hs|hrs)\b|segunda|ter[çc]a|quarta|quinta|sexta/i.test(conteudo);
    if ((prevTemHora || prevTemLista || conteudoTemDT) && /\d/.test(conteudo)) {
      estado.horario = conteudo;
    }
  }

  // Convênio: menção direta OU resposta após pergunta de convênio
  if (!estado.convenio) {
    if (/particular/i.test(texto) || /sem conv[eê]nio/i.test(texto)) {
      estado.convenio = 'Particular';
    } else if (/conv[eê]nio|plano/i.test(prevTexto) && conteudo.length < 60) {
      estado.convenio = conteudo;
    } else if (/conv[eê]nio|plano/i.test(texto) && !/perguntar|informar|verificar/i.test(texto)) {
      // Paciente menciona convênio espontaneamente
      const plans = (config.sofia?.convenios || []);
      const matchPlan = plans.find(p => texto.includes(p.toLowerCase()));
      if (matchPlan) estado.convenio = matchPlan;
    }
  }
}

function extrairEstadoConversa(historico, mensagemAtual, paciente, config) {
  const isProf = config.clinica?.modalidade === 'profissional';

  // Clínica com único médico ativo: pré-seleciona para não perguntar ao paciente
  const medicoUnico = !isProf && config.medicos?.length === 1
    ? config.medicos[0].nome
    : null;

  const estado = {
    nome:        paciente?.nome     || null,
    motivo:      null,
    medico:      isProf ? (config.clinica?.medico_nome || null) : medicoUnico,
    horario:     null,
    convenio:    paciente?.convenio || null,
    reagendando: false,
  };

  // Itera o histórico buscando pares pergunta→resposta
  for (let i = 0; i < historico.length; i++) {
    const msg = historico[i];
    if (msg.role !== 'user') continue;
    const conteudo = (msg.content || '').trim();
    if (!conteudo) continue;

    let prevTexto = '';
    for (let j = i - 1; j >= 0; j--) {
      if (historico[j].role === 'assistant') {
        prevTexto = (historico[j].content || '').toLowerCase();
        break;
      }
    }
    _aplicarMensagem(estado, conteudo, prevTexto, isProf, config);
  }

  // Inclui a mensagem atual no estado (ela ainda não foi salva no histórico)
  if (mensagemAtual?.trim()) {
    const ultimaAssist = [...historico].reverse().find(m => m.role === 'assistant');
    const prevTexto = (ultimaAssist?.content || '').toLowerCase();
    _aplicarMensagem(estado, mensagemAtual.trim(), prevTexto, isProf, config);
  }

  // Detecta se o fluxo em curso é de reagendamento (não novo agendamento)
  const textoConversa = [
    ...historico.map(m => m.content || ''),
    mensagemAtual || '',
  ].join(' ');
  estado.reagendando = /\breagend|\bmudar.{0,15}hor[aá]rio|\btrocar.{0,15}hor[aá]rio|\boutro.{0,15}hor[aá]rio|\bmudar.{0,15}consulta/i.test(textoConversa);

  return estado;
}

function buildEstadoInjetado(estado, config, mensagemAtual = '', agendamentoRecente = null) {
  const isProf = config.clinica?.modalidade === 'profissional';

  // Fluxo de reagendamento tem prioridade — só ativa se há consulta ativa para reagendar
  if (estado.reagendando && agendamentoRecente) {
    const linhas = ['\n\n=== FLUXO ATIVO: REAGENDAMENTO ==='];
    linhas.push('(Paciente quer mudar o horário — NÃO pergunte nome, médico ou motivo novamente)\n');

    if (!estado.horario) {
      linhas.push('✗ Novo horário: não escolhido ainda');
      linhas.push('');
      linhas.push('➡ PRÓXIMA AÇÃO OBRIGATÓRIA: APRESENTE SOMENTE os horários da seção "HORÁRIOS DISPONÍVEIS PARA AGENDAMENTO" — copie-os literalmente, NUNCA invente — e PERGUNTE qual o paciente prefere para o REAGENDAMENTO');
    } else {
      linhas.push(`✓ Novo horário escolhido: "${estado.horario}"`);
      linhas.push('');
      const partes = [];
      if (estado.nome) partes.push(`nome: ${estado.nome}`);
      partes.push(`horário: ${estado.horario}`);
      if (!isProf && estado.medico) partes.push(`médico: ${estado.medico}`);
      linhas.push(`➡ PRÓXIMA AÇÃO OBRIGATÓRIA: CONFIRME o reagendamento (${partes.join(', ')}) e feche com [REAGENDAMENTO_CONFIRMADO:{...}]`);
    }

    linhas.push('=====================================');
    return linhas.join('\n');
  }

  // Só ativa o fluxo de agendamento se já há dados coletados nesta conversa
  // OU se a mensagem atual tem intenção explícita de agendar.
  // Motivo e horário nunca vêm do perfil, então sua presença indica fluxo em andamento.
  const fluxoIniciado = !!(estado.motivo || estado.horario);
  const temIntencao = /\bagend|\bmarcar\b|\bconsult[ae]\b|\bhorário\b|\bquero\s+(uma?\s+)?consulta/i.test(mensagemAtual);

  if (!fluxoIniciado && !temIntencao) {
    return '\n\n=== MODO DE ATENDIMENTO ===\nNenhum agendamento em andamento. Responda a dúvida ou saudação do paciente normalmente, sem iniciar coleta de dados de agendamento a menos que ele solicite.\n===========================';
  }

  const linhas = ['\n\n=== ESTADO ATUAL DO AGENDAMENTO ==='];
  linhas.push('(Calculado do histórico — NÃO repita perguntas para itens com ✓)\n');

  linhas.push(estado.nome     ? `✓ Nome: "${estado.nome}"`           : '✗ Nome: não coletado');
  linhas.push(estado.motivo   ? `✓ Motivo: "${estado.motivo}"`       : '✗ Motivo: não coletado');
  if (!isProf) {
    linhas.push(estado.medico ? `✓ Médico: "${estado.medico}"`       : '✗ Médico: não escolhido');
  }
  linhas.push(estado.horario  ? `✓ Horário: "${estado.horario}"`     : '✗ Horário: não escolhido');
  linhas.push(estado.convenio ? `✓ Convênio: "${estado.convenio}"`   : '✗ Convênio: não informado');

  linhas.push('');

  let proximaAcao;
  if (!estado.nome) {
    proximaAcao = 'PERGUNTE o nome do paciente';
  } else if (!estado.motivo) {
    proximaAcao = 'PERGUNTE o motivo da consulta';
  } else if (!isProf && !estado.medico) {
    proximaAcao = 'APRESENTE os médicos disponíveis e PERGUNTE qual o paciente prefere';
  } else if (!estado.horario) {
    const med = !isProf && estado.medico ? ` do ${estado.medico}` : '';
    proximaAcao = `APRESENTE SOMENTE os horários da seção "HORÁRIOS DISPONÍVEIS PARA AGENDAMENTO"${med} — copie-os literalmente, NUNCA invente horários — e PERGUNTE qual o paciente prefere`;
  } else if (!estado.convenio) {
    proximaAcao = 'PERGUNTE se usa convênio ou é particular';
  } else {
    const partes = [`nome: ${estado.nome}`, `motivo: ${estado.motivo}`];
    if (!isProf) partes.push(`médico: ${estado.medico}`);
    partes.push(`horário: ${estado.horario}`, `convênio: ${estado.convenio}`);
    proximaAcao = `CONFIRME os dados (${partes.join(', ')}) e feche com [AGENDAMENTO_CONFIRMADO:{...}]`;
  }

  linhas.push(`➡ PRÓXIMA AÇÃO OBRIGATÓRIA: ${proximaAcao}`);
  linhas.push('=====================================');

  return linhas.join('\n');
}

// ─── NPS ─────────────────────────────────────────────────────────────────────

async function getNpsPendente(clinicaId, pacienteId) {
  const { data } = await supabase
    .from('agendamentos')
    .select('id')
    .eq('clinica_id', clinicaId)
    .eq('paciente_id', pacienteId)
    .not('nps_enviado_em', 'is', null)
    .is('nps_nota', null)
    .gte('nps_enviado_em', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
    .limit(1)
    .maybeSingle();
  return data;
}

// Chamado pelo cron job diário — envia NPS para consultas concluídas sem avaliação
async function enviarNpsPendentes() {
  const { data: agendamentos } = await supabase
    .from('agendamentos')
    .select('id, clinica_id, paciente_id, data_hora, medico_id, medicos(nome)')
    .eq('status', 'confirmado')
    .lt('data_hora', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())  // consulta já passou
    .gt('data_hora', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()) // máx 48h atrás
    .is('nps_enviado_em', null);

  if (!agendamentos?.length) {
    console.log('[NPS] Nenhum agendamento pendente de avaliação');
    return;
  }

  console.log(`[NPS] Enviando para ${agendamentos.length} agendamento(s)`);

  for (const ag of agendamentos) {
    try {
      const [pacResult, whaResult] = await Promise.all([
        supabase.from('pacientes').select('telefone, nome').eq('id', ag.paciente_id).maybeSingle(),
        supabase.from('whatsapp_instancias').select('instance_name').eq('clinica_id', ag.clinica_id).maybeSingle(),
      ]);

      const pac = pacResult.data;
      const wha = whaResult.data;
      if (!pac?.telefone || !wha?.instance_name) continue;

      const tel = normalizePhone(pac.telefone);
      if (!tel) continue;

      const medicoNome = ag.medicos?.nome || 'o médico';
      const dataFormatada = formatBRT(ag.data_hora, { day: '2-digit', month: '2-digit' });
      const primeiroNome = pac.nome ? `, ${pac.nome.split(' ')[0]}` : '';

      const msg = [
        `Olá${primeiroNome}! 😊`,
        '',
        `Como foi sua consulta com ${medicoNome} no dia ${dataFormatada}?`,
        '',
        'Avalie de 1 a 5:',
        '1 — Péssimo',
        '2 — Ruim',
        '3 — Regular',
        '4 — Bom',
        '5 — Excelente ⭐',
        '',
        'Responda só o número. Sua opinião nos ajuda a melhorar!',
      ].join('\n');

      await sendMessage(wha.instance_name, tel, msg);
      await supabase.from('agendamentos')
        .update({ nps_enviado_em: new Date().toISOString() })
        .eq('id', ag.id);

    } catch (e) {
      console.error(`[NPS] Erro no agendamento ${ag.id}:`, e.message);
    }
  }
}

// ─── LEMBRETE PRÉ-CONSULTA ───────────────────────────────────────────────────
// Cron diário às 9h BRT — avisa pacientes com consulta no dia seguinte.
// Apenas um aviso humanizado, sem pedir confirmação.

async function enviarLembretes() {
  // Janela "amanhã": consultas entre 20h e 32h a partir de agora
  const de  = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
  const ate = new Date(Date.now() + 32 * 60 * 60 * 1000).toISOString();

  const { data: agendamentos } = await supabase
    .from('agendamentos')
    .select('id, clinica_id, paciente_id, data_hora, medicos(nome)')
    .eq('status', 'confirmado')
    .gte('data_hora', de)
    .lte('data_hora', ate)
    .is('lembrete_enviado_em', null);

  if (!agendamentos?.length) {
    console.log('[LEMBRETE] Nenhuma consulta amanhã para lembrar');
    return;
  }

  console.log(`[LEMBRETE] Enviando para ${agendamentos.length} agendamento(s)`);

  for (const ag of agendamentos) {
    try {
      const [pacResult, whaResult] = await Promise.all([
        supabase.from('pacientes').select('telefone, nome').eq('id', ag.paciente_id).maybeSingle(),
        supabase.from('whatsapp_instancias').select('instance_name').eq('clinica_id', ag.clinica_id).maybeSingle(),
      ]);

      const pac = pacResult.data;
      const wha = whaResult.data;
      if (!pac?.telefone || !wha?.instance_name) continue;

      const tel = normalizePhone(pac.telefone);
      if (!tel) continue;

      const nome       = pac.nome ? pac.nome.split(' ')[0] : null;
      const saudacao   = nome ? `Oi, ${nome}!` : 'Oi!';
      const medicoNome = ag.medicos?.nome ? `com ${ag.medicos.nome}` : 'sua consulta';
      const hora       = formatBRT(ag.data_hora, { hour: '2-digit', minute: '2-digit' });

      const msg = [
        `${saudacao} 😊`,
        '',
        `Só passando para te lembrar que amanhã você tem consulta ${medicoNome} às ${hora}. 🗓️`,
        '',
        `Se acontecer algum imprevisto, é só chamar aqui antes. Até amanhã!`,
      ].join('\n');

      await sendMessage(wha.instance_name, tel, msg);
      await supabase.from('agendamentos')
        .update({ lembrete_enviado_em: new Date().toISOString() })
        .eq('id', ag.id);

    } catch (e) {
      console.error(`[LEMBRETE] Erro no agendamento ${ag.id}:`, e.message);
    }
  }
}

// ─── FOLLOW-UP PÓS-CONSULTA ───────────────────────────────────────────────────
// Cron diário às 10h BRT — envia mensagem calorosa ~30 dias após consulta realizada.
// Não empurra reagendamento — é genuinamente sobre saber como o paciente está.

async function enviarFollowups() {
  // Consultas realizadas há 28–32 dias (janela de 4 dias evita perder ou duplicar)
  const de  = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
  const ate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

  const { data: agendamentos } = await supabase
    .from('agendamentos')
    .select('id, clinica_id, paciente_id, data_hora, medicos(nome), pacientes!inner(recall_opt_out)')
    .eq('status', 'realizado')
    .eq('pacientes.recall_opt_out', false) // respeita o opt-out do paciente (LGPD)
    .gte('data_hora', de)
    .lte('data_hora', ate)
    .is('followup_enviado_em', null);

  if (!agendamentos?.length) {
    console.log('[FOLLOWUP] Nenhum follow-up pendente');
    return;
  }

  console.log(`[FOLLOWUP] Enviando para ${agendamentos.length} paciente(s)`);

  for (const ag of agendamentos) {
    try {
      // Não envia se paciente já tem consulta futura marcada — seria redundante
      const { data: futuro } = await supabase
        .from('agendamentos')
        .select('id')
        .eq('paciente_id', ag.paciente_id)
        .eq('status', 'confirmado')
        .gt('data_hora', new Date().toISOString())
        .maybeSingle();
      if (futuro) {
        await supabase.from('agendamentos').update({ followup_enviado_em: new Date().toISOString() }).eq('id', ag.id);
        continue;
      }

      const [pacResult, whaResult] = await Promise.all([
        supabase.from('pacientes').select('telefone, nome').eq('id', ag.paciente_id).maybeSingle(),
        supabase.from('whatsapp_instancias').select('instance_name').eq('clinica_id', ag.clinica_id).maybeSingle(),
      ]);

      const pac = pacResult.data;
      const wha = whaResult.data;
      if (!pac?.telefone || !wha?.instance_name) continue;

      const tel = normalizePhone(pac.telefone);
      if (!tel) continue;

      const nome       = pac.nome ? pac.nome.split(' ')[0] : null;
      const saudacao   = nome ? `Oi, ${nome}!` : 'Oi!';
      const medicoNome = ag.medicos?.nome;

      const msg = [
        `${saudacao} Tudo bem? 😊`,
        '',
        medicoNome
          ? `Faz um mês desde a sua consulta com ${medicoNome} aqui, e passamos só para dar um oi e saber como você está.`
          : `Faz um mês desde a sua última consulta aqui, e passamos só para dar um oi e saber como você está.`,
        '',
        `Esperamos que esteja tudo ótimo! Qualquer coisa, é só chamar. 💙`,
      ].join('\n');

      await sendMessage(wha.instance_name, tel, msg);
      await supabase.from('agendamentos')
        .update({ followup_enviado_em: new Date().toISOString() })
        .eq('id', ag.id);

    } catch (e) {
      console.error(`[FOLLOWUP] Erro no agendamento ${ag.id}:`, e.message);
    }
  }
}

// ─── REENGAJAMENTO DE PACIENTES DORMENTES ─────────────────────────────────────
// Cron semanal às segundas 10h BRT — reengage pacientes sem contato há 90+ dias.
// Tom genuíno de "sentimos sua falta", sem mencionar reagendamento diretamente.
// Só dispara para quem teve ao menos uma consulta realizada (paciente real, não lead).

async function enviarReengajamentos() {
  const noventaDiasAtras = new Date(Date.now() - 90  * 24 * 60 * 60 * 1000).toISOString();
  const seisMesesAtras   = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  // Pacientes com último contato há 90+ dias e sem reengajamento nos últimos 6 meses
  const { data: pacientes } = await supabase
    .from('pacientes')
    .select('id, nome, telefone, clinica_id, reengajamento_enviado_em')
    .not('ultimo_contato', 'is', null)
    .lt('ultimo_contato', noventaDiasAtras)
    .eq('recall_opt_out', false) // respeita o opt-out do paciente (LGPD)
    .or(`reengajamento_enviado_em.is.null,reengajamento_enviado_em.lt.${seisMesesAtras}`);

  if (!pacientes?.length) {
    console.log('[REENGAJAMENTO] Nenhum paciente dormente encontrado');
    return;
  }

  console.log(`[REENGAJAMENTO] Verificando ${pacientes.length} paciente(s)`);

  for (const pac of pacientes) {
    try {
      if (!pac.telefone || !pac.clinica_id) continue;

      // Só envia se o paciente tem ao menos uma consulta realizada
      // (busca a mais recente para personalizar a mensagem com o médico)
      const { data: historico } = await supabase
        .from('agendamentos')
        .select('id, medicos(nome)')
        .eq('paciente_id', pac.id)
        .eq('status', 'realizado')
        .order('data_hora', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!historico) continue;

      // Não envia se paciente já tem consulta futura marcada
      const { data: futuro } = await supabase
        .from('agendamentos')
        .select('id')
        .eq('paciente_id', pac.id)
        .eq('status', 'confirmado')
        .gt('data_hora', new Date().toISOString())
        .maybeSingle();
      if (futuro) continue;

      const { data: wha } = await supabase
        .from('whatsapp_instancias')
        .select('instance_name')
        .eq('clinica_id', pac.clinica_id)
        .maybeSingle();
      if (!wha?.instance_name) continue;

      const tel = normalizePhone(pac.telefone);
      if (!tel) continue;

      const nome       = pac.nome ? pac.nome.split(' ')[0] : null;
      const saudacao   = nome ? `Oi, ${nome}!` : 'Oi!';
      const medicoNome = historico.medicos?.nome;

      const msg = [
        `${saudacao} Como você está? 😊`,
        '',
        medicoNome
          ? `Faz um tempinho que não temos notícias suas desde sua consulta com ${medicoNome}, e passamos só para dar um oi e saber se está tudo bem.`
          : `Faz um tempinho que não temos notícias suas por aqui, e passamos só para dar um oi e saber se está tudo bem.`,
        '',
        `Cuide-se! Se precisar de nós, estamos por aqui. 💙`,
      ].join('\n');

      await sendMessage(wha.instance_name, tel, msg);
      await supabase.from('pacientes')
        .update({ reengajamento_enviado_em: new Date().toISOString() })
        .eq('id', pac.id);

    } catch (e) {
      console.error(`[REENGAJAMENTO] Erro no paciente ${pac.id}:`, e.message);
    }
  }
}

// ─── LISTA DE ESPERA ──────────────────────────────────────────────────────────

async function handleListaEspera(clinicaId, paciente, telefone, dados, config) {
  // Resolve o médico preferido pelo nome (se o paciente indicou um).
  let medicoId = null;
  if (dados.medico && config?.medicos?.length) {
    const busca = dados.medico.toLowerCase();
    const m = config.medicos.find(x => x.nome.toLowerCase() === busca)
      || config.medicos.find(x => x.nome.toLowerCase().includes(busca) || busca.includes(x.nome.toLowerCase()));
    if (m) medicoId = m.id;
  }

  // PERSISTE na fila de espera — é o que o painel/engine usa para ofertar a vaga
  // (link /fila/[token]) quando um horário cancela. Sem isso, a fila não existe de fato.
  const { error: leErr } = await supabase.from('lista_espera').insert({
    clinica_id:  clinicaId,
    paciente_id: paciente.id,
    nome:        dados.nome || paciente.nome || 'Paciente',
    telefone:    (telefone || '').replace(/\D/g, ''),
    medico_id:   medicoId,
    observacao:  dados.motivo || null,
  });
  if (leErr) console.error('Erro ao inserir lista_espera:', leErr.message);

  const corpo = [
    dados.nome ? `Paciente: ${dados.nome}` : null,
    dados.medico ? `Médico preferido: ${dados.medico}` : null,
    dados.motivo ? `Motivo: ${dados.motivo}` : null,
  ].filter(Boolean).join(' · ');

  await supabase.from('notificacoes').insert({
    clinica_id: clinicaId,
    tipo:       'agendamento',
    titulo:     'Paciente entrou na lista de espera',
    corpo:      corpo || 'Paciente quer ser avisado quando abrir horário',
  });

  // Registra na memória do paciente para enriquecer futuras conversas
  const entrada = `Lista de espera em ${new Date().toLocaleDateString('pt-BR')}${dados.medico ? ` para ${dados.medico}` : ''}`;
  await salvarMemoriaPaciente(paciente.id, entrada);
}

// ─── RECALL CLÍNICO ───────────────────────────────────────────────────────────
// Convida pacientes ao retorno no vencimento clínico de uma consulta REALIZADA.
// Toda a elegibilidade (protocolo APROVADO pelo médico, vencimento, janela, opt-out,
// staleness, consulta-futura, dedup do ciclo, cooldown, teto por janela) vem resolvida
// da VIEW recall_vencidos. O gate recall_config.ativo é aplicado AQUI (a view é pura).
// Copy = SÓ o template aprovado pelo médico (sem geração livre). NÃO pré-reserva slot.
async function enviarRecalls() {
  // 1) Clínicas com recall LIGADO (o interruptor) + teto global/dia (reputação do número).
  const { data: cfgs } = await supabase.from('recall_config').select('clinica_id, max_por_dia').eq('ativo', true);
  if (!cfgs?.length) { console.log('[RECALL] Nenhuma clínica com recall ativo'); return; }
  const ativos = cfgs.map(c => c.clinica_id);
  const maxDia = Object.fromEntries(cfgs.map(c => [c.clinica_id, c.max_por_dia ?? 50]));

  const { data: vencidos, error } = await supabase
    .from('recall_vencidos').select('*').in('clinica_id', ativos).limit(500);
  if (error) { console.error('[RECALL] Erro na view recall_vencidos:', error.message); return; }
  if (!vencidos?.length) { console.log('[RECALL] Nenhum recall vencido'); return; }

  console.log(`[RECALL] ${vencidos.length} elegível(is)`);
  const enviadosHoje = {};

  for (const r of vencidos) {
    try {
      enviadosHoje[r.clinica_id] = enviadosHoje[r.clinica_id] || 0;
      if (enviadosHoje[r.clinica_id] >= (maxDia[r.clinica_id] || 50)) continue;   // teto global/dia

      const [pacResult, whaResult] = await Promise.all([
        supabase.from('pacientes').select('telefone, nome').eq('id', r.paciente_id).maybeSingle(),
        supabase.from('whatsapp_instancias').select('instance_name').eq('clinica_id', r.clinica_id).maybeSingle(),
      ]);
      const pac = pacResult.data, wha = whaResult.data;
      if (!pac?.telefone || !wha?.instance_name) continue;
      const tel = normalizePhone(pac.telefone);
      if (!tel) continue;

      // Belt-and-suspenders: confirma que não surgiu consulta futura entre a view e o envio.
      const { data: futuro } = await supabase.from('agendamentos').select('id')
        .eq('paciente_id', r.paciente_id)
        .gt('data_hora', new Date().toISOString())
        .in('status', ['confirmado', 'aguardando']).maybeSingle();
      if (futuro) continue;

      // Renderiza o template APROVADO. Coringa (sem médico) → "nossa equipe", nunca nome individual.
      const primeiro = pac.nome ? pac.nome.split(' ')[0] : 'Olá';
      let msg = (r.mensagem_template || '')
        .replace(/\{nome\}/g, primeiro)
        .replace(/\{clinica\}/g, r.clinica_nome || 'nossa clínica')
        .replace(/\{medico\}/g, r.medico_nome || 'nossa equipe')
        .replace(/\{procedimento\}/g, r.procedimento || 'seu retorno');

      // Sugere 1 horário concreto (SUGESTÃO — não reserva, não chama book_slot: segurar vaga p/ quem
      // não responde vira no-show). Quando o paciente topar, o fluxo normal agenda pelo book_slot.
      let slotQ = supabase.from('horarios_disponiveis').select('data_hora')
        .eq('clinica_id', r.clinica_id).eq('disponivel', true).gt('data_hora', new Date().toISOString());
      if (r.medico_id) slotQ = slotQ.eq('medico_id', r.medico_id);
      const { data: slot } = await slotQ.order('data_hora', { ascending: true }).limit(1).maybeSingle();
      if (slot) {
        const quando = new Date(slot.data_hora).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        msg += `\n\nTenho ${quando} disponível, quer que eu veja pra você? Se preferir outro dia, é só dizer.`;
      }

      await sendMessage(wha.instance_name, tel, msg);

      // O INSERT no ledger É o marcador de "enviado" (o índice único do ciclo deduplica).
      const { error: insErr } = await supabase.from('recall_envios').insert({
        clinica_id: r.clinica_id, protocolo_id: r.protocolo_id, paciente_id: r.paciente_id,
        medico_id: r.medico_id, agendamento_origem_id: r.agendamento_origem_id,
        status: 'enviado', valor_estimado: r.valor_estimado ?? 0,
      });
      if (insErr) console.error('[RECALL] Erro no ledger:', insErr.message);
      else enviadosHoje[r.clinica_id]++;
    } catch (e) {
      console.error('[RECALL] Erro ao processar item:', e.message);
    }
  }
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
      // Override de segurança: mesmo em handoff (hold de 24h), um sinal claro de
      // emergência não pode ficar sem orientação nem sem avisar a clínica.
      const EMERGENCIA = /(dor no peito|aperto no peito|n[ãa]o consigo respirar|falta de ar|desmai|sangramento intenso|sangrando muito|\bavc\b|derrame|convuls)/i;
      if (EMERGENCIA.test(mensagem || '')) {
        const emergMsg = 'Pelo que você descreveu, procure atendimento de emergência AGORA: ligue 192 (SAMU) ou vá à UPA/pronto-socorro mais próximo. Já avisei a equipe da clínica.';
        await salvarMensagem(conversa.id, 'assistant', emergMsg);
        try {
          await supabase.from('notificacoes').insert({
            clinica_id: clinicaId, paciente_id: paciente.id, tipo: 'urgencia',
            titulo: '🚨 Possível urgência (paciente em atendimento humano)',
            corpo: `${paciente.nome || telefone} (${telefone}) durante handoff: "${mensagem}"`,
          });
        } catch (e) { console.error('[urgencia-handoff]', e.message); }
        return emergMsg;
      }
      const holdMsg = 'Nossa equipe vai te atender em breve. 🙏';
      await salvarMensagem(conversa.id, 'assistant', holdMsg);
      return holdMsg;
    }

    // 2b. #4 NPS pendente: paciente respondendo avaliação com número 1-5
    const npsPendente = await getNpsPendente(clinicaId, paciente.id);
    if (npsPendente && /^[1-5]$/.test(mensagem.trim())) {
      const nota = parseInt(mensagem.trim(), 10);
      await supabase.from('agendamentos').update({ nps_nota: nota }).eq('id', npsPendente.id);
      const conversa = await getOrCreateConversa(clinicaId, paciente.id);
      await salvarMensagem(conversa.id, 'user', mensagem);
      const respostas = [
        'Lamentamos que a experiência não tenha sido boa. Seu retorno vai nos ajudar a melhorar.',
        'Obrigado pelo retorno honesto. Vamos trabalhar para melhorar.',
        'Obrigado pela avaliação! Seu retorno é importante para nós.',
        'Que bom saber! Obrigado por avaliar.',
        'Fico muito feliz! Obrigado. Até a próxima. 😊',
      ];
      const npsResp = respostas[nota - 1];
      await salvarMensagem(conversa.id, 'assistant', npsResp);
      return npsResp;
    }

    // 3. Conversa ativa (ou nova se passaram mais de 2h)
    const conversa = await getOrCreateConversa(clinicaId, paciente.id);

    // 4. Histórico desta conversa (últimas 20 mensagens)
    const historico = await getHistorico(conversa.id);

    // 4a. Extrai estado atual da conversa em código (evita loop de perguntas)
    // mensagem é passada para incluir a resposta atual no estado (ela ainda não está no histórico)
    const estadoConversa = extrairEstadoConversa(historico, mensagem, paciente, config);
    // #5 — passa agendamentoRecente para distinguir fluxo de reagendamento
    const estadoInjetado = buildEstadoInjetado(estadoConversa, config, mensagem, agendamentoRecente);

    // Log para debug no Railway — mostra o estado calculado antes de chamar Claude
    console.log(`[SOFIA] clinica=${clinicaId} tel=${telefone} estado=${JSON.stringify(estadoConversa)}`);

    // 5. Salva mensagem do paciente ANTES de processar
    await salvarMensagem(conversa.id, 'user', mensagem);

    // 6. Envia para Claude — estado vai NO INÍCIO do system prompt (maior atenção do modelo)
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: estadoInjetado + '\n\n' + buildPrompt(config, perfilPaciente),
      messages: [...historico, { role: 'user', content: mensagem }],
    });

    const rawText = response.content.map(b => b.text || '').join('');
    const parsed = parseResponse(rawText);

    // 7. Processa ações ANTES de salvar a resposta (permite corrigir msg em caso de slot_taken)
    let finalMessage = parsed.message;

    // 8. Agendamento confirmado
    if (parsed.booking) {
      const result = await salvarAgendamento(clinicaId, paciente.id, conversa.id, parsed.booking, modalidade, { pacienteTelefone: telefone });
      if (result?.error === 'slot_taken') {
        // Horário foi reservado por outro paciente — invalida cache e corrige a mensagem
        invalidateCache(clinicaId);
        finalMessage = 'Esse horário acabou de ser reservado por outro paciente. Veja os horários disponíveis e escolha outro.';
        // Não encerra a conversa — paciente precisará escolher novo slot
      } else if (!result?.success) {
        // Falha de banco (db_error): NÃO encerra como sucesso nem diz "confirmado" — nada foi gravado.
        console.error(`[SOFIA] salvarAgendamento falhou (${result?.error || 'desconhecido'}) — clinica=${clinicaId} paciente=${paciente.id}`);
        finalMessage = 'Tive um probleminha técnico para concluir seu agendamento agora. Pode tentar de novo em instantes? Se continuar, a recepção da clínica finaliza para você.';
      } else {
        // Fase 4 — conversão do recall: se este paciente tinha recall pendente, marca convertido
        // (a receita recorrente que aparece no painel, rotulada "estimado").
        supabase.from('recall_envios').update({ status: 'agendou' })
          .eq('clinica_id', clinicaId).eq('paciente_id', paciente.id).eq('status', 'enviado')
          .gte('enviado_em', new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString())
          .then(({ error }) => { if (error) console.error('[RECALL] conversão:', error.message); });
        await encerrarConversa(conversa.id, 'ia');
        gerarResumoConversa(conversa.id)
          .then(r => salvarMemoriaPaciente(paciente.id, r))
          .catch(e => console.error('Resumo agendamento:', e.message));
      }
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
      const result = await reagendarAgendamento(clinicaId, paciente.id, conversa.id, parsed.reagendamento, modalidade, telefone);
      if (result?.error === 'slot_taken') {
        invalidateCache(clinicaId);
        finalMessage = 'Esse horário acabou de ser reservado por outro paciente. Escolha outro horário para o reagendamento.';
      } else if (!result?.success) {
        // Falha de banco: a consulta original foi RESTAURADA (em reagendarAgendamento); não encerra como sucesso.
        console.error(`[SOFIA] reagendarAgendamento falhou (${result?.error || 'desconhecido'}) — clinica=${clinicaId} paciente=${paciente.id}`);
        finalMessage = 'Tive um probleminha técnico para concluir o reagendamento. Sua consulta anterior continua marcada — pode tentar de novo em instantes?';
      } else {
        await encerrarConversa(conversa.id, 'ia');
        gerarResumoConversa(conversa.id)
          .then(r => salvarMemoriaPaciente(paciente.id, r))
          .catch(e => console.error('Resumo reagendamento:', e.message));
      }
    }

    // 11. Handoff — encerra, gera resumo para contexto do atendente e notifica
    if (parsed.handoff) {
      await encerrarConversa(conversa.id, 'handoff');
      const resumo = await gerarResumoConversa(conversa.id);
      if (resumo) salvarMemoriaPaciente(paciente.id, resumo).catch(e => console.error('Memória handoff:', e.message));
      const nomePaciente = paciente.nome || telefone;
      const contexto = resumo ? `\n\nContexto: ${resumo}` : '';
      await supabase.from('notificacoes').insert({
        clinica_id:  clinicaId,
        paciente_id: paciente.id,
        tipo: 'handoff',
        titulo: 'Paciente precisa de atendimento humano',
        corpo: `${nomePaciente} (${telefone}) — "${mensagem}"${contexto}`,
      });
    }

    // 11b. Urgência — triagem detectou sinal de risco: encerra e notifica médico(s) com prioridade máxima
    if (parsed.urgencia) {
      await encerrarConversa(conversa.id, 'urgencia');
      const nomePaciente = paciente.nome || telefone;
      const sintoma = parsed.urgencia.sintoma || 'sinal de urgência';
      const resumoUrg = parsed.urgencia.resumo || mensagem;

      // Profissional: notifica ele mesmo. Clínica: notifica todos os médicos ativos.
      const medicosParaNotificar = modalidade === 'profissional'
        ? [{ id: null, telefone: config.clinica.telefone }]
        : (config.medicos || []).filter(m => m.telefone);

      for (const m of medicosParaNotificar) {
        const { error: urgNotifErr } = await supabase.from('notificacoes').insert({
          clinica_id:  clinicaId,
          medico_id:   m.id || null,
          paciente_id: paciente.id,
          tipo:        'urgencia',
          titulo:      '🚨 Possível urgência detectada',
          corpo:       `${nomePaciente} (${telefone}) — ${sintoma}: "${resumoUrg}"`,
        });
        if (urgNotifErr) console.error('Erro ao criar notificação de urgência:', urgNotifErr.message);
      }

      try {
        const { data: wha } = await supabase
          .from('whatsapp_instancias').select('instance_name')
          .eq('clinica_id', clinicaId).maybeSingle();
        if (wha?.instance_name) {
          for (const m of medicosParaNotificar) {
            const tel = normalizePhone(m.telefone);
            if (tel) {
              await sendMessage(wha.instance_name, tel,
                `🚨 *Possível urgência detectada pela ${config.sofia?.nome_assistente || 'Sofia'}*\n\n*Paciente:* ${nomePaciente}\n*Telefone:* ${telefone}\n*Sinal:* ${sintoma}\n*Relato:* "${resumoUrg}"\n\nO paciente já foi orientado a buscar socorro imediato. Considere ligar diretamente.`
              );
            }
          }
        }
      } catch (e) {
        console.error('Erro ao notificar urgência via WhatsApp:', e.message);
      }
    }

    // 12. Lista de espera
    if (parsed.listaEspera) {
      await handleListaEspera(clinicaId, paciente, telefone, parsed.listaEspera, config);
    }

    // 12b. Demanda reprimida — intenção que a Sofia não conseguiu atender (convênio fora,
    //      especialidade/horário/exame indisponível). Alimenta o relatório de oportunidade
    //      na aba Comercial do painel.
    if (parsed.demandaReprimida) {
      const d = parsed.demandaReprimida;
      const tipo = ['convenio', 'especialidade', 'horario', 'exame', 'outro'].includes(d.tipo) ? d.tipo : 'outro';
      const { error: dErr } = await supabase.from('demanda_reprimida').insert({
        clinica_id: clinicaId,
        tipo,
        detalhe: d.detalhe || null,
        paciente_telefone: telefone,
        conversa_id: conversa.id,
        valor_estimado: Number(d.valor) || 0,
      });
      if (dErr) console.error('Erro ao registrar demanda reprimida:', dErr.message);
    }

    // Salva a mensagem final da Sofia (pode ter sido corrigida em caso de slot_taken)
    await salvarMensagem(conversa.id, 'assistant', finalMessage, response.usage?.output_tokens || 0);

    return finalMessage;

  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    return 'Desculpe, tive um problema técnico. Tente novamente em instantes.';
  }
}

module.exports = { processarMensagem, invalidateCache, enviarNpsPendentes, enviarLembretes, enviarFollowups, enviarReengajamentos, enviarRecalls };
