/**
 * informacion.js
 * Módulo para manejar las consultas de información con un modelo conversacional avanzado.
 */
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const pdf = require('pdf-parse');
const axios = require('axios');
const { getUsersCollection, getChatHistoriesCollection, saveProfile, sendMessage, saveHistory } = require('./utils.js');
// Importar handleInscription de forma diferida para evitar dependencias circulares
let inscriptionHandler;
setTimeout(() => {
    inscriptionHandler = require('./inscripcion.js').handleInscription;
}, 0);

require('dotenv').config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];
let infoModel;
let knowledgeTextCache = null;

// --- **CORRECCIÓN:** Implementación y Declaración de Herramientas ---

// 1. Implementación de las funciones de las herramientas
const toolImplementations = {
    search_web: async ({ query }) => {
        console.log(`[Tool Executed] Searching web for: "${query}"`);

        if (!GOOGLE_API_KEY || !SEARCH_ENGINE_ID) {
            console.error("Faltan las variables de entorno GOOGLE_API_KEY o SEARCH_ENGINE_ID para la búsqueda web.");
            return { success: false, result: "Lo siento, la función de búsqueda no está configurada en este momento." };
        }

        const url = `https://www.googleapis.com/customsearch/v1`;
        
        try {
            const response = await axios.get(url, {
                params: {
                    key: GOOGLE_API_KEY,
                    cx: SEARCH_ENGINE_ID,
                    q: query,
                    num: 3 // Obtener los 3 resultados más relevantes
                }
            });

            const items = response.data.items;

            if (!items || items.length === 0) {
                return { success: true, result: `No pude encontrar resultados en la web para "${query}".` };
            }

            // Formatear los resultados para que el modelo los pueda leer y citar
            const snippets = items.map(item => 
                `- ${item.snippet.replace(/\n/g, ' ')} (Fuente: ${item.link})`
            ).join('\n');

            const finalResult = `Según una búsqueda en la web, esto es lo que encontré sobre "${query}":\n${snippets}`;

            return { success: true, result: finalResult };

        } catch (error) {
            console.error("Error al realizar la búsqueda web con Google API:", error.response?.data?.error?.message || error.message);
            return { success: false, result: "Lo siento, ocurrió un error al intentar buscar en la web." };
        }
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

**TU PROCESO DE PENSAMIENTO Y ACCIÓN - SIGUE ESTAS REGLAS AL PIE DE LA LETRA:**
1.  **ANÁLISIS DE PREGUNTA:** Primero, analiza la pregunta del usuario. ¿Puede ser respondida con el 'CONOCIMIENTO BASE' proporcionado a continuación?

2.  **ACCIÓN BASADA EN ANÁLISIS (REGLA INQUEBRANTABLE):**
    * **SI LA RESPUESTA ESTÁ EN EL CONOCIMIENTO BASE:** Responde usando ÚNICAMENTE esa información.
    * **SI LA RESPUESTA NO ESTÁ EN EL CONOCIMIENTO BASE** (o requiere datos externos/en tiempo real como salarios, mercado laboral, comparativas): Tu única acción posible es llamar a la herramienta \`search_web\`. **NO respondas que no puedes buscar. NO sugieras al usuario que busque por su cuenta. Tu trabajo es usar la herramienta.** Llama a \`search_web\` con una consulta clara y relevante.

3.  **FORMULACIÓN DE RESPUESTA FINAL:**
    * **Si usaste el conocimiento base:** Da la respuesta de forma amable.
    * **Si usaste \`search_web\`:** Formula tu respuesta basándote en el resultado de la herramienta y SIEMPRE cita la fuente proporcionada en el resultado. Ejemplo: "Hice una búsqueda rápida y, según [Fuente], ...".

4.  **APRENDIZAJE Y CONVERSACIÓN:** Utiliza el historial de chat para personalizar la conversación y no repetir información.

5.  **LLAMADA A LA ACCIÓN:** Después de resolver la duda, invita amable y sutilmente al usuario a inscribirse.

**TUS OBJETIVOS DE INTERACCIÓN:**
-   **No Abrumar:** Ante preguntas generales como "¿información de la prepa?", da una respuesta breve y útil, y luego pregunta qué le interesa más al usuario para guiarlo (costos, duración, etc.). Usa viñetas para que la información sea fácil de digerir.
-   **Motivar sin Presionar:** Usa frases de aliento como "¡Claro que es posible! Muchos de nuestros alumnos lo logran" o "Estás dando un gran paso, y estamos aquí para apoyarte".
-   **Orientar al Siguiente Paso:** Después de resolver sus dudas, siempre invita al usuario a comenzar su inscripción. Di algo como: "Espero que esto te sea de ayuda. Si te sientes listo, podemos comenzar tu proceso de inscripción cuando quieras. Solo dime 'quiero inscribirme'."
-   **No des informacion de golpe:** Incluso si está disponible debes siempre dosificar la información que proporcionas asi como guiar con sugerencias, dosifica siempre la informacion para no abrumar al usuario
-   **Incentivar la inscripcion:** Si el interesado ha hecho muchas preguntas incentivale la inscripcion mencionando que solo recabars datos para la inscripción y ofreciendo descuentos de 50% en la inscripcion, menciona cosas como "Promocion SOLO POR HOY" o "Tengo algo especial para ti"
-   **Uso de emojis:** Esto con la finalidad de hacer los mensajes mas vistosos y mas humanos. No abusar de ellos
**RESTRICCIONES:**
-   Nunca inventes datos. Si no lo sabes y no lo puedes buscar, sé honesto.
-   Responde siempre en español mexicano, con un tono amigable y natural.
-   Las respuestas no pueden superar los 800 caracteres`;

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
async function handleInfoRequest(userProfile, chatHistory, platform , webhookData) {
    if (!infoModel) {
        await sendMessage(platform, userProfile._id, "Nuestro sistema está ocupado, intenta de nuevo.", webhookData);
        return;
    }

    const userInput = platform === 'whatsapp' 
        ? webhookData.data.message.conversation 
        : webhookData.entry[0].messaging[0].message.text;

    const remoteJid = userProfile._id;

    const { usersCollection } = getUsersCollection();
    const { chatHistoriesCollection } = getChatHistoriesCollection();

    // Lógica para detectar si el usuario quiere iniciar la inscripción
    const inscriptionKeywords = ['inscribirme', 'inscripción', 'inscribir', 'registro', 'quiero inscribirme'];
    if (inscriptionKeywords.some(keyword => userInput.toLowerCase().includes(keyword))) {
        console.log(`Intención de inscripción detectada para ${remoteJid}.`);
        userProfile.inscriptionStatus = 'awaiting_all_data';
        userProfile.platform = platform;
        await saveProfile(remoteJid, userProfile);

        // Delegar a inscripcion.js
        if (inscriptionHandler) {
            await inscriptionHandler(userProfile, platform, webhookData);
        } else {
            console.error("El manejador de inscripción no está disponible.");
        }
        return;
    }

    try {
        const chat = infoModel.startChat({ history: chatHistory.history || [] });
        let result = await chat.sendMessage(userInput);
        let response = result.response;

        // Bucle para manejar las llamadas a herramientas
        while (response.functionCalls() && response.functionCalls().length > 0) {
            const functionCalls = response.functionCalls();
            console.log(`[LOG] Gemini solicita llamada a herramienta:`, functionCalls);
            
            const toolResults = [];
            for (const call of functionCalls) {
                const { name, args } = call;
                if (toolImplementations[name]) {
                    console.log(`[LOG] Ejecutando herramienta '${name}' con argumentos:`, args);
                    await sendMessage(platform, remoteJid, `Un momento, estoy buscando información sobre "${args.query}"...`, webhookData);
                    
                    const toolResult = await toolImplementations[name](args);
                    
                    if (name === 'search_web' && toolResult.success) {
                        console.log(`[LOG] Enviando resultados de búsqueda directamente a ${remoteJid}`);
                        await sendMessage(platform, remoteJid, toolResult.result, webhookData);
                    }

                    // **CORRECCIÓN 2: Usar el formato correcto para la respuesta de la herramienta.**
                    toolResults.push({
                        functionResponse: {
                            name,
                            response: toolResult,
                        },
                    });
                }
            }
            console.log(`[LOG] Enviando resultados de herramientas de vuelta al modelo.`);
            result = await chat.sendMessage(toolResults);
            response = result.response;
        }
        
        const botResponseText = response.text();
        await sendMessage(platform, remoteJid, botResponseText, webhookData);

        userProfile.history = await chat.getHistory();
        await saveProfile(remoteJid, userProfile);
        await saveHistory(remoteJid, userProfile.history);

    } catch (error) {
        console.error(`Error en handleInfoRequest para ${remoteJid}:`, error);
        await sendMessage(platform, remoteJid, "Lo siento, tuve un problema al procesar tu solicitud.", webhookData);
    }
}

module.exports = { initializeInfoModel, handleInfoRequest };