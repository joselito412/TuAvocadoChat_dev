// ingest/04_validate_quality.ts
import { createClient } from '@supabase/supabase-js'; 
import 'dotenv/config'; 

// --- CONFIGURACIÓN ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!; // Usar ANON KEY para simular consulta del Edge
const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001"; 

// Asumimos que la generación de embeddings para el query funciona (la lógica está en agent_manager.ts)
// Simulamos el vector del query para la prueba (Necesitas la función real de tu Capa 4)
function getTestQueryEmbedding(): number[] {
    // ESTO DEBE SER UN VECTOR REAL DE 768 DIMENSIONES DEL QUERY DE PRUEBA
    // Para el demo, devolvemos un mock vector de 768 ceros.
    return Array(768).fill(0); 
}

async function validateQuality() {
    console.log("▶️ Iniciando Fase 4: Validación y Prueba de Calidad...");
    
    // 1. Creamos un cliente que simula la Capa 2 (Edge Function) con RLS/Anon Key
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    
    // 2. Definir prueba de Smoke Test
    const TEST_QUERY = "Quiero saber sobre el incumplimiento de contratos en Derecho Civil.";
    const TEST_SPECIALTY = "Derecho Civil";
    
    // **CRÍTICO**: Generar el embedding del query (Se necesita el modelo de Gemini para esto)
    const queryEmbedding = getTestQueryEmbedding(); 
    
    if (queryEmbedding.length !== 768) {
        console.error("❌ ERROR: La función de embedding de prueba debe retornar un vector de 768 dimensiones.");
        return;
    }

    // 3. Ejecutar la RPC de RAG (Simulando el Agente Router)
    const { data: results, error } = await supabase.rpc('match_legal_documents', {
        query_embedding: queryEmbedding as any, 
        p_specialty: TEST_SPECIALTY, 
        p_match_threshold: 0.60, 
        p_match_count: 3 
    });

    // 4. Auditoría y Reporte
    if (error) {
        console.error("❌ ERROR CRÍTICO: Fallo en la RPC 'match_legal_documents':", error);
        return;
    }

    if (results && results.length > 0) {
        console.log(`✅ TEST DE RAG SUPERADO. Se recuperaron ${results.length} fragmentos.`);
        console.log(`   - Top 1 Similitud: ${results[0].similarity.toFixed(4)}`);
        console.log(`   - Corpus Principal: ${results[0].content_chunk.substring(0, 100)}...`);
    } else {
        console.warn(`⚠️ ALERTA: La búsqueda RAG no devolvió resultados para la consulta de prueba '${TEST_QUERY}'.`);
        console.warn('   Esto podría significar que el umbral es muy alto o que la ingesta falló.');
    }
}

validateQuality().catch(console.error);