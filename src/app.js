const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const fileRoutes = require('./routes/file.routes');
const onboardingRoutes = require('./routes/onboarding.routes');
const authRoutes = require('./routes/auth.routes');
const categoryRoutes = require('./routes/category.routes');
const siteRoutes = require('./routes/site.routes');
const reportRoutes = require('./routes/report.routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Render, Railway, Fly and Heroku all terminate TLS at a proxy. Without this,
// req.protocol is "http" and anything that builds an absolute URL gets it wrong.
app.set('trust proxy', 1);

/**
 * CORS.
 *
 * CORS_ORIGINS is a comma-separated allowlist, e.g.
 *   CORS_ORIGINS=https://community-voice.vercel.app,http://localhost:5173
 *
 * Left unset, every origin is reflected back. That is the right default for a
 * hackathon — the frontend's deploy URL changes on every push and a stale
 * allowlist is just a second outage — but set it before anything real.
 *
 * The origin is echoed rather than answered with "*" because "*" is rejected by
 * the browser the moment a request carries credentials.
 */
const allowlist = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // No Origin header: curl, Postman, server-to-server, same-origin. Allow.
    if (!origin) return callback(null, true);
    if (!allowlist.length) return callback(null, true);
    if (allowlist.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    // Refuse by omitting the header, not by erroring — an error here becomes a
    // 500 whose body the browser will not let the frontend read anyway.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  maxAge: 86400, // cache the preflight for a day
};

app.use(cors(corsOptions));
// Express 4 does not run the preflight through the route table on its own.
app.options('*', cors(corsOptions));

app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (req, res) =>
  res.json({
    ok: true,
    uptime: process.uptime(),
    cors: allowlist.length ? allowlist : 'all origins',
  })
);

app.use('/api/files', fileRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/reports', reportRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
