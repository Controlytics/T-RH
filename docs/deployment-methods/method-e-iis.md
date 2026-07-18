# Method E: IIS Instead of Nginx

**Status: Only if client mandates IIS — HISTORICAL EVALUATION DOC**

> **2026-04-29 update:** Phase 4 of the windows-friendly-rewrite retired the bundled Nginx config from the standard install path. Fastify now serves the SPA + `/api/*` directly on `:3000`, so a reverse proxy is **optional**. If a customer requires IIS in front of Fastify, this evaluation still applies; otherwise the IIS step can be skipped entirely. EMQX → Mosquitto 2.0 (Phase 1); BullMQ + Memurai → graphile-worker on Postgres (Phase 2) also apply. DigiLog ships as the `DigiLog-Setup-<ver>.exe` installer (Fastify serves the SPA directly; a reverse proxy is optional); the deployment runbook is [`docs/PHARMA_DEPLOYMENT_21CFR.md`](../PHARMA_DEPLOYMENT_21CFR.md).
>
> **2026-06 update (Phase 7):** the entire data-ingestion subsystem — MQTT (Mosquitto), TimescaleDB, and Redis — was removed, and the WebSocket layer no longer exists. The Memurai (:6379), EMQX/Mosquitto (:1883), and WebSocket-proxy references below **no longer apply**; DigiLog now runs on a single vanilla PostgreSQL 18 database with no broker, cache, or WebSocket endpoint. This page is retained as a historical evaluation only.

Same as Method A but replace Nginx with IIS (Windows' built-in web server). Use IIS URL Rewrite + Application Request Routing (ARR) for reverse proxy.

---

## How It Works

```
IIS (Windows built-in web server)
├── Static files: C:\DigiLog\web\     ← serves React SPA
├── URL Rewrite: /api/* → https://127.0.0.1:3000/api/*
├── URL Rewrite: /docs → https://127.0.0.1:3000/docs
└── SPA fallback: /* → /index.html

Node.js + PM2 → digilog-api (:3000)
PostgreSQL (:5432)
Memurai (:6379)
EMQX (:1883)
```

IIS replaces Nginx for static file serving and reverse proxying.

## Pros

### 1. IIS is Native Windows — No Extra Install
IIS is a Windows Feature, not a third-party download. Enable it via:
```powershell
Install-WindowsFeature Web-Server -IncludeManagementTools
```
No downloading, no ZIP extraction, no PATH configuration.

### 2. Windows Admins Already Know IIS
Most Windows Server admins have configured IIS before. They know IIS Manager, application pools, site bindings.

### 3. Auto-Starts as Windows Service
IIS runs as the `W3SVC` Windows Service. Auto-starts on boot by default. No NSSM wrapper needed.

### 4. Built-in Windows Logging
IIS logs integrate with Windows Event Viewer. Enterprise monitoring tools (SCOM, Nagios) have built-in IIS monitoring.

### 5. SSL Certificate Management
IIS has a GUI for SSL certificate binding. Import `.pfx` certificates through IIS Manager. Integrates with Windows Certificate Store.

---

## Cons

### 1. IIS Reverse Proxy Configuration is Painful

**Required modules (not installed by default):**
- **URL Rewrite Module** — separate download from Microsoft
- **Application Request Routing (ARR)** — separate download
- **WebSocket Protocol** — must be enabled in Windows Features

**Nginx config (20 lines, clear syntax):**
```nginx
location /api/ {
    proxy_pass https://127.0.0.1:3000/api/;
    proxy_ssl_verify off;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location / {
    try_files $uri $uri/ /index.html;
}
```

**IIS equivalent (web.config XML — 50+ lines):**
```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="API Proxy" stopProcessing="true">
          <match url="^api/(.*)" />
          <action type="Rewrite" url="https://127.0.0.1:3000/api/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_FOR" value="{REMOTE_ADDR}" />
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="HTTP_HOST" value="{HTTP_HOST}" />
          </serverVariables>
        </rule>
        <rule name="Swagger Proxy" stopProcessing="true">
          <match url="^docs(.*)" />
          <action type="Rewrite" url="https://127.0.0.1:3000/docs{R:1}" />
        </rule>
        <rule name="WebSocket Proxy" stopProcessing="true">
          <match url="^ws(.*)" />
          <action type="Rewrite" url="https://127.0.0.1:3000/ws{R:1}" />
        </rule>
        <rule name="SPA Fallback" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="/index.html" />
        </rule>
      </rules>
    </rewrite>
    <httpProtocol>
      <customHeaders>
        <add name="X-Frame-Options" value="SAMEORIGIN" />
        <add name="X-Content-Type-Options" value="nosniff" />
        <add name="X-XSS-Protection" value="1; mode=block" />
      </customHeaders>
    </httpProtocol>
    <webSocket enabled="true" />
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="10485760" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

Every change requires understanding XML rewrite rules. Typos in XML cause IIS to return 500 errors with no helpful message.

---

### 2. WebSocket Proxying Through IIS is Fragile

Your app uses WebSockets for real-time updates (filter state changes, alarm notifications).

**IIS WebSocket issues:**
- WebSocket protocol must be explicitly installed as a Windows Feature
- ARR doesn't natively support WebSocket upgrade in all configurations
- IIS default connection timeout: 120 seconds — WebSocket connections drop after 2 minutes unless changed
- Must set `connectionTimeout="00:00:00"` for infinite timeout
- Some IIS versions have bugs where WebSocket connections silently drop under load
- Application pool recycling kills ALL WebSocket connections

**Timeout configuration:**
```xml
<!-- In applicationHost.config, not web.config -->
<webSocket enabled="true" pingInterval="00:00:10" receiveBufferLimit="4194304">
  <connectionTimeout value="00:00:00" />
</webSocket>
```

**Real scenario:** Users report "real-time updates stop working after a few minutes." IIS drops WebSocket connections due to timeout. You debug API code for hours before discovering it's IIS configuration.

---

### 3. Slower Than Nginx for Static Files

| Benchmark | Nginx | IIS |
|---|---|---|
| Static file requests/sec | ~15,000 | ~8,000 |
| Memory usage (static serving) | ~5 MB | ~50 MB |
| First-byte latency | ~2 ms | ~5 ms |

**Why:** Nginx is built specifically for high-performance static serving and reverse proxying. IIS is a general-purpose web server with many features (ASP.NET, ISAPI, auth modules) consuming memory even when unused.

**Impact for your app:** Not meaningful at factory scale (20-50 users). But wasted resources.

---

### 4. IIS Application Pool Recycling

IIS recycles application pools (worker processes) on a schedule:
- Default: every **29 hours**
- Also triggers on: memory limit, CPU limit, specific times, configuration changes

**What happens during recycling:**
- All active HTTP connections are dropped momentarily
- Users see a brief blank page or loading spinner
- WebSocket connections are killed — real-time updates stop
- First request after recycle is slow (cold start)

**Nginx never does this.** Nginx reloads gracefully without dropping connections.

**Configuration to mitigate:**
```powershell
# Disable periodic recycling
Set-ItemProperty "IIS:\AppPools\DigiLog" -Name recycling.periodicRestart.time -Value "00:00:00"
# Set recycling to specific time (e.g., 3 AM)
Set-ItemProperty "IIS:\AppPools\DigiLog" -Name recycling.periodicRestart.schedule -Value @{value="03:00:00"}
```

---

### 5. Enterprise IIS Mandates Come with More Requirements

If a client says "you must use IIS," they typically also require:
- **Windows Authentication** (Kerberos/NTLM) instead of JWT
- **Active Directory** integration for all user accounts
- **IIS logging format** (W3C extended)
- **Specific TLS cipher suites** and protocol versions
- **IIS Manager** for all configuration (no command-line editing)
- **Centralized certificate management** via Group Policy

**What this means:** Significant extra work to adapt your deployment to their IIS standards. Deployment guide becomes client-specific.

---

### 6. ARR Proxy Adds Latency

Application Request Routing (ARR) processes every proxied request through IIS's full pipeline:

```
Request → IIS Pipeline → URL Rewrite → ARR → Backend API → Response → ARR → IIS Pipeline → Client
```

Compared to Nginx:
```
Request → Nginx → Backend API → Response → Nginx → Client
```

IIS pipeline includes authentication modules, logging modules, compression modules, etc. — even for simple proxy requests. Adds ~5-10ms per API call.

---

## When to Use Method E

- Client mandates IIS and won't allow Nginx
- Enterprise environment with existing IIS infrastructure
- Client IT team is skilled with IIS but won't learn Nginx

## When NOT to Use Method E

- You have a choice (Nginx is better in every technical aspect)
- WebSocket reliability is important
- You want simple, readable configuration
- You want to use the existing deployment scripts (they use Nginx)
