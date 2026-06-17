const express = require('express');
const router = express.Router();
const { processarMensagem } = require('../ai/sofia');
const { sendMessage } = require('../whatsapp/sender');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Recebe mensagens da Evolution API
router.post('/whatsapp', async (req, res) => {
  try {
    const body = req.body;

    // Ignora eventos que não são mensagens
    if (body.event !== 'messages.upsert') {
      return res.sendStatus(200);
    }

    const data = body.data;

    // Ignora mensagens enviadas pela própria Sofia
    if (data.key?.fromMe) {
      return res.sendStatus(200);
    }

    // Ignora mensagens de grupo
    if (data.key?.remoteJid?.includes('@g.us')) {
      return res.sendStatus(200);
    }

    // Extrai dados da mensagem
    const instanceName = body.instance;
    const telefone = data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const mensagem = data.message?.conversation ||
                     data.message?.extendedTextMessage?.text ||
                     '';

    if (!telefone || !mensagem) {
      return res.sendStatus(200);
    }

    // Busca clínica pelo nome da instância
    const { data: instancia } = await supabase
      .from('whatsapp_instancias')
      .select('clinica_id')
      .eq('instance_name', instanceName)
      .single();

    if (!instancia) {
      console.log(`Instância não encontrada: ${instanceName}`);
      return res.sendStatus(200);
    }

    // Responde imediatamente ao webhook
    res.sendStatus(200);

    // Processa mensagem de forma assíncrona
    const resposta = await processarMensagem(
      instancia.clinica_id,
      telefone,
      mensagem
    );

    // Envia resposta pelo WhatsApp
    await sendMessage(instanceName, telefone, resposta);

  } catch (error) {
    console.error('Erro no webhook:', error.message);
    res.sendStatus(500);
  }
});

module.exports = router;