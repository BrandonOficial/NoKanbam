import * as vscode from "vscode";
import { TextEncoder, TextDecoder } from "util";

interface QuickNote {
  id: string;
  text: string;
  timestamp: string;
  tags?: string[];
}

interface Task {
  text: string;
  done: boolean;
  priority?: string;
}

interface StorageData {
  notepadContent: string;
  todoList: Task[];
  quickNotes: QuickNote[];
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new NotepadSidebarProvider(
    context.extensionUri,
    context.globalState
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("notepad-sidebar", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("notepad.clear", () => {
      provider.clearNotes();
    })
  );
}

class NotepadSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _autoBackupInterval?: NodeJS.Timeout;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _globalState: vscode.Memento
  ) {
    this._initializeAutoBackup();
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const savedNotes = this._getSavedNotes();
    const savedTasks = this._getSavedTasks();
    const autoBackupEnabled = this._globalState.get<boolean>(
      "autoBackupEnabled",
      false
    );
    const autoBackupInterval = this._globalState.get<number>(
      "autoBackupInterval",
      30
    );

    // Verificar status de autenticação
    const isAuthenticated = await this._checkGitHubAuth();

    this._updateBadge(savedTasks);

    webviewView.webview.html = await this._getHtmlForWebview(
      webviewView.webview,
      savedNotes,
      savedTasks,
      autoBackupEnabled,
      autoBackupInterval,
      isAuthenticated
    );

    webviewView.webview.onDidReceiveMessage(async (data) => {
      await this._handleWebviewMessage(data);
    });
  }

  private _getSavedNotes(): string {
    return this._globalState.get<string>("notepadContent", "");
  }

  private _getSavedTasks(): any[] {
    return this._globalState.get<any[]>("todoList", []);
  }

  private async _handleWebviewMessage(data: any): Promise<void> {
    switch (data.command) {
      case "saveNotes":
        await this._globalState.update("notepadContent", data.text);
        break;
      case "saveTasks":
        await this._globalState.update("todoList", data.tasks);
        this._updateBadge(data.tasks);
        break;
      case "export":
        await this._exportData();
        break;
      case "import":
        await this._importData();
        break;
      case "syncGist":
        await this._syncGist();
        break;
      case "authenticateGist":
        const token = await this._authenticateGitHub();
        if (token) {
          vscode.window.showInformationMessage(
            "Autenticado com GitHub com sucesso!"
          );
          if (this._view) {
            this._view.webview.postMessage({
              command: "updateAuthStatus",
              authenticated: true,
            });
          }
        }
        break;
      case "disconnectGist":
        await this._disconnectGitHub();
        break;
      case "enableAutoBackup":
        await this._enableAutoBackup(data.enabled, data.interval);
        break;
    }
  }

  public clearNotes() {
    this._globalState.update("notepadContent", "");
    this._globalState.update("todoList", []);

    if (this._view) {
      this._view.badge = undefined;
      this._view.webview.postMessage({ command: "clearAll" });
    }
  }

  private _updateBadge(tasks: any[]) {
    if (!this._view || !Array.isArray(tasks)) {
      return;
    }

    const validTasks = tasks.filter((t) => t?.text?.trim());
    const pendingCount = validTasks.filter((t) => !t.done).length;

    this._view.badge =
      pendingCount > 0
        ? {
            tooltip: `${pendingCount} tarefa(s) pendente(s)`,
            value: pendingCount,
          }
        : undefined;
  }

  private async _importData() {
    const options: vscode.OpenDialogOptions = {
      canSelectMany: false,
      openLabel: "Importar",
      filters: {
        "Todos os formatos": ["txt", "md", "json"],
        Markdown: ["md"],
        Texto: ["txt"],
        JSON: ["json"],
      },
    };

    const fileUri = await vscode.window.showOpenDialog(options);

    if (fileUri?.[0]) {
      try {
        const fileData = await vscode.workspace.fs.readFile(fileUri[0]);
        const fileContent = new TextDecoder().decode(fileData);
        const fileName = fileUri[0].fsPath.toLowerCase();

        // Verificar se é JSON
        if (fileName.endsWith(".json")) {
          try {
            const data = JSON.parse(fileContent);
            if (data.notes !== undefined) {
              await this._globalState.update(
                "notepadContent",
                data.notes || ""
              );
            }
            if (data.tasks !== undefined) {
              await this._globalState.update("todoList", data.tasks || []);
              this._updateBadge(data.tasks || []);
            }

            if (this._view) {
              this._view.webview.postMessage({
                command: "updateNotes",
                text: data.notes || "",
              });
              this._view.webview.postMessage({
                command: "updateTasks",
                tasks: data.tasks || [],
              });
              vscode.window.showInformationMessage(
                "JSON importado com sucesso!"
              );
            }
          } catch (jsonError) {
            vscode.window.showErrorMessage(
              "Erro ao importar JSON. Verifique se o arquivo é válido."
            );
          }
        } else {
          // Importação de texto normal (TXT/MD)
          await this._globalState.update("notepadContent", fileContent);

          if (this._view) {
            this._view.webview.postMessage({
              command: "updateNotes",
              text: fileContent,
            });
            vscode.window.showInformationMessage("Importado com sucesso!");
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage("Erro ao ler arquivo.");
      }
    }
  }

  private async _exportData() {
    const notes = this._getSavedNotes();
    const tasks = this._getSavedTasks();

    const uri = await vscode.window.showSaveDialog({
      saveLabel: "Exportar",
      filters: {
        "Todos os formatos": ["txt", "md", "json"],
        Markdown: ["md"],
        Texto: ["txt"],
        JSON: ["json"],
      },
    });

    if (uri) {
      const fileName = uri.fsPath.toLowerCase();
      let content: string;
      let message: string;

      if (fileName.endsWith(".json")) {
        // Exportar como JSON
        const data = {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          notes,
          tasks,
        };
        content = JSON.stringify(data, null, 2);
        message = "JSON exportado com sucesso!";
      } else {
        // Exportar como texto (MD/TXT)
        content = this._generateExportContent(notes, tasks);
        message = "Salvo com sucesso!";
      }

      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(content)
      );
      vscode.window.showInformationMessage(message);
    }
  }

  private _generateExportContent(notes: string, tasks: any[]): string {
    const date = new Date().toLocaleDateString("pt-BR");
    let content = `=== NOTEPAD PRO - ${date} ===\n\n`;
    content += `--- NOTAS ---\n${notes || "(Vazio)"}\n\n`;
    content += `--- TAREFAS ---\n`;

    if (!tasks?.length) {
      content += `(Nenhuma tarefa)\n`;
    } else {
      tasks.forEach((t) => {
        const priority = t.priority ? `[${t.priority.toUpperCase()}] ` : "";
        content += `[${t.done ? "x" : " "}] ${priority}${t.text}\n`;
      });
    }

    return content;
  }

  private async _checkGitHubAuth(): Promise<boolean> {
    const token = await this._getGitHubToken();
    return token !== null;
  }

  private async _getHtmlForWebview(
    webview: vscode.Webview,
    notes: string,
    tasks: any[],
    autoBackupEnabled: boolean = false,
    autoBackupInterval: number = 30,
    isAuthenticated: boolean = false
  ): Promise<string> {
    const safeNotes = this._sanitizeForJson(notes);
    const safeTasks = JSON.stringify(tasks);

    return `<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            font-size: 13px;
            height: 100vh;
            display: flex;
            flex-direction: column;
            background: var(--vscode-sideBar-background);
            color: var(--vscode-foreground);
            overflow: hidden;
        }

        /* HEADER MINIMALISTA */
        .header {
            display: flex;
            align-items: center;
            padding: 16px 16px 0;
            gap: 4px;
            position: relative;
            z-index: 2;
        }

        .tab-btn {
            flex: 1;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            padding: 12px 16px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.8px;
            text-transform: uppercase;
            opacity: 0.5;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            border-radius: 8px 8px 0 0;
            position: relative;
        }

        .tab-btn::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 50%;
            transform: translateX(-50%) scaleX(0);
            width: 40%;
            height: 2px;
            background: var(--vscode-textLink-activeForeground);
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            border-radius: 2px;
        }

        .tab-btn:hover {
            opacity: 0.8;
            background: var(--vscode-list-hoverBackground);
        }

        .tab-btn.active {
            opacity: 1;
            background: var(--vscode-editor-background);
            margin-bottom: -1px;
            padding-bottom: 13px;
        }

        .tab-btn.active::after {
            transform: translateX(-50%) scaleX(1);
        }

        /* ACTIONS */
        .actions {
            display: flex;
            gap: 4px;
            padding: 0 0 0 8px;
        }

        .action-btn {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            opacity: 0.5;
            padding: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            transition: all 0.2s;
            width: 36px;
            height: 36px;
        }

        .action-btn:hover {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
            transform: translateY(-1px);
        }

        .action-btn:active {
            transform: translateY(0);
        }

        /* CONTENT VIEWS */
        .content-view {
            display: none;
            flex: 1;
            flex-direction: column;
            overflow: hidden;
            background: var(--vscode-editor-background);
            border-radius: 8px 0 0 0;
            margin: 0 16px 0 0;
            position: relative;
            z-index: 1;
        }

        .content-view.active {
            display: flex;
        }

        #view-notes {
            border-radius: 8px 8px 0 0;
            margin: 0 16px;
        }

        /* NOTES AREA */
        .notes-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            position: relative;
        }

        textarea {
            flex: 1;
            background: transparent;
            color: var(--vscode-editor-foreground);
            border: none;
            padding: 24px;
            resize: none;
            outline: none;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            line-height: 1.8;
            display: block;
        }

        textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 0.4;
            font-style: italic;
        }

        /* TASKS */
        .task-controls {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .task-input-container {
            display: flex;
            gap: 10px;
        }

        .search-container {
            position: relative;
        }

        #task-search {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 32px 8px 12px;
            border-radius: 6px;
            outline: none;
            font-size: 12px;
            transition: all 0.2s;
        }

        #task-search:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }

        .search-icon {
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            opacity: 0.4;
            pointer-events: none;
        }

        .filter-buttons {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .filter-btn {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 500;
            transition: all 0.2s;
        }

        .filter-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .filter-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }

        #task-input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 10px 14px;
            border-radius: 8px;
            outline: none;
            font-size: 13px;
            transition: all 0.2s;
        }

        #task-input:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }

        #add-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            padding: 0 20px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 18px;
            transition: all 0.2s;
            min-width: 44px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        #add-btn:hover {
            background: var(--vscode-button-hoverBackground);
            transform: scale(1.05);
        }

        #add-btn:active {
            transform: scale(0.98);
        }

        /* TASK LIST */
        ul {
            list-style: none;
            padding: 12px;
            margin: 0;
            overflow-y: auto;
            flex: 1;
        }

        li {
            display: flex;
            align-items: center;
            padding: 12px 14px;
            margin-bottom: 6px;
            border-radius: 8px;
            transition: all 0.2s;
            cursor: default;
            background: var(--vscode-sideBar-background);
            border: 1px solid transparent;
            position: relative;
        }

        li.hidden {
            display: none;
        }

        li:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-panel-border);
            transform: translateX(2px);
        }

        /* PRIORITY INDICATORS */
        .priority-indicator {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            margin-right: 10px;
            flex-shrink: 0;
            transition: all 0.2s;
        }

        .priority-high { 
            background: #f14c4c; 
            box-shadow: 0 0 8px rgba(241, 76, 76, 0.4);
        }
        .priority-medium { 
            background: #cca700; 
            box-shadow: 0 0 8px rgba(204, 167, 0, 0.4);
        }
        .priority-low { 
            background: #89d185; 
            box-shadow: 0 0 8px rgba(137, 209, 133, 0.4);
        }

        .priority-menu-wrapper {
            position: relative;
            margin-left: 8px;
        }

        .priority-menu-btn {
            background: transparent;
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-foreground);
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            display: grid;
            place-items: center;
            opacity: 0.7;
            transition: all 0.2s;
        }

        .priority-menu-btn:hover {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .priority-menu {
            position: absolute;
            right: 0;
            top: 34px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            box-shadow: 0 6px 14px rgba(0,0,0,0.35);
            min-width: 160px;
            display: none;
            z-index: 5;
        }

        .priority-menu.open {
            display: block;
        }

        .priority-menu-item {
            width: 100%;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            padding: 10px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }

        .priority-menu-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .priority-menu-item .priority-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            flex-shrink: 0;
        }

        /* CUSTOM CHECKBOX */
        input[type="checkbox"] {
            appearance: none;
            width: 18px;
            height: 18px;
            border: 2px solid var(--vscode-icon-foreground);
            border-radius: 50%;
            cursor: pointer;
            margin-right: 12px;
            display: grid;
            place-content: center;
            transition: all 0.2s;
            flex-shrink: 0;
        }

        input[type="checkbox"]::before {
            content: "";
            width: 10px;
            height: 10px;
            border-radius: 50%;
            transform: scale(0);
            transition: 120ms transform cubic-bezier(0.4, 0, 0.2, 1);
            background: var(--vscode-button-background);
        }

        input[type="checkbox"]:checked {
            border-color: var(--vscode-button-background);
            background: var(--vscode-button-background);
        }

        input[type="checkbox"]:checked::before {
            transform: scale(1);
            background: white;
        }

        input[type="checkbox"]:hover {
            border-color: var(--vscode-button-background);
            transform: scale(1.1);
        }

        .task-text {
            flex: 1;
            font-size: 13px;
            color: var(--vscode-foreground);
            word-break: break-word;
            line-height: 1.5;
            transition: all 0.3s;
        }

        .completed .task-text {
            text-decoration: line-through;
            opacity: 0.4;
            color: var(--vscode-descriptionForeground);
        }

        .delete-btn {
            background: transparent;
            border: none;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            opacity: 0;
            padding: 6px;
            border-radius: 6px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .delete-btn:hover {
            background: var(--vscode-inputValidation-errorBackground);
            opacity: 1 !important;
            transform: scale(1.1);
        }

        li:hover .delete-btn {
            opacity: 0.6;
        }

        /* SCROLLBAR MODERNA */
        ::-webkit-scrollbar {
            width: 8px;
        }

        ::-webkit-scrollbar-track {
            background: transparent;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }

        /* EMPTY STATE */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px 20px;
            opacity: 0.4;
            text-align: center;
        }

        .empty-state svg {
            width: 48px;
            height: 48px;
            margin-bottom: 12px;
            opacity: 0.5;
        }

        .empty-state p {
            font-size: 12px;
            line-height: 1.6;
        }

        /* SETTINGS MODAL */
        .settings-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .settings-modal.active {
            display: flex;
        }

        .settings-content {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 24px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }

        .settings-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .settings-header h2 {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
        }

        .close-btn {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 24px;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s;
        }

        .close-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .settings-section {
            margin-bottom: 24px;
        }

        .settings-section h3 {
            margin: 0 0 12px 0;
            font-size: 14px;
            font-weight: 600;
        }

        .settings-item {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 16px;
        }

        .settings-item label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .settings-item input,
        .settings-item select {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 13px;
            outline: none;
        }

        .settings-item input:focus,
        .settings-item select:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }

        .settings-item input[type="checkbox"] {
            width: auto;
            height: auto;
            margin: 0;
            cursor: pointer;
        }

        .checkbox-row {
            flex-direction: row;
            align-items: center;
            gap: 8px;
        }

        .settings-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.2s;
            width: 100%;
            margin-top: 8px;
        }

        .settings-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .settings-btn.secondary {
            background: var(--vscode-input-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-input-border);
        }

        .settings-btn.secondary:hover {
            background: var(--vscode-list-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="header">
        <button class="tab-btn active" onclick="switchTab('notes')">Notes</button>
        <button class="tab-btn" onclick="switchTab('tasks')">Tasks</button>
        <div class="actions">
            <button class="action-btn" id="import-btn" title="Importar">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M7.646 1.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 2.707V11.5a.5.5 0 0 1-1 0V2.707L5.354 4.854a.5.5 0 1 1-.708-.708l3-3z"/>
                    <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                </svg>
            </button>
            <button class="action-btn" id="export-btn" title="Exportar">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
                    <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                </svg>
            </button>
            <button class="action-btn" id="settings-btn" title="Configurações">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
                    <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a1.873 1.873 0 0 1-1.255 1.327l-.319.094a1.785 1.785 0 0 0-1.201 1.201l-.094.319c-1.79.527-1.79 3.065 0 3.592l.319.094a1.785 1.785 0 0 0 1.201 1.201l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a1.873 1.873 0 0 1 1.255-1.327l.319-.094a1.785 1.785 0 0 0 1.201-1.201l.094-.319c1.79-.527 1.79-3.065 0-3.592l-.319-.094a1.785 1.785 0 0 0-1.201-1.201l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 1.255 1.327l.319.094c.335.093.58.339.673.673l.094.319c.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-1.255-1.327l-.319-.094a1.785 1.785 0 0 1-1.201-1.201l-.094-.319z"/>
                </svg>
            </button>
        </div>
    </div>

    <div id="view-notes" class="content-view active">
        <div class="notes-container">
            <textarea id="notes-area" placeholder="Comece a escrever suas ideias..."></textarea>
        </div>
    </div>

    <div id="view-tasks" class="content-view">
        <div class="task-controls">
            <div class="task-input-container">
                <input type="text" id="task-input" placeholder="Nova tarefa..." autocomplete="off" />
                <button id="add-btn">+</button>
            </div>
            <div class="search-container">
                <input type="text" id="task-search" placeholder="Buscar tarefas..." autocomplete="off" />
                <svg class="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                </svg>
            </div>
            <div class="filter-buttons">
                <button class="filter-btn active" data-filter="all">Todas</button>
                <button class="filter-btn" data-filter="pending">Pendentes</button>
                <button class="filter-btn" data-filter="completed">Concluídas</button>
                <button class="filter-btn" data-filter="high">Alta</button>
                <button class="filter-btn" data-filter="medium">Média</button>
                <button class="filter-btn" data-filter="low">Baixa</button>
            </div>
        </div>
        <ul id="task-list"></ul>
    </div>

    <div class="settings-modal" id="settings-modal">
        <div class="settings-content">
            <div class="settings-header">
                <h2>Configurações</h2>
                <button class="close-btn" id="close-settings">&times;</button>
            </div>
            
            <div class="settings-section">
                <h3>Sincronização GitHub Gist</h3>
                <div class="settings-item">
                    <p id="auth-status" style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">
                        Status: Não autenticado
                    </p>
                    <button class="settings-btn" id="authenticate-gist-btn" style="display: flex; align-items: center; justify-content: center; gap: 8px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                        </svg>
                        Autenticar com GitHub
                    </button>
                    <button class="settings-btn secondary" id="disconnect-gist-btn" style="margin-top: 8px; display: none;">Desconectar</button>
                    <button class="settings-btn secondary" id="sync-gist-btn" style="margin-top: 8px;">Sincronizar Agora</button>
                </div>
            </div>

            <div class="settings-section">
                <h3>Backup Automático</h3>
                <div class="settings-item checkbox-row">
                    <input type="checkbox" id="auto-backup-checkbox" />
                    <label for="auto-backup-checkbox">Habilitar backup automático</label>
                </div>
                <div class="settings-item">
                    <label>Intervalo (minutos)</label>
                    <select id="backup-interval-select">
                        <option value="15">15 minutos</option>
                        <option value="30" selected>30 minutos</option>
                        <option value="60">1 hora</option>
                        <option value="120">2 horas</option>
                        <option value="240">4 horas</option>
                    </select>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const notesArea = document.getElementById('notes-area');
        const taskListEl = document.getElementById('task-list');
        const taskInput = document.getElementById('task-input');
        const taskSearch = document.getElementById('task-search');
        
        notesArea.value = "${safeNotes}";
        let tasks = ${safeTasks};
        let currentFilter = 'all';
        let searchQuery = '';
        
        // Inicializar configurações
        document.getElementById('auto-backup-checkbox').checked = ${autoBackupEnabled};
        document.getElementById('backup-interval-select').value = '${autoBackupInterval}';
        updateAuthStatus(${isAuthenticated});

        notesArea.addEventListener('input', () => {
            vscode.postMessage({ command: 'saveNotes', text: notesArea.value });
        });

        function getFilteredTasks() {
            let filtered = tasks.filter(task => {
                if (!task?.text) return false;
                
                // Search filter
                if (searchQuery && !task.text.toLowerCase().includes(searchQuery.toLowerCase())) {
                    return false;
                }
                
                // Status filter
                if (currentFilter === 'pending' && task.done) return false;
                if (currentFilter === 'completed' && !task.done) return false;
                
                // Priority filter
                if (currentFilter === 'high' && task.priority !== 'high') return false;
                if (currentFilter === 'medium' && task.priority !== 'medium') return false;
                if (currentFilter === 'low' && task.priority !== 'low') return false;
                
                return true;
            });
            
            // Sort by priority: high > medium > low > none
            const priorityOrder = { high: 0, medium: 1, low: 2, none: 3 };
            filtered.sort((a, b) => {
                const aPriority = priorityOrder[a.priority] ?? priorityOrder.none;
                const bPriority = priorityOrder[b.priority] ?? priorityOrder.none;
                if (aPriority !== bPriority) return aPriority - bPriority;
                return 0;
            });
            
            return filtered;
        }

        function renderTasks() {
            const filteredTasks = getFilteredTasks();
            
            if (!filteredTasks.length) {
                taskListEl.innerHTML = \`
                    <div class="empty-state">
                        <svg viewBox="0 0 16 16" fill="currentColor">
                            <path d="M2 2.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5H2zM3 3H2v1h1V3z"/>
                            <path d="M5 3.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zM5.5 7a.5.5 0 0 0 0 1h9a.5.5 0 0 0 0-1h-9zm0 4a.5.5 0 0 0 0 1h9a.5.5 0 0 0 0-1h-9z"/>
                            <path d="M1.5 7a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V7zM2 7h1v1H2V7zm0 3.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5H2zm1 .5H2v1h1v-1z"/>
                        </svg>
                        <p>\${tasks.length === 0 ? 'Nenhuma tarefa ainda.<br>Adicione uma acima!' : 'Nenhuma tarefa encontrada.'}</p>
                    </div>
                \`;
                return;
            }

            taskListEl.innerHTML = '';
            filteredTasks.forEach((task) => {
                const index = tasks.indexOf(task);
                if (index === -1) return;

                const priority = task.priority || 'none';
                const priorityClass = priority !== 'none' ? \`priority-\${priority}\` : '';
                
                const li = document.createElement('li');
                li.className = task.done ? 'completed' : '';
                li.innerHTML = \`
                    <input type="checkbox" \${task.done ? 'checked' : ''} onchange="toggleTask(\${index})">
                    \${priority !== 'none' ? \`<div class="priority-indicator \${priorityClass}"></div>\` : '<div class="priority-indicator" style="opacity: 0;"></div>'}
                    <span class="task-text" onclick="toggleTask(\${index})">\${task.text}</span>
                    <div class="priority-menu-wrapper">
                        <button class="priority-menu-btn" onclick="togglePriorityMenu(event, \${index})" title="Prioridade">...</button>
                        <div class="priority-menu" data-index="\${index}">
                            <button class="priority-menu-item" onclick="setPriority(\${index}, 'high')">
                                <span class="priority-dot priority-high"></span>
                                Alta
                            </button>
                            <button class="priority-menu-item" onclick="setPriority(\${index}, 'medium')">
                                <span class="priority-dot priority-medium"></span>
                                Média
                            </button>
                            <button class="priority-menu-item" onclick="setPriority(\${index}, 'low')">
                                <span class="priority-dot priority-low"></span>
                                Baixa
                            </button>
                            <button class="priority-menu-item" onclick="setPriority(\${index}, undefined)">
                                <span class="priority-dot" style="background: var(--vscode-input-border);"></span>
                                Sem prioridade
                            </button>
                        </div>
                    </div>
                    <button class="delete-btn" onclick="deleteTask(\${index})" title="Excluir">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.75 1.75 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.702-1.576l-.66-6.6a.75.75 0 1 1 1.493-.149Z"/>
                        </svg>
                    </button>
                \`;
                taskListEl.appendChild(li);
            });
        }

        function addTask() {
            const text = taskInput.value.trim();
            if (text) {
                tasks.push({ text, done: false, priority: 'medium' });
                taskInput.value = '';
                updateTasks();
            }
        }

        window.toggleTask = (index) => {
            tasks[index].done = !tasks[index].done;
            updateTasks();
        };

        window.deleteTask = (index) => {
            tasks.splice(index, 1);
            updateTasks();
        };

        window.setPriority = (index, priority) => {
            tasks[index].priority = priority;
            closePriorityMenus();
            updateTasks();
        };

        window.togglePriorityMenu = (event, index) => {
            event.stopPropagation();
            const menus = document.querySelectorAll('.priority-menu');
            menus.forEach((menu) => {
                if (menu.dataset.index !== String(index)) {
                    menu.classList.remove('open');
                }
            });
            const currentMenu = document.querySelector(\`.priority-menu[data-index="\${index}"]\`);
            currentMenu?.classList.toggle('open');
        };

        function closePriorityMenus() {
            document.querySelectorAll('.priority-menu').forEach(menu => menu.classList.remove('open'));
        }
        
        function updateTasks() {
            renderTasks();
            const cleanTasks = tasks.filter(t => t?.text?.trim());
            vscode.postMessage({ command: 'saveTasks', tasks: cleanTasks });
        }

        // Search functionality
        taskSearch.addEventListener('input', (e) => {
            searchQuery = e.target.value;
            renderTasks();
        });

        // Filter functionality
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFilter = btn.dataset.filter;
                renderTasks();
            });
        });

        document.getElementById('add-btn').addEventListener('click', addTask);
        document.getElementById('export-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'export' });
        });
        document.getElementById('import-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'import' });
        });
        document.getElementById('settings-btn').addEventListener('click', () => {
            document.getElementById('settings-modal').classList.add('active');
        });
        document.getElementById('close-settings').addEventListener('click', () => {
            document.getElementById('settings-modal').classList.remove('active');
        });
        document.getElementById('authenticate-gist-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'authenticateGist' });
        });
        document.getElementById('disconnect-gist-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'disconnectGist' });
        });
        document.getElementById('sync-gist-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'syncGist' });
        });
        
        function updateAuthStatus(authenticated) {
            const statusEl = document.getElementById('auth-status');
            const authBtn = document.getElementById('authenticate-gist-btn');
            const disconnectBtn = document.getElementById('disconnect-gist-btn');
            if (authenticated) {
                statusEl.textContent = 'Status: Autenticado ✓';
                statusEl.style.color = 'var(--vscode-textLink-foreground)';
                authBtn.textContent = 'Reautenticar';
                disconnectBtn.style.display = 'block';
            } else {
                statusEl.textContent = 'Status: Não autenticado';
                statusEl.style.color = 'var(--vscode-descriptionForeground)';
                authBtn.textContent = 'Autenticar com GitHub';
                disconnectBtn.style.display = 'none';
            }
        }
        document.getElementById('auto-backup-checkbox').addEventListener('change', (e) => {
            const enabled = e.target.checked;
            const interval = parseInt(document.getElementById('backup-interval-select').value);
            vscode.postMessage({ command: 'enableAutoBackup', enabled, interval });
        });
        document.getElementById('backup-interval-select').addEventListener('change', (e) => {
            const enabled = document.getElementById('auto-backup-checkbox').checked;
            if (enabled) {
                const interval = parseInt(e.target.value);
                vscode.postMessage({ command: 'enableAutoBackup', enabled: true, interval });
            }
        });
        taskInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addTask();
        });
        document.addEventListener('click', closePriorityMenus);
        
        // Fechar modal ao clicar fora
        document.getElementById('settings-modal').addEventListener('click', (e) => {
            if (e.target.id === 'settings-modal') {
                document.getElementById('settings-modal').classList.remove('active');
            }
        });

        renderTasks();

        window.switchTab = (tabName) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.content-view').forEach(v => v.classList.remove('active'));
            document.querySelector(\`.tab-btn[onclick="switchTab('\${tabName}')"]\`).classList.add('active');
            document.getElementById(\`view-\${tabName}\`).classList.add('active');
            
            if (tabName === 'tasks') {
                taskInput.focus();
            } else {
                notesArea.focus();
            }
        };

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'clearAll') {
                notesArea.value = '';
                tasks = [];
                renderTasks();
            }
            if (msg.command === 'updateNotes') {
                notesArea.value = msg.text;
                switchTab('notes');
            }
            if (msg.command === 'updateTasks') {
                tasks = msg.tasks || [];
                renderTasks();
            }
            if (msg.command === 'updateAuthStatus') {
                updateAuthStatus(msg.authenticated);
            }
        });
    </script>
</body>
</html>`;
  }

  private _sanitizeForJson(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  }

  private async _getGitHubToken(): Promise<string | null> {
    try {
      const session = await vscode.authentication.getSession(
        "github",
        ["gist"],
        { createIfNone: false }
      );
      return session?.accessToken || null;
    } catch (error) {
      console.error("Erro ao obter token do GitHub:", error);
      return null;
    }
  }

  private async _authenticateGitHub(): Promise<string | null> {
    try {
      const session = await vscode.authentication.getSession(
        "github",
        ["gist"],
        { createIfNone: true }
      );
      return session?.accessToken || null;
    } catch (error) {
      vscode.window.showErrorMessage(`Erro ao autenticar com GitHub: ${error}`);
      return null;
    }
  }

  private async _disconnectGitHub() {
    try {
      const session = await vscode.authentication.getSession(
        "github",
        ["gist"],
        { createIfNone: false }
      );

      if (session) {
        // Remover o Gist ID salvo
        await this._globalState.update("gistId", undefined);

        // Tentar remover a sessão (pode não estar disponível em todas as versões do VS Code)
        // O usuário pode precisar fazer logout manualmente nas configurações do VS Code
        vscode.window.showInformationMessage(
          "Desconectado com sucesso! O Gist ID foi removido. Para remover completamente a autenticação, vá em Configurações > Contas."
        );

        if (this._view) {
          this._view.webview.postMessage({
            command: "updateAuthStatus",
            authenticated: false,
          });
        }
      } else {
        vscode.window.showInformationMessage("Você não está autenticado.");
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Erro ao desconectar: ${error}`);
    }
  }

  private async _syncGist() {
    let token = await this._getGitHubToken();
    if (!token) {
      const authenticate = await vscode.window.showWarningMessage(
        "Você precisa autenticar com GitHub para sincronizar. Deseja autenticar agora?",
        "Sim",
        "Não"
      );
      if (authenticate === "Sim") {
        token = await this._authenticateGitHub();
        if (!token) {
          return;
        }
      } else {
        return;
      }
    }

    const gistId = this._globalState.get<string>("gistId");
    const notes = this._getSavedNotes();
    const tasks = this._getSavedTasks();

    try {
      const data = {
        version: "1.0",
        syncedAt: new Date().toISOString(),
        notes,
        tasks,
      };

      if (gistId) {
        // Atualizar Gist existente
        await this._updateGist(token, gistId, data);
        vscode.window.showInformationMessage("Sincronizado com sucesso!");
      } else {
        // Criar novo Gist
        const newGistId = await this._createGist(token, data);
        await this._globalState.update("gistId", newGistId);
        vscode.window.showInformationMessage(
          "Gist criado e sincronizado com sucesso!"
        );
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(
        `Erro ao sincronizar: ${error.message || "Erro desconhecido"}`
      );
    }
  }

  private async _createGist(token: string, data: any): Promise<string> {
    const response = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "NoKanban-VSCode-Extension",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        description: "NoKanban Backup",
        public: false,
        files: {
          "notepad-backup.json": {
            content: JSON.stringify(data, null, 2),
          },
        },
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as { message?: string };
      throw new Error(error.message || "Erro ao criar Gist");
    }

    const gist = (await response.json()) as { id: string };
    return gist.id;
  }

  private async _updateGist(token: string, gistId: string, data: any) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "NoKanban-VSCode-Extension",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        description: "NoKanban Backup",
        files: {
          "notepad-backup.json": {
            content: JSON.stringify(data, null, 2),
          },
        },
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as { message?: string };
      throw new Error(error.message || "Erro ao atualizar Gist");
    }
  }

  private async _enableAutoBackup(enabled: boolean, intervalMinutes: number) {
    await this._globalState.update("autoBackupEnabled", enabled);
    await this._globalState.update("autoBackupInterval", intervalMinutes);

    if (this._autoBackupInterval) {
      clearInterval(this._autoBackupInterval);
      this._autoBackupInterval = undefined;
    }

    if (enabled) {
      const intervalMs = intervalMinutes * 60 * 1000;
      this._autoBackupInterval = setInterval(() => {
        this._performAutoBackup();
      }, intervalMs);
    }
  }

  private async _initializeAutoBackup() {
    const enabled = this._globalState.get<boolean>("autoBackupEnabled", false);
    const interval = this._globalState.get<number>("autoBackupInterval", 30);

    if (enabled) {
      await this._enableAutoBackup(true, interval);
    }
  }

  private async _performAutoBackup() {
    const notes = this._getSavedNotes();
    const tasks = this._getSavedTasks();
    const data = {
      version: "1.0",
      backedUpAt: new Date().toISOString(),
      notes,
      tasks,
    };

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const backupDir = workspaceFolder
        ? vscode.Uri.joinPath(workspaceFolder, ".nokanban-backups")
        : vscode.Uri.joinPath(
            vscode.Uri.file(vscode.env.appRoot),
            ".nokanban-backups"
          );

      try {
        await vscode.workspace.fs.createDirectory(backupDir);
      } catch {
        // Diretório já existe
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFile = vscode.Uri.joinPath(
        backupDir,
        `backup-${timestamp}.json`
      );

      await vscode.workspace.fs.writeFile(
        backupFile,
        new TextEncoder().encode(JSON.stringify(data, null, 2))
      );

      // Manter apenas os últimos 10 backups
      const files = await vscode.workspace.fs.readDirectory(backupDir);
      const backupFiles = files
        .filter(([name]) => name.startsWith("backup-"))
        .sort()
        .reverse();

      if (backupFiles.length > 10) {
        for (const [name] of backupFiles.slice(10)) {
          await vscode.workspace.fs.delete(
            vscode.Uri.joinPath(backupDir, name)
          );
        }
      }
    } catch (error) {
      // Silenciosamente falha no backup automático
      console.error("Erro no backup automático:", error);
    }
  }
}
