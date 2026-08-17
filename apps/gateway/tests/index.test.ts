import { describe, expect, it } from "vitest";
import {
  FakeGatewayRouter,
  LocalMcpGateway,
  McpConnection,
  McpFrameDecoder,
  McpProtocolError,
  McpStdioShim,
  createGateway,
  encodeMcpMessage,
  redactSensitiveText,
  resolveWorkspaceContext,
} from "../src/index.js";

describe("Gateway Package Index Exports", () => {
  it("exports all core classes, functions, and helpers", () => {
    expect(LocalMcpGateway).toBeDefined();
    expect(FakeGatewayRouter).toBeDefined();
    expect(McpConnection).toBeDefined();
    expect(McpFrameDecoder).toBeDefined();
    expect(McpProtocolError).toBeDefined();
    expect(McpStdioShim).toBeDefined();
    expect(encodeMcpMessage).toBeDefined();
    expect(resolveWorkspaceContext).toBeDefined();
    expect(redactSensitiveText).toBeDefined();
  });

  it("createGateway helper starts and stops cleanly", async () => {
    const gw = createGateway();
    await expect(gw.start()).resolves.toBeUndefined();
    await expect(gw.stop()).resolves.toBeUndefined();
  });
});
