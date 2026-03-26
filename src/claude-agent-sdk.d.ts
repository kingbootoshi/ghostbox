declare module "@anthropic-ai/claude-agent-sdk" {
  export type QueryOptions = {
    cwd: string;
    permissionMode: string;
    allowDangerouslySkipPermissions: boolean;
    model?: string;
    resume?: string;
    maxTurns: number;
    systemPrompt: string;
  };

  export type QueryInput = {
    prompt: string;
    options: QueryOptions;
    env: Record<string, string | undefined>;
  };

  export function query(input: QueryInput): AsyncGenerator<unknown>;
}
