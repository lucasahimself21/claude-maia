// Atualização da própria Claude Maia pelo GitHub Releases (repo público lucasahimself21/claude-maia).
// Confere ao ativar e a cada 6 h; se a release mais nova tem versão maior que a instalada, liga o
// contexto claudeMaia.updateAvailable (botão "Atualizar" no título da view) e avisa uma vez.
// "Atualizar" baixa o .vsix da release pra pasta temporária e instala pelo próprio VS Code.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const REPO = "lucasahimself21/claude-maia";
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

interface Release {
  readonly tag_name: string;
  readonly html_url: string;
  readonly assets: readonly { readonly name: string; readonly browser_download_url: string }[];
}

let latest: Release | undefined;
let installedPending: string | undefined;

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number(n) || 0);
}

function newer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) > (y[i] ?? 0);
    }
  }
  return false;
}

async function fetchLatest(): Promise<Release | undefined> {
  const res = await fetch(API_LATEST, {
    headers: { "User-Agent": "claude-maia", Accept: "application/vnd.github+json" }
  });
  if (!res.ok) {
    return undefined;
  }
  return (await res.json()) as Release;
}

export function setupUpdater(
  context: vscode.ExtensionContext,
  log: (msg: string) => void,
  onAvailable: (version: string | undefined, mode?: "update" | "reload") => void
): void {
  const current = (context.extension.packageJSON as { version: string }).version;
  let notified = false;
  let lastCheck = 0;

  const check = async (interactive: boolean) => {
    // GitHub limita 60 consultas/h sem login: no máximo 1 a cada 30 s fora do pedido manual (22/09: era 2 min;
    // com a checagem ao focar a janela, a release nova aparece na primeira volta ao VS Code)
    if (!interactive && Date.now() - lastCheck < 30000) {
      return;
    }
    lastCheck = Date.now();
    try {
      latest = await fetchLatest();
    } catch (err) {
      log(`[update] falha ao consultar releases: ${String(err)}`);
      latest = undefined;
    }
    if (installedPending) {
      onAvailable(installedPending, "reload"); // já baixada: só falta recarregar
      return;
    }
    const available =
      latest !== undefined && newer(latest.tag_name, current) && latest.assets.some((a) => a.name.endsWith(".vsix"));
    await vscode.commands.executeCommand("setContext", "claudeMaia.updateAvailable", available);
    onAvailable(available && latest ? latest.tag_name : undefined);
    if (available && latest && (interactive || !notified)) {
      notified = true;
      const choice = await vscode.window.showInformationMessage(
        `Claude Maia ${latest.tag_name} disponível (instalada: ${current}).`,
        "Atualizar",
        "Ver no GitHub"
      );
      if (choice === "Atualizar") {
        await vscode.commands.executeCommand("claudeMaia.update");
      } else if (choice === "Ver no GitHub") {
        await vscode.env.openExternal(vscode.Uri.parse(latest.html_url));
      }
    } else if (interactive && !available) {
      void vscode.window.showInformationMessage(`Claude Maia ${current} já é a mais nova.`);
    }
  };

  const update = async () => {
    if (!latest) {
      await check(true);
      if (!latest) {
        return;
      }
    }
    const asset = latest.assets.find((a) => a.name.endsWith(".vsix"));
    if (!asset) {
      void vscode.window.showWarningMessage("Claude Maia: a release não tem .vsix.");
      return;
    }
    const tag = latest.tag_name;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Claude Maia: baixando ${tag}…` },
      async () => {
        const res = await fetch(asset.browser_download_url, { headers: { "User-Agent": "claude-maia" } });
        if (!res.ok) {
          throw new Error(`HTTP ${String(res.status)}`);
        }
        const dest = path.join(os.tmpdir(), asset.name);
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        log(`[update] ${tag} baixado em ${dest}`);
        await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(dest));
      }
    );
    await vscode.commands.executeCommand("setContext", "claudeMaia.updateAvailable", false);
    installedPending = tag;
    onAvailable(tag, "reload"); // botão do rodapé vira "Recarregar pra ativar vX"
    const choice = await vscode.window.showInformationMessage(
      `Claude Maia ${tag} instalada. Recarregue a janela.`,
      "Reload Window"
    );
    if (choice) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeMaia.checkUpdate", () => check(true)),
    vscode.commands.registerCommand("claudeMaia.checkUpdateQuiet", () => check(false)),
    vscode.commands.registerCommand("claudeMaia.update", () =>
      update().catch(
        (err: unknown) => void vscode.window.showErrorMessage(`Claude Maia: não deu pra atualizar (${String(err)})`)
      )
    )
  );
  setTimeout(() => void check(false), 5000);
  const tick = setInterval(() => void check(false), 3600 * 1000);
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((st) => {
      if (st.focused) {
        void check(false);
      }
    })
  );
  context.subscriptions.push({ dispose: () => clearInterval(tick) });
}
