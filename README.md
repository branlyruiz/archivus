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
