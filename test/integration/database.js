// This guard intentionally does not read DATABASE_URL or load .env. A test
// database must always be selected explicitly before any database operation.
export function requireTestDatabaseUrl(value = process.env.TEST_DATABASE_URL) {
  if (!value?.trim()) {
    throw new Error('TEST_DATABASE_URL is required; provision a disposable PostgreSQL database whose name contains "test"');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error('TEST_DATABASE_URL must use postgres:// or postgresql://');
  }
  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL contains an invalid database name');
  }
  if (!database.toLowerCase().includes('test') || database.includes('/')) {
    throw new Error('Refusing to run integration tests: database name must contain "test"');
  }
  return url.toString();
}
