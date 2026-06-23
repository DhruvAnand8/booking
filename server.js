const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const express = require('express');

const PORT_HTTP = process.env.PORT || 8000;
const PORT_HTTPS = 8443;
const DB_FILE = path.join(__dirname, 'db.json');
const CERT_KEY = path.join(__dirname, 'key.pem');
const CERT_CRT = path.join(__dirname, 'cert.pem');

// 1. Auto-generate SSL Certificate if not present (same as parent server)
if (!process.env.PORT && (!fs.existsSync(CERT_KEY) || !fs.existsSync(CERT_CRT))) {
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

// Enable CORS for cross-origin hosting (e.g. GitHub Pages)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
// Middleware to block direct access to sensitive backend files
app.use((req, res, next) => {
  const forbiddenFiles = [
    '/server.js', 
    '/db.json', 
    '/package.json', 
    '/package-lock.json', 
    '/key.pem', 
    '/cert.pem', 
    '/.git',
    '/.gitignore'
  ];
  const urlPath = req.path.toLowerCase();
  if (forbiddenFiles.some(f => urlPath === f || urlPath.startsWith(f + '/'))) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.static(__dirname));

// Helper to read database
// Overlap & Conflict checking helpers
function parseTimeInterval(startStr, durationStr) {
  const [hStr, mStr] = (startStr || '09:00').split(':');
  const startMin = parseInt(hStr) * 60 + parseInt(mStr);
  
  let durationMin = 60; // default 1 hour
  const dLower = (durationStr || '1 hour').toLowerCase();
  if (dLower.includes('minute')) {
    durationMin = parseInt(dLower) || 30;
  } else if (dLower.includes('hour')) {
    const val = parseFloat(dLower);
    durationMin = Math.round(val * 60);
  } else if (dLower.includes('half day')) {
    durationMin = 240; // 4 hours
  } else if (dLower.includes('full day')) {
    durationMin = 480; // 8 hours
  }
  
  return [startMin, startMin + durationMin];
}

function isOverlapping(start1, end1, start2, end2) {
  return start1 < end2 && start2 < end1;
}

function hasConflictingApprovedBooking(bookings, currentBk) {
  const [currentStart, currentEnd] = parseTimeInterval(currentBk.start, currentBk.duration);
  return bookings.some(b => {
    if (b.id === currentBk.id) return false;
    if (b.room !== currentBk.room || b.date !== currentBk.date || b.status !== 'approved') {
      return false;
    }
    const [existingStart, existingEnd] = parseTimeInterval(b.start, b.duration);
    return isOverlapping(existingStart, existingEnd, currentStart, currentEnd);
  });
}

function hasConflict(bookings, newBk, excludeId = null) {
  if (newBk.status === 'rejected') return null;
  
  const [newStart, newEnd] = parseTimeInterval(newBk.start, newBk.duration);
  
  return bookings.find(b => {
    if (b.id === excludeId) return false;
    if (b.room !== newBk.room || b.date !== newBk.date || b.status === 'rejected') {
      return false;
    }
    const [existingStart, existingEnd] = parseTimeInterval(b.start, b.duration);
    return isOverlapping(existingStart, existingEnd, newStart, newEnd);
  });
}

// Helper to read database
function readDb() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(data);
    
    // Check auto-approvals for bookings waiting for approval
    // starting 30 mins before scheduled time if room is available
    let dbChanged = false;
    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    const nowDate = now.getDate();
    const nowHour = now.getHours();
    const nowMin = now.getMinutes();
    const localNowTime = new Date(nowYear, nowMonth - 1, nowDate, nowHour, nowMin, 0);

    db.bookings.forEach(b => {
      if (b.status === 'pending') {
        const [bkYear, bkMonth, bkDay] = b.date.split('-').map(Number);
        const [bkHour, bkMin] = b.start.split(':').map(Number);
        const localBkTime = new Date(bkYear, bkMonth - 1, bkDay, bkHour, bkMin, 0);
        
        const diffMs = localBkTime.getTime() - localNowTime.getTime();
        
        // 30 mins before scheduled time (or past bookings that are still pending)
        if (diffMs <= 30 * 60 * 1000) {
          // If room is available (no conflicting approved booking)
          if (!hasConflictingApprovedBooking(db.bookings, b)) {
            b.status = 'approved';
            dbChanged = true;
            addAuditLog(db, 'AUTO_APPROVE', 'System', `Auto-approved pending booking ID ${b.id} for ${b.room} as slot starts in <30 mins and room is available.`);
          }
        }
      }
    });

    if (dbChanged) {
      writeDb(db);
    }
    
    return db;
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

  // Collision validation check
  const conflict = hasConflict(db.bookings, { room, date, start, duration, status });
  if (conflict) {
    return res.status(409).json({
      success: false,
      message: "This Time Slot Is Unavailable Look For Another Slot"
    });
  }
  
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

  const currentBooking = db.bookings[bookingIndex];
  const updatedBooking = { ...currentBooking, ...req.body };

  // Collision validation check for edit/updates
  const conflict = hasConflict(db.bookings, updatedBooking, bookingId);
  if (conflict) {
    return res.status(409).json({
      success: false,
      message: "This Time Slot Is Unavailable Look For Another Slot"
    });
  }
  
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

// 4. Employee endpoints (Editable by Admin Only)
app.post('/api/employees', (req, res) => {
  const db = readDb();
  const { name, tag, dept, initials, color, textColor, role, actor } = req.body;
  
  // Authorization check: Only Admin can add employees through console
  const caller = db.employees.find(e => e.name === actor || (e.username && e.username.toLowerCase() === (actor || '').toLowerCase()));
  if (!caller || caller.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Forbidden: Only system administrators can register badge credentials.' });
  }
  
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
  
  addAuditLog(db, 'EMPLOYEE_CREATE', actor || 'Admin', `Registered new employee ${name} with RFID tag ${tag} (${role})`);
  
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
  
  const { actor } = req.body;
  const caller = db.employees.find(e => e.name === actor || (e.username && e.username.toLowerCase() === (actor || '').toLowerCase()));
  if (!caller || caller.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Forbidden: Only system administrators can modify badge credentials.' });
  }
  
  const updatedEmp = { ...db.employees[empIndex], ...req.body };
  db.employees[empIndex] = updatedEmp;
  
  addAuditLog(db, 'EMPLOYEE_UPDATE', actor || 'Admin', `Updated employee ${updatedEmp.name} (Role: ${updatedEmp.role}, Tag: ${updatedEmp.tag})`);
  
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
  
  const actor = req.query.actor;
  const caller = db.employees.find(e => e.name === actor || (e.username && e.username.toLowerCase() === (actor || '').toLowerCase()));
  if (!caller || caller.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Forbidden: Only system administrators can delete security profiles.' });
  }
  
  const deletedEmp = db.employees[empIndex];
  db.employees.splice(empIndex, 1);
  
  addAuditLog(db, 'EMPLOYEE_DELETE', actor || 'Admin', `Deregistered employee ${deletedEmp.name}`);
  
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
  console.log('API settings request body:', req.body);
  const db = readDb();
  const { globalLockdown, gracePeriod, companyName, logoUrl, clientName, clientLogoUrl, fontFamily, theme, actor } = req.body;
  
  if (globalLockdown !== undefined) {
    db.systemSettings.globalLockdown = globalLockdown;
    addAuditLog(db, 'LOCKDOWN_TOGGLE', actor || 'Admin', `System Global Lockdown set to: ${globalLockdown}`);
  }
  
  if (gracePeriod !== undefined) {
    db.systemSettings.gracePeriod = parseInt(gracePeriod);
    addAuditLog(db, 'SETTINGS_CHANGE', actor || 'Admin', `System grace period set to ${gracePeriod} minutes`);
  }
  
  if (companyName !== undefined) {
    db.systemSettings.companyName = companyName;
  }
  
  if (logoUrl !== undefined) {
    db.systemSettings.logoUrl = logoUrl;
  }

  if (clientName !== undefined) {
    db.systemSettings.clientName = clientName;
  }

  if (clientLogoUrl !== undefined) {
    db.systemSettings.clientLogoUrl = clientLogoUrl;
  }
  
  if (fontFamily !== undefined) {
    db.systemSettings.fontFamily = fontFamily;
  }
  
  if (theme !== undefined) {
    db.systemSettings.theme = theme;
    addAuditLog(db, 'BRANDING_CHANGE', actor || 'Admin', `System appearance theme set to: ${theme}`);
  }
  
  writeDb(db);
  res.json({ success: true, settings: db.systemSettings });
});

// Base32 decode helper for TOTP secrets
function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanBase32 = base32.replace(/=+$/, '').toUpperCase();
  let length = cleanBase32.length;
  let bits = 0;
  let value = 0;
  let index = 0;
  const buffer = Buffer.alloc(Math.floor((length * 5) / 8));

  for (let i = 0; i < length; i++) {
    const val = alphabet.indexOf(cleanBase32[i]);
    if (val === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      buffer[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return buffer;
}

// Verify TOTP code (RFC 6238)
function verifyTOTP(secret, code, window = 1) {
  try {
    const key = base32Decode(secret);
    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);

    for (let i = -window; i <= window; i++) {
      const val = counter + i;
      const buf = Buffer.alloc(8);
      let tmp = val;
      for (let j = 7; j >= 0; j--) {
        buf[j] = tmp & 0xff;
        tmp = tmp >> 8;
      }

      const hmac = crypto.createHmac('sha1', key);
      hmac.update(buf);
      const hmacResult = hmac.digest();

      const offset = hmacResult[hmacResult.length - 1] & 0xf;
      const binCode = ((hmacResult[offset] & 0x7f) << 24) |
                      ((hmacResult[offset + 1] & 0xff) << 16) |
                      ((hmacResult[offset + 2] & 0xff) << 8) |
                      (hmacResult[offset + 3] & 0xff);

      const otp = (binCode % 1000000).toString().padStart(6, '0');
      if (otp === code) {
        return true;
      }
    }
  } catch (e) {
    console.error('TOTP validation error:', e);
  }
  return false;
}

// Verify TOTP code (RFC 6238) generator helper
function getTOTP(secret) {
  try {
    const key = base32Decode(secret);
    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);

    const buf = Buffer.alloc(8);
    let tmp = counter;
    for (let j = 7; j >= 0; j--) {
      buf[j] = tmp & 0xff;
      tmp = tmp >> 8;
    }

    const hmac = crypto.createHmac('sha1', key);
    hmac.update(buf);
    const hmacResult = hmac.digest();

    const offset = hmacResult[hmacResult.length - 1] & 0xf;
    const binCode = ((hmacResult[offset] & 0x7f) << 24) |
                    ((hmacResult[offset + 1] & 0xff) << 16) |
                    ((hmacResult[offset + 2] & 0xff) << 8) |
                    (hmacResult[offset + 3] & 0xff);

    return (binCode % 1000000).toString().padStart(6, '0');
  } catch (e) {
    console.error('Error generating TOTP:', e);
    return null;
  }
}

// Authentication endpoints
app.post('/api/auth/register', (req, res) => {
  const db = readDb();
  const { name, username, email, password } = req.body;

  if (!name || !username || !email || !password) {
    return res.status(400).json({ success: false, message: 'All fields (Name, ID/Username, Email, Password) are required.' });
  }

  // Check if username/ID already exists
  const existingUser = db.employees.find(e => e.username && e.username.toLowerCase() === username.toLowerCase());
  if (existingUser) {
    return res.status(400).json({ success: false, message: 'ID number/Username already registered.' });
  }

  // Generate unique employee ID
  const nextIdNum = db.employees.length > 0 ? Math.max(...db.employees.map(e => parseInt(e.id.substring(1)))) + 1 : 1;
  const newEmpId = 'E' + String(nextIdNum).padStart(3, '0');

  // Generate initials
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 3);

  // Generate random base32 TOTP secret (16 characters)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let totpSecret = '';
  for (let i = 0; i < 16; i++) {
    totpSecret += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  // Generate random unique RFID tag
  let tag = '';
  let isUniqueTag = false;
  while (!isUniqueTag) {
    const randHex = crypto.randomBytes(2).toString('hex').toUpperCase();
    tag = `RF-${randHex.substring(0, 2)}${randHex.substring(2, 4)}`;
    if (!db.employees.some(e => e.tag === tag)) {
      isUniqueTag = true;
    }
  }

  // Color harmony presets for avatar
  const colors = [
    { bg: '#EDE9FE', text: '#534AB7' }, // Purple
    { bg: '#E1F5EE', text: '#0F6E56' }, // Teal
    { bg: '#FAECE7', text: '#993C1D' }, // Red/Orange
    { bg: '#FAEEDA', text: '#854F0B' }, // Yellow/Amber
    { bg: '#E0F2FE', text: '#0369A1' }, // Blue
    { bg: '#FCE7F3', text: '#B91C1C' }  // Pink
  ];
  const chosenColor = colors[Math.floor(Math.random() * colors.length)];

  const newEmployee = {
    id: newEmpId,
    name,
    tag,
    dept: 'Engineering',
    initials,
    color: chosenColor.bg,
    textColor: chosenColor.text,
    role: 'employee',
    username,
    password,
    totpSecret,
    email
  };

  db.employees.push(newEmployee);
  
  addAuditLog(db, 'USER_REGISTER', name, `Self-registered new employee account: ${username} (RFID: ${tag})`);
  writeDb(db);

  res.status(201).json({
    success: true,
    message: 'Registration successful! You can now log in using your ID number.',
    username: username
  });
});

app.post('/api/auth/login', (req, res) => {
  const db = readDb();
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  const employee = db.employees.find(e => e.username && e.username.toLowerCase() === username.toLowerCase());
  
  if (!employee || employee.password !== password) {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }

  res.json({
    success: true,
    step: 2,
    username: employee.username,
    email: employee.email || `${employee.username}@bookmyroom.com`,
    totpSecret: employee.totpSecret,
    message: 'Password verified. Please check or enter your email to receive code.'
  });
});

app.post('/api/auth/send-totp-email', (req, res) => {
  const db = readDb();
  const { username, email } = req.body;

  if (!username || !email) {
    return res.status(400).json({ success: false, message: 'Username and email are required.' });
  }

  const employee = db.employees.find(e => e.username && e.username.toLowerCase() === username.toLowerCase());

  if (!employee) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const code = getTOTP(employee.totpSecret);

  console.log('\n==================================================');
  console.log('📧 SIMULATED EMAIL TRANSMISSION');
  console.log(`Date: ${new Date().toUTCString()}`);
  console.log(`From: security@bookmyroom.com`);
  console.log(`To: ${email}`);
  console.log(`Subject: 🔐 BookMyRoom Verification Code`);
  console.log('--------------------------------------------------');
  console.log(`Hello ${employee.name},\n`);
  console.log(`Your two-factor verification code is: ${code}\n`);
  console.log(`If you did not request this, please secure your credentials.`);
  console.log('==================================================\n');

  res.json({
    success: true,
    code: code,
    email: email,
    message: 'Verification code shared on email.'
  });
});

app.post('/api/auth/verify-totp', (req, res) => {
  const db = readDb();
  const { username, code } = req.body;

  if (!username || !code) {
    return res.status(400).json({ success: false, message: 'Username and TOTP code are required.' });
  }

  const employee = db.employees.find(e => e.username && e.username.toLowerCase() === username.toLowerCase());

  if (!employee) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const isValid = verifyTOTP(employee.totpSecret, code);

  if (!isValid) {
    return res.status(401).json({ success: false, message: 'Invalid TOTP verification code.' });
  }

  addAuditLog(db, 'USER_LOGIN', employee.name, `${employee.name} (${employee.role}) logged in successfully via 2FA.`);
  writeDb(db);

  const sessionUser = {
    id: employee.id,
    name: employee.name,
    role: employee.role,
    dept: employee.dept,
    initials: employee.initials,
    color: employee.color,
    textColor: employee.textColor
  };

  res.json({
    success: true,
    user: sessionUser,
    message: 'Two-factor authentication successful.'
  });
});

// Start server listening
// Only start HTTPS locally (when PORT env is not defined by cloud platforms)
if (!process.env.PORT) {
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
}

http.createServer(app).listen(PORT_HTTP, () => {
  console.log(`Server running on port ${PORT_HTTP}`);
});
