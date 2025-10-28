import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.0';
// Importamos el agente simulado (LangGraph Mock) de la Capa 4/5
import { agentManager } from '../agent-manager/agentManager.ts'; 

// ----------------------------------------------------------------
// Configuraciones de Entorno (Capa 2: Autenticación & Meta)
// --- USANDO LOS NUEVOS NOMBRES SIN EL PREFIJO 'SUPABASE_' ---
// ----------------------------------------------------------------
const SUPABASE_URL = Deno.env.get('APP_SUPABASE_URL')!; // Variable renombrada
const SUPABASE_ANON_KEY = Deno.env.get('APP_SUPABASE_ANON_KEY')!; // Variable renombrada
const WHATSAPP_VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN')!;

// ----------------------------------------------------------------
// Funciones de Seguridad (Capa 2)
// ----------------------------------------------------------------

/**
 * Llama a la RPC en PostgreSQL para autenticar al usuario y generar un JWT.
 * El JWT permite el RLS (Seguridad a Nivel de Fila) en la Capa 3.
 * @param whatsappId El ID de Meta (número de teléfono) del usuario.
 * @returns El JWT y el user_id.
 */
async function authenticateAndGetJwt(whatsappId: string, anonClient: any): Promise<{ jwtToken: string, userId: string }> {
  const { data, error } = await anonClient.rpc('upsert_user_and_get_jwt', {
    whatsapp_user_id_in: whatsappId,
  });

  if (error) {
    throw new Error(`RPC Auth Error: ${error.message}`);
  }
  
  // La RPC devuelve { jwt_token, user_id }
  return { jwtToken: data.jwt_token, userId: data.user_id };
}

// ----------------------------------------------------------------
// Handler Principal del Webhook (Capa 1/2)
// ----------------------------------------------------------------

serve(async (req) => {
  const url = new URL(req.url);
  const method = req.method;

  // ----------------------------------
  // 1. HANDSHAKE (Capa 1: GET)
  // ----------------------------------
  if (method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      // Handshake exitoso
      console.log('Webhook verificado.');
      return new Response(challenge, { status: 200 });
    }
    return new Response('Verification token mismatch', { status: 403 });
  }

  // ----------------------------------
  // 2. RECEPCIÓN DE MENSAJE (Capa 1: POST)
  // ----------------------------------
  if (method === 'POST') {
    try {
      const payload = await req.json();

      // Extracción del mensaje (Implementación simplificada)
      const messageEntry = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const whatsappUserId = messageEntry?.from;
      const messageContent = messageEntry?.text?.body;
      
      // Si no es un mensaje de usuario válido, respondemos OK y terminamos.
      if (!whatsappUserId || !messageContent) {
        return new Response('No message content or user ID found.', { status: 200 });
      }

      // ----------------------------------
      // 3. AUTENTICACIÓN Y SEGURIDAD (Capa 2)
      // ----------------------------------
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { jwtToken, userId } = await authenticateAndGetJwt(whatsappUserId, anonClient);
      
      // Crear un cliente seguro con el JWT adjunto para aplicar RLS (Capa 3)
      const secureClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
          },
        },
      });

      // --------------------------------------------------------
      // 4. DELEGACIÓN ASÍNCRONA Y RESPUESTA SÍNCRONA (Capa 1 CRÍTICA)
      // --------------------------------------------------------
      
      // Lógica CRÍTICA para evitar timeout de WhatsApp:
      // Devolvemos 200 OK inmediatamente.
      req.waitUntil(agentManager({
          userId: userId,
          whatsappId: whatsappUserId,
          message: messageContent,
          secureClient: secureClient,
          // Las claves de Meta se pasan aquí o se leen directamente en agentManager.ts
          // Para esta versión, asumimos que agentManager.ts las lee.
      }));

      // Retorno síncrono de baja latencia
      return new Response('OK - Processing asynchronously', { status: 200 });

    } catch (e) {
      console.error('Error in POST handler:', e.message);
      // Respondemos con 500 para notificar a Meta que algo falló internamente
      return new Response(`Internal Server Error: ${e.message}`, { status: 500 });
    }
  }

  return new Response('Not Found', { status: 404 });
});