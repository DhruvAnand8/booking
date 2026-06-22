const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const express = require('express');

const PORT_HTTP = 8000;
const PORT_HTTPS = 8443;
const DB_FILE = path.join(__dirname, 'db.json');
const CERT_KEY = path.join(__dirname, 'key.pem');
const CERT_CRT = path.join(__dirname, 'cert.pem');

// 1. Auto-generate SSL Certificate if not present (same as parent server)
if (!fs.existsSync(CERT_KEY) || !fs.existsSync(CERT_CRT)) {
  console.log('SSL certificate files missing. Generating self-signed certificate using OpenSSL...');
  try {
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${CERT_KEY}" -out "${CERT_CRT}" -days 365 -nodes -subj "/CN=localhost"`);
    console.log('SSL Certificate generated successfully.');
  } catch (err) {
    console.error('Failed to auto-generate SSL certificate. Make sure openssl is installed.', err.message);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to read database
function readDb() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading DB, returning empty', err);
    return { rooms: [], employees: [], bookings: [], rfidLog: [], rfidState: {}, systemSettings: { globalLockdown: false, gracePeriod: 15 }, auditLogs: [] };
  }
}

// Helper to write database
function writeDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing DB', err);
  }
}

// Helper to write audit log
function addAuditLog(db, action, user, details) {
  const newLog = {
    id: db.auditLogs.length > 0 ? Math.max(...db.auditLogs.map(l => l.id)) + 1 : 1,
    timestamp: new Date().toISOString(),
    action,
    user,
    details
  };
  db.auditLogs.unshift(newLog);
}

// REST API Endpoints

// 1. Get entire state
app.get('/api/state', (req, res) => {
  res.json(readDb());
});

// 2. Booking endpoints
app.post('/api/bookings', (req, res) => {
  const db = readDb();
  const { empId, room, date, start, duration, purpose, status } = req.body;
  
  const newBooking = {
    id: db.bookings.length > 0 ? Math.max(...db.bookings.map(b => b.id)) + 1 : 1,
    empId,
    room,
    date,
    start,
    duration,
    purpose,
    status: status || 'pending',
    checkin: null,
    checkout: null
  };
  
  db.bookings.push(newBooking);
  
  const emp = db.employees.find(e => e.id === empId);
  const empName = emp ? emp.name : 'Unknown';
  addAuditLog(db, 'BOOKING_CREATE', empName, `Requested reservation for ${room} on ${date} at ${start}`);
  
  writeDb(db);
  res.status(201).json(newBooking);
});

app.put('/api/bookings/:id', (req, res) => {
  const db = readDb();
  const bookingId = parseInt(req.params.id);
  const bookingIndex = db.bookings.findIndex(b => b.id === bookingId);
  
  if (bookingIndex === -1) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  
  const updatedBooking = { ...db.bookings[bookingIndex], ...req.body };
  db.bookings[bookingIndex] = updatedBooking;
  
  const actor = req.body.actor || 'System';
  addAuditLog(db, 'BOOKING_UPDATE', actor, `Booking ID ${bookingId} updated status to ${updatedBooking.status}`);
  
  writeDb(db);
  res.json(updatedBooking);
});

app.delete('/api/bookings/:id', (req, res) => {
  const db = readDb();
  const bookingId = parseInt(req.params.id);
  const bookingIndex = db.bookings.findIndex(b => b.id === bookingId);
  
  if (bookingIndex === -1) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  
  const deletedBooking = db.bookings[bookingIndex];
  db.bookings.splice(bookingIndex, 1);
  
  const actor = req.query.actor || 'System';
  addAuditLog(db, 'BOOKING_DELETE', actor, `Cancelled reservation for ${deletedBooking.room} on ${deletedBooking.date}`);
  
  writeDb(db);
  res.json({ success: true });
});

// 3. Room endpoints (Editable by Admin)
app.post('/api/rooms', (req, res) => {
  const db = readDb();
  const { name, capacity, lockStatus } = req.body;
  
  const newRoom = {
    id: 'R' + String(db.rooms.length > 0 ? parseInt(db.rooms[db.rooms.length - 1].id.substring(1)) + 1 : 1).padStart(3, '0'),
    name,
    capacity: parseInt(capacity),
    lockStatus: lockStatus || 'Normal'
  };
  
  db.rooms.push(newRoom);
  
  const actor = req.body.actor || 'Admin';
  addAuditLog(db, 'ROOM_CREATE', actor, `Added new room ${name} with capacity ${capacity}`);
  
  writeDb(db);
  res.status(201).json(newRoom);
});

app.put('/api/rooms/:id', (req, res) => {
  const db = readDb();
  const roomId = req.params.id;
  const roomIndex = db.rooms.findIndex(r => r.id === roomId);
  
  if (roomIndex === -1) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const updatedRoom = { ...db.rooms[roomIndex], ...req.body };
  // Ensure capacity is a number
  if (updatedRoom.capacity) updatedRoom.capacity = parseInt(updatedRoom.capacity);
  db.rooms[roomIndex] = updatedRoom;
  
  const actor = req.body.actor || 'Admin';
  addAuditLog(db, 'ROOM_UPDATE', actor, `Updated room ${updatedRoom.name} details (Lock status: ${updatedRoom.lockStatus})`);
  
  writeDb(db);
  res.json(updatedRoom);
});

app.delete('/api/rooms/:id', (req, res) => {
  const db = readDb();
  const roomId = req.params.id;
  const roomIndex = db.rooms.findIndex(r => r.id === roomId);
  
  if (roomIndex === -1) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const deletedRoom = db.rooms[roomIndex];
  db.rooms.splice(roomIndex, 1);
  
  const actor = req.query.actor || 'Admin';
  addAuditLog(db, 'ROOM_DELETE', actor, `Deleted room ${deletedRoom.name}`);
  
  writeDb(db);
  res.json({ success: true });
});

// 4. Employee endpoints (Editable by Admin)
app.post('/api/employees', (req, res) => {
  const db = readDb();
  const { name, tag, dept, initials, color, textColor, role } = req.body;
  
  const newEmp = {
    id: 'E' + String(db.employees.length > 0 ? parseInt(db.employees[db.employees.length - 1].id.substring(1)) + 1 : 1).padStart(3, '0'),
    name,
    tag,
    dept,
    initials: initials || name.split(' ').map(n => n[0]).join('').toUpperCase(),
    color: color || '#EDE9FE',
    textColor: textColor || '#534AB7',
    role: role || 'employee'
  };
  
  db.employees.push(newEmp);
  
  const actor = req.body.actor || 'Admin';
  addAuditLog(db, 'EMPLOYEE_CREATE', actor, `Registered new employee ${name} with RFID tag ${tag} (${role})`);
  
  writeDb(db);
  res.status(201).json(newEmp);
});

app.put('/api/employees/:id', (req, res) => {
  const db = readDb();
  const empId = req.params.id;
  const empIndex = db.employees.findIndex(e => e.id === empId);
  
  if (empIndex === -1) {
    return res.status(404).json({ error: 'Employee not found' });
  }
  
  const updatedEmp = { ...db.employees[empIndex], ...req.body };
  db.employees[empIndex] = updatedEmp;
  
  const actor = req.body.actor || 'Admin';
  addAuditLog(db, 'EMPLOYEE_UPDATE', actor, `Updated employee ${updatedEmp.name} (Role: ${updatedEmp.role}, Tag: ${updatedEmp.tag})`);
  
  writeDb(db);
  res.json(updatedEmp);
});

app.delete('/api/employees/:id', (req, res) => {
  const db = readDb();
  const empId = req.params.id;
  const empIndex = db.employees.findIndex(e => e.id === empId);
  
  if (empIndex === -1) {
    return res.status(404).json({ error: 'Employee not found' });
  }
  
  const deletedEmp = db.employees[empIndex];
  db.employees.splice(empIndex, 1);
  
  const actor = req.query.actor || 'Admin';
  addAuditLog(db, 'EMPLOYEE_DELETE', actor, `Deregistered employee ${deletedEmp.name}`);
  
  writeDb(db);
  res.json({ success: true });
});

// 5. RFID Scan/Tap endpoint (Simulated access scanner logic)
app.post('/api/rfid/tap', (req, res) => {
  const db = readDb();
  const { tag, room } = req.body;
  const now = new Date();
  const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const dateStr = now.toISOString().split('T')[0];
  
  // Find employee by RFID tag
  const emp = db.employees.find(e => e.tag === tag);
  if (!emp) {
    const errorMsg = `Denied access at ${room}. Reason: Unrecognized RFID card.`;
    const newLog = {
      id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1,
      tag, name: 'Unknown Card', room, event: 'access-denied', time: timeStr, date: dateStr, duration: 'Unknown tag'
    };
    db.rfidLog.unshift(newLog);
    addAuditLog(db, 'ACCESS_DENIED', 'Unknown RFID', `Card tag ${tag} scanned at ${room} - Denied: Card not registered.`);
    writeDb(db);
    return res.status(403).json({ success: false, message: errorMsg, code: 'UNREGISTERED_CARD' });
  }
  
  // Check Global Lockdown
  if (db.systemSettings.globalLockdown) {
    const errorMsg = `Denied access at ${room} for ${emp.name}. Reason: System in Global Lockdown.`;
    const newLog = {
      id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1,
      tag, name: emp.name, room, event: 'access-denied', time: timeStr, date: dateStr, duration: 'System lockdown'
    };
    db.rfidLog.unshift(newLog);
    addAuditLog(db, 'ACCESS_DENIED', emp.name, `Card scanned at ${room} - Denied: Global lockdown active.`);
    writeDb(db);
    return res.status(403).json({ success: false, message: errorMsg, code: 'GLOBAL_LOCKDOWN' });
  }
  
  // Find room and check room-specific lock status
  const rm = db.rooms.find(r => r.name === room);
  if (!rm) {
    return res.status(404).json({ success: false, message: 'Room not found in database.' });
  }
  
  if (rm.lockStatus === 'Locked') {
    const errorMsg = `Denied access at ${room} for ${emp.name}. Reason: Room is administratively locked.`;
    const newLog = {
      id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1,
      tag, name: emp.name, room, event: 'access-denied', time: timeStr, date: dateStr, duration: 'Room locked'
    };
    db.rfidLog.unshift(newLog);
    addAuditLog(db, 'ACCESS_DENIED', emp.name, `Card scanned at ${room} - Denied: Room is manually locked.`);
    writeDb(db);
    return res.status(403).json({ success: false, message: errorMsg, code: 'ROOM_LOCKED' });
  }
  
  const isIn = db.rfidState[tag];
  
  if (rm.lockStatus === 'Force Unlocked' || emp.role === 'admin') {
    // Admin bypass or Room Force Unlocked bypasses booking requirement
    if (!isIn) {
      db.rfidLog.unshift({ id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1, tag, name: emp.name, room, event: 'check-in', time: timeStr, date: dateStr, duration: null });
      db.rfidState[tag] = { room, since: now.getTime() };
      
      // Auto-mark any active approved booking as checked in
      const activeBooking = db.bookings.find(b => b.empId === emp.id && b.room === room && b.status === 'approved' && !b.checkin);
      if (activeBooking) {
        activeBooking.checkin = timeStr;
      }
      
      addAuditLog(db, 'ACCESS_GRANTED', emp.name, `Unlocked ${room} via ${emp.role === 'admin' ? 'Admin Override' : 'Force Unlocked Mode'}`);
      writeDb(db);
      return res.json({ success: true, event: 'check-in', message: `${emp.name} checked in (Override access granted).` });
    } else {
      const durationMs = now.getTime() - db.rfidState[tag].since;
      const durationMin = Math.round(durationMs / 60000);
      const durStr = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}min` : `${durationMin} min`;
      
      db.rfidLog.unshift({ id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1, tag, name: emp.name, room, event: 'check-out', time: timeStr, date: dateStr, duration: durStr });
      delete db.rfidState[tag];
      
      // Auto-mark active booking as checked out
      const activeBooking = db.bookings.find(b => b.empId === emp.id && b.room === room && b.checkin && !b.checkout);
      if (activeBooking) {
        activeBooking.checkout = timeStr;
      }
      
      addAuditLog(db, 'ACCESS_CLOSED', emp.name, `Locked ${room} session closed. Duration: ${durStr}`);
      writeDb(db);
      return res.json({ success: true, event: 'check-out', message: `${emp.name} checked out.` });
    }
  }
  
  // Normal mode: Requires booking check
  // Check if this employee has an approved booking for this room right now (allowing grace period or active session)
  // To keep simulation friendly, we search for any approved, uncompleted booking for today
  const todaysBooking = db.bookings.find(b => b.empId === emp.id && b.room === room && b.date === dateStr && b.status === 'approved');
  
  if (!todaysBooking && !isIn) {
    // Access denied because no booking exists
    const errorMsg = `Denied access at ${room} for ${emp.name}. Reason: No active booking found.`;
    db.rfidLog.unshift({ id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1, tag, name: emp.name, room, event: 'access-denied', time: timeStr, date: dateStr, duration: 'No booking' });
    addAuditLog(db, 'ACCESS_DENIED', emp.name, `Card scanned at ${room} - Denied: No active booking today.`);
    writeDb(db);
    return res.status(403).json({ success: false, message: errorMsg, code: 'NO_BOOKING' });
  }
  
  if (!isIn) {
    // Check-in
    db.rfidLog.unshift({ id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1, tag, name: emp.name, room, event: 'check-in', time: timeStr, date: dateStr, duration: null });
    db.rfidState[tag] = { room, since: now.getTime() };
    
    if (todaysBooking) {
      todaysBooking.checkin = timeStr;
    }
    
    addAuditLog(db, 'ACCESS_GRANTED', emp.name, `RFID scan checked in to ${room} for booking.`);
    writeDb(db);
    res.json({ success: true, event: 'check-in', message: `${emp.name} checked in.` });
  } else {
    // Check-out
    const durationMs = now.getTime() - db.rfidState[tag].since;
    const durationMin = Math.round(durationMs / 60000);
    const durStr = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}min` : `${durationMin} min`;
    
    db.rfidLog.unshift({ id: db.rfidLog.length > 0 ? Math.max(...db.rfidLog.map(l => l.id)) + 1 : 1, tag, name: emp.name, room, event: 'check-out', time: timeStr, date: dateStr, duration: durStr });
    delete db.rfidState[tag];
    
    // Find active booking for checkout
    const activeBooking = db.bookings.find(b => b.empId === emp.id && b.room === room && b.checkin && !b.checkout);
    if (activeBooking) {
      activeBooking.checkout = timeStr;
    }
    
    addAuditLog(db, 'ACCESS_CLOSED', emp.name, `RFID scan checked out of ${room}. Duration: ${durStr}`);
    writeDb(db);
    res.json({ success: true, event: 'check-out', message: `${emp.name} checked out.` });
  }
});

// 6. Settings endpoint
app.post('/api/system/settings', (req, res) => {
  const db = readDb();
  const { globalLockdown, gracePeriod, actor } = req.body;
  
  if (globalLockdown !== undefined) {
    db.systemSettings.globalLockdown = globalLockdown;
    addAuditLog(db, 'LOCKDOWN_TOGGLE', actor || 'Admin', `System Global Lockdown set to: ${globalLockdown}`);
  }
  
  if (gracePeriod !== undefined) {
    db.systemSettings.gracePeriod = parseInt(gracePeriod);
    addAuditLog(db, 'SETTINGS_CHANGE', actor || 'Admin', `System grace period set to ${gracePeriod} minutes`);
  }
  
  writeDb(db);
  res.json({ success: true, settings: db.systemSettings });
});

// Start server listening
try {
  const options = {
    key: fs.readFileSync(CERT_KEY),
    cert: fs.readFileSync(CERT_CRT)
  };
  https.createServer(options, app).listen(PORT_HTTPS, () => {
    console.log(`Secure Server running at: https://localhost:${PORT_HTTPS}/`);
  });
} catch (err) {
  console.error('Error starting HTTPS server, falling back to HTTP only for SSL missing:', err.message);
}

http.createServer(app).listen(PORT_HTTP, () => {
  console.log(`Server running on port ${PORT_HTTP}`);
});
