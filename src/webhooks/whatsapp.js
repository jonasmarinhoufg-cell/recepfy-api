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

// Deduplicação: evita reprocessar o mesmo evento enviado duas vezes pela Evolution API
const processedMessageIds = new Set();

router.post('/whatsapp', async (req, res) => {
  try {
    const body = req.body;

    const ev = (body.event || '').toUpperCase().replace('.', '_');

    // Queda de conexão em TEMPO REAL: antes esse evento era descartado e a única detecção era
    // o health-check 1x/dia — a Sofia ficava "morta" por horas. Agora marca desconectada na hora
    // (o painel reflete na hora e o health-check, mais frequente, dispara o alerta ao dono).
    if (ev === 'CONNECTION_UPDATE') {
      const st = String(body.data?.state || body.data?.connection || '').toLowerCase();
      const instName = body.instance || body.data?.instance;
      if (instName && st) {
        const novo = st === 'open' ? 'conectada' : 'desconectada';
        try {
          await supabase.from('whatsapp_instancias')
            .update({ status: novo, updated_at: new Date().toISOString() })
            .eq('instance_name', instName);
        } catch (e) { console.error('[conn-update]', e.message); }
      }
      return res.sendStatus(200);
    }

    if (ev !== 'MESSAGES_UPSERT') {
      return res.sendStatus(200);
    }

    // Evolution API v2 pode enviar data como array ou objeto
    const raw = body.data;
    const data = Array.isArray(raw) ? raw[0] : raw;

    if (data?.key?.fromMe) return res.sendStatus(200);
    if (data?.key?.remoteJid?.includes('@g.us')) return res.sendStatus(200);

    // Ignora mensagem já processada (Evolution pode disparar o mesmo evento duas vezes)
    const messageId = data?.key?.id;
    if (messageId) {
      if (processedMessageIds.has(messageId)) {
        console.log('[webhook] Mensagem duplicada ignorada:', messageId);
        return res.sendStatus(200);
      }
      processedMessageIds.add(messageId);
      setTimeout(() => processedMessageIds.delete(messageId), 5 * 60 * 1000);
    }

    const instanceName = body.instance;
    const telefone = data?.key?.remoteJid?.replace('@s.whatsapp.net', '');
    if (!telefone) return res.sendStatus(200);

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
        .eq('instance_name', instanceName).maybeSingle();
      if (!instancia) { console.warn('[webhook] Instância não encontrada (áudio):', instanceName); return; }

      try {
        const transcricao = await transcribeAudioMessage(instanceName, data.key, data.message);
        if (!transcricao) throw new Error('Transcrição vazia');

        const delay = Math.floor(Math.random() * 3000) + 2000;
        await new Promise(r => setTimeout(r, delay));
        await sendTyping(instanceName, telefone);

        const resposta = await processarMensagem(instancia.clinica_id, telefone, transcricao);
        await sendMessage(instanceName, telefone, resposta);
      } catch (e) {
        console.error('Erro ao transcrever áudio:', e);
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
          .eq('instance_name', instanceName).maybeSingle();
        if (instancia) {
          await new Promise(r => setTimeout(r, 1200));
          await sendMessage(instanceName, telefone,
            'Por enquanto só consigo ler mensagens de texto. Pode digitar o que precisa?'
          );
        }
      }
      return;
    }

    const { data: instancia } = await supabase
      .from('whatsapp_instancias').select('clinica_id')
      .eq('instance_name', instanceName).maybeSingle();

    if (!instancia) {
      console.warn('[webhook] Instância não encontrada:', instanceName);
      return res.sendStatus(200);
    }

    res.sendStatus(200);

    // Opt-out do recall (LGPD/CFM): "SAIR"/"PARAR"/"STOP" ANTES do LLM → registra e confirma,
    // sem resposta livre. Match EXATO da mensagem normalizada — "vou sair 15h" NÃO silencia.
    // NÃO inclui "CANCELAR": é a palavra natural para cancelar a CONSULTA — deve fluir para o
    // processarMensagem (cancelamento), não descadastrar do recall nem virar no-show silencioso.
    const norm = (mensagem || '').trim().toUpperCase();
    if (['SAIR', 'PARAR', 'STOP'].includes(norm)) {
      try {
        await supabase.from('pacientes').update({ recall_opt_out: true })
          .eq('clinica_id', instancia.clinica_id).eq('telefone', telefone);
      } catch (e) { console.error('[optout]', e.message); }
      await sendMessage(instanceName, telefone, 'Pronto! Você não vai mais receber nossos lembretes de retorno. Se precisar agendar, é só chamar quando quiser. 💙');
      return;
    }

    const delay = Math.floor(Math.random() * 3000) + 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
    await sendTyping(instanceName, telefone);

    const resposta = await processarMensagem(instancia.clinica_id, telefone, mensagem);
    await sendMessage(instanceName, telefone, resposta);

  } catch (error) {
    console.error('Erro no webhook:', error.message);
  }
});

module.exports = router;
