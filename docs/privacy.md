# Privacidad

Las auditorías, capturas, perfiles y seguimiento se almacenan exclusivamente en `.seo-data/`, fuera del control de versiones. Los refresh tokens y clientes OAuth se almacenan en el Llavero de macOS, no en archivos del repositorio. El dashboard enlaza únicamente con `127.0.0.1`; sus snapshots son de solo lectura y la única ruta de escritura actualiza el tracker local con validación de origen y CSRF.
