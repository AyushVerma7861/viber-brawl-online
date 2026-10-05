# Deploying Viber Brawl Online

You've done the GitHub → Cloudflare flow before, so this will feel familiar.
**There is one important difference, and it's the thing to get right.**

---

## Read this first: Worker, not Pages

Your last game was a single HTML file, so **Cloudflare Pages** was the right
choice. It just serves files.

This game is different. The live rooms are **Durable Objects** — a real server
that runs the match at 60 frames a second and decides who got hit. Pages cannot
run those. So this one has to be a **Worker**.

You'll still connect it to GitHub the same way. You just pick **Workers** instead
of **Pages** when you get to that screen.

There are two other new things:

| | Your last game | This one |
|---|---|---|
| Cloudflare product | Pages | **Workers** |
| A database | not needed | **needed** (accounts live there) |
| Build command | not needed | **`npm run build`** |
| Setup after deploy | nothing | **one paste** to create the tables |

That's the whole list. Four small differences.

---

## What's in the box

`viber-brawl-deploy.zip` — 45 files, 1.1 MB. Unzip it somewhere you'll find it,
like your Desktop.

The only file you need to touch by hand is `wrangler.toml`, and only one line of
it.

---

## Step 1 — Create the database, and paste its id

**Do this before uploading to GitHub.** The build needs to know where the
database is.

1. Go to <https://dash.cloudflare.com> and sign in
2. In the left sidebar, click **Storage & Databases** → **D1 SQL Database**
3. Click **Create**
4. Name it exactly: `viber-brawl-db`
5. Click **Create**

You'll land on the database's page. Find **Database ID** and copy it — it's a
long code like `a1b2c3d4-5678-90ab-cdef-1234567890ab`.

6. Open the unzipped folder, then open `wrangler.toml` in **Notepad**
7. Press Ctrl+F, search for `00000000`, and you'll land on this line:

   ```toml
   database_id = "00000000-0000-0000-0000-000000000000"
   ```

8. Replace the whole line with your real id, **keeping the quotes**:

   ```toml
   database_id = "a1b2c3d4-5678-90ab-cdef-1234567890ab"
   ```

9. Save the file (Ctrl+S)

> **This is the step that goes wrong.** If this line still has the zeros, the
> deploy fails with a message about the database not being found.

---

## Step 2 — Put the files on GitHub

Same as last time:

1. Go to <https://github.com/new>
2. Name it `viber-brawl`
3. **Do NOT** tick "Add a README" — the repo must start empty
4. Create the repository
5. On the next page, click **uploading an existing file**
6. Open your unzipped folder, select **everything inside it** (Ctrl+A), and drag
   it into the GitHub upload box
7. Scroll down, click **Commit changes**

> Drag the *contents* of the folder, not the folder itself, or everything ends up
> one level too deep and the build won't find `wrangler.toml`.

Refresh the page — you should see `wrangler.toml`, `package.json`, `public`,
`multiplayer`, and the rest.

---

## Step 3 — Connect Cloudflare to the repo

1. Cloudflare dashboard → **Workers & Pages** in the left sidebar
2. Click **Create**
3. Choose **Workers** ← **not Pages**
4. Click **Import a repository** (it may say "Connect to Git")
5. Authorise GitHub if it asks, then pick your `viber-brawl` repo
6. Cloudflare shows build settings. Set them to exactly:

   | Setting | Value |
   |---|---|
   | **Build command** | `npm run build` |
   | **Deploy command** | `npx wrangler deploy` |
   | **Root directory** | leave blank |

7. Click **Save and Deploy**

It takes 1–3 minutes. When it finishes you get your link:

```
https://viber-brawl-multiplayer.YOUR-SUBDOMAIN.workers.dev
```

> **If the build fails**, clear the Build command box and deploy again. The game
> page is already built and included, so it works without that step — the build
> command just refreshes it. Tell me if this happens and I'll sort it properly.

---

## Step 4 — Create the tables

The database exists but is empty. One paste fills it in.

1. Cloudflare dashboard → **Storage & Databases** → **D1 SQL Database** →
   `viber-brawl-db`
2. Click the **Console** tab
3. In your unzipped folder, open `multiplayer/db/apply-all.sql` in **Notepad**
4. Ctrl+A to select all, Ctrl+C to copy
5. Paste it into the Cloudflare console box
6. Click **Execute**

You should see it run through the statements with no errors. That one file
creates all 21 tables and fills in 30 achievements, 35 cosmetics and 6
challenges.

> It's safe to run twice — nothing gets duplicated.

---

## Step 5 — Play with your friends

Your game link is:

```
https://viber-brawl-multiplayer.YOUR-SUBDOMAIN.workers.dev/viber-brawl-multiplayer.html
```

1. Open it, click **MULTIPLAYER**, type a name, click **CREATE ROOM**
2. You get a 5-letter code, e.g. `X7K4Q`
3. Send your friends this link with the code on the end:

```
https://viber-brawl-multiplayer.YOUR-SUBDOMAIN.workers.dev/viber-brawl-multiplayer.html?room=X7K4Q
```

They land straight in your room. Everyone picks a different Viber, clicks
**READY**, and you click **START MATCH**.

**Nobody installs anything, and your PC can be off.**

At this point the game fully works — multiplayer, accounts, levels, profiles.
The next step is optional.

---

## Step 6 — Add Google and Discord login (optional)

Right now players can sign in with a **display name only**, and everything is
saved. Google and Discord are a nice-to-have on top.

**Do this AFTER step 5**, because both providers need to know your deployed
address, which didn't exist until now.

### 6a. Discord first — it's much easier

1. Go to <https://discord.com/developers/applications>
2. Click **New Application**, name it `Viber Brawl`, agree, create
3. In the left menu click **OAuth2**
4. Under **Redirects**, click **Add Redirect** and paste exactly:

   ```
   https://viber-brawl-multiplayer.YOUR-SUBDOMAIN.workers.dev/api/auth/oauth/discord/callback
   ```

5. Click **Save Changes**
6. Copy the **Client ID** and, under Client Secret, click **Reset Secret** and
   copy that too

Now put them into Cloudflare:

7. Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings**
8. Click **Variables and Secrets** → **Add**
9. Add two, both of type **Secret**:
   - Name `DISCORD_CLIENT_ID`, value = your Client ID
   - Name `DISCORD_CLIENT_SECRET`, value = your Client Secret

### 6b. Google

1. Go to <https://console.cloud.google.com/apis/credentials>
2. Create a project if it asks (name it anything)
3. Click **Create Credentials** → **OAuth client ID**
4. If it asks you to configure a consent screen first, do that — choose
   **External**, give it a name, and you can leave the rest at defaults. You do
   **not** need Google's verification for personal use.
5. Application type: **Web application**
6. Under **Authorised redirect URIs**, click **Add URI** and paste exactly:

   ```
   https://viber-brawl-multiplayer.YOUR-SUBDOMAIN.workers.dev/api/auth/oauth/google/callback
   ```

7. Click **Create**, then copy the **Client ID** and **Client Secret**
8. Add them in Cloudflare the same way as step 9 above:
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

### Then

Redeploy (Cloudflare → your Worker → **Deployments** → **Retry deployment**, or
just push any change to GitHub). The buttons appear on the ACCOUNT screen
automatically.

> A provider's button only appears once **both** its values are set. So you can
> do Discord now, Google later, or neither. Nothing breaks either way.

---

## Making changes later

Once set up, updating the live game is just: upload the changed files to GitHub
and commit. Cloudflare rebuilds and updates automatically.

---

## If something goes wrong

| What you see | What it means | Fix |
|---|---|---|
| Deploy log mentions `database_id` | The id in `wrangler.toml` is still the zeros | Redo step 1, re-upload `wrangler.toml` |
| Deploy log can't find `wrangler.toml` | The files went in one folder too deep | Re-upload the *contents*, not the folder |
| `npm error EBADPLATFORM` | A Windows-only package is listed as *required* | See below |
| `npm ci ... can only install packages when your package.json and package-lock.json are in sync` | The lockfile was regenerated on Windows and lost the Linux entries | See below |
| Build fails | Usually the build command | Clear the Build command box, redeploy |
| The page loads but rooms don't work | The Durable Object failed to start | Worker → **Logs** tab, tell me what it says |
| Google/Discord button missing | Not both values set | Redo step 6 |
| `redirect_uri_mismatch` | The address in Google/Discord doesn't match exactly | It must match character for character |
| Sign-up fails with an error | Password sign-in is on but you're on the free plan | See below |

### About those two npm errors

Your PC is Windows. Cloudflare's build machines are Linux. Some tools ship a
separate package per operating system (`@esbuild/win32-x64`,
`@cloudflare/workerd-linux-64` and so on).

There are two ways this goes wrong, and this project is set up to avoid both:

1. **Listed as a *required* dependency** → npm refuses to install on the wrong
   operating system. (`EBADPLATFORM`)
2. **Listed as *optional*, but missing from the lockfile** → npm refuses because
   the two files disagree. (`npm ci ... not in sync`)

The fix for both is already applied: `package.json` declares **all 46 platform
variants as `optionalDependencies`**, so npm records every platform in the
lockfile and then installs only the one that matches the machine it is on.
Windows skips the Linux ones; Linux skips the Windows ones. Neither fails.

> **Never run `npm install` on this project on Windows and then upload
> `package-lock.json`.** npm only writes the entries for the machine it runs on,
> which silently strips every other platform out of the lockfile — and that is
> exactly what caused the second error. If you ever do need to regenerate it, the
> `optionalDependencies` block in `package.json` is what keeps all 46 entries
> present, so regenerate from the copy in the zip rather than from scratch.

**About the free plan.** The game ships with email + password sign-in switched
on, and that needs Cloudflare's $5/month plan. If you're on the free plan,
open `wrangler.toml` in Notepad, find `AUTH_PASSWORD = "1"`, change it to
`AUTH_PASSWORD = "0"`, and re-upload that file. Then players sign in with Google
or Discord only — which is what most games do anyway.

---

## Two things to check after your first deploy

I built and tested everything against Cloudflare's local simulator, which is very
close to the real thing but not identical. So please check:

1. **A match is recorded** — play one match, then open **PROFILE**. It should
   appear in your match history.
2. **Your name sticks** — reload the page. You should still have the same name
   and stats.

If either looks wrong, open the Worker's **Logs** tab and send me what it says.
That tab shows live what the server is doing, and it's the fastest way for me to
find the problem.
