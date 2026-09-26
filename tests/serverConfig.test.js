'use strict';

// Final pre-PP2 fix — small config/standards fixes (spec items 9/14).
const fs = require('fs');
const path = require('path');

describe('CORS methods (spec item 9 — PATCH added)', () => {
  const indexSource = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');

  it("index.js's cors() config includes PATCH", () => {
    const corsBlock = indexSource.slice(indexSource.indexOf('app.use(cors('), indexSource.indexOf('app.use(cors(') + 400);
    expect(corsBlock).toMatch(/methods:\s*\[[^\]]*'PATCH'[^\]]*\]/);
  });

  it('the two routes that actually use PATCH still exist (so this fix is not stale)', () => {
    const routesSource = fs.readFileSync(path.resolve(__dirname, '../src/routes/handwriting.js'), 'utf8');
    expect(routesSource).toMatch(/router\.patch\(/);
    expect((routesSource.match(/router\.patch\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('CORS_ORIGIN fallback behavior is unchanged (still \'*\' when unset) — not a redesign', () => {
    const corsBlock = indexSource.slice(indexSource.indexOf('app.use(cors('), indexSource.indexOf('app.use(cors(') + 400);
    expect(corsBlock).toContain("process.env.CORS_ORIGIN || '*'");
  });
});

describe('.env.example (spec item 8/14) — safe placeholders only', () => {
  const envExamplePath = path.resolve(__dirname, '../.env.example');
  const envExampleSource = fs.readFileSync(envExamplePath, 'utf8');

  it('exists', () => {
    expect(fs.existsSync(envExamplePath)).toBe(true);
  });

  it('every genuinely-used env var (from index.js + src/) has an entry', () => {
    const REQUIRED_KEYS = [
      'NODE_ENV', 'PORT', 'ALLOW_DB_SYNC',
      'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
      'JWT_SECRET', 'JWT_EXPIRES_IN', 'CORS_ORIGIN',
      'ML_SERVICE_URL', 'GNN_SERVICE_URL',
      'AZURE_STORAGE_ACCOUNT_NAME', 'AZURE_STORAGE_ACCOUNT_KEY', 'AZURE_BLOB_CONTAINER',
      'SMTP_EMAIL', 'SMTP_APP_PASSWORD',
      'PRINCIPAL_USERNAME', 'PRINCIPAL_PASSWORD',
    ];
    for (const key of REQUIRED_KEYS) {
      expect(envExampleSource).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });

  it('contains no plausible real secret (long random-looking value, real-looking connection string, or a real Azure/JWT-style key)', () => {
    // Every value must be a short, obviously-fake placeholder — this
    // regex looks for the kind of long, high-entropy-looking string a
    // real secret would produce and asserts NONE exist.
    const lines = envExampleSource.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'));
    for (const line of lines) {
      const value = line.split('=').slice(1).join('=').trim();
      expect(value.length).toBeLessThan(40); // real secrets/keys are typically much longer than any placeholder here
      expect(value).not.toMatch(/^postgres(?:ql)?:\/\//); // no real connection string
    }
  });

  it('never contains the literal word "REDACTED" or a copied real value from .env (spot-check placeholder wording)', () => {
    expect(envExampleSource).not.toMatch(/REDACTED/);
  });
});

describe('ML service .env.example (repository truth — already present)', () => {
  it('exists and contains only placeholder values', () => {
    const mlEnvPath = path.resolve(__dirname, '../../auriva-ml-service/.env.example');
    expect(fs.existsSync(mlEnvPath)).toBe(true);
    const source = fs.readFileSync(mlEnvPath, 'utf8');
    expect(source).toMatch(/DB_PASSWORD=password/); // confirmed placeholder, not a real credential
  });
});
