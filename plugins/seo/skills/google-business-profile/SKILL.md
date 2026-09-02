---
name: google-business-profile
description: Consulta cuentas, fichas, horarios, reseñas y métricas de Google Business Profile usando OAuth local. Úsala cuando el usuario pida datos de Google Business Profile, Perfil de Empresa, Google Maps local, reseñas, llamadas, clics web, solicitudes de ruta o visibilidad local.
---

# Google Business Profile

Usa las herramientas del servidor `google-business-profile` para consultar datos reales de la cuenta conectada.

## Conexión y cuenta

- Si falta autenticación, llama a `manage_business_profile_connection` con `action: "connect"`.
- En la primera conexión, incluye `credentialsFile` con la ruta absoluta al JSON de un cliente OAuth de escritorio.
- Para TaxiPrime, usa `preferredAccountEmail: "admin@taxisabadell.online"`. El plugin rechazará otra cuenta y no guardará su sesión.
- El selector de Google puede mostrar varias cuentas; no asumas que la sesión activa del navegador es la correcta.
- Usa `action: "status"` para comprobar el correo realmente conectado.
- Usa `forceAccountSelection: true` solo cuando el usuario pida sustituir una cuenta ya conectada.
- Desconecta únicamente cuando el usuario lo solicite explícitamente.
- Nunca pidas que pegue el JSON, un código OAuth o un token en el chat.

## Selección de ficha

- Empieza con `list_business_profile_accounts` y después `list_business_profile_locations` si la cuenta o ubicación exacta no está clara.
- Conserva literalmente los identificadores `accounts/{id}` y `locations/{id}` devueltos por Google.
- Usa `accounts/-` para descubrir ubicaciones administradas indirectamente; para reseñas usa la cuenta numérica propietaria junto con la ubicación.
- Si hay varias fichas plausibles, muestra nombre, dirección y estado y pide elegir antes de comparar o diagnosticar.

## Lectura y análisis

- Usa `get_business_profile_location` para auditar identidad, categorías, teléfonos, web, dirección, horarios, área de servicio y estado de apertura.
- Pagina reseñas con `nextPageToken` solo cuando el análisis necesite más resultados. Distingue texto del cliente, respuesta del propietario e inferencias.
- Para rendimiento exige ubicación, intervalo y métricas. No confundas impresiones con usuarios únicos fuera de la definición concreta de Google.
- Distingue datos obtenidos de la API, inferencias y recomendaciones de SEO local.

## Límites

- Todas las herramientas de negocio son de solo lectura, aunque Google obligue a conceder `business.manage`.
- No respondas reseñas, no edites fichas y no publiques contenido con este plugin.
- Un `403` puede indicar falta de acceso de la cuenta a la ficha, APIs no habilitadas o proyecto todavía sin aprobación/cuota.
- Las reseñas solo se pueden listar para ubicaciones verificadas.
- No caches ni guardes en archivos el contenido devuelto por Google Business Profile.
