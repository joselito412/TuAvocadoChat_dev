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

// 🆕 CRÍTICO para la Tool Calling (Capa 5)
const N8N_CASE_CREATION_WEBHOOK = Deno.env.get('N8N_CASE_CREATION_WEBHOOK')!;

// 🔑 CLAVES DE LLM (Obtenidas de Secrets)
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!; // Clave principal

// Modelos usados para el Agente AVOCADO
const GEMINI_EMBEDDING_MODEL = 'text-embedding-004'; 
const GEMINI_GENERATION_MODEL = 'gemini-2.5-flash'; 
const GEMINI_CLASSIFICATION_MODEL = 'gemini-2.5-flash'; 

// CRÍTICO: Mapeo de Thresholds para RAG Híbrido (Cambio 6)
const THRESHOLD_MAP: Record<string, number> = {
    'Derecho Penal': 0.80,   
    'Derecho Civil': 0.70,   
    'Derecho Laboral': 0.75, 
};
const DEFAULT_THRESHOLD = 0.65; 

// 🚨 VALIDACIÓN CRÍTICA (Cambio 1)
if (!GEMINI_API_KEY) {
    throw new Error('ERROR CRÍTICO: GEMINI_API_KEY no está configurada en los Secrets de Supabase.');
}

// Inicialización del cliente Gemini
const geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY }); 

// ----------------------------------------------------------------------
// --- CIRCUIT BREAKER (Cambio 9: Resiliencia) ---
// ----------------------------------------------------------------------

class CircuitBreaker {
    private failures = 0; private lastFailTime = 0; private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
    private failureThreshold = 5; private timeout = 60000; // 1 minuto

    async execute<T>(fn: () => Promise<T>, fallback: T, service: string): Promise<T> {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailTime > this.timeout) { this.state = 'HALF_OPEN'; } 
            else { console.warn(`[BREAKER] ${service} OPEN. Forzando Fallback.`); return fallback; }
        }
        
        try {
            const result = await fn(); this.onSuccess(); return result;
        } catch (error) {
            console.error(`[BREAKER] ${service} Fallo:`, error.message); this.onFailure();
            if (this.state === 'OPEN' || this.state === 'HALF_OPEN') { return fallback; }
            throw error; 
        }
    }
    private onSuccess() {
        if (this.state !== 'CLOSED') console.log('[BREAKER] CERRADO: Servicio recuperado.');
        this.failures = 0; this.state = 'CLOSED';
    }
    private onFailure() {
        this.failures++; this.lastFailTime = Date.now();
        if (this.state !== 'OPEN' && this.failures >= this.failureThreshold) {
            this.state = 'OPEN'; console.error('[BREAKER] ABIERTO: Excedido umbral de fallos. Servicio degradado.');
        }
    }
}
const geminiBreaker = new CircuitBreaker();

// --- FALLBACK DEFINITIONS ---
const FALLBACK_EMBEDDING = Array(768).fill(0); 
const FALLBACK_CLASSIFICATION = { specialty: 'Sin Clasificar', usage: 0 };
const FALLBACK_AUGMENTATION_TEXT = "🤖 [Sistema Degradado] Lo siento, el servicio de IA está experimentando fallas críticas. Hemos iniciado el **Handoff de emergencia** a un abogado humano.";
const FALLBACK_AUGMENTATION = { responseText: FALLBACK_AUGMENTATION_TEXT, usage: 0 };

// ----------------------------------------------------------------------
// --- FUNCIONES DE CÁCHÉ Y HASHING (Cambio 11) ---
// ----------------------------------------------------------------------

/** Helper: Genera un hash MD5 de la consulta para usar como clave de caché. */
async function createMD5Hash(text: string): Promise<string> {
    const data = new TextEncoder().encode(text.toLowerCase().trim());
    const hashBuffer = await crypto.subtle.digest("MD5", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
}


// ----------------------------------------------------------------------
// --- SERVICIOS DE COMUNICACIÓN (Capa 4/5) ---
// ----------------------------------------------------------------------

/** * Servicio de Mensajería: Llama a la API de Meta para responder al usuario.
 * 🐛 CORRECCIÓN: Lanzar excepción si falla la respuesta de Meta (Problema 3).
 */
async function sendWhatsappMessage(phoneNumber: string, message: string): Promise<void> {
    const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: message }
    };
    
    const response = await fetch(`https://graph.whatsapp.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error(`Fallo al enviar mensaje a WhatsApp: ${JSON.stringify(errorData)}`);
        // CORRECCIÓN APLICADA
        throw new Error(`WhatsApp API Error: ${JSON.stringify(errorData)}`); 
    }
}

/** * 🆕 TOOL: Llama al webhook de n8n para crear un caso formal en Notion (Capa 5).
 */
async function crear_caso_notion(user_id: string, query: string, specialty: string, attachments: string[] = []): Promise<string> {
    if (!N8N_CASE_CREATION_WEBHOOK) {
        throw new Error("N8N_CASE_CREATION_WEBHOOK no configurado.");
    }
    
    const payload = {
        user_id: user_id,
        whatsapp_id: user_id, 
        initial_query: query,
        specialty: specialty,
        attachments: attachments,
        source: 'AVOCADO_AI_CHATBOT'
    };
    
    const response = await fetch(N8N_CASE_CREATION_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`n8n Case Creation Failed (${response.status}): ${errorText}`);
    }
    
    // Asumimos que n8n devuelve el ID y mensaje de éxito
    const result = await response.json(); 
    
    return `Caso creado con éxito. ID: ${result.case_id || 'N/A'}. Detalles: ${result.message || 'Procesando'}.`;
}

// ----------------------------------------------------------------------
// --- FUNCIÓN DE RATE LIMITING (Cambio 12) ---
// ----------------------------------------------------------------------
const RATE_LIMIT_COUNT = 10; 
const RATE_LIMIT_WINDOW_MS = 60 * 1000; 

/** * 🐛 CORRECCIÓN: Usar await para atomicidad en la actualización (Problema 1).
 */
async function checkRateLimit(secureClient: SupabaseClient, userId: string): Promise<boolean> {
    const { data, error } = await secureClient
        .from('user_rate_limits')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    if (error && error.code !== 'PGRST116') { console.error('Error al consultar tabla de Rate Limit:', error); return true; }
    const now = Date.now();

    if (!data) {
        // Usar await para la primera inserción
        await secureClient.from('user_rate_limits').insert({ user_id: userId, request_count: 1 });
        return true;
    }
    const windowStart = new Date(data.window_start).getTime();

    if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
        await secureClient.from('user_rate_limits').update({ request_count: 1, window_start: new Date().toISOString() }).eq('user_id', userId);
        return true;
    }

    if (data.request_count >= RATE_LIMIT_COUNT) { return false; }

    // CORRECCIÓN APLICADA (Usar await)
    const { error: updateError } = await secureClient.from('user_rate_limits').update({ request_count: data.request_count + 1 }).eq('user_id', userId);
    if (updateError) { console.error('Error al actualizar Rate Limit:', updateError); } 

    return true;
}


// ----------------------------------------------------------------------
// --- SERVICIOS LLM Y RAG (Capa 4: Implementación Real) ---
// ----------------------------------------------------------------------

/** Genera el embedding de la consulta, utilizando cache si es posible (Cambio 11). */
async function generateQueryEmbedding(secureClient: SupabaseClient, query: string): Promise<number[]> {
    const queryHash = await createMD5Hash(query);
    // 1. Intentar leer del cache (Cache Hit)
    const { data: cached } = await secureClient.from('embedding_cache').select('embedding').eq('query_hash', queryHash).maybeSingle(); 
    if (cached) { 
        console.log('[CACHE HIT] Embedding recuperado.');
        secureClient.from('embedding_cache').update({ hit_count: (cached.hit_count || 0) + 1 }).eq('query_hash', queryHash).then(() => {}).catch(console.error);
        return cached.embedding;
    }
    
    // 2. Cache Miss: Generar nuevo embedding (Cambio 9)
    const uncachedFn = async () => { return (await geminiClient.models.embedContent({ model: GEMINI_EMBEDDING_MODEL, content: query, taskType: "RETRIEVAL_QUERY" })).embedding; };
    let embedding: number[];
    try { embedding = await geminiBreaker.execute(uncachedFn, FALLBACK_EMBEDDING, 'Embedding Service'); } catch (e) { throw e; }

    // 3. Guardar en cache (Cambio 11)
    // ⚠️ La comparación de arrays es intencionalmente por contenido.
    const isFallback = embedding.length === FALLBACK_EMBEDDING.length && embedding.every((val, i) => val === FALLBACK_EMBEDDING[i]);

    if (!isFallback) {
        secureClient.from('embedding_cache').insert({ query_hash: queryHash, embedding: embedding }).then(() => console.log('[CACHE MISS] Guardado.')).catch(console.warn);
    }
    return embedding;
}

/** * Llama a la RPC de PostgreSQL para buscar fragmentos legales (Retrieval).
 * 🐛 CORRECCIÓN: Validar contenido del array de fallback (Problema 4).
 */
async function retrieveRAGContext(secureClient: SupabaseClient, query: string, specialty?: string): Promise<any[]> {
    const queryEmbedding = await generateQueryEmbedding(secureClient, query);
    const determinedSpecialty = specialty && specialty !== 'Sin Clasificar' ? specialty : 'Sin Clasificar';
    const matchThreshold = THRESHOLD_MAP[determinedSpecialty] || DEFAULT_THRESHOLD;

    console.log(`[RAG] Usando Threshold: ${matchThreshold}`);

    // CORRECCIÓN APLICADA (Validación por contenido)
    const isFallback = queryEmbedding.length === FALLBACK_EMBEDDING.length && queryEmbedding.every(v => v === 0);
    
    if (isFallback) { 
        console.warn('Alerta: Embedding Fallback usado. Ignorando resultados RAG.'); 
        return []; 
    }

    const { data, error } = await secureClient.rpc('match_legal_documents', {
        query_embedding: queryEmbedding as any, p_specialty: specialty || null, p_match_threshold: matchThreshold, p_match_count: 3 
    });

    if (error) { console.error('Error en RPC RAG:', error.message); return []; }
    return data;
}

/** Clasifica la consulta y devuelve los tokens usados (Cambio 4, 7, 9) */
async function classifyLegalSpecialty(query: string): Promise<{ specialty: string, usage: number }> {
    const systemPrompt = `Eres un clasificador de consultas legales. Tu única función es identificar la especialidad legal de la siguiente consulta. Debes responder ÚNICAMENTE con una de estas etiquetas: 'Derecho Penal', 'Derecho Civil', 'Derecho Laboral', o 'Sin Clasificar'. NO incluyas ninguna explicación, texto adicional, formato JSON, ni signos de puntuación.`; 
    const fn = async () => {
        const response = await geminiClient.models.generateContent({ model: GEMINI_CLASSIFICATION_MODEL, contents: [{ role: 'user', parts: [{ text: `Consulta: ${query}` }] }], config: { systemInstruction: systemPrompt, temperature: 0.1 } });
        const usage = response.usageMetadata?.totalTokens || 0; 
        const specialtyMap: Record<string, string> = { 'derecho penal': 'Derecho Penal', 'derecho civil': 'Derecho Civil', 'derecho laboral': 'Derecho Laboral', 'sin clasificar': 'Sin Clasificar', };
        const normalized = response.text.trim().toLowerCase().replace(/[.,]/g, '');
        if (specialtyMap[normalized]) { return { specialty: specialtyMap[normalized], usage }; }
        return { specialty: 'Sin Clasificar', usage };
    };

    try { return await geminiBreaker.execute(fn, FALLBACK_CLASSIFICATION, 'Classification Service'); } catch (e) { throw e; }
}

/** * Genera la respuesta, la transmite por streaming y devuelve los tokens usados (Cambio 7, 9, 10).
 * 🐛 CORRECCIÓN: Ya no reenvía el FALLBACK_AUGMENTATION_TEXT dos veces (Problema 2).
 */
async function generateAugmentedResponse(context: string, query: string, whatsappId: string): Promise<{ responseText: string, usage: number }> {
    const systemPrompt = `Eres el Agente Legal AVOCADO. Genera un "Concepto Previo" basándote únicamente en el contexto legal proporcionado. Si el contexto es insuficiente, informa al usuario que se necesita asistencia humana (Handoff). Sé conciso y profesional.`;
    const userPrompt = `Consulta del usuario: ${query}\n\nContexto Legal Recuperado:\n---\n${context}\n---`;

    const fn = async () => {
        const stream = await geminiClient.models.generateContentStream({ model: GEMINI_GENERATION_MODEL, contents: [{ role: 'user', parts: [{ text: userPrompt }] }], config: { systemInstruction: systemPrompt } });
        let fullText = ''; let buffer = ''; const CHUNK_SIZE = 150; 
        
        for await (const chunk of stream) {
            const text = chunk.text || ''; buffer += text; fullText += text;
            if (buffer.length >= CHUNK_SIZE) { await sendWhatsappMessage(whatsappId, buffer); buffer = ''; }
        }
        if (buffer.length > 0) { await sendWhatsappMessage(whatsappId, buffer); }
        
        const usage = stream.usageMetadata?.totalTokens || 0;
        return { responseText: fullText, usage };
    };

    try {
        const result = await geminiBreaker.execute(fn, FALLBACK_AUGMENTATION, 'Augmentation Service');
        
        // Si el breaker forzó el fallback, enviamos el mensaje aquí (si no hubo streaming)
        if (result.responseText === FALLBACK_AUGMENTATION_TEXT) { 
             await sendWhatsappMessage(whatsappId, result.responseText);
        }
        return result;

    } catch (e) {
        console.error('Fallo grave no controlado en generación:', e.message);
        // Si falló de forma crítica, enviamos el mensaje de Handoff
        await sendWhatsappMessage(whatsappId, FALLBACK_AUGMENTATION_TEXT);
        return FALLBACK_AUGMENTATION;
    }
}


// ----------------------------------------------------------------------
// --- FUNCIONES DE VALIDACIÓN Y HANDOFF ---
// ----------------------------------------------------------------------
const MAX_INPUT_LENGTH = 2000;
const MIN_INPUT_LENGTH = 5;

/** Valida la longitud y realiza sanitización básica del mensaje del usuario (Cambio 8). */
function validateInput(message: string): string {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length < MIN_INPUT_LENGTH) { throw new Error("Validation Error: Message too short."); }
    if (trimmedMessage.length > MAX_INPUT_LENGTH) { throw new Error(`Validation Error: Message exceeds ${MAX_INPUT_LENGTH} characters.`); }
    const sanitizedMessage = trimmedMessage.replace(/[\x00-\x1F\x7F]/g, ''); 
    return sanitizedMessage;
}

/** Guarda el estado actual de la conversación o el mensaje en la tabla chat_history. */
async function saveCheckpoint(secureClient: SupabaseClient, user_id: string, message_text: string, is_handoff: boolean): Promise<void> {
    const { error } = await secureClient.from('chat_history').insert({ user_id: user_id, message_text: message_text, is_ai: false, is_handoff_initiated: is_handoff, });
    if (error) { console.error('Error al guardar checkpoint (chat_history):', error); }
}

/** Delega asíncronamente la creación del caso en el sistema de agente humano (n8n/Capa 5). */
async function executeHandoff(user_id: string, whatsapp_id: string, message_text: string, specialty: string): Promise<void> {
    if (!N8N_HANDOFF_WEBHOOK_URL) { console.error("N8N_HANDOFF_WEBHOOK_URL no está configurado. Handoff fallido."); return; }
    
    const handoffPayload = { user_id: user_id, whatsapp_id: whatsapp_id, initial_query: message_text, agent_reason: `RAG fallido o clasificación: ${specialty}`, conversation_summary: `Consulta inicial: ${message_text}`, };

    fetch(N8N_HANDOFF_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(handoffPayload), }).catch(err => { console.error("Error al disparar Webhook de n8n para Handoff:", err); });
}


// ----------------------------------------------------------------------
// --- LÓGICA CENTRAL DEL AGENTE ROUTER (Capa 4) ---
// ----------------------------------------------------------------------

export async function runAgentRouter( // <-- Nombre de la función final (Cambio 13)
    secureClient: SupabaseClient, 
    message_text: string, 
    whatsapp_id: string
): Promise<void> {
    
    const user = await secureClient.auth.getUser();
    const user_id = user.data.user?.id;
    if (!user_id) return;

    // 0. RATE LIMITING (Cambio 12)
    const isAllowed = await checkRateLimit(secureClient, user_id);
    if (!isAllowed) {
        await sendWhatsappMessage(whatsapp_id, `⚠️ Has excedido el límite de ${RATE_LIMIT_COUNT} consultas por minuto. Espera un momento y vuelve a intentarlo.`);
        return; 
    }

    // 1. VALIDACIÓN DE ENTRADA (Cambio 8)
    let sanitized_message: string;
    try {
        sanitized_message = validateInput(message_text);
    } catch (e) {
        const errorMessage = e.message.includes('too long')
            ? `⚠️ Lo siento, tu mensaje excede el límite de ${MAX_INPUT_LENGTH} caracteres. Por favor, envíalo en partes más cortas.`
            : '⚠️ Lo siento, tu mensaje es demasiado corto o contiene caracteres inválidos. Por favor, reformula tu consulta.';
        // sendWhatsappMessage puede fallar, pero lo intentamos de todas formas
        await sendWhatsappMessage(whatsapp_id, errorMessage).catch(console.error);
        return; 
    }

    let totalTokensUsed = 0;
    
    // 2. Fase de Clasificación (Router)
    const { specialty: determined_specialty, usage: classification_tokens } = await classifyLegalSpecialty(sanitized_message);
    totalTokensUsed += classification_tokens; 
    
    let executeHandoffFlag = false;
    
    // 3. Fase de RAG Híbrido (Retrieval)
    const ragResults = await retrieveRAGContext(secureClient, sanitized_message, determined_specialty); 
    let aiResponseText = '';
    
    if (ragResults.length > 0) {
        // --- NODO: RAG_Executed ---
        const context = ragResults.map(r => r.content_chunk).join('\n---\n');
        
        // Generación y Streaming (Cambio 10)
        const { responseText, usage: generation_tokens } = await generateAugmentedResponse(context, sanitized_message, whatsapp_id);
        
        aiResponseText = responseText; 
        totalTokensUsed += generation_tokens; 
        
        // Si el Breaker forzó el fallback (enviado por generateAugmentedResponse), activamos el Handoff
        if (aiResponseText === FALLBACK_AUGMENTATION_TEXT) { executeHandoffFlag = true; }
        
    } else {
        // Handoff_Initiation (Si RAG Falla)
        executeHandoffFlag = true;
        aiResponseText = `🤖 LangGraph: No encontré información específica en la especialidad "${determined_specialty}". Hemos iniciado el **traspaso a un Abogado Humano** (Handoff).`;
        
        await saveCheckpoint(secureClient, user_id, sanitized_message, true); 
        executeHandoff(user_id, whatsapp_id, sanitized_message, determined_specialty);
    }
    
    // 6. Paso de Trazabilidad (Auditoría Legal)
    const langgraph_path = executeHandoffFlag ? ['Router:' + determined_specialty, 'Handoff_Initiated'] : ['Router:' + determined_specialty, 'RAG_Executed', 'Augmentation'];
        
    const { error: logError } = await secureClient
        .from('ai_interactions')
        .insert({
            user_id: user_id, 
            prompt_used: sanitized_message, 
            response_text: aiResponseText,
            llm_model_used: ragResults.length > 0 ? 'Gemini (Streamed)' : 'Handoff Triggered', 
            cost_in_tokens: totalTokensUsed, 
            path_langgraph_recorrido: langgraph_path,
            rag_fragments_ids: ragResults.map(r => r.id),
        });

    if (logError) { console.error('ERROR CRÍTICO: Fallo al registrar ai_interactions:', logError); }
}