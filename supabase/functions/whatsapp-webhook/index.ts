import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.0';
// Importamos el agente simulado (LangGraph Mock) de la Capa 4/5
import { runLangGraphAgent } from './agent_manager.ts';

// ----------------------------------------------------------------
// Configuraciones de Entorno (Capa 2: Autenticación & Meta)
// ----------------------------------------------------------------
const SUPABASE_URL = Deno.env.get('APP_SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('APP_SUPABASE_ANON_KEY')!;
const WHATSAPP_VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN')!;
// CRÍTICO para el MVP: Webhook de n8n para la orquestación de email
const N8N_EMAIL_VERIFY_WEBHOOK = Deno.env.get('N8N_EMAIL_VERIFY_WEBHOOK')!; 

// ----------------------------------------------------------------
// Funciones de Seguridad y Orquestación (Capa 2)
// ----------------------------------------------------------------

/**
 * [Capa 5: Delegación Asíncrona] Dispara el Webhook de n8n para enviar el código de verificación por email.
 * Es ASÍNCRONA y NO bloquea el hilo de ejecución (fetch sin await).
 */
async function sendVerificationEmail(email: string, code: string): Promise<void> {
    if (!N8N_EMAIL_VERIFY_WEBHOOK) {
        console.error("N8N_EMAIL_VERIFY_WEBHOOK no está configurado.");
        return;
    }
    
    // fetch sin 'await' para mantener la baja latencia CRÍTICA de la Edge Function (Capa 2)
    fetch(N8N_EMAIL_VERIFY_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, reason: 'VERIFY_FREE_PLAN' }),
    }).catch(err => {
        console.error("Error al disparar Webhook de n8n para email:", err);
    });
}

// Función dummy para generación de código
function generateRandomCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * [Capa 2/3: RPC Call] Llama a la RPC upsert_user_free para autenticar/registrar al usuario.
 * (REEMPLAZA la función authenticateAndGetJwt del código anterior)
 * @param whatsappId El ID de Meta (número de teléfono) del usuario.
 * @returns El objeto de perfil completo, incluyendo el jwt_token.
 */
async function authenticateAndGetUserProfile(whatsappId: string, anonClient: any): Promise<any> {
    
    const { data, error } = await anonClient.rpc('upsert_user_free', {
        p_whatsapp_id: whatsappId, // CRÍTICO: Usamos el nombre de columna correcto
        p_full_name: null, 
        p_email: null, 
    }).single(); 

    if (error) {
        throw new Error(`RPC Auth Error (upsert_user_free): ${error.message}`);
    }
    
    // Data ahora contiene el perfil COMPLETO MÁS la columna jwt_token
    return data;
}

// ----------------------------------------------------------------
// Handler Principal del Webhook (Capa 1/2)
// ----------------------------------------------------------------

serve(async (req) => {
  const url = new URL(req.url);
  const method = req.method;

  // 1. HANDSHAKE (Capa 1: GET) - Lógica sin cambios, correcta para baja latencia.
  if (method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('Webhook verificado.');
      return new Response(challenge, { status: 200 });
    }
    return new Response('Verification token mismatch', { status: 403 });
  }

  // 2. RECEPCIÓN DE MENSAJE (Capa 1: POST)
  if (method === 'POST') {
    try {
      const payload = await req.json();

      // Extracción del mensaje
      const messageEntry = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const whatsappUserId = messageEntry?.from;
      const messageContent = messageEntry?.text?.body;
      
      if (!whatsappUserId || !messageContent) {
        return new Response('No message content or user ID found.', { status: 200 });
      }

      // 3. AUTENTICACIÓN Y SEGURIDAD (Capa 2)
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      
      // Llamada a la RPC corregida. Recibe todo el perfil + el JWT
      const userProfile = await authenticateAndGetUserProfile(whatsappUserId, anonClient);
      const jwtToken = userProfile.jwt_token; // CRÍTICO: Extracción directa del JWT
      
      // Lógica simple para inferir si el email debe verificarse (Ejemplo)
      if (userProfile.email && !userProfile.email_verified) { 
          const verificationCode = generateRandomCode(); 
          // 🛑 Delegación asíncrona del envío de email
          sendVerificationEmail(userProfile.email, verificationCode); 
      }
      
      // 4. Crear un cliente seguro con el JWT adjunto para aplicar RLS (Capa 3)
      const secureClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
          headers: {
            Authorization: `Bearer ${jwtToken}`, // CRÍTICO: RLS habilitado
          },
        },
      });

      // 5. DELEGACIÓN ASÍNCRONA A LANGRGRAPH (Capa 4)
      // El secureClient se pasa al Agente para que todas sus consultas respeten el RLS.
      req.waitUntil(runLangGraphAgent(secureClient, messageContent, whatsappUserId));

      // 6. Retorno síncrono de baja latencia (Capa 1 CRÍTICA)
      return new Response('OK - Processing asynchronously', { status: 200 });

    } catch (e) {
      console.error('Error in POST handler:', e.message);
      return new Response(`Internal Server Error: ${e.message}`, { status: 500 });
    }
  }

  return new Response('Not Found', { status: 404 });
});