// Analisa a resposta da Sofia e extrai ações especiais

function parseResponse(text) {
  const result = {
    message:      text,
    booking:      null,
    cancelamento: false,
    reagendamento: null,
    handoff:      false,
    listaEspera:  null,
    urgencia:     null,
    demandaReprimida: null,
    duvidaSemResposta: null,
    perfil:       null,
  };

  // Agendamento confirmado
  const bookingMatch = text.match(/\[AGENDAMENTO_CONFIRMADO:(.*?)\]/s);
  if (bookingMatch) {
    try {
      const b = JSON.parse(bookingMatch[1]);
      const faltando = ['nome', 'data', 'hora', 'medico'].filter(k => !b[k]);
      if (faltando.length > 0) {
        console.error('AGENDAMENTO_CONFIRMADO com campos faltando:', faltando, b);
      } else {
        result.booking = b;
        result.message = result.message.replace(/\[AGENDAMENTO_CONFIRMADO:.*?\]/s, '').trim();
      }
    } catch (e) {
      console.error('Erro ao parsear agendamento:', e.message);
    }
  }

  // Reagendamento confirmado
  const reagendamentoMatch = text.match(/\[REAGENDAMENTO_CONFIRMADO:(.*?)\]/s);
  if (reagendamentoMatch) {
    try {
      const r = JSON.parse(reagendamentoMatch[1]);
      const faltando = ['nome', 'data', 'hora', 'medico'].filter(k => !r[k]);
      if (faltando.length > 0) {
        console.error('REAGENDAMENTO_CONFIRMADO com campos faltando:', faltando, r);
      } else {
        result.reagendamento = r;
        result.message = result.message.replace(/\[REAGENDAMENTO_CONFIRMADO:.*?\]/s, '').trim();
      }
    } catch (e) {
      console.error('Erro ao parsear reagendamento:', e.message);
    }
  }

  // Cancelamento confirmado
  if (text.includes('[CANCELAMENTO_CONFIRMADO]')) {
    result.cancelamento = true;
    result.message = result.message.replace('[CANCELAMENTO_CONFIRMADO]', '').trim();
  }

  // Handoff para humano
  if (text.includes('[HANDOFF_SOLICITADO]')) {
    result.handoff = true;
    result.message = result.message.replace('[HANDOFF_SOLICITADO]', '').trim();
  }

  // Urgência detectada (triagem)
  const urgenciaMatch = text.match(/\[URGENCIA_DETECTADA:(.*?)\]/s);
  if (urgenciaMatch) {
    try {
      result.urgencia = JSON.parse(urgenciaMatch[1]);
      result.message = result.message.replace(/\[URGENCIA_DETECTADA:.*?\]/s, '').trim();
    } catch (e) {
      console.error('Erro ao parsear urgência:', e.message);
      result.urgencia = { sintoma: 'não especificado', resumo: text };
      result.message = result.message.replace(/\[URGENCIA_DETECTADA:.*?\]/s, '').trim();
    }
  }

  // Lista de espera
  const listaEsperaMatch = text.match(/\[LISTA_ESPERA:(.*?)\]/s);
  if (listaEsperaMatch) {
    try {
      result.listaEspera = JSON.parse(listaEsperaMatch[1]);
      result.message = result.message.replace(/\[LISTA_ESPERA:.*?\]/s, '').trim();
    } catch (e) {
      console.error('Erro ao parsear lista de espera:', e.message);
    }
  }

  // Demanda reprimida (intenção que a Sofia não conseguiu atender).
  // Regex exige o objeto {…} completo (mesmo padrão do DUVIDA_SEM_RESPOSTA):
  // um ']' dentro do detalhe não trunca o JSON nem vaza a tag pro paciente.
  const demandaMatch = text.match(/\[DEMANDA_REPRIMIDA:(\{.*?\})\]/s);
  if (demandaMatch) {
    try {
      result.demandaReprimida = JSON.parse(demandaMatch[1]);
      result.message = result.message.replace(/\[DEMANDA_REPRIMIDA:\{.*?\}\]/s, '').trim();
    } catch (e) {
      console.error('Erro ao parsear demanda reprimida:', e.message);
      result.message = result.message.replace(/\[DEMANDA_REPRIMIDA:\{.*?\}\]/s, '').trim();
    }
  }

  // Dúvida sem resposta — pergunta legítima que o prompt não cobre; vira
  // notificação para a clínica completar o cadastro/responder o paciente.
  // Regex exige o objeto completo {…} antes do ']' — um colchete dentro da
  // pergunta não trunca o strip (defeito dos regex lazy dos outros marcadores).
  const duvidaMatch = text.match(/\[DUVIDA_SEM_RESPOSTA:(\{.*?\})\]/s);
  if (duvidaMatch) {
    try {
      result.duvidaSemResposta = JSON.parse(duvidaMatch[1]);
      result.message = result.message.replace(/\[DUVIDA_SEM_RESPOSTA:\{.*?\}\]/s, '').trim();
    } catch (e) {
      console.error('Erro ao parsear dúvida sem resposta:', e.message);
      result.message = result.message.replace(/\[DUVIDA_SEM_RESPOSTA:\{.*?\}\]/s, '').trim();
    }
  }

  // Perfil revelado espontaneamente (CRM fase 2) — nome/interesse dito em conversa,
  // fora do fluxo de agendamento. Mesmo padrão endurecido dos marcadores acima:
  // regex exige o objeto {…} completo e o strip acontece mesmo com JSON quebrado
  // (a tag NUNCA pode vazar para o paciente).
  const perfilMatch = text.match(/\[PERFIL:(\{.*?\})\]/s);
  if (perfilMatch) {
    try {
      result.perfil = JSON.parse(perfilMatch[1]);
      // /g: se o modelo emitir DOIS marcadores PERFIL na mesma resposta (viola o
      // "máx 1", mas acontece), o strip pega todos — só o primeiro é processado.
      result.message = result.message.replace(/\[PERFIL:\{.*?\}\]/gs, '').trim();
    } catch (e) {
      console.error('Erro ao parsear perfil:', e.message);
      result.message = result.message.replace(/\[PERFIL:\{.*?\}\]/gs, '').trim();
    }
  }

  return result;
}

module.exports = { parseResponse };
