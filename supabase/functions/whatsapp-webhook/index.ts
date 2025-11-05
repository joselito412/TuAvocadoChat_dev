import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.0';
// Importamos el agente simulado (LangGraph Mock) de la Capa 4/5
import { runLangGraphAgent } from './agent_manager.ts';

// ----------------------------------------------------------------
// Configuraciones de Entorno (Capa 2: Autenticación & Meta)
// ----------------------------------------------------------------
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// 🚨 VARIABLE CRÍTICA: Service Role Key (Se buscará con el nombre seguro)
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('PROJECT_SERVICE_KEY')!; 
// ----------------------------------------------------------------
const WHATSAPP_VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN')!;
const N8N_EMAIL_VERIFY_WEBHOOK = Deno.env.get('N8N_EMAIL_VERIFY_WEBHOOK')!; 

// ----------------------------------------------------------------
// Funciones de Seguridad y Orquestación (Capa 2)
// ----------------------------------------------------------------

/**
 * [Capa 5: Delegación Asíncrona] Dispara el Webhook de n8n para enviar el código de verificación por email.
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
 * @param whatsappId El ID de Meta (número de teléfono) del usuario.
 * @param client El cliente Supabase que puede ser anon o serviceRoleClient.
 * @returns El objeto de perfil completo, incluyendo el jwt_token.
 */
async function authenticateAndGetUserProfile(whatsappId: string, client: any): Promise<any> {
    
    const { data, error } = await client.rpc('upsert_user_free', {
        p_whatsapp_id: whatsappId, 
        p_full_name: null, 
        p_email: null, 
    }).single(); 

    if (error) {
        throw new Error(`RPC Auth Error (upsert_user_free): ${error.message}`);
    }
    
    return data;
}

// ----------------------------------------------------------------
// Handler Principal del Webhook (Capa 1/2)
// ----------------------------------------------------------------

serve(async (req) => {
  const url = new URL(req.url);
  const method = req.method;

  // 1. HANDSHAKE (Capa 1: GET)
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

      const messageEntry = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const whatsappUserId = messageEntry?.from;
      const messageContent = messageEntry?.text?.body;
      
      if (!whatsappUserId || !messageContent) {
        return new Response('No message content or user ID found.', { status: 200 });
      }
      
      // LOGS para depuración
      console.log('--- NUEVA INTERACCIÓN INICIADA (Capa 1) ---');
      console.log('Usuario:', whatsappUserId);

      // 3. AUTENTICACIÓN Y SEGURIDAD (Capa 2)
      
      // 🚨 CAMBIO CRÍTICO: Usar Service Role Client para la RPC de autenticación
      // Esto bypassa el RLS de INSERT que está causando el conflicto
      const serviceRoleClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      
      // Llamada a la RPC con el cliente con privilegios
      const userProfile = await authenticateAndGetUserProfile(whatsappUserId, serviceRoleClient);
      const jwtToken = userProfile.jwt_token; // CRÍTICO: Extracción directa del JWT
      
      // 🚨 LOG CRÍTICO: Capturar el JWT para la prueba RLS
      console.log('✅ JWT Generado (Copia para RLS TEST):', jwtToken); 
      console.log('UUID del Usuario (RLS):', userProfile.id);

      // Lógica simple para inferir si el email debe verificarse (Ejemplo)
      if (userProfile.email && !userProfile.email_verified) { 
          const verificationCode = generateRandomCode(); 
          sendVerificationEmail(userProfile.email, verificationCode); 
      }
      
      // 4. Crear un cliente seguro con el JWT adjunto para aplicar RLS (Capa 3)
      // ESTE CLIENTE SÍ RESPETA EL RLS Y SE USA EN EL RESTO DEL FLUJO
      const secureClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
          headers: {
            Authorization: `Bearer ${jwtToken}`, // CRÍTICO: RLS habilitado
          },
        },
      });
      console.log('✅ Cliente Seguro (RLS) inicializado.');

      // 5. DELEGACIÓN ASÍNCRONA A LANGRGRAPH (Capa 4)
      req.waitUntil(runLangGraphAgent(secureClient, messageContent, whatsappUserId));

      // 6. Retorno síncrono de baja latencia (Capa 1 CRÍTICA)
      console.log('--- RETORNO SÍNCRONO 200 OK (Capa 1) ---');
      return new Response('OK - Processing asynchronously', { status: 200 });

    } catch (e) {
      console.error('Error in POST handler:', e.message);
      return new Response(`Internal Server Error: ${e.message}`, { status: 500 });
    }
  }

  return new Response('Not Found', { status: 404 });
});