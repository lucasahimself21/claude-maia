import { execFile, exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { findTerminalForPid, readLiveSessions } from "./liveSessions";
import { SessionNode } from "./models";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export interface OpenSessionOptions {
  readonly forceTerminal?: boolean;
  readonly dangerouslySkipPermissions?: boolean;
}

/** Time to wait for shell integration before falling back to sendText. */
export const SHELL_INTEGRATION_TIMEOUT_MS = 500;

/** Injectable dependencies for {@link executeInTerminal}, enabling unit tests. */
export interface ExecuteInTerminalDeps {
  readonly subscribe: typeof vscode.window.onDidChangeTerminalShellIntegration;
  readonly onDidStartExecution: typeof vscode.window.onDidStartTerminalShellExecution;
  readonly log: (message: string) => void;
  readonly timeoutMs: number;
}

/**
 * Execute a command in a terminal, waiting for shell integration when possible.
 *
 * Shell integration's `executeCommand` waits for the shell prompt to be ready
 * before running the command, which prevents race conditions with interactive
 * shell prompts (e.g. oh-my-zsh update checks) consuming command characters.
 *
 * The returned promise resolves once the command has actually **started running**
 * (via `onDidStartTerminalShellExecution`), or immediately after the `sendText`
 * fallback.  The caller uses this to keep a progress indicator visible for the
 * entire wait.
 *
 * Falls back to `sendText` if shell integration doesn't activate within the timeout.
 */
export function executeInTerminal(
  terminal: vscode.Terminal,
  command: string,
  deps: ExecuteInTerminalDeps
): Promise<void> {
  const { subscribe, onDidStartExecution, log, timeoutMs } = deps;

  if (terminal.shellIntegration) {
    log("[terminal] Shell integration available, using executeCommand.");
    terminal.shellIntegration.executeCommand(command);
    return awaitCommandStart(terminal, onDidStartExecution, log, timeoutMs);
  }

  return new Promise<void>((resolve) => {
    let executed = false;

    const listener = subscribe(({ terminal: t, shellIntegration }) => {
      if (t === terminal && !executed) {
        executed = true;
        listener.dispose();
        log("[terminal] Shell integration activated, using executeCommand.");
        shellIntegration.executeCommand(command);
        awaitCommandStart(terminal, onDidStartExecution, log, timeoutMs).then(resolve);
      }
    });

    setTimeout(() => {
      if (!executed) {
        executed = true;
        listener.dispose();
        log("[terminal] Shell integration not available after timeout, falling back to sendText.");
        terminal.sendText(command, true);
        resolve();
      }
    }, timeoutMs);
  });
}

/**
 * Wait for `onDidStartTerminalShellExecution` so the progress toast stays
 * visible until the command is actually running.  Resolves after a safeguard
 * timeout if the event never fires.
 */
function awaitCommandStart(
  terminal: vscode.Terminal,
  onDidStartExecution: ExecuteInTerminalDeps["onDidStartExecution"],
  log: ExecuteInTerminalDeps["log"],
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;

    const listener = onDidStartExecution(({ terminal: t }) => {
      if (t === terminal && !resolved) {
        resolved = true;
        listener.dispose();
        log("[terminal] Command execution started.");
        resolve();
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        listener.dispose();
        resolve();
      }
    }, timeoutMs);
  });
}

export class ClaudeTerminalService {
  public constructor(private readonly outputChannel: vscode.OutputChannel) {}

  public async openSession(session: SessionNode, options: OpenSessionOptions = {}): Promise<void> {
    // Extensão oficial instalada: abre (ou foca) a sessão no chat dela, salvo pedido explícito de terminal
    if (!options.forceTerminal && options.dangerouslySkipPermissions !== true) {
      const live = readLiveSessions().get(session.sessionId);
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes("claude-vscode.editor.open") && live?.source !== "terminal") {
        this.outputChannel.appendLine(`[ide] Opening session ${session.sessionId} in Claude Code extension.`);
        // mesmos args do atalho Cmd+Shift+0 (só o id): segue o "preferredLocation" da extensão,
        // senão abre no layout antigo (fullEditor) com outro visual
        await vscode.commands.executeCommand("claude-vscode.editor.open", session.sessionId);
        // sessão nova: vai pra um grupo próprio à direita (igual ao Cmd+Shift+0); já aberta: só foca
        if (!live) {
          await vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
        }
        return;
      }
    }
    const hasClaude = await this.hasClaudeBinary();
    if (!hasClaude) {
      vscode.window.showErrorMessage("Could not find `claude` in PATH. Install Claude Code CLI to resume sessions.");
      this.outputChannel.appendLine("[terminal] `claude` executable not found in PATH.");
      return;
    }

    // Sessão já rodando: foca o terminal dela em vez de abrir outro claude
    const live = readLiveSessions().get(session.sessionId);
    if (live) {
      const existing = await findTerminalForPid(vscode.window.terminals, live.pid);
      if (existing) {
        this.outputChannel.appendLine(
          `[terminal] Session ${session.sessionId} already running (pid ${String(live.pid)}), focusing terminal.`
        );
        existing.show(false);
        return;
      }
      this.outputChannel.appendLine(
        `[terminal] Session ${session.sessionId} running (pid ${String(live.pid)}) but no terminal found in this window.`
      );
      vscode.window.showInformationMessage("Essa sessão já está aberta em outra janela do VS Code.");
      return;
    }

    // sem "name": a aba segue o título que o próprio claude manda (nome do chat, acompanha /rename)
    const terminal = vscode.window.createTerminal({
      cwd: session.cwd,
      location: {
        viewColumn: vscode.ViewColumn.Active
      }
    });

    const command = buildClaudeResumeCommand(session.sessionId, options.dangerouslySkipPermissions === true);
    this.outputChannel.appendLine(
      `[terminal] Launching session ${session.sessionId} (skipPermissions=${String(options.dangerouslySkipPermissions === true)}).`
    );
    terminal.show(true);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Waiting for terminal to be ready…" },
      () =>
        executeInTerminal(terminal, command, {
          subscribe: vscode.window.onDidChangeTerminalShellIntegration,
          onDidStartExecution: vscode.window.onDidStartTerminalShellExecution,
          log: (msg) => this.outputChannel.appendLine(msg),
          timeoutMs: SHELL_INTEGRATION_TIMEOUT_MS
        })
    );
  }

  private claudeFound: boolean | undefined;

  private async hasClaudeBinary(): Promise<boolean> {
    if (this.claudeFound === undefined) {
      this.claudeFound = await this.checkClaudeBinary();
    }
    return this.claudeFound;
  }

  private async checkClaudeBinary(): Promise<boolean> {
    const checker = process.platform === "win32" ? "where" : "which";

    try {
      await execFileAsync(checker, ["claude"]);
      return true;
    } catch {
      // VS Code's extension host may have a limited PATH that excludes user shell
      // profiles. Fall back to running through the user's login shell so paths
      // from ~/.zshrc, ~/.bashrc, etc. are resolved.
      try {
        const shell = vscode.env.shell || "/bin/sh";
        await execAsync(`${checker} claude`, { env: { ...process.env, SHELL: shell } });
        return true;
      } catch {
        try {
          const shell = vscode.env.shell || "/bin/sh";
          await execAsync(`"${shell}" -l -c "${checker} claude"`);
          return true;
        } catch {
          return false;
        }
      }
    }
  }
}

export function buildClaudeResumeCommand(sessionId: string, dangerouslySkipPermissions: boolean): string {
  const args = ["claude"];
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  args.push("--resume", shellQuote(sessionId));
  return args.join(" ");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
