---
name: google-analytics
description: Consulta cuentas, propiedades, dimensiones, métricas e informes históricos o en tiempo real de Google Analytics 4 usando OAuth local. Úsala cuando el usuario pida datos de GA4, Analytics, usuarios, sesiones, eventos, conversiones, adquisición, páginas, campañas o tráfico en tiempo real.
---

# Google Analytics

Usa las herramientas del servidor `google-analytics` para consultar datos reales de la cuenta conectada.

## Conexión y propiedad

- Si falta autenticación, llama a `manage_analytics_connection` con `action: "connect"`.
- En la primera conexión incluye `credentialsFile` con la ruta absoluta al JSON de un cliente OAuth de escritorio.
- Para TaxiPrime usa `preferredAccountEmail: "admin@taxisabadell.online"`; el plugin rechazará otra cuenta y no guardará su sesión.
- Usa `action: "status"` para comprobar el correo conectado y `disconnect` solo cuando el usuario lo solicite expresamente.
- Usa `forceAccountSelection: true` únicamente para sustituir una cuenta ya conectada.
- Nunca pidas que peguen en el chat el JSON, un código OAuth o un token.
- Empieza con `list_analytics_properties` si no conoces el identificador. Conserva literalmente `properties/{id}`.

## Informes

- Usa `get_analytics_metadata` cuando no estés seguro del nombre API de una dimensión o métrica.
- En informes históricos solicita solo dimensiones y métricas relevantes, con un periodo explícito. Pagina con `nextOffset` cuando haga falta.
- Para tiempo real usa únicamente dimensiones y métricas compatibles con la API Realtime.
- Conserva tipos y valores tal como los devuelve Google; explica porcentajes, monedas y promedios según los metadatos.
- Señala si la respuesta contiene metadatos de umbral, cuota o muestreo. Ausencia de filas no implica un error.

## Límites

- Todas las herramientas de datos son de solo lectura.
- Este plugin cubre GA4; no Universal Analytics ni Google Tag Manager.
- No crea eventos, conversiones, audiencias, propiedades ni vínculos con otros productos.
- Distingue datos obtenidos de la API, inferencias y recomendaciones.
