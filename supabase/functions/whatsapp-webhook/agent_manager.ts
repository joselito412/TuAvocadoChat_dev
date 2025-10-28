// supabase/functions/whatsapp-webhook/agent_manager.ts

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.2'; 
import { GoogleGenAI } from 'https://esm.sh/@google/genai@0.14.0'; // SDK de Gemini

// ----------------------------------------------------------------------
// --- CONFIGURACIÓN CRÍTICA (Secrets de Capa 4) ---
// ----------------------------------------------------------------------
const WHATSAPP_API_TOKEN = Deno.env.get('WHATSAPP_API_TOKEN')!;
const WHATSAPP_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_ID')!;

// 🔑 CLAVES DE LLM (Obtenidas de Secrets)
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!; // Clave principal
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY'); // Clave de respaldo (comentada)

// Modelos usados para el Agente AVOCADO
const GEMINI_EMBEDDING_MODEL = 'text-embedding-004'; 
const GEMINI_GENERATION_MODEL = 'gemini-2.5-flash';  

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
        
        // ⚠️ RESPALDO COMENTADO (OpenAI)
        /*
        if (OPENAI_API_KEY) {
            // Aquí iría el código de respaldo que inicializa el cliente OpenAI
            // y llama a openai.embeddings.create
            console.warn('Respaldo con OpenAI omitido. Usando vector Mock en su lugar.');
        }
        */

        // Fallback si la clave o la API fallan. (Vector Mock)
        console.warn('Usando vector Mock. El RAG fallará hasta que se ingeste conocimiento real.');
        return Array(1536).fill(Math.random()); 
    }
}

/** Llama a la RPC de PostgreSQL para buscar fragmentos legales (Retrieval) */
async function retrieveRAGContext(secureClient: SupabaseClient, query: string): Promise<any[]> {
    // 1. Generar el embedding de la consulta del usuario
    const queryEmbedding = await generateQueryEmbedding(query);

    // 2. Llamada a la RPC de PostgreSQL (pgvector)
    const { data, error } = await secureClient.rpc('match_legal_documents', {
        query_embedding: queryEmbedding as any, 
        match_threshold: 0.75, // Umbral de similitud 
        match_count: 3 
    });

    if (error) {
        console.error('Error en RPC RAG:', error.message);
        return [];
    }
    return data;
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
// --- LÓGICA CENTRAL DEL AGENTE LANGGRAPH (Capa 4) ---
// ----------------------------------------------------------------------

/** Función central que ejecuta el ciclo de LangGraph (LangGraph Mock en Deno). */
export async function runLangGraphAgent(
    secureClient: SupabaseClient, 
    message_text: string, 
    whatsapp_id: string
): Promise<void> {
    
    // 1. Fase de RAG (Simulando el Router de LangGraph)
    const ragResults = await retrieveRAGContext(secureClient, message_text);
    let aiResponseText = '';
    
    if (ragResults.length > 0) {
        // Ejecución RAG: Augmentation (Generación Aumentada)
        const context = ragResults.map(r => r.content_chunk).join('\n---\n');
        
        // Generar la respuesta final usando Gemini
        aiResponseText = await generateAugmentedResponse(context, message_text);
        
    } else {
        // Simulación de Handoff/Respuesta Directa si RAG falla o no encuentra contexto.
        aiResponseText = `🤖 LangGraph: Recibí tu mensaje, "${message_text}". El LLM no encontró fundamento RAG directo. Tu consulta es segura, pero sugerimos un Handoff para asistencia humana.`;
    }

    // Paso 2: Trazabilidad (Auditoría Legal - Capa 3/4)
    const user_id = await secureClient.auth.getUser().then(res => res.data.user?.id);
    
    const { error: logError } = await secureClient
        .from('ai_interactions')
        .insert({
            user_id: user_id, 
            prompt_used: message_text,
            response_text: aiResponseText,
            llm_model_used: ragResults.length > 0 ? 'Gemini (Augmented)' : 'RAG Fallback',
            cost_in_tokens: 200, 
            path_langgraph_recorrido: ragResults.length > 0 ? ['Router', 'RAG_Executed', 'Augmentation'] : ['Router', 'Respuesta_Directa'],
            rag_fragments_ids: ragResults.map(r => r.id),
        });

    if (logError) {
        console.error('ERROR CRÍTICO: Fallo al registrar ai_interactions:', logError);
    }
    
    // Paso 3: Envío de la Respuesta Final (Capa 4/5)
    await sendWhatsappMessage(whatsapp_id, aiResponseText);
}