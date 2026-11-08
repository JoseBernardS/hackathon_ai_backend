const uploads = require('../services/upload.service');
const File = require('../models/File');

// POST /api/files  (multipart/form-data, field name: "file")
async function uploadFile(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file sent (field name must be "file")' });

  const stored = await uploads.putObject(req.file, 'uploads');

  const doc = await File.create({
    ...stored,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });

  res.status(201).json(doc);
}

// GET /api/files
async function listFiles(req, res) {
  const files = await File.find().sort({ createdAt: -1 }).limit(100);
  res.json(files);
}

// GET /api/files/:id  -> metadata + a 15 min presigned download URL
async function getFile(req, res) {
  const doc = await File.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  const downloadUrl = await uploads.presign(doc.key);
  res.json({ ...doc.toObject(), downloadUrl });
}

// DELETE /api/files/:id
async function deleteFile(req, res) {
  const doc = await File.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  await uploads.removeObject(doc.key, doc.bucket);
  await doc.deleteOne();

  res.json({ deleted: true, id: req.params.id });
}

module.exports = { uploadFile, listFiles, getFile, deleteFile };
