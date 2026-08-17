/**
 * @tool-evolver/cloud - Cloud MCP Subsystem Types & Schemas
 */

import type {
  DeploymentRecord,
  ISOTimestamp,
  Identifier,
  ToolManifest,
} from "@tool-evolver/contracts";
import type {
  AuthClaims,
  CatalogSnapshotResponse,
  StreamCatalogInvalidation,
  StreamCloudToolCatalogChange,
} from "@tool-evolver/protocol";
import type { PrivacyLevel } from "../models/types.js";
import type { TenantContext } from "../tenant.js";

/**
 * Standard MCP Content Types.
 */
export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string; // Base64 encoded
  mimeType: string;
}

export interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

/**
 * Result returned from an MCP tool invocation.
 */
export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
  structuredData?: unknown;
}

/**
 * MCP Protocol Version.
 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SUPPORTED_MCP_VERSIONS = ["2024-11-05", "2024-10-07", "latest"] as const;

/**
 * Invocation context passed to tool handlers and middleware.
 */
export interface CloudMcpInvocationContext {
  tenant: TenantContext;
  sessionId?: string;
  deviceId?: string;
  installationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  user?: {
    id: string;
    email?: string;
    roles?: string[];
  };
  claims?: AuthClaims;
  scopes?: string[];
  signal?: AbortSignal;
  protocolVersion?: string;
  clientInfo?: {
    name: string;
    version: string;
  };
  environment?: Record<string, string>;
}

/**
 * Active MCP Session Context.
 */
export interface CloudMcpSessionContext {
  sessionId: string;
  tenant: TenantContext;
  protocolVersion: string;
  clientInfo?: {
    name: string;
    version: string;
  };
  createdAt: string;
  lastActivityAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Cloud MCP Tool Definition.
 */
export interface CloudMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  handler: (
    params: Record<string, unknown>,
    context: CloudMcpInvocationContext,
  ) => Promise<CallToolResult>;
  scope?: "platform" | "workspace" | "tenant" | "public";
  classification?: "read_only" | "idempotent" | "mutation" | "destructive";
  privacyLevel?: PrivacyLevel | "airgapped" | "redacted" | "direct";
  rateLimit?: {
    maxRequestsPerMinute?: number;
    burst?: number;
  };
  timeoutMs?: number;
  manifest?: ToolManifest;
  source?: "platform" | "model" | "registry" | "fixture";
  version?: string;
}

/**
 * Provider interface for injecting tools into the cloud MCP catalog.
 */
export interface CloudToolProvider {
  readonly name: string;
  getTools(tenant: TenantContext): Promise<CloudMcpToolDefinition[]>;
  getTool(tenant: TenantContext, toolName: string): Promise<CloudMcpToolDefinition | null>;
}

/**
 * Scoped Catalog Snapshot Record.
 */
export interface CloudCatalogSnapshotRecord {
  snapshotVersion: string;
  revision: number;
  tenantId: string;
  workspaceId: string;
  checksum: string;
  generatedAt: string;
  tools: ToolManifest[];
  activeDeployments: DeploymentRecord[];
  filterScopes?: string[];
}

/**
 * Invalidation reason for cloud catalog updates.
 */
export type CatalogInvalidationReason =
  | "version_published"
  | "tool_deprecated"
  | "emergency_revocation"
  | "config_changed";

/**
 * Invalidation event listener callback.
 */
export type CatalogInvalidationListener = (
  event: StreamCatalogInvalidation,
) => void | Promise<void>;

/**
 * Next function for middleware pipeline.
 */
export type CloudMcpNextFunction = () => Promise<CallToolResult>;

/**
 * Middleware function for tool invocation pipeline.
 */
export type CloudMcpMiddleware = (
  context: CloudMcpInvocationContext,
  tool: CloudMcpToolDefinition,
  params: Record<string, unknown>,
  next: CloudMcpNextFunction,
) => Promise<CallToolResult>;

/**
 * JSON-RPC 2.0 Error Codes.
 */
export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_TIMEOUT: -32000,
  CANCELLED: -32001,
  RESOURCE_NOT_FOUND: -32002,
  UNAUTHORIZED: -32003,
  RATE_LIMITED: -32029,
} as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

/**
 * JSON-RPC 2.0 Request and Response Interfaces.
 */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = Record<string, unknown>> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = Record<string, unknown>> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: TResult;
  error?: JsonRpcErrorObject;
}

/**
 * Standard MCP Initialize Request Parameters.
 */
export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: {
    roots?: { listChanged?: boolean };
    sampling?: Record<string, unknown>;
    [key: string]: unknown;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

/**
 * Standard MCP Initialize Response Result.
 */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    logging?: Record<string, unknown>;
    [key: string]: unknown;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

/**
 * Standard MCP Tools List Result.
 */
export interface McpToolsListResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  nextCursor?: string;
}

/**
 * Standard MCP Call Tool Params.
 */
export interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Standard MCP Cancel Notification Params.
 */
export interface McpCancelNotificationParams {
  requestId: JsonRpcId;
  reason?: string;
}
