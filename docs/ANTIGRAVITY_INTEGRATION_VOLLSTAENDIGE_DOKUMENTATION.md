# Vollständige Dokumentation: Google Antigravity (`agy`) Integration in `grok-build-vscode`

**Projekt:** `grok-build-vscode` (VS Code Extension für xAI Grok, OpenAI Codex, Anthropic Claude Code und Google Antigravity / Gemini)  
**Dokumentversion:** 3.0.0  
**Datum:** 4. September 2026  
**Status:** Vollständig implementiert, im produktiven VS Code Betrieb erfolgreich verifiziert, 100% aller 4.895 Tests bestanden.  
**Referenz-Binaries:** `C:\Users\zfzfg\.gemini\bin\agy.exe` (v1.1.26) & Legacy `gemini-cli`

---

## Inhaltsverzeichnis

1. [Executive Summary & Ausgangslage](#1-executive-summary--ausgangslage)
2. [Architekturkonzept: Die `AgyAcpAdapter`-Brücke](#2-architekturkonzept-die-agyacpadapter-brücke)
3. [Detaillierte Datei- und Komponentenübersicht](#3-detaillierte-datei--und-komponentenübersicht)
   - [3.1 `src/agy-acp-adapter.ts`](#31-srcagy-acp-adapterts)
   - [3.2 `src/gemini-backend.ts`](#32-srcgemini-backendts)
   - [3.3 `src/gemini-cli-locator.ts`](#33-srcgemini-cli-locatorts)
   - [3.4 `src/sidebar.ts`](#34-srcsidebarts)
   - [3.5 `media/chat.js` & UI-Komponenten](#35-mediachatjs--ui-komponenten)
4. [Laufzeit-Meilensteine & Problemlösungen im E2E-Betrieb](#4-laufzeit-meilensteine--problemlösungen-im-e2e-betrieb)
   - [4.1 Kontextfenster-Korrektur (1.0M statt 200k)](#41-kontextfenster-korrektur-10m-statt-200k)
   - [4.2 Live-Tool-Calling Streaming (Erstellungsschritte & Terminal)](#42-live-tool-calling-streaming-erstellungsschritte--terminal)
   - [4.3 Extension-Startup & Packaging-Reparatur (VSIX `node_modules`)](#43-extension-startup--packaging-reparatur-vsix-node_modules)
   - [4.4 Workspace-Binding (`--add-dir`)](#44-workspace-binding---add-dir)
   - [4.5 Tool Label & Parameter-Normalisierung (`Run git status`)](#45-tool-label--parameter-normalisierung-run-git-status)
5. [Vollständige Modell-Spezifikation (14 Modelle)](#5-vollständige-modell-spezifikation-14-modelle)
6. [Qualitätssicherung & Testergebnisse](#6-qualitätssicherung--testergebnisse)
   - [6.1 Dedizierte Adapter- & Gemini-Tests](#61-dedizierte-adapter---gemini-tests)
   - [6.2 Gesamte Testsuite (`npm test`)](#62-gesamte-testsuite-npm-test)
   - [6.3 E2E-Verifikation in Visual Studio Code](#63-e2e-verifikation-in-visual-studio-code)
7. [Benutzer- und Entwickleranleitung](#7-benutzer--und-entwickleranleitung)

---

## 1. Executive Summary & Ausgangslage

### 1.1 Die Problemstellung
Bei der Nutzung der ursprünglichen `gemini-cli` via Google-Account (`gemini auth login`) wurde der Zugriff serverseitig eingestellt:
```text
Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals.
To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google
```
Google hat die eigenständige `gemini-cli` für Einzelentwickler abgekündigt und durch die **Google Antigravity Plattform** mit der modernen CLI **`agy`** ersetzt.

### 1.2 Die technische Herausforderung
- `grok-build-vscode` kommuniziert mit Providern standardmäßig über das **Agent Client Protocol (ACP)** via JSON-RPC 2.0 über `stdio`.
- Grok Build integriert ACP nativ, für Codex und Claude existieren offizielle Adapterpakete.
- Die Antigravity CLI `agy.exe` bietet jedoch kein `--acp`-Flag, sondern eine hochperformante, interaktive Streaming-Schnittstelle über NDJSON:
  ```bash
  agy --input-format stream-json --output-format stream-json
  ```

### 1.3 Das Gesamtergebnis
Durch die Implementierung des eigenständigen TypeScript-Adapters `AgyAcpAdapterServer` und dessen Integration in das `GeminiBackend` wurde Antigravity vollständig, performant und mit allen Features in die IDE eingebunden.

---

## 2. Architekturkonzept: Die `AgyAcpAdapter`-Brücke

Die Kommunikation ist nach dem **Bridge- und Adapter-Pattern** aufgebaut:

```
┌──────────────────────────────────────────────────────────────────┐
│                 VS Code Host (grok-build-vscode)                 │
│                 AcpClient (src/acp.ts)                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                   JSON-RPC 2.0 (ACP über stdio)
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│               AgyAcpAdapterServer (src/agy-acp-adapter.ts)       │
│                                                                  │
│  - ACP Handshake: initialize, session/new, session/load          │
│  - Dynamisches Workspace-Binding (--add-dir <cwd>)               │
│  - Modell- und Reasoning-Effort-Verwaltung (--model, --effort)   │
│  - Translation: session/prompt <-> NDJSON {"event":"user",...}   │
│  - Streaming: agent_response <-> session/update (Text-Delta)     │
│  - Tool-Calls: step_type: tool <-> tool_call / tool_call_update   │
│  - Parameter-Normalisierung: PascalCase -> ACP Standard-Keys     │
│  - Thinking-Token Erfassung (usage.thinking_tokens)              │
│  - Ausführungsmodi: yolo (--dangerously-skip-permissions), plan  │
│  - Session-Resumption via --conversation <conversation_id>       │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                   NDJSON (stream-json über stdio)
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│                  Google Antigravity CLI                          │
│               (C:\...\.gemini\bin\agy.exe)                       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Detaillierte Datei- und Komponentenübersicht

### 3.1 `src/agy-acp-adapter.ts`
Der zentrale Protokoll-Adapter:
- **Prozess-Steuerung:** Startet und überwacht `agy.exe` mit `--input-format stream-json --output-format stream-json`.
- **Workspace-Kopplung:** Übergibt automatisch `--add-dir <cwd>`, damit Antigravity direkt im geöffneten Projektverzeichnis arbeitet.
- **Effort-Handling:** Stellt sicher, dass bei Modellen wie `gemini-3.8-flash` stets ein gültiger `--effort` Parameter (`low`, `medium`, `high`) übergeben wird, um CLI-Fehler zu vermeiden.
- **Tool-Calling-Übersetzung:** Wandelt Antigravity Tool-Events in ACP-Updates um:
  - `state === "ACTIVE"` ➔ `sessionUpdate: "tool_call"` (`status: "in_progress"`)
  - `state === "DONE" | "ERROR"` ➔ `sessionUpdate: "tool_call_update"` (`status: "completed" | "failed"`)
- **Parameter-Normalisierung (`normalizeToolInput`):** Mappt herstellerspezifische Parameter (`CommandLine`, `TargetFile`, `AbsolutePath`, `DirectoryPath`, `Query`) transparent auf ACP-Standardattribute (`command`, `file_path`, `directory`, `pattern`).

### 3.2 `src/gemini-backend.ts`
Das ACP-Backend für Google Gemini & Antigravity:
- **`isAntigravityCli(cliPath)`:** Erkennt anhand von Dateinamen oder Pfad (`agy`, `agy.exe`), ob die Antigravity CLI vorliegt.
- **`spawn()`:** Startet bei Antigravity den Node-Subprozess für `agy-acp-adapter.js` unter Weitergabe von `AGY_PATH` und `AGY_CWD`.
- **`contextWindowForModel()`:** Weist Gemini-Modellen das reale Kontextfenster von **1.048.576 Tokens (~1.0M)** zu.
- **`normalizeGeminiUpdate()`:** Stellt sicher, dass das Kontextfenster im `usage_update` an die Webview gemeldet wird und normalisiert Tool-Input-Objekte für Replays.
- **Legacy-Fallback:** Bleibt für traditionelle Setups mit `gemini --acp` weiterhin voll kompatibel.

### 3.3 `src/gemini-cli-locator.ts`
Automatische Erkennung der CLI im System:
- Sucht prioritär nach `agy.exe` bzw. `agy` im Standard-Installationspfad `%USERPROFILE%\.gemini\bin\agy.exe`.
- Durchsucht den System-`PATH` nach `agy` und `gemini`.
- Berücksichtigt benutzerdefinierte Pfade aus `grok.geminiCliPath`.

### 3.4 `src/sidebar.ts`
Integration in die VS Code Host-Umgebung:
- Registrierung des Providers `"gemini"` in Verbindung mit Modell-Caching, Session-History und Authentifizierungsprüfung.
- Verwaltung des YOLO-Modus (`--dangerously-skip-permissions`) für automatische Befehlsausführung.

### 3.5 `media/chat.js` & UI-Komponenten
Webview-Anzeige im Chat:
- Anzeige des korrekten **1.0M Context Window** im oberen Header.
- Dynamische Darstellung von Tool-Karten mit Icons (Stift für Edits, Lupe für Suchen, Terminal für Commands).
- Expandierbare Terminal-Details für Ein- und Ausgabe von Befehlen.

---

## 4. Laufzeit-Meilensteine & Problemlösungen im E2E-Betrieb

Im Zuge der Inbetriebnahme wurden folgende praxisrelevante Herausforderungen iterativ gelöst:

### 4.1 Kontextfenster-Korrektur (1.0M statt 200k)
- **Symptom:** Im Chat-UI wurde für alle Gemini-Modelle fälschlicherweise ein Context Window von lediglich 200k Token angezeigt.
- **Ursache:** In `media/chat.js` existierte ein Standard-Fallback von `200000`. Da die Modellmetadaten in `DEFAULT_GEMINI_MODELS` und `parseAgyModelsOutput` kein explizites `totalContextTokens` enthielten, griff der Fallback.
- **Lösung:** 
  - Funktion `contextWindowForModel(modelId)` in `src/gemini-backend.ts` implementiert (`1048576` für `gemini-*`).
  - `_meta.totalContextTokens: 1048576` zu allen Standardmodellen hinzugefügt.
  - Weitergabe über `normalizeGeminiUpdate` an das `usage_update` Event der Webview.

### 4.2 Live-Tool-Calling Streaming (Erstellungsschritte & Terminal)
- **Symptom:** Während Antigravity Dateien anlegte oder Befehle ausführte, sah der Nutzer im UI ausschließlich die Meldung "Thinking...". Die einzelnen Arbeitsschritte waren unsichtbar.
- **Ursache:** `AgyAcpAdapterServer` verarbeitete in der Erstversion ausschließlich `step_type === "agent_response"` und verwarf alle `step_type === "tool"` Events.
- **Lösung:**
  - Event-Handler in `handleAgyLine` implementiert, der `step.step_type === "tool"` abfängt.
  - Zuordnung von Antigravity-Tools (`write_to_file`, `replace_file_content`, `run_command`, `view_file`, etc.) zu ACP-Kategorien (`edit`, `execute`, `read`).
  - Streaming von `tool_call` bei Status `ACTIVE` und `tool_call_update` bei Abschluss (`DONE` / `ERROR`).

### 4.3 Extension-Startup & Packaging-Reparatur (VSIX `node_modules`)
- **Symptom:** Nach einer Aktualisierung fror die Extension beim Öffnen des Sidebars mit Endlos-Ladeanimation ein.
- **Ursache:** Ein Build-Befehl wurde versehentlich mit `--no-dependencies` ausgeführt. Dadurch fehlten im VSIX-Paket alle Laufzeit-Module in `node_modules/` (u. a. `ws`, `jpeg-js`, `@agentclientprotocol/*`), wodurch die Extension beim Laden abbrach.
- **Lösung:**
  - VSIX-Paketierung auf den regulären Standard-Build ohne `--no-dependencies` umgestellt.
  - Verifiziert, dass alle 650 Produktionsmodule (8,04 MB Gesamtgröße) im Paket enthalten sind und fehlerfrei laden.

### 4.4 Workspace-Binding (`--add-dir`)
- **Symptom:** Antigravity erstellte Dateien (z. B. `TODO.md`) im internen Standardverzeichnis `C:\Users\zfzfg\.gemini\antigravity-cli\scratch` statt im tatsächlich geöffneten VS Code Projekt.
- **Ursache:** Die Antigravity CLI benötigt zwingend das Argument `--add-dir <pfad>`, um das Projektverzeichnis als aktiven Workspace zu registrieren. Ohne dieses Flag greift der interne Scratch-Fallback.
- **Lösung:**
  - In `src/gemini-backend.ts` wird `AGY_CWD` im Environment übergeben.
  - In `src/agy-acp-adapter.ts` wird `this.cwd` bei `session/new` und `session/load` dynamisch aktualisiert.
  - `ensureAgyProc()` hängt beim Starten von `agy.exe` automatisch `--add-dir <cwd>` an.

### 4.5 Tool Label & Parameter-Normalisierung (`Run git status`)
- **Symptom:** In den Tool-Karten erschien für Terminal-Befehle nur ein unbestimmtes `"Run"` (ohne den ausgeführten Befehl) und bei einigen Dateizugriffen nur `"Read"`.
- **Ursache:** `media/chat.js` erwartet im Tool-Objekt Standard-Schlüssel wie `rawInput.command` oder `rawInput.file_path`. Antigravity übergibt jedoch PascalCase-Namen (`CommandLine`, `AbsolutePath`, `TargetFile`).
- **Lösung:**
  - Funktion `normalizeToolInput(name, params)` in `src/agy-acp-adapter.ts` und `src/gemini-backend.ts` integriert.
  - `CommandLine` wird transparent als `command` und `cmd` gespiegelt.
  - `AbsolutePath` und `TargetFile` werden als `file_path`, `path` und `target_file` bereitgestellt.
  - **Ergebnis:** Die Karten zeigen nun aussagekräftige Titel wie `Run git status`, `Run java` oder `Read pom.xml`. Beim Anklicken öffnet sich die Detailansicht mit vollem Terminal-Output.

---

## 5. Vollständige Modell-Spezifikation (14 Modelle)

Antigravity stellt über die `agy`-CLI insgesamt **14 Modelle** zur Verfügung:

| Modell-ID | Anzeigename | Reasoning Effort | Kontextfenster | Primärer Einsatzzweck |
|:---|:---|:---:|:---:|:---|
| `gemini-3.8-flash` | Gemini 3.8 Flash | Low, Medium, High | **1.048.576 Tokens (1.0M)** | Standardmodell für Coding, High-Speed |
| `gemini-3.7-flash` | Gemini 3.7 Flash | Low, Medium, High | **1.048.576 Tokens (1.0M)** | Schnelle Codeanalyse & Refactoring |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Low, Medium, High | **1.048.576 Tokens (1.0M)** | Ausgewogene Performance & Ökonomie |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Low, High | **1.048.576 Tokens (1.0M)** | Deep Reasoning, komplexe Algorithmen |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | Nein | 200.000 Tokens | Anthropic Frontier Reasoning via Antigravity |
| `claude-opus-4-6-thinking`| Claude Opus 4.6 (Thinking) | Nein | 200.000 Tokens | Systemarchitektur & Großrefactorings |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | Nein | 131.072 Tokens | Open-Weight Frontier Modell |
| *Dynamische Varianten* | *(Effort-gebundene IDs)* | Aus Basismodell | Je nach Basis | Vollständig unterstützt über Dynamic Parser |

---

## 6. Qualitätssicherung & Testergebnisse

### 6.1 Dedizierte Adapter- & Gemini-Tests
Alle für Antigravity neu erstellten und aktualisierten Testsuiten wurden mit `vitest` validiert:
- `test/agy-acp-adapter.test.ts` (6 Tests):
  - Handshake & Capabilities (`initialize`)
  - Session-Erstellung & Metadaten (`session/new`, `session/load`)
  - Konfigurationswechsel (`model`, `effort`, `mode`)
  - Prompt-Ausführung & NDJSON-Streaming
  - Live Tool-Call Translation (`tool_call` & `tool_call_update`) inkl. Parameter-Normalisierung
  - Workspace-Binding (`cwd` & `--add-dir`)
- `test/gemini-backend.test.ts` (13 Tests):
  - Backend-Erkennung (`isAntigravityCli`)
  - Spawn-Spezifikation und Environment-Variablen
  - Kontextfenster-Normalisierung (1.0M Tokens)
  - Tool-Input Normalisierung
- `test/gemini-cli-locator.test.ts` (13 Tests):
  - Pfadpriorisierung (`.gemini\bin\agy.exe` vor Legacy)
- `test/gemini-model-cache.test.ts` (3 Tests):
  - Dynamic Model Discovery und Caching

**Ergebnis: 35 von 35 Tests erfolgreich (100%).**

### 6.2 Gesamte Testsuite (`npm test`)
Vollständiger Regressionslauf über das gesamte Projekt:
```text
Test Files  211 passed (211)
     Tests  4895 passed | 4 skipped (4899)
  Duration  17.19s
```
**Ergebnis: 100% aller 211 Testsuiten und 4.895 Tests bestanden – keine Regressionen.**

### 6.3 E2E-Verifikation in Visual Studio Code
Im Live-Betrieb innerhalb eines realen Projekts (`TriggerVolumes`) verifiziert:
1. **Workspace-Direktzugriff:** Antigravity liest `pom.xml` und erstellt `TODO.md` direkt im Workspace.
2. **Multi-Turn Dateioperationen:** Befehl zum Löschen von `TODO.md` wird sofort verstanden und ausgeführt.
3. **Tool-Ausführung & Anzeige:**
   - Drei aufeinanderfolgende Terminal-Befehle (`git status`, `java -version`, `Get-ChildItem`) wurden als Karten `Run git status`, `Run java`, `Run Get-ChildItem` gerendert.
   - Die echten Konsolenausgaben wurden live erfasst und im Chat dargestellt.

---

## 7. Benutzer- und Entwickleranleitung

### Für Endanwender:
1. **Google Antigravity CLI installieren:**
   Falls noch nicht vorhanden, in der PowerShell ausführen:
   ```powershell
   irm https://antigravity.google/cli/install.ps1 | iex
   ```
2. **In VS Code verwenden:**
   - VS Code starten bzw. Fenster neu laden (`Strg + Shift + P` ➔ `Developer: Reload Window`).
   - Die Extension erkennt `agy.exe` vollautomatisch.
   - In der Modellauswahl steht **Gemini 3.8 Flash** als Standard bereit (inkl. 1.0M Context Window).
   - Der Reasoning-Effort (`Low`, `Medium`, `High`) kann direkt über das Dropdown gewählt werden.
   - Für autonomes Arbeiten kann der Modus auf **YOLO** gestellt werden.

### Für Entwickler:
- **Kompilieren:** `npm run compile` (übersetzt TypeScript nach `out/`).
- **Paketieren:** `npx @vscode/vsce package --readme-path README.marketplace.md` (erzeugt das installationsbereite `.vsix`).
- **Direkt installieren:**
  ```powershell
  code --install-extension grok-vscode-phuryn-4.1.6.vsix --force
  ```
- **Tests ausführen:**
  ```bash
  npx vitest run test/agy-acp-adapter.test.ts test/gemini-backend.test.ts
  ```
