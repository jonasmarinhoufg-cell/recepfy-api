const express = require('express');
const router = express.Router();
const { processarMensagem } = require('../ai/sofia');
const { transcribeAudioMessage } = require('../ai/transcriber');
const { sendMessage, sendTyping } = require('../whatsapp/sender');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.post('/whatsapp', async (req, res) => {
  console.log('[webhook] event:', req.body?.event, '| instance:', req.body?.instance);
  try {
    const body = req.body;

    // Evolution API v2 envia MESSAGES_UPSERT (maiúsculo) ou messages.upsert
    const ev = (body.event || '').toUpperCase().replace('.', '_');
    if (ev === 'CONNECTION_UPDATE') {
      const state = body.data?.state || body.data?.connection || JSON.stringify(body.data);
      console.log('[webhook] connection.update | state:', state);
      return res.sendStatus(200);
    }
    if (ev !== 'MESSAGES_UPSERT') {
      return res.sendStatus(200);
    }

    // Evolution API v2 pode enviar data como array ou objeto
    const raw = body.data;
    const data = Array.isArray(raw) ? raw[0] : raw;

    console.log('[webhook] fromMe:', data?.key?.fromMe, '| jid:', data?.key?.remoteJid);

    if (data?.key?.fromMe) {
      console.log('[webhook] fromMe event | status:', data?.status, '| jid:', data?.key?.remoteJid);
      return res.sendStatus(200);
    }
    if (data?.key?.remoteJid?.includes('@g.us')) return res.sendStatus(200);

    const instanceName = body.instance;
    const telefone = data?.key?.remoteJid?.replace('@s.whatsapp.net', '');
    if (!telefone) { console.log('[webhook] sem telefone - jid:', data?.key?.remoteJid); return res.sendStatus(200); }

    console.log('[webhook] message keys:', JSON.stringify(Object.keys(data?.message || {})));

    // Extrai texto de todos os tipos comuns de mensagem de texto
    const mensagem = data?.message?.conversation ||
                     data?.message?.extendedTextMessage?.text ||
                     data?.message?.imageMessage?.caption ||
                     data?.message?.videoMessage?.caption ||
                     data?.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
                     data?.message?.ephemeralMessage?.message?.conversation ||
                     data?.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
                     data?.message?.viewOnceMessage?.message?.conversation ||
                     data?.message?.viewOnceMessage?.message?.extendedTextMessage?.text ||
                     '';

    // Áudio (voz ou arquivo de áudio) — transcreve com Whisper
    const temAudio = data.message?.audioMessage || data.message?.pttMessage;
    if (!mensagem && temAudio) {
      res.sendStatus(200);
      const { data: instancia } = await supabase
        .from('whatsapp_instancias').select('clinica_id')
        .eq('instance_name', instanceName).single();
      if (!instancia) return;

      try {
        const transcricao = await transcribeAudioMessage(instanceName, data.key, data.message);
        if (!transcricao) throw new Error('Transcrição vazia');

        const delay = Math.floor(Math.random() * 3000) + 2000;
        await new Promise(r => setTimeout(r, delay));
        await sendTyping(instanceName, telefone);

        const resposta = await processarMensagem(instancia.clinica_id, telefone, transcricao);
        await sendMessage(instanceName, telefone, resposta);
      } catch (e) {
        console.error('Erro ao transcrever áudio:', e.message);
        await new Promise(r => setTimeout(r, 1200));
        await sendMessage(instanceName, telefone,
          'Não consegui ouvir seu áudio. Pode digitar o que precisa? 🙏'
        );
      }
      return;
    }

    // Outros mídia (imagem, vídeo, documento, sticker) — pede para digitar
    if (!mensagem) {
      console.log('[webhook] mensagem vazia - keys:', JSON.stringify(Object.keys(data?.message || {})));
      const temMidia = data.message && (
        data.message.imageMessage    ||
        data.message.videoMessage    ||
        data.message.documentMessage ||
        data.message.stickerMessage
      );
      res.sendStatus(200);
      if (temMidia) {
        const { data: instancia } = await supabase
          .from('whatsapp_instancias').select('clinica_id')
          .eq('instance_name', instanceName).single();
        if (instancia) {
          await new Promise(r => setTimeout(r, 1200));
          await sendMessage(instanceName, telefone,
            'Por enquanto só consigo ler mensagens de texto. Pode digitar o que precisa?'
          );
        }
      }
      return;
    }

    console.log('[webhook] mensagem extraída:', mensagem.substring(0, 80));
    console.log('[webhook] buscando instancia:', instanceName, '| SUPABASE_URL:', process.env.SUPABASE_URL ? 'OK' : 'AUSENTE');

    const { data: instancia, error: supaErr } = await supabase
      .from('whatsapp_instancias').select('clinica_id')
      .eq('instance_name', instanceName).single();

    console.log('[webhook] instancia:', instancia?.clinica_id || null, '| error:', supaErr?.message || null);

    if (!instancia) {
      console.log(`Instância não encontrada: ${instanceName}`);
      return res.sendStatus(200);
    }

    res.sendStatus(200);
    console.log('[webhook] 200 enviado, iniciando processamento...');

    const delay = Math.floor(Math.random() * 3000) + 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
    console.log('[webhook] delay OK, chamando processarMensagem...');

    const resposta = await processarMensagem(instancia.clinica_id, telefone, mensagem);
    console.log('[webhook] resposta da Sofia:', resposta?.substring(0, 80));

    await sendMessage(instanceName, telefone, resposta);
    console.log('[webhook] mensagem enviada com sucesso!');

  } catch (error) {
    console.error('Erro no webhook:', error.message);
  }
});

module.exports = router;
