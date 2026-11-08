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

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api/files', fileRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/reports', reportRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
