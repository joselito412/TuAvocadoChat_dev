// ingest/Pipeline de Ingesta RAG/03_generate_embeddings.ts

import { createClient } from '@supabase/supabase-js'; 
import { GoogleGenAI } from '@google/genai';         
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config'; 
import { fileURLToPath } from 'url';

// 🆕 RUTA CORREGIDA: Importa la interfaz para tipado estático
import { LegalChunk } from './types.ts'; 

// --- CONFIGURACIÓN CRÍTICA ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; 
const EMBEDDING_MODEL = 'text-embedding-004'; 

// Cliente Supabase con Service Role Key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
let geminiClient: GoogleGenAI; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** * [FUNCIÓN DE AUTENTICACIÓN] Obtiene el cliente OAuth2 usando ADC.
 * Copia de la lógica administrativa de ingest.ts original.
 */
async function getGoogleAuthClient() {
    // ID de la Service Account que ya tiene el rol 'Usuario de Vertex AI'
    const SERVICE_ACCOUNT_TO_IMPERSONATE = '688865581027-compute@developer.gserviceaccount.com'; // CRÍTICO: Usar el ID correcto de tu proyecto
    
    const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    
    // [CRÍTICO]: Suplantamos la identidad de la Service Account que tiene el permiso
    const authClient = await auth.getClient();
    
    const impersonatedClient = await auth.getClient({
        targetServiceAccount: SERVICE_ACCOUNT_TO_IMPERSONATE,
        client: authClient
    });

    return impersonatedClient;
}


async function generateEmbeddings() {
    console.log("▶️ Iniciando Fase 3: Generación de Embeddings y Persistencia...");
    
    // 1. Inicialización de Autenticación
    const authClient = await getGoogleAuthClient();
    // Usamos 'as any' porque getGoogleAuthClient retorna un cliente OAuth2.
    geminiClient = new GoogleGenAI({ auth: authClient as any }); 

    // 2. Cargar Chunks del paso 02
    // ✅ RUTA AJUSTADA: Usa '../' para acceder a la carpeta padre 'ingest/'
    const chunksPath = path.join(__dirname, '../temp_chunks.json'); 
    if (!fs.existsSync(chunksPath)) {
        throw new Error(`❌ ERROR: No se encontraron chunks. Ejecute 02_chunk_documents.ts primero.`);
    }
    // Tipado fuerte usando la interfaz LegalChunk
    const chunksToProcess: LegalChunk[] = JSON.parse(fs.readFileSync(chunksPath, 'utf-8'));
    const finalChunks: LegalChunk[] = [];
    
    // 3. Vectorización (La parte lenta y con Rate Limit)
    for (let i = 0; i < chunksToProcess.length; i++) {
        const chunk = chunksToProcess[i];
        
        try {
            console.log(`[Paso 3] Generando embedding para chunk ${i + 1}/${chunksToProcess.length}...`);
            
            const embeddingResponse = await geminiClient.models.embedContent({
                model: EMBEDDING_MODEL,
                contents: [chunk.content_chunk], 
                taskType: "RETRIEVAL_DOCUMENT"
            });
            
            finalChunks.push({
                ...chunk,
                embedding: embeddingResponse.embeddings[0].values, 
            });

        } catch (e) {
            console.error(`❌ ERROR en la vectorización del chunk ${i}:`, e.message);
            // Implementar lógica de reintento o registro en ingestion_logs (para escalamiento)
            continue; 
        }
    }

    // 4. Indexación Final (Escritura en C3)
    console.log(`[Paso 4] Insertando ${finalChunks.length} fragmentos en legal_documents...`);

    const { error } = await supabase
        .from('legal_documents')
        // Insertamos el array completo de objetos (chunk + embedding)
        .insert(finalChunks as any[]); 

    if (error) {
        console.error("❌ ERROR CRÍTICO en la inserción de Supabase:", error);
    } else {
        // Actualizar el conteo de chunks en la tabla source_documents
        const documentId = finalChunks.length > 0 ? finalChunks[0].document_id : '';
        // Usamos .eq para asegurar que solo se actualiza el documento correcto
        await supabase.from('source_documents').update({ total_chunks: finalChunks.length }).eq('document_id', documentId);
        
        console.log("✅ Fase 3 completada. Documentos vectorizados e indexados.");
    }
}

// FINALIZACIÓN: Llamada a la función principal
generateEmbeddings().catch(console.error);