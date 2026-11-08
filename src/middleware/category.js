const categories = require('../services/categories.service');

/**
 * Resolves the `category` parameter into a registry entry on `req.category`.
 *
 * Every collection-level endpoint is category-scoped, so this is the one place
 * that decides what a valid category is. A site or report id is globally
 * unique, so item-level endpoints read the category off the document instead
 * and do not use this.
 *
 * Looks in the path (`/:category/...`), the query string, then the body — so
 * `GET /api/sites?category=pothole` and `POST /api/reports` with a `category`
 * field both work.
 */
function resolveCategory({ required = true } = {}) {
  return (req, _res, next) => {
    const raw = req.params.category || req.query.category || (req.body && req.body.category);

    if (!raw) {
      if (!required) return next();
      const enabled = categories.REGISTRY.map((c) => c.code).join(', ');
      const err = new Error(`category is required. Currently available: ${enabled}`);
      err.status = 400;
      return next(err);
    }

    const entry = categories.get(raw);
    if (!entry) {
      const err = new Error(
        categories.isBacklog(raw)
          ? `Category "${raw}" exists in the 311 data but is not enabled yet`
          : `Unknown category "${raw}"`
      );
      err.status = 404;
      return next(err);
    }

    req.category = entry;
    return next();
  };
}

/** Pins a route to one category, for the deprecated /api/potholes aliases. */
function fixedCategory(code) {
  return (req, _res, next) => {
    req.category = categories.get(code);
    if (!req.category) {
      const err = new Error(`Category "${code}" is not enabled`);
      err.status = 404;
      return next(err);
    }
    return next();
  };
}

module.exports = { resolveCategory, fixedCategory };
