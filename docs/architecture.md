# Arquitectura

El marketplace contiene un plugin `seo`. Sus skills son planificadores/instrucciones; no conceden permisos por sí mismas. Tres servidores MCP independientes conservan los límites OAuth de Analytics, Search Console y Business Profile. Un cuarto servidor administra perfiles conjuntos, snapshots, hallazgos, inventario, páginas y seguimiento local.

Astro SSR lee el mismo almacén privado. Cada snapshot v3 separa `manifest.json`, `metrics.json`, `findings.json`, `inventory.json`, `diagnostics.json` y `pages/`. Hasta 500 páginas usan un hash estable de su URL normalizada; hasta 50 pueden incorporar métricas y assets profundos. El tracker vive en `projects/<proyecto>/issues.json`, fuera de los snapshots, para que responsables y decisiones sobrevivan entre ejecuciones.

La evidencia es de solo lectura desde la web. La única mutación del dashboard actualiza el tracker y exige host loopback, origen idéntico y un token CSRF ligado a una cookie `SameSite=Strict`.
