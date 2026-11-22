import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskedNote, maskSourceSecrets, redact, REDACTED, secretValues } from './redact';

test('credential shapes are redacted, ordinary output is not', () => {
  const samples = [
    'nvapi-AbCdEfGhIjKlMnOpQrStUvWx0123', 'sk-or-v1-0123456789abcdef0123456789abcdef', 'sk-ant-api03-AbCdEfGhIjKlMnOp_qrst',
    'gsk_AbCdEfGhIjKlMnOpQrStUv01', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abcdefghij',
  ];
  for (const s of samples) {
    const r = redact(`before ${s} after`, []);
    assert.equal(r.text, `before ${REDACTED} after`, s);
    assert.equal(r.count, 1);
  }
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(redact(`key:\n${pem}\ndone`, []).text, `key:\n${REDACTED}\ndone`);
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop0123456789', []).text, `Authorization: Bearer ${REDACTED}`);
  assert.equal(redact('OPENAI_API_KEY=abcdefgh12345678 and "secret_token": "zzzzzzzzzz"', []).text,
    `OPENAI_API_KEY=${REDACTED} and "secret_token": "${REDACTED}"`);
  const plain = '57 passed, 3 skipped in 0.15s\nsrc/flask/cli.py:12: def get_secret_key_from_env(app):\ntask-scope token count';
  assert.deepEqual(redact(plain, []), { text: plain, count: 0 });
});

test('configured provider keys are redacted verbatim wherever they appear', () => {
  const key = 'zq-provider-key-123456';
  const values = secretValues({ PATH: '/usr/bin', MY_PROVIDER_API_KEY: key, SHORT_TOKEN: 'abc', HOME: '/home/u' }, []);
  assert.deepEqual(values, [key], 'credential-named variables of 8+ characters only');
  assert.deepEqual(redact(`x=${key};${key}`, values), { text: `x=${REDACTED};${REDACTED}`, count: 2 });
});

test('apiKeyEnv names in the model config make their values secret even without a credential-like name', async () => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-redact-'));
  const cfg = path.join(dir, 'models.json');
  await fs.writeFile(cfg, JSON.stringify({ providers: { p: { apiKeyEnv: 'NVIDIA_CREDS_VAR' } } }));
  try {
    assert.deepEqual(secretValues({ NVIDIA_CREDS_VAR: 'value-of-the-key-1', OTHER: 'not-a-secret-value' }, [cfg]), ['value-of-the-key-1']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('source masking: high-confidence credential shapes only; ordinary code and test fixtures are sent unchanged', () => {
  const nv = 'nvapi-' + 'Q'.repeat(28), gh = 'ghp_' + 'Z'.repeat(36);
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
  const src = `KEY = "${nv}"\ntoken = "${gh}"\n${pem}\n`;
  const m = maskSourceSecrets(src, []);
  assert.equal(m.count, 3);
  assert.ok(!m.text.includes(nv) && !m.text.includes(gh) && !m.text.includes('MIIE'));
  assert.equal(m.text.split(REDACTED).length - 1, 3);
  // What redact() would treat as a credential assignment stays: Task B's own test fixtures look like this.
  const ordinary = 'app.config.update(SECRET_KEY="s3cr3t-value-1234", DB_PASSWORD="hunter2hunter2", API_TOKEN="tok-123456789")\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n';
  assert.deepEqual(maskSourceSecrets(ordinary, []), { text: ordinary, count: 0 });
  assert.notEqual(redact(ordinary, []).count, 0, 'the command-output rule is broader on purpose');
  // Known key values are masked verbatim.
  assert.deepEqual(maskSourceSecrets('x = "plain-known-value-0123456789"', ['plain-known-value-0123456789']), { text: `x = "${REDACTED}"`, count: 1 });
  assert.equal(maskedNote(1), '[Forge masked 1 credential-shaped string in this text; the file itself is unchanged]');
  assert.equal(maskedNote(2), '[Forge masked 2 credential-shaped strings in this text; the file itself is unchanged]');
});
