const crypto = require('crypto');
const path = require('path');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { s3, BUCKET, region } = require('../config/s3');

function buildKey(originalName, prefix = 'uploads') {
  const ext = path.extname(originalName);
  return `${prefix}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

async function putObject(file, prefix) {
  const key = buildKey(file.originalname, prefix);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  return {
    key,
    bucket: BUCKET,
    url: `https://${BUCKET}.s3.${region}.amazonaws.com/${key}`,
  };
}

function presign(key, expiresIn = 900) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

function removeObject(key, bucket = BUCKET) {
  return s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = { buildKey, putObject, presign, removeObject };
