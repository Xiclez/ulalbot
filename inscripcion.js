/**
 * inscripcion.js
 * Módulo para manejar un flujo de inscripción simplificado e inteligente.
 */
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { getUsersCollection, sendWhatsappMessage } = require('./utils.js');
require('dotenv').config();

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    // ...
];

let inscriptionModel;

async function initializeInscriptionModel() {
    const systemInstruction = `Eres un asistente de inscripciones para la Universidad ULAL. Tu objetivo es procesar la información de un formulario de manera eficiente.

**TU FUNCIÓN:**

1.  **ANÁLISIS Y EXTRACCIÓN:** Cuando recibas un bloque de texto del usuario, tu única función es analizarlo y extraer los siguientes campos:
    -   nombreCompleto
    -   fechaNacimiento (formato DD/MM/AAAA)
    -   curp
    -   email
    -   telefono
    -   nivelEducacion
    -   escuelaProcedencia
    -   contactoEmergencia1 (nombre y teléfono)
    -   contactoEmergencia2 (nombre y teléfono)
    -   nivelInscripcion (y horario si es presencial)

    Tu única salida debe ser un objeto JSON con la siguiente estructura:
    \`{"action": "validate_data", "data": {"nombreCompleto": "VALOR_EXTRAIDO", "email": "VALOR_EXTRAIDO", ...}, "missing": ["campo_faltante_1", "campo_faltante_2"]}\`
    -   En el campo "data", incluye solo los datos que pudiste extraer del texto del usuario.
    -   En el campo "missing", incluye un array con los nombres de los campos que el usuario no proporcionó. Si no falta ninguno, el array debe estar vacío: \`[]\`. No inventes datos.

2.  **RESPUESTAS A PREGUNTAS SIMPLES:** Si el sistema te pide que formules una pregunta para un campo faltante, hazlo de forma natural.
    * Ejemplo de input del sistema: "[SISTEMA: Pide el campo 'curp']". Tu respuesta debe ser: "Parece que faltó tu CURP. ¿Podrías proporcionármela, por favor?".
`;

    const genAI = new GoogleGenerativeAI(process.env.API_KEY);
    inscriptionModel = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction,
        safetySettings,
        responseMimeType: "application/json",
    });
    console.log("Modelo de Inscripción Simplificado de Gemini inicializado.");
}

const fieldQuestions = {
    'nombreCompleto': '¿Cuál es tu nombre completo?',
    'fechaNacimiento': '¿Cuál es tu fecha de nacimiento (DD/MM/AAAA)?',
    'curp': '¿Cuál es tu CURP?',
    'email': '¿Cuál es tu correo electrónico?',
    'telefono': '¿Cuál es tu número de teléfono con WhatsApp?',
    'nivelEducacion': '¿Cuál es tu último grado de estudios terminado?',
    'escuelaProcedencia': '¿De qué escuela egresaste?',
    'contactoEmergencia1': 'Por favor, dame el nombre y teléfono de tu primer contacto de emergencia.',
    'contactoEmergencia2': 'Gracias, ahora el nombre y teléfono de tu segundo contacto de emergencia.',
    'nivelInscripcion': 'Finalmente, ¿a qué nivel de estudios te inscribes (Prepa o Licenciatura)? Si es presencial, indica el horario.',
};

async function handleInscription(userProfile, webhookData) {
    if (!inscriptionModel) {
        await sendWhatsappMessage(webhookData.data.key.remoteJid, "Sistema ocupado, intenta de nuevo.", webhookData);
        return;
    }

    const { usersCollection } = getUsersCollection();
    const remoteJid = webhookData.data.key.remoteJid;
    const currentStatus = userProfile.inscriptionStatus;
    const userInput = webhookData.data.message.conversation;
    
    // 1. INICIO DEL PROCESO: Pedir toda la información
    if (currentStatus === 'awaiting_all_data') {
        const initialMessage = `¡Excelente! Para realizar tu trámite de inscripción, por favor mándame tus siguientes datos. Puedes escribirlos en un solo mensaje, separados por comas o en diferentes líneas:
▪️ Nombre completo
▪️ Fecha de nacimiento (DD/MM/AAAA)
▪️ CURP
▪️ Correo electrónico
▪️ Teléfono con WhatsApp
▪️ Último grado de estudios terminado
▪️ Escuela de procedencia
▪️ 2 contactos de emergencia (nombre y teléfono)
▪️ Nivel al que te inscribes (y horario si es presencial)`;
        
        await sendWhatsappMessage(remoteJid, initialMessage, webhookData);
        userProfile.inscriptionStatus = 'validating_data';
        await usersCollection.updateOne({ _id: remoteJid }, { $set: { inscriptionStatus: 'validating_data' } });
        return;
    }

    // 2. VALIDACIÓN DE DATOS: El usuario ha enviado su bloque de texto
    if (currentStatus === 'validating_data' && userInput) {
        try {
            const chat = inscriptionModel.startChat();
            const result = await chat.sendMessage(userInput);
            // **CORRECCIÓN AQUÍ: Limpiar la respuesta antes de parsear**
            const cleanedText = result.response.text().replace(/```json\n?|```/g, '').trim();
            const responseJson = JSON.parse(cleanedText);

            if (responseJson.action === 'validate_data') {
                userProfile.inscriptionData = { ...userProfile.inscriptionData, ...responseJson.data };
                
                if (responseJson.missing && responseJson.missing.length > 0) {
                    const nextFieldToCollect = responseJson.missing[0];
                    userProfile.inscriptionStatus = `collecting_${nextFieldToCollect}`;
                    await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile });
                    
                    const question = fieldQuestions[nextFieldToCollect] || `Faltó un dato, ¿podrías proporcionármelo?`;
                    await sendWhatsappMessage(remoteJid, question, webhookData);
                } else {
                    userProfile.inscriptionStatus = 'awaiting_ine_front';
                    await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile });
                    await sendWhatsappMessage(remoteJid, "¡Perfecto, tengo todos tus datos! Ahora, por favor, envíame una foto clara del FRENTE de tu INE.", webhookData);
                }
            }
        } catch (error) {
            console.error("Error al parsear la respuesta del modelo o al validar datos:", error);
            await sendWhatsappMessage(remoteJid, "Hubo un problema procesando tu información. ¿Podrías intentar enviarla de nuevo, por favor?", webhookData);
        }
        return;
    }
    
    // 3. RECOPILACIÓN INDIVIDUAL: Si faltaba algún dato
    if (currentStatus.startsWith('collecting_')) {
        const fieldToCollect = currentStatus.replace('collecting_', '');
        if (userInput) {
            userProfile.inscriptionData[fieldToCollect] = userInput;
            
            const allDataText = Object.values(userProfile.inscriptionData).join(', ');
            const chat = inscriptionModel.startChat();
            const result = await chat.sendMessage(allDataText);
            // **CORRECCIÓN AQUÍ: Limpiar la respuesta antes de parsear**
            const cleanedText = result.response.text().replace(/```json\n?|```/g, '').trim();
            const responseJson = JSON.parse(cleanedText);
            
            if (responseJson.missing && responseJson.missing.length > 0) {
                const nextFieldToCollect = responseJson.missing[0];
                userProfile.inscriptionStatus = `collecting_${nextFieldToCollect}`;
                const question = fieldQuestions[nextFieldToCollect];
                await sendWhatsappMessage(remoteJid, `Gracias. ${question}`, webhookData);
            } else {
                userProfile.inscriptionStatus = 'awaiting_ine_front';
                await sendWhatsappMessage(remoteJid, "¡Perfecto, ahora sí tengo todo! Por favor, envíame la foto del FRENTE de tu INE.", webhookData);
            }
            await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile });
        }
        return;
    }

    // 4. MANEJO DE IMÁGENES DE LA INE
    if (webhookData.data.message.imageMessage) {
        const imageBase64 = webhookData.data.message.base64;
        if (currentStatus === 'awaiting_ine_front' && imageBase64) {
            userProfile.inscriptionData.ineFrontBase64 = imageBase64;
            userProfile.inscriptionStatus = 'awaiting_ine_back';
            await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile });
            await sendWhatsappMessage(remoteJid, "¡Gracias! Ahora, por favor, envíame la foto del REVERSO de la misma INE.", webhookData);
        } else if (currentStatus === 'awaiting_ine_back' && imageBase64) {
            userProfile.inscriptionData.ineBackBase64 = imageBase64;
            userProfile.inscriptionStatus = 'completed';
            
            const finalMessage = `¡Felicidades, tu proceso de inscripción ha concluido! Con estos datos quedas inscrito y tu lugar está seguro. Pronto te enviaremos tu matrícula de alumno. Por último, deberás realizar el pago de inscripción. La fecha límite es dos días antes de tu inicio de clases. Los pagos los puedes realizar en cualquiera de nuestras escuelas o por depósito/transferencia a los siguientes datos:
Banco: BANAMEX
Beneficiario: UNIVERSIDAD DE MEXICO AMERICA LATINA EN LINEA SC
CLABE: 0021 5070 1822 2027 09
CUENTA: 7018-2220270
¡Bienvenido/a a ULAL!`;
            
            await sendWhatsappMessage(remoteJid, finalMessage, webhookData);
            
            const finalData = { _id: remoteJid, ...userProfile.inscriptionData, status: 'completed', createdAt: new Date() };
            await usersCollection.replaceOne({ _id: remoteJid }, finalData, { upsert: true });
            console.log(`Inscripción completada para ${remoteJid}.`);
        }
    }
}

module.exports = { initializeInscriptionModel, handleInscription };
