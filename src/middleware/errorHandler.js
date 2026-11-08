function notFound(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
}

function errorHandler(err, req, res, next) {
  console.error('[error]', err);

  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `Unexpected field "${err.field}"` });

  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
}

module.exports = { notFound, errorHandler };
