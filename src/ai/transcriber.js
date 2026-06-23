const { OpenAI, toFile } = require('openai');
const axios = require('axios');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'pt',
  });

  return transcription.text?.trim() || '';
}

module.exports = { transcribeAudioMessage };
