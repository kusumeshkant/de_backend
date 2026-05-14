# DQ Backend — Deployment Guide

## Architecture overview

```
Branch      →  Provider  →  Target
──────────────────────────────────────────────────────────────
develop     →  render    →  dq-backend-uat.onrender.com        (UAT — current)
develop     →  azure     →  ca-dq-uat (Azure Container Apps)   (UAT — when re-enabled)
main        →  azure     →  ca-dq-backend (Azure Container Apps) (Production — always)
```

Production (`main → Azure`) is never affected by the `DEPLOY_PROVIDER` flag.

---

## Deployment provider flag

The active UAT provider is controlled by a single GitHub repository variable:

| Setting | Effect |
|---------|--------|
| `DEPLOY_PROVIDER = render` | `deploy-render-uat.yml` runs on push to `develop` |
| `DEPLOY_PROVIDER = azure`  | `deploy-azure-uat.yml` runs on push to `develop` |

**To change the provider:**
1. GitHub → repository → Settings → Secrets and variables → Actions → Variables
2. Edit `DEPLOY_PROVIDER`
3. The next push to `develop` targets the new provider — no code changes needed

---

## GitHub Actions workflow files

| File | Trigger | Purpose |
|------|---------|---------|
| `deploy.yml` | push to `main` | Production deploy → Azure (never changed) |
| `deploy-azure-uat.yml` | push to `develop` (if `DEPLOY_PROVIDER=azure`) | UAT → Azure Container Apps |
| `deploy-render-uat.yml` | push to `develop` (if `DEPLOY_PROVIDER=render`) | UAT → Render |
| `deploy-uat.yml` | `workflow_dispatch` only | Emergency manual Azure UAT deploy (override) |

---

## Flutter app backend URL

All three apps (`dq_admin`, `dq_staff`, `dq_app`) use `AppConfig.graphqlEndpoint`,
which is compiled in at build time via two `--dart-define` flags:

```
APP_FLAVOR=uat
BACKEND_PROVIDER=render | azure
```

| BACKEND_PROVIDER | UAT endpoint |
|-----------------|--------------|
| `render`        | `https://dq-backend-uat.onrender.com/graphql` |
| `azure`         | `https://ca-dq-uat.ashysea-f5376b70.centralindia.azurecontainerapps.io/graphql` |

The build scripts (`build_uat.ps1`, `build_web_uat.ps1`) pass both flags automatically.
To change the target, update `$BACKEND_PROVIDER` in each script and rebuild.

---

## One-time Render setup (done once per environment)

### 1. Create the Render service

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect the GitHub repo `kusumeshkant/de_backend`
3. Configure:
   - **Name:** `dq-backend-uat`
   - **Environment:** Docker
   - **Branch:** `develop`
   - **Dockerfile path:** `./Dockerfile`
   - **Region:** Singapore
   - **Plan:** Starter ($7/month) — use Free only for occasional testing (cold starts)
4. Set environment variables (Environment tab):
   - `NODE_ENV` = `staging`
   - `MONGO_URI` = *(paste Atlas connection string)*
   - `FIREBASE_SERVICE_ACCOUNT` = *(paste full service account JSON as single line)*
   - `APPLICATIONINSIGHTS_CONNECTION_STRING` = *(leave empty)*
5. Click **Create Web Service** — first deploy will start

### 2. Get the deploy hook URL

1. Render dashboard → `dq-backend-uat` → Settings → Deploy Hook
2. Copy the URL (looks like `https://api.render.com/deploy/srv-xxxx?key=yyyy`)

### 3. Add GitHub secrets and variables

**Secrets** (Settings → Secrets and variables → Actions → Secrets):
- `RENDER_DEPLOY_HOOK_UAT` = *(deploy hook URL from step 2)*

**Variables** (Settings → Secrets and variables → Actions → Variables):
- `DEPLOY_PROVIDER` = `render`
- `RENDER_UAT_URL` = `https://dq-backend-uat.onrender.com`
  *(confirm exact URL from Render dashboard after first deploy)*

### 4. Verify CORS

`uat-admin.dqstore.in`, `uat-staff.dqstore.in`, `uat-app.dqstore.in` are already
in the backend CORS allowlist (`src/index.js`). No changes needed — the web apps
can reach the Render backend at the correct URL.

---

## Switching back to Azure UAT

When the Azure subscription `df095314-c591-429a-b242-b3e2f17b8b64` is re-enabled:

1. **Re-enable Azure subscription:**
   - Azure Portal → Subscriptions → `df095314-...` → Re-enable
   - Ensure billing details are up to date

2. **Switch the provider flag:**
   - GitHub → Settings → Variables → `DEPLOY_PROVIDER` → change to `azure`

3. **Update Flutter build scripts:**
   - In `build_uat.ps1` and `build_web_uat.ps1`, change `$BACKEND_PROVIDER = "render"` → `"azure"`

4. **Rebuild and redistribute UAT apps:**
   - Run `.\build_uat.ps1` → distributes new APKs to Firebase App Distribution
   - Run `.\build_web_uat.ps1` → rebuild web apps → upload to Cloudflare Pages

5. **Verify:**
   - Push to `develop` → confirm `deploy-azure-uat.yml` runs and health check passes
   - Confirm apps hit the Azure UAT URL

---

## Environment variable parity (Render ↔ Azure)

| Variable | Render | Azure | Notes |
|----------|--------|-------|-------|
| `NODE_ENV` | `staging` | `staging` | Non-production: enables schema validation, introspection |
| `PORT` | Auto-set by Render | `4000` (Azure default) | App reads `process.env.PORT \|\| 4000` |
| `MONGO_URI` | Render Environment tab | Azure secret | Same Atlas cluster |
| `FIREBASE_SERVICE_ACCOUNT` | Render Environment tab | Azure secret | Same JSON, same format |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Empty | Azure secret | Azure-specific telemetry |

---

## Rollback

**Render:** Render dashboard → `dq-backend-uat` → Deploys → click any previous deploy → Rollback

**Azure (when active):**
```
az containerapp revision list --name ca-dq-uat --resource-group rg-dq-prod
az containerapp revision activate --name ca-dq-uat --resource-group rg-dq-prod --revision <name>
```

**Image reference:** Both providers push the Docker image to GHCR.
```
ghcr.io/kusumeshkant/de_backend:uat-<git-sha>
```
Every deployment is tagged with the commit SHA for precise rollback identification.

---

## Health and version endpoints

| Endpoint | Purpose |
|----------|---------|
| `/health` | Returns `{"status":"ok"}` — used by CI/CD health checks |
| `/version` | Returns `{"env","version","timestamp"}` — confirms which build is live |

**Render UAT:** `https://dq-backend-uat.onrender.com/health`
**Azure UAT:** `https://ca-dq-uat.ashysea-f5376b70.centralindia.azurecontainerapps.io/health`
**Azure Production:** `https://ca-dq-backend.ashysea-f5376b70.centralindia.azurecontainerapps.io/health`
