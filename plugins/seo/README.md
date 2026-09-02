# SEO

Plugin Codex con 54 skills y 22 herramientas MCP. Incluye la orquestadora `/seo full`, 50 Marketing Skills y las integraciones Analytics, Search Console y Business Profile con perfiles conjuntos y credenciales aisladas por servicio y cuenta.

## Auditoría integral

En una tarea nueva, escribe:

```text
/seo full https://example.com proyecto=MiProyecto profileId=mi-perfil
```

También puedes invocarla como `$seo full`. Si omites `profileId`, utilizará el perfil Google predeterminado. El informe se guarda en `.seo-data` mediante las herramientas privadas del plugin e incluye KPIs, datasets diarios/mensuales y gráficas estructuradas que el dashboard representa sin ejecutar contenido del informe. Los snapshots completados son inmutables; los borradores pueden ampliarse cuando una fuente pendiente vuelva a estar disponible.

El dashboard se inicia con `npm run dashboard`. Lee auditorías desde `SEO_PLUGIN_DATA_DIR` o, por defecto, `~/Documents/seo-plugin/.seo-data`.
