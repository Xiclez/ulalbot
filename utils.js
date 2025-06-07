/**
 * utils.js
 * Funciones compartidas para la conexión a DB y envío de mensajes.
 */
const { MongoClient, ServerApiVersion } = require('mongodb');
const axios = require('axios');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'ulal_chatbot_db';
const USERS_COLLECTION = 'user_profiles';
const CHAT_HISTORY_COLLECTION = 'chat_histories'; // Colección dedicada para historiales

let dbClient;
let usersCollection;
let chatHistoriesCollection; // Variable para la nueva colección
let mongoConnectionError = null;

async function connectToMongoDB() {
    if (!MONGODB_URI) {
        mongoConnectionError = new Error("MONGODB_URI no definida.");
        console.error(mongoConnectionError.message);
        return;
    }
    if (dbClient && dbClient.topology && dbClient.topology.isConnected()) {
        return;
    }
    try {
        console.log("Intentando conectar a MongoDB...");
        dbClient = new MongoClient(MONGODB_URI, {
            serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
            connectTimeoutMS: 30000,
            socketTimeoutMS: 45000,
        });
        await dbClient.connect();
        const db = dbClient.db(DB_NAME);
        // Inicializar ambas colecciones
        usersCollection = db.collection(USERS_COLLECTION);
        chatHistoriesCollection = db.collection(CHAT_HISTORY_COLLECTION);
        await db.command({ ping: 1 });
        console.log("Conectado exitosamente a MongoDB:", DB_NAME);
        mongoConnectionError = null;
    } catch (error) {
        mongoConnectionError = error;
        console.error("Error al conectar con MongoDB:", error);
    }
}

async function sendWhatsappMessage(recipientJid, text, webhookData) {
    const { instance, server_url, apikey } = webhookData;
    if (!instance || !server_url || !apikey) {
        console.error("Faltan datos de la instancia de Evolution para enviar mensaje.");
        return;
    }
    const sendTextUrl = `${server_url}/message/sendText/${instance}`;
    const payload = { number: recipientJid, text };
    try {
        console.log(`Enviando a Evolution API:`, JSON.stringify(payload));
        await axios.post(sendTextUrl, payload, { headers: { 'apikey': apikey, 'Content-Type': 'application/json' } });
        console.log("Respuesta enviada exitosamente.");
    } catch (error) {
        console.error(`Error al enviar mensaje a Evolution API:`, error.response?.data ? JSON.stringify(error.response.data) : error.message);
    }
}

// Inicializar conexión al arrancar
connectToMongoDB();

module.exports = {
    // Exportar getters para ambas colecciones
    getUsersCollection: () => ({ usersCollection, mongoConnectionError }),
    getChatHistoriesCollection: () => ({ chatHistoriesCollection, mongoConnectionError }),
    sendWhatsappMessage,
};
