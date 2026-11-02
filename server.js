require('dotenv').config();
const { MongoClient } = require('mongodb');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const express = require('express');
const cors = require('cors');

// Firebase key: from env variable when hosted (Render), else from the local file
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

// Fixes keys whose line breaks were pasted as the text \n
if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}

initializeApp({ credential: cert(serviceAccount) });
// This MUST say optimes-notification (the same Firebase project as the app)
console.log('Firebase project:', serviceAccount.project_id);

const SITE = (process.env.WEBSITE_URL || '').replace(/\/$/, '');

// ---------------------------------------------------------------
// WHAT TO WATCH
// updates:true  -> notify on new document AND when "status" changes
// updates:false -> notify on new document only
// ---------------------------------------------------------------
const WATCH = [
  { db: 'DB_CMMS', collections: ['workorders', 'workrequests'], updates: true },
  { db: 'DB_MASTERS', collections: ['work_permit'], updates: true },
  {
    db: 'DB_SAFETY',
    all: true,
    exclude: ['agent_recommendation', 'occupancies'],
    updates: false,
  },
];

// ---------------------------------------------------------------
// WEBSITE PAGE FOR EACH COLLECTION
// ---------------------------------------------------------------
const PATHS = {
  workorders: '/workorders',
  workrequests: '/workrequests',
  work_permit: '/work-permit',
  fire: '/safety/fire',
  forklift: '/safety/forklift',
  gas_leakage: '/safety/gas-leakage',
  incident_management: '/safety/incidents',
  occupancies: '/safety/occupancy',
  safety_observation: '/safety/observation',
  slip: '/safety/slip',
  unauthorized_entries: '/safety/unauthorized',
  ppe_kit: '/safety/ppe',
  default: '/safety',
};

const join = (...a) => a.filter(Boolean).join(' • ');
const pretty = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const FORMATTERS = {
  workorders: (d) => ({
    category: 'Work Order',
    title: `Work Order ${d.workorderid || ''}`.trim(),
    message: join(d.workordertype, d.department, d.priority, d.status && `Status: ${d.status}`),
  }),
  workrequests: (d) => ({
    category: 'Work Request',
    title: `Work Request ${d.workorderId || ''}`.trim(),
    message: join(d.workorderType, d.group, d.location, d.priority, d.status && `Status: ${d.status}`),
  }),
  work_permit: (d) => ({
    category: 'Work Permit',
    title: `Work Permit ${d.permitNumber || ''}`.trim(),
    message: join(
      (d.selectedWorkTypes || []).join(', '),
      d.activityDescription,
      d.status && `Status: ${d.status}`
    ),
  }),
  ppe_kit: (d) => {
    const items = ['hardhat', 'mask', 'safetyVest', 'safetyBoot', 'goggles', 'glass'];
    const missing = items.filter((k) => d[k] === false).join(', ');
    return {
      category: 'PPE',
      title: `PPE violation: ${d.personName || 'Unknown'}`,
      message: join(missing && `Missing: ${missing}`, d.camera, d.priority),
    };
  },
};

const PICK = [
  'scenario', 'description', 'type', 'title', 'incidentType', 'observation',
  'zone', 'area', 'location', 'camera', 'personName', 'priority', 'severity', 'status',
];

function format(collection, d) {
  const f = FORMATTERS[collection];
  if (f) return { ...f(d), path: PATHS[collection] || PATHS.default };

  const parts = PICK.map((k) => d[k])
    .filter((v) => v && typeof v !== 'object')
    .map(String)
    .slice(0, 4);

  return {
    category: pretty(collection),
    title: `${pretty(collection)} alert`,
    message: parts.join(' • '),
    path: PATHS[collection] || PATHS.default,
  };
}

// Push message for the "alerts" topic (used by the Android / iPhone apps)
function buildMessage(title, body, link, extraData = {}) {
  const message = {
    topic: 'alerts',
    notification: { title, body },
    data: { link: String(link || ''), ...extraData },
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };
  if (link && link.startsWith('https://')) {
    message.webpush = { fcmOptions: { link } };
  }
  return message;
}

(async () => {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  console.log('MongoDB connected');

  const notifyCol = client.db('optimes_notify').collection('notifications');
  // Web browsers / iPhone web apps are stored here and messaged directly
  const tokensCol = client.db('optimes_notify').collection('web_tokens');
  await tokensCol.createIndex({ token: 1 }, { unique: true });

  const DEAD_CODES = [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/mismatched-credential',
  ];

  // Sends to every saved web token directly (no topic subscription needed)
  async function sendToWeb(title, body, link, data = {}) {
    const docs = await tokensCol.find().toArray();
    const tokens = docs.map((d) => d.token);
    if (!tokens.length) {
      console.log('Web push: no web devices registered');
      return;
    }
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const message = {
        tokens: chunk,
        notification: { title, body },
        data: { link: String(link || ''), ...data },
      };
      if (link && link.startsWith('https://')) {
        message.webpush = { fcmOptions: { link } };
      }
      const r = await getMessaging().sendEachForMulticast(message);
      const dead = [];
      r.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          console.error('Web send failed:', code, resp.error && resp.error.message);
          if (DEAD_CODES.includes(code)) dead.push(chunk[idx]);
        }
      });
      if (dead.length) await tokensCol.deleteMany({ token: { $in: dead } });
      console.log(`Web push: ${r.successCount} ok, ${r.failureCount} failed`);
    }
  }

  async function handle(ch, dbName, name) {
    try {
      const d = ch.fullDocument;
      if (!d) return;

      const isUpdate = ch.operationType !== 'insert';
      if (
        isUpdate &&
        !(ch.updateDescription && ch.updateDescription.updatedFields &&
          'status' in ch.updateDescription.updatedFields)
      ) {
        return;
      }

      const f = format(name, d);
      const title = isUpdate ? `Status update: ${f.title}` : f.title;
      const body = f.message || 'Tap to view details';
      const link = SITE + f.path;
      const extra = { category: String(f.category), id: String(d._id) };

      await notifyCol.insertOne({
        db: dbName,
        collection: name,
        docId: String(d._id),
        category: f.category,
        title,
        message: f.message,
        link,
        createdAt: new Date(),
      });

      // Android / iPhone apps (topic)
      const id = await getMessaging().send(buildMessage(title, body, link, extra));
      console.log('Sent:', `${dbName}.${name}`, '-', title, '| fcm id:', id);

      // Web / iPhone web app (direct to saved tokens)
      await sendToWeb(title, body, link, extra);
    } catch (e) {
      console.error('Send failed:', e.message);
    }
  }

  function watchCollection(dbName, name, updates) {
    const ops = updates ? ['insert', 'update'] : ['insert'];
    const stream = client
      .db(dbName)
      .collection(name)
      .watch([{ $match: { operationType: { $in: ops } } }], { fullDocument: 'updateLookup' });

    stream.on('change', (ch) => {
      console.log('Change detected:', `${dbName}.${name}`, ch.operationType);
      handle(ch, dbName, name);
    });
    stream.on('error', (e) => {
      console.error('Stream error', `${dbName}.${name}`, e.message);
      stream.close().catch(() => {});
      setTimeout(() => watchCollection(dbName, name, updates), 5000);
    });
    console.log('Watching', `${dbName}.${name}`);
  }

  for (const w of WATCH) {
    let names = w.collections || [];
    if (w.all) {
      const list = await client.db(w.db).listCollections({}, { nameOnly: true }).toArray();
      names = list
        .map((c) => c.name)
        .filter((n) => !(w.exclude || []).includes(n) && !n.startsWith('system.'));
    }
    names.forEach((n) => watchCollection(w.db, n, w.updates));
  }

  // ---------------- API used by the app ----------------
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/', (_, res) => res.send('Optimes server running'));

  app.get('/notifications', async (_, res) => {
    try {
      const docs = await notifyCol.find().sort({ createdAt: -1 }).limit(100).toArray();
      res.json(
        docs.map((d) => ({
          id: String(d._id),
          category: d.category,
          title: d.title,
          message: d.message,
          link: d.link,
          time: d.createdAt,
        }))
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Web browsers register here. The token is checked against this Firebase
  // project (dry run), then saved so alerts can be sent to it directly.
  app.post('/register', async (req, res) => {
    try {
      const token = req.body && req.body.token;
      if (!token) return res.status(400).json({ error: 'token missing' });

      try {
        await getMessaging().send(
          { token, notification: { title: 'check', body: 'check' } },
          true // dry run: nothing is delivered
        );
      } catch (e) {
        const msg = `${e.code || ''} ${e.message || ''}`.trim();
        console.error('Register check failed:', msg);
        return res.status(500).json({ error: msg });
      }

      await tokensCol.updateOne(
        { token },
        { $set: { token, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log('Web device registered:', token.slice(0, 12) + '...');

      // Optional proof: set DEBUG_WELCOME=1 in Render to send a direct
      // "Notifications enabled" push to the device that just registered.
      if (process.env.DEBUG_WELCOME === '1') {
        try {
          const welcome = {
            token,
            notification: {
              title: 'Notifications enabled',
              body: 'You will now receive Optimes alerts',
            },
          };
          if (SITE.startsWith('https://')) {
            welcome.webpush = { fcmOptions: { link: SITE } };
          }
          const id = await getMessaging().send(welcome);
          console.log('Welcome sent:', id);
        } catch (e) {
          console.error('Welcome failed:', e.code || '', e.message);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      console.error('Register failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Sends a test push WITHOUT touching MongoDB. Turned on only if TEST_KEY is set.
  // Open: https://YOUR-SERVER/test?key=YOUR_TEST_KEY
  app.get('/test', async (req, res) => {
    if (!process.env.TEST_KEY || req.query.key !== process.env.TEST_KEY) {
      return res.status(403).send('Forbidden');
    }
    try {
      const title = 'Test alert';
      const body = 'If you see this, push notifications work';
      const id = await getMessaging().send(buildMessage(title, body, SITE));
      console.log('Test sent | fcm id:', id);
      await sendToWeb(title, body, SITE);
      res.send('Test notification sent: ' + id);
    } catch (e) {
      console.error('Test failed:', e.message);
      res.status(500).send('Test failed: ' + e.message);
    }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Server on port', port));
})();