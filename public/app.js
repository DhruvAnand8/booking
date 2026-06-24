// Global fetch interceptor to support separate backend hosting (e.g. on Render)
// REPLACE this URL with your actual deployed Render backend URL when you configure it.
const BACKEND_URL = 'https://room-booking-backend.onrender.com';

const originalFetch = window.fetch;
window.fetch = function (url, options) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    // If running on GitHub Pages (not localhost), route requests to the hosted backend
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      url = BACKEND_URL.replace(/\/$/, '') + url;
    }
  }
  return originalFetch(url, options);
};

// ======================== STATE ========================

let state = {
  rooms: [],
  employees: [],
  bookings: [],
  rfidLog: [],
  rfidState: {},
  systemSettings: { globalLockdown: false, gracePeriod: 15 },
  auditLogs: []
};

let currentUser = null;
let currentRole = 'employee';
let selectedRoomName = '';
let weekOffset = 0;
let currentPage = 'dashboard';
let currentAdminTab = 'rooms';

const DAYS = ['Mon 23', 'Tue 24', 'Wed 25', 'Thu 26', 'Fri 27'];
const HOURS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

// ======================== CORE OPERATIONS ========================
async function fetchState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('API server returned error');
    state = await res.json();
    
    // Check if session is stored in localStorage
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
      const parsedUser = JSON.parse(savedUser);
      currentUser = state.employees.find(e => e.id === parsedUser.id) || parsedUser;
      currentRole = currentUser.role;
      const overlay = document.getElementById('login-overlay');
      if (overlay) overlay.style.display = 'none';
      const roleSel = document.getElementById('role-select');
      if (roleSel) roleSel.value = currentRole;

      // Enforce dashboard page access restriction for employee role on initial load
      const isEmployee = currentUser.role !== 'admin' && currentUser.role !== 'manager' && currentRole !== 'admin' && currentRole !== 'manager';
      if (isEmployee && currentPage === 'dashboard') {
        currentPage = 'book';
        // Set visual side bar states for Book page
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navItem = document.getElementById('nav-book');
        if (navItem) navItem.classList.add('active');
        document.getElementById('page-title').textContent = 'Book a Room';
        document.getElementById('page-sub').textContent = 'Submit a booking request';
        
        // Render book page division active
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const targetPage = document.getElementById('page-book');
        if (targetPage) targetPage.classList.add('active');
      }
    } else {
      currentUser = null;
      const overlay = document.getElementById('login-overlay');
      if (overlay) overlay.style.display = 'flex';
      return; // Stop execution of other UI updates until login
    }
    
    // Apply branding settings
    applyBranding(state.systemSettings);
    
    // Update global UI indicators
    updateGlobalIndicators();
    
    // Render current view
    renderPage(currentPage);
  } catch (err) {
    console.error('Failed to sync state from backend', err);
    toast('Server connection offline. Retrying...', 'danger');
  }
}
function updateGlobalIndicators() {
  // Sidebar roles and profiles
  document.getElementById('sidebar-name').textContent = currentUser.name;
  document.getElementById('sidebar-role').textContent = currentUser.role.toUpperCase();
  document.getElementById('sidebar-avatar').textContent = currentUser.initials;
  document.getElementById('sidebar-avatar').style.backgroundColor = currentUser.color;
  document.getElementById('sidebar-avatar').style.color = currentUser.textColor;
  
  // Pending count badge
  const pendingCount = state.bookings.filter(b => b.status === 'pending').length;
  document.getElementById('pending-count').textContent = pendingCount;
  document.getElementById('pending-count').style.display = pendingCount > 0 ? 'inline-block' : 'none';
  
  // Sidebar admin tab display
  const adminNav = document.getElementById('nav-admin');
  if (currentUser.role === 'admin' || currentRole === 'admin') {
    adminNav.style.display = 'flex';
  } else {
    adminNav.style.display = 'none';
    if (currentPage === 'admin') showPage('dashboard');
  }

  // Sidebar dashboard display (only admin and managers)
  const dashboardNav = document.getElementById('nav-dashboard');
  const isEmployee = currentUser.role !== 'admin' && currentUser.role !== 'manager' && currentRole !== 'admin' && currentRole !== 'manager';
  if (isEmployee) {
    if (dashboardNav) dashboardNav.style.display = 'none';
  } else {
    if (dashboardNav) dashboardNav.style.display = 'flex';
  }
  
  // Global lockdown styling and warning displays
  const lockdownIndicator = document.getElementById('lockdown-sidebar-indicator');
  const alertIndicator = document.getElementById('lockdown-status-indicator');
  const lockdownBtn = document.getElementById('global-lockdown-btn');
  
  if (state.systemSettings.globalLockdown) {
    document.body.classList.add('lockdown-active');
    lockdownIndicator.style.display = 'block';
    
    if (alertIndicator) {
      alertIndicator.textContent = 'ACTIVE LOCKDOWN';
      alertIndicator.className = 'lockdown-status-badge active';
    }
    if (lockdownBtn) {
      lockdownBtn.textContent = 'Disable System Lockdown';
      lockdownBtn.className = 'btn btn-success';
    }
  } else {
    document.body.classList.remove('lockdown-active');
    lockdownIndicator.style.display = 'none';
    
    if (alertIndicator) {
      alertIndicator.textContent = 'OFF - NORMAL';
      alertIndicator.className = 'lockdown-status-badge';
    }
    if (lockdownBtn) {
      lockdownBtn.textContent = 'Enable System Lockdown';
      lockdownBtn.className = 'btn btn-danger';
    }
  }
}

// ======================== NAVIGATION & ROUTING ========================

function showPage(page) {
  // Prevent employees from accessing dashboard
  const isEmployee = currentUser && currentUser.role !== 'admin' && currentUser.role !== 'manager' && currentRole !== 'admin' && currentRole !== 'manager';
  if (isEmployee && page === 'dashboard') {
    page = 'book';
  }
  
  currentPage = page;
  
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  const targetPage = document.getElementById(`page-${page}`);
  if (targetPage) targetPage.classList.add('active');
  
  const navItem = document.getElementById(`nav-${page}`);
  if (navItem) navItem.classList.add('active');

  const titles = {
    dashboard: ['Dashboard', 'Overview of all rooms and activity'],
    book: ['Book a Room', 'Submit a booking request'],
    timetable: ['Weekly Schedule', 'View availability across all rooms'],
    mybookings: ['My Bookings', 'Your upcoming and past reservations'],
    rfid: ['RFID Access Log', 'Track check-ins and check-outs'],
    manager: ['Manager Dashboard', 'Approve requests and monitor usage'],
    admin: ['Admin Console', 'System settings, device overrides, and directories'],
  };
  
  document.getElementById('page-title').textContent = titles[page][0];
  document.getElementById('page-sub').textContent = titles[page][1];

  renderPage(page);
}

function renderPage(page) {
  if (page === 'dashboard') renderDashboard();
  if (page === 'book') renderBookForm();
  if (page === 'timetable') renderWeekTimetable();
  if (page === 'mybookings') renderMyBookings();
  if (page === 'rfid') renderRFID();
  if (page === 'manager') renderManager();
  if (page === 'admin') renderAdmin();
}

function switchRole(role) {
  logout();
  const usernameMap = {
    admin: 'admin',
    manager: 'priya',
    employee: 'arjun'
  };
  const username = usernameMap[role] || 'arjun';
  const userField = document.getElementById('login-username');
  if (userField) userField.value = username;
  toast(`Logging out. Prefilled ${role.toUpperCase()} credentials.`, 'info');
}

// ======================== DASHBOARD VIEW ========================

function renderDashboard() {
  // Counters
  document.getElementById('dash-rooms-count').textContent = state.rooms.length;
  document.getElementById('dash-bookings-count').textContent = state.bookings.filter(b => !b.checkout).length;
  
  const pending = state.bookings.filter(b => b.status === 'pending').length;
  document.getElementById('dash-pending').textContent = pending;
  
  const checkedIn = Object.keys(state.rfidState).length;
  document.getElementById('dash-checkedin').textContent = checkedIn;

  // Timetable
  renderTodayGrid();

  // Activity list
  const tbody = document.getElementById('bookings-list');
  let html = '';
  
  [...state.bookings].reverse().slice(0, 6).forEach(b => {
    const emp = state.employees.find(e => e.id === b.empId) || { name: 'Unknown', dept: 'System', initials: 'UN', color: '#CBD5E1', textColor: '#475569' };
    let checkinText = '—';
    if (b.checkin && b.checkout) {
      checkinText = `<span style="color:var(--success); font-weight:700;">✓ Checked Out (${b.checkin}–${b.checkout})</span>`;
    } else if (b.checkin) {
      checkinText = `<span style="color:var(--primary); font-weight:700;">● Active (${b.checkin})</span>`;
    }
    
    html += `<tr>
      <td>
        <div class="avatar-cell">
          <div class="mini-avatar" style="background:${emp.color}; color:${emp.textColor}">${emp.initials}</div>
          <div>
            <div style="font-weight:700; color:var(--slate-800);">${emp.name}</div>
            <div style="font-size:11px; color:var(--slate-400); font-weight:600;">${emp.dept}</div>
          </div>
        </div>
      </td>
      <td style="font-weight:700; color:var(--slate-800);">${b.room}</td>
      <td>
        <div style="font-weight:600;">${b.date}</div>
        <div style="font-size:12px; color:var(--slate-500); font-weight:500;">${b.start} · ${b.duration}</div>
      </td>
      <td style="font-size:12.5px; color:var(--slate-600); max-width:160px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${b.purpose}</td>
      <td>${statusBadge(b.status)}</td>
      <td>${checkinText}</td>
    </tr>`;
  });
  
  if (!html) html = `<tr><td colspan="6" style="text-align:center; padding:32px; color:var(--slate-400)">No bookings registered.</td></tr>`;
  tbody.innerHTML = html;
}

function renderTodayGrid() {
  const header = document.getElementById('today-grid-header');
  const tbody = document.getElementById('today-grid-body');
  if (!tbody || !header) return;

  // Header rooms list
  let headerHtml = '<th class="time-col">Time</th>';
  state.rooms.forEach(r => {
    headerHtml += `<th>${r.name}</th>`;
  });
  header.innerHTML = headerHtml;

  // Body
  let bodyHtml = '';
  HOURS.forEach(h => {
    bodyHtml += `<tr><td class="time-cell">${h}</td>`;
    state.rooms.forEach(r => {
      const b = state.bookings.find(bk => bk.room === r.name && bk.date === '2026-06-23' && bk.start === h);
      let cls = 'slot-available', label = 'Free';
      let titleAttr = 'Room Available';
      
      if (b) {
        const emp = state.employees.find(e => e.id === b.empId);
        titleAttr = `${emp ? emp.name : 'User'} — ${b.purpose}`;
        if (b.status === 'pending') {
          cls = 'slot-pending';
          label = emp ? emp.initials : '?';
        } else if (b.empId === currentUser.id) {
          cls = 'slot-mine';
          label = emp ? emp.initials : 'Me';
        } else {
          cls = 'slot-booked';
          label = emp ? emp.initials : 'In';
        }
      }
      bodyHtml += `<td><div class="slot ${cls}" title="${titleAttr}" onclick="handleDashboardCellClick('${r.name}', '${h}')" style="cursor: pointer;">${label}</div></td>`;
    });
    bodyHtml += '</tr>';
  });
  tbody.innerHTML = bodyHtml;
}

// ======================== BOOK ROOM VIEW ========================

function renderBookForm() {
  const floorSelect = document.getElementById('book-floor-select');
  const typeSelect = document.getElementById('book-type-select');
  if (floorSelect && typeSelect) {
    updateBookRoomResolution();
  }
}

function updateBookRoomResolution() {
  const floor = document.getElementById('book-floor-select').value;
  const type = document.getElementById('book-type-select').value;
  const roomName = `Floor ${floor} ${type}`;
  document.getElementById('book-resolved-room').value = roomName;
  selectedRoomName = roomName;
}

async function submitBooking() {
  const date = document.getElementById('book-date').value;
  const start = document.getElementById('book-start').value;
  const duration = document.getElementById('book-duration').value;
  
  const purposeSelect = document.getElementById('book-purpose-select');
  let purpose = 'Client meeting';
  if (purposeSelect) {
    purpose = purposeSelect.value;
    if (purpose === 'More') {
      purpose = document.getElementById('book-purpose-custom').value.trim() || 'More';
    }
  }
  
  if (!date || !start) {
    return toast('Please select date and start time.', 'warning');
  }

  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empId: currentUser.id,
        room: selectedRoomName,
        date,
        start,
        duration,
        purpose,
        status: (currentRole === 'manager' || currentRole === 'admin') ? 'approved' : 'pending'
      })
    });
    
    if (res.ok) {
      toast('Booking request sent successfully!', 'success');
      // Reset purpose input
      if (purposeSelect) {
        purposeSelect.value = 'Client meeting';
        document.getElementById('book-purpose-custom-container').style.display = 'none';
        document.getElementById('book-purpose-custom').value = '';
      }
      showPage('mybookings');
      fetchState();
    } else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.message || 'Failed to register booking.', 'danger');
    }
  } catch (err) {
    toast('Network error saving booking.', 'danger');
  }
}// ======================== WEEKLY TIMETABLE VIEW ========================

function renderWeekTimetable() {
  const table = document.getElementById('week-timetable');
  if (!table) return;
  
  // Populate filter dropdown
  const filter = document.getElementById('tt-room-filter');
  const currentFilterVal = filter.value;
  let filterHtml = '<option value="all">All Rooms</option>';
  state.rooms.forEach(r => {
    filterHtml += `<option value="${r.name}">${r.name}</option>`;
  });
  filter.innerHTML = filterHtml;
  filter.value = currentFilterVal;

  const targetRoom = filter.value;

  // Compute dates for the selected week offset
  let html = '<thead><tr><th class="time-col">Time</th>';
  DAYS.forEach((d, idx) => {
    // Add offset days if any
    const dateNum = 23 + idx + (weekOffset * 7);
    html += `<th>${d.split(' ')[0]} ${dateNum} Jun</th>`;
  });
  html += '</tr></thead><tbody>';

  HOURS.forEach(h => {
    html += `<tr><td class="time-cell">${h}</td>`;
    DAYS.forEach((d, idx) => {
      const dateNum = 23 + idx + (weekOffset * 7);
      const dateStr = `2026-06-${String(dateNum).padStart(2, '0')}`;
      
      const matchedBookings = state.bookings.filter(bk => 
        (targetRoom === 'all' ? true : bk.room === targetRoom) &&
        bk.date === dateStr && bk.start === h
      );
      
      if (matchedBookings.length > 0) {
        // Show first booking
        const b = matchedBookings[0];
        const emp = state.employees.find(e => e.id === b.empId);
        let cls = 'slot-booked';
        if (b.status === 'pending') cls = 'slot-pending';
        else if (b.empId === currentUser.id) cls = 'slot-mine';
        
        html += `<td><div class="slot ${cls}" title="${emp ? emp.name : 'User'} — ${b.room} — ${b.purpose}" onclick="handleDashboardCellClick('${b.room}', '${b.start}', '${b.date}')" style="cursor: pointer;">${emp ? emp.initials : '?'}</div></td>`;
      } else {
        html += `<td><div class="slot slot-available" onclick="openDirectBookingAt('${dateStr}', '${h}')">+</div></td>`;
      }
    });
    html += '</tr>';
  });

  html += '</tbody>';
  table.innerHTML = html;
}

function changeWeek(dir) {
  weekOffset += dir;
  const startNum = 23 + (weekOffset * 7);
  const endNum = 27 + (weekOffset * 7);
  document.getElementById('week-label').textContent = `${startNum}–${endNum} Jun 2026`;
  renderWeekTimetable();
}

function openDirectBookingAt(date, time) {
  if (currentRole === 'admin') {
    openAdminAddBookingModal();
    document.getElementById('admin-booking-date').value = date;
    document.getElementById('admin-booking-start').value = time;
  } else {
    showPage('book');
    document.getElementById('book-date').value = date;
    document.getElementById('book-start').value = time;
  }
}

// ======================== MY BOOKINGS VIEW ========================

function renderMyBookings() {
  const mine = state.bookings.filter(b => b.empId === currentUser.id);
  const tbody = document.getElementById('my-bookings-list');
  let html = '';
  
  mine.forEach(b => {
    let checkinText = '—';
    if (b.checkin && b.checkout) {
      checkinText = `<span style="color:var(--success);">✓ ${b.checkin}→${b.checkout}</span>`;
    } else if (b.checkin) {
      checkinText = `<span class="badge badge-checkedin">In @ ${b.checkin}</span>`;
    }
    
    let action = '';
    if (b.status === 'approved' && !b.checkout) {
      action = `<button class="btn btn-danger btn-sm" onclick="cancelBooking(${b.id})">Cancel</button>`;
    } else if (b.status === 'pending') {
      action = `<button class="btn btn-outline btn-sm" onclick="cancelBooking(${b.id})">Retract</button>`;
    } else {
      action = `<span style="font-size:12px; color:var(--slate-400); font-weight:600;">No actions</span>`;
    }
    
    html += `<tr>
      <td style="font-weight:700; color:var(--slate-800);">${b.room}</td>
      <td>${b.date}</td>
      <td style="font-weight:600;">${b.start} · ${b.duration}</td>
      <td style="font-size:12.5px; color:var(--slate-500);">${b.purpose}</td>
      <td>${statusBadge(b.status)}</td>
      <td>${checkinText}</td>
      <td>${action}</td>
    </tr>`;
  });
  
  if (!mine.length) {
    html = `<tr><td colspan="7"><div style="text-align:center; padding:48px 24px; color:var(--slate-400); font-weight:600;">No reservations scheduled yet.</div></td></tr>`;
  }
  
  tbody.innerHTML = html;
}

async function cancelBooking(id) {
  if (!confirm('Cancel this room reservation request?')) return;
  
  try {
    const res = await fetch(`/api/bookings/${id}?actor=${encodeURIComponent(currentUser.name)}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      toast('Booking cancelled successfully', 'info');
      fetchState();
    } else {
      toast('Failed to cancel booking', 'danger');
    }
  } catch (err) {
    toast('Network error', 'danger');
  }
}

// ======================== RFID SIMULATION & ACCESS LOG VIEW ========================

function renderRFID() {
  // Target room dropdown
  const roomSelect = document.getElementById('rfid-sim-room-select');
  const activeRoom = roomSelect.value;
  let roomHtml = '';
  state.rooms.forEach(r => {
    roomHtml += `<option value="${r.name}">${r.name}</option>`;
  });
  roomSelect.innerHTML = roomHtml;
  if (activeRoom) roomSelect.value = activeRoom;

  // Render clickable simulated RFID badges
  const cardsWrap = document.getElementById('rfid-sim-cards');
  let cardsHtml = '';
  
  state.employees.forEach(emp => {
    const activeSession = state.rfidState[emp.tag];
    const isIn = !!activeSession;
    const sessionRoomInfo = isIn ? ` @ ${activeSession.room}` : '';
    
    cardsHtml += `<div class="rfid-card ${isIn ? 'active-in' : ''}" onclick="tapSimulateRFID('${emp.tag}')">
      <div class="rfid-card-tag">${emp.tag}</div>
      <div class="rfid-card-name">${emp.name}</div>
      <div class="rfid-card-status ${isIn ? 'status-in' : 'status-out'}">
        ${isIn ? '● Checked In' + sessionRoomInfo : '○ Swiped Out'}
      </div>
    </div>`;
  });
  
  cardsWrap.innerHTML = cardsHtml;

  // Access Logs
  renderRFIDLogsList();
}

async function tapSimulateRFID(tag) {
  const room = document.getElementById('rfid-sim-room-select').value;
  const sensor = document.getElementById('rfid-sensor-light');
  
  if (!room) return toast('Please register a room first!', 'warning');
  
  try {
    const res = await fetch('/api/rfid/tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, room })
    });
    
    const result = await res.json();
    
    // Scanner Glow Animations
    if (res.ok) {
      sensor.className = 'sensor-light granted';
      toast(result.message, 'success');
    } else {
      sensor.className = 'sensor-light denied';
      toast(result.message || 'Access Denied', 'danger');
    }
    
    // Reset scanner state after delay
    setTimeout(() => {
      sensor.className = 'sensor-light';
    }, 1500);
    
    fetchState();
  } catch (err) {
    toast('Network communication error with sensor.', 'danger');
  }
}

function renderRFIDLogsList() {
  const list = document.getElementById('rfid-log-list');
  const count = document.getElementById('log-count');
  let html = '';
  
  state.rfidLog.slice(0, 15).forEach(r => {
    let cls = 'rfid-in';
    let icon = '●';
    if (r.event === 'check-out') {
      cls = 'rfid-out';
      icon = '○';
    } else if (r.event === 'access-denied') {
      cls = 'rfid-denied';
      icon = '🚫';
    }
    
    const emp = state.employees.find(e => e.tag === r.tag) || { initials: '?', color: '#CBD5E1', textColor: '#475569' };
    
    html += `<div class="rfid-row">
      <span class="rfid-time">${r.time}</span>
      <span class="rfid-tag">${r.tag}</span>
      <div class="mini-avatar" style="background:${emp.color}; color:${emp.textColor}; width:24px; height:24px; font-size:9.5px;">${emp.initials}</div>
      <span class="rfid-name">${r.name}</span>
      <span class="rfid-room">door: <strong>${r.room}</strong></span>
      <span class="rfid-event ${cls}">${icon} ${r.event.toUpperCase()}</span>
      ${r.duration ? `<span class="rfid-duration">⏱ ${r.duration}</span>` : ''}
    </div>`;
  });
  
  list.innerHTML = html || '<div style="padding:32px; text-align:center; color:var(--slate-400);">No lock events recorded. Scan a card to start.</div>';
  count.textContent = `${state.rfidLog.length} entry/entries today`;
}

// ======================== MANAGER APPROVAL PANEL ========================

function renderManager() {
  const notice = document.getElementById('employee-notice');
  const container = document.getElementById('manager-container');
  
  if (currentRole !== 'manager' && currentRole !== 'admin') {
    notice.style.display = 'block';
    container.style.opacity = '0.35';
    container.style.pointerEvents = 'none';
    return;
  } else {
    notice.style.display = 'none';
    container.style.opacity = '1';
    container.style.pointerEvents = 'auto';
  }

  // Pending queue
  const pending = state.bookings.filter(b => b.status === 'pending');
  const list = document.getElementById('approval-list');
  let html = '';
  
  pending.forEach(b => {
    const emp = state.employees.find(e => e.id === b.empId) || { name: 'Unknown', dept: 'System', initials: 'U', color: '#E2E8F0', textColor: '#64748B' };
    
    html += `<div class="approval-item">
      <div class="notification-dot"></div>
      <div class="mini-avatar" style="background:${emp.color}; color:${emp.textColor}; width:38px; height:38px; font-size:13px;">${emp.initials}</div>
      <div class="approval-detail">
        <div class="approval-name">${emp.name} <span>(${emp.dept})</span></div>
        <div class="approval-meta">
          <strong>${b.room}</strong> · ${b.date} · ${b.start} · ${b.duration}
        </div>
        <div class="approval-purpose">${b.purpose}</div>
      </div>
      <div class="actions">
        <button class="btn btn-success btn-sm" onclick="approveBooking(${b.id})">✓ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="rejectBooking(${b.id})">✗ Reject</button>
      </div>
    </div>`;
  });
  
  list.innerHTML = html || '<div style="padding:32px; text-align:center; color:var(--slate-400); font-weight:600;">No pending clearance requests.</div>';

  renderManagerTable();
}

function renderManagerTable() {
  const filterVal = document.getElementById('mgr-filter').value;
  const tbody = document.getElementById('mgr-bookings-list');
  let html = '';
  
  const filtered = filterVal === 'All' ? state.bookings : state.bookings.filter(b => b.status === filterVal.toLowerCase());
  
  filtered.forEach(b => {
    const emp = state.employees.find(e => e.id === b.empId) || { name: 'Unknown' };
    let checkinText = '—';
    if (b.checkin && b.checkout) checkinText = `<span style="color:var(--success);">✓ Checked Out</span>`;
    else if (b.checkin) checkinText = `<span style="color:var(--primary); font-weight:700;">● Checked In</span>`;
    
    let action = '';
    if (b.status === 'pending') {
      action = `<button class="btn btn-success btn-sm" onclick="approveBooking(${b.id})">Approve</button>
                <button class="btn btn-danger btn-sm" onclick="rejectBooking(${b.id})">Reject</button>`;
    } else if (b.status === 'approved' && !b.checkout) {
      action = `<button class="btn btn-outline btn-sm" onclick="cancelBooking(${b.id})">Cancel</button>`;
    }
    
    html += `<tr>
      <td style="font-weight:700; color:var(--slate-800);">${emp.name}</td>
      <td style="font-weight:600;">${b.room}</td>
      <td>${b.date} · ${b.start}<br><span style="font-size:11px; color:var(--slate-400);">${b.duration}</span></td>
      <td style="font-size:12.5px; color:var(--slate-600);">${b.purpose}</td>
      <td>${statusBadge(b.status)}</td>
      <td>${checkinText}</td>
      <td><div class="actions">${action}</div></td>
    </tr>`;
  });
  
  if (!html) html = `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--slate-400)">No matching bookings found.</td></tr>`;
  tbody.innerHTML = html;
}

async function approveBooking(id) {
  try {
    const res = await fetch(`/api/bookings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', actor: currentUser.name })
    });
    if (res.ok) {
      toast('Booking approved.', 'success');
      fetchState();
    }
  } catch (err) {
    toast('API error', 'danger');
  }
}

async function rejectBooking(id) {
  try {
    const res = await fetch(`/api/bookings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', actor: currentUser.name })
    });
    if (res.ok) {
      toast('Booking rejected.', 'info');
      fetchState();
    }
  } catch (err) {
    toast('API error', 'danger');
  }
}

// ======================== ADMIN CONSOLE VIEW ========================

function renderAdmin() {
  const notice = document.getElementById('admin-notice');
  const container = document.getElementById('admin-container');
  
  if (currentUser.role !== 'admin' && currentRole !== 'admin') {
    notice.style.display = 'block';
    container.style.opacity = '0.3';
    container.style.pointerEvents = 'none';
    return;
  } else {
    notice.style.display = 'none';
    container.style.opacity = '1';
    container.style.pointerEvents = 'auto';
  }

  if (currentAdminTab === 'rooms') renderAdminRooms();
  if (currentAdminTab === 'employees') renderAdminEmployees();
  if (currentAdminTab === 'bookings') renderAdminBookings();
  if (currentAdminTab === 'settings') renderAdminSettings();
  if (currentAdminTab === 'analytics') renderAdminAnalytics();
}

function switchAdminTab(tab) {
  currentAdminTab = tab;
  document.querySelectorAll('.admin-tab').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  
  // Set active button
  const activeBtn = Array.from(document.querySelectorAll('.admin-tab')).find(btn => btn.getAttribute('onclick').includes(tab));
  if (activeBtn) activeBtn.classList.add('active');
  
  const targetContent = document.getElementById(`admin-tab-${tab}`);
  if (targetContent) targetContent.classList.add('active');
  
  renderAdmin();
}

// 1. Rooms Tab
function renderAdminRooms() {
  const tbody = document.getElementById('admin-rooms-list');
  let html = '';
  
  state.rooms.forEach(r => {
    let overrideBtnText = 'Lock Room';
    let nextLockState = 'Locked';
    let btnClass = 'btn btn-outline btn-sm';
    
    if (r.lockStatus === 'Locked') {
      overrideBtnText = 'Unlock Door';
      nextLockState = 'Normal';
      btnClass = 'btn btn-success btn-sm';
    } else if (r.lockStatus === 'Normal') {
      overrideBtnText = 'Lock Door';
      nextLockState = 'Locked';
      btnClass = 'btn btn-danger btn-sm';
    }
    
    html += `<tr>
      <td style="font-family:monospace; font-weight:700;">${r.id}</td>
      <td style="font-weight:700; color:var(--slate-800);">${r.name}</td>
      <td>${r.capacity} people</td>
      <td>
        <span class="room-lock-badge ${r.lockStatus.replace(' ', '')}">
          <span class="lock-indicator-glow ${r.lockStatus.replace(' ', '')}"></span>
          ${r.lockStatus}
        </span>
      </td>
      <td>
        <div class="actions">
          <button class="${btnClass}" onclick="toggleRoomLock('${r.id}', '${nextLockState}')">${overrideBtnText}</button>
          <button class="btn btn-outline btn-sm" onclick="toggleRoomLock('${r.id}', 'Force Unlocked')">Force Open</button>
        </div>
      </td>
      <td>
        <div class="actions">
          <button class="btn btn-outline btn-sm" onclick="openEditRoomModal('${r.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteRoom('${r.id}')">Delete</button>
        </div>
      </td>
    </tr>`;
  });
  
  tbody.innerHTML = html;
}

async function toggleRoomLock(id, status) {
  try {
    const res = await fetch(`/api/rooms/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lockStatus: status, actor: currentUser.name })
    });
    if (res.ok) {
      toast(`Room door override set to: ${status}`, 'success');
      fetchState();
    }
  } catch (err) {
    toast('API communication failed', 'danger');
  }
}

// 2. Employees Tab
function renderAdminEmployees() {
  const tbody = document.getElementById('admin-employees-list');
  let html = '';
  
  state.employees.forEach(emp => {
    html += `<tr>
      <td style="font-family:monospace; font-weight:700;">${emp.id}</td>
      <td>
        <div class="avatar-cell">
          <div class="mini-avatar" style="background:${emp.color}; color:${emp.textColor}">${emp.initials}</div>
          <div style="font-weight:700; color:var(--slate-800);">${emp.name}</div>
        </div>
      </td>
      <td>${emp.dept}</td>
      <td style="font-family:monospace;">${emp.tag}</td>
      <td><span class="badge ${emp.role === 'admin' ? 'badge-rejected' : emp.role === 'manager' ? 'badge-pending' : 'badge-completed'}">${emp.role.toUpperCase()}</span></td>
      <td>
        <div class="actions">
          <button class="btn btn-outline btn-sm" onclick="openEditEmpModal('${emp.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteEmp('${emp.id}')">Delete</button>
        </div>
      </td>
    </tr>`;
  });
  
  tbody.innerHTML = html;
}

// 3. Bookings Tab
function renderAdminBookings() {
  const tbody = document.getElementById('admin-bookings-list');
  let html = '';
  
  state.bookings.forEach(b => {
    const emp = state.employees.find(e => e.id === b.empId) || { name: 'Unknown' };
    let checkinText = 'Not Scanned';
    if (b.checkin && b.checkout) checkinText = `✓ Checked out (${b.checkin}–${b.checkout})`;
    else if (b.checkin) checkinText = `Active Check-in (${b.checkin})`;

    html += `<tr>
      <td>${b.id}</td>
      <td style="font-weight:700;">${emp.name}</td>
      <td style="font-weight:600;">${b.room}</td>
      <td>${b.date} · ${b.start} · ${b.duration}</td>
      <td>${b.purpose}</td>
      <td>${statusBadge(b.status)}</td>
      <td style="font-size:12px; color:var(--slate-500);">${checkinText}</td>
      <td>
        <div class="actions">
          <button class="btn btn-outline btn-sm" onclick="openAdminEditBookingModal(${b.id})">Reschedule</button>
          <button class="btn btn-danger btn-sm" onclick="deleteBooking(${b.id})">Force Cancel</button>
        </div>
      </td>
    </tr>`;
  });
  
  tbody.innerHTML = html;
}

// 4. Settings & Logs Tab
function renderAdminSettings() {
  const graceEl = document.getElementById('sys-grace-period');
  if (graceEl && document.activeElement !== graceEl) {
    graceEl.value = state.systemSettings.gracePeriod;
  }
  
  // Load branding values
  const companyNameEl = document.getElementById('sys-company-name');
  if (companyNameEl && state.systemSettings.companyName !== undefined && document.activeElement !== companyNameEl) {
    companyNameEl.value = state.systemSettings.companyName;
  }
  const logoUrlEl = document.getElementById('sys-logo-url');
  if (logoUrlEl && state.systemSettings.logoUrl !== undefined && document.activeElement !== logoUrlEl) {
    logoUrlEl.value = state.systemSettings.logoUrl;
  }
  
  if (state.systemSettings.logoUrl !== undefined) {
    // Configure file uploader name
    const isBase64 = state.systemSettings.logoUrl.startsWith('data:image/png;base64,');
    if (isBase64) {
      document.getElementById('logo-file-name').textContent = "Uploaded PNG Logo";
      document.getElementById('btn-clear-logo').style.display = 'inline-flex';
    } else if (state.systemSettings.logoUrl.trim() !== '') {
      document.getElementById('logo-file-name').textContent = "Image URL Configured";
      document.getElementById('btn-clear-logo').style.display = 'inline-flex';
    } else {
      document.getElementById('logo-file-name').textContent = "No file chosen";
      document.getElementById('btn-clear-logo').style.display = 'none';
    }
  }

  // Load secondary branding values
  const clientNameEl = document.getElementById('sys-client-name');
  if (clientNameEl && state.systemSettings.clientName !== undefined && document.activeElement !== clientNameEl) {
    clientNameEl.value = state.systemSettings.clientName;
  }
  const clientLogoUrlEl = document.getElementById('sys-client-logo-url');
  if (clientLogoUrlEl && state.systemSettings.clientLogoUrl !== undefined && document.activeElement !== clientLogoUrlEl) {
    clientLogoUrlEl.value = state.systemSettings.clientLogoUrl;
  }
  
  if (state.systemSettings.clientLogoUrl !== undefined) {
    // Configure file uploader name
    const isBase64 = state.systemSettings.clientLogoUrl.startsWith('data:image/png;base64,');
    if (isBase64) {
      document.getElementById('client-logo-file-name').textContent = "Uploaded PNG Logo";
      document.getElementById('btn-clear-client-logo').style.display = 'inline-flex';
    } else if (state.systemSettings.clientLogoUrl.trim() !== '') {
      document.getElementById('client-logo-file-name').textContent = "Image URL Configured";
      document.getElementById('btn-clear-client-logo').style.display = 'inline-flex';
    } else {
      document.getElementById('client-logo-file-name').textContent = "No file chosen";
      document.getElementById('btn-clear-client-logo').style.display = 'none';
    }
  }

  const fontFamilyEl = document.getElementById('sys-font-family');
  if (fontFamilyEl && state.systemSettings.fontFamily !== undefined && document.activeElement !== fontFamilyEl) {
    fontFamilyEl.value = state.systemSettings.fontFamily;
  }
  if (state.systemSettings.theme !== undefined) {
    const themeVal = state.systemSettings.theme;
    const legacyToHex = {
      indigo: '#4F46E5',
      emerald: '#10B981',
      orange: '#F59E0B',
      crimson: '#E11D48',
      dark: '#334155'
    };
    const hexVal = themeVal.startsWith('#') ? themeVal : (legacyToHex[themeVal] || '#4F46E5');
    const picker = document.getElementById('sys-theme-picker');
    if (picker) picker.value = hexVal;
    const btn = document.getElementById('sys-theme-color-btn');
    if (btn) btn.style.background = hexVal;
    const label = document.getElementById('sys-theme-color-hex');
    if (label) label.textContent = hexVal.toUpperCase();
  }
  
  // Render logs
  const list = document.getElementById('admin-audit-logs-list');
  let html = '';
  
  state.auditLogs.slice(0, 30).forEach(log => {
    const date = new Date(log.timestamp);
    const timeStr = date.toLocaleTimeString() + ' ' + date.toLocaleDateString();
    
    html += `<div class="audit-log-item">
      <div class="audit-log-meta">
        <span class="audit-log-actor">user: ${log.user}</span>
        <span class="audit-log-action">${log.action}</span>
        <span class="audit-log-time">${timeStr}</span>
      </div>
      <div class="audit-log-details">${log.details}</div>
    </div>`;
  });
  
  list.innerHTML = html || '<div style="padding:20px; text-align:center; color:var(--slate-400);">No logs present.</div>';
}

async function toggleGlobalLockdown() {
  const nextLockdown = !state.systemSettings.globalLockdown;
  if (nextLockdown && !confirm('WARNING: System Global Lockdown will lock ALL room doors and deny ALL employee RFID access scanner taps immediately. Proceed?')) return;
  
  try {
    const res = await fetch('/api/system/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalLockdown: nextLockdown, actor: currentUser.name })
    });
    if (res.ok) {
      toast(nextLockdown ? 'SYSTEM GLOBALLY LOCKED DOWN!' : 'Global lockdown disabled. Doors restored.', nextLockdown ? 'danger' : 'success');
      fetchState();
    }
  } catch (err) {
    toast('Failed to change security status', 'danger');
  }
}

async function saveSystemSettings() {
  const grace = parseInt(document.getElementById('sys-grace-period').value);
  if (isNaN(grace) || grace <= 0) return toast('Invalid grace period input', 'warning');
  
  try {
    const res = await fetch('/api/system/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gracePeriod: grace, actor: currentUser.name })
    });
    if (res.ok) {
      toast('Security parameters updated successfully.', 'success');
      fetchState();
    }
  } catch (err) {
    toast('Network error', 'danger');
  }
}

// 5. Analytics Tab
function renderAdminAnalytics() {
  // Room utilization rate (based on approved bookings)
  const utilContainer = document.getElementById('analytics-utilization-bars');
  let utilHtml = '';
  
  state.rooms.forEach(r => {
    const roomBookings = state.bookings.filter(b => b.room === r.name && b.status === 'approved');
    const bookingHours = roomBookings.length * 1.0; // Average 1 hour each
    const percentage = Math.min(Math.round((bookingHours / 9) * 100), 100); // Out of 9 working hours (9 AM to 6 PM)
    
    utilHtml += `<div class="bar-wrapper">
      <div class="bar" style="height: ${percentage}%;">
        <span class="bar-val">${percentage}%</span>
      </div>
      <span class="bar-label" title="${r.name}">${r.name}</span>
    </div>`;
  });
  
  utilContainer.innerHTML = utilHtml;

  // Card swipe summaries
  const totalScans = state.rfidLog.length;
  const granted = state.rfidLog.filter(l => l.event !== 'access-denied').length;
  const denied = state.rfidLog.filter(l => l.event === 'access-denied').length;
  
  document.getElementById('metric-total-scans').textContent = totalScans;
  document.getElementById('metric-access-granted').textContent = granted;
  document.getElementById('metric-access-denied').textContent = denied;
}

// ======================== MODALS CONTROLLERS ========================

function handleDashboardCellClick(roomName, time, dateStr = '2026-06-23') {
  const booking = state.bookings.find(bk => bk.room === roomName && bk.date === dateStr && bk.start === time);
  
  if (booking) {
    // Show booking summary modal
    const emp = state.employees.find(e => e.id === booking.empId) || { name: 'Unknown', dept: 'System' };
    
    document.getElementById('summary-booking-id').textContent = `Booking ID: #${booking.id}`;
    document.getElementById('summary-room-name').textContent = booking.room;
    document.getElementById('summary-time').textContent = `${booking.start} · ${booking.duration}`;
    document.getElementById('summary-employee').textContent = `${emp.name} (${emp.dept})`;
    
    const emailField = document.getElementById('summary-email');
    if (emailField) {
      emailField.textContent = emp.email || (emp.username ? `${emp.username}@e-conference.com` : 'no-email@e-conference.com');
    }
    
    const statusContainer = document.getElementById('summary-status');
    statusContainer.innerHTML = statusBadge(booking.status);
    
    document.getElementById('summary-purpose').textContent = booking.purpose || 'No description provided.';
    
    const modalContainer = document.querySelector('#booking-summary-modal .modal');
    if (modalContainer) {
      modalContainer.classList.remove('status-pending', 'status-approved', 'status-rejected', 'status-checkedin', 'status-completed');
      modalContainer.classList.add(`status-${booking.status}`);
    }
    
    const modalIcon = document.querySelector('#booking-summary-modal .modal-icon');
    if (modalIcon) {
      if (booking.status === 'pending') {
        modalIcon.style.background = 'var(--warning-glow)';
        modalIcon.style.color = 'var(--warning)';
      } else if (booking.status === 'rejected') {
        modalIcon.style.background = 'var(--danger-glow)';
        modalIcon.style.color = 'var(--danger)';
      } else if (booking.status === 'approved') {
        modalIcon.style.background = 'var(--success-glow)';
        modalIcon.style.color = 'var(--success)';
      } else {
        modalIcon.style.background = 'var(--primary-glow)';
        modalIcon.style.color = 'var(--primary)';
      }
    }
    
    const footer = document.getElementById('summary-modal-foot');
    if (booking.empId === currentUser.id || currentUser.role === 'manager' || currentUser.role === 'admin') {
      footer.innerHTML = `
        <button class="btn btn-danger" onclick="cancelSummaryBooking(${booking.id})">Cancel Booking</button>
        <button class="btn btn-outline" onclick="closeSummaryModal()">Close</button>
      `;
    } else {
      footer.innerHTML = `
        <button class="btn btn-outline" style="width: 100%;" onclick="closeSummaryModal()">Close</button>
      `;
    }
    
    document.getElementById('booking-summary-modal').classList.add('open');
  } else {
    // Open Quick Booking Modal with prefilled parameters
    const matchFloor = roomName.match(/Floor (\d+)/);
    const floorVal = matchFloor ? matchFloor[1] : '1';
    
    const roomType = roomName.replace(/Floor \d+\s+/, '');
    
    document.getElementById('m-floor').value = floorVal;
    document.getElementById('m-type').value = roomType;
    document.getElementById('m-time').value = time;
    document.getElementById('m-date').value = dateStr; // Prefill the clicked date
    updateQuickBookResolution();
    
    const mPurposeSelect = document.getElementById('m-purpose-select');
    if (mPurposeSelect) {
      mPurposeSelect.value = 'Client meeting';
      document.getElementById('m-purpose-custom-container').style.display = 'none';
      document.getElementById('m-purpose-custom').value = '';
    }

    document.getElementById('book-modal').classList.add('open');
  }
}

function closeSummaryModal() {
  document.getElementById('booking-summary-modal').classList.remove('open');
}

async function cancelSummaryBooking(id) {
  if (!confirm('Are you sure you want to cancel this reservation?')) return;
  closeSummaryModal();
  await cancelBooking(id);
}

// 1. Booking Modals
function openBookModal() {
  document.getElementById('m-floor').value = '1';
  document.getElementById('m-type').value = 'CR';
  updateQuickBookResolution();
  
  // Initialize purpose fields
  const mPurposeSelect = document.getElementById('m-purpose-select');
  if (mPurposeSelect) {
    mPurposeSelect.value = 'Client meeting';
    document.getElementById('m-purpose-custom-container').style.display = 'none';
    document.getElementById('m-purpose-custom').value = '';
  }

  document.getElementById('book-modal').classList.add('open');
}

function updateQuickBookResolution() {
  const floor = document.getElementById('m-floor').value;
  const type = document.getElementById('m-type').value;
  const roomName = `Floor ${floor} ${type}`;
  document.getElementById('m-resolved-room').value = roomName;
}

function closeModal() {
  document.getElementById('book-modal').classList.remove('open');
}

async function submitQuickBooking() {
  const roomName = document.getElementById('m-resolved-room').value;
  const date = document.getElementById('m-date').value;
  const time = document.getElementById('m-time').value;
  const duration = document.getElementById('m-duration').value;
  
  const mPurposeSelect = document.getElementById('m-purpose-select');
  let purpose = 'Client meeting';
  if (mPurposeSelect) {
    purpose = mPurposeSelect.value;
    if (purpose === 'More') {
      purpose = document.getElementById('m-purpose-custom').value.trim() || 'More';
    }
  }
  
  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empId: currentUser.id,
        room: roomName,
        date,
        start: time,
        duration,
        purpose,
        status: (currentRole === 'manager' || currentRole === 'admin') ? 'approved' : 'pending'
      })
    });
    if (res.ok) {
      toast('Booking request submitted!', 'success');
      closeModal();
      fetchState();
    } else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.message || 'API error', 'danger');
    }
  } catch (err) {
    toast('API error', 'danger');
  }
}

// Admin booking modal
function openAdminAddBookingModal() {
  const userSelect = document.getElementById('admin-booking-user');
  let userHtml = '';
  state.employees.forEach(e => {
    userHtml += `<option value="${e.id}">${e.name} (${e.role})</option>`;
  });
  userSelect.innerHTML = userHtml;

  document.getElementById('admin-booking-floor').value = '1';
  document.getElementById('admin-booking-type').value = 'CR';
  updateAdminBookResolution();

  // Clear fields
  document.getElementById('admin-booking-id').value = '';
  const adminPurposeSelect = document.getElementById('admin-booking-purpose-select');
  if (adminPurposeSelect) {
    adminPurposeSelect.value = 'Client meeting';
    document.getElementById('admin-booking-purpose-custom-container').style.display = 'none';
    document.getElementById('admin-booking-purpose-custom').value = '';
  }
  document.getElementById('admin-booking-status').value = 'approved';
  document.getElementById('admin-booking-title').textContent = 'Create Administrative Reservation';

  document.getElementById('admin-booking-modal').classList.add('open');
}

function updateAdminBookResolution() {
  const floor = document.getElementById('admin-booking-floor').value;
  const type = document.getElementById('admin-booking-type').value;
  const roomName = `Floor ${floor} ${type}`;
  document.getElementById('admin-booking-resolved-room').value = roomName;
}

function openAdminEditBookingModal(bookingId) {
  const b = state.bookings.find(bk => bk.id === bookingId);
  if (!b) return;

  openAdminAddBookingModal(); // Loads lists
  
  document.getElementById('admin-booking-id').value = b.id;
  document.getElementById('admin-booking-user').value = b.empId;
  
  const parts = b.room.split(' ');
  if (parts.length >= 3) {
    document.getElementById('admin-booking-floor').value = parts[1];
    document.getElementById('admin-booking-type').value = parts.slice(2).join(' ');
  }
  updateAdminBookResolution();
  
  document.getElementById('admin-booking-date').value = b.date;
  document.getElementById('admin-booking-start').value = b.start;
  document.getElementById('admin-booking-duration').value = b.duration;
  document.getElementById('admin-booking-status').value = b.status;
  
  const adminPurposeSelect = document.getElementById('admin-booking-purpose-select');
  if (adminPurposeSelect) {
    const predefined = ["Client meeting", "Calling", "Board Meeting", "Group Discussion"];
    if (predefined.includes(b.purpose)) {
      adminPurposeSelect.value = b.purpose;
      document.getElementById('admin-booking-purpose-custom-container').style.display = 'none';
      document.getElementById('admin-booking-purpose-custom').value = '';
    } else {
      adminPurposeSelect.value = 'More';
      document.getElementById('admin-booking-purpose-custom-container').style.display = 'block';
      document.getElementById('admin-booking-purpose-custom').value = b.purpose;
    }
  }
  
  document.getElementById('admin-booking-title').textContent = 'Edit/Reschedule Reservation';
}

function closeAdminBookingModal() {
  document.getElementById('admin-booking-modal').classList.remove('open');
}

async function saveAdminBookingSubmit() {
  const id = document.getElementById('admin-booking-id').value;
  const empId = document.getElementById('admin-booking-user').value;
  const room = document.getElementById('admin-booking-resolved-room').value;
  const date = document.getElementById('admin-booking-date').value;
  const start = document.getElementById('admin-booking-start').value;
  const duration = document.getElementById('admin-booking-duration').value;
  const status = document.getElementById('admin-booking-status').value;
  
  const adminPurposeSelect = document.getElementById('admin-booking-purpose-select');
  let purpose = 'Client meeting';
  if (adminPurposeSelect) {
    purpose = adminPurposeSelect.value;
    if (purpose === 'More') {
      purpose = document.getElementById('admin-booking-purpose-custom').value.trim() || 'More';
    }
  }
  
  const payload = { empId, room, date, start, duration, status, purpose, actor: currentUser.name };
  
  try {
    let res;
    if (id) {
      // Edit
      res = await fetch(`/api/bookings/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      // Add new
      res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    
    if (res.ok) {
      toast('Booking updated successfully.', 'success');
      closeAdminBookingModal();
      fetchState();
    } else {
      const errData = await res.json().catch(() => ({}));
      toast(errData.message || 'API write failed', 'danger');
    }
  } catch (err) {
    toast('API write failed', 'danger');
  }
}

async function deleteBooking(id) {
  if (!confirm('Force cancel this reservation?')) return;
  try {
    const res = await fetch(`/api/bookings/${id}?actor=${encodeURIComponent(currentUser.name)}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      toast('Booking deleted from logs.', 'info');
      fetchState();
    }
  } catch (err) {
    toast('Error', 'danger');
  }
}

// 2. Room Modals
function openAddRoomModal() {
  document.getElementById('room-modal-id').value = '';
  document.getElementById('room-modal-name').value = '';
  document.getElementById('room-modal-capacity').value = 10;
  document.getElementById('room-modal-lock').value = 'Normal';
  document.getElementById('room-modal-title').textContent = 'Create New Meeting Room';
  document.getElementById('room-modal').classList.add('open');
}

function openEditRoomModal(id) {
  const rm = state.rooms.find(r => r.id === id);
  if (!rm) return;
  
  document.getElementById('room-modal-id').value = rm.id;
  document.getElementById('room-modal-name').value = rm.name;
  document.getElementById('room-modal-capacity').value = rm.capacity;
  document.getElementById('room-modal-lock').value = rm.lockStatus;
  document.getElementById('room-modal-title').textContent = `Edit Room details (${rm.id})`;
  document.getElementById('room-modal').classList.add('open');
}

function closeRoomModal() {
  document.getElementById('room-modal').classList.remove('open');
}

async function saveRoomSubmit() {
  const id = document.getElementById('room-modal-id').value;
  const name = document.getElementById('room-modal-name').value;
  const capacity = parseInt(document.getElementById('room-modal-capacity').value);
  const lockStatus = document.getElementById('room-modal-lock').value;
  
  if (!name || isNaN(capacity)) return toast('Name and Capacity are required.', 'warning');
  
  const payload = { name, capacity, lockStatus, actor: currentUser.name };
  
  try {
    let res;
    if (id) {
      res = await fetch(`/api/rooms/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    
    if (res.ok) {
      toast('Room saved successfully.', 'success');
      closeRoomModal();
      fetchState();
    }
  } catch (err) {
    toast('Database failed to write room details.', 'danger');
  }
}

async function deleteRoom(id) {
  if (!confirm('Warning: Deleting this room will discard all associated schedules. Proceed?')) return;
  try {
    const res = await fetch(`/api/rooms/${id}?actor=${encodeURIComponent(currentUser.name)}`, { method: 'DELETE' });
    if (res.ok) {
      toast('Room deleted.', 'info');
      fetchState();
    }
  } catch (err) {
    toast('API error', 'danger');
  }
}

// 3. Employee Modals
function openAddEmpModal() {
  document.getElementById('emp-modal-id').value = '';
  document.getElementById('emp-modal-name').value = '';
  document.getElementById('emp-modal-dept').value = '';
  document.getElementById('emp-modal-tag').value = '';
  document.getElementById('emp-modal-role').value = 'employee';
  document.getElementById('emp-modal-title').textContent = 'Add Employee Badge';
  document.getElementById('emp-modal').classList.add('open');
}

function openEditEmpModal(id) {
  const emp = state.employees.find(e => e.id === id);
  if (!emp) return;
  
  document.getElementById('emp-modal-id').value = emp.id;
  document.getElementById('emp-modal-name').value = emp.name;
  document.getElementById('emp-modal-dept').value = emp.dept;
  document.getElementById('emp-modal-tag').value = emp.tag;
  document.getElementById('emp-modal-role').value = emp.role;
  document.getElementById('emp-modal-title').textContent = `Edit Badge Details (${emp.id})`;
  document.getElementById('emp-modal').classList.add('open');
}

function closeEmpModal() {
  document.getElementById('emp-modal').classList.remove('open');
}

async function saveEmpSubmit() {
  const id = document.getElementById('emp-modal-id').value;
  const name = document.getElementById('emp-modal-name').value;
  const dept = document.getElementById('emp-modal-dept').value;
  const tag = document.getElementById('emp-modal-tag').value;
  const role = document.getElementById('emp-modal-role').value;
  
  if (!name || !tag) return toast('Name and RFID UID Tag are required.', 'warning');
  
  const payload = { name, dept, tag, role, actor: currentUser.name };
  
  try {
    let res;
    if (id) {
      res = await fetch(`/api/employees/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    
    if (res.ok) {
      toast('Security profile saved.', 'success');
      closeEmpModal();
      fetchState();
    }
  } catch (err) {
    toast('API error', 'danger');
  }
}

async function deleteEmp(id) {
  if (!confirm('Deregister this employee and scrap RFID access rights?')) return;
  try {
    const res = await fetch(`/api/employees/${id}?actor=${encodeURIComponent(currentUser.name)}`, { method: 'DELETE' });
    if (res.ok) {
      toast('User deleted.', 'info');
      fetchState();
    }
  } catch (err) {
    toast('Error', 'danger');
  }
}

// ======================== HELPERS ========================

function statusBadge(s) {
  const map = {
    pending: '<span class="badge badge-pending">Pending</span>',
    approved: '<span class="badge badge-approved">Approved</span>',
    rejected: '<span class="badge badge-rejected">Rejected</span>',
    checkedin: '<span class="badge badge-checkedin">Active</span>',
    completed: '<span class="badge badge-completed">Completed</span>'
  };
  return map[s] || s;
}

function toast(msg, type = 'info') {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) return;

  const icons = {
    success: '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" fill="none"/></svg>',
    danger: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" fill="none"/></svg>',
    warning: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = (icons[type] || icons.info) + `<span>${msg}</span>`;
  wrap.appendChild(t);
  
  setTimeout(() => {
    t.remove();
  }, 3500);
}

function hexToHsl(hex) {
  // Convert hex to rgb first
  let r = 0, g = 0, b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.substring(1, 3), 16);
    g = parseInt(hex.substring(3, 5), 16);
    b = parseInt(hex.substring(5, 7), 16);
  }
  // Convert rgb to hsl
  r /= 255;
  g /= 255;
  b /= 255;
  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;

  if (max === min) {
    h = s = 0; // achromatic
  } else {
    let d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100)
  };
}

function applyBranding(settings) {
  if (!settings) return;
  
  // Apply font family
  document.body.style.fontFamily = `"${settings.fontFamily || 'Plus Jakarta Sans'}", system-ui, -apple-system, sans-serif`;
  
  // Apply logo text (top header brand identity - defaults to "E-Conference")
  const logoTextEl = document.querySelector('.logo-text');
  if (logoTextEl) {
    logoTextEl.textContent = (settings.companyName && settings.companyName.trim() !== '') ? settings.companyName : 'E-Conference';
  }
  
  // Apply logo image in top header - uses custom logo if provided, otherwise default SVG vector mark
  const logoIconEl = document.querySelector('.logo-icon');
  if (logoIconEl) {
    if (settings.logoUrl && settings.logoUrl.trim() !== '') {
      logoIconEl.classList.add('has-image');
      logoIconEl.innerHTML = `<img src="${settings.logoUrl.trim()}" alt="Logo" style="width: 100%; height: 100%; object-fit: contain;">`;
    } else {
      logoIconEl.classList.remove('has-image');
      logoIconEl.innerHTML = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" stroke="white" stroke-width="2" fill="none"/><path d="M9 9h6M9 13h6M9 17h4" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
    }
  }

  // Hide duplicate footer logo element beneath admin console (as it is now integrated at the top)
  const footerLogoEl = document.getElementById('sidebar-footer-logo');
  if (footerLogoEl) {
    footerLogoEl.style.display = 'none';
  }

  // Apply secondary custom company logo and name above employee details
  const clientLogoEl = document.getElementById('sidebar-client-logo');
  const clientLogoImgEl = document.getElementById('sidebar-client-logo-img');
  const clientLogoTextEl = document.getElementById('sidebar-client-logo-text');
  if (clientLogoEl && clientLogoImgEl && clientLogoTextEl) {
    const hasCustomName = settings.clientName && settings.clientName.trim() !== '';
    const hasCustomLogo = settings.clientLogoUrl && settings.clientLogoUrl.trim() !== '';
    
    if (hasCustomName || hasCustomLogo) {
      if (hasCustomLogo) {
        clientLogoImgEl.src = settings.clientLogoUrl.trim();
        clientLogoImgEl.style.display = 'block';
      } else {
        clientLogoImgEl.src = '';
        clientLogoImgEl.style.display = 'none';
      }
      clientLogoTextEl.textContent = hasCustomName ? settings.clientName : '';
      clientLogoEl.style.display = 'flex';
    } else {
      clientLogoEl.style.display = 'none';
      clientLogoImgEl.src = '';
      clientLogoTextEl.textContent = '';
    }
  }
  
  // Apply theme color variables (with darker shades for the Control Panel)
  let activeTheme;
  const legacyThemes = {
    indigo: { primary: '#4F46E5', dark: '#3730A3', darker: '#1E1B4B', sidebar: '#0e1022', light: '#EEF2FF', glow: 'rgba(79, 70, 229, 0.15)' },
    emerald: { primary: '#10B981', dark: '#047857', darker: '#064E3B', sidebar: '#051f18', light: '#ECFDF5', glow: 'rgba(16, 185, 129, 0.15)' },
    orange: { primary: '#F59E0B', dark: '#B45309', darker: '#78350F', sidebar: '#1a110a', light: '#FFFBEB', glow: 'rgba(245, 158, 11, 0.15)' },
    crimson: { primary: '#E11D48', dark: '#9F1239', darker: '#4C0519', sidebar: '#1d0a0f', light: '#FFF1F2', glow: 'rgba(225, 29, 72, 0.15)' },
    dark: { primary: '#334155', dark: '#1E293B', darker: '#0F172A', sidebar: '#0b0f19', light: '#F1F5F9', glow: 'rgba(51, 65, 85, 0.15)' }
  };

  const themeValue = settings.theme || 'indigo';
  if (themeValue.startsWith('#')) {
    const hsl = hexToHsl(themeValue);
    activeTheme = {
      primary: themeValue,
      dark: `hsl(${hsl.h}, ${hsl.s}%, ${Math.max(hsl.l - 15, 8)}%)`,
      darker: `hsl(${hsl.h}, ${hsl.s}%, ${Math.max(hsl.l - 30, 4)}%)`,
      sidebar: `hsl(${hsl.h}, ${Math.max(hsl.s - 15, 10)}%, 7%)`,
      light: `hsl(${hsl.h}, ${hsl.s}%, ${Math.min(hsl.l + 45, 96)}%)`,
      glow: `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, 0.15)`
    };
  } else {
    activeTheme = legacyThemes[themeValue] || legacyThemes.indigo;
  }
  
  document.documentElement.style.setProperty('--primary', activeTheme.primary);
  document.documentElement.style.setProperty('--primary-dark', activeTheme.dark);
  document.documentElement.style.setProperty('--primary-darker', activeTheme.darker);
  document.documentElement.style.setProperty('--sidebar-bg', activeTheme.sidebar);
  document.documentElement.style.setProperty('--primary-light', activeTheme.light);
  document.documentElement.style.setProperty('--primary-glow', activeTheme.glow);
}

// Logo upload helper utilities
let uploadedLogoBase64 = "";

function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  
  if (file.type !== "image/png") {
    toast("Please select a PNG image file.", "warning");
    input.value = "";
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function(e) {
    uploadedLogoBase64 = e.target.result;
    document.getElementById('sys-logo-url').value = uploadedLogoBase64;
    document.getElementById('logo-file-name').textContent = file.name;
    document.getElementById('btn-clear-logo').style.display = 'inline-flex';
    toast("PNG logo loaded. Save settings to apply.", "success");
  };
  reader.readAsDataURL(file);
}

function clearLogoImage() {
  uploadedLogoBase64 = "";
  document.getElementById('sys-logo-file').value = "";
  document.getElementById('sys-logo-url').value = "";
  document.getElementById('logo-file-name').textContent = "No file chosen";
  document.getElementById('btn-clear-logo').style.display = 'none';
  toast("Logo cleared. Save settings to apply.", "info");
}

// Secondary brand logo upload helper utilities
let uploadedClientLogoBase64 = "";

function handleClientLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  
  if (file.type !== "image/png") {
    toast("Please select a PNG image file.", "warning");
    input.value = "";
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function(e) {
    uploadedClientLogoBase64 = e.target.result;
    document.getElementById('sys-client-logo-url').value = uploadedClientLogoBase64;
    document.getElementById('client-logo-file-name').textContent = file.name;
    document.getElementById('btn-clear-client-logo').style.display = 'inline-flex';
    toast("Secondary PNG logo loaded. Save settings to apply.", "success");
  };
  reader.readAsDataURL(file);
}

function clearClientLogoImage() {
  uploadedClientLogoBase64 = "";
  document.getElementById('sys-client-logo-file').value = "";
  document.getElementById('sys-client-logo-url').value = "";
  document.getElementById('client-logo-file-name').textContent = "No file chosen";
  document.getElementById('btn-clear-client-logo').style.display = 'none';
  toast("Secondary logo cleared. Save settings to apply.", "info");
}
function updateThemeColorFromPicker(hexVal) {
  const btn = document.getElementById('sys-theme-color-btn');
  if (btn) {
    btn.style.background = hexVal;
  }
  const hexLabel = document.getElementById('sys-theme-color-hex');
  if (hexLabel) {
    hexLabel.textContent = hexVal.toUpperCase();
  }
}

async function saveBrandingSettings() {
  const companyName = document.getElementById('sys-company-name').value || '';
  const logoUrl = document.getElementById('sys-logo-url').value || '';
  const clientName = document.getElementById('sys-client-name').value || '';
  const clientLogoUrl = document.getElementById('sys-client-logo-url').value || '';
  const fontFamily = document.getElementById('sys-font-family').value || 'Plus Jakarta Sans';
  const themePicker = document.getElementById('sys-theme-picker');
  const theme = themePicker ? themePicker.value : '#4F46E5';
  
  try {
    const res = await fetch('/api/system/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName,
        logoUrl,
        clientName,
        clientLogoUrl,
        fontFamily,
        theme,
        actor: currentUser.name
      })
    });
    if (res.ok) {
      toast('Appearance and branding settings updated!', 'success');
      fetchState();
    } else {
      toast('Failed to save appearance parameters.', 'danger');
    }
  } catch (err) {
    toast('Network communication error.', 'danger');
  }
}
function handlePurposeSelectChange(selectEl, customContainerId) {
  const container = document.getElementById(customContainerId);
  if (selectEl.value === 'More') {
    container.style.display = 'block';
    const customInput = container.querySelector('input, textarea');
    if (customInput) customInput.focus();
  } else {
    container.style.display = 'none';
    const customInput = container.querySelector('input, textarea');
    if (customInput) customInput.value = '';
  }
}

function toggleLoginPasswordVisibility() {
  const passInput = document.getElementById('login-password');
  const icon = document.getElementById('pass-show-icon');
  if (passInput.type === 'password') {
    passInput.type = 'text';
    icon.innerHTML = `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22"/>`;
  } else {
    passInput.type = 'password';
    icon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
  }
}

let authTempUsername = '';

async function submitCredentials() {
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    return toast('Please enter username and password.', 'warning');
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    if (res.ok && data.success) {
      authTempUsername = data.username;
      
      // Load TOTP Setup data for fallback QR code scan
      document.getElementById('totp-secret-text').textContent = data.totpSecret;
      
      // QuickChart QR generation API
      const qrUrl = `https://quickchart.io/chart?cht=qr&chs=200x200&chl=${encodeURIComponent(`otpauth://totp/E-Conference:${data.username}?secret=${data.totpSecret}&issuer=E-Conference`)}`;
      document.getElementById('totp-qr').src = qrUrl;
      
      // Prefill confirmed email address
      document.getElementById('login-email').value = data.email || '';
      
      // Reset Step 2 view state
      document.getElementById('totp-digits-container').style.display = 'block';
      document.getElementById('totp-qr-collapse').style.display = 'none';
      document.getElementById('btn-toggle-qr').textContent = 'Or, use Authenticator App (QR Code)';
      
      // Clear TOTP inputs
      document.querySelectorAll('.totp-digit-input').forEach(input => {
        input.value = '';
      });

      // Transition steps
      document.getElementById('login-step-1').style.display = 'none';
      document.getElementById('login-step-2').style.display = 'block';
      
      // Focus email address field
      document.getElementById('login-email').focus();
      
      toast('Password verified. Please confirm email to receive code.', 'success');
    } else {
      toast(data.message || 'Invalid username or password.', 'danger');
    }
  } catch (err) {
    toast('Network error during login.', 'danger');
  }
}

function toggleLoginSignUp(event, mode) {
  if (event) event.preventDefault();
  const loginStep1 = document.getElementById('login-step-1');
  const loginSignup = document.getElementById('login-signup');
  
  // Clear forms on toggle
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('signup-name').value = '';
  document.getElementById('signup-username').value = '';
  document.getElementById('signup-email').value = '';
  document.getElementById('signup-password').value = '';
  document.getElementById('signup-password-confirm').value = '';
  
  if (mode === 'signup') {
    loginStep1.style.display = 'none';
    loginSignup.style.display = 'block';
    document.getElementById('signup-name').focus();
  } else {
    loginSignup.style.display = 'none';
    loginStep1.style.display = 'block';
    document.getElementById('login-username').focus();
  }
}

async function submitRegister() {
  const name = document.getElementById('signup-name').value.trim();
  const username = document.getElementById('signup-username').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const passwordConfirm = document.getElementById('signup-password-confirm').value;

  if (!name || !username || !email || !password || !passwordConfirm) {
    return toast('Please fill in all fields.', 'warning');
  }

  // Basic email validation
  if (!email.includes('@') || !email.includes('.')) {
    return toast('Please enter a valid email address.', 'warning');
  }

  if (password !== passwordConfirm) {
    return toast('Passwords do not match.', 'danger');
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, email, password })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      toast(data.message, 'success');
      
      // Transition back to login prefilled
      toggleLoginSignUp(null, 'login');
      document.getElementById('login-username').value = data.username;
      document.getElementById('login-password').focus();
    } else {
      toast(data.message || 'Registration failed.', 'danger');
    }
  } catch (err) {
    toast('Network error during registration.', 'danger');
  }
}

function toggleQrCodeCollapse(event) {
  if (event) event.preventDefault();
  const qrDiv = document.getElementById('totp-qr-collapse');
  const toggleLink = document.getElementById('btn-toggle-qr');
  if (qrDiv.style.display === 'none') {
    qrDiv.style.display = 'block';
    toggleLink.textContent = 'Hide Authenticator App QR Code';
  } else {
    qrDiv.style.display = 'none';
    toggleLink.textContent = 'Or, use Authenticator App (QR Code)';
  }
}

async function sendTotpEmail() {
  const emailInput = document.getElementById('login-email');
  const confirmedEmail = emailInput.value.trim();
  
  if (!confirmedEmail) {
    return toast('Please enter a valid email address.', 'warning');
  }
  
  const sendBtn = document.getElementById('btn-send-totp');
  const originalText = sendBtn.innerHTML;
  
  try {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    
    const res = await fetch('/api/auth/send-totp-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: authTempUsername, email: confirmedEmail })
    });
    
    const data = await res.json();
    if (res.ok && data.success) {
      toast('Verification code sent successfully!', 'success');
      
      // Show simulated email preview notification banner
      showSimulatedEmailToast(data.email, data.code);
      
      // Reveal 6-digit inputs container
      document.getElementById('totp-digits-container').style.display = 'block';
      
      // Focus first digit box
      const digitInputs = document.querySelectorAll('.totp-digit-input');
      if (digitInputs.length > 0) {
        digitInputs[0].focus();
      }
    } else {
      toast(data.message || 'Failed to send verification code.', 'danger');
    }
  } catch (err) {
    toast('Network error sending verification code.', 'danger');
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = originalText;
  }
}

function showSimulatedEmailToast(email, code) {
  const container = document.getElementById('email-notification-wrap');
  if (!container) return;

  const card = document.createElement('div');
  card.className = 'email-notification-card';
  
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  card.innerHTML = `
    <div class="email-notif-header">
      <div class="email-notif-title-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        <span>Outlook Mail</span>
      </div>
      <div class="email-notif-time-wrap">
        <span class="email-notif-time">${timeStr}</span>
        <button class="email-notif-close" onclick="closeEmailNotif(this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <div class="email-notif-content">
      <div class="email-notif-sender">From: <strong>security@e-conference.com</strong></div>
      <div class="email-notif-subject">🔐 E-Conference Verification Code</div>
      <div class="email-notif-body">
        Hello user,<br>
        Your dynamic two-factor verification code is:
        <div style="text-align: center; margin: 8px 0 4px 0;">
          <span class="email-notif-otp-val">${code}</span>
        </div>
        <span style="font-size:10px; color:var(--slate-400);">This code expires in 30 seconds. Double-click to select and copy.</span>
      </div>
    </div>
  `;

  container.appendChild(card);

  // Auto dismiss after 15 seconds
  setTimeout(() => {
    if (card.parentNode) {
      card.classList.add('slide-out');
      setTimeout(() => {
        if (card.parentNode) {
          container.removeChild(card);
        }
      }, 350);
    }
  }, 15000);
}

// Global window helper to close simulated email card
window.closeEmailNotif = function(btn) {
  const card = btn.closest('.email-notification-card');
  if (card) {
    card.classList.add('slide-out');
    setTimeout(() => {
      if (card.parentNode) {
        card.parentNode.removeChild(card);
      }
    }, 350);
  }
};

function handleTotpInput(input, event, index) {
  const value = input.value;
  const digits = document.querySelectorAll('.totp-digit-input');

  // Allow only digits
  if (value && !/^\d$/.test(value)) {
    input.value = '';
    return;
  }

  if (event.key === 'Backspace') {
    if (index > 0) {
      digits[index - 1].focus();
    }
  } else if (value.length === 1) {
    if (index < 5) {
      digits[index + 1].focus();
    } else if (index === 5) {
      submitTotpCode();
    }
  }
}

async function submitTotpCode() {
  const digits = document.querySelectorAll('.totp-digit-input');
  let code = '';
  digits.forEach(input => {
    code += input.value;
  });

  if (code.length < 6) {
    return toast('Please enter a 6-digit verification code.', 'warning');
  }

  try {
    const res = await fetch('/api/auth/verify-totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: authTempUsername, code })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      toast('Verification successful!', 'success');
      localStorage.setItem('currentUser', JSON.stringify(data.user));
      
      // Hide login overlay
      document.getElementById('login-overlay').style.display = 'none';

      // Remove simulated email toasts if any are visible
      const emailWrap = document.getElementById('email-notification-wrap');
      if (emailWrap) emailWrap.innerHTML = '';

      // Load states
      fetchState();
    } else {
      // Flash inputs red
      digits.forEach(input => {
        input.style.borderColor = 'var(--danger)';
        input.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.2)';
        input.value = '';
      });
      setTimeout(() => {
        digits.forEach(input => {
          input.style.borderColor = '';
          input.style.boxShadow = '';
        });
        digits[0].focus();
      }, 800);
      
      toast(data.message || 'Invalid verification code.', 'danger');
    }
  } catch (err) {
    toast('Network error verifying code.', 'danger');
  }
}

function goBackToCredentials(event) {
  if (event) event.preventDefault();
  document.getElementById('login-step-2').style.display = 'none';
  document.getElementById('login-step-1').style.display = 'block';
  
  // Clear inputs and containers
  document.querySelectorAll('.totp-digit-input').forEach(input => {
    input.value = '';
  });
  document.getElementById('totp-digits-container').style.display = 'block';
  document.getElementById('totp-qr-collapse').style.display = 'none';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-password').focus();
  
  const signupContainer = document.getElementById('login-signup');
  if (signupContainer) signupContainer.style.display = 'none';
  
  // Remove simulated email notifications
  const emailWrap = document.getElementById('email-notification-wrap');
  if (emailWrap) emailWrap.innerHTML = '';
}

function logout() {
  localStorage.removeItem('currentUser');
  currentUser = null;
  
  // Clear fields and views
  document.getElementById('login-password').value = '';
  document.getElementById('login-email').value = '';
  
  document.querySelectorAll('.totp-digit-input').forEach(input => {
    input.value = '';
  });
  
  const digitsContainer = document.getElementById('totp-digits-container');
  if (digitsContainer) digitsContainer.style.display = 'block';
  
  const qrCollapse = document.getElementById('totp-qr-collapse');
  if (qrCollapse) qrCollapse.style.display = 'none';
  
  const step2 = document.getElementById('login-step-2');
  if (step2) step2.style.display = 'none';
  const step1 = document.getElementById('login-step-1');
  if (step1) step1.style.display = 'block';
  
  const signupContainer = document.getElementById('login-signup');
  if (signupContainer) signupContainer.style.display = 'none';

  // Remove simulated email notifications
  const emailWrap = document.getElementById('email-notification-wrap');
  if (emailWrap) emailWrap.innerHTML = '';

  // Show overlay
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.style.display = 'flex';
  const userField = document.getElementById('login-username');
  if (userField) userField.focus();
  
  toast('Logged out successfully.', 'info');
  fetchState();
}

// ======================== INITIALIZE ========================
document.addEventListener('DOMContentLoaded', () => {
  fetchState();
  // Poll state every 4 seconds for real-time multiplayer coordination feel
  setInterval(fetchState, 4000);
});
