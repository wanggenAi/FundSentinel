export interface DatabaseConfig {
  path: string;
}

export const defaultDatabaseConfig: DatabaseConfig = {
  path: "fundsentinel_mock.sqlite"
};

export function initializeDatabase(): { ready: boolean; note: string } {
  return {
    ready: true,
    note: "SQLite persistence is reserved for V0.2; V0.1 keeps snapshots in memory."
  };
}

