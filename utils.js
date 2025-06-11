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
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const instance = 'ulalbot';
const EVO_SERVER_URL = process.env.EVO_SERVER_URL;
const EVO_API_KEY = process.env.EVO_API_KEY;

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
function getUsersCollection() {
    return { usersCollection };
}

function getChatHistoriesCollection(){
    return{ chatHistoriesCollection };
}
async function saveProfile(remoteJid, profileData) {
    if (!usersCollection) return;
    await usersCollection.updateOne({ _id: remoteJid }, { $set: profileData }, { upsert: true });
}
async function saveHistory(remoteJid, historyArray) {
    if (!chatHistoriesCollection) return;
    await chatHistoriesCollection.updateOne({ _id: remoteJid }, { $set: { history: historyArray } }, { upsert: true });
}
async function getHistory(remoteJid) {
    if (!chatHistoriesCollection) return null;
    return await chatHistoriesCollection.findOne({ _id: remoteJid });
}
async function getProfile(remoteJid) {
    if (!usersCollection) return null;
    return await usersCollection.findOne({ _id: remoteJid });
}
async function sendWhatsappMessage(recipientJid, text) {
    if (!instance || !EVO_SERVER_URL || !EVO_API_KEY) {
        console.error("Faltan datos de la instancia de Evolution para enviar mensaje.");
        return;
    }
    const sendTextUrl = `${EVO_SERVER_URL}/message/sendText/${instance}`;
    const payload = { number: recipientJid, text };
    try {
        console.log(`Enviando a Evolution API:`, JSON.stringify(payload));
        await axios.post(sendTextUrl, payload, { headers: { 'apikey': EVO_API_KEY, 'Content-Type': 'application/json' } });
        console.log("Respuesta enviada exitosamente.");
    } catch (error) {
        console.error(`Error al enviar mensaje a Evolution API:`, error.response?.data ? JSON.stringify(error.response.data) : error.message);
    }
}
async function sendWhatsappImage(recipientJid, caption, base64Data, fileName) {
    if (!instance || !EVO_SERVER_URL || !EVO_API_KEY) {
        console.error("Faltan datos de la instancia de Evolution para enviar imagen.");
        return;
    }
    const sendImageUrl = `${EVO_SERVER_URL}/message/sendMedia/${instance}`;
    const payload = {
        number: recipientJid,
        options: {
            delay: 1200,
        },
        mediatype: "image", // Propiedad en el nivel superior
        media: base64Data,    // Propiedad en el nivel superior
        mimetype: "image/jpeg", // Propiedad en el nivel superior
        fileName: fileName,   // Propiedad en el nivel superior
        caption: caption,     // Propiedad en el nivel superior
    };
    try {
        console.log(`Enviando imagen a Evolution API: ${fileName} a ${recipientJid}`);
        console.log("Payload: ",payload)
        await axios.post(sendImageUrl, payload, { headers: { 'apikey': EVO_API_KEY, 'Content-Type': 'application/json' } });
        console.log("Imagen enviada exitosamente.");
    } catch (error) {
        console.error(`Error al enviar imagen a Evolution API:`, error.response?.data ? JSON.stringify(error.response.data) : error.message);
    }
}
async function notifyDirectorOfNewRegistration(finalData, webhookData) {
    const directorJid = "5216144272399@s.whatsapp.net";
    const userDataText = `
¡Nuevo Alumno Inscrito!
-------------------------
*Plataforma:* ${finalData.platform || 'No especificada'}
*Nombre:* ${finalData.nombreCompleto || 'No proporcionado'}
*Fecha de Nacimiento:* ${finalData.fechaNacimiento || 'No proporcionado'}
*CURP:* ${finalData.curp || 'No proporcionado'}
*Email:* ${finalData.email || 'No proporcionado'}
*Teléfono:* ${finalData.telefono || 'No proporcionado'}
*Nivel de Estudios:* ${finalData.nivelEducacion || 'No proporcionado'}
*Escuela de Procedencia:* ${finalData.escuelaProcedencia || 'No proporcionado'}
*Nivel a Inscribirse:* ${finalData.nivelInscripcion || 'No proporcionado'}
*Contacto 1:* ${finalData.contactoEmergencia1 || 'No proporcionado'}
*Contacto 2:* ${finalData.contactoEmergencia2 || 'No proporcionado'}
-------------------------
*Método de Pago:* ${finalData.payment?.method || 'No definido'}
*Estado del Pago:* ${finalData.payment?.status || 'No definido'}
*Cita para pago:* ${finalData.payment?.scheduledAt || 'N/A'}
`;

    console.log(`Enviando notificación de nuevo inscrito a ${directorJid}`);
    await sendWhatsappMessage(directorJid, userDataText, webhookData);

    if (finalData.ineFrontBase64) {
        await sendWhatsappImage(
            directorJid, 
            `INE (Frente) de ${finalData.nombreCompleto}`, 
            finalData.ineFrontBase64, 
            `ine_frente_${finalData._id}.jpeg`, 
            webhookData
        );
    }
    if (finalData.ineBackBase64) {
        await sendWhatsappImage(
            directorJid, 
            `INE (Reverso) de ${finalData.nombreCompleto}`, 
            finalData.ineBackBase64, 
            `ine_reverso_${finalData._id}.jpeg`, 
            webhookData
        );
    }
}
async function sendMetaMessage(recipientId, text) {
    if (!META_PAGE_ACCESS_TOKEN) {
        console.error("Falta el token META_PAGE_ACCESS_TOKEN.");
        return;
    }
    const url = `https://graph.facebook.com/v19.0/me/messages`;
    const payload = {
        recipient: { id: recipientId },
        message: { text },
        messaging_type: "RESPONSE"
    };
    try {
        await axios.post(url, payload, { params: { access_token: META_PAGE_ACCESS_TOKEN } });
    } catch (error) {
        console.error(`Error al enviar mensaje de Meta:`, error.response?.data?.error);
    }
}

async function sendMessage(platform, recipientId, text, webhookData = {}) {
    console.log(`Enviando mensaje a [${platform}] para [${recipientId}]`);
    if (platform === 'whatsapp') {
        await sendWhatsappMessage(recipientId, text, webhookData);
    } else if (platform === 'meta' || platform === 'facebook' || platform === 'instagram') {
        await sendMetaMessage(recipientId, text);
    } else {
        console.error(`Plataforma desconocida: ${platform}`);
    }
}
// Inicializar conexión al arrancar
connectToMongoDB();

module.exports = {
    // Exportar getters para ambas colecciones
    getUsersCollection,
    getChatHistoriesCollection,
    sendMessage,
    saveProfile,
    getProfile,
    getHistory,
    saveHistory,
    notifyDirectorOfNewRegistration
};
