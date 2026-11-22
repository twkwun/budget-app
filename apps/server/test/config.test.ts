import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_SESSION_SECRET, loadConfig } from '../src/config.ts';

const SECRET = 'x'.repeat(40);

describe('loadConfig', () => {
  it('uses development defaults', () => {
    const config = loadConfig({}, '/srv/app');
    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe('/srv/app/data');
    expect(config.dbFile).toBe(path.join('/srv/app/data', 'budget.sqlite'));
    expect(config.backupDir).toBe(path.join('/srv/app/data', 'backups'));
    expect(config.sessionSecret).toBe(DEV_SESSION_SECRET);
    expect(config.backup).toEqual({ enabled: true, time: '04:00', retentionDays: 30 });
    expect(config.app.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('parses a full production environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      DATA_DIR: '/data',
      SESSION_SECRET: SECRET,
      PUBLIC_ORIGIN: 'https://budget.example-tailnet.ts.net/',
      BACKUP_ENABLED: 'false',
      BACKUP_TIME: '03:30',
      BACKUP_RETENTION_DAYS: '7',
      APP_VERSION: '1.2.3',
      APP_COMMIT: 'abc123',
    });
    expect(config.port).toBe(8080);
    expect(config.publicOrigin).toBe('https://budget.example-tailnet.ts.net');
    expect(config.backup).toEqual({ enabled: false, time: '03:30', retentionDays: 7 });
    expect(config.app).toEqual({ version: '1.2.3', commit: 'abc123' });
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ PORT: '', SESSION_SECRET: '' }).port).toBe(3000);
  });

  it('requires a strong secret and an https origin in production', () => {
    const attempt = () => loadConfig({ NODE_ENV: 'production' });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toContain('SESSION_SECRET');
      expect(issues).toContain('PUBLIC_ORIGIN');
    }
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: DEV_SESSION_SECRET,
        PUBLIC_ORIGIN: 'https://a.example.com',
      }),
    ).toThrow(/placeholder/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: SECRET,
        PUBLIC_ORIGIN: 'http://budget.example.com',
      }),
    ).toThrow(/https/);
  });

  it.each([
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: 'abc' }, 'PORT'],
    [{ SESSION_SECRET: 'short' }, 'SESSION_SECRET'],
    [{ PUBLIC_ORIGIN: 'not a url' }, 'PUBLIC_ORIGIN'],
    [{ PUBLIC_ORIGIN: 'https://a.example.com/app' }, 'PUBLIC_ORIGIN'],
    [{ BACKUP_TIME: '25:00' }, 'BACKUP_TIME'],
    [{ BACKUP_ENABLED: 'maybe' }, 'BACKUP_ENABLED'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
  ])('rejects %j', (env, key) => {
    expect(() => loadConfig(env)).toThrow(key);
  });
});
