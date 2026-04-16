const express = require('express');
const path = require('path');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TW_DOMAIN = process.env.TW_DOMAIN || 'deksia';
const PORT = process.env.PORT || 3847;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Public client (for auth verification)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Service client (for Vault access - never exposed to frontend)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Cached admin TW key (loaded from Vault on startup)
let TW_ADMIN_KEY = null;

async function loadAdminKey() {
  const { data, error } = await supabaseAdmin.rpc('get_tw_admin_key');
  if (error || !data) {
    console.error('Failed to load TW admin key from Vault:', error?.message);
    process.exit(1);
  }
  TW_ADMIN_KEY = data;
  console.log('  TW admin key loaded from Vault');
}

// --- Teamwork API helpers ---

function twFetch(endpoint, apiKey, domain) {
  const auth = Buffer.from(`${apiKey}:x`).toString('base64');
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `https://${domain || TW_DOMAIN}.teamwork.com`);
    const req = https.request(url, {
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function twPost(endpoint, body, apiKey, domain) {
  const auth = Buffer.from(`${apiKey}:x`).toString('base64');
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `https://${domain || TW_DOMAIN}.teamwork.com`);
    const postData = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function twPut(endpoint, body, apiKey, domain) {
  const auth = Buffer.from(`${apiKey}:x`).toString('base64');
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `https://${domain || TW_DOMAIN}.teamwork.com`);
    const putData = body ? JSON.stringify(body) : '';
    const req = https.request(url, {
      method: 'PUT',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putData) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(putData);
    req.end();
  });
}

function twPatch(endpoint, body, apiKey, domain) {
  const auth = Buffer.from(`${apiKey}:x`).toString('base64');
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `https://${domain || TW_DOMAIN}.teamwork.com`);
    const patchData = body ? JSON.stringify(body) : '';
    const req = https.request(url, {
      method: 'PATCH',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(patchData) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(patchData);
    req.end();
  });
}

// --- Rate limiter ---
const apiQueue = [];
let processing = false;

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    apiQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing || apiQueue.length === 0) return;
  processing = true;
  const { fn, resolve, reject } = apiQueue.shift();
  try { resolve(await fn()); } catch (err) { reject(err); }
  setTimeout(() => { processing = false; processQueue(); }, 200);
}

// --- Auth middleware ---
// Extracts Supabase user + their Teamwork credentials from the Authorization header

async function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No auth token' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });

    // Get profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile) return res.status(401).json({ error: 'No profile found' });

    // Get user's own TW key from Vault
    const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userTwKey } = await userSupabase.rpc('get_my_tw_api_key');

    req.user = profile;
    req.twKey = userTwKey || TW_ADMIN_KEY; // Fall back to admin key for shared endpoints
    req.twDomain = profile.teamwork_domain || TW_DOMAIN;
    req.twUserId = profile.teamwork_user_id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// --- Public routes ---

// Config (public - just returns Supabase URL for frontend)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    twDomain: TW_DOMAIN,
  });
});

// Validate a TW API key during onboarding
app.post('/api/validate-tw-key', async (req, res) => {
  try {
    const { apiKey } = req.body;
    const result = await twFetch('/me.json', apiKey, TW_DOMAIN);
    if (result.person) {
      res.json({
        valid: true,
        person: {
          id: result.person.id,
          firstName: result.person['first-name'],
          lastName: result.person['last-name'],
          email: result.person['email-address'],
        }
      });
    } else {
      res.json({ valid: false });
    }
  } catch {
    res.json({ valid: false });
  }
});

// --- Authenticated routes ---

// Profile
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ profile: req.user });
});

// Notifications — uses admin key, returns admin's notifications
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    let qs = `pageSize=${req.query.pageSize || 50}`;
    if (req.query.cursor) qs += `&cursor=${req.query.cursor}`;
    const result = await twFetch(`/projects/api/v3/notifications.json?${qs}`, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark single notification read
app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const result = await enqueue(() => twPatch(`/projects/api/v3/notifications/${req.params.id}.json`, {
      notification: { read: true }
    }, req.twKey, req.twDomain));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tasks
app.get('/api/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const result = await twFetch(`/projects/api/v3/tasks/${req.params.id}.json`, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/my-tasks', authMiddleware, async (req, res) => {
  try {
    const uid = req.twUserId;
    const from = req.query.from || '';
    const to = req.query.to || '';
    let url = `/projects/api/v3/tasks.json?responsiblePartyIds=${uid}&includeCompletedTasks=false&includeTemplates=false&pageSize=250`;
    if (from) url += `&dueDateFrom=${from}`;
    if (to) url += `&dueDateTo=${to}`;
    const result = await twFetch(url, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/my-tasks/overdue', authMiddleware, async (req, res) => {
  try {
    const uid = req.twUserId;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10).replace(/-/g,'');
    const result = await twFetch(`/projects/api/v3/tasks.json?responsiblePartyIds=${uid}&includeCompletedTasks=false&includeTemplates=false&pageSize=250&dueDateTo=${yesterday}&dueDateFrom=20260101`, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/complete', authMiddleware, async (req, res) => {
  try {
    const result = await enqueue(() => twPut(`/tasks/${req.params.id}/complete.json`, null, req.twKey, req.twDomain));
    res.json(result || { ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comments
app.get('/api/tasks/:id/comments', authMiddleware, async (req, res) => {
  try {
    const result = await twFetch(`/projects/api/v3/tasks/${req.params.id}/comments.json?pageSize=100`, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/milestones/:id/comments', authMiddleware, async (req, res) => {
  try {
    const result = await twFetch(`/projects/api/v3/milestones/${req.params.id}/comments.json?pageSize=100`, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/:id/comments', authMiddleware, async (req, res) => {
  try {
    const comment = { body: req.body.body, 'content-type': req.body.contentType || 'TEXT' };
    if (req.body.notifyIds && req.body.notifyIds.length) comment.notify = req.body.notifyIds.join(',');
    const result = await enqueue(() => twPost(`/tasks/${req.params.id}/comments.json`, { comment }, req.twKey, req.twDomain));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/milestones/:id/comments', authMiddleware, async (req, res) => {
  try {
    const comment = { body: req.body.body, 'content-type': req.body.contentType || 'TEXT' };
    if (req.body.notifyIds && req.body.notifyIds.length) comment.notify = req.body.notifyIds.join(',');
    const result = await enqueue(() => twPost(`/milestones/${req.params.id}/comments.json`, { comment }, req.twKey, req.twDomain));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// People (for @mentions)
app.get('/api/people', authMiddleware, async (req, res) => {
  try {
    const result = await twFetch(`/projects/api/v3/people.json?pageSize=100`, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const result = await twFetch(`/projects/api/v3/people/${req.params.id}.json`, req.twKey, req.twDomain);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Bug reports ---
app.post('/api/bugs', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bug_reports')
      .insert({ user_id: req.user.id, title: req.body.title, description: req.body.description })
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bugs', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bug_reports')
      .select('*, profiles(full_name)')
      .order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin/Manager routes ---

app.get('/api/admin/users', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or Manager only' });
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, onboarded, teamwork_user_id, created_at')
      .order('full_name');
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fetch tasks for any user (admin key, for bandwidth view)
app.get('/api/admin/user-tasks', authMiddleware, async (req, res) => {
  if (!['admin','manager'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or Manager only' });
  try {
    const uid = req.query.userId;
    const from = req.query.from || '';
    const to = req.query.to || '';
    let url = `/projects/api/v3/tasks.json?responsiblePartyIds=${uid}&includeCompletedTasks=false&includeTemplates=false&pageSize=250`;
    if (from) url += `&dueDateFrom=${from}`;
    if (to) url += `&dueDateTo=${to}`;
    const result = await twFetch(url, TW_ADMIN_KEY, TW_DOMAIN);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Load admin key from Vault, then start
loadAdminKey().then(() => {
  app.listen(PORT, () => {
    console.log(`  TW Inbox running at http://localhost:${PORT}`);
    console.log(`  Supabase: ${SUPABASE_URL}\n`);
  });
});
