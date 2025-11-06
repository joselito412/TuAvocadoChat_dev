// ingest/ingest.ts

// --- Usamos importaciones de paquetes Node.js locales ---
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';         
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config'; 
import { fileURLToPath } from 'url';

// --- CONFIGURACIÓN DE ENTORNO (CRÍTICA) ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; 
const EMBEDDING_MODEL = 'text-embedding-004'; 

// CRÍTICO: IDs para la prueba (deben existir en sus respectivas tablas)
const TEST_TENANT_ID = "57d5a03b-80e0-4ed4-b230-103b786af8a4"; // UUID del Tenant REAL
const TEST_DOCUMENT_ID = "11111111-1111-1111-1111-111111111111"; 

// 🆕 CRÍTICO: ARCHIVO DE CLAVE DE CUENTA DE SERVICIO
const KEY_FILE_NAME = 'rag-key.json'; 

// Cliente Supabase (Con rol de servicio para bypass RLS)
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("ERROR: Las variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ----------------------------------------------------------------------
// --- INTERFACES NECESARIAS (Sin cambios) ---
// ----------------------------------------------------------------------

interface LegalDocument {
    document_id: string;
    title: string;
    specialty: 'Derecho Penal' | 'Derecho Civil' | 'Derecho Laboral' | 'Sin Clasificar';
    full_text: string;
    tenant_id: string;
    metadata: {
        source_name: string;
        publication_date: string;
    };
}

interface LegalChunk {
    document_id: string;
    content_chunk: string;
    specialty: string;
    tenant_id: string;
    embedding?: number[]; 
    metadata: {
        source_file: string;
        article_number?: string; 
        chunk_index: number;
        word_count: number;
    };
}

// ----------------------------------------------------------------------
// --- FUNCIONES DE AUTENTICACIÓN (MÉTODO KEYFILE SEGURO) ---
// ----------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEY_FILE_PATH = path.join(__dirname, KEY_FILE_NAME);

/**
 * 🆕 Inicializa el cliente Gemini usando un archivo de Clave JSON.
 * Este método bypassa el fallo de negociación de scope de ADC/Suplantación.
 */
async function initializeGeminiClient() {
    if (!fs.existsSync(KEY_FILE_PATH)) {
        throw new Error(`ERROR: No se encontró el archivo de clave JSON en: ${KEY_FILE_PATH}. Por favor, cree y descargue una Service Account Key.`);
    }

    const auth = new GoogleAuth({
        keyFile: KEY_FILE_PATH,
        // Usar scopes amplios para cubrir Vertex AI y Generative Language
        scopes: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/generative-language'
        ],
    });

    return await auth.getClient();
}

// ----------------------------------------------------------------------

let geminiClient: GoogleGenAI; 

// ----------------------------------------------------------------------
// --- 🆕 CHUNKING INTELIGENTE (Sin cambios) ---
// ----------------------------------------------------------------------
const MAX_CHARS_PER_CHUNK = 1000;
const MIN_CHARS_PER_CHUNK = 100;


function createChunk(doc: LegalDocument, content: string, index: number, articleNumber?: string): LegalChunk {
    return {
        document_id: doc.document_id,
        content_chunk: content,
        specialty: doc.specialty,
        tenant_id: doc.tenant_id,
        metadata: {
            source_file: doc.metadata.source_name,
            article_number: articleNumber,
            word_count: content.split(/\s+/).length,
            chunk_index: index,
        },
    };
}

/** * Divide el texto legal respetando la estructura de artículos. 
 * Si un artículo es muy largo, lo subdivide por párrafos.
 */
function smartChunker(doc: LegalDocument): LegalChunk[] {
    // Regex para detectar "Artículo X. [contenido]"
    const articleRegex = /(Artículo\s+\d+\.\s+.*?)(?=Artículo\s+\d+\.|$)/gs;
    const matches = [...doc.full_text.matchAll(articleRegex)];

    const chunks: LegalChunk[] = [];
    let chunkIndex = 0;

    // Fallback si no se detectan artículos (ej. es una sentencia)
    if (matches.length === 0) {
        const paragraphs = doc.full_text.split('\n\n').filter(p => p.trim().length > MIN_CHARS_PER_CHUNK);
        return paragraphs.map((p, i) => createChunk(doc, p, i));
    }

    for (const match of matches) {
        const articleText = match[1].trim();
        const articleNumberMatch = articleText.match(/Artículo\s+(\d+)\./);
        const articleNumber = articleNumberMatch ? articleNumberMatch[1] : undefined;

        if (articleText.length > MAX_CHARS_PER_CHUNK) {
            // Subdivisión si el artículo es muy largo
            const paragraphs = articleText.split('\n\n').filter(p => p.trim().length > MIN_CHARS_PER_CHUNK);
            
            paragraphs.forEach(paragraph => {
                chunks.push(createChunk(doc, paragraph, chunkIndex++, articleNumber));
            });
        } else if (articleText.length > MIN_CHARS_PER_CHUNK) {
            // Chunk válido (Artículo completo)
            chunks.push(createChunk(doc, articleText, chunkIndex++, articleNumber));
        }
    }

    return chunks;
}


// ----------------------------------------------------------------------
// --- FUNCIÓN PRINCIPAL DE INGESTA (Modificada) ---
// ----------------------------------------------------------------------

async function ingestDocument() {
    console.log("🚀 Iniciando Pipeline de Ingesta (Capa 0)...");

    // [INICIALIZACIÓN CRÍTICA] 🆕 Usa el nuevo método de autenticación
    const authClient = await initializeGeminiClient();
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

    // --- Definición del Documento Fuente (Datos Mock) ---
    const sourceDocument: LegalDocument = {
        document_id: TEST_DOCUMENT_ID,
        title: fileName,
        specialty: 'Derecho Civil', // Coincide con el ejemplo de sample_document.txt
        full_text: fullText,
        tenant_id: TEST_TENANT_ID,
        metadata: {
            source_name: fileName,
            publication_date: new Date().toISOString().split('T')[0] 
        }
    };

    // 2. Chunking y Metadatos
    // 🆕 USO DE CHUNKING INTELIGENTE
    const chunksToProcess = smartChunker(sourceDocument);

    const finalChunks: LegalChunk[] = [];
    
    // 3. Vectorización de cada fragmento
    for (const chunk of chunksToProcess) {
        console.log(`[Paso 3] Generando embedding para fragmento ${chunk.metadata.chunk_index}...`);

        const embeddingResponse = await geminiClient.models.embedContent({
            model: EMBEDDING_MODEL,
            contents: [chunk.content_chunk], // Usar content_chunk
            taskType: "RETRIEVAL_DOCUMENT" // Usar DOCUMENT para el corpus
        });

        if (!embeddingResponse.embeddings || embeddingResponse.embeddings.length === 0) {
            console.error(`Error al obtener embedding para chunk ${chunk.metadata.chunk_index}`);
            continue; 
        }

        finalChunks.push({
            ...chunk,
            // Uso de 'values' para el array de embedding
            embedding: embeddingResponse.embeddings[0].values, 
        });
    }

    // 4. Indexación Final (Escritura en C3)
    // 🚨 USO DE NOMBRE DE TABLA CORREGIDO: legal_documents
    console.log(`[Paso 4] Insertando ${finalChunks.length} fragmentos en legal_documents...`);

    const { error } = await supabase
        .from('legal_documents')
        .insert(finalChunks as any[]); 

    if (error) {
        console.error("❌ ERROR CRÍTICO en la inserción de Supabase:", error);
    } else {
        console.log("✅ ¡Ingesta completada con ÉXITO!");
        console.log(`Documentos listos para el RAG Híbrido del tenant: ${TEST_TENANT_ID}`);
    }
}

ingestDocument().catch(console.error);