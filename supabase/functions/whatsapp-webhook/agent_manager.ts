// supabase/functions/whatsapp-webhook/agent_manager.ts

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.2'; 

// Las variables de Meta se deben leer aquí.
const WHATSAPP_API_TOKEN = Deno.env.get('WHATSAPP_API_TOKEN')!;
const WHATSAPP_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_ID')!;

// ----------------------------------------------------------------------
// --- SERVICIOS DE COMUNICACIÓN (Habilita la Interacción con Meta) ---
// ----------------------------------------------------------------------

/** Servicio de Mensajería: Llama a la API de Meta para responder al usuario. */
async function sendWhatsappMessage(phoneNumber: string, message: string): Promise<void> {
    const payload = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: message }
    };

    const response = await fetch(`https://graph.whatsapp.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
            // El token para enviar respuestas
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
// --- LÓGICA CENTRAL DEL AGENTE LANGGRAPH (Capa 4) ---
// ----------------------------------------------------------------------

/** Función central que ejecuta el ciclo de LangGraph (Mock).
 * @param secureClient El cliente Supabase ya autenticado con el JWT del usuario (Capa 2).
 */
export async function runLangGraphAgent(
    secureClient: SupabaseClient, 
    message_text: string, 
    whatsapp_id: string
): Promise<void> {
    
    // Simulación del Router de LangGraph
    const aiResponseText = `🤖 LangGraph: Recibí tu mensaje, "${message_text}". Tu sesión es segura y tu traza se está registrando. ¡Ya eres interactivo!`;

    // Paso 1: Trazabilidad (Auditoría Legal - Capa 3/4)
    // Obtenemos el user_id de la sesión JWT establecida por la Capa 2.
    const user_id = await secureClient.auth.getUser().then(res => res.data.user?.id);

    if (!user_id) {
        throw new Error("No se pudo obtener el user_id de la sesión JWT.");
    }
    
    const { error: logError } = await secureClient
        .from('ai_interactions')
        .insert({
            user_id: user_id, 
            prompt_used: message_text,
            response_text: aiResponseText,
            llm_model_used: 'Deno LangGraph Mock',
            cost_in_tokens: 100,
            path_langgraph_recorrido: ['Router', 'Respuesta_Directa'],
        });

    if (logError) {
        console.error('ERROR CRÍTICO: Fallo al registrar ai_interactions (RLS?):', logError);
    }
    
    // Paso 2: Envío de la Respuesta Final (Habilitando la Interacción - Capa 4/5)
    await sendWhatsappMessage(whatsapp_id, aiResponseText);

    console.log(`Respuesta enviada a ${whatsapp_id}. Ciclo de LangGraph completado.`);
}