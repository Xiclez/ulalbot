/**
 * index.js
 * Punto de entrada principal y enrutador.
 */
const express = require('express');
const bodyParser = require('body-parser');
const { getUsersCollection, getChatHistoriesCollection } = require('./utils.js');
const { initializeInfoModel, handleInfoRequest } = require('./informacion.js');
const { initializeInscriptionModel, handleInscription } = require('./inscripcion.js');
require('dotenv').config();

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

app.post('/webhook/evolution', async (req, res) => {
    // Validaciones iniciales del webhook
    if (typeof req.body !== 'object' || req.body === null || !req.body.event || !req.body.data.message) {
        return res.status(400).send("Webhook con formato inválido.");
    }
    if (req.body.data.key.fromMe) {
        return res.status(200).send("Mensaje propio ignorado.");
    }
    
    const webhookData = req.body;
    const remoteJid = webhookData.data.key.remoteJid;
    const userInput = webhookData.data.message.conversation || (webhookData.data.message.imageMessage ? "[IMAGEN RECIBIDA]" : "");

    if (!userInput) {
        return res.status(200).send("Mensaje sin contenido procesable.");
    }

    const { usersCollection } = getUsersCollection();
    const { chatHistoriesCollection } = getChatHistoriesCollection();
    
    if (!usersCollection || !chatHistoriesCollection) {
        console.error("Error de DB: Una o más colecciones no están disponibles.");
        return res.status(200).send("Error de DB, no se puede procesar.");
    }

    try {
        // Buscar perfil de inscripción y historial de chat por separado
        let userProfile = await usersCollection.findOne({ _id: remoteJid });
        let chatHistory = await chatHistoriesCollection.findOne({ _id: remoteJid });

        // Si no existen, crearlos
        if (!userProfile) {
            userProfile = { _id: remoteJid, inscriptionStatus: 'not_started', inscriptionData: {} };
            await usersCollection.insertOne(userProfile);
        }
        if (!chatHistory) {
            chatHistory = { _id: remoteJid, history: [] };
            await chatHistoriesCollection.insertOne(chatHistory);
        }

        // --- LÓGICA DE ENRUTAMIENTO ---
        // Si el usuario ya está en el proceso de inscripción
        if (userProfile.inscriptionStatus && userProfile.inscriptionStatus !== 'not_started' && userProfile.inscriptionStatus !== 'completed') {
            // El módulo de inscripción no necesita el historial de chat general
            await handleInscription(userProfile, webhookData);
        } 
        // Si no, usar el bot informativo (que sí usa el historial de chat)
        else {
            await handleInfoRequest(userProfile, chatHistory, webhookData);
        }
        
        res.status(200).send("Procesado");

    } catch (error) {
        console.error(`Error procesando mensaje para ${remoteJid}:`, error);
        res.status(500).send("Error interno del servidor.");
    }
});

app.get('/', (req, res) => {
    res.send('Servidor ULAL AI Agent (v14 - Separated History) funcionando.');
});
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Servidor DEV escuchando en http://localhost:${PORT}`);
    });
}
module.exports = app;
