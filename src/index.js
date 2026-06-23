require('dotenv').config();
const express = require('express');
const cors = require('cors');

const whatsappWebhook = require('./webhooks/whatsapp');
const { invalidateCache } = require('./ai/sofia');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de saúde — confirma que o servidor está no ar
app.get('/', (req, res) => {
  res.json({
    status: 200,
    message: 'Recepfy API funcionando!',
    version: '1.0.0'
  });
});

// Invalida cache de configuração de uma clínica
// Chamado pelo painel web após salvar configs da Sofia
app.post('/cache/invalidate', (req, res) => {
  const { clinica_id } = req.body || {};
  if (clinica_id) invalidateCache(clinica_id);
  res.sendStatus(200);
});

// Webhook do WhatsApp
app.use('/webhooks', whatsappWebhook);

// Diagnóstico — testa o fluxo completo de processamento da Sofia sem enviar WhatsApp
app.post('/debug/sofia', async (req, res) => {
  const { clinica_id, instance_name, mensagem = 'Olá, quero agendar uma consulta' } = req.body || {};

  const steps = [];
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    steps.push('supabase_ok');

    let cid = clinica_id;
    if (!cid && instance_name) {
      const { data: inst } = await supabase
        .from('whatsapp_instancias').select('clinica_id')
        .eq('instance_name', instance_name).single();
      cid = inst?.clinica_id;
      steps.push(cid ? `clinica_id_resolvido:${cid}` : 'instancia_nao_encontrada');
    }
    if (!cid) return res.status(400).json({ erro: 'clinica_id ou instance_name obrigatório' });

    const { processarMensagem } = require('./ai/sofia');
    steps.push('sofia_importada');

    const resposta = await processarMensagem(cid, '5500000000000', mensagem);
    steps.push('processamento_ok');

    return res.json({ ok: true, steps, clinica_id: cid, resposta });
  } catch (e) {
    steps.push(`erro:${e.message}`);
    return res.json({ ok: false, steps, erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Recepfy API rodando na porta ${PORT}`);
});