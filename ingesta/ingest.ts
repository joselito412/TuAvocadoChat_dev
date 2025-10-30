// ingest/ingest.ts

import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
// [CRÍTICO] Importación para autenticación OAuth2 (ADC)
import { GoogleAuth } from 'google-auth-library'; 
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config'; 
// [CRÍTICO] Para resolver ReferenceError: __dirname
import { fileURLToPath } from 'url';

// --- CONFIGURACIÓN DE ENTORNO (CRÍTICA) ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; 

const EMBEDDING_MODEL = 'text-embedding-004'; 

// CRÍTICO: IDs para la prueba (deben existir en sus respectivas tablas)
const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001"; 
const TEST_DOCUMENT_ID = "11111111-1111-1111-1111-111111111111"; 

// Cliente Supabase (Con rol de servicio para bypass RLS)
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("ERROR: Las variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas.");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);


// [FUNCIÓN DE AUTENTICACIÓN] Obtiene el cliente OAuth2 usando ADC
async function getGoogleAuthClient() {
    // ID de la Service Account que ya tiene el rol 'Usuario de Vertex AI'
    const SERVICE_ACCOUNT_TO_IMPERSONATE = '688865581027-compute@developer.gserviceaccount.com';

    const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'], 
    });
    
    // [CRÍTICO]: Suplantamos la identidad de la Service Account que tiene el permiso
    const authClient = await auth.getClient();
    
    // Esto crea un cliente que usa tu token ADC, pero actúa con la identidad del Compute Engine
    const impersonatedClient = await auth.getClient({
        targetServiceAccount: SERVICE_ACCOUNT_TO_IMPERSONATE,
        client: authClient
    });

    return impersonatedClient;
}

// Declaramos el cliente Gemini aquí
let geminiClient: GoogleGenAI; 

// [RESOLUCIÓN DE RUTA] Definición de __dirname para Módulos ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


/** Simulación simple de Chunking: divide el texto por párrafos. */
function simpleChunker(text: string, documentId: string, specialty: string, source: string) {
    const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
    
    return paragraphs.map((content, index) => ({
        content: content.trim(),
        document_id: documentId,
        metadata: {
            specialty: specialty, 
            source_file: source,
            chunk_index: index,
        },
        tenant_id: TEST_TENANT_ID, 
    }));
}

/** Vectoriza los fragmentos y los inserta en la Base de Datos. */
async function ingestDocument() {
    console.log("🚀 Iniciando Pipeline de Ingesta (Capa 0)...");

    // [INICIALIZACIÓN CRÍTICA] Autenticación con ADC/OAuth2
    const authClient = await getGoogleAuthClient();
    geminiClient = new GoogleGenAI({ 
        auth: authClient 
    });

    // 1. Extracción de Texto
    const filePath = path.join(__dirname, 'sample_document.txt'); 
    
    if (!fs.existsSync(filePath)) {
        throw new Error(`ERROR: No se encontró el archivo de prueba en: ${filePath}`);
    }

    const fullText = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);

    console.log(`[Paso 1] Documento cargado: ${fileName}. Longitud: ${fullText.length}`);

    // 2. Chunking y Metadatos
    const chunksToProcess = simpleChunker(fullText, TEST_DOCUMENT_ID, 'Derecho Civil', fileName);

    const finalChunks = [];
    
    // 3. Vectorización de cada fragmento
    for (const chunk of chunksToProcess) {
        console.log(`[Paso 3] Generando embedding para fragmento ${chunk.metadata.chunk_index}...`);

        const embeddingResponse = await geminiClient.models.embedContent({
            model: EMBEDDING_MODEL,
            contents: [chunk.content], 
        });

        if (!embeddingResponse.embeddings || embeddingResponse.embeddings.length === 0) {
            console.error(`Error al obtener embedding para chunk ${chunk.metadata.chunk_index}`);
            continue; 
        }

        // Uso de 'embeddings' (plural), tomamos el primer elemento [0] y la propiedad 'values' (plural).
        finalChunks.push({
            ...chunk,
            embedding: embeddingResponse.embeddings[0].values, 
        });
    }

    // 4. Indexación Final (Escritura en C3)
    console.log(`[Paso 4] Insertando ${finalChunks.length} fragmentos en legal_document_chunks...`);

    const { error } = await supabase
        .from('legal_document_chunks')
        .insert(finalChunks as any[]); 

    if (error) {
        console.error("❌ ERROR CRÍTICO en la inserción de Supabase:", error);
    } else {
        console.log("✅ ¡Ingesta completada con ÉXITO!");
        console.log(`Documentos listos para el RAG Híbrido del tenant: ${TEST_TENANT_ID}`);
    }
}

ingestDocument().catch(console.error);