// ingest/01_acquire_documents.ts
import { createClient } from '@supabase/supabase-js'; 
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config'; 
import { fileURLToPath } from 'url';

// --- CONFIGURACIÓN CRÍTICA (Se obtiene de .env) ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; 
const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001"; 
const TEST_DOCUMENT_ID = "11111111-1111-1111-1111-111111111111"; // Mock UUID

// Cliente Supabase con Service Role Key (Omite RLS para tareas admin)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function acquireDocuments() {
    console.log("▶️ Iniciando Fase 1: Adquisición de Documentos Fuente...");
    
    // Simular la adquisición leyendo el archivo local
    const filePath = path.join(__dirname, '../sample_document.txt');    
    if (!fs.existsSync(filePath)) {
        throw new Error(`❌ ERROR: No se encontró el archivo de prueba en: ${filePath}`);
    }

    const fullText = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const specialty = 'Derecho Civil';

    // 1. Insertar el registro de metadatos en source_documents
    const { error: sourceError } = await supabase
        .from('source_documents')
        .insert({
            document_id: TEST_DOCUMENT_ID,
            title: fileName,
            specialty: specialty,
            tenant_id: TEST_TENANT_ID,
            total_chunks: 0, // Se actualizará en la Fase 3
        });

    if (sourceError) {
        console.error("❌ ERROR: Fallo al registrar source_documents:", sourceError);
        return;
    }

    // 2. Exportar el texto completo para el siguiente paso (Chunking)
    // Se guarda el texto en un formato intermedio simple
    fs.writeFileSync(path.join(__dirname, 'temp_full_text.txt'), fullText);

    console.log(`✅ Fase 1 completada. Documento '${fileName}' registrado y texto listo para Chunking.`);
}

acquireDocuments().catch(console.error);