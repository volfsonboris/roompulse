# Presentation Feedback / RoomPulse

A working web app for live audience feedback. Built with Node.js, HTML, CSS,
and browser JavaScript, without third-party dependencies or external assets.

## Deploy online for free

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/volfsonboris/roompulse)

1. Click **Deploy to Render**, sign in to Render, and connect your GitHub account
   if prompted.
2. Review the Blueprint: it creates **one Free web service**, with no database
   or paid disk. Keep the Free plan selected, then approve deployment.
3. Wait for the service to become live and open the HTTPS URL Render assigns.
4. Create your presentation on that public URL and share its audience link.

The included `render.yaml` runs the API tests during the build and starts the
Node.js server. Automatic redeployment is disabled to avoid interrupting live
presentations; deploy subsequent changes manually from Render's dashboard.

**Free-hosting tradeoffs:** Render sleeps after 15 minutes without inbound
traffic, can take about a minute to wake, and may restart at any time. Its free
filesystem is temporary: **all sessions, messages, and presenter links are lost
on sleep, restart, or redeployment**. This is appropriate for demos, not durable
or critical presentation feedback. Free usage quotas apply; review Render's
[Free instance limits](https://render.com/docs/free) and billing settings before
deployment. No paid hosting is required by this Blueprint.

For reliable retention, use a host with persistent storage instead, as described
below. A GitHub repository or GitHub Pages alone cannot run this app's server.

## Start

Requires Node.js 22 or newer.

```powershell
git clone https://github.com/volfsonboris/roompulse.git
cd roompulse
npm start
```

Open <http://localhost:3000>. No dependency installation or build is required.
Use `npm test` to run the automated API tests.

## Use

1. Enter a presentation title and select **Create presentation**.
2. Bookmark the private presenter dashboard URL. Its `#` fragment contains the
   access key; you need the complete URL to return to your dashboard.
3. Copy the **audience link** and share it. Do not share the presenter URL.
4. Audience members choose green (everything is clear), yellow (explain further),
   or red (confused). Changing a signal replaces that person's previous signal.
5. Audience members can also send anonymous free-text feedback. The presenter
   sees aggregate signals and messages, updated every two seconds while the page
   is visible (every eight seconds in the background).
6. **End session** permanently stops new responses. The private dashboard remains
   available with the final results while the server's data file is retained.

## Share with other devices

`localhost` links work only on the computer running the server.

For a presentation on the same trusted network:

1. Run `ipconfig` and find your active network adapter's IPv4 address.
2. Open `http://YOUR-NETWORK-IP:3000` on the presenter's computer.
3. Create the session there (or replace `localhost` in an existing dashboard URL
   with that IP, retaining the entire path and `#` key), then copy the audience link.
4. Keep the server running and permit incoming TCP port 3000 on your **private**
   network if Windows Firewall requires it. Guest Wi-Fi may block device-to-device
   connections. Automatic clipboard access may be unavailable over HTTP; manually
   copy the displayed link instead.

For remote audiences, deploy a single Node.js instance behind an **HTTPS** reverse
proxy on a reachable hostname. Open that public URL before creating or sharing
sessions. The proxy must preserve the public `Host` header and pass
`Authorization` through. Use persistent storage for the data file. This project
does not configure public hosting, TLS, firewall rules, or authentication for
session creation.

## Configuration

Set environment variables before `npm start`:

```powershell
$env:PORT = "3001"
$env:HOST = "127.0.0.1"
$env:DATA_FILE = "C:\RoomPulseData\sessions.json"
npm start
```

Defaults: port `3000`, host `0.0.0.0` (all network interfaces), data file
`data\sessions.json` inside this project. Binding to `127.0.0.1` disables access
from other devices.

## Data, privacy, and limits

- No names or accounts are requested. A random audience token is stored in
  browser local storage per session. The server stores only its hash. The same
  browser profile and origin count as one participant across tabs and reloads.
  Another browser/device, private window, cleared storage, or changed origin can
  count as another participant. This is lightweight feedback, not verified voting.
- A participant is counted after sending a signal or message, not merely opening
  the page. Signals stay until changed or the session ends; counts do not
  represent online attendance. Percentages use only people who sent a signal and
  are independently rounded.
- Audience members cannot read other messages or aggregate results. The dashboard
  requires a random private key sent in an authorization header. Its URL fragment
  is not sent with page requests; only a hash of the key is stored on the server.
  Anyone who has the full private URL can view results and end that session.
- Messages are anonymous to the presenter, but are not encrypted at rest.
  Server operators can access saved content; infrastructure may log network
  metadata. Do not submit sensitive information. Use HTTPS beyond a trusted
  development network.
- Responses persist in the JSON data file across restarts. The app acknowledges
  writes only after saving them. This requires retained storage; the free Render
  deployment loses the file when its instance sleeps, restarts, or redeploys.
  Keep this file private and backed up. There is
  no account-based recovery for lost presenter links and no automatic retention
  cleanup. To clear all sessions, stop the server and deliberately remove the
  configured data file. Ending a session does not delete it.
- Limits: 500 sessions per server, 1,000 participants per session, 1,000 characters
  per message, 20 messages per participant, 2,000 messages per session. Session
  creation is limited to 10 requests per minute per IP; other writes to 3,000.
  Reverse-proxied traffic shares the proxy's IP for rate limiting.
- Intended for small, single-server deployments. JSON storage rewrites the data
  file on each change; do not run multiple processes against the same file.
  Large/public deployments should add durable database storage, stronger
  abuse controls, presenter authentication, and a retention policy.

## Files

- `server.js`: HTTP server, validated API, private presenter access, JSON persistence.
- `public\index.html`: home, presenter, and audience views.
- `public\styles.css`: responsive, keyboard-accessible UI with traffic-light styling.
- `public\app.js`: session creation, sharing, audience actions, and live polling.
- `test\server.test.js`: end-to-end HTTP API checks using Node's built-in test runner.
- `render.yaml`: Free Render web-service deployment configuration.
