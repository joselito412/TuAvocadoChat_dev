// supabase/functions/whatsapp-webhook/agent_manager.ts

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.2'; 
import { GoogleGenAI } from 'https://esm.sh/@google/genai@0.14.0'; // SDK de Gemini

// ----------------------------------------------------------------------
// --- CONFIGURACIÓN CRÍTICA (Secrets de Capa 4/5) ---
// ----------------------------------------------------------------------
const WHATSAPP_API_TOKEN = Deno.env.get('WHATSAPP_API_TOKEN')!;
const WHATSAPP_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_ID')!;

// CRÍTICO para el Handoff a Agente Humano (Capa 5)
const N8N_HANDOFF_WEBHOOK_URL = Deno.env.get('N8N_HANDOFF_WEBHOOK_URL')!; 

// 🔑 CLAVES DE LLM (Obtenidas de Secrets)
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!; // Clave principal
// const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY'); // Clave de respaldo

// Modelos usados para el Agente AVOCADO
const GEMINI_EMBEDDING_MODEL = 'text-embedding-004'; 
const GEMINI_GENERATION_MODEL = 'gemini-2.5-flash'; 
 
// Modelo para el clasificador (Router)
const GEMINI_CLASSIFICATION_MODEL = 'gemini-2.5-flash'; 

// Inicialización del cliente Gemini
// Solo se inicializa si la clave existe; de lo contrario, fallará la ejecución LLM.
const geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY }); 

// ----------------------------------------------------------------------
// --- SERVICIOS DE COMUNICACIÓN (Capa 4/5) ---
// ----------------------------------------------------------------------

/** Servicio de Mensajería: Llama a la API de Meta para responder al usuario. */
async function sendWhatsappMessage(phoneNumber: string, message: string): Promise<void> {
    const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: message }
    };
    
    // Llamada al endpoint de Meta
    const response = await fetch(`https://graph.whatsapp.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`, 
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Fallo al enviar mensaje a WhatsApp: ${JSON.stringify(errorData)}`);
    }
}

// ----------------------------------------------------------------------
// --- SERVICIOS LLM Y RAG (Capa 4: Implementación Real) ---
// ----------------------------------------------------------------------

/** Genera el embedding de la consulta usando Gemini (Principal). */
async function generateQueryEmbedding(query: string): Promise<number[]> {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY no configurada en Secrets.');
        } 

        // Llamada real al modelo de embedding de Gemini
        const response = await geminiClient.models.embedContent({
            model: GEMINI_EMBEDDING_MODEL,
            content: query,
            taskType: "RETRIEVAL_QUERY",
        });
        return response.embedding;
    } catch (e) {
        console.error('Fallo en la generación de embedding con Gemini (Principal):', e.message);
        
        // Fallback si la clave o la API fallan. (Vector Mock)
        console.warn('Usando vector Mock. El RAG fallará hasta que se ingeste conocimiento real.');
        return Array(1536).fill(Math.random()); 
    }
}

/** Llama a la RPC de PostgreSQL para buscar fragmentos legales (Retrieval) */
async function retrieveRAGContext(secureClient: SupabaseClient, query: string, specialty?: string): Promise<any[]> {
    // 1. Generar el embedding de la consulta del usuario
    const queryEmbedding = await generateQueryEmbedding(query);

    // 2. Llamada a la RPC de PostgreSQL (pgvector)
    const { data, error } = await secureClient.rpc('match_legal_documents', {
        query_embedding: queryEmbedding as any, 
        p_specialty: specialty || null, // CRÍTICO: Filtro de metadatos (RAG Híbrido)
        p_match_threshold: 0.75, // Ajustado a los nombres del RPC
        p_match_count: 3 // Ajustado a los nombres del RPC
    });

    if (error) {
        console.error('Error en RPC RAG:', error.message);
        return [];
    }
    return data;
}

/** Clasifica la consulta del usuario para determinar la especialidad legal (Router de LangGraph). */
async function classifyLegalSpecialty(query: string): Promise<string> {
    const systemPrompt = `Eres un clasificador de consultas legales. Tu única función es identificar la especialidad legal de la siguiente consulta.
    Debes responder ÚNICAMENTE con una de estas etiquetas: 'Derecho Penal', 'Derecho Civil', 'Derecho Laboral', o 'Sin Clasificar'.
    NO incluyas ninguna explicación, texto adicional, formato JSON, ni signos de puntuación.`;
    
    try {
        const response = await geminiClient.models.generateContent({
            model: GEMINI_CLASSIFICATION_MODEL,
            contents: [{ role: 'user', parts: [{ text: `Consulta: ${query}` }] }],
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.1 // Baja temperatura para una clasificación determinista
            }
        });

        // Limpieza de la respuesta para obtener solo la etiqueta
        const result = response.text.trim();
        
        // Validación de las etiquetas permitidas
        if (['Derecho Penal', 'Derecho Civil', 'Derecho Laboral'].includes(result)) {
            return result;
        }

        // Devolvemos 'Sin Clasificar' si el LLM falla en seguir el prompt
        return 'Sin Clasificar';
    } catch (e) {
        console.error('Fallo en la clasificación de especialidad con Gemini:', e.message);
        return 'Sin Clasificar'; // Fallback seguro
    }
}

/** Genera la respuesta final usando el LLM (Augmentation) */
async function generateAugmentedResponse(context: string, query: string): Promise<string> {
    const systemPrompt = `Eres el Agente Legal AVOCADO. Genera un "Concepto Previo" basándote únicamente en el contexto legal proporcionado. Si el contexto es insuficiente, informa al usuario que se necesita asistencia humana (Handoff). Sé conciso y profesional.`;
    
    const userPrompt = `Consulta del usuario: ${query}\n\nContexto Legal Recuperado:\n---\n${context}\n---`;

    try {
        const response = await geminiClient.models.generateContent({
            model: GEMINI_GENERATION_MODEL,
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            config: {
                systemInstruction: systemPrompt,
            }
        });
        
        return response.text.trim();
    } catch (e) {
        console.error('Fallo en la generación de respuesta con Gemini (Generación):', e.message);
        // Fallback si la generación LLM falla
        return "🤖 LangGraph: Lo siento, la inteligencia artificial está experimentando dificultades. Sugiero solicitar un Handoff.";
    }
}

// ----------------------------------------------------------------------
// --- FUNCIONES DE HANDOFF Y CHECKPOINTING (Capa 4 -> C3/C5) ---
// ----------------------------------------------------------------------

// Tarea II.3: Checkpointing
/** Guarda el estado actual de la conversación o el mensaje en la tabla chat_history. */
async function saveCheckpoint(secureClient: SupabaseClient, user_id: string, message_text: string, is_handoff: boolean): Promise<void> {
    const { error } = await secureClient
        .from('chat_history')
        .insert({
            user_id: user_id, 
            message_text: message_text,
            is_ai: false, // El mensaje siempre viene del usuario
            is_handoff_initiated: is_handoff, // Indica si este mensaje activó el Handoff
        });
    
    if (error) {
        console.error('Error al guardar checkpoint (chat_history):', error);
    }
}

// Tarea II.2: Finalizar Handoff Condicional
/** Delega asíncronamente la creación del caso en el sistema de agente humano (n8n/Capa 5). */
async function executeHandoff(user_id: string, whatsapp_id: string, message_text: string, specialty: string): Promise<void> {
    if (!N8N_HANDOFF_WEBHOOK_URL) {
        console.error("N8N_HANDOFF_WEBHOOK_URL no está configurado. Handoff fallido.");
        return;
    }
    
    const handoffPayload = {
        user_id: user_id,
        whatsapp_id: whatsapp_id, // Necesario para contactar al usuario
        initial_query: message_text,
        agent_reason: `RAG fallido o clasificación: ${specialty}`,
        conversation_summary: `Consulta inicial: ${message_text}`, 
    };

    // fetch sin 'await' (delegación asíncrona CRÍTICA)
    fetch(N8N_HANDOFF_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(handoffPayload),
    }).catch(err => {
        console.error("Error al disparar Webhook de n8n para Handoff:", err);
    });
}


// ----------------------------------------------------------------------
// --- LÓGICA CENTRAL DEL AGENTE LANGGRAPH (Capa 4) ---
// ----------------------------------------------------------------------

/** Función central que ejecuta el ciclo de LangGraph (LangGraph Mock en Deno). */
export async function runLangGraphAgent(
    secureClient: SupabaseClient, 
    message_text: string, 
    whatsapp_id: string
): Promise<void> {
    
    // Obtener el ID del usuario actual (necesario para Checkpointing y Handoff)
    const user = await secureClient.auth.getUser();
    const user_id = user.data.user?.id;
    if (!user_id) {
        console.error("Error crítico: User ID no encontrado en la sesión segura.");
        return;
    }
    
    // 1. Fase de Clasificación (Router de LangGraph)
    const determined_specialty = await classifyLegalSpecialty(message_text);

    // Bandera para indicar si se debe ejecutar el Handoff
    let executeHandoffFlag = false;
    
    // 2. Fase de RAG Híbrido (Retrieval)
    const ragResults = await retrieveRAGContext(secureClient, message_text, determined_specialty);
    let aiResponseText = '';
    
    // Lógica Condicional del Agente LangGraph (Router)
    if (ragResults.length > 0) {
        // --- NODO: RAG_Executed ---
        // Ejecución RAG: Augmentation (Generación Aumentada)
        const context = ragResults.map(r => r.content_chunk).join('\n---\n');
        
        // Generar la respuesta final usando Gemini
        aiResponseText = await generateAugmentedResponse(context, message_text);
        
    } else {
        // --- NODO: Handoff_Initiation ---
        // Si no hay resultados RAG, se ejecuta la ruta de Handoff
        executeHandoffFlag = true;
        
        // 3. (Simulación) Respuesta al usuario notificando el Handoff
        aiResponseText = `🤖 LangGraph: No encontré información específica en la especialidad "${determined_specialty}". Hemos iniciado el **traspaso a un Abogado Humano** (Handoff). Un agente te contactará por este medio tan pronto como esté disponible.`;
        
        // 4. Tarea II.3: Checkpointing
        // Guardamos el último mensaje y marcamos que el Handoff se inició
        await saveCheckpoint(secureClient, user_id, message_text, true); 
        
        // 5. Tarea II.2: Ejecución Asíncrona del Handoff (Capa 5)
        // La Edge Function lo gestiona sin bloquear el hilo principal
        executeHandoff(user_id, whatsapp_id, message_text, determined_specialty);
    }
    
    // 6. Paso de Trazabilidad (Auditoría Legal - Capa 3/4)
    // Se ejecuta al final, independientemente de la ruta (RAG o Handoff)
    const langgraph_path = executeHandoffFlag 
        ? ['Router:' + determined_specialty, 'Handoff_Initiated', 'Checkpointing'] 
        : ['Router:' + determined_specialty, 'RAG_Executed', 'Augmentation'];
        
    const { error: logError } = await secureClient
        .from('ai_interactions')
        .insert({
            user_id: user_id, 
            prompt_used: message_text,
            response_text: aiResponseText,
            llm_model_used: ragResults.length > 0 ? 'Gemini (Augmented)' : 'Handoff Triggered',
            cost_in_tokens: 200, 
            path_langgraph_recorrido: langgraph_path,
            rag_fragments_ids: ragResults.map(r => r.id),
        });

    if (logError) {
        console.error('ERROR CRÍTICO: Fallo al registrar ai_interactions:', logError);
    }
    
    // 7. Envío de la Respuesta Final (Capa 4/5)
    await sendWhatsappMessage(whatsapp_id, aiResponseText);
}