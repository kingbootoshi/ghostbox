declare module '@mariozechner/pi-coding-agent' {
  export type PiModel = {
    provider: string;
    id: string;
  };

  export type PiAgentMessage = {
    role?: string;
    content?: unknown;
  };

  export type PiAgentSessionEvent =
    | {
        type: 'message_update';
        message?: PiAgentMessage;
        assistantMessageEvent: {
          type: string;
          delta?: string;
        };
      }
    | {
        type: 'message_end';
        message?: PiAgentMessage;
      }
    | {
        type: 'tool_execution_start';
        toolName: string;
        args: unknown;
      }
    | {
        type: 'tool_execution_end';
        toolName: string;
        result: unknown;
        isError: boolean;
      }
    | {
        type: 'agent_end';
        messages?: unknown[];
      }
    | {
        type: string;
        [key: string]: unknown;
      };

  export class AuthStorage {
    static create(path?: string): AuthStorage;
  }

  export class ModelRegistry {
    constructor(authStorage: AuthStorage, modelsPath?: string);
    find(provider: string, modelId: string): PiModel | undefined;
  }

  export class SessionManager {
    static continueRecent(cwd: string, sessionDir?: string): SessionManager;
    static create(cwd: string, sessionDir?: string): SessionManager;
    getSessionFile(): string | undefined;
  }

  export class DefaultResourceLoader {
    constructor(options: {
      cwd?: string;
      systemPromptOverride?: (base: string | undefined) => string | undefined;
      appendSystemPromptOverride?: (base: string[]) => string[];
    });
    reload(): Promise<void>;
  }

  export class AgentSession {
    readonly sessionId: string;
    readonly modelRegistry: ModelRegistry;
    subscribe(listener: (event: PiAgentSessionEvent) => void): () => void;
    prompt(text: string): Promise<void>;
    setModel(model: PiModel): Promise<void>;
    reload(): Promise<void>;
  }

  export const codingTools: unknown[];

  export function createAgentSession(options: {
    cwd?: string;
    sessionManager?: SessionManager;
    model?: PiModel;
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    tools?: unknown[];
    resourceLoader?: DefaultResourceLoader;
  }): Promise<{ session: AgentSession }>;
}
