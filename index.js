/**
 * index.js
 * Punto de entrada principal y enrutador para múltiples plataformas.
 */
const express = require('express');
const bodyParser = require('body-parser');
const { getProfile, saveProfile, getHistory } = require('./utils.js');
const { initializeInfoModel, handleInfoRequest } = require('./informacion.js');
const { initializeInscriptionModel, handleInscription } = require('./inscripcion.js');
require('dotenv').config();

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const pageTokens = JSON.parse(process.env.META_PAGE_TOKENS || '{}');

// --- INICIALIZACIÓN GLOBAL ---
async function main() {
    await initializeInfoModel();
    await initializeInscriptionModel();
    console.log("Todos los módulos han sido inicializados.");
}

main();

// --- LÓGICA DEL SERVIDOR EXPRESS ---
const app = express();
app.use(bodyParser.json({ limit: '25mb' }));

// --- WEBHOOK PARA EVOLUTION API (WHATSAPP) ---
app.post('/webhook/evolution', async (req, res) => {
    if (req.body?.data?.key?.fromMe) return res.status(200).send("Mensaje propio ignorado.");
    
    console.log('[WEBHOOK_EVOLUTION] Payload recibido:', JSON.stringify(req.body));

    const webhookData = req.body;
    const remoteJid = webhookData.data?.key?.remoteJid;
    if (!remoteJid) return res.status(400).send("Webhook de WhatsApp inválido.");

    await processMessage('whatsapp', remoteJid, webhookData);
    res.status(200).send("Procesado");
});

// --- WEBHOOK PARA FACEBOOK E INSTAGRAM (META) ---

// Endpoint para la verificación del webhook de Meta
app.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Endpoint para recibir mensajes de Meta
app.post('/webhook/meta', async (req, res) => {
    const body = req.body;
    console.log('[WEBHOOK_META] Payload recibido:', JSON.stringify(body));
    
    if (body.object === 'page' || body.object === 'instagram') {
        // Usar for...of en lugar de forEach para poder usar await dentro.
        for (const entry of body.entry) {
            const pageId = entry.id; 
            const pageAccessToken = pageTokens[pageId]; // Selecciona el token correcto

            if (!pageAccessToken) {
                console.error(`No se encontró un token para la Page ID: ${pageId}`);
                continue; // Salta al siguiente evento si no hay token
            }
            for (const event of entry.messaging) {
                if (event.message && !event.message.is_echo) {
                    const senderId = event.sender.id;
                    const platform = 'meta'; // Unificar Facebook e Instagram
                    // Esperar a que el procesamiento del mensaje termine antes de continuar.
                    await processMessage(platform, senderId, body, pageAccessToken);
                }
            }
        }
        // Responder a Meta solo después de que todos los mensajes han sido procesados.
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

/**
 * Función central para procesar mensajes de cualquier plataforma.
 * @param {string} platform - 'whatsapp', 'facebook', o 'instagram'
 * @param {string} senderId - El ID único del usuario en la plataforma
 * @param {object} webhookData - El cuerpo completo del webhook
 */
async function processMessage(platform, senderId, webhookData, pageAccessToken = null) {
    try {
        let userProfile = await getProfile(senderId);
        let chatHistory = await getHistory(senderId);

        if (!userProfile) {
            userProfile = { _id: senderId, platform, inscriptionStatus: 'not_started', inscriptionData: {}, history: [] };
            await saveProfile(senderId, userProfile);
        }
        
        if (!chatHistory) {
            chatHistory = { _id: senderId, history: [] };
        }

        /*if (!userInput) {
        console.log(`[PROCESS_MSG] Mensaje sin texto recibido (sticker, reacción, etc.). Ignorando.`);
        // Opcional: enviar una respuesta genérica.
        // await sendMessage(platform, senderId, "Lo siento, solo puedo procesar mensajes de texto.", webhookData);
        return;
        }*/

        // --- LÓGICA DE ENRUTAMIENTO ---
        if (userProfile.inscriptionStatus && userProfile.inscriptionStatus !== 'not_started' && userProfile.inscriptionStatus !== 'completed') {
            await handleInscription(userProfile, platform, webhookData, pageAccessToken);
        } else {
            await handleInfoRequest(userProfile, chatHistory, platform, webhookData, pageAccessToken);
        }
        console.log(`[PROCESS_MSG] Procesando mensaje de [${platform}] para [${senderId}]`);

    } catch (error) {
        console.error(`Error procesando mensaje para ${senderId} en ${platform}:`, error);
    }
}
const PORT = process.env.PORT || 3010;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Servidor escuchando en http://localhost:${PORT}`);
    });

app.get('/', (req, res) => {
    res.send('Servidor ULAL AI Agent (Multi-platform) funcionando.');
});

module.exports = app;
