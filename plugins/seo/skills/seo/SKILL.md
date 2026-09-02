---
name: seo
description: Orquesta auditorías SEO integrales con KPIs, gráficas, análisis del sitio, Search Console, Google Analytics, Business Profile y las skills especializadas del plugin. Úsala cuando el usuario invoque `/seo full`, `$seo full` o pida una auditoría SEO completa, visual y accionable con datos Google y guardado privado.
---

# SEO

Interpreta la palabra posterior a la invocación como modo. Para `full`, lee y sigue [references/full.md](references/full.md).

Acepta el objetivo en lenguaje natural. Son útiles, pero no obligatorios, una URL o ruta local, el nombre del proyecto, `profileId` y el periodo. Si falta el objetivo y no puede inferirse con seguridad del proyecto actual, pide únicamente la URL o ruta. Si faltan los demás valores, aplica los valores predeterminados del modo.

No presentes una auditoría parcial como completa. Expón integraciones no disponibles, continúa con las fuentes independientes que sí funcionen y reanuda las pendientes después de que el usuario complete cualquier autenticación necesaria.
