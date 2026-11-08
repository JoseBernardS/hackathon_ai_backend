const { S3Client } = require('@aws-sdk/client-s3');

const region = process.env.AWS_REGION || 'us-east-1';

// Credentials are picked up from env vars, or the default AWS chain
// (~/.aws/credentials, IAM role) when the env vars are absent.
const s3 = new S3Client({
  region,
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

const BUCKET = process.env.S3_BUCKET;

module.exports = { s3, BUCKET, region };
