# Privacidad

Las auditorías, capturas, perfiles y seguimiento se almacenan exclusivamente en `.seo-data/`, fuera del control de versiones. Cada snapshot tiene una cuota fija de 512.000.000 bytes (512 MB) y las escrituras se comprueban y renuevan atómicamente sin seguir enlaces simbólicos. Los refresh tokens y clientes OAuth se almacenan en el Llavero de macOS, no en archivos del repositorio. El dashboard enlaza únicamente con `127.0.0.1`; sus snapshots son de solo lectura y la única ruta de escritura actualiza el tracker local con validación de origen y CSRF.
