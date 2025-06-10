/**
 * inscripcion.js
 * Módulo para manejar un flujo de inscripción completo, desde la recolección de datos
 * hasta la selección del método de pago, con validación de INE integrada.
 */
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
// **CORRECCIÓN:** Se ha actualizado la importación para usar MongoDB.
const { getUsersCollection, sendWhatsappMessage, notifyDirectorOfNewRegistration } = require('./utils.js');
require('dotenv').config();

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let inscriptionModel, visionModel, validationModel;

// Función auxiliar para limpiar la respuesta JSON de los modelos
function cleanJson(text) {
    return text.replace(/```json\n?|```/g, '').trim();
}

async function initializeInscriptionModel() {
    const genAI = new GoogleGenerativeAI(process.env.API_KEY);
    
    // Modelo para guiar la conversación
    inscriptionModel = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: `Eres un asistente de inscripciones para ULAL. Tu única tarea es guiar al usuario a través del formulario y el proceso de pago. Responde amablemente a las instrucciones que te da el sistema. Si se te pide analizar datos, tu única salida debe ser un objeto JSON.`,
    });

    // Modelo para extraer texto de las imágenes de la INE
    visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    // Modelo para comparar y validar los datos
    validationModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    console.log("Modelos de Inscripción, Visión y Validación inicializados.");
}

async function extractIneData(imageBase64, side = 'anverso') {
    try {
        const imagePart = { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } };
        let prompt;
        if (side === 'anverso') {
            prompt = `Analiza el ANVERSO de esta credencial INE de México y extrae en formato JSON: nombre (solo el/los nombre/s), apellidoPaterno, apellidoMaterno, fechaNacimiento (DD/MM/YYYY), y curp. Si un campo es ilegible, ponle un valor nulo. Ejemplo de salida: {"type": "anverso", "data": {"nombre": "...", "apellidoPaterno": "...", "apellidoMaterno": "...", "fechaNacimiento": "...", "curp": "..."}}`;
        } else { // reverso
            prompt = `Analiza el REVERSO de esta credencial INE de México. Extrae en formato JSON únicamente la segunda y tercera línea de la zona de texto inferior (la que empieza con "IDMEX" es la primera linea, esta se ignora). Ejemplo de salida: {"type": "reverso", "data": {"linea2": "...", "linea3": "..."}}`;
        }
        
        const result = await visionModel.generateContent([prompt, imagePart]);
        const text = result.response.text();
        return JSON.parse(cleanJson(text));
    } catch (error) {
        console.error(`Error en la extracción de datos de la INE (${side}):`, error);
        return null;
    }
}

async function compareIneAnverso(userData, ineData) {
    try {
        const prompt = `Compara los datos del usuario con los de la INE. Valida si el nombre completo, CURP y fecha de nacimiento coinciden. El nombre puede estar en orden diferente. Responde únicamente con un objeto JSON: {"match": true|false, "reason": "explicación breve si no coincide"}.
        - Datos del Usuario: ${JSON.stringify(userData)}
        - Datos de la INE: ${JSON.stringify(ineData)}`;

        console.log("Datos Usuario: ",userData)
        console.log("Datos INE: ",ineData)

        const result = await validationModel.generateContent(prompt);
        const text = result.response.text();
        return JSON.parse(cleanJson(text));
    } catch (error) {
        console.error("Error en la comparación de datos (Anverso):", error);
        return { match: false, reason: "No se pudo realizar la validación automática." };
    }
}

async function validateIneReverso(userData, ineReversoData) {
    try {
        const prompt = `Valida los datos del reverso de una INE.
        - Datos del Usuario: ${JSON.stringify(userData)}
        - Datos del Reverso de la INE: ${JSON.stringify(ineReversoData)}
        
        Reglas de validación:
         "linea3" debe contener el nombre del usuario en formato APELLIDO1<APELLIDO2<<NOMBRE.

        Responde únicamente con un objeto JSON: {"match": true|false, "reason": "explicación breve si no coincide"}.`;
        console.log("Datos Usuario: ",userData)
        console.log("Datos INE Reverso: ",ineReversoData)
        const result = await validationModel.generateContent(prompt);
        const text = result.response.text();
        return JSON.parse(cleanJson(text));
    } catch (error) {
         console.error("Error en la comparación de datos (Reverso):", error);
        return { match: false, reason: "No se pudo realizar la validación automática del reverso." };
    }
}

async function parseAppointmentDateTime(userInput) {
    try {
        // **CORRECCIÓN: Obtener la fecha y hora actual dinámicamente.**
        const now = new Date();
        const options = {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'America/Chihuahua'
        };
        const currentDateTimeString = now.toLocaleString('es-MX', options);

        const prompt = `Dada la fecha y hora actual: "${currentDateTimeString}", convierte la siguiente solicitud del usuario a un formato de fecha y hora estructurado. La solicitud es: "${userInput}".
        Responde únicamente con un objeto JSON: {"dateTime": "DD/MM/YYYY HH:mm"}.
        Ejemplos:
        - "mañana a las 9:30" -> {"dateTime": "11/06/2025 09:30"} (si hoy es 10/06/2025)
        - "el jueves a las 9" -> {"dateTime": "12/06/2025 09:00"} (si hoy es martes 10/06/2025)
        - "hoy a las 5 pm" -> {"dateTime": "10/06/2025 17:00"}
        Si no puedes determinar una fecha y hora claras, responde: {"dateTime": null}`;
        
        const result = await validationModel.generateContent(prompt);
        const text = result.response.text();
        return JSON.parse(cleanJson(text));
    } catch (error) {
        console.error("Error al parsear fecha y hora:", error);
        return { dateTime: null };
    }
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
    if (!inscriptionModel || !visionModel || !validationModel) {
        await sendWhatsappMessage(webhookData.data.key.remoteJid, "Sistema ocupado, intenta de nuevo.", webhookData);
        return;
    }
    
    // Obtener la colección de MongoDB
    const { usersCollection } = getUsersCollection();
    if (!usersCollection) {
        console.error("Error de DB en handleInscription: La colección de usuarios no está disponible.");
        await sendWhatsappMessage(webhookData.data.key.remoteJid, "Lo siento, hay un problema con nuestra base de datos. Por favor, intenta más tarde.", webhookData);
        return;
    }

    const remoteJid = webhookData.data.key.remoteJid;
    let currentStatus = userProfile.inscriptionStatus;
    const userInput = webhookData.data.message.conversation;
    
    // --- INICIO DEL FLUJO DE INSCRIPCIÓN ---
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
        await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
        return;
    }
    
    // --- VALIDACIÓN DEL BLOQUE DE DATOS INICIAL ---
    if (currentStatus === 'validating_data' && userInput) {
        await sendWhatsappMessage(remoteJid, "Gracias, estoy procesando tu información...", webhookData);
        try {
            const validationPrompt = `Analiza este bloque de texto y extrae los campos: nombreCompleto, fechaNacimiento, curp, email, telefono, nivelEducacion, escuelaProcedencia, contactoEmergencia1, contactoEmergencia2, nivelInscripcion. Responde solo con un JSON: {"action": "validate_data", "data": {...}, "missing": [...]}. El texto es: "${userInput}"`;
            const result = await inscriptionModel.generateContent(validationPrompt);
            const responseJson = JSON.parse(cleanJson(result.response.text()));

            if (responseJson.action === 'validate_data') {
                userProfile.inscriptionData = { ...userProfile.inscriptionData, ...responseJson.data };
                
                if (responseJson.missing && responseJson.missing.length > 0) {
                    const nextField = responseJson.missing[0];
                    userProfile.inscriptionStatus = `collecting_${nextField}`;
                    await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
                    const question = fieldQuestions[nextField] || `Faltó un dato, ¿podrías proporcionármelo?`;
                    await sendWhatsappMessage(remoteJid, `Gracias. ${question}`, webhookData);
                } else {
                    userProfile.inscriptionStatus = 'awaiting_ine_front';
                    await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
                    await sendWhatsappMessage(remoteJid, "¡Perfecto, tengo todos tus datos! Ahora, por favor, envíame una foto clara del FRENTE de tu INE.", webhookData);
                }
            }
        } catch (error) {
            console.error("Error al validar datos:", error);
            await sendWhatsappMessage(remoteJid, "Hubo un problema procesando tu información. ¿Podrías intentar enviarla de nuevo?", webhookData);
        }
        return;
    }

    // --- RECOLECCIÓN DE DATOS FALTANTES ---
    if (currentStatus.startsWith('collecting_')) {
        const fieldToCollect = currentStatus.replace('collecting_', '');
        if (userInput) {
            userProfile.inscriptionData[fieldToCollect] = userInput;
            const allDataText = Object.values(userProfile.inscriptionData).join(', ');
            const validationPrompt = `Analiza este bloque de texto y extrae los campos que faltan de esta lista: nombreCompleto, fechaNacimiento, curp, email, telefono, nivelEducacion, escuelaProcedencia, contactoEmergencia1, contactoEmergencia2, nivelInscripcion. Responde solo con un JSON: {"action": "validate_data", "data": {...}, "missing": [...]}. El texto es: "${allDataText}"`;
            const result = await inscriptionModel.generateContent(validationPrompt);
            const responseJson = JSON.parse(cleanJson(result.response.text()));
            
            if (responseJson.missing && responseJson.missing.length > 0) {
                const nextField = responseJson.missing[0];
                userProfile.inscriptionStatus = `collecting_${nextField}`;
                const question = fieldQuestions[nextField];
                await sendWhatsappMessage(remoteJid, `Gracias. ${question}`, webhookData);
            } else {
                userProfile.inscriptionStatus = 'awaiting_ine_front';
                await sendWhatsappMessage(remoteJid, "¡Perfecto, ahora sí tengo todo! Por favor, envíame la foto del FRENTE de tu INE.", webhookData);
            }
            await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
        }
        return;
    }

    // --- MANEJO DE IMÁGENES (VALIDACIÓN DE INE Y COMPROBANTE DE PAGO) ---
    if (webhookData.data.message.imageMessage) {
        const imageBase64 = webhookData.data.message.base64;
        
        if (currentStatus === 'awaiting_ine_front' && imageBase64) {
            await sendWhatsappMessage(remoteJid, "Recibí la foto del frente, validando la información... 🧐", webhookData);
            const extractedData = await extractIneData(imageBase64, 'anverso');
            if (!extractedData?.data) {
                await sendWhatsappMessage(remoteJid, "No pude leer la información de la imagen. ¿Podrías enviar una foto más clara?", webhookData);
                return;
            }
            const validationResult = await compareIneAnverso(userProfile.inscriptionData, extractedData.data);
            if (validationResult.match) {
                userProfile.inscriptionData.ineFrontBase64 = imageBase64;
                userProfile.inscriptionStatus = 'awaiting_ine_back';
                await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
                await sendWhatsappMessage(remoteJid, "¡Validación exitosa! 👍 Ahora, por favor, envíame la foto del REVERSO de la misma INE.", webhookData);
            } else {
                await sendWhatsappMessage(remoteJid, `Hubo una discrepancia al validar tu INE: ${validationResult.reason}. Por favor, verifica tus datos o envía una foto más clara.`, webhookData);
            }
        } 
        // PROCESO PARA EL REVERSO DE LA INE
        else if (currentStatus === 'awaiting_ine_back' && imageBase64) {
            await sendWhatsappMessage(remoteJid, "Recibí la foto del reverso, realizando la última comprobación...", webhookData);
            const extractedData = await extractIneData(imageBase64, 'reverso');
             if (!extractedData?.data) {
                await sendWhatsappMessage(remoteJid, "No pude leer la información del reverso. ¿Podrías enviar una foto más clara?", webhookData);
                return;
            }
            const validationResult = await validateIneReverso(userProfile.inscriptionData, extractedData.data);
            if(validationResult.match) {
                userProfile.inscriptionData.ineBackBase64 = imageBase64;
                userProfile.inscriptionStatus = 'awaiting_payment_method';
                await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
                const message = `¡Perfecto, todos tus documentos son correctos! Para finalizar, solo falta el pago. ¿Qué método prefieres?\n1. Depósito o Transferencia\n2. Pago con Tarjeta\n3. Pago en Caja`;
                await sendWhatsappMessage(remoteJid, message, webhookData);
            } else {
                await sendWhatsappMessage(remoteJid, `La información del reverso no coincide: ${validationResult.reason}. Por favor, envía una foto clara del reverso de tu INE.`, webhookData);
            }
        }else if (currentStatus === 'awaiting_payment_proof' && imageBase64) {
            userProfile.payment = {
                method: 'transferencia',
                status: 'comprobante_recibido',
                proofBase64: imageBase64,
                receivedAt: new Date()
            };
            userProfile.inscriptionStatus = 'completed';
            const finalData = { _id: remoteJid, ...userProfile.inscriptionData, payment: userProfile.payment, status: 'completed', createdAt: new Date() };
            await usersCollection.replaceOne({ _id: remoteJid }, finalData, { upsert: true });
            await sendWhatsappMessage(remoteJid, "¡He recibido tu comprobante! Gracias, en breve confirmaremos tu pago. ¡Tu inscripción está completa!", webhookData);
        }
        return;
    }
    
    // --- FLUJO DE TEXTO PARA SELECCIÓN DE PAGO ---
    if (currentStatus === 'awaiting_payment_method' && userInput) {
        const input = userInput.toLowerCase();
        let message = "";
        if (input.includes('1') || input.includes('deposito') || input.includes('transferencia')) {
            userProfile.inscriptionStatus = 'awaiting_payment_proof';
            userProfile.payment = { method: 'transferencia', status: 'pending' };
            message = `Claro, aquí tienes los datos para tu pago:\nBanco: BANAMEX\nBeneficiario: UNIVERSIDAD DE MEXICO AMERICA LATINA EN LINEA SC\nCLABE: 0021 5070 1822 2027 09\nCUENTA: 7018-2220270\n\nPor favor, envíame una foto de tu comprobante de pago cuando lo hayas realizado.`;
        } else if (input.includes('2') || input.includes('tarjeta')) {
            userProfile.payment = { method: 'tarjeta', status: 'pending_implementation' };
            message = "Actualmente estamos trabajando en la integración para pagos con tarjeta. Por ahora, ¿te gustaría elegir la opción de depósito/transferencia o pago en caja?";
        } else if (input.includes('3') || input.includes('caja')) {
            userProfile.inscriptionStatus = 'awaiting_caja_schedule';
            userProfile.payment = { method: 'caja', status: 'pending_schedule' };
            message = `¡Con gusto te esperamos! Nuestros horarios de atención son:\nLunes a Viernes de 8:00 a 19:30\nSábados de 8:00 a 14:00\nDomingos de 9:00 a 13:00\n\n¿Qué día y hora te gustaría pasar a realizar tu pago para agendar tu visita?`;
        } else {
             await sendWhatsappMessage(remoteJid, "No entendí tu selección. Por favor, elige 1, 2 o 3.", webhookData);
             return;
        }
        await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
        const finalData = { _id: remoteJid, ...userProfile.inscriptionData, payment: userProfile.payment, status: 'completed', createdAt: new Date() };
        await notifyDirectorOfNewRegistration(finalData, webhookData);
        await sendWhatsappMessage(remoteJid, message, webhookData);
        return;
    }

    if (currentStatus === 'awaiting_caja_schedule' && userInput) {
        const parsedDate = await parseAppointmentDateTime(userInput);
        if (parsedDate && parsedDate.dateTime) {
            userProfile.payment.scheduledAt = parsedDate.dateTime;
            userProfile.payment.status = 'scheduled';
            userProfile.inscriptionStatus = 'completed';
            await usersCollection.updateOne({ _id: remoteJid }, { $set: userProfile }, { upsert: true });
            //const finalData = { _id: remoteJid, ...userProfile.inscriptionData, payment: userProfile.payment, status: 'completed', createdAt: new Date() };            
            //await notifyDirectorOfNewRegistration(finalData, webhookData);
            await sendWhatsappMessage(remoteJid, `¡Perfecto! Hemos agendado tu visita para el ${parsedDate.dateTime}. ¡Tu inscripción está completa! Te esperamos.`, webhookData);
        } else {
            await sendWhatsappMessage(remoteJid, "No pude entender la fecha y hora. ¿Podrías ser más específico? Por ejemplo: 'mañana a las 10 am' o 'el viernes a las 4 de la tarde'.", webhookData);
        }
        return;
    }
}

module.exports = { initializeInscriptionModel, handleInscription };
