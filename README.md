# gpx-joiner

Aplicación estática para unir GPX de Garmin Connect directamente en el navegador.
No requiere backend, instalación de dependencias ni compilación.

## Uso

1. Abre `index.html` o publica el repositorio en GitHub Pages (Settings → Pages →
   Deploy from a branch → selecciona la rama y la carpeta `/ (root)`).
2. Arrastra uno o varios archivos `.gpx` al panel o selecciónalos con el botón.
3. Revisa los archivos, las estadísticas y el recorrido en el mapa. Puedes eliminar
   archivos antes de descargar.
4. Personaliza el nombre del track y del archivo y pulsa **Descargar GPX Unificado**.

Para servirlo localmente también puedes ejecutar `python -m http.server 8000`
desde la raíz del repositorio y abrir <http://localhost:8000>.

## Fusión y compatibilidad

- Admite GPX 1.1 (Garmin Connect) y GPX sencillos sin namespace, hasta 25 MB por
  archivo. Los archivos inválidos se notifican sin descartar los demás.
- Ordena los puntos cronológicamente y deduplica con un `Map` por timestamp en
  milisegundos, latitud y longitud numéricas. Fechas equivalentes con distintas
  zonas horarias cuentan como la misma fecha. En un duplicado conserva el primer
  nodo completo, según el orden de carga.
- Deduplica `trkpt` y `wpt` por separado. Exporta un único `trk`/`trkseg` y conserva
  los waypoints como `wpt` en la raíz, antes del track.
- Clona los puntos completos y copia sus declaraciones de namespace heredadas.
  Conserva extensiones Garmin de pulso, cadencia, temperatura, potencia y otros
  datos de los puntos; no copia metadatos ni extensiones globales de los archivos.
- Conserva los puntos sin fecha válida al final de cada colección, sin
  deduplicarlos, y muestra una advertencia.
- Los contadores incluyen tracks y waypoints. La distancia Haversine y el
  desnivel positivo solo usan puntos del track final. Son aproximaciones:
  conectan los fragmentos cargados, no corrigen ruido de elevación y omiten
  incrementos de desnivel si falta la elevación en cualquiera de los dos puntos.
- Rechaza coordenadas ausentes/fuera de rango, DTD y entidades XML.

Los GPX se procesan localmente y no se envían a ningún servidor. Se necesita
conexión para Tailwind CSS, Leaflet y Lucide desde CDN y para las teselas de
OpenStreetMap. Las solicitudes de teselas revelan la zona visualizada al proveedor
del mapa. Si Leaflet no está disponible, la fusión y la descarga siguen funcionando.