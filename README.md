# SEO Plugin

Plugin público para Codex que reúne 50 Marketing Skills y tres integraciones Google de solo lectura: Analytics, Search Console y Business Profile. Incluye perfiles multi-account y un dashboard Astro local para consultar auditorías privadas.

## Instalación local

```bash
codex plugin marketplace add /Users/gtrave/Documents/seo-plugin
codex plugin add seo@seo-marketplace
cd /Users/gtrave/Documents/seo-plugin/plugins/seo
npm install
npm run dashboard
```

El dashboard solo escucha en `http://127.0.0.1:4321`. Los resultados se guardan en `.seo-data/`, que está excluido completamente de Git.

## Instalación desde GitHub

```bash
codex plugin marketplace add Tutitoos/seo-plugin --ref main
codex plugin add seo@seo-marketplace
```

Por defecto, los datos privados se guardan en `~/Documents/seo-plugin/.seo-data`. Se puede cambiar la ubicación con `SEO_PLUGIN_DATA_DIR`.

## Origen de las skills

Las 50 Marketing Skills proceden de `coreyhaines31/marketingskills`, snapshot `d4ff28a9c8d56c06809860bf2800d4f5224b52db` (MIT). Consulta [UPSTREAM.md](UPSTREAM.md).

## Seguridad

- Los tokens OAuth permanecen en el Llavero de macOS.
- Las APIs Google se usan en modo lectura; Business Profile requiere el scope de Google `business.manage`, aunque las herramientas expuestas no escriben.
- El dashboard es de solo lectura y no se publica.
- El único almacenamiento modificable por el plugin es `.seo-data/`.
