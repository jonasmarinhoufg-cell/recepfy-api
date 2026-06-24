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
      .limit(30),
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
    }
  }

  const dataHoraAgendamento = parseBookingDateTime(booking.data, booking.hora);

  const { error } = await supabase.from('agendamentos').insert({
    clinica_id: clinicaId,
    paciente_id: pacienteId,
    conversa_id: conversaId,
    medico_id: medicoId,
    data_hora: dataHoraAgendamento,
    motivo: booking.motivo,
    status: 'confirmado',
    origem: 'sofia',
    modalidade_conta: modalidade,
  });

  if (error) {
    console.error('Erro ao salvar agendamento:', error.message);
    return;
  }

  // Marca o slot como indisponível para evitar duplo agendamento
  let slotQ = supabase.from('horarios_disponiveis').update({ disponivel: false })
    .eq('clinica_id', clinicaId).eq('data_hora', dataHoraAgendamento);
  if (medicoId) slotQ = slotQ.eq('medico_id', medicoId);
  await slotQ;

  // Notificação na plataforma (sempre, mesmo sem medico_id para profissional)
  await supabase.from('notificacoes').insert({
    clinica_id: clinicaId,
    medico_id:  medicoId,
    tipo:       'agendamento',
    titulo:     'Novo agendamento pela Sofia',
    corpo:      `${booking.nome} — ${booking.data} às ${booking.hora} — ${booking.motivo}`,
  });

  // Notificação WhatsApp pessoal do médico/profissional
  if (telefoneMedico) {
    try {
      const { data: wha } = await supabase
        .from('whatsapp_instancias').select('instance_name')
        .eq('clinica_id', clinicaId).maybeSingle();
      if (wha?.instance_name) {
        const tel = normalizePhone(telefoneMedico);
        if (tel) {
          const linhas = [
            '📅 *Novo agendamento via Sofia*',
            '',
            `*Paciente:* ${booking.nome}`,
            `*Data:* ${booking.data} às ${booking.hora}`,
            `*Motivo:* ${booking.motivo || '—'}`,
          ];
          if (booking.convenio) linhas.push(`*Convênio:* ${booking.convenio}`);
          await sendMessage(wha.instance_name, tel, linhas.join('\n'));
        }
      }
    } catch (e) {
      console.error('Erro ao notificar médico via WhatsApp:', e.message);
    }
  }

  // Salva nome e convênio do paciente para contatos futuros
  await atualizarNomePaciente(pacienteId, booking.nome);
  if (booking.convenio) await atualizarConvenioPaciente(pacienteId, booking.convenio);
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

  // Motivo: resposta após qualquer pergunta de contexto clínico
  if (!estado.motivo && /motivo|traz|sentindo|queixa|sintoma|problem|o que|por que|precis|consulta por|tipo de|qual.*consulta/i.test(prevTexto)) {
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

  const estado = {
    nome:     paciente?.nome     || null,
    motivo:   null,
    medico:   isProf ? (config.clinica?.medico_nome || null) : null,
    horario:  null,
    convenio: paciente?.convenio || null,
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

  return estado;
}

function buildEstadoInjetado(estado, config, mensagemAtual = '') {
  const isProf = config.clinica?.modalidade === 'profissional';

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
    proximaAcao = `APRESENTE os horários disponíveis${med} e PERGUNTE qual o paciente prefere`;
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

    // 4. Histórico desta conversa (últimas 20 mensagens)
    const historico = await getHistorico(conversa.id);

    // 4a. Extrai estado atual da conversa em código (evita loop de perguntas)
    // mensagem é passada para incluir a resposta atual no estado (ela ainda não está no histórico)
    const estadoConversa = extrairEstadoConversa(historico, mensagem, paciente, config);
    const estadoInjetado = buildEstadoInjetado(estadoConversa, config, mensagem);

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
