// ingest/Pipeline de Ingesta RAG/02_chunk_documents.ts

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ✅ CORRECCIÓN 1: La ruta asume que 'types.ts' está en el mismo subdirectorio.
// Si no existe, debes crearlo con las interfaces LegalDocument y LegalChunk.
import { LegalDocument, LegalChunk } from './types.ts'; 

// --- CONSTANTES ---
const MAX_CHARS_PER_CHUNK = 1000;
const MIN_CHARS_PER_CHUNK = 100;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- LÓGICA DE CHUNKING (Manteniendo las funciones del usuario) ---

function createChunk(doc: LegalDocument, content: string, index: number, articleNumber?: string): LegalChunk {
    // ... (Implementación de createChunk)
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

function simpleParagraphChunker(doc: LegalDocument): LegalChunk[] {
     const paragraphs = doc.full_text.split('\n\n').filter(p => p.trim().length > 100);
     return paragraphs.map((p, i) => createChunk(doc, p, i));
}

function smartChunker(doc: LegalDocument): LegalChunk[] {
    const articleRegex = /(Artículo\s+\d+\.\s+.*?)(?=Artículo\s+\d+\.|$)/gs;
    const matches = [...doc.full_text.matchAll(articleRegex)];

    const chunks: LegalChunk[] = [];
    let chunkIndex = 0;

    if (matches.length === 0) { return simpleParagraphChunker(doc); }

    for (const match of matches) {
        const articleText = match[1].trim();
        const articleNumberMatch = articleText.match(/Artículo\s+(\d+)\./);
        const articleNumber = articleNumberMatch ? articleNumberMatch[1] : undefined;

        if (articleText.length > MAX_CHARS_PER_CHUNK) {
            const paragraphs = articleText.split('\n\n').filter(p => p.trim().length > MIN_CHARS_PER_CHUNK);
            paragraphs.forEach(paragraph => { chunks.push(createChunk(doc, paragraph, chunkIndex++, articleNumber)); });
        } else if (articleText.length > MIN_CHARS_PER_CHUNK) {
            chunks.push(createChunk(doc, articleText, chunkIndex++, articleNumber));
        }
    }
    return chunks;
}

// --- FUNCIÓN EJECUTORA (Ajustada para I/O) ---
async function runChunking() {
    console.log("▶️ Iniciando Fase 2: Chunking Inteligente de Documentos...");
    
    // 1. Cargar datos del Paso 1 (Adquisición)
    // ✅ CORRECCIÓN 2: Usa '../' para acceder a la carpeta padre 'ingest/'
    const fullTextPath = path.join(__dirname, '../temp_full_text.txt');
    const metadataPath = path.join(__dirname, '../temp_metadata.json'); 
    
    if (!fs.existsSync(fullTextPath) || !fs.existsSync(metadataPath)) {
        throw new Error(`❌ ERROR: No se encuentran archivos intermedios. Ejecute 01_acquire_documents.ts primero.`);
    }

    const fullText = fs.readFileSync(fullTextPath, 'utf-8');
    const sourceMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    
    // Construimos el objeto LegalDocument completo
    const sourceDocument: LegalDocument = { ...sourceMetadata, full_text: fullText };

    // 2. Aplicar Chunking
    const chunks = smartChunker(sourceDocument);

    // 3. Guardar Chunks sin Embeddings para el Paso 3
    // ✅ CORRECCIÓN 3: Guarda en la carpeta padre 'ingest/'
    fs.writeFileSync(path.join(__dirname, '../temp_chunks.json'), JSON.stringify(chunks, null, 2));

    console.log(`✅ Fase 2 completada. Creados ${chunks.length} chunks listos para vectorización.`);
}

// Ejecutar la función principal
runChunking().catch(console.error);