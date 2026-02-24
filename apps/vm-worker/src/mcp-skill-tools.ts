/**
 * MCP Skill Tools — starts MCP servers for enabled skills and converts their
 * tools into Pi SDK ToolDefinitions so they appear as first-class agent tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type, type TSchema } from "@sinclair/typebox";
import type { SkillManifest, SkillMcpServer } from "./skills-runtime.js";

/** A live MCP connection with its client and transport. */
interface McpConnection {
  skillId: string;
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
}

/** A Pi SDK ToolDefinition built from an MCP tool. */
export interface McpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

/** Holds all MCP connections for cleanup. */
export class McpSkillToolsRuntime {
  private connections: McpConnection[] = [];

  /**
   * Start MCP servers for the given skills and return their tools as
   * Pi SDK ToolDefinitions.
   */
  async start(
    skills: SkillManifest[],
    log?: (msg: string) => void
  ): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];

    for (const skill of skills) {
      for (const [serverName, serverConfig] of Object.entries(skill.tools.mcpServers)) {
        try {
          const conn = await this.connectServer(skill.id, serverName, serverConfig, log);
          const serverTools = await this.discoverTools(conn, log);
          tools.push(...serverTools);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log?.(`[mcp-tools] failed to start ${skill.id}/${serverName}: ${msg}`);
        }
      }
    }

    return tools;
  }

  /** Shut down all MCP server connections. */
  async shutdown(): Promise<void> {
    for (const conn of this.connections) {
      try {
        await conn.client.close();
        await conn.transport.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.connections = [];
  }

  private async connectServer(
    skillId: string,
    serverName: string,
    config: SkillMcpServer,
    log?: (msg: string) => void
  ): Promise<McpConnection> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: `butler-${skillId}`, version: "0.1.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    log?.(`[mcp-tools] connected to ${skillId}/${serverName}`);

    const conn: McpConnection = { skillId, serverName, client, transport };
    this.connections.push(conn);
    return conn;
  }

  private async discoverTools(
    conn: McpConnection,
    log?: (msg: string) => void
  ): Promise<McpToolDefinition[]> {
    const result = await conn.client.listTools();
    const tools: McpToolDefinition[] = [];

    for (const mcpTool of result.tools) {
      const toolName = `mcp__${conn.serverName}__${mcpTool.name}`;
      const description = mcpTool.description ?? `${conn.serverName} tool: ${mcpTool.name}`;

      // Convert JSON Schema to TypeBox using Type.Unsafe (passthrough).
      const parameters = Type.Unsafe(mcpTool.inputSchema ?? { type: "object" });

      const client = conn.client;
      const originalName = mcpTool.name;

      const tool: McpToolDefinition = {
        name: toolName,
        label: `${conn.skillId}: ${mcpTool.name}`,
        description,
        parameters,
        execute: async (_toolCallId, params) => {
          const callResult = await client.callTool({
            name: originalName,
            arguments: params,
          });

          // Convert MCP content to Pi SDK TextContent format.
          const content = extractTextContent(callResult);
          return { content, details: null };
        },
      };

      tools.push(tool);
    }

    log?.(
      `[mcp-tools] ${conn.skillId}/${conn.serverName}: ${tools.length} tools registered`
    );
    return tools;
  }
}

/** Extract text from MCP callTool result into Pi SDK TextContent array. */
function extractTextContent(
  result: Awaited<ReturnType<Client["callTool"]>>
): { type: "text"; text: string }[] {
  if ("content" in result && Array.isArray(result.content)) {
    const textItems: { type: "text"; text: string }[] = [];
    for (const item of result.content) {
      if (item.type === "text") {
        textItems.push({ type: "text", text: item.text });
      } else {
        // For non-text content (images, resources), serialize as JSON.
        textItems.push({ type: "text", text: JSON.stringify(item) });
      }
    }
    if (textItems.length > 0) return textItems;
  }

  // Fallback: serialize the whole result.
  return [{ type: "text", text: JSON.stringify(result) }];
}
