const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    originalName: { type: String, required: true },
    mimeType: { type: String },
    size: { type: Number },
    bucket: { type: String, required: true },
    url: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('File', fileSchema);
