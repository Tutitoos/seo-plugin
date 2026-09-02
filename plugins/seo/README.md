# SEO

Plugin Codex con 54 skills y 31 herramientas MCP. Incluye la orquestadora `/seo full`, 50 Marketing Skills y las integraciones Analytics, Search Console y Business Profile con perfiles conjuntos y credenciales aisladas por servicio y cuenta.

## Auditoría integral

En una tarea nueva, escribe:

```text
/seo full https://example.com proyecto=MiProyecto profileId=mi-perfil
```

También puedes invocarla como `$seo full`. Si omites `profileId`, utilizará el perfil Google predeterminado. El informe se guarda en `.seo-data` mediante las herramientas privadas del plugin e incluye KPIs, datasets diarios/mensuales, gráficas, hallazgos explicados, inventario técnico y hasta 500 páginas auditadas —50 profundas—. Cada página tiene salud, evidencia, métricas disponibles, enlaces, acciones y comparación histórica. Los snapshots completados son inmutables; el tracker de incidencias persiste aparte y permite responsables, fechas, notas y riesgos aceptados.

El dashboard se inicia con `npm run dashboard`. Lee auditorías desde `SEO_PLUGIN_DATA_DIR` o, por defecto, `~/Documents/seo-plugin/.seo-data`.

## Auditorías profundas v4

Después de crear el snapshot global, ejecuta `npm run audit:deep -- --audit=<id>`. El runner reanuda su progreso en `.seo-data/runs/<id>.json`, renderiza hasta 50 páginas en Chrome/Chromium aislado y ejecuta Lighthouse de laboratorio en hasta 10 páginas representativas. Si no hay navegador, conserva el rastreo HTTP y registra el diagnóstico sin inventar cobertura.

Cada auditoría tiene una cuota fija de 512.000.000 bytes (512 MB). Todas las escrituras del snapshot pasan por el gestor de cuota, que calcula el tamaño real con `lstat`, rechaza symlinks y escribe de forma atómica. `get_audit_storage` y el panel inferior del detalle muestran uso, desglose, archivos y espacio disponible. Alcanzar la cuota bloquea la escritura con `audit-storage-limit-exceeded`; no se borran ni comprimen datos existentes.

La API local añade `get_audit_run_status`, `get_audit_changes` y `get_audit_storage`. Los snapshots v1–v3 se siguen leyendo; los nuevos se guardan como v4 con `changes.json`, cobertura por página, idiomas esperados/declarados y diferencias frente al snapshot anterior.
