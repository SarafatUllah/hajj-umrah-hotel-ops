# Deploying the MVP on Vercel (free plan) with Supabase and Cloudflare R2

This guide puts the whole system online at no cost for a demo (D-P2-67): the three websites and the API on Vercel,
the database and the scheduler of the background jobs on Supabase, the uploaded files on Cloudflare R2. `vercel.json`
configures Vercel; you create the accounts, paste the settings and run the database setup once. How the deployed
system works, part by part, is in `docs/DEPLOYMENT_ARCHITECTURE.md`.

**Use demo data only.** No real pilgrims' passports on this setup: it has no automatic backups, and where pilgrims'
data may be stored is still an open client question (client question 27).

## What runs where

| Part | Where | Notes |
|---|---|---|
| Public site, agency portal, ops console | Vercel functions (one project, "Services") | each on its own address, chosen by the start of its host name |
| API | Vercel function, **private** | only the three websites reach it (a service binding); the one public path is `/api/jobs/tick` (secret-protected) |
| Background jobs (hold expiry, reminders, retention, passport reading) | a **job tick**: Supabase Cron calls `POST /api/jobs/tick` every 5 minutes | each call runs every job that is due, then stops |
| Database (PostgreSQL) | Supabase, free plan | 500 MB, 5 GB of data out a month; encrypted connections (`DATABASE_SSL=verify`) |
| Documents and passport photos | Cloudflare R2, free plan, private bucket | 10 GB, downloads free; passport photos are encrypted before they are stored |

Why a tick and not an always-on worker (a Vercel Daemon): Daemons are still a beta, and on the free plan a team gets
5 hours of active CPU a month for them. A worker polling the queue every 2 seconds spends some of it every minute, and
once the quota is used up Vercel stops the daemons until the 1st (the sites keep running, the jobs would not). The tick
needs no extra service: Supabase's free plan includes Cron (`pg_cron`) and HTTP calls from the database (`pg_net`).
On Vercel Pro or a server, the worker (`Dockerfile.worker`) can run all the time instead (see "Moving to a proper
server later").

Why R2 for the files: ten times the free storage of Supabase Storage (10 GB against 1 GB), and opening a file costs
nothing (on Supabase every download counts toward the project's 5 GB a month, shared with the database). The API talks
to any S3-compatible store, so Supabase Storage remains the fallback for anyone without a Cloudflare account — the
settings differ, not the code (step 2, last part).

Region: everything near Mumbai (Vercel `bom1`, Supabase "South Asia (Mumbai)", the R2 bucket's location
"Asia-Pacific") — close to Bangladesh and the Gulf, and the API's database round trips stay short. Another region:
change `regions` in `vercel.json` and create the Supabase project and the bucket in the matching region.

## Limits of the free setup (read before you start)

- **Vercel's free plan is for non-commercial personal use only.** A project anyone is paid to build or run needs Pro
  ($20 a month per member); upgrading later changes nothing in the code.
- **Background jobs run every 5 minutes**, not continuously: a passport photo is read (or sent to manual review) up
  to 5 minutes after its upload, and a booking whose hold ran out is marked EXPIRED (and its quote released) up to 5
  minutes late. Its rooms are free at once: availability already ignores a hold that has run out.
- **Keep `PASSPORT_OCR=none` here** (the default): the 5-minute pass runs every job inside a Vercel function, for 20
  seconds at most. Reading passports by OCR needs the always-on worker of "Moving to a proper server later".
- **Anyone who has the addresses can use the demo sign-in**, and so add bookings, documents and photos. Share them only
  with the people who need them. Uploads are rate-limited; R2 charges only past its free tier (its overview page shows
  the usage).
- **Function quota:** the free plan includes 4 hours of active CPU a month for all functions. A tick lasts about 3
  seconds and uses 0.03–0.15 s of CPU (measured), so 12 ticks an hour stay well under an hour of the quota a month.
  The project's Usage page shows what is used.
- **Cloudflare R2 must be turned on before it can be used**, and Cloudflare may ask for a payment card to do it.
  Nothing is charged within the free tier (10 GB stored, 1 million uploads and 10 million reads a month, Standard
  storage only); past it, the card is billed ($0.015 per GB a month). Without a card, use Supabase Storage (step 2,
  last part: 1 GB).
- **Preview deployments show only the public site** (one address) and must not use the demo database (step 5).
- **Uploads are at most 4 MB.** The apps shrink a larger photo before sending it; a PDF over 4 MB must be made smaller.
- **No automatic backups** of the database on Supabase's free plan, nor of the files on R2 (see "Backups"). A Supabase
  project with no activity for a week is paused (open its dashboard and press Restore).
- **Server logs are kept for one hour** on Vercel's free plan.
- **Customers sign in on the public site by e-mail** once step 5.4 is done: a code sent from a Gmail account, which
  sends to about 500 recipients a day. **Text messages are not connected**: the phone option answers that texts cannot
  be sent right now, and agencies get no text messages. Staff and agencies use the demo sign-in on the console and the
  portal.
- Supabase runs **PostgreSQL 17**; the test suites run on 16 (nothing in the schema depends on the difference).

## 1. Supabase: the database and the scheduler

1. Create a project at [supabase.com](https://supabase.com): region **South Asia (Mumbai)**. Keep the database
   password.
2. **Turn the Data API off**: open the **Data API** integration's overview and switch **Enable Data API** off. The app
   connects to PostgreSQL directly; left on, Supabase would publish the app's tables through its own web API.
3. **Encrypted connections only**: Database → Settings → **SSL Configuration**: turn on **Enforce SSL on incoming
   connections**, and **download the certificate** (a `.crt` file: the CA the app checks Supabase's certificate with).
4. **Room for the connections**: Database → Settings → **Connection pooling**: raise **Pool Size** to 40 (every API
   function instance and each tick hold a few connections; the default can be as low as 15).
5. **The connection string**: Connect → **Session pooler** (it works over IPv4, which Vercel needs). Copy it exactly —
   the host (`aws-<n>-<region>.pooler.supabase.com`) differs between projects. It looks like
   `postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres`. Use the session pooler for everything
   (the transaction pooler, port 6543, breaks prepared statements and the job queue), and leave `sslmode` out of it:
   `DATABASE_SSL` sets the encryption for every connection. A password with characters such as `@`, `:`, `/`, `?`
   or `#` must be written percent-encoded in the string (`@` → `%40`); simplest is a password of letters and digits.
6. **The scheduler**: Integrations (Database → Extensions) → enable **pg_cron** and **pg_net**. The schedule itself is
   created in step 7 below, once the site's address is known.

## 2. Cloudflare R2: the files

In the Cloudflare dashboard → **R2 object storage**:

1. **Turn R2 on** if the page offers it (Cloudflare calls this purchasing R2; the free tier costs nothing, but a
   payment card may be asked for first).
2. **Create bucket**: name `hotel-files`; **Location**: Asia-Pacific (APAC); **Default storage class**: Standard (the
   free tier covers Standard only). Keep it private: connect no custom domain and leave the public `r2.dev` address
   off — the API is the only way to the files.
3. **The key**: on the R2 overview, **Account Details** → **API Tokens** → **Manage** → **Create Account API token**:
   permission **Object Read & Write**, applied to the bucket **`hotel-files` only**. Copy the **Access Key ID** and
   the **Secret Access Key** (the secret is shown once) — they go only into Vercel's settings.
4. **The endpoint**: `https://<account-id>.r2.cloudflarestorage.com`. The account ID is the long hexadecimal part of
   the dashboard's address (`dash.cloudflare.com/<account-id>/…`); the token page shows the full endpoint too.

**Without a Cloudflare account: Supabase Storage.** In Supabase: Storage → New bucket → `hotel-files`, **Public: off**.
Then Storage → Settings → **S3 Connection**: enable it, note the **Endpoint**
(`https://<project-ref>.storage.supabase.co/storage/v1/s3`) and the **Region**, and create an **access key** (the
secret is shown once; these keys reach every bucket of the project). In step 5 use that endpoint and region instead
of R2's. The files then share Supabase's free limits: 1 GB stored, and downloads count toward its 5 GB a month.

## 3. Secrets (on your computer)

```bash
openssl rand -base64 48                 # NUXT_SESSION_PASSWORD
echo "k1:$(openssl rand -base64 32)"    # PII_ENCRYPTION_KEYS
openssl rand -base64 32                 # PII_LOOKUP_KEY
openssl rand -hex 32                    # JOBS_TICK_SECRET
```

Keep all four in a password manager. **Losing `PII_ENCRYPTION_KEYS` loses every encrypted passport number, guest
detail and passport photo**; changing `NUXT_SESSION_PASSWORD` signs everyone out.

## 4. The database, once (from your computer)

In the repository, with the connection string from step 1.5 and the certificate from step 1.3:

```bash
export DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres'
export DATABASE_SSL=verify
export DATABASE_SSL_CA="$(cat ~/Downloads/prod-ca-2021.crt)"   # the file downloaded in step 1.3
pnpm db:migrate      # creates the tables (and the btree_gist extension)
pnpm rbac:sync       # roles and permissions
APP_ENV=demo pnpm db:seed   # the demo organization: hotels, rooms, rates, staff and agency personas
```

The demo personas share the password `DemoPassword123!` (public by design: demo data only). If the connection is
refused with a certificate error, check that `DATABASE_SSL_CA` holds the downloaded file; `DATABASE_SSL=require`
encrypts without checking the certificate — use it only if verifying cannot be made to work.

## 5. The Vercel project

1. Push the code to GitHub (`main` of `sumoncse19/hajj-umrah`).
2. Vercel → Add New → Project → import the repository. **Root Directory: `./`** (the repository root). The framework
   shows as **Services** (from `vercel.json`); leave the build settings alone.
3. Environment Variables → add these for **Production only** (a preview deployment must not reach the demo database,
   its keys or its files), with your values:

   ```bash
   ENABLE_EXPERIMENTAL_COREPACK=1
   APP_ENV=demo
   DEMO_SIGN_IN_ENABLED=true
   NUXT_PUBLIC_ORGANIZATION_SLUG=demo
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres
   DATABASE_SSL=verify
   DATABASE_SSL_CA=<the certificate of step 1.3 on one line: the output of the awk command below>
   DATABASE_POOL_MAX=2
   NUXT_SESSION_PASSWORD=<from step 3>
   PII_ENCRYPTION_KEYS=<the whole line from step 3, its k1: included>
   PII_LOOKUP_KEY=<from step 3>
   TRUST_PROXY=true
   NUXT_API_PROXY_TRUST_PROXY=true
   TRUST_VISITOR_HEADER=true
   ALLOWED_ORIGINS=https://hajj-umrah.vercel.app,https://agency-hajj-umrah.vercel.app,https://ops-hajj-umrah.vercel.app
   JOBS_MODE=send
   JOBS_POOL_MAX=2
   JOBS_TICK_SECRET=<from step 3>
   STORAGE_DRIVER=s3
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_BUCKET=hotel-files
   S3_ACCESS_KEY_ID=<from step 2.3>
   S3_SECRET_ACCESS_KEY=<from step 2.3>
   S3_FORCE_PATH_STYLE=true
   ```

   `DATABASE_SSL_CA` goes on one line, its line breaks written as `\n` (the API turns them back). Print it with

   ```bash
   awk 'NF { printf "%s\\n", $0 }' ~/Downloads/prod-ca-2021.crt
   ```

   and paste the output. Every value is then a single line, so the block can go into Vercel's paste box as it is (a
   multi-line value pasted there keeps only its first line, and the API refuses to start: "must be a whole PEM
   certificate"). `ENABLE_EXPERIMENTAL_COREPACK=1` makes Vercel install with the pnpm the repository pins (9.4.0);
   `TRUST_VISITOR_HEADER=true` makes the API take each visitor's address from the header the websites' proxy adds
   (Vercel's internal hop may rewrite `X-Forwarded-For`), so every visitor has their own rate limits.
   With Supabase Storage instead of R2: `S3_ENDPOINT` and `S3_REGION` (e.g. `ap-south-1`) from step 2's last part,
   and its access key. `ALLOWED_ORIGINS` lists the three addresses of step 6, exactly (`https://`, no trailing
   slash): when you pick other names, change it and redeploy — a form sent from an address not on it is refused
   (`CSRF_ORIGIN_MISMATCH`). `JOBS_MODE=send`: the API functions only enqueue; the tick works the jobs. Do **not** set
   `NUXT_API_PROXY_TARGET` (Vercel fills it in from the binding) or `NUXT_SESSION_COOKIE_SECURE` (secure by default).
4. **Customer sign-in by e-mail (Gmail).** Customers sign in on the public site with a code sent to their e-mail
   address (or, once an SMS provider is connected, to their phone). The codes go out through a Gmail account over
   SMTP; e-mailing them outside development also needs the Cloudflare Turnstile bot check (the API refuses to start
   without it: a stranger could otherwise flood inboxes from your account).

   1. **An app password.** Use the Gmail account the e-mails should come from — best one made for this, not a
      personal mailbox: an app password opens the account's mail (sending and reading), so it is a secret like a
      password. Google Account → Security → turn on **2-Step Verification** (app passwords need it) → **App
      passwords** (`myaccount.google.com/apppasswords`) → name it `hajj-umrah` → Create. Copy the 16 letters
      **without the spaces**; revoke it there to cut access. Gmail sends to about **500 recipients a day** per
      account: the API's own budget for sign-in codes stays below (`EMAIL_DAILY_LIMIT=300`, `EMAIL_HOURLY_LIMIT=100`
      by default), leaving room for the booking messages to customers who sign in by e-mail, which count against
      Gmail's limit too. One client address gets at most 20 codes an hour and 40 a day (5 a day to one mailbox), one
      mailbox 30 a day in all.
   2. **The bot check.** Cloudflare dashboard → **Turnstile** → Add widget → name `hajj-umrah`, hostname
      `hajj-umrah.vercel.app` (and your own domain later), mode **Managed** → Create. Copy the **site key** and the
      **secret key**.
   3. Add these to the Production variables (same rules as above: one line each, no quotes):

      ```bash
      EMAIL_DRIVER=smtp
      SMTP_HOST=smtp.gmail.com
      SMTP_PORT=465
      SMTP_USER=<the Gmail address>
      SMTP_PASSWORD=<the app password of 5.4.1: 16 letters, no spaces>
      EMAIL_FROM=Hajj & Umrah Stays <the same Gmail address>
      CAPTCHA_DRIVER=turnstile
      CAPTCHA_SECRET=<the Turnstile secret key>
      NUXT_PUBLIC_TURNSTILE_SITE_KEY=<the Turnstile site key>
      ```

      Port 465 is TLS from the first byte; the API checks Gmail's certificate and never sends in clear text. The name
      in `EMAIL_FROM` is what the inbox shows and the site name the e-mail gives; keep its address the Gmail address
      itself (Gmail replaces any other sender with the account's own address unless it is a "Send mail as" alias you
      set up in Gmail).

   **Later, with your own domain: Resend.** Gmail is fine for a demo. For more volume and a sender on your own domain,
   use [Resend](https://resend.com): add the domain (Domains → Add, then the DNS records it lists, until it shows
   *Verified*), create an API key with **Sending access**, then replace the `SMTP_*` lines with

   ```bash
   EMAIL_DRIVER=resend
   RESEND_API_KEY=<the key>
   EMAIL_FROM=Hajj & Umrah Stays <bookings@your-domain.com>
   ```

   and redeploy, with `EMAIL_HOURLY_LIMIT` / `EMAIL_DAILY_LIMIT` set to your Resend plan: **Resend's free plan sends 100
   e-mails a day**, booking messages included, so there set them well below it (e.g. `EMAIL_HOURLY_LIMIT=30`,
   `EMAIL_DAILY_LIMIT=70`; keep them above the per-client-address caps of 20 an hour and 40 a day, or one visitor could
   spend the budget alone). **Do not switch before the
   domain is verified:** without it Resend sends only from its test address and only to your own Resend account's
   e-mail — every customer's code would fail (503 `EMAIL_UNAVAILABLE`; the log says `Resend answered 403
   (validation_error)`).
5. Deploy.

## 6. The three addresses

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

## 7. The job tick (Supabase Cron)

Supabase → SQL Editor, with the public site's address and `JOBS_TICK_SECRET`:

```sql
select cron.schedule('hajj-jobs-tick', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://hajj-umrah.vercel.app/api/jobs/tick',
    headers := jsonb_build_object('Authorization', 'Bearer <JOBS_TICK_SECRET>', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
```

The secret is stored in the database's cron table, readable only by its administrators. To change the interval or the
secret, run `select cron.unschedule('hajj-jobs-tick');` and schedule it again.

## 8. Check it

1. The public site lists the demo hotels.
2. The ops console: a demo sign-in button signs you in; the dashboard and the room calendar load.
3. The agency portal: the demo agency signs in; make a quote and a booking, add a passport photo. The photo opens in
   the portal, and the bucket (R2 → `hotel-files` → Objects) holds one more object — unreadable there: it is
   encrypted.
4. The tick: after 5 minutes, `select status_code, content from net._http_response order by created desc limit 3;` in
   the SQL Editor shows `200` and `{"idle":true,…}`; the photo's status has left "queued" (to manual review: no OCR is
   configured). A `401` means the secret in the schedule differs from `JOBS_TICK_SECRET`; a `404`, that
   `JOBS_TICK_SECRET` is not set in Vercel (or not yet deployed).
5. The rate limits see each visitor's own address. Open the public site over IPv4 (or `curl -4` its
   `/api/public/hotels?organization=demo`), then run in the SQL Editor, with the first three parts of your public
   address (any "what is my IP" page) in place of `203.0.113`:

   ```sql
   select n as last_part, b.hits
   from generate_series(0, 255) as n
   join rate_limit_bucket b
     on b.key = 'public-catalog-ip:' || encode(sha256(convert_to('203.0.113.' || n, 'UTF8')), 'hex');
   ```

   Keys hold a hash of the address, never the address. A row (or several) = the API sees your own address. Several
   rows are normal: many providers send traffic out through a pool of public addresses, so the "what is my IP" page
   can show a different one than a request used — which is why this checks the whole block. No row = it sees another
   address, so every visitor would share one limit: check that `TRUST_VISITOR_HEADER` and
   `NUXT_API_PROXY_TRUST_PROXY` are `true` in Production and that the latest deployment has them. (An IPv6 visitor
   counts by the first four groups of the address: `2001:db8:85a3:8d3::/64` for `2001:db8:85a3:8d3:…`.)
6. Customer sign-in: on the public site, Sign in → E-mail → an address you can read → complete the check → "E-mail me
   a code". The code arrives within a minute (look in the spam folder the first time) from the name and address of
   `EMAIL_FROM`; entering it with a name creates the account, and Account shows the address. The Gmail account's Sent
   folder shows the message too.

## Updating

Push to `main`: Vercel builds and deploys everything together. When a change adds a migration, run
`pnpm db:migrate` (step 4, same settings) **before** the push; after a change that adds permissions, run
`pnpm rbac:sync` too.

## Backups

Neither free plan keeps any. Now and then (and before any risky change), the database with `pg_dump` **17 or newer**
(the server's major version), checking the server's certificate with the file of step 1.3 as the app does:

```bash
pg_dump "$DATABASE_URL?sslmode=verify-full&sslrootcert=$HOME/Downloads/prod-ca-2021.crt" --format=custom --file="hajj-$(date +%F).dump"
```

and the files with any S3 tool, for example the AWS CLI with the bucket's key from step 2.3:

```bash
AWS_ACCESS_KEY_ID=<S3_ACCESS_KEY_ID> AWS_SECRET_ACCESS_KEY=<S3_SECRET_ACCESS_KEY> \
  aws s3 sync s3://hotel-files ./hotel-files-backup --region auto \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

(With Supabase Storage: its region and endpoint instead.) The passport photos in the copy open only with
`PII_ENCRYPTION_KEYS`: keep the keys safe, and not next to the backup.

## If something goes wrong

| Symptom | Cause and fix |
|---|---|
| The build rejects `regions` | Remove `"regions"` from `vercel.json` and set Settings → Functions → Region to Mumbai. |
| A page says "Something went wrong" | The API refused to start: the function's log names the setting (`Invalid environment configuration: …`). |
| The agency or ops address shows the public site | Its name must start with `agency.`/`agency-` or `ops.`/`ops-`. |
| Saving anything fails with `CSRF_ORIGIN_MISMATCH` | The address is missing from `ALLOWED_ORIGINS` (exact `https://` origin), or the variable was changed without a redeploy. |
| Bookings stay HELD past their time, photos stay "queued" | The tick is not running: step 7's schedule (`select * from cron.job`), then step 8.4. |
| Uploads fail; the log shows `AccessDenied`, `InvalidAccessKeyId` or `NoSuchBucket` | The key must be step 2.3's, with Object Read & Write on `hotel-files`; `S3_BUCKET` the bucket's exact name; `S3_ENDPOINT` the account's R2 address. |
| `Max client connections reached` / `too many clients` | Raise the Pool Size (step 1.4) or lower `DATABASE_POOL_MAX`/`JOBS_POOL_MAX`. |
| Connection errors mentioning a certificate | `DATABASE_SSL_CA` must be the whole downloaded file; with `sslmode` in `DATABASE_URL`, remove it. |
| `DATABASE_SSL_CA must be a whole PEM certificate` | The certificate lost its lines: paste the one-line form of step 5 (the awk command). |
| Every visitor is refused "too many attempts" at once | They share one rate limit: step 8.5 (`TRUST_VISITOR_HEADER`, `NUXT_API_PROXY_TRUST_PROXY`). |
| Upload refused as too large | The file is over 4 MB (a PDF cannot be shrunk by the app). |
| The API refuses to start: `CAPTCHA_DRIVER must be turnstile when sign-in codes are e-mailed` | E-mail sign-in needs the bot check: step 5.4.2 (`CAPTCHA_DRIVER`, `CAPTCHA_SECRET`, `NUXT_PUBLIC_TURNSTILE_SITE_KEY`). |
| Sign-in says e-mails cannot be sent right now | The function log names the cause: `[email] delivery failed: EAUTH 535` = the app password is wrong, revoked or pasted with its spaces (step 5.4.1); `ETIMEDOUT`/`ECONNECTION` = `SMTP_HOST`/`SMTP_PORT`; `Resend answered 403 (validation_error)` = the Resend domain is not verified yet. |
| Sign-in says "Please complete the check" for everyone | The Turnstile widget does not list this address (Cloudflare → Turnstile → the widget's hostnames), or the site key and the secret are from different widgets. |
| "Too many attempts" at sign-in | One address gets a code a minute, 3 in 15 minutes and 30 a day (5 a day from one visitor's address); one visitor's address 20 an hour and 40 a day; past `EMAIL_HOURLY_LIMIT`/`EMAIL_DAILY_LIMIT` the log warns `reached its otp-email-org-… e-mail budget`. |

## Moving to a proper server later

Nothing in the code is Vercel-only. The worker can run all the time as a Vercel Daemon (a beta: on the free plan within
its 5 active CPU-hours a month, on Pro without that quota): add to `vercel.json`

```json
"daemons": {
  "worker": {
    "root": "./",
    "entrypoint": "Dockerfile.worker",
    "command": ["sh", "-c", "WORKER_JOBS=all exec node --import tsx worker/index.ts"],
    "instances": { "bom1": 1 },
    "resources": { "requests": { "memory": "1Gi" } }
  }
}
```

and remove the Supabase schedule (`select cron.unschedule('hajj-jobs-tick');`). On a server or another host: run the
API (`node .output/server/index.mjs`, `JOBS_MODE=light`) and the worker (`Dockerfile.worker`, heavy queues by
default), keep `STORAGE_DRIVER=s3` (the R2 bucket stays where it is) or move the files to a lasting disk with
`STORAGE_DRIVER=local`, and `DATABASE_SSL` for a remote database; move the data with `pg_dump`/`pg_restore`.
`docs/DEPLOY_CHECKLIST.md` lists the production settings (`APP_ENV=production`, staff 2FA, e-mail, SMS, Turnstile).
