import * as vscode from "vscode";
import { TextEncoder, TextDecoder } from "util";

interface Task {
  text: string;
  done: boolean;
  priority: 'high' | 'medium' | 'low';
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

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _globalState: vscode.Memento
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const savedNotes = this._getSavedNotes();
    const savedTasks = this._getSavedTasks();

    this._updateBadge(savedTasks);

    webviewView.webview.html = this._getHtmlForWebview(
      webviewView.webview,
      savedNotes,
      savedTasks
    );

    webviewView.webview.onDidReceiveMessage(async (data) => {
      await this._handleWebviewMessage(data);
    });
  }

  private _getSavedNotes(): string {
    return this._globalState.get<string>("notepadContent", "");
  }

  private _getSavedTasks(): Task[] {
    return this._globalState.get<Task[]>("todoList", []);
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

  private _updateBadge(tasks: Task[]) {
    if (!this._view || !Array.isArray(tasks)) {
      return;
    }

    const validTasks = tasks.filter((t) => t?.text?.trim());
    const pendingCount = validTasks.filter((t) => !t.done).length;

    this._view.badge = pendingCount > 0
      ? { tooltip: `${pendingCount} tarefa(s) pendente(s)`, value: pendingCount }
      : undefined;
  }

  private async _importData() {
    const options: vscode.OpenDialogOptions = {
      canSelectMany: false,
      openLabel: "Importar Texto",
      filters: { Arquivos: ["txt", "md", "json"] },
    };

    const fileUri = await vscode.window.showOpenDialog(options);

    if (fileUri?.[0]) {
      try {
        const fileData = await vscode.workspace.fs.readFile(fileUri[0]);
        const fileContent = new TextDecoder().decode(fileData);
        await this._globalState.update("notepadContent", fileContent);
        
        if (this._view) {
          this._view.webview.postMessage({
            command: "updateNotes",
            text: fileContent,
          });
          vscode.window.showInformationMessage("Importado com sucesso!");
        }
      } catch (error) {
        vscode.window.showErrorMessage("Erro ao ler arquivo.");
      }
    }
  }

  private async _exportData() {
    const notes = this._getSavedNotes();
    const tasks = this._getSavedTasks();
    const content = this._generateExportContent(notes, tasks);

    const uri = await vscode.window.showSaveDialog({
      saveLabel: "Exportar Notas",
      filters: { Markdown: ["md"], Texto: ["txt"] },
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(content)
      );
      vscode.window.showInformationMessage("Salvo com sucesso!");
    }
  }

  private _generateExportContent(notes: string, tasks: Task[]): string {
    const date = new Date().toLocaleDateString("pt-BR");
    let content = `=== NOTEPAD PRO - ${date} ===\n\n`;
    content += `--- NOTAS ---\n${notes || "(Vazio)"}\n\n`;
    content += `--- TAREFAS ---\n`;

    if (!tasks?.length) {
      content += `(Nenhuma tarefa)\n`;
    } else {
      const priorityLabels = { high: '🔴', medium: '🟡', low: '🟢' };
      tasks.forEach((t) => {
        const priority = priorityLabels[t.priority] || '';
        content += `[${t.done ? "x" : " "}] ${priority} ${t.text}\n`;
      });
    }

    return content;
  }

  private _getHtmlForWebview(
    webview: vscode.Webview,
    notes: string,
    tasks: Task[]
  ) {
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

        .action-btn.active {
            opacity: 1;
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
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

        /* NOTES TOOLBAR */
        .notes-toolbar {
            display: flex;
            gap: 8px;
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
        }

        .toolbar-btn {
            background: transparent;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 500;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .toolbar-btn:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .toolbar-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }

        /* NOTES CONTAINER */
        .notes-container {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        .notes-editor,
        .notes-preview {
            flex: 1;
            overflow-y: auto;
        }

        .notes-editor.split,
        .notes-preview.split {
            flex: 1;
            border-right: 1px solid var(--vscode-panel-border);
        }

        .notes-preview.split {
            border-right: none;
        }

        /* NOTES AREA */
        textarea {
            width: 100%;
            height: 100%;
            background: transparent;
            color: var(--vscode-editor-foreground);
            border: none;
            padding: 24px;
            resize: none;
            outline: none;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            line-height: 1.8;
        }

        textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 0.4;
            font-style: italic;
        }

        /* MARKDOWN PREVIEW */
        .preview-content {
            padding: 24px;
            line-height: 1.8;
        }

        .preview-content h1 { font-size: 2em; margin: 0.67em 0; font-weight: 600; }
        .preview-content h2 { font-size: 1.5em; margin: 0.75em 0; font-weight: 600; }
        .preview-content h3 { font-size: 1.17em; margin: 0.83em 0; font-weight: 600; }
        .preview-content p { margin: 1em 0; }
        .preview-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }
        .preview-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 1em 0;
        }
        .preview-content pre code {
            background: none;
            padding: 0;
        }
        .preview-content ul, .preview-content ol { margin: 1em 0; padding-left: 2em; }
        .preview-content li { margin: 0.5em 0; }
        .preview-content blockquote {
            border-left: 4px solid var(--vscode-textLink-activeForeground);
            padding-left: 1em;
            margin: 1em 0;
            opacity: 0.8;
        }
        .preview-content a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .preview-content a:hover {
            text-decoration: underline;
        }

        /* TASKS */
        .task-controls {
            display: flex;
            gap: 8px;
            padding: 16px 16px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .search-container {
            flex: 1;
            position: relative;
        }

        #task-search {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 12px 8px 32px;
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
            left: 10px;
            top: 50%;
            transform: translateY(-50%);
            opacity: 0.5;
            pointer-events: none;
        }

        .filter-group {
            display: flex;
            gap: 4px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 2px;
        }

        .filter-btn {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            opacity: 0.6;
            transition: all 0.2s;
        }

        .filter-btn:hover {
            opacity: 1;
        }

        .filter-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            opacity: 1;
        }

        .task-input-container {
            display: flex;
            padding: 12px 16px;
            gap: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .priority-selector {
            display: flex;
            gap: 4px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 2px;
        }

        .priority-btn {
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 8px;
            border-radius: 4px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            font-size: 14px;
            opacity: 0.4;
        }

        .priority-btn:hover {
            opacity: 0.8;
        }

        .priority-btn.active {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
        }

        #task-input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 12px;
            border-radius: 6px;
            outline: none;
            font-size: 12px;
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
            padding: 0 16px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 16px;
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
        }

        li:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-panel-border);
            transform: translateX(2px);
        }

        li.hidden {
            display: none;
        }

        /* PRIORITY INDICATORS */
        .priority-indicator {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            margin-right: 12px;
            flex-shrink: 0;
        }

        .priority-high { background: #f14c4c; box-shadow: 0 0 8px rgba(241, 76, 76, 0.4); }
        .priority-medium { background: #cca700; box-shadow: 0 0 8px rgba(204, 167, 0, 0.4); }
        .priority-low { background: #89d185; box-shadow: 0 0 8px rgba(137, 209, 133, 0.4); }

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
        </div>
    </div>

    <div id="view-notes" class="content-view active">
        <div class="notes-toolbar">
            <button class="toolbar-btn active" id="edit-btn" onclick="setNotesMode('edit')">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-3-3zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207l6.5-6.5zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.499.499 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11l.178-.178z"/>
                </svg>
                Editar
            </button>
            <button class="toolbar-btn" id="preview-btn" onclick="setNotesMode('preview')">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/>
                    <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/>
                </svg>
                Preview
            </button>
            <button class="toolbar-btn" id="split-btn" onclick="setNotesMode('split')">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.5 1a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-13a.5.5 0 0 0-.5-.5h-6zm0 1