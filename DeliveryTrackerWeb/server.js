// server.js - Servidor Web, Sesiones, Geocodificación y SQL
const express = require('express');
const session = require('express-session');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'delivery_tracker.sqlite');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: 'delivery-tracker-utc-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 4 },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

let db;

function guardarBD() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function consultarSQL(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const filas = [];
  while (stmt.step()) {
    filas.push(stmt.getAsObject());
  }
  stmt.free();
  return filas;
}

// Consulta gratuita a OpenStreetMap (Nominatim) para convertir dirección en coordenadas
function consultarNominatim(query) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&q=${encodeURIComponent(query)}`;
    const opciones = {
      headers: { 'User-Agent': 'DeliveryTrackerProyectoUTC/1.0' },
    };

    https
      .get(url, opciones, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (json && json.length > 0) {
              resolve({
                lat: parseFloat(json[0].lat),
                lon: parseFloat(json[0].lon),
                display: json[0].display_name,
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

// Geocodificación escalonada (intenta calle exacta -> luego CP/ciudad -> luego ciudad)
async function geocodificarDireccion({ calle, colonia, codigoPostal, ciudad, estadoGeo }) {
  const intentos = [
    `${calle}, ${colonia}, ${codigoPostal} ${ciudad}, ${estadoGeo}, México`,
    `${calle}, ${ciudad}, ${estadoGeo}, México`,
    `${codigoPostal}, ${ciudad}, ${estadoGeo}, México`,
    `${ciudad}, ${estadoGeo}, México`,
  ];

  for (const consulta of intentos) {
    if (consulta.replace(/[, ]/g, '').length > 6) {
      const resultado = await consultarNominatim(consulta);
      if (resultado) return resultado;
    }
  }

  // Coordenadas por defecto (Calvillo / Aguascalientes) si no hay internet
  return { lat: 21.8469, lon: -102.7188, display: 'Ubicación aproximada por defecto' };
}

async function iniciarBaseDeDatos() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS paquetes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idPaquete TEXT UNIQUE NOT NULL,
      cliente TEXT NOT NULL,
      telefono TEXT,
      calle TEXT DEFAULT '',
      colonia TEXT DEFAULT '',
      codigoPostal TEXT DEFAULT '',
      ciudad TEXT DEFAULT '',
      estadoGeo TEXT DEFAULT '',
      direccion TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      unidad TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'En Ruta',
      reporteIncidencia TEXT DEFAULT '',
      fechaActualizacion TEXT
    );
  `);

  // Migración segura por si ya existía la tabla anterior
  const nuevasColumnas = ['calle', 'colonia', 'codigoPostal', 'ciudad', 'estadoGeo'];
  for (const col of nuevasColumnas) {
    try {
      db.run(`ALTER TABLE paquetes ADD COLUMN ${col} TEXT DEFAULT ''`);
    } catch (e) {}
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS telemetria_gps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      latitud REAL,
      longitud REAL,
      precision REAL,
      evento TEXT,
      fecha TEXT
    );
  `);

  const existeAdmin = consultarSQL("SELECT id FROM usuarios WHERE usuario = 'admin'");
  if (existeAdmin.length === 0) {
    db.run(
      "INSERT INTO usuarios (usuario, password, nombre, rol) VALUES ('admin', '1234', 'Encargado de Logística', 'Administrador')"
    );
  }

  guardarBD();
}

function requiereSesion(req, res, next) {
  if (req.session && req.session.usuario) return next();
  return res.status(401).json({ exito: false, mensaje: 'No autorizado.' });
}

// =====================================================================
// SESIONES
// =====================================================================
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  const filas = consultarSQL(
    'SELECT id, usuario, nombre, rol FROM usuarios WHERE usuario = ? AND password = ?',
    [usuario, password]
  );
  if (filas.length > 0) {
    req.session.usuario = filas[0];
    return res.json({ exito: true, usuario: filas[0] });
  }
  return res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ exito: true });
});

app.get('/api/sesion', (req, res) => {
  if (req.session && req.session.usuario) {
    return res.json({ autenticado: true, usuario: req.session.usuario });
  }
  return res.json({ autenticado: false });
});

// =====================================================================
// GEOCODIFICACIÓN Y CRUD SQL WEB
// =====================================================================
app.post('/api/admin/geocodificar', requiereSesion, async (req, res) => {
  const coords = await geocodificarDireccion(req.body);
  res.json({ exito: true, ...coords });
});

app.get('/api/admin/datos', requiereSesion, (req, res) => {
  const paquetes = consultarSQL('SELECT * FROM paquetes ORDER BY id DESC');
  const gps = consultarSQL('SELECT * FROM telemetria_gps ORDER BY id DESC LIMIT 1');
  res.json({ exito: true, paquetes, ultimoGps: gps[0] || null });
});

app.post('/api/admin/paquetes', requiereSesion, async (req, res) => {
  const { idPaquete, cliente, telefono, calle, colonia, codigoPostal, ciudad, estadoGeo, unidad } = req.body;
  if (!idPaquete || !cliente || !calle || !ciudad) {
    return res.status(400).json({ exito: false, mensaje: 'CompletaTracking, Cliente, Calle y Ciudad.' });
  }

  const direccionCompleta = `${calle.trim()}, Col. ${(colonia || 'Centro').trim()}, C.P. ${(codigoPostal || '').trim()}, ${ciudad.trim()}, ${(estadoGeo || 'Aguascalientes').trim()}`;

  // Obtener coordenadas automáticamente si no vienen definidas
  let lat = parseFloat(req.body.lat);
  let lon = parseFloat(req.body.lon);
  if (isNaN(lat) || isNaN(lon)) {
    const geo = await geocodificarDireccion({ calle, colonia, codigoPostal, ciudad, estadoGeo });
    lat = geo.lat;
    lon = geo.lon;
  }

  try {
    const ahora = new Date().toLocaleString('es-MX');
    db.run(
      `INSERT INTO paquetes (idPaquete, cliente, telefono, calle, colonia, codigoPostal, ciudad, estadoGeo, direccion, lat, lon, unidad, estado, reporteIncidencia, fechaActualizacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'En Ruta', '', ?)`,
      [
        idPaquete.trim().toUpperCase(),
        cliente.trim(),
        (telefono || 'Sin teléfono').trim(),
        calle.trim(),
        (colonia || '').trim(),
        (codigoPostal || '').trim(),
        ciudad.trim(),
        (estadoGeo || 'Aguascalientes').trim(),
        direccionCompleta,
        lat,
        lon,
        (unidad || 'UNIDAD-01').trim().toUpperCase(),
        ahora,
      ]
    );
    guardarBD();
    res.json({ exito: true, mensaje: 'Ruta asignada y enviada al repartidor.' });
  } catch (err) {
    res.status(400).json({ exito: false, mensaje: 'Ese Tracking ID ya existe.' });
  }
});

app.post('/api/admin/paquetes/editar/:id', requiereSesion, async (req, res) => {
  const { id } = req.params;
  const { cliente, telefono, calle, colonia, codigoPostal, ciudad, estadoGeo, unidad, estado } = req.body;
  const direccionCompleta = `${calle.trim()}, Col. ${(colonia || '').trim()}, C.P. ${(codigoPostal || '').trim()}, ${ciudad.trim()}, ${(estadoGeo || '').trim()}`;

  const geo = await geocodificarDireccion({ calle, colonia, codigoPostal, ciudad, estadoGeo });
  const ahora = new Date().toLocaleString('es-MX');

  db.run(
    `UPDATE paquetes
     SET cliente = ?, telefono = ?, calle = ?, colonia = ?, codigoPostal = ?, ciudad = ?, estadoGeo = ?, direccion = ?, lat = ?, lon = ?, unidad = ?, estado = ?, fechaActualizacion = ?
     WHERE id = ?`,
    [cliente, telefono, calle, colonia, codigoPostal, ciudad, estadoGeo, direccionCompleta, geo.lat, geo.lon, unidad, estado, ahora, id]
  );
  guardarBD();
  res.json({ exito: true });
});

app.post('/api/admin/paquetes/eliminar/:id', requiereSesion, (req, res) => {
  db.run('DELETE FROM paquetes WHERE id = ?', [req.params.id]);
  guardarBD();
  res.json({ exito: true });
});

// =====================================================================
// API MÓVIL (GET / POST)
// =====================================================================
app.get('/api/movil/paquetes', (req, res) => {
  const paquetes = consultarSQL('SELECT * FROM paquetes ORDER BY id ASC');
  res.json({ exito: true, paquetes });
});

app.post('/api/movil/sincronizar', (req, res) => {
  const payload = req.body;
  const ahora = new Date().toLocaleString('es-MX');

  if (payload.tipo === 'telemetria_gps' && payload.latitud) {
    db.run(
      'INSERT INTO telemetria_gps (latitud, longitud, precision, evento, fecha) VALUES (?, ?, ?, ?, ?)',
      [payload.latitud, payload.longitud, payload.precision || 0, 'GPS EN VIVO', ahora]
    );
    guardarBD();
    return res.json({ exito: true, id: Date.now() % 10000 });
  }

  if (['cambio_estado', 'deshacer', 'rehacer'].includes(payload.tipo)) {
    const nuevoEstado = payload.tipo === 'deshacer' ? payload.estadoAnterior : payload.estadoNuevo;
    const reporte =
      nuevoEstado === 'Incidencia' ? (payload.reporteIncidencia || 'Incidencia reportada en ruta') : '';

    db.run(
      'UPDATE paquetes SET estado = ?, reporteIncidencia = ?, fechaActualizacion = ? WHERE idPaquete = ?',
      [nuevoEstado, reporte, ahora, payload.idPaquete]
    );

    if (payload.ubicacion && payload.ubicacion.latitud) {
      db.run(
        'INSERT INTO telemetria_gps (latitud, longitud, precision, evento, fecha) VALUES (?, ?, ?, ?, ?)',
        [
          payload.ubicacion.latitud,
          payload.ubicacion.longitud,
          payload.ubicacion.precision || 0,
          `${payload.idPaquete} -> ${nuevoEstado}`,
          ahora,
        ]
      );
    }

    guardarBD();
    return res.json({ exito: true, id: Date.now() % 10000 });
  }

  res.json({ exito: true, id: Date.now() % 10000 });
});

iniciarBaseDeDatos().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚚 Servidor Delivery Tracker activo en http://localhost:${PORT}`);
  });
});
