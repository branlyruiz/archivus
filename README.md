# Archivus

Inventario de discos y carpetas para equipos audiovisuales. Guarda nombres y especificaciones. Las operaciones afectan al catálogo de Archivus.

## Publicación

- Ejecutar `supabase/schema.sql` una vez en el SQL Editor de un proyecto dedicado con Data API activa.
- Aplicar después `supabase/add-disk-color.sql` para habilitar los colores de los discos.
- Completar `docs/config.js` con la URL del proyecto y su clave publicable. Será visible en el navegador.
- Configurar GitHub Pages para publicar `main` desde `/docs`. Mantener la URL, identidad y alcance de la PWA en las actualizaciones. Incrementar la versión de caché en `docs/sw.js` cuando cambien los recursos.
- Verificar altas, ediciones, movimientos y eliminaciones con dos sesiones y registros de prueba.

## Sincronización

El uso diario es directo, sin cuentas ni código. El inventario permite lectura y escritura públicas. La app consulta cambios cada dos segundos mientras está visible, vuelve a consultar al abrir o reconectar y permite consultar la última copia guardada sin conexión. Para escribir hace falta conexión.

Para habilitar archivos e importaciones, aplica también `supabase/add-file-import.sql` después de la migración de color. En **Tus discos → Importar JSON**, selecciona un inventario `archivus.disk-inventory` v1, revisa el destino y confirma. La importación agrega rutas de carpetas y archivos al inventario compartido.

Aplica también `supabase/extend-import-timeout.sql` para que una importación grande pueda completarse en una única transacción.

Aplica `supabase/raise-import-limit.sql` después de la migración anterior para admitir hasta 100.000 rutas por importación.

Aplica después `supabase/add-incremental-sync.sql`. Archivus reutiliza la copia local existente, guarda las siguientes sincronizaciones en IndexedDB y descarga únicamente los cambios desde la última revisión compatible. La primera copia se descarga por páginas y conserva su progreso local.
