import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Copy, ScrollText, Trash2, Search, Filter, Download, Info, AlertOctagon, X, RotateCcw } from "lucide-react";
import { logFrontend, safeLogValue } from "../../lib/log";
import { parseBridgePayload, readBridgeError } from "../../utils/bridge";
import { Dropdown } from "../../components/Dropdown";

type LogLevel = "all" | "info" | "warn" | "error";

interface ParsedLogLine {
  raw: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "unknown";
  event: string;
  message: string;
  details?: string;
}

function parseLogLine(line: string): ParsedLogLine {
  const levelMatch = line.match(/\[(INFO|WARN|ERROR)\]/i);
  const level = (levelMatch?.[1]?.toLowerCase() as ParsedLogLine["level"]) || "unknown";
  
  const timestampMatch = line.match(/^\[([\d\-T:.+]+)\]/);
  const timestamp = timestampMatch?.[1] || "";
  
  const eventMatch = line.match(/\]\s+([\w.]+):/);
  const event = eventMatch?.[1] || "";
  
  // Locate the message by looking after the event colon to avoid matching colons inside timestamp
  let message = line;
  if (event) {
    const eventIndex = line.indexOf(event + ":");
    if (eventIndex !== -1) {
      message = line.substring(eventIndex + event.length + 1).trim();
    }
  } else {
    const messageMatch = line.match(/:\s*(.+?)(?:\n|$)/);
    message = messageMatch?.[1] || line;
  }
  
  const detailsMatch = line.match(/\n?\s*details:\s*(.+)$/s);
  const details = detailsMatch?.[1];
  
  return { raw: line, timestamp, level, event, message, details };
}

function getEventCategory(event: string): string {
  if (event.startsWith("app.")) return "app";
  if (event.startsWith("audio.")) return "audio";
  if (event.startsWith("clip.")) return "clip";
  if (event.startsWith("discord.")) return "discord";
  if (event.startsWith("download.")) return "download";
  if (event.startsWith("frontend.")) return "frontend";
  if (event.startsWith("tools.")) return "tools";
  if (event.startsWith("config.")) return "config";
  return "other";
}

function getExportFilename(
  activeTab: LogLevel,
  selectedCategory: string,
  searchQuery: string
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  
  // 1. Level label
  const levelLabel = activeTab === "all" ? "All" : activeTab.charAt(0).toUpperCase() + activeTab.slice(1);
  
  // 2. Filters list (category & search)
  const filters: string[] = [];
  
  if (selectedCategory !== "all") {
    filters.push(selectedCategory.charAt(0).toUpperCase() + selectedCategory.slice(1));
  }
  
  if (searchQuery) {
    const cleanSearch = searchQuery
      .replace(/[\\/:*?"<>|]/g, "")
      .trim()
      .slice(0, 15);
    if (cleanSearch) {
      filters.push(`Search '${cleanSearch}'`);
    }
  }
  
  const filtersSuffix = filters.length > 0 ? ` [${filters.join(" - ")}]` : "";
  
  return `[Ultimate AMV] ${levelLabel} Logs (${timestamp})${filtersSuffix}`;
}

export function LogsPanel() {
  const [lines, setLines] = React.useState<string[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "error">("idle");
  const [copyAllState, setCopyAllState] = React.useState<"idle" | "copied" | "error">("idle");
  const [clearing, setClearing] = React.useState(false);
  
  // Filter states
  const [activeTab, setActiveTab] = React.useState<LogLevel>("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState<string>("all");
  const [showFilters, setShowFilters] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [expandedDetails, setExpandedDetails] = React.useState<Set<number>>(new Set());
  
  const logRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    void refreshLogs();
    const interval = window.setInterval(() => {
      void refreshLogs();
    }, 2500);
    return () => window.clearInterval(interval);
  }, []);
  
  // Auto-scroll to bottom when new logs arrive — but only if the user is
  // already pinned to (or very near) the bottom. If they've scrolled up to
  // read/screenshot older lines, never yank their scroll position. Scrolling
  // back down to the bottom re-arms the follow behavior automatically.
  React.useEffect(() => {
    const el = logRef.current;
    if (!autoScroll || !el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= 40) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines, autoScroll, activeTab, searchQuery, selectedCategory]);

  async function refreshLogs() {
    try {
      const raw = await invoke<string>("app_logs");
      const payload = parseBridgePayload<{ type: "logs"; lines: string[] }>(raw);
      setLines(payload.lines ?? []);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    }
  }
  
  async function handleExport() {
    if (filteredLogs.length === 0) return;
    
    try {
      const content = filteredLogs.map(l => l.raw).join("\n");
      const defaultName = getExportFilename(activeTab, selectedCategory, searchQuery) + ".txt";
      
      // Import Tauri dialog plugin dynamically
      const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
      
      // Open Save As dialog
      const selectedPath = await saveDialog({
        defaultPath: defaultName,
        filters: [
          { name: "Text Files", extensions: ["txt"] },
          { name: "All Files", extensions: ["*"] }
        ],
        title: "Export Logs"
      });
      
      if (!selectedPath) {
        // User cancelled
        return;
      }
      
      // Write file using backend command
      await invoke("write_file", { path: selectedPath, content });
      
      logFrontend("info", "frontend.logs.export", "Exported logs to file", { 
        lineCount: filteredLogs.length,
        path: selectedPath 
      });
      
      setErrorMessage(null);
    } catch (error) {
      logFrontend("error", "frontend.logs.export.error", "Failed to export logs", {
        error: safeLogValue(error),
      });
      setErrorMessage(`Failed to export logs: ${readBridgeError(error)}`);
    }
  }
  
  function toggleDetails(index: number) {
    const newExpanded = new Set(expandedDetails);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedDetails(newExpanded);
  }
  
  function clearFilters() {
    setActiveTab("all");
    setSearchQuery("");
    setSelectedCategory("all");
  }
  
  // Parse and filter logs, grouping details lines into their parent logs
  const parsedLogs = React.useMemo(() => {
    const result: ParsedLogLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("    details: ")) {
        if (result.length > 0) {
          const lastLog = result[result.length - 1];
          lastLog.raw += "\n" + line;
          lastLog.details = line.substring("    details: ".length);
        } else {
          result.push(parseLogLine(line));
        }
      } else {
        result.push(parseLogLine(line));
      }
    }
    return result.map((log, index) => ({ ...log, index }));
  }, [lines]);
  
  const filteredLogs = React.useMemo(() => {
    return parsedLogs.filter((log) => {
      // Level filter
      if (activeTab !== "all" && log.level !== activeTab) return false;
      
      // Category filter
      if (selectedCategory !== "all" && getEventCategory(log.event) !== selectedCategory) return false;
      
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          log.event.toLowerCase().includes(query) ||
          log.message.toLowerCase().includes(query) ||
          log.timestamp.includes(query) ||
          log.details?.toLowerCase().includes(query)
        );
      }
      
      return true;
    });
  }, [parsedLogs, activeTab, searchQuery, selectedCategory]);
  
  // Stats
  const stats = React.useMemo(() => {
    return {
      total: parsedLogs.length,
      info: parsedLogs.filter(l => l.level === "info").length,
      warn: parsedLogs.filter(l => l.level === "warn").length,
      error: parsedLogs.filter(l => l.level === "error").length,
    };
  }, [parsedLogs]);
  
  const categories = React.useMemo(() => {
    const cats = new Set<string>();
    parsedLogs.forEach(log => cats.add(getEventCategory(log.event)));
    return Array.from(cats).sort();
  }, [parsedLogs]);

  async function copyLogs() {
    try {
      const content = filteredLogs.map(l => l.raw).join("\n");
      await navigator.clipboard.writeText(content);
      setCopyState("copied");
      logFrontend("info", "frontend.logs.copy", "Copied filtered logs to clipboard", {
        lineCount: filteredLogs.length,
      });
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch (error) {
      setCopyState("error");
      setErrorMessage(readBridgeError(error));
      logFrontend("error", "frontend.logs.copy.error", "Could not copy logs to clipboard", {
        error: safeLogValue(error),
      });
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  async function copyAllLogs() {
    try {
      const content = filteredLogs
        .map((l) => {
          const header = `${l.timestamp} ${l.level.toUpperCase()} ${l.event} ${l.message}`;
          return l.details ? `${header}\n${l.details}` : header;
        })
        .join("\n\n");
      await navigator.clipboard.writeText(content);
      setCopyAllState("copied");
      logFrontend("info", "frontend.logs.copyAll", "Copied filtered logs (with details) to clipboard", {
        lineCount: filteredLogs.length,
      });
      window.setTimeout(() => setCopyAllState("idle"), 1600);
    } catch (error) {
      setCopyAllState("error");
      setErrorMessage(readBridgeError(error));
      logFrontend("error", "frontend.logs.copyAll.error", "Could not copy logs to clipboard", {
        error: safeLogValue(error),
      });
      window.setTimeout(() => setCopyAllState("idle"), 2200);
    }
  }

  async function clearLogs() {
    try {
      setClearing(true);
      await invoke("clear_app_logs");
      setLines([]);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(readBridgeError(error));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="logs-panel">
      <div className="logs-console u-material">
      {/* Stats Bar */}
      <div className="logs-stats">
        <div className={`log-stat ${activeTab === "all" ? "is-active" : ""}`} onClick={() => setActiveTab("all")}>
          <span className="log-stat-count">{stats.total}</span>
          <span className="log-stat-label">All</span>
        </div>
        <div className={`log-stat is-info ${activeTab === "info" ? "is-active" : ""}`} onClick={() => setActiveTab("info")}>
          <Info size={14} />
          <span className="log-stat-count">{stats.info}</span>
          <span className="log-stat-label">Info</span>
        </div>
        <div className={`log-stat is-warn ${activeTab === "warn" ? "is-active" : ""}`} onClick={() => setActiveTab("warn")}>
          <AlertTriangle size={14} />
          <span className="log-stat-count">{stats.warn}</span>
          <span className="log-stat-label">Warn</span>
        </div>
        <div className={`log-stat is-error ${activeTab === "error" ? "is-active" : ""}`} onClick={() => setActiveTab("error")}>
          <AlertOctagon size={14} />
          <span className="log-stat-count">{stats.error}</span>
          <span className="log-stat-label">Error</span>
        </div>
      </div>
      
      {/* Toolbar */}
      <div className="logs-toolbar">
        <div className="logs-search">
          <Search size={14} className="logs-search-icon" />
          <input
            type="text"
            placeholder="Search logs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="logs-search-input"
          />
          {searchQuery && (
            <button className="logs-search-clear" onClick={() => setSearchQuery("")}>
              <X size={14} />
            </button>
          )}
        </div>
        
        <div className="logs-actions">
          <button 
            type="button" 
            onClick={() => setShowFilters(!showFilters)}
            className={showFilters ? "is-active" : ""}
          >
            <Filter size={15} />
            Filter
          </button>
          <button type="button" onClick={() => setAutoScroll(!autoScroll)} className={autoScroll ? "is-active" : ""}>
            <RotateCcw size={15} />
            Auto
          </button>
          <button type="button" onClick={handleExport} disabled={filteredLogs.length === 0}>
            <Download size={15} />
            Export
          </button>
          <button type="button" onClick={copyLogs} disabled={filteredLogs.length === 0}>
            <Copy size={15} />
            {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy"}
          </button>
          <button type="button" onClick={copyAllLogs} disabled={filteredLogs.length === 0}>
            <Copy size={15} />
            {copyAllState === "copied" ? "Copied" : copyAllState === "error" ? "Copy failed" : "Copy all"}
          </button>
          <button className="logs-clear-button" type="button" onClick={clearLogs} disabled={lines.length === 0 || clearing}>
            <Trash2 size={15} />
            {clearing ? "Clearing" : "Clear"}
          </button>
        </div>
      </div>
      
      {/* Filters Panel */}
      {showFilters && (
        <div className="logs-filters">
          <div className="logs-filter-group">
            <label>Category:</label>
            <Dropdown<string>
              value={selectedCategory}
              onChange={setSelectedCategory}
              placeholder="All categories"
              options={[
                { value: "all", label: "All categories" },
                ...categories.map(cat => ({ value: cat, label: cat.charAt(0).toUpperCase() + cat.slice(1) }))
              ]}
            />
          </div>
          <button className="logs-clear-filters" onClick={clearFilters}>
            <X size={14} />
            Clear filters
          </button>
        </div>
      )}
      
      {/* Results count */}
      <div className="logs-results-info">
        Showing {filteredLogs.length} of {stats.total} log lines
        {(searchQuery || selectedCategory !== "all" || activeTab !== "all") && (
          <span className="logs-filter-badge">filtered</span>
        )}
      </div>
      </div>

      {errorMessage && (
        <div className="audio-message is-error">
          <AlertTriangle size={17} /> {errorMessage}
        </div>
      )}

      {lines.length === 0 ? (
        <div className="audio-empty">
          <ScrollText size={32} strokeWidth={1.8} />
          <h2>No logs yet</h2>
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className="audio-empty">
          <Search size={32} strokeWidth={1.8} />
          <h2>No logs match your filters</h2>
          <button className="logs-clear-filters-btn" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : (
        <div ref={logRef} className="terminal-log" aria-label="Application logs">
          {filteredLogs.map((log, i) => (
            <div 
              key={i} 
              className={`log-line log-level-${log.level}`}
              onClick={() => log.details && toggleDetails(log.index)}
            >
              <span className="log-timestamp">{log.timestamp}</span>
              <span className={`log-level-badge log-level-${log.level}`}>
                {log.level === "error" && <AlertOctagon size={12} />}
                {log.level === "warn" && <AlertTriangle size={12} />}
                {log.level === "info" && <Info size={12} />}
                {log.level.toUpperCase()}
              </span>
              <span className="log-event">{log.event}</span>
              <span className="log-message">{log.message}</span>
              {log.details && (
                <span className="log-details-toggle">
                  {expandedDetails.has(log.index) ? "▼" : "▶"}
                </span>
              )}
              {log.details && expandedDetails.has(log.index) && (
                <pre className="log-details">{log.details}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
