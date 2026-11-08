const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');

  mongoose.connection.on('error', (err) => console.error('[mongo] error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('[mongo] disconnected'));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('[mongo] connected:', mongoose.connection.name);
}

module.exports = { connectDB };
