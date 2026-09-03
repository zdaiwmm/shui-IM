import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
process.stdout.write([
  '# Store the private key in the deployment secret manager; never commit it.',
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  'VAPID_SUBJECT=mailto:security@example.com',
  '',
].join('\n'));
