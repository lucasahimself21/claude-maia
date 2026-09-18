import * as vscode from "vscode";
import { SessionNode } from "../models";
import { ISessionDiscoveryService } from "../discovery/types";
import { SessionTreeStateManager } from "../webview/SessionTreeStateManager";
import { deleteSession } from "../delete";

export async function confirmAndDeleteSessions(
  sessions: SessionNode[],
  discovery: ISessionDiscoveryService,
  stateManager: SessionTreeStateManager,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  if (sessions.length === 0) {
    return;
  }

  const confirmLabel = "Delete";
  let confirmMessage: string;

  if (sessions.length === 1) {
    confirmMessage = `Delete session "${sessions[0].title}"?`;
  } else {
    confirmMessage = `Delete ${String(sessions.length)} sessions?`;
  }

  const titlesToList = sessions.slice(0, 5).map((s) => `• ${s.title}`);
  const overflowCount = sessions.length - titlesToList.length;
  const titleLines = overflowCount > 0 ? [...titlesToList, `...and ${String(overflowCount)} more`] : titlesToList;
  const confirmDetail =
    (sessions.length > 1 ? titleLines.join("\n") + "\n\n" : "") +
    "This will permanently remove the session transcript(s) and all associated data.";

  const response = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true, detail: confirmDetail },
    confirmLabel
  );

  if (response !== confirmLabel) {
    return;
  }

  let successCount = 0;
  let failureCount = 0;
  const uniqueTranscriptPaths = new Set<string>();

  for (const session of sessions) {
    // abas de chat dessa sessão, resolvidas ANTES de apagar (depois ela some da lista e a aba não casa mais)
    const openTabs = chatTabsOf(session, stateManager);
    const result = await deleteSession(session.transcriptPath, session.sessionId);
    if (result.success) {
      outputChannel.appendLine(
        `[delete] Session ${session.sessionId} deleted. Removed paths: ${result.deletedPaths.join(", ")}`
      );
      successCount++;
      if (openTabs.length > 0) {
        await vscode.window.tabGroups.close(openTabs);
        outputChannel.appendLine(`[delete] ${String(openTabs.length)} aba(s) de chat da sessão fechada(s).`);
      }
    } else {
      outputChannel.appendLine(`[delete] Error deleting session ${session.sessionId}: ${result.error}`);
      failureCount++;
    }
    uniqueTranscriptPaths.add(session.transcriptPath);
  }

  for (const transcriptPath of uniqueTranscriptPaths) {
    discovery.invalidateSessionCache(transcriptPath);
  }

  stateManager.clearChecked();
  vscode.commands.executeCommand("setContext", "claudeSessions.hasCheckedSessions", false);
  await stateManager.refresh();

  if (failureCount === 0) {
    if (successCount === 1) {
      vscode.window.showInformationMessage("Session deleted.");
    } else {
      vscode.window.showInformationMessage(`${String(successCount)} sessions deleted.`);
    }
  } else if (successCount > 0) {
    vscode.window.showWarningMessage(
      `Deleted ${String(successCount)} of ${String(sessions.length)} sessions. Some sessions could not be removed.`
    );
  } else {
    vscode.window.showErrorMessage("Failed to delete session(s).");
  }
}

export async function confirmDangerousLaunch(sessionTitle: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration("claudeSessions");
  const shouldConfirm = config.get<boolean>("confirmDangerousSkipPermissions", true);
  if (!shouldConfirm) {
    return true;
  }

  const acceptLabel = "Open With Full Access";
  const response = await vscode.window.showWarningMessage(
    "This will run Claude with --dangerously-skip-permissions.",
    {
      modal: true,
      detail: [
        "Claude will run without normal permission prompts in this terminal session.",
        `Session: ${sessionTitle}`,
        "Use this only for trusted repos and prompts."
      ].join("\n")
    },
    acceptLabel
  );

  return response === acceptLabel;
}

/** Abas de chat da extensão Claude Code que pertencem a essa sessão (mesma regra da bolinha:
 * com dois chats de mesmo título, a aba é da sessão de escrita mais recente). */
function chatTabsOf(session: SessionNode, stateManager: SessionTreeStateManager): vscode.Tab[] {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputWebview &&
        /claude/i.test(input.viewType) &&
        stateManager.getSessionByTabLabel(tab.label)?.sessionId === session.sessionId
      ) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}
