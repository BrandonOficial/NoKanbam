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
        taskInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addTask();
        });
        document.addEventListener('click', closePriorityMenus);

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
