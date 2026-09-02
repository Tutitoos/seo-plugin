# Arquitectura

El marketplace contiene un plugin `seo`. Sus skills son planificadores/instrucciones; no conceden permisos por sí mismas. Tres servidores MCP independientes conservan los límites OAuth de Analytics, Search Console y Business Profile. Un cuarto servidor administra perfiles conjuntos y resultados locales. Astro SSR lee el mismo almacén privado para presentar auditorías, skills y accesos.
