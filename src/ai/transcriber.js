const { OpenAI, toFile } = require('openai');
const axios = require('axios');

// Inicialização lazy — não quebra o módulo se a chave ainda não estiver configurada
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada no Railway')
    // timeout/maxRetries explícitos: sem isso o SDK espera ~10min por padrão, e um Whisper
    // pendurado deixa o paciente no vácuo (o fallback "não consegui ouvir" só dispara quando
    // a chamada resolve). 20s por tentativa, 1 retry → pior caso ~40s antes do fallback.
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 1 })
  }
  return _openai
}

// Baixa o áudio da Evolution API como base64 e transcreve com Whisper
async function transcribeAudioMessage(instanceName, messageKey, messageContent) {
  const evolutionUrl = process.env.EVOLUTION_API_URL;
  const evolutionKey = process.env.EVOLUTION_API_KEY;

  const { data: mediaData } = await axios.post(
    `${evolutionUrl}/chat/getBase64FromMediaMessage/${instanceName}`,
    { message: { key: messageKey, message: messageContent } },
    { headers: { apikey: evolutionKey }, timeout: 15000 }
  );

  const { base64, mimetype = 'audio/ogg' } = mediaData;
  if (!base64) throw new Error('Evolution API não retornou base64');

  const buffer = Buffer.from(base64, 'base64');

  const ext = mimetype.includes('ogg') ? 'ogg'
    : mimetype.includes('mp4')  ? 'mp4'
    : mimetype.includes('webm') ? 'webm'
    : mimetype.includes('wav')  ? 'wav'
    : 'ogg';

  const file = await toFile(buffer, `audio.${ext}`, { type: mimetype });

  const transcription = await getOpenAI().audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'pt',
  });

  return transcription.text?.trim() || '';
}

module.exports = { transcribeAudioMessage };
