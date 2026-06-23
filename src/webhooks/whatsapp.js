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
  try {
    const body = req.body;

    // Evolution API v2 envia MESSAGES_UPSERT (maiúsculo) ou messages.upsert
    const ev = (body.event || '').toUpperCase().replace('.', '_');
    console.log(`[WH] event="${body.event}" ev="${ev}" instance="${body.instance}"`);
    if (ev !== 'MESSAGES_UPSERT') {
      return res.sendStatus(200);
    }

    const data = body.data;

    if (data.key?.fromMe) {
      console.log('[WH] ignorado: fromMe');
      return res.sendStatus(200);
    }
    if (data.key?.remoteJid?.includes('@g.us')) {
      console.log('[WH] ignorado: grupo');
      return res.sendStatus(200);
    }

    const instanceName = body.instance;
    const telefone = data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    if (!telefone) {
      console.log('[WH] ignorado: sem telefone. remoteJid=' + data.key?.remoteJid);
      return res.sendStatus(200);
    }

    const mensagem = data.message?.conversation ||
                     data.message?.extendedTextMessage?.text ||
                     '';

    console.log(`[WH] fone=${telefone} msg="${mensagem.slice(0,60)}" msgKeys=${Object.keys(data.message || {}).join(',')}`);

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
      } else {
        console.log('[WH] ignorado: sem mensagem e sem midia reconhecida');
      }
      return;
    }

    const { data: instancia } = await supabase
      .from('whatsapp_instancias').select('clinica_id')
      .eq('instance_name', instanceName).single();

    if (!instancia) {
      console.log(`[WH] instância não encontrada: ${instanceName}`);
      return res.sendStatus(200);
    }

    console.log(`[WH] processando: clinica=${instancia.clinica_id}`);
    res.sendStatus(200);

    // Delay humanizado + "digitando..." para parecer humano
    const delay = Math.floor(Math.random() * 3000) + 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
    await sendTyping(instanceName, telefone);

    const resposta = await processarMensagem(
      instancia.clinica_id,
      telefone,
      mensagem
    );

    console.log(`[WH] resposta gerada (${resposta?.length} chars), enviando...`);
    await sendMessage(instanceName, telefone, resposta);
    console.log('[WH] enviado com sucesso');

  } catch (error) {
    console.error('[WH] erro:', error.message);
  }
});

module.exports = router;
