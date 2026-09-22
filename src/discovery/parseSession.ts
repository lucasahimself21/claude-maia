import * as fs from "fs";
import * as vscode from "vscode";
import { extractText, isDisplayableUserPrompt, isRecord } from "./content";
import { isNormalizedPathWithin, isPathWithin, normalizeFsPath } from "./pathUtils";
import { chooseSessionTitleRaw, toNonEmptySingleLine } from "./title";
import { ParsedSession } from "./types";

// Estado acumulado do parse (22/09): todos os campos são "primeiro" ou "último", então dá pra continuar de
// onde parou. A sessão ativa cresce a cada tool call (6 MB+), e reler tudo a cada mudança era o que deixava a
// lista lenta pra atualizar. `offset` = bytes já consumidos; `partial` = última linha incompleta (arquivo
// sendo escrito), que é colada no próximo trecho.
export interface ParseState {
  offset: number;
  partial: string;
  sessionId?: string;
  cwd?: string;
  firstPromptRaw?: string;
  firstUserRaw?: string;
  latestExplicitTitle?: string;
  latestAiTitle?: string;
  latestAgentName?: string;
  titleHistory: string[];
}

export function emptyParseState(): ParseState {
  return { offset: 0, partial: "", titleHistory: [] };
}

function applyLine(state: ParseState, line: string, transcriptPath: string, log: (msg: string) => void): void {
  if (!line.trim()) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    log(`[discovery] malformed JSON in ${transcriptPath}: ${String(error)}`);
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }
  if (!state.sessionId && typeof parsed.sessionId === "string" && parsed.sessionId.trim() !== "") {
    state.sessionId = parsed.sessionId;
  }
  if (!state.cwd && typeof parsed.cwd === "string" && parsed.cwd.trim() !== "") {
    state.cwd = parsed.cwd;
  }
  if (parsed.type === "custom-title") {
    const customTitle = toNonEmptySingleLine(parsed.customTitle);
    if (customTitle) {
      state.latestExplicitTitle = customTitle;
      state.titleHistory.push(customTitle);
    }
  }
  // o Claude Code repete o agent-name (nome antigo) a cada resposta, depois do custom-title;
  // a aba do chat usa o custom-title, então ele só vale quando não há nenhum
  if (parsed.type === "agent-name") {
    const agentName = toNonEmptySingleLine(parsed.agentName);
    if (agentName) {
      state.latestAgentName = agentName;
      state.titleHistory.push(agentName);
    }
  }
  // nome que o próprio Claude Code dá ao chat (aparece no /resume); vale menos que /rename
  if (parsed.type === "ai-title") {
    const aiTitle = toNonEmptySingleLine(parsed.aiTitle);
    if (aiTitle) {
      state.latestAiTitle = aiTitle;
      state.titleHistory.push(aiTitle);
    }
  }
  if (parsed.type === "user" && parsed.message?.role === "user") {
    const text = extractText(parsed.message.content);
    if (text.trim()) {
      if (!state.firstUserRaw) {
        state.firstUserRaw = text;
      }
      if (!state.firstPromptRaw && isDisplayableUserPrompt(text)) {
        state.firstPromptRaw = text;
      }
    }
  }
}

function toParsed(state: ParseState): ParsedSession | null {
  if (!state.sessionId || !state.cwd) {
    return null;
  }
  return {
    sessionId: state.sessionId,
    cwd: state.cwd,
    titleSourceRaw:
      chooseSessionTitleRaw({
        latestExplicitTitle: state.latestExplicitTitle ?? state.latestAgentName ?? state.latestAiTitle,
        firstPromptRaw: state.firstPromptRaw,
        firstUserRaw: state.firstUserRaw
      }) ?? "",
    titleHistory: [...new Set(state.titleHistory)]
  };
}

// Lê só o que foi acrescentado desde `prev.offset` (arquivo encolheu ou foi reescrito → recomeça do zero).
export async function parseTranscriptIncremental(
  transcriptPath: string,
  log: (msg: string) => void,
  prev?: ParseState
): Promise<{ parsed: ParsedSession | null; state: ParseState }> {
  let state: ParseState = prev ? { ...prev, titleHistory: [...prev.titleHistory] } : emptyParseState();
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(transcriptPath, "r");
    const { size } = await handle.stat();
    if (size < state.offset) {
      state = emptyParseState();
    }
    if (size > state.offset) {
      const buf = Buffer.alloc(size - state.offset);
      await handle.read(buf, 0, buf.length, state.offset);
      state.offset = size;
      const chunk = state.partial + buf.toString("utf8");
      const lines = chunk.split("\n");
      // última fatia: linha completa se o chunk terminou em "\n", senão fica pra próxima leitura
      state.partial = lines.pop() ?? "";
      for (const line of lines) {
        applyLine(state, line, transcriptPath, log);
      }
    }
  } finally {
    await handle?.close();
  }
  // linha final sem "\n" (arquivo fechado): parseia sem consumir, pra não perder se ainda vier mais
  const parsedState: ParseState = { ...state, titleHistory: [...state.titleHistory] };
  if (state.partial.trim()) {
    applyLine(parsedState, state.partial, transcriptPath, log);
  }
  return { parsed: toParsed(parsedState), state };
}

export async function parseTranscriptFile(
  transcriptPath: string,
  log: (msg: string) => void
): Promise<ParsedSession | null> {
  try {
    return (await parseTranscriptIncremental(transcriptPath, log)).parsed;
  } catch (error) {
    log(`[discovery] read failed for ${transcriptPath}: ${String(error)}`);
    return null;
  }
}

export function matchWorkspace(
  sessionCwd: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): vscode.WorkspaceFolder | undefined {
  const normalizedCwd = normalizeFsPath(sessionCwd);
  const matching = workspaceFolders
    .filter((folder) => isPathWithin(normalizedCwd, normalizeFsPath(folder.uri.fsPath)))
    .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);

  return matching[0];
}

export interface NormalizedWorkspaceFolder {
  readonly folder: vscode.WorkspaceFolder;
  readonly normalizedPath: string;
}

export function precomputeWorkspacePaths(
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): NormalizedWorkspaceFolder[] {
  return workspaceFolders
    .map((folder) => ({
      folder,
      normalizedPath: normalizeFsPath(folder.uri.fsPath)
    }))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);
}

export function matchWorkspacePrecomputed(
  sessionCwd: string,
  precomputed: readonly NormalizedWorkspaceFolder[]
): vscode.WorkspaceFolder | undefined {
  const normalizedCwd = normalizeFsPath(sessionCwd);
  for (const entry of precomputed) {
    if (isNormalizedPathWithin(normalizedCwd, entry.normalizedPath)) {
      return entry.folder;
    }
  }
  return undefined;
}
