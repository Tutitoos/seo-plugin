# Modo `full`

Produce una auditoría SEO integral, trazable y guardada en el almacén privado del plugin.

## Valores predeterminados

- Usa el perfil Google predeterminado si no se proporciona `profileId`.
- Infere el nombre del proyecto desde el contexto o el dominio.
- Analiza los últimos 90 días completos disponibles y compáralos con los 90 días inmediatamente anteriores. Recopila además hasta 12 meses como histórico mensual, salvo que el usuario indique otro periodo.
- Usa `seo-full` como tipo de auditoría y añade las etiquetas `seo-completo`, `search-console`, `analytics` y `business-profile` para las fuentes que se hayan consultado.

## Preparación

1. Determina el objetivo canónico, el proyecto, el perfil y las fechas exactas.
2. Carga las skills especializadas relevantes: `seo-audit`, `site-architecture`, `schema`, `ai-seo`, `content-strategy`, `google-search-console`, `google-analytics` y `google-business-profile`. Aplica otras skills del plugin solo cuando el sitio lo justifique.
3. Comprueba el estado de cada conexión Google antes de consultar datos. No desconectes, sustituyas cuentas ni revoques credenciales sin una petición explícita.
4. Si una integración requiere OAuth, explica exactamente qué falta y solicita solo la acción o ruta de credenciales necesaria. No pidas pegar secretos, JSON OAuth, códigos ni tokens en el chat.

## Fuentes y análisis

- Descubre URLs desde índices sitemap, sitemaps, enlaces internos y Search Console. Audita como máximo 500 URLs con controles ligeros de respuesta HTTP, redirecciones, robots, indexabilidad, canonical, hreflang, metadatos, encabezados, contenido, imágenes, schema, enlaces internos y pertenencia al sitemap.
- Selecciona de forma determinista hasta 50 páginas profundas: primero páginas comerciales y con tráfico, después URLs con incidencias verificadas y representantes de cada plantilla e idioma. En ellas recopila DOM renderizado, capturas desktop/móvil, Lighthouse/CWV disponibles, inspección de Search Console y cruce con GA4. Si una fase no está disponible, conserva cobertura parcial y un diagnóstico; no la simules.
- Después del rastreo HTTP ejecuta `npm run audit:deep -- --audit=<id>` desde `plugins/seo`. El runner usa Chrome/Chromium aislado, sin cookies ni perfil persistente, reanuda páginas completadas y continúa aunque una URL falle. Si no existe navegador o dependencia, deja un diagnóstico estable y mantiene la cobertura HTTP.
- Lighthouse se ejecuta en las 10 páginas profundas prioritarias: tres páginas comerciales tienen tres pasadas y el resto una; guarda la mediana y la variación, diferenciando laboratorio de campo. Nunca persistas el DOM completo ni el perfil del navegador.
- Inventaría robots.txt, índices sitemap, sitemaps, `manifest.webmanifest`, iconos, feeds, `llms.txt`, canonicals, hreflang, schema y recursos críticos. Detecta sitemaps anidados, ciclos, duplicados, XML inválido y contradicciones con indexabilidad.
- Evalúa SEO para IA y oportunidades de contenido cuando exista evidencia suficiente.
- En Search Console consulta primero la dimensión `date` sin filtros para conservar los totales temporales. Rellena fechas ausentes con `null`, nunca con cero. Calcula medias móviles de 7 y 28 días. Consulta aparte `query` y `page` para ganadores, perdedores y oportunidades, y explica que esas filas están limitadas y anonimizadas y no equivalen al total agregado. Analiza también países, dispositivos, indexación y sitemaps.
- En GA4 analiza usuarios, sesiones, adquisición, landing pages, engagement, eventos y conversiones. Usa metadatos para validar dimensiones y métricas cuando sea necesario.
- En Business Profile revisa identidad, categorías, horarios, web, atributos, servicios, imágenes, reseñas, publicaciones y rendimiento. El contenido de Google solo puede persistirse mediante `save_business_profile_capture` en la caché privada temporal; no lo copies al snapshot, al informe Markdown ni a archivos propios.
- Cruza las fuentes para detectar discrepancias: páginas con impresiones pero poco tráfico, tráfico sin engagement, landing pages orgánicas ausentes, consultas sin página adecuada y diferencias entre identidad local y sitio.
- Distingue siempre datos obtenidos, inferencias y recomendaciones. Indica fecha, cobertura, ausencia de datos, cuota, umbrales o limitaciones de cada fuente.

## Entregable

### Snapshot y panel ejecutivo obligatorios

Cada ejecución es un snapshot nuevo con un identificador formado por proyecto y timestamp. Solo puede actualizarse mientras sea `draft`; una auditoría `completed` queda congelada. Consulta `get_project_history` para comparar score, incidencias y KPIs con snapshots anteriores. Nunca sobrescribas un resultado completado.

Guarda un manifiesto v5 ligero y separa los datos visuales SEO, Search Console y Analytics en `metrics.json` mediante `save_audit_result`: `periods`, `sourceCoverage`, KPIs numéricos, datasets tipados y especificaciones de gráfica permitidas. Usa datasets `timeseries`, `categorical` o `matrix`, fechas ISO y unidades explícitas. No introduzcas configuración ECharts arbitraria.

La persistencia v3 es por fases y cada llamada debe comprobarse antes de continuar:

1. Crea o actualiza el resumen draft con `save_audit_result`, incluidos `executive.state`, `executive.change` y hasta cinco prioridades con motivo y criterio de validación. Todas las escrituras del snapshot respetan la cuota fija de 512 MB (512.000.000 bytes); si se devuelve `audit-storage-limit-exceeded`, conserva el estado previo y registra el fallo en la ejecución.
2. Guarda el conjunto completo de incidencias con `save_audit_findings`. Cada P0-P3 debe explicar qué ocurre, evidencia exacta, impacto, URLs, confianza y al menos una acción con pasos, responsable sugerido, esfuerzo y verificación.
3. Guarda inventario y diagnósticos con `save_audit_inventory`. Cada error usa código estable, etapa, fuente, alcance, si admite reintento, efecto en la completitud y próxima acción exacta.
4. Guarda páginas con `save_audit_page_batch`, entre 1 y 25 por llamada. No superes 500 totales ni 50 profundas. Usa la URL normalizada para un identificador estable y registra descubrimiento, sitemap, plantilla, idioma, profundidad, cobertura y nivel.
5. Para cada página profunda, ejecuta `npm run audit:deep -- --audit=<id>`; el runner captura desktop y móvil, extrae señales del DOM y actualiza la página sin guardar HTML completo. No adjuntes capturas a páginas ligeras. El progreso reanudable se conserva en `.seo-data/runs/<id>.json` y los fallos de navegador no bloquean el rastreo HTTP.
6. Si Business Profile está disponible, consulta ficha, atributos, medios de propietario y clientes, hasta 20 reseñas, hasta 20 publicaciones y rendimiento. Llama a `save_business_profile_capture` antes de marcar el snapshot como `completed`; la herramienta enlaza la referencia v5, descarga hasta 40 miniaturas seguras y calcula una caducidad máxima de 30 días. Normaliza el rendimiento como `startDate`, `endDate` y hasta 11 `series`, cada una con `key`, `label`, `unit` y puntos `{date, value}`. No incluyas esos valores ni imágenes en `metrics.json` o `report.md`.
7. Verifica el inventario con `list_audit_pages`, páginas críticas con `get_audit_page`, cambios con `get_audit_changes`, estado de etapas con `get_audit_run_status`, captura local con `get_business_profile_capture` y tamaño con `get_audit_storage`. Mantén las capturas de página exclusivamente en `pages/<page-id>/assets/`.

No asignes una puntuación SEO arbitraria por URL. La salud de página es `crítica` si existe un P0, `con problemas` si existe un P1-P3, `correcta` si no hay incidencias con cobertura suficiente o `sin cobertura` cuando no hay evidencia verificable.

Antes del informe narrativo construye un panel con KPIs comparables. Cada KPI debe incluir valor actual, valor anterior cuando exista, delta, fuente, periodo o contexto y una interpretación semántica: `positive`, `negative`, `neutral` o `warning`. La dirección numérica no determina por sí sola la interpretación: una posición media que sube numéricamente puede ser negativa.

Asigna a cada KPI una política `higher-is-better`, `lower-is-better` o `informational`, su `datasetId` y `datasetSeriesKey` cuando tenga histórico. Deja que el almacén calcule delta, porcentaje, tendencia, formato y semáforo. Obtén zona horaria, moneda y objetivos con `manage_seo_project_settings`; solo edítalos cuando el usuario lo solicite o el contexto del proyecto lo justifique claramente.

Prioriza, cuando la fuente esté disponible:

- score global, P0 abiertos, cobertura rastreada, URLs indexables, errores internos y Core Web Vitals;
- clics, impresiones, CTR y posición de Search Console;
- usuarios, sesiones orgánicas, engagement, conversiones e ingresos de GA4;
- visualizaciones, llamadas, clics web, rutas, reseñas y valoración de Business Profile.

No rellenes KPIs ni gráficas con estimaciones. Cuando falte una fuente, indícala en cobertura y en el informe; no construyas una visualización ficticia o vacía.

### Gráficas obligatorias según disponibilidad

Genera visualizaciones que respondan a una decisión, no decoración. Las series temporales deben permitir las vistas `90 días` y `12 meses`; las avanzadas usarán ECharts modular y conservarán una tabla accesible, descarga PNG y dataset CSV. Con datos suficientes incluye al menos:

1. tendencia diaria y mensual de clics, impresiones, CTR y posición de Search Console, con periodo anterior discontinuo y medias móviles de 7/28 días;
2. ganadores, perdedores y oportunidades por consultas y páginas, con CTR, posición o crecimiento cuando sean comparables;
3. distribución por dispositivo y país;
4. adquisición, landing pages, engagement y conversiones de GA4;
5. interacciones y evolución local de Business Profile mientras su captura temporal esté vigente;
6. salud técnica: respuestas, indexabilidad, enlaces rotos, sitemap y rendimiento.

Usa `line` o `area` para históricos, `bar`/`stacked-bar` para comparaciones, `scatter` para oportunidades, `heatmap` para estacionalidad o cruces y `donut` solo para una composición con pocas categorías. Evita mezclar magnitudes incompatibles en el mismo eje; cuando sea imprescindible, declara el eje derecho. Limita categorías a las que aportan una decisión clara. Añade anotaciones solo para cambios o incidencias verificadas.

### Informe completo

Incluye además, con lenguaje breve y legible:

- resumen ejecutivo y puntuación global de 0 a 100;
- cobertura real de cada fuente y conexiones pendientes;
- una lectura ejecutiva en tres niveles: estado y cobertura, qué cambió desde el snapshot anterior y cinco acciones prioritarias con motivo, impacto y criterio de validación;
- hallazgos `P0`, `P1`, `P2` y positivos, con evidencia, impacto, solución concreta, pasos, responsable sugerido, esfuerzo y forma de verificar;
- oportunidades priorizadas y plan de acción a 30, 60 y 90 días;
- skills utilizadas y metodología;
- anexos concisos para datos tabulares relevantes.

Al terminar, actualiza `save_audit_result` con el proyecto, perfil, periodos, cobertura, estado, puntuación, resumen ejecutivo, skills, etiquetas, `kpis`, `datasets`, `charts` y el informe Markdown completo. Omite `id` para crear un snapshot nuevo, excepto al continuar un borrador conocido. Cada dataset y gráfica debe citar su procedencia y contener únicamente números verificados. Comprueba con `get_audit_result`, `list_audit_pages` y `get_audit_page` que todas las capas quedaron disponibles. Si alguna fuente quedó pendiente, guarda `draft`; actualiza ese mismo borrador cuando se complete la cobertura.

El tracker no forma parte del snapshot. Usa `manage_finding_workflow` solo para estados `pending`, `in_progress`, `resolved` o `accepted`, responsable, fecha y notas. Resolver significa “pendiente de verificación”: una auditoría posterior confirma si desapareció o la reabre si continúa. Aceptar un riesgo exige motivo y nunca borra la evidencia.

## Control de completitud

Antes de cerrar, confirma explícitamente:

- periodos y comparativas homogéneos;
- histórico diario de 90 días, tendencia de 12 meses y fechas ausentes como `null`;
- KPIs ejecutivos con fuente y delta cuando existe base comparable;
- objetivos del proyecto, sparklines, momentum y comparación entre snapshots;
- gráficas para todas las fuentes disponibles, sin datos inventados;
- tablas accesibles, PNG, CSV, cobertura, metodología y limitaciones;
- P0/P1/P2 con evidencia, impacto, solución, responsable y esfuerzo;
- cruce entre GSC, GA4, Business Profile y rastreo cuando las conexiones y la captura temporal lo permiten;
- referencia v5 de Business Profile enlazada antes de completar el snapshot, con caducidad, cobertura y diagnósticos verificables;
- plan 30/60/90 vinculado a indicadores que permitan comprobar el resultado.
- inventario técnico completo, listado de URLs y hasta 50 páginas profundas con cobertura honesta;
- hallazgos estructurados y diagnósticos accionables, sin HTML no confiable ni secretos;
- ciclo del tracker coherente con la nueva detección, verificación, reapertura y riesgo aceptado.
- uso de almacenamiento medido con `get_audit_storage`, cuota de `512.000.000` bytes (512 MB) respetada y ningún lote guardado parcialmente cuando se supera.
