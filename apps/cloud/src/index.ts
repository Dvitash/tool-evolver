import { InMemoryDatabaseClient } from "@tool-evolver/db";

export interface CloudService {
  initialize(): Promise<void>;
}

export function createCloudService(): CloudService {
  const db = new InMemoryDatabaseClient();
  return {
    async initialize() {
      await db.connect();
    },
  };
}
