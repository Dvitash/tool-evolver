import type { BrokerRequestHandlerFn, BrokeredFetchResponse } from "../worker/sdk.js";
import type { CommandExecuteResult } from "./cmd-broker.js";
import type { FileStatResult, ReadFileResult } from "./fs-broker.js";
import type { NetResponseResult } from "./net-broker.js";

export type { BrokeredFetchResponse } from "../worker/sdk.js";

export interface FsWriteOptions {
  encoding?: "utf-8" | "base64";
  atomic?: boolean;
}

export interface NetRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  redirect?: "follow" | "error" | "manual";
  maxRedirects?: number;
}

export interface CommandExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputSizeBytes?: number;
}

/**
 * Client SDK for brokered filesystem operations.
 */
export class FsClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  async stat(filePath: string): Promise<FileStatResult> {
    return (await this.requestHandler("fs", "stat", { path: filePath })) as FileStatResult;
  }

  async exists(filePath: string): Promise<boolean> {
    const res = (await this.requestHandler("fs", "exists", { path: filePath })) as {
      exists: boolean;
    };
    return res.exists;
  }

  async readFile(
    filePath: string,
    encoding: "utf-8" | "base64" | "buffer" = "utf-8",
  ): Promise<string | Uint8Array> {
    const wireEncoding = encoding === "buffer" ? "base64" : encoding;
    const res = (await this.requestHandler("fs", "readFile", {
      path: filePath,
      encoding: wireEncoding,
    })) as ReadFileResult;

    if (encoding === "buffer") {
      return typeof Buffer !== "undefined"
        ? Buffer.from(res.content, "base64")
        : Uint8Array.from(atob(res.content), (c) => c.charCodeAt(0));
    }
    return res.content;
  }

  async writeFile(
    filePath: string,
    content: string | Uint8Array,
    options: FsWriteOptions = {},
  ): Promise<void> {
    let serialized: string;
    let encoding: "utf-8" | "base64";

    if (typeof content === "string") {
      serialized = content;
      encoding = options.encoding ?? "utf-8";
    } else {
      serialized =
        typeof Buffer !== "undefined"
          ? Buffer.from(content).toString("base64")
          : btoa(String.fromCharCode(...content));
      encoding = "base64";
    }

    await this.requestHandler("fs", "writeFile", {
      path: filePath,
      content: serialized,
      encoding,
      atomic: options.atomic,
    });
  }

  async appendFile(
    filePath: string,
    content: string | Uint8Array,
    options: { encoding?: "utf-8" | "base64" } = {},
  ): Promise<void> {
    let serialized: string;
    let encoding: "utf-8" | "base64";

    if (typeof content === "string") {
      serialized = content;
      encoding = options.encoding ?? "utf-8";
    } else {
      serialized =
        typeof Buffer !== "undefined"
          ? Buffer.from(content).toString("base64")
          : btoa(String.fromCharCode(...content));
      encoding = "base64";
    }

    await this.requestHandler("fs", "appendFile", {
      path: filePath,
      content: serialized,
      encoding,
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.requestHandler("fs", "rename", { oldPath, newPath });
  }

  async delete(filePath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.requestHandler("fs", "delete", { path: filePath, recursive: options.recursive });
  }

  async removeFile(filePath: string): Promise<void> {
    await this.delete(filePath);
  }

  async createDirectory(dirPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.requestHandler("fs", "createDirectory", {
      path: dirPath,
      recursive: options.recursive,
    });
  }

  async mkdir(dirPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.createDirectory(dirPath, options);
  }

  async listDirectory(dirPath = ".", options: { recursive?: boolean } = {}): Promise<string[]> {
    return (await this.requestHandler("fs", "listDirectory", {
      path: dirPath,
      recursive: options.recursive,
    })) as string[];
  }

  async listDir(dirPath = ".", options: { recursive?: boolean } = {}): Promise<string[]> {
    return this.listDirectory(dirPath, options);
  }
}

/**
 * Client SDK for brokered network requests.
 */
export class NetClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  async request(url: string, options: NetRequestOptions = {}): Promise<BrokeredFetchResponse> {
    const raw = (await this.requestHandler("net", "request", {
      url,
      ...options,
    })) as NetResponseResult;

    const ok = raw.status >= 200 && raw.status < 300;

    return {
      status: raw.status,
      statusText: raw.statusText,
      headers: raw.headers,
      ok,
      url: raw.url,
      redirected: raw.redirected,
      text: async () => raw.body,
      json: async <T = unknown>() => JSON.parse(raw.body) as T,
      arrayBuffer: async () => {
        const buf =
          typeof Buffer !== "undefined"
            ? Buffer.from(raw.body, "utf-8")
            : new TextEncoder().encode(raw.body);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      bytes: async () => {
        return typeof Buffer !== "undefined"
          ? new Uint8Array(Buffer.from(raw.body, "utf-8"))
          : new TextEncoder().encode(raw.body);
      },
    };
  }

  async fetch(url: string, options: NetRequestOptions = {}): Promise<BrokeredFetchResponse> {
    return this.request(url, options);
  }

  async get(url: string, headers: Record<string, string> = {}): Promise<BrokeredFetchResponse> {
    return this.request(url, { method: "GET", headers });
  }

  async post(
    url: string,
    body?: string | unknown,
    headers: Record<string, string> = {},
  ): Promise<BrokeredFetchResponse> {
    const serializedBody =
      typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined;
    const finalHeaders =
      typeof body === "object" &&
      body !== null &&
      !headers["content-type"] &&
      !headers["Content-Type"]
        ? { ...headers, "Content-Type": "application/json" }
        : headers;

    return this.request(url, { method: "POST", headers: finalHeaders, body: serializedBody });
  }

  async put(
    url: string,
    body?: string | unknown,
    headers: Record<string, string> = {},
  ): Promise<BrokeredFetchResponse> {
    const serializedBody =
      typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined;
    const finalHeaders =
      typeof body === "object" &&
      body !== null &&
      !headers["content-type"] &&
      !headers["Content-Type"]
        ? { ...headers, "Content-Type": "application/json" }
        : headers;

    return this.request(url, { method: "PUT", headers: finalHeaders, body: serializedBody });
  }

  async delete(url: string, headers: Record<string, string> = {}): Promise<BrokeredFetchResponse> {
    return this.request(url, { method: "DELETE", headers });
  }
}

/**
 * Client SDK for brokered command execution.
 */
export class CommandClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  async execute(
    executable: string,
    args: string[] = [],
    options: CommandExecuteOptions = {},
  ): Promise<CommandExecuteResult> {
    return (await this.requestHandler("cmd", "execute", {
      executable,
      args,
      ...options,
    })) as CommandExecuteResult;
  }

  async exec(
    command: string,
    args: string[] = [],
    options: CommandExecuteOptions = {},
  ): Promise<CommandExecuteResult> {
    return this.execute(command, args, options);
  }
}

/**
 * Client SDK for brokered secret resolution.
 */
export class SecretClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  async getSecret(name: string): Promise<string | null> {
    const res = (await this.requestHandler("secret", "getSecret", { name })) as {
      secret: string | null;
    };
    return res.secret;
  }
}

/**
 * Creates the complete suite of SDK clients bound to a request handler function.
 */
export function createBrokerClients(requestHandler: BrokerRequestHandlerFn): {
  fs: FsClient;
  net: NetClient;
  cmd: CommandClient;
  secret: SecretClient;
} {
  return {
    fs: new FsClient(requestHandler),
    net: new NetClient(requestHandler),
    cmd: new CommandClient(requestHandler),
    secret: new SecretClient(requestHandler),
  };
}
