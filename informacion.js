/**
 * informacion.js
 * Módulo para manejar las consultas de información con un modelo conversacional avanzado.
 */
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const pdf = require('pdf-parse');
const { getUsersCollection, getChatHistoriesCollection, sendWhatsappMessage } = require('./utils.js');
// Importar handleInscription de forma diferida para evitar dependencias circulares
let inscriptionHandler;
setTimeout(() => {
    inscriptionHandler = require('./inscripcion.js').handleInscription;
}, 0);

require('dotenv').config();

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    // ...
];
let infoModel;
let knowledgeTextCache = null;

// --- **CORRECCIÓN:** Implementación y Declaración de Herramientas ---

// 1. Implementación de las funciones de las herramientas
const toolImplementations = {
    search_web: async ({ query }) => {
        console.log(`[Tool Executed] Searching web for: "${query}"`);
        // Simulación de una búsqueda exitosa
        return {
            success: true,
            result: `Según una búsqueda en la web, los resultados más relevantes para "${query}" indican que es una excelente opción con alta demanda laboral. Fuente: PortalDeEmpleos.com`
        };
    },
};

// 2. Declaración de las herramientas para el modelo (Formato correcto)
const tools = [
  {
    functionDeclarations: [
      {
        name: "search_web",
        description: "Busca en la web información actualizada que no se encuentra en la base de conocimiento interna, como perspectivas laborales o comparativas.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "El término o pregunta a buscar en la web."
            }
          },
          required: ["query"]
        }
      }
    ]
  }
];


async function loadKnowledgeBaseFromDirectory() {
    if (knowledgeTextCache) return knowledgeTextCache;

    const knowledgeDir = path.join(__dirname, 'knowledge_base');
    let combinedText = "";
    if (!fs.existsSync(knowledgeDir)) {
        console.warn(`ADVERTENCIA: El directorio 'knowledge_base' no existe.`);
        return "";
    }
    try {
        const files = fs.readdirSync(knowledgeDir).filter(file => path.extname(file).toLowerCase() === '.pdf');
        console.log(`Cargando ${files.length} archivo(s) PDF para base de conocimiento...`);
        for (const pdfFile of files) {
            const dataBuffer = fs.readFileSync(path.join(knowledgeDir, pdfFile));
            const data = await pdf(dataBuffer);
            combinedText += `\n\n--- INICIO DOC: ${pdfFile} ---\n${data.text}\n--- FIN DOC: ${pdfFile} ---\n`;
        }
    } catch (error) {
        console.error(`Error al leer el directorio de conocimiento:`, error);
    }
    knowledgeTextCache = combinedText;
    return combinedText;
}

async function initializeInfoModel() {
    const knowledgeText = await loadKnowledgeBaseFromDirectory();

    const systemInstruction = `Actúa como un asesor educativo virtual de la Universidad en Línea América Latina (ULAL). Tu personalidad es profesional, cálida, empática, motivadora y muy humana. Tu objetivo es que los usuarios se sientan cómodos y perfectamente informados.

**TU CONOCIMIENTO BASE:**
Primero, basa tus respuestas en la siguiente información interna de la universidad:
---
${knowledgeText || "No hay información disponible en los documentos."}
---

**TUS CAPACIDADES Y HERRAMIENTAS:**
1.  **Aprender de la Conversación:** Utiliza el historial del chat para dar respuestas personalizadas. Si un usuario ya mencionó su interés por la "Prepa en 2 meses", no empieces desde cero; profundiza en ese tema. Recuerda lo que han dicho para que la conversación se sienta fluida y natural.
2.  **Buscar en la Web:** Si la pregunta del usuario no puede ser respondida con tu conocimiento base (por ejemplo, preguntas sobre el mercado laboral actual, comparativas con otras instituciones, o términos muy específicos), debes usar la herramienta \`search_web\`.
    -   **Cuándo usarla:** Solo como último recurso, si estás seguro de que la información no está en tus documentos.
    -   **Cómo usarla:** Cuando uses esta herramienta, siempre debes informarle al usuario de dónde obtuviste la información. Ejemplo: "Hice una búsqueda rápida y, según el portal [Fuente], ...".

**TUS OBJETIVOS DE INTERACCIÓN:**
-   **No Abrumar:** Ante preguntas generales como "¿información de la prepa?", da una respuesta breve y útil, y luego pregunta qué le interesa más al usuario para guiarlo (costos, duración, etc.). Usa viñetas para que la información sea fácil de digerir.
-   **Motivar sin Presionar:** Usa frases de aliento como "¡Claro que es posible! Muchos de nuestros alumnos lo logran" o "Estás dando un gran paso, y estamos aquí para apoyarte".
-   **Orientar al Siguiente Paso:** Después de resolver sus dudas, siempre invita al usuario a comenzar su inscripción. Di algo como: "Espero que esto te sea de ayuda. Si te sientes listo, podemos comenzar tu proceso de inscripción cuando quieras. Solo dime 'quiero inscribirme'."
-   **No des informacion de golpe:** Incluso si está disponible debes siempre dosificar la información que proporcionas asi como guiar con sugerencias
-   **Incentivar la inscripcion:** Si el interesado ha hecho muchas preguntas incentivale la inscripcion mencionando que solo recabars datos para la inscripción y ofreciendo descuentos de 50% en la inscripcion, menciona cosas como "Promocion SOLO POR HOY" o "Tengo algo especial para ti"
-   **Uso de emojis:** Esto con la finalidad de hacer los mensajes mas vistosos y mas humanos. No abusar de ellos
**RESTRICCIONES:**
-   Nunca inventes datos. Si no lo sabes y no lo puedes buscar, sé honesto.
-   Responde siempre en español mexicano, con un tono amigable y natural.`;

    const genAI = new GoogleGenerativeAI(process.env.API_KEY);
    infoModel = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction,
        safetySettings,
        tools: tools, // Habilitar las herramientas con el formato correcto
    });
    console.log("Modelo Informativo Avanzado de Gemini inicializado.");
}

// La función ahora recibe el documento de historial por separado
async function handleInfoRequest(userProfile, chatHistory, webhookData) {
    if (!infoModel) {
        await sendWhatsappMessage(userProfile._id, "Nuestro sistema está ocupado, intenta de nuevo.", webhookData);
        return;
    }

    const userInput = webhookData.data.message.conversation;
    const remoteJid = userProfile._id;
    const { usersCollection } = getUsersCollection();
    const { chatHistoriesCollection } = getChatHistoriesCollection();

    // Lógica para detectar si el usuario quiere iniciar la inscripción
    const inscriptionKeywords = ['inscribirme', 'inscripción', 'inscribir', 'registro', 'quiero inscribirme'];
    if (inscriptionKeywords.some(keyword => userInput.toLowerCase().includes(keyword))) {
        console.log(`Intención de inscripción detectada para ${remoteJid}.`);
        userProfile.inscriptionStatus = 'awaiting_all_data';
        await usersCollection.updateOne({ _id: remoteJid }, { $set: { inscriptionStatus: 'awaiting_all_data' } });

        // Delegar a inscripcion.js
        if (inscriptionHandler) {
            await inscriptionHandler(userProfile, webhookData);
        } else {
            console.error("El manejador de inscripción no está disponible.");
        }
        return;
    }

    try {
        // Iniciar chat con el historial del usuario para "aprender" del contexto
        const chat = infoModel.startChat({ history: chatHistory.history || [] });
        let result = await chat.sendMessage(userInput);
        let response = result.response;

        // Bucle para manejar las llamadas a herramientas
        while (response.functionCalls() && response.functionCalls().length > 0) {
            const functionCalls = response.functionCalls();
            console.log(`Gemini solicita llamada a herramienta:`, functionCalls);

            const toolResults = [];
            for (const call of functionCalls) {
                const { name, args } = call;
                // Usar el objeto de implementación para ejecutar la función
                if (toolImplementations[name]) {
                    const toolResult = await toolImplementations[name](args);
                    toolResults.push({
                        isError: !toolResult.success,
                        response: { name, content: toolResult }
                    });
                }
            }
            // Enviar los resultados de las herramientas de vuelta a Gemini
            result = await chat.sendMessage(toolResults);
            response = result.response;
        }

        const botResponseText = response.text();
        await sendWhatsappMessage(remoteJid, botResponseText, webhookData);

        // Guardar el historial completo en la colección de historiales
        const updatedHistory = await chat.getHistory();
        await chatHistoriesCollection.updateOne(
            { _id: remoteJid },
            { $set: { history: updatedHistory } },
            { upsert: true } // Crear si no existe
        );

    } catch (error) {
        console.error(`Error en handleInfoRequest para ${remoteJid}:`, error);
        await sendWhatsappMessage(remoteJid, "Lo siento, tuve un problema al procesar tu solicitud.", webhookData);
    }
}

module.exports = { initializeInfoModel, handleInfoRequest };