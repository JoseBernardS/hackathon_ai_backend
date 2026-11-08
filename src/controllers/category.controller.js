const categories = require('../services/categories.service');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// GET /api/categories?includeBacklog=1&stats=0
// What the app can report. Only potholes are live today.
async function listCategories(req, res) {
  const withStats = req.query.stats !== '0';
  const payload = {
    count: categories.REGISTRY.length,
    categories: await categories.list({ withStats }),
  };

  if (req.query.includeBacklog === '1' || req.query.includeBacklog === 'true') {
    payload.backlog = categories.BACKLOG;
    payload.backlogCount = categories.BACKLOG.length;
  }

  res.json(payload);
}

// GET /api/categories/:code
async function getCategory(req, res) {
  const entry = categories.get(req.params.code);
  if (!entry) {
    if (categories.isBacklog(req.params.code)) {
      throw httpError(404, `Category "${req.params.code}" exists in the 311 data but is not enabled yet`);
    }
    throw httpError(404, `Unknown category "${req.params.code}"`);
  }
  res.json(await categories.describe(entry));
}

module.exports = { listCategories, getCategory };
