import * as vscode from "vscode";
import { TextEncoder, TextDecoder } from "util";

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

  private _getHtmlForWebview(
    webview: vscode.Webview,
    notes: string,
    tasks: any[]
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

        .notes-toolbar {
            display: flex;
            justify-content: flex-end;
            padding: 12px 16px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .preview-toggle {
            background: transparent;
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 600;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .preview-toggle:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
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

        textarea.hidden {
            display: none;
        }

        textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 0.4;
            font-style: italic;
        }

        .preview-content {
            flex: 1;
            padding: 24px;
            overflow-y: auto;
            display: none;
        }

        .preview-content.active {
            display: block;
        }

        .preview-content h1 { font-size: 2em; margin: 0.67em 0; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.3em; }
        .preview-content h2 { font-size: 1.5em; margin: 0.75em 0; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.3em; }
        .preview-content h3 { font-size: 1.17em; margin: 0.83em 0; font-weight: 600; }
        .preview-content h4 { font-size: 1em; margin: 1em 0; font-weight: 600; }
        .preview-content h5 { font-size: 0.83em; margin: 1.17em 0; font-weight: 600; }
        .preview-content h6 { font-size: 0.67em; margin: 1.5em 0; font-weight: 600; }
        .preview-content p { margin: 1em 0; line-height: 1.6; }
        .preview-content code {
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
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
        .preview-content li { margin: 0.5em 0; line-height: 1.6; }
        .preview-content blockquote {
            border-left: 3px solid var(--vscode-textBlockQuote-border);
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
        .preview-content table {
            border-collapse: collapse;
            width: 100%;
            margin: 1em 0;
        }
        .preview-content table th,
        .preview-content table td {
            border: 1px solid var(--vscode-panel-border);
            padding: 8px 12px;
            text-align: left;
        }
        .preview-content table th {
            background: var(--vscode-list-hoverBackground);
            font-weight: 600;
        }
        .preview-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 1.5em 0;
        }
        .preview-content strong { font-weight: 600; }
        .preview-content em { font-style: italic; }

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

        .priority-selector {
            display: flex;
            gap: 4px;
            margin-left: 8px;
            opacity: 0;
            transition: opacity 0.2s;
        }

        li:hover .priority-selector {
            opacity: 1;
        }

        .priority-btn {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            border: 2px solid transparent;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
        }

        .priority-btn.high {
            background: #f14c4c;
        }

        .priority-btn.medium {
            background: #cca700;
        }

        .priority-btn.low {
            background: #89d185;
        }

        .priority-btn:hover {
            transform: scale(1.2);
            border-color: var(--vscode-foreground);
        }

        .priority-btn.active {
            border-color: var(--vscode-foreground);
            box-shadow: 0 0 0 2px var(--vscode-editor-background);
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
        <div class="notes-container">
            <div class="notes-toolbar">
                <button class="preview-toggle" id="preview-toggle" title="Alternar Preview">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A4.003 4.003 0 0 1 8 3.5c1.258 0 2.4.69 2.97 1.71l1.204-1.204A5.488 5.488 0 0 0 8 2.5zm-4.131 9.631A5.487 5.487 0 0 0 8 13.5a5.487 5.487 0 0 0 4.131-1.869l-1.204-1.204A4.003 4.003 0 0 1 8 12.5c-1.258 0-2.4-.69-2.97-1.71l-1.204 1.204z"/>
                        <path d="M1.354 1.354l13 13a.5.5 0 0 1-.708.708l-13-13a.5.5 0 0 1 .708-.708zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>
                    </svg>
                    <span id="preview-toggle-text">Preview</span>
                </button>
            </div>
            <textarea id="notes-area" placeholder="Comece a escrever suas ideias..."></textarea>
            <div class="preview-content" id="preview-content"></div>
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

    <script>
        const vscode = acquireVsCodeApi();
        const notesArea = document.getElementById('notes-area');
        const taskListEl = document.getElementById('task-list');
        const taskInput = document.getElementById('task-input');
        const taskSearch = document.getElementById('task-search');
        const previewContent = document.getElementById('preview-content');
        const previewToggle = document.getElementById('preview-toggle');
        const previewToggleText = document.getElementById('preview-toggle-text');
        
        notesArea.value = "${safeNotes}";
        let tasks = ${safeTasks};
        let currentFilter = 'all';
        let searchQuery = '';

        // Markdown Preview
        function markdownToHtml(text) {
            if (!text) return '';
            var html = text;
            var codeBlockPattern = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) + '([\\\\s\\\\S]*?)' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
            var codeBlockRegex = new RegExp(codeBlockPattern, 'g');
            var ltRegex = new RegExp('<', 'g');
            var gtRegex = new RegExp('>', 'g');
            html = html.replace(codeBlockRegex, function(match, code) {
                return '<pre><code>' + code.replace(ltRegex, '&lt;').replace(gtRegex, '&gt;') + '</code></pre>';
            });
            var h3Regex = new RegExp('^### (.*$)', 'gim');
            var h2Regex = new RegExp('^## (.*$)', 'gim');
            var h1Regex = new RegExp('^# (.*$)', 'gim');
            var boldRegex1 = new RegExp('\\\\*\\\\*(.+?)\\\\*\\\\*', 'g');
            var boldRegex2 = new RegExp('__(.+?)__', 'g');
            var codePattern = String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96);
            var codeRegex = new RegExp(codePattern, 'g');
            var italicRegex1 = new RegExp('\\\\*([^\\\\*\\\\n]+)\\\\*', 'g');
            var italicRegex2 = new RegExp('_([^_\\\\n]+)_', 'g');
            var linkRegex = new RegExp('\\\\[([^\\\\]]+)\\\\]\\\\(([^\\\\)]+)\\\\)', 'g');
            var imgRegex = new RegExp('!\\\\[([^\\\\]]*)\\\\]\\\\(([^\\\\)]+)\\\\)', 'g');
            var blockquoteRegex = new RegExp('^> (.+)$', 'gim');
            var hrRegex = new RegExp('^---$', 'gim');
            var listRegex1 = new RegExp('^\\\\* (.+)$', 'gim');
            var listRegex2 = new RegExp('^\\\\d+\\\\. (.+)$', 'gim');
            var brRegex1 = new RegExp('\\\\n\\\\n', 'g');
            var brRegex2 = new RegExp('\\\\n', 'g');
            html = html.replace(h3Regex, '<h3>$1</h3>');
            html = html.replace(h2Regex, '<h2>$1</h2>');
            html = html.replace(h1Regex, '<h1>$1</h1>');
            html = html.replace(boldRegex1, '<strong>$1</strong>');
            html = html.replace(boldRegex2, '<strong>$1</strong>');
            html = html.replace(codeRegex, '<code>$1</code>');
            html = html.replace(italicRegex1, '<em>$1</em>');
            html = html.replace(italicRegex2, '<em>$1</em>');
            html = html.replace(linkRegex, '<a href="$2">$1</a>');
            html = html.replace(imgRegex, '<img src="$2" alt="$1" />');
            html = html.replace(blockquoteRegex, '<blockquote>$1</blockquote>');
            html = html.replace(hrRegex, '<hr>');
            html = html.replace(listRegex1, '<li>$1</li>');
            html = html.replace(listRegex2, '<li>$1</li>');
            html = html.replace(brRegex1, '</p><p>');
            html = html.replace(brRegex2, '<br>');
            var listWrapRegex = new RegExp('(<li>.*?</li>)', 'gs');
            html = html.replace(listWrapRegex, function(match) {
                if (match.indexOf('<ul>') === -1) {
                    return '<ul>' + match + '</ul>';
                }
                return match;
            });
            html = '<p>' + html + '</p>';
            var pCleanRegex1 = new RegExp('<p><(h[1-6]|ul|ol|pre|blockquote|hr)', 'g');
            var pCleanRegex2 = new RegExp('(</(h[1-6]|ul|ol|pre|blockquote|hr)>)</p>', 'g');
            var pCleanRegex3 = new RegExp('<p></p>', 'g');
            html = html.replace(pCleanRegex1, '<$1');
            html = html.replace(pCleanRegex2, '$1');
            html = html.replace(pCleanRegex3, '');
            return html;
        }

        function updatePreview() {
            const markdown = notesArea.value;
            previewContent.innerHTML = markdownToHtml(markdown);
        }

        let isPreviewMode = false;
        previewToggle.addEventListener('click', () => {
            isPreviewMode = !isPreviewMode;
            if (isPreviewMode) {
                notesArea.classList.add('hidden');
                previewContent.classList.add('active');
                previewToggleText.textContent = 'Editar';
                updatePreview();
            } else {
                notesArea.classList.remove('hidden');
                previewContent.classList.remove('active');
                previewToggleText.textContent = 'Preview';
            }
        });

        notesArea.addEventListener('input', () => {
            vscode.postMessage({ command: 'saveNotes', text: notesArea.value });
            if (isPreviewMode) {
                updatePreview();
            }
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
                    <div class="priority-selector">
                        <button class="priority-btn high \${priority === 'high' ? 'active' : ''}" onclick="setPriority(\${index}, 'high')" title="Alta"></button>
                        <button class="priority-btn medium \${priority === 'medium' ? 'active' : ''}" onclick="setPriority(\${index}, 'medium')" title="Média"></button>
                        <button class="priority-btn low \${priority === 'low' ? 'active' : ''}" onclick="setPriority(\${index}, 'low')" title="Baixa"></button>
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
            if (tasks[index].priority === priority) {
                tasks[index].priority = undefined;
            } else {
                tasks[index].priority = priority;
            }
            updateTasks();
        };
        
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
        taskInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addTask();
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
}
