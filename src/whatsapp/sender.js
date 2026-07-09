const axios = require('axios');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;

// Normaliza número BR para o formato que a Evolution/WhatsApp entrega: 55 + DDD + 9 + 8.
// Bug real: numeros que chegam do remoteJid em 12 digitos (55+DDD+8, SEM o 9o digito do
// celular — formato legado) falhavam no envio; a Sofia gerava a resposta mas ela nunca
// chegava. Aqui, no unico ponto de saida, garantimos o 9o digito para celulares.
function toWhatsAppNumberBR(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return d;
  if (d.length === 10 || d.length === 11) d = '55' + d;         // sem DDI -> assume Brasil
  if (d.length === 12 && d.startsWith('55')) {                   // 55+DDD+8 = celular legado
    const local = d.slice(4);                                    // 8 digitos
    if (/^[6-9]/.test(local)) d = d.slice(0, 4) + '9' + local;   // insere o 9o -> 13 digitos
  }
  return d;
}

const evolutionClient = axios.create({
  baseURL: EVOLUTION_URL,
  headers: {
    'apikey': EVOLUTION_KEY,
    'Content-Type': 'application/json',
  },
});

// Envio com RETRY + backoff: um soluço da Evolution (rede, 5xx, restart) não pode
// virar "agendamento perdido invisível" — o oposto do "atende 24/7" que se vende.
// 3 tentativas (0ms, 800ms, 3s). Erros 4xx (exceto 429) não re-tentam: são definitivos.
async function sendMessage(instanceName, phone, message) {
  const numero = toWhatsAppNumberBR(phone);
  const esperas = [0, 800, 3000];
  let ultimoErro;
  for (let i = 0; i < esperas.length; i++) {
    if (esperas[i]) await new Promise(r => setTimeout(r, esperas[i]));
    try {
      const response = await evolutionClient.post(
        `/message/sendText/${instanceName}`,
        { number: numero, text: message }
      );
      return response.data;
    } catch (error) {
      ultimoErro = error;
      const st = error.response?.status;
      const definitivo = st && st >= 400 && st < 500 && st !== 429;
      console.error(`[sender] Falha ao enviar (tentativa ${i + 1}/${esperas.length}${definitivo ? ', definitiva' : ''}):`, st, error.response?.data || error.message);
      if (definitivo) break;
    }
  }
  throw ultimoErro;
}

// Simula "digitando..." enquanto a Sofia processa — melhora percepção de velocidade
async function sendTyping(instanceName, phone) {
  try {
    await evolutionClient.post(`/chat/sendPresence/${instanceName}`, {
      number: toWhatsAppNumberBR(phone),
      options: { presence: 'composing', delay: 4000 },
    });
  } catch {
    // não crítico — ignora silenciosamente
  }
}

module.exports = { sendMessage, sendTyping };
