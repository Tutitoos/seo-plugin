# Arquitectura

El marketplace contiene un plugin `seo`. Sus skills son planificadores/instrucciones; no conceden permisos por sí mismas. Tres servidores MCP independientes conservan los límites OAuth de Analytics, Search Console y Business Profile. Un cuarto servidor administra perfiles conjuntos, snapshots, hallazgos, inventario, páginas y seguimiento local.

Astro SSR lee el mismo almacén privado. Cada snapshot v4 separa `manifest.json`, `metrics.json`, `findings.json`, `inventory.json`, `diagnostics.json`, `changes.json` y `pages/`. Hasta 500 páginas usan un hash estable de su URL normalizada; hasta 50 pueden incorporar DOM final, capturas y métricas profundas, y hasta 10 reciben Lighthouse de laboratorio. El progreso reanudable vive fuera del snapshot en `runs/<auditoría>.json`. El tracker vive en `projects/<proyecto>/issues.json`, fuera de los snapshots, para que responsables y decisiones sobrevivan entre ejecuciones.

Todas las escrituras de un snapshot pasan por `audit-storage.mjs`: un bloqueo exclusivo por auditoría, cálculo real por `lstat`, proyección incluyendo reemplazos, staging fuera de `audits/<id>` y renombrado atómico. Si el resultado supera 512 MB (512.000.000 bytes) se devuelve `audit-storage-limit-exceeded`, se conserva el snapshot intacto y se registra el fallo en el estado de ejecución.

La evidencia es de solo lectura desde la web. La única mutación del dashboard actualiza el tracker y exige host loopback, origen idéntico y un token CSRF ligado a una cookie `SameSite=Strict`.
