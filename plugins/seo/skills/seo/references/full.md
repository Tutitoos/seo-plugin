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

- Audita rastreo, respuestas HTTP, robots, sitemap, canonicals, redirecciones, indexabilidad, metadatos, encabezados, contenido, imágenes, enlazado interno, arquitectura, datos estructurados, rendimiento y experiencia móvil.
- Evalúa SEO para IA y oportunidades de contenido cuando exista evidencia suficiente.
- En Search Console consulta primero la dimensión `date` sin filtros para conservar los totales temporales. Rellena fechas ausentes con `null`, nunca con cero. Calcula medias móviles de 7 y 28 días. Consulta aparte `query` y `page` para ganadores, perdedores y oportunidades, y explica que esas filas están limitadas y anonimizadas y no equivalen al total agregado. Analiza también países, dispositivos, indexación y sitemaps.
- En GA4 analiza usuarios, sesiones, adquisición, landing pages, engagement, eventos y conversiones. Usa metadatos para validar dimensiones y métricas cuando sea necesario.
- En Business Profile revisa identidad, categorías, horarios, web, estado, reseñas y rendimiento disponible. No guardes texto íntegro de reseñas ni respuestas de la API; conserva únicamente métricas, evidencia mínima y conclusiones agregadas.
- Cruza las fuentes para detectar discrepancias: páginas con impresiones pero poco tráfico, tráfico sin engagement, landing pages orgánicas ausentes, consultas sin página adecuada y diferencias entre identidad local y sitio.
- Distingue siempre datos obtenidos, inferencias y recomendaciones. Indica fecha, cobertura, ausencia de datos, cuota, umbrales o limitaciones de cada fuente.

## Entregable

### Snapshot y panel ejecutivo obligatorios

Cada ejecución es un snapshot nuevo con un identificador formado por proyecto y timestamp. Solo puede actualizarse mientras sea `draft`; una auditoría `completed` queda congelada. Consulta `get_project_history` para comparar score, incidencias y KPIs con snapshots anteriores. Nunca sobrescribas un resultado completado.

Guarda un manifiesto v2 ligero y separa los datos visuales en `metrics.json` mediante `save_audit_result`: `periods`, `sourceCoverage`, KPIs numéricos, datasets tipados y especificaciones de gráfica permitidas. Usa datasets `timeseries`, `categorical` o `matrix`, fechas ISO y unidades explícitas. No introduzcas configuración ECharts arbitraria.

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
5. interacciones y evolución local de Business Profile;
6. salud técnica: respuestas, indexabilidad, enlaces rotos, sitemap y rendimiento.

Usa `line` o `area` para históricos, `bar`/`stacked-bar` para comparaciones, `scatter` para oportunidades, `heatmap` para estacionalidad o cruces y `donut` solo para una composición con pocas categorías. Evita mezclar magnitudes incompatibles en el mismo eje; cuando sea imprescindible, declara el eje derecho. Limita categorías a las que aportan una decisión clara. Añade anotaciones solo para cambios o incidencias verificadas.

### Informe completo

Incluye además:

- resumen ejecutivo y puntuación global de 0 a 100;
- cobertura real de cada fuente y conexiones pendientes;
- hallazgos `P0`, `P1`, `P2` y positivos, con evidencia, impacto, solución concreta, responsable sugerido y esfuerzo;
- oportunidades priorizadas y plan de acción a 30, 60 y 90 días;
- skills utilizadas y metodología;
- anexos concisos para datos tabulares relevantes.

Al terminar, llama a `save_audit_result`. Usa el proyecto, perfil, periodos primario/comparativo/histórico, cobertura, estado, puntuación, resumen, skills, etiquetas, `kpis`, `datasets`, `charts` y el informe Markdown completo. Omite `id` para que el almacén cree el snapshot con timestamp, excepto al continuar un borrador conocido. Los identificadores deben usar solo minúsculas, números y guiones. Cada dataset y gráfica debe citar su procedencia y contener únicamente números verificados. Comprueba después con `get_audit_result` que el resultado y `metrics.json` quedaron disponibles. Si alguna fuente quedó pendiente, guarda `draft`; actualiza ese mismo borrador cuando se complete la cobertura.

## Control de completitud

Antes de cerrar, confirma explícitamente:

- periodos y comparativas homogéneos;
- histórico diario de 90 días, tendencia de 12 meses y fechas ausentes como `null`;
- KPIs ejecutivos con fuente y delta cuando existe base comparable;
- objetivos del proyecto, sparklines, momentum y comparación entre snapshots;
- gráficas para todas las fuentes disponibles, sin datos inventados;
- tablas accesibles, PNG, CSV, cobertura, metodología y limitaciones;
- P0/P1/P2 con evidencia, impacto, solución, responsable y esfuerzo;
- cruce entre GSC, GA4, Business Profile y rastreo cuando las conexiones lo permiten;
- plan 30/60/90 vinculado a indicadores que permitan comprobar el resultado.
