# Tennis Edge Deployment

This project is ready to deploy as a web app with Docker.

## What Is Automated

- Docker production runtime
- Render blueprint config
- `/healthz` health check endpoint
- optional password protection with Basic Auth
- GitHub Actions syntax checks
- optional GitHub Actions deploy hook trigger

## What Still Needs Your Account

No deployment tool can create or bill a cloud account without your login. You need to connect the repo to a host once, then future deploys can be automatic.

## Recommended: Render Blueprint

1. Push this folder to a private GitHub repo.
2. In Render, create a new Blueprint from the repo.
3. Render will read `render.yaml`.
4. Add the private environment variables when Render asks for them.

Required private values:

```text
APP_BASIC_AUTH_USER
APP_BASIC_AUTH_PASSWORD
RAPIDAPI_KEY
ALLSPORTS_TENNIS_RAPIDAPI_KEY
SOFASCORE_RAPIDAPI_KEY
JJRM365_TENNIS_RAPIDAPI_KEY
LIVESCORE6_RAPIDAPI_KEY
```

Use the same RapidAPI key value for the API keys you currently use, or only fill the sources you want active.

`render.yaml` is set to Render's `free` plan so creating the service does not silently choose a paid starter instance. Free services may sleep when unused; upgrade later if you want always-on live refreshes.

## Auto Redeploy From GitHub

After the first Render service exists:

1. Copy the service deploy hook URL from Render.
2. Add it to GitHub repo secrets as:

```text
RENDER_DEPLOY_HOOK_URL
```

Then every push to `main` or `master` will:

- check `server.mjs`
- check `app.js`
- validate `odds_preload.json`
- trigger a Render redeploy

You can also trigger the deploy hook manually from PowerShell:

```powershell
$env:RENDER_DEPLOY_HOOK_URL="https://api.render.com/deploy/..."
.\scripts\deploy-render-hook.ps1
```

## If This Folder Is Not A Git Repo Yet

Run these from the project folder:

```powershell
git init -b main
git add .
git commit -m "Prepare Tennis Edge for web deployment"
git remote add origin https://github.com/YOUR_USERNAME/tennis-edge.git
git push -u origin main
```

Do not commit `.env`; it is ignored by `.gitignore`.

## Local Production Check

Run:

```powershell
npm run check
npm start
```

Then open:

```text
http://localhost:5177/healthz
```

## Docker Check

If Docker Desktop is installed:

```powershell
docker build -t tennis-edge .
docker run --rm -p 5177:5177 --env-file .env tennis-edge
```

Then open:

```text
http://localhost:5177/
```

## Important Security Note

Set `APP_BASIC_AUTH_USER` and `APP_BASIC_AUTH_PASSWORD` in production. Without them, anyone with the public URL can open the app and trigger API refreshes.
