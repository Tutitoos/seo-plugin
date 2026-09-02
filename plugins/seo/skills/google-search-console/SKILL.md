---
name: google-search-console
description: Consulta propiedades, rendimiento orgánico, indexación y sitemaps de Google Search Console usando el plugin local con OAuth. Úsala cuando el usuario pida datos de Search Console, clics, impresiones, CTR, posición, consultas, páginas, países, dispositivos, estado indexado o sitemaps.
---

# Google Search Console

Usa las herramientas del servidor `google-search-console` para consultar datos reales de la cuenta conectada.

## Conexión

- Si una herramienta indica que falta autenticación, llama a `manage_google_connection` con `action: "connect"`.
- En la primera conexión, incluye `credentialsFile` con la ruta absoluta al JSON de un cliente OAuth de escritorio descargado desde Google Cloud.
- No pidas al usuario que pegue el contenido del JSON, códigos OAuth ni tokens en el chat.
- Usa `action: "status"` para comprobar la sesión y `action: "disconnect"` solo cuando el usuario lo solicite explícitamente.
- Para cambiar de cuenta, conecta con `forceAccountSelection: true`; no sustituyas silenciosamente la cuenta activa.

## Propiedad y consultas

- Empieza con `list_search_console_sites` cuando la propiedad exacta no esté clara.
- Conserva literalmente el `siteUrl` devuelto, incluidos `sc-domain:` o la barra final de una propiedad de prefijo.
- Exige confirmación si hay varias propiedades plausibles y la elección cambia el análisis.
- Para rendimiento, usa dimensiones y filtros mínimos. Pagina con `nextStartRow` solo cuando haga falta.
- Explica que CTR se devuelve entre 0 y 1 y que posición es un promedio.

## Límites

- Todas las consultas de Search Console son de solo lectura.
- `inspect_search_console_url` consulta la versión indexada por Google; no es una prueba en vivo y no solicita indexación.
- No confundas ausencia de filas con un error: puede no haber datos para el periodo o filtros elegidos.
- Distingue claramente datos obtenidos, inferencias y recomendaciones SEO.
