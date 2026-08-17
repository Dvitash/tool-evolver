import { describe, expect, it } from "vitest";
import { InMemoryDatabaseClient } from "../src/index.js";

describe("db", () => {
  it("connects and disconnects", async () => {
    const db = new InMemoryDatabaseClient();
    expect(db.isConnected()).toBe(false);
    await db.connect();
    expect(db.isConnected()).toBe(true);
    await db.disconnect();
    expect(db.isConnected()).toBe(false);
  });
});
