/**
 * Dashboard HTML Template
 *
 * Single-file HTML dashboard with embedded CSS and Alpine.js
 */

export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proton Drive Sync - Dashboard</title>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 1.5rem;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1.5rem;
      color: #fff;
    }

    h2 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #a0a0a0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 1rem;
    }

    .stat-card {
      text-align: center;
    }

    .stat-value {
      font-size: 2.5rem;
      font-weight: 700;
      line-height: 1;
    }

    .stat-label {
      font-size: 0.875rem;
      color: #808080;
      margin-top: 0.25rem;
    }

    .stat-pending .stat-value { color: #f59e0b; }
    .stat-processing .stat-value { color: #3b82f6; }
    .stat-synced .stat-value { color: #10b981; }
    .stat-blocked .stat-value { color: #ef4444; }

    .section {
      margin-bottom: 1.5rem;
    }

    .list {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      max-height: 300px;
      overflow-y: auto;
    }

    .list-item {
      padding: 0.625rem 1rem;
      border-bottom: 1px solid #2a2a2a;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.8125rem;
    }

    .list-item:last-child {
      border-bottom: none;
    }

    .list-item-path {
      color: #e0e0e0;
      word-break: break-all;
    }

    .list-item-error {
      color: #f87171;
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }

    .list-item-meta {
      color: #606060;
      font-size: 0.75rem;
      margin-top: 0.125rem;
    }

    .empty {
      color: #606060;
      padding: 1rem;
      text-align: center;
      font-style: italic;
    }

    .logs {
      background: #0a0a0a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 1rem;
      max-height: 400px;
      overflow-y: auto;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.75rem;
      line-height: 1.5;
    }

    .log-line {
      white-space: pre-wrap;
      word-break: break-all;
    }

    .log-line.error { color: #f87171; }
    .log-line.warn { color: #fbbf24; }
    .log-line.info { color: #60a5fa; }
    .log-line.debug { color: #6b7280; }

    .connection-status {
      position: fixed;
      top: 1rem;
      right: 1rem;
      padding: 0.375rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .connection-status.connected {
      background: #064e3b;
      color: #34d399;
    }

    .connection-status.disconnected {
      background: #7f1d1d;
      color: #fca5a5;
    }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    @media (max-width: 768px) {
      .two-col {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body x-data="dashboard()" x-init="init()">
  <div class="connection-status" :class="connected ? 'connected' : 'disconnected'">
    <span x-text="connected ? 'Connected' : 'Disconnected'"></span>
  </div>

  <h1>Proton Drive Sync</h1>

  <!-- Stats Grid -->
  <div class="grid">
    <div class="card stat-card stat-pending">
      <div class="stat-value" x-text="stats.pending">0</div>
      <div class="stat-label">Pending</div>
    </div>
    <div class="card stat-card stat-processing">
      <div class="stat-value" x-text="stats.processing">0</div>
      <div class="stat-label">Processing</div>
    </div>
    <div class="card stat-card stat-synced">
      <div class="stat-value" x-text="stats.synced">0</div>
      <div class="stat-label">Synced</div>
    </div>
    <div class="card stat-card stat-blocked">
      <div class="stat-value" x-text="stats.blocked">0</div>
      <div class="stat-label">Blocked</div>
    </div>
  </div>

  <!-- Jobs Section -->
  <div class="two-col">
    <!-- Processing Jobs -->
    <div class="section">
      <h2>Processing</h2>
      <div class="list">
        <template x-if="processing.length === 0">
          <div class="empty">No jobs currently processing</div>
        </template>
        <template x-for="job in processing" :key="job.id">
          <div class="list-item">
            <div class="list-item-path" x-text="job.localPath"></div>
          </div>
        </template>
      </div>
    </div>

    <!-- Blocked Jobs -->
    <div class="section">
      <h2>Blocked</h2>
      <div class="list">
        <template x-if="blocked.length === 0">
          <div class="empty">No blocked jobs</div>
        </template>
        <template x-for="job in blocked" :key="job.id">
          <div class="list-item">
            <div class="list-item-path" x-text="job.localPath"></div>
            <div class="list-item-error" x-text="job.lastError"></div>
            <div class="list-item-meta">Retries: <span x-text="job.nRetries"></span></div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- Recent Synced -->
  <div class="section">
    <h2>Recently Synced</h2>
    <div class="list">
      <template x-if="recent.length === 0">
        <div class="empty">No recently synced files</div>
      </template>
      <template x-for="job in recent" :key="job.id">
        <div class="list-item">
          <div class="list-item-path" x-text="job.localPath"></div>
        </div>
      </template>
    </div>
  </div>

  <!-- Logs Section -->
  <div class="section">
    <h2>Logs</h2>
    <div class="logs" x-ref="logsContainer">
      <template x-if="logs.length === 0">
        <div class="empty">Waiting for log events...</div>
      </template>
      <template x-for="(line, index) in logs" :key="index">
        <div class="log-line" :class="getLogLevel(line)" x-text="line"></div>
      </template>
    </div>
  </div>

  <script>
    function dashboard() {
      return {
        connected: false,
        stats: { pending: 0, processing: 0, synced: 0, blocked: 0 },
        recent: [],
        blocked: [],
        processing: [],
        logs: [],
        eventsSource: null,
        logsSource: null,

        async init() {
          // Fetch initial data
          await this.fetchAll();

          // Connect to SSE streams
          this.connectEvents();
          this.connectLogs();
        },

        async fetchAll() {
          try {
            const [statsRes, recentRes, blockedRes, processingRes] = await Promise.all([
              fetch('/api/stats'),
              fetch('/api/jobs/recent'),
              fetch('/api/jobs/blocked'),
              fetch('/api/jobs/processing'),
            ]);

            this.stats = await statsRes.json();
            this.recent = await recentRes.json();
            this.blocked = await blockedRes.json();
            this.processing = await processingRes.json();
          } catch (err) {
            console.error('Failed to fetch data:', err);
          }
        },

        connectEvents() {
          this.eventsSource = new EventSource('/api/events');

          this.eventsSource.onopen = () => {
            this.connected = true;
          };

          this.eventsSource.onerror = () => {
            this.connected = false;
            // Reconnect after 2 seconds
            setTimeout(() => this.connectEvents(), 2000);
          };

          this.eventsSource.addEventListener('stats', (e) => {
            this.stats = JSON.parse(e.data);
          });

          this.eventsSource.addEventListener('job', (e) => {
            const event = JSON.parse(e.data);
            // Refresh all data on any job event
            this.fetchAll();
          });
        },

        connectLogs() {
          this.logsSource = new EventSource('/api/logs');

          this.logsSource.addEventListener('log', (e) => {
            this.logs.push(e.data);
            // Keep only last 500 lines
            if (this.logs.length > 500) {
              this.logs = this.logs.slice(-500);
            }
            // Auto-scroll to bottom
            this.$nextTick(() => {
              const container = this.$refs.logsContainer;
              if (container) {
                container.scrollTop = container.scrollHeight;
              }
            });
          });

          this.logsSource.onerror = () => {
            // Reconnect after 2 seconds
            setTimeout(() => this.connectLogs(), 2000);
          };
        },

        getLogLevel(line) {
          if (line.includes('"level":"error"') || line.includes('"level":50')) return 'error';
          if (line.includes('"level":"warn"') || line.includes('"level":40')) return 'warn';
          if (line.includes('"level":"info"') || line.includes('"level":30')) return 'info';
          if (line.includes('"level":"debug"') || line.includes('"level":20')) return 'debug';
          return '';
        }
      };
    }
  </script>
</body>
</html>`;
