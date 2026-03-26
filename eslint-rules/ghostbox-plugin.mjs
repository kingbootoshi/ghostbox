// Custom ESLint rules for Ghostbox
// Biome handles formatting + standard lint. ESLint handles project-specific policy.

const noConsoleInServicesRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow console.log in service modules. Use the structured logger from src/logger.ts."
    },
    messages: {
      noConsole:
        "Use the structured logger from src/logger.ts instead of console. Import: import { logger } from './logger.ts'"
    },
    schema: []
  },
  create(context) {
    const filename = context.filename || "";
    // Allow console in CLI (user-facing output) and ghost-server (runs inside container)
    if (filename.includes("/cli.ts") || filename.includes("/ghost-server.ts") || filename.includes("/oauth.ts")) {
      return {};
    }
    // Allow in tests
    if (filename.includes("/tests/") || filename.includes(".test.") || filename.includes(".spec.")) {
      return {};
    }
    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "console" &&
          node.property.type === "Identifier" &&
          ["log", "warn", "error", "info", "debug"].includes(node.property.name)
        ) {
          context.report({ node, messageId: "noConsole" });
        }
      }
    };
  }
};

const noShellDeleteRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow rm/unlink for file deletion. Use trash for safe deletion."
    },
    messages: {
      noShellDelete: "Use 'trash' for file deletion instead of rm/unlink. Deletions must be recoverable."
    },
    schema: []
  },
  create(context) {
    return {
      CallExpression(node) {
        // Check for Bun.spawn/spawnSync with rm
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          (node.callee.property.name === "spawn" || node.callee.property.name === "spawnSync")
        ) {
          const firstArg = node.arguments[0];
          if (firstArg && firstArg.type === "ArrayExpression" && firstArg.elements.length > 0) {
            const cmd = firstArg.elements[0];
            if (cmd && cmd.type === "Literal" && (cmd.value === "rm" || cmd.value === "rm -rf")) {
              context.report({ node: cmd, messageId: "noShellDelete" });
            }
          }
        }
        // Check for fs.unlink/unlinkSync
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          (node.callee.property.name === "unlink" || node.callee.property.name === "unlinkSync")
        ) {
          context.report({ node: node.callee, messageId: "noShellDelete" });
        }
      }
    };
  }
};

const noLintSuppressionRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow eslint-disable and biome-ignore suppression comments."
    },
    messages: {
      noEslintDisable: "eslint-disable comments are forbidden. Fix the underlying lint issue.",
      noBiomeIgnore: "biome-ignore comments are forbidden. Fix the underlying lint issue."
    },
    schema: []
  },
  create(context) {
    return {
      Program(node) {
        const sourceCode = context.sourceCode || context.getSourceCode();
        const comments = sourceCode.getAllComments ? sourceCode.getAllComments() : [...(node.comments || [])];
        for (const comment of comments) {
          const text = comment.value;
          if (/eslint-disable/.test(text)) {
            context.report({ loc: comment.loc, messageId: "noEslintDisable" });
          }
          if (/biome-ignore/.test(text)) {
            context.report({ loc: comment.loc, messageId: "noBiomeIgnore" });
          }
        }
      }
    };
  }
};

const noDockerCliInOrchestratorRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow shelling out to docker CLI in orchestrator. Use dockerode."
    },
    messages: {
      noDockerCli:
        "Use dockerode for Docker operations in the orchestrator. Shell docker commands are only allowed in cli.ts for build tasks."
    },
    schema: []
  },
  create(context) {
    const filename = context.filename || "";
    // Only enforce in orchestrator
    if (!filename.includes("/orchestrator.ts")) {
      return {};
    }
    return {
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          (node.callee.property.name === "spawn" || node.callee.property.name === "spawnSync")
        ) {
          const firstArg = node.arguments[0];
          if (firstArg && firstArg.type === "ArrayExpression" && firstArg.elements.length > 0) {
            const cmd = firstArg.elements[0];
            if (cmd && cmd.type === "Literal" && cmd.value === "docker") {
              context.report({ node: cmd, messageId: "noDockerCli" });
            }
          }
        }
      }
    };
  }
};

export default {
  rules: {
    "no-console-in-services": noConsoleInServicesRule,
    "no-shell-delete": noShellDeleteRule,
    "no-lint-suppression-comments": noLintSuppressionRule,
    "no-docker-cli-in-orchestrator": noDockerCliInOrchestratorRule
  }
};
