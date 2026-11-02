'use strict';

(() => {
  const GPX_NS = 'http://www.topografix.com/GPX/1/1';
  const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const files = [];
  const ui = Object.fromEntries([
    'file-input', 'drop-zone', 'file-list', 'status', 'errors', 'warnings',
    'track-name', 'file-name', 'download', 'map', 'map-summary',
    'stat-files', 'stat-original', 'stat-duplicates', 'stat-final',
    'stat-distance', 'stat-ascent'
  ].map(id => [id, document.getElementById(id)]));
  const number = new Intl.NumberFormat('es-ES');
  const decimal = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
  let merged = { tracks: [], waypoints: [], duplicates: 0 };
  let importQueue = Promise.resolve();
  let nextId = 0;
  let map;
  let layers;

  function child(node, name) {
    return Array.from(node.children).find(element =>
      element.localName === name && element.namespaceURI === node.namespaceURI);
  }

  function parsePoint(node) {
    const latText = node.getAttribute('lat');
    const lonText = node.getAttribute('lon');
    const lat = Number(latText);
    const lon = Number(lonText);
    if (!latText?.trim() || !lonText?.trim() ||
        !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('Un punto tiene coordenadas ausentes o fuera de rango.');
    }
    const time = Date.parse(child(node, 'time')?.textContent.trim() || '');
    const elevationText = child(node, 'ele')?.textContent.trim();
    const elevation = elevationText ? Number(elevationText) : NaN;
    return { node, lat, lon, time, elevation };
  }

  function parseGPX(text) {
    // GPX does not need DTDs or entities. Reject them before parsing untrusted XML.
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
      throw new Error('No se permiten declaraciones DTD ni entidades XML.');
    }
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    let root = doc.documentElement;
    if (doc.getElementsByTagName('parsererror').length || root.localName !== 'gpx') {
      throw new Error('El archivo no contiene un documento GPX válido.');
    }
    if (root.namespaceURI && root.namespaceURI !== GPX_NS) {
      throw new Error('Se necesita GPX 1.1, como el exportado por Garmin Connect.');
    }
    if (!root.namespaceURI) {
      // Normalize namespace-less input once; cloned output points then inherit GPX 1.1.
      root.removeAttribute('xmlns');
      const xml = new XMLSerializer().serializeToString(root)
        .replace(/^<gpx(?=[\s>])/, `<gpx xmlns="${GPX_NS}"`);
      root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
    }
    const points = name => Array.from(
      root.getElementsByTagNameNS(root.namespaceURI, name), parsePoint);
    const tracks = points('trkpt');
    const waypoints = points('wpt');
    if (!tracks.length && !waypoints.length) {
      throw new Error('El archivo no contiene puntos de track ni waypoints.');
    }
    let start = Infinity;
    for (const point of tracks.length ? tracks : waypoints) {
      if (Number.isFinite(point.time)) start = Math.min(start, point.time);
    }
    return { tracks, waypoints, start };
  }

  function deduplicate(points) {
    const unique = new Map();
    let duplicates = 0;
    for (const point of points) {
      // Without a valid timestamp there is no safe temporal identity: retain the point.
      const key = Number.isFinite(point.time)
        ? `${point.time}|${point.lat}|${point.lon}` : point;
      if (unique.has(key)) duplicates++;
      else unique.set(key, point);
    }
    const sorted = [...unique.values()].sort((a, b) => {
      const left = Number.isFinite(a.time) ? a.time : Infinity;
      const right = Number.isFinite(b.time) ? b.time : Infinity;
      return left === right ? 0 : left - right;
    });
    return { points: sorted, duplicates };
  }

  function haversine(a, b) {
    const radians = degrees => degrees * Math.PI / 180;
    const dLat = radians(b.lat - a.lat);
    const dLon = radians(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function render() {
    const tracks = deduplicate(files.flatMap(file => file.tracks));
    const waypoints = deduplicate(files.flatMap(file => file.waypoints));
    merged = {
      tracks: tracks.points, waypoints: waypoints.points,
      duplicates: tracks.duplicates + waypoints.duplicates
    };
    const all = [...merged.tracks, ...merged.waypoints];
    let distance = 0;
    let ascent = 0;
    for (let i = 1; i < merged.tracks.length; i++) {
      const previous = merged.tracks[i - 1];
      const current = merged.tracks[i];
      distance += haversine(previous, current);
      if (Number.isFinite(previous.elevation) && Number.isFinite(current.elevation)) {
        ascent += Math.max(0, current.elevation - previous.elevation);
      }
    }
    ui['stat-files'].textContent = number.format(files.length);
    ui['stat-original'].textContent = number.format(all.length + merged.duplicates);
    ui['stat-duplicates'].textContent = number.format(merged.duplicates);
    ui['stat-final'].textContent = number.format(all.length);
    ui['stat-distance'].textContent = decimal.format(distance / 1000);
    ui['stat-ascent'].textContent = number.format(Math.round(ascent));
    ui.download.disabled = !all.length;
    const untimed = all.filter(point => !Number.isFinite(point.time)).length;
    const missingElevation = merged.tracks.filter(point => !Number.isFinite(point.elevation)).length;
    const warnings = [];
    if (untimed) warnings.push(`${number.format(untimed)} puntos sin fecha válida: se conservan al final, en orden de carga y sin deduplicar.`);
    if (missingElevation) warnings.push('Desnivel parcial: hay puntos sin elevación válida.');
    ui.warnings.textContent = warnings.join(' ');
    ui['map-summary'].textContent = all.length
      ? `${number.format(merged.tracks.length)} puntos de track · ${number.format(merged.waypoints.length)} waypoints.`
      : 'El mapa mostrará el track unificado y los waypoints.';
    renderFiles();
    renderMap();
  }

  function renderFiles() {
    ui['file-list'].replaceChildren();
    for (const file of files) {
      const card = document.createElement('li');
      card.className = 'file-card';
      const info = document.createElement('div');
      info.className = 'file-info';
      const title = document.createElement('p');
      title.className = 'file-title';
      title.textContent = file.name;
      const details = document.createElement('p');
      details.className = 'file-details';
      const start = Number.isFinite(file.start)
        ? new Date(file.start).toLocaleString('es-ES', { timeZoneName: 'short' }) : 'Sin fecha válida';
      details.textContent = `${number.format(file.tracks.length)} trkpt · ${number.format(file.waypoints.length)} wpt · ${start}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Eliminar ${file.name}`);
      remove.addEventListener('click', () => {
        files.splice(files.findIndex(item => item.id === file.id), 1);
        render();
        ui.status.textContent = `${number.format(files.length)} archivos cargados.`;
      });
      info.append(title, details);
      card.append(info, remove);
      ui['file-list'].append(card);
    }
  }

  function setupMap() {
    if (!window.L) {
      ui.map.classList.add('map-unavailable');
      ui.map.textContent = 'No se ha podido cargar el mapa. Puedes seguir uniendo y descargando tus archivos.';
      return;
    }
    map = L.map(ui.map).setView([40.42, -3.7], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    layers = L.featureGroup().addTo(map);
  }

  function renderMap() {
    if (!map) return;
    layers.clearLayers();
    const coordinates = merged.tracks.map(point => [point.lat, point.lon]);
    if (coordinates.length) {
      L.polyline(coordinates, { color: '#38bdf8', weight: 4 }).addTo(layers);
      const marker = (position, type, label, symbol) => {
        L.marker(position, {
          icon: L.divIcon({
            className: '',
            html: `<span class="track-marker ${type}" aria-hidden="true">${symbol}</span>`,
            iconSize: [28, 28], iconAnchor: [14, 14]
          }),
          title: label, alt: label
        }).bindPopup(label).addTo(layers);
      };
      marker(coordinates[0], 'start', 'Inicio del recorrido', '▶');
      marker(coordinates[coordinates.length - 1], 'end', 'Final del recorrido', '■');
    }
    for (const point of merged.waypoints) {
      const label = document.createElement('span');
      label.textContent = child(point.node, 'name')?.textContent || 'Waypoint';
      L.circleMarker([point.lat, point.lon], {
        radius: 5, color: '#a3e635', fillOpacity: 0.8
      }).bindPopup(label).addTo(layers);
    }
    if (layers.getLayers().length) map.fitBounds(layers.getBounds(), { padding: [30, 30], maxZoom: 16 });
    else map.setView([40.42, -3.7], 5);
  }

  function enqueueFiles(selectedFiles) {
    const batch = Array.from(selectedFiles);
    if (!batch.length) return;
    importQueue = importQueue.then(async () => {
      ui.errors.replaceChildren();
      ui['drop-zone'].setAttribute('aria-busy', 'true');
      try {
        for (const file of batch) {
          ui.status.textContent = `Leyendo ${file.name}…`;
          try {
            if (!/\.gpx$/i.test(file.name)) throw new Error('Selecciona un archivo con extensión .gpx.');
            if (file.size > MAX_FILE_SIZE) throw new Error('El archivo supera el límite de 25 MB.');
            const parsed = parseGPX(await file.text());
            files.push({ ...parsed, id: nextId++, name: file.name });
          } catch (error) {
            const item = document.createElement('li');
            item.textContent = `${file.name}: ${error.message}`;
            ui.errors.append(item);
          }
        }
        render();
        ui.status.textContent = `${number.format(files.length)} archivos cargados. Listo para exportar.`;
      } finally {
        ui['drop-zone'].setAttribute('aria-busy', 'false');
      }
    }).catch(() => {
      ui.status.textContent = 'No se pudo actualizar la vista. Vuelve a añadir los archivos o recarga la página.';
    });
  }

  function clonePoint(point, output) {
    const clone = point.node.cloneNode(true);
    // Namespace declarations can live on <gpx>, <trk> or <trkseg>, not on the point.
    const namespaces = new Map();
    for (let node = point.node; node?.nodeType === 1; node = node.parentElement) {
      for (const attribute of node.attributes) {
        if (attribute.namespaceURI === XMLNS_NS && !namespaces.has(attribute.name)) {
          namespaces.set(attribute.name, attribute.value);
        }
      }
    }
    for (const [name, value] of namespaces) clone.setAttributeNS(XMLNS_NS, name, value);
    return output.importNode(clone, true);
  }

  function buildGPX() {
    const output = document.implementation.createDocument(GPX_NS, 'gpx');
    const root = output.documentElement;
    root.setAttribute('version', '1.1');
    root.setAttribute('creator', 'GPX Joiner');
    const append = (parent, name, text) => {
      const element = output.createElementNS(GPX_NS, name);
      if (text !== undefined) element.textContent = text;
      parent.append(element);
      return element;
    };
    const name = ui['track-name'].value.trim() || 'Mi recorrido unificado';
    const metadata = append(root, 'metadata');
    append(metadata, 'name', name);
    const first = [...merged.tracks, ...merged.waypoints]
      .filter(point => Number.isFinite(point.time))
      .reduce((earliest, point) => Math.min(earliest, point.time), Infinity);
    if (Number.isFinite(first)) append(metadata, 'time', new Date(first).toISOString());
    for (const point of merged.waypoints) root.append(clonePoint(point, output));
    if (merged.tracks.length) {
      const track = append(root, 'trk');
      append(track, 'name', name);
      const segment = append(track, 'trkseg');
      for (const point of merged.tracks) segment.append(clonePoint(point, output));
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(output)}\n`;
  }

  ui['file-input'].addEventListener('change', event => {
    enqueueFiles(event.target.files);
    event.target.value = '';
  });
  for (const name of ['dragenter', 'dragover']) {
    ui['drop-zone'].addEventListener(name, event => {
      event.preventDefault();
      ui['drop-zone'].classList.add('dragging');
    });
  }
  ui['drop-zone'].addEventListener('dragleave', event => {
    if (!ui['drop-zone'].contains(event.relatedTarget)) ui['drop-zone'].classList.remove('dragging');
  });
  ui['drop-zone'].addEventListener('drop', event => {
    event.preventDefault();
    ui['drop-zone'].classList.remove('dragging');
    enqueueFiles(event.dataTransfer.files);
  });
  ui.download.addEventListener('click', () => {
    if (!merged.tracks.length && !merged.waypoints.length) return;
    const blob = new Blob([buildGPX()], { type: 'application/gpx+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const base = ui['file-name'].value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
    link.download = `${base.replace(/\.gpx$/i, '') || 'recorrido-unificado'}.gpx`;
    link.href = url;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  setupMap();
  render();
  if (window.lucide) window.lucide.createIcons();
})();
