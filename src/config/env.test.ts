import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

/**
 * Environment validation is the difference between a bad deploy failing at boot
 * with a readable message and failing an hour later on the request that happens
 * to touch the missing value. These cases pin that behaviour.
 */

const minimal = { DATABASE_URL: 'postgres://user:pass@localhost:5432/kattegat' };

describe('parseEnv', () => {
  it('accepts a minimal environment and applies documented defaults', () => {
    const env = parseEnv(minimal);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toStrictEqual(['http://localhost:3000']);
    expect(env.ERC8004_IDENTITY_REGISTRY).toBe('0x8004a169fb4a3325136eb29fa0ceb6d2e539a432');
    expect(env.AI_PROVIDER).toBe('none');
  });

  it('rejects a missing database url', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a database url that is not postgres', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/postgres/);
  });

  it('lowercases and validates registry addresses', () => {
    const env = parseEnv({
      ...minimal,
      ERC8004_IDENTITY_REGISTRY: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
    });
    expect(env.ERC8004_IDENTITY_REGISTRY).toBe('0xabcdef0123456789abcdef0123456789abcdef01');

    expect(() => parseEnv({ ...minimal, ERC8004_IDENTITY_REGISTRY: '0xnope' })).toThrow(
      /20-byte hex address/,
    );
  });

  it('parses a comma-separated origin list and tolerates stray whitespace', () => {
    const env = parseEnv({
      ...minimal,
      CORS_ORIGINS: 'http://localhost:3000, https://kattegat.xyz ,',
    });
    expect(env.CORS_ORIGINS).toStrictEqual(['http://localhost:3000', 'https://kattegat.xyz']);
  });

  it('refuses a wildcard CORS origin in production', () => {
    expect(() => parseEnv({ ...minimal, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /wildcard origin/,
    );
    // Still permitted in development, where it is a convenience not a hole.
    expect(() => parseEnv({ ...minimal, NODE_ENV: 'development', CORS_ORIGINS: '*' })).not.toThrow();
  });

  it('refuses an AI provider without credentials', () => {
    expect(() => parseEnv({ ...minimal, AI_PROVIDER: 'openai-compatible' })).toThrow(/AI_API_KEY/);

    expect(() =>
      parseEnv({ ...minimal, AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'sk-test' }),
    ).not.toThrow();
  });

  it('coerces booleanish flags from either spelling', () => {
    expect(parseEnv({ ...minimal, ERC8004_EXPLORER_ENABLED: 'true' }).ERC8004_EXPLORER_ENABLED).toBe(
      true,
    );
    expect(parseEnv({ ...minimal, ERC8004_EXPLORER_ENABLED: '1' }).ERC8004_EXPLORER_ENABLED).toBe(
      true,
    );
    expect(parseEnv({ ...minimal, ERC8004_EXPLORER_ENABLED: 'false' }).ERC8004_EXPLORER_ENABLED).toBe(
      false,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseEnv({ ...minimal, PORT: '70000' })).toThrow(/PORT/);
  });

  it('reports every invalid variable at once rather than the first', () => {
    try {
      parseEnv({ DATABASE_URL: 'nope', PORT: '0', LOG_LEVEL: 'chatty' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('LOG_LEVEL');
    }
  });
});

/**
 * The bind address, which has no single correct default.
 *
 * This is here because getting it wrong cost a deployment and the symptom pointed nowhere near
 * the cause: the service built, validated its environment, reached Postgres, logged "Server
 * listening at http://127.0.0.1:10000", and the platform then reported "No open ports detected on
 * 0.0.0.0" for five minutes. A process that is plainly running, and a message naming neither the
 * variable nor the process.
 */
describe('HOST', () => {
  const base = { DATABASE_URL: 'postgres://user:pass@host:5432/db' };

  it('binds loopback in development, so a dev server is not exposed to the network', () => {
    expect(parseEnv({ ...base }).HOST).toBe('127.0.0.1');
  });

  it('binds every interface in production, because a container is reached from outside', () => {
    /*
     * The regression this exists for. On loopback the platform's health check cannot reach the
     * process however healthy it is, and nothing in the logs says so.
     */
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://kattegat.vercel.app',
    });

    expect(env.HOST).toBe('0.0.0.0');
  });

  it('still lets a deployment name its own interface', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      HOST: '10.0.0.5',
      CORS_ORIGINS: 'https://kattegat.vercel.app',
    });

    expect(env.HOST).toBe('10.0.0.5');
  });
});
