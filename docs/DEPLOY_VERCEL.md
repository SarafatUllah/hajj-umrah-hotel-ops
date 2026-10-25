# Deploying the MVP on Vercel (free plan) with Supabase

This guide puts the whole system online at no cost for a demo (D-P2-67): the three websites and the API on Vercel,
the background worker as a Vercel Daemon, the database and the uploaded files on Supabase. Everything is configured by
`vercel.json` and `Dockerfile.worker`; you create the accounts, paste the settings and run the database setup once.

**Use demo data only.** No real pilgrims' passports on this setup: it has no automatic backups, its limits stop work
when they run out, and where pilgrims' data may be stored is still an open client question (client question 27).

## What runs where

| Part | Where | Notes |
|---|---|---|
| Public site, agency portal, ops console | Vercel functions (one project, "Services") | each on its own address, chosen by the start of its host name |
| API | Vercel function, **private** | only the three websites can reach it (a service binding), never the internet |
| Background worker (hold expiry, reminders, retention, passport reading) | Vercel Daemon `worker` | one always-on container in Mumbai (`bom1`); production only |
| Database (PostgreSQL 16) | Supabase, free plan | 500 MB |
| Documents and passport photos | Supabase Storage, free plan, private bucket | 1 GB; passport photos are encrypted before they are stored |

Region: everything in Mumbai (Vercel `bom1`, Supabase "South Asia (Mumbai)") — close to Bangladesh and the Gulf, and
the API's database round trips stay short. If you choose another region, change `bom1` in `vercel.json` (both places)
and create the Supabase project in the matching region.

## Limits of the free setup (read before you start)

- **Vercel's free plan is for non-commercial personal use only.** A project anyone is paid to build or run needs Pro
  ($20 a month per member); upgrading later changes nothing in the code.
- **The worker has 5 hours of CPU a month.** When they run out, Vercel stops the worker until the 1st: holds stop
  expiring and passport photos stop being read. `JOBS_POLL_SECONDS=15` keeps an idle worker well under it; the
  project's Usage page shows what it used.
- **Daemons are in beta and run only in production.** A preview deployment has no worker, and shows only the public
  site (one address).
- **Uploads are at most 4 MB.** The apps shrink a larger photo before sending it; a PDF over 4 MB must be made smaller.
- **No automatic backups** on Supabase's free plan (see "Backups"). A Supabase project with no activity for a week is
  paused (open its dashboard and press Restore).
- **Server logs are kept for one hour** on Vercel's free plan.
- **Customers cannot sign in on the public site** (it texts a code; no SMS provider is connected): use the demo
  sign-in on the console and the portal.

## 1. Supabase: the database and the file storage

1. Create a project at [supabase.com](https://supabase.com): region **South Asia (Mumbai)**. Keep the database
   password.
2. **Turn the Data API off**: Project Settings → Data API → disable. The app connects to PostgreSQL directly; left on,
   Supabase would publish the app's tables through its own web API.
3. **The connection string**: Connect → **Session pooler** (it works over IPv4, which Vercel needs). It looks like
   `postgresql://postgres.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`. Use the session
   pooler for everything: the transaction pooler (port 6543) breaks prepared statements and the job queue.
4. **The files**: Storage → New bucket → name `hotel-files`, **Public: off**. Then Storage → Settings → **S3
   Connection**: enable it, note the **Endpoint** (`https://<project-ref>.storage.supabase.co/storage/v1/s3`) and the
   **Region**, and create an **access key** (Access key ID and Secret access key — the secret is shown once). These
   keys reach every bucket: they go only into Vercel's settings.

## 2. Secrets (on your computer)

```bash
openssl rand -base64 48                 # NUXT_SESSION_PASSWORD
echo "k1:$(openssl rand -base64 32)"    # PII_ENCRYPTION_KEYS
openssl rand -base64 32                 # PII_LOOKUP_KEY
```

Keep all three in a password manager. **Losing `PII_ENCRYPTION_KEYS` loses every encrypted passport number, guest
detail and passport photo**; changing `NUXT_SESSION_PASSWORD` signs everyone out.

## 3. The database, once (from your computer)

In the repository, with the session pooler connection string from step 1:

```bash
export DATABASE_URL='postgresql://postgres.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
pnpm db:migrate      # creates the tables (and the btree_gist extension)
pnpm rbac:sync       # roles and permissions
APP_ENV=demo pnpm db:seed   # the demo organization: hotels, rooms, rates, staff and agency personas
```

The demo personas share the password `DemoPassword123!` (public by design: demo data only).

## 4. The Vercel project

1. Push the code to GitHub (`main` of `sumoncse19/hajj-umrah`).
2. Vercel → Add New → Project → import the repository. **Root Directory: `./`** (the repository root — required for the
   worker). The framework shows as **Services** (from `vercel.json`); leave the build settings alone.
3. Environment Variables → paste this (Production and Preview), with your values:

   ```bash
   APP_ENV=demo
   DEMO_SIGN_IN_ENABLED=true
   NUXT_PUBLIC_ORGANIZATION_SLUG=demo
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   DATABASE_POOL_MAX=3
   NUXT_SESSION_PASSWORD=<from step 2>
   PII_ENCRYPTION_KEYS=k1:<from step 2>
   PII_LOOKUP_KEY=<from step 2>
   TRUST_PROXY=true
   NUXT_API_PROXY_TRUST_PROXY=true
   ALLOWED_ORIGINS=https://hajj-umrah.vercel.app,https://agency-hajj-umrah.vercel.app,https://ops-hajj-umrah.vercel.app
   JOBS_MODE=send
   JOBS_POOL_MAX=2
   JOBS_POLL_SECONDS=15
   STORAGE_DRIVER=s3
   S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
   S3_REGION=ap-south-1
   S3_BUCKET=hotel-files
   S3_ACCESS_KEY_ID=<from step 1>
   S3_SECRET_ACCESS_KEY=<from step 1>
   S3_FORCE_PATH_STYLE=true
   ```

   `ALLOWED_ORIGINS` lists the three addresses of step 5, exactly (`https://`, no trailing slash): when you pick other
   names, change it and redeploy — a form sent from an address not on it is refused (`CSRF_ORIGIN_MISMATCH`). Do
   **not** set `NUXT_API_PROXY_TARGET` (Vercel fills it in from the binding), `WORKER_JOBS` (the daemon's command sets
   it) or `NUXT_SESSION_COOKIE_SECURE` (secure by default). `JOBS_MODE=send`: the API functions only enqueue; the
   worker works every queue.
4. Deploy.

## 5. The three addresses

Each website is chosen by how its host name starts (`vercel.json` → `rewrites`): **`agency.` or `agency-`** → the
agency portal, **`ops.` or `ops-`** → the ops console, anything else → the public site.

Project → Settings → Domains, add free `vercel.app` names (any free ones that follow the rule), for example:

| Address | App |
|---|---|
| `hajj-umrah.vercel.app` (the project's own) | public site |
| `agency-hajj-umrah.vercel.app` | agency portal |
| `ops-hajj-umrah.vercel.app` | ops console |

With your own domain later: `example.com`, `agency.example.com`, `ops.example.com` — no code change. Each app keeps its
own session cookie on its own address, through its own `/api` (no cross-site cookies are involved).

## 6. Check it

1. The public site lists the demo hotels.
2. The ops console: a demo sign-in button signs you in; the dashboard and the room calendar load.
3. The agency portal: the demo agency signs in; make a quote and a booking, add a passport photo.
4. Vercel → the project → **Daemons / Logs**: `[worker] started (all, polling every 15s); queues: …`. Within about 15
   seconds of the upload, the photo's status leaves "queued" (to manual review: no OCR is configured).
5. The rate limits see each visitor's own address. Open the public site, then run in Supabase → SQL Editor, with your
   public address (any "what is my IP" page) in place of `203.0.113.7`:

   ```sql
   select count(*) from rate_limit_bucket
   where key = 'public-catalog-ip:' || encode(sha256(convert_to('203.0.113.7', 'UTF8')), 'hex');
   ```

   (an IPv6 address counts by its first four groups: `2001:db8:85a3:8d3::/64` for `2001:db8:85a3:8d3:…`.)
   `1` = the API sees your address (keys hold a hash of it, never the address). `0` = it sees another one, and every
   visitor would share one limit: report it — Vercel does not document whether its internal calls between services
   keep the forwarded address.

## Updating

Push to `main`: Vercel builds and deploys everything together. When a change adds a migration, run
`pnpm db:migrate` (step 3, same `DATABASE_URL`) **before** the push; after a change that adds permissions, run
`pnpm rbac:sync` too.

## Backups

Supabase's free plan keeps none. Now and then (and before any risky change):

```bash
pg_dump "$DATABASE_URL" --format=custom --file="hajj-$(date +%F).dump"
```

and download the bucket with any S3 tool, for example
`aws s3 sync s3://hotel-files ./hotel-files-backup --endpoint-url https://<project-ref>.storage.supabase.co/storage/v1/s3`.

## If something goes wrong

| Symptom | Cause and fix |
|---|---|
| The build rejects `regions` or the daemon's region | Remove `"regions"` (then set Settings → Functions → Region to Mumbai) or change `bom1` under `daemons.worker.instances`. |
| A page says "Something went wrong" | The API refused to start: the function's log names the setting (`Invalid environment configuration: …`). |
| The agency or ops address shows the public site | Its name must start with `agency.`/`agency-` or `ops.`/`ops-`. |
| Saving anything fails with `CSRF_ORIGIN_MISMATCH` | The address is missing from `ALLOWED_ORIGINS` (exact `https://` origin), or the variable was changed without a redeploy. |
| Holds never expire, photos stay "queued" | The worker is not running: the Daemons page, its log, and the monthly CPU quota. |
| `too many clients` / connection errors | Lower `DATABASE_POOL_MAX` (and `JOBS_POOL_MAX`): every function instance and the worker hold a few connections. |
| Upload refused as too large | The file is over 4 MB (a PDF cannot be shrunk by the app). |

## Moving to a proper server later

Nothing in the code is Vercel-only. On Vercel Pro the same project simply gets higher limits. On a server or another
host: run the API (`node .output/server/index.mjs`, `JOBS_MODE=light`) and the worker (`Dockerfile.worker`, heavy
queues by default) and keep `STORAGE_DRIVER=s3` (or move the files to a lasting disk with `STORAGE_DRIVER=local`); move
the data with `pg_dump`/`pg_restore` and the bucket with an S3 copy. `docs/DEPLOY_CHECKLIST.md` lists the production
settings (`APP_ENV=production`, staff 2FA, SMS, Turnstile).
